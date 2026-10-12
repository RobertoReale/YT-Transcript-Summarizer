// ── llm-stream.js — the one place that speaks each provider's wire protocol ──
// Both the side panel (live rendering) and the batch API mode (accumulated into
// a .md file) go through streamLLM. They used to have two separate clients that
// drifted apart: the side panel had no Groq, ignored the Stop button (the abort
// signal never reached fetch), and the batch client sent `max_tokens` to models
// that reject it.
//
// Streaming in batch mode is deliberate too: a long summary on a thinking model
// can take minutes, and a non-streaming request had to choose between a timeout
// that killed good answers and one that let a dead connection hang the queue.
// Here the timeout is on *silence* (no bytes for `idleTimeoutMs`), not on length.

const ENDPOINTS = {
  anthropic:  'https://api.anthropic.com/v1/messages',
  openai:     'https://api.openai.com/v1/chat/completions',
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

export const PROVIDER_LABELS = {
  anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini',
  groq: 'Groq', openrouter: 'OpenRouter', custom: 'Custom',
};

// Claude models whose only thinking switch is `{type: "adaptive"}`. On the 5.x
// line thinking is on by default anyway; the chip then only raises the effort.
const ANTHROPIC_ADAPTIVE = /^claude-(fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[678]|sonnet-4-6)/;
// Older models that still take a fixed thinking budget.
const ANTHROPIC_BUDGET = /^claude-(opus-4-[015]|sonnet-4-5|haiku-4-5|sonnet-4-0|opus-4-0)/;

const ANTHROPIC_MAX_TOKENS = 32000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

/** An HTTP failure, with the status kept so callers can decide about retries. */
export class LLMError extends Error {
  constructor(message, { status = 0, type = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.type = type;
  }
}

/** 429, overload and transient 5xx are worth retrying; a bad key or model is not. */
export function isRetriable(err) {
  const s = err?.status || 0;
  if (s === 429 || s === 529 || s === 500 || s === 502 || s === 503 || s === 504) return true;
  return /overloaded|rate.?limit|too many requests/i.test(String(err?.type || '') + ' ' + String(err?.message || ''));
}

/**
 * Build the HTTP request for one provider. Pure, so tests can check exactly what
 * goes on the wire without a network.
 * @returns {{ url: string, headers: object, body: object, kind: 'anthropic'|'openai'|'gemini' }}
 */
export function buildRequest(prompt, config) {
  const { provider, model, apiKey, endpoint, useThinking } = config;
  const label = PROVIDER_LABELS[provider] || provider;

  if (provider === 'anthropic') {
    const m = model || 'claude-sonnet-5-5';
    const body = {
      model: m,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
    if (useThinking && ANTHROPIC_ADAPTIVE.test(m)) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: 'high' };
    } else if (useThinking && ANTHROPIC_BUDGET.test(m)) {
      body.thinking = { type: 'enabled', budget_tokens: 8000 };
    }
    return {
      kind: 'anthropic',
      url: ENDPOINTS.anthropic,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  }

  if (provider === 'gemini') {
    const m = model || 'gemini-3.8-flash';
    return {
      kind: 'gemini',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`,
      // The key travels in a header rather than the query string so it cannot
      // leak through referrers, proxy logs or an error message echoing the URL.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey || '' },
      body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
    };
  }

  if (provider === 'openai' || provider === 'groq' || provider === 'openrouter' || provider === 'custom') {
    const url = provider === 'custom' ? endpoint : ENDPOINTS[provider];
    if (!url) throw new LLMError('Custom endpoint URL not configured. Set it in Advanced Settings.');
    if (!model) throw new LLMError(`${label}: no model selected.`);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/RobertoReale/YT-Transcript-Summarizer';
      headers['X-Title'] = 'YT Summarizer';
    }
    // No max_tokens / max_completion_tokens: reasoning models reject the first,
    // older OpenAI-compatible servers (Ollama, LM Studio) the second, and every
    // provider's default is the model's own output ceiling — which is what a
    // summary wants anyway.
    return {
      kind: 'openai',
      url,
      headers,
      body: { model, messages: [{ role: 'user', content: prompt }], stream: true },
    };
  }

  throw new LLMError(`Unsupported provider: ${provider}`);
}

/**
 * Stream one completion. `onChunk(text)` receives each piece of visible text as
 * it arrives (thinking is never forwarded).
 *
 * @param {string} prompt
 * @param {{provider: string, model?: string, apiKey?: string, endpoint?: string, useThinking?: boolean}} config
 * @param {(text: string) => void} [onChunk]
 * @param {{signal?: AbortSignal, idleTimeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{text: string, stopReason: string|null, truncated: boolean}>}
 */
export async function streamLLM(prompt, config, onChunk = () => {}, opts = {}) {
  const { signal, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = opts;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const label = PROVIDER_LABELS[config.provider] || config.provider;
  const req = buildRequest(prompt, config);

  if (config.provider !== 'custom' && !String(config.apiKey || '').trim()) {
    throw new LLMError(`${label}: no API key configured.`);
  }

  // One controller for both reasons to stop: the caller's signal and silence.
  const ctrl = new AbortController();
  let idleTimer = null;
  let timedOut = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, idleTimeoutMs);
  };
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let text = '';
  let stopReason = null;
  const emit = (t) => { if (t) { text += t; onChunk(t); } };

  try {
    armIdle();
    let res;
    try {
      res = await doFetch(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal,
      });
    } catch (e) {
      throw abortError(e, timedOut, signal, label, idleTimeoutMs);
    }

    if (!res.ok) throw await httpError(res, label);
    if (!res.body) throw new LLMError(`${label} returned an empty response body`);

    try {
      await parseSSE(res.body, (event, data) => {
        armIdle();
        if (req.kind === 'anthropic') stopReason = onAnthropicEvent(event, data, emit, label) ?? stopReason;
        else if (req.kind === 'gemini') stopReason = onGeminiEvent(data, emit, label) ?? stopReason;
        else stopReason = onOpenAIEvent(data, emit, label) ?? stopReason;
      });
    } catch (e) {
      if (e instanceof LLMError) throw e;
      throw abortError(e, timedOut, signal, label, idleTimeoutMs);
    }
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!text.trim()) {
    if (stopReason === 'refusal' || stopReason === 'SAFETY' || stopReason === 'content_filter') {
      throw new LLMError(`${label} declined to summarize this transcript (${stopReason}).`);
    }
    if (stopReason === 'MAX_TOKENS' || stopReason === 'max_tokens' || stopReason === 'length') {
      throw new LLMError(`${label} hit the output limit before writing anything — try a shorter summary or another model.`);
    }
    throw new LLMError(`${label} returned an empty summary (stop reason: ${stopReason || 'unknown'})`);
  }

  const truncated = stopReason === 'max_tokens' || stopReason === 'MAX_TOKENS' || stopReason === 'length';
  return { text, stopReason, truncated };
}

function abortError(e, timedOut, signal, label, idleTimeoutMs) {
  if (timedOut) return new LLMError(`${label}: no data received for ${Math.round(idleTimeoutMs / 1000)} s — connection timed out`, { status: 504 });
  if (signal?.aborted) {
    const err = new LLMError('Interrupted by user');
    err.aborted = true;
    return err;
  }
  return e instanceof Error ? e : new LLMError(String(e));
}

async function httpError(res, label) {
  const raw = await res.text().catch(() => '');
  let msg = '', type = '';
  try {
    const j = JSON.parse(raw);
    const err = Array.isArray(j) ? j[0]?.error : j.error;
    msg = typeof err === 'string' ? err : (err?.message || j.message || '');
    type = err?.type || err?.status || '';
  } catch { msg = raw.slice(0, 300); }
  return new LLMError(`${label} API error ${res.status}${type ? ` (${type})` : ''}: ${msg || res.statusText || 'request failed'}`,
    { status: res.status, type });
}

// ── Per-provider event handlers. Each returns a stop reason when it sees one. ──

function onAnthropicEvent(event, data, emit, label) {
  if (!data || typeof data !== 'object') return null;
  if (event === 'error' || data.type === 'error') {
    const err = data.error || {};
    throw new LLMError(`${label} API error (${err.type || 'stream'}): ${err.message || 'stream error'}`,
      { status: err.type === 'overloaded_error' ? 529 : 0, type: err.type || '' });
  }
  if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') emit(data.delta.text);
  if (data.type === 'message_delta' && data.delta?.stop_reason) return data.delta.stop_reason;
  return null;
}

function onOpenAIEvent(data, emit, label) {
  if (data === '[DONE]' || !data || typeof data !== 'object') return null;
  if (data.error) {
    const err = data.error;
    throw new LLMError(`${label} API error: ${err.message || JSON.stringify(err).slice(0, 200)}`,
      { status: Number(err.code) || 0, type: err.type || '' });
  }
  const choice = data.choices?.[0];
  if (typeof choice?.delta?.content === 'string') emit(choice.delta.content);
  return choice?.finish_reason || null;
}

function onGeminiEvent(data, emit, label) {
  if (!data || typeof data !== 'object') return null;
  if (data.error) {
    throw new LLMError(`${label} API error ${data.error.code || ''}: ${data.error.message || 'stream error'}`,
      { status: Number(data.error.code) || 0, type: data.error.status || '' });
  }
  const cand = data.candidates?.[0];
  for (const part of cand?.content?.parts || []) {
    if (!part.thought && typeof part.text === 'string') emit(part.text);
  }
  if (!cand && data.promptFeedback?.blockReason) return 'SAFETY';
  return cand?.finishReason && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED' ? cand.finishReason : null;
}

/**
 * Minimal Server-Sent Events reader: `event:` names, multi-line `data:`, CRLF,
 * and a final event without a trailing blank line are all handled.
 * `onEvent(eventName, parsedData)` — data is JSON-parsed, or the raw string.
 */
export async function parseSSE(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event = '';
  let dataLines = [];

  const dispatch = () => {
    if (!dataLines.length) { event = ''; return; }
    const raw = dataLines.join('\n');
    dataLines = [];
    let data = raw;
    if (raw !== '[DONE]') { try { data = JSON.parse(raw); } catch { /* keep the string */ } }
    const name = event;
    event = '';
    onEvent(name, data);
  };

  const feedLine = (line) => {
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return; // comment / keep-alive
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      feedLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) feedLine(buffer.replace(/\r$/, ''));
  dispatch();
}
