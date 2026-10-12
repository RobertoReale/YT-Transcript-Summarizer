// streamLLM is the only code that speaks each provider's protocol, for both the
// side panel and batch API mode. These tests pin what goes on the wire (the
// parameters that 400 on current models are the usual way this breaks) and how
// each SSE dialect is read back — offline, with a scripted fetch.
import { streamLLM, buildRequest, parseSSE, isRetriable, LLMError } from '../modules/llm-stream.js';
import { check, finish } from './harness.mjs';

/** A fetch Response whose body streams `chunks` (strings), one per read. */
function sse(chunks, { status = 200, delayMs = 0 } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300, status, statusText: '',
    text: async () => chunks.join(''),
    body: new ReadableStream({
      async pull(ctrl) {
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
        else ctrl.close();
      },
    }),
  };
}
const ev = (obj, name) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;

// ── request shapes ──
{
  const r = buildRequest('P', { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' });
  check('anthropic: streams', r.body.stream, true);
  check('anthropic: browser-access header', r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  check('anthropic: no thinking param unless asked', r.body.thinking, undefined);
  check('anthropic: room for a long summary', r.body.max_tokens >= 16000, true);
  const t = buildRequest('P', { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k', useThinking: true });
  check('anthropic 5.x + thinking chip → adaptive', t.body.thinking?.type, 'adaptive');
  check('...never budget_tokens (400 on 5.x)', t.body.thinking?.budget_tokens, undefined);
  const old = buildRequest('P', { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', useThinking: true });
  check('anthropic haiku-4-5 + thinking → budget form', old.body.thinking?.type, 'enabled');
  check('...budget below max_tokens', old.body.thinking.budget_tokens < old.body.max_tokens, true);

  const o = buildRequest('P', { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k' });
  check('openai: endpoint', o.url, 'https://api.openai.com/v1/chat/completions');
  check('openai: no max_tokens (reasoning models reject it)', 'max_tokens' in o.body, false);
  check('openai: bearer auth', o.headers.Authorization, 'Bearer k');
  const g = buildRequest('P', { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'k' });
  check('groq: endpoint', g.url, 'https://api.groq.com/openai/v1/chat/completions');
  const c = buildRequest('P', { provider: 'custom', model: 'llama3', endpoint: 'http://localhost:11434/v1/chat/completions' });
  check('custom: no key → no auth header', c.headers.Authorization, undefined);
  let threw = null;
  try { buildRequest('P', { provider: 'custom', model: 'x' }); } catch (e) { threw = e.message; }
  check('custom without endpoint fails clearly', /endpoint/i.test(threw || ''), true);
  const gm = buildRequest('P', { provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'AIza' });
  check('gemini: SSE endpoint', gm.url.endsWith('gemini-3.8-flash:streamGenerateContent?alt=sse'), true);
  check('gemini: key in header, not URL', gm.url.includes('AIza'), false);
}

// ── streaming, per dialect ──
{
  const got = [];
  const r = await streamLLM('P', { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, t => got.push(t), {
    fetchImpl: async () => sse([
      ev({ type: 'message_start' }, 'message_start'),
      ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } }, 'content_block_delta'),
      // a chunk boundary in the middle of an event must not lose it
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
      'lo"}}\n\n',
      ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }, 'content_block_delta'),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'message_delta'),
    ]),
  });
  check('anthropic: text assembled across chunk boundaries', r.text, 'Hello world');
  check('anthropic: thinking is never shown', got.join('').includes('secret'), false);
  check('anthropic: stop reason', r.stopReason, 'end_turn');
  check('anthropic: not truncated', r.truncated, false);
}
{
  const r = await streamLLM('P', { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k' }, undefined, {
    fetchImpl: async () => sse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });
  check('openai: CRLF + comments handled', r.text, 'AB');
  check('openai: finish_reason=length → truncated', r.truncated, true);
}
{
  const r = await streamLLM('P', { provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'k' }, undefined, {
    fetchImpl: async () => sse([
      ev({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }] } }] }),
      ev({ candidates: [{ content: { parts: [{ text: 'Sum' }, { text: 'mary' }] } }] }),
      // final event with no trailing blank line
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}]}',
    ]),
  });
  check('gemini: thought parts skipped, all parts joined, last event flushed', r.text, 'Summary!');
  check('gemini: finish reason', r.stopReason, 'STOP');
}

// ── failures ──
{
  let err = null;
  try {
    await streamLLM('P', { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, undefined, {
      fetchImpl: async () => sse(['{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'], { status: 429 }),
    });
  } catch (e) { err = e; }
  check('http error carries status', err?.status, 429);
  check('http error message is readable', /429.*slow down/.test(err?.message || ''), true);
  check('429 is retriable', isRetriable(err), true);
  check('401 is not', isRetriable(new LLMError('bad key', { status: 401 })), false);
}
{
  let err = null;
  try {
    await streamLLM('P', { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, undefined, {
      fetchImpl: async () => sse([ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error')]),
    });
  } catch (e) { err = e; }
  check('mid-stream overload surfaces as an error', /Overloaded/.test(err?.message || ''), true);
  check('...and is retriable', isRetriable(err), true);
}
{
  let err = null;
  try {
    await streamLLM('P', { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, undefined, {
      fetchImpl: async () => sse([ev({ type: 'message_delta', delta: { stop_reason: 'refusal' } }, 'message_delta')]),
    });
  } catch (e) { err = e; }
  check('refusal with no text is reported as such', /declined/.test(err?.message || ''), true);
}
{
  let err = null;
  try { await streamLLM('P', { provider: 'openai', model: 'm', apiKey: '' }); } catch (e) { err = e; }
  check('missing key fails before any request', /no API key/.test(err?.message || ''), true);
}

// ── stopping ──
{
  const ctrl = new AbortController();
  let fetchSignal = null;
  const p = streamLLM('P', { provider: 'openai', model: 'm', apiKey: 'k' }, () => ctrl.abort(), {
    signal: ctrl.signal,
    fetchImpl: async (url, opts) => {
      fetchSignal = opts.signal;
      const res = sse(Array.from({ length: 50 }, (_, i) => `data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`), { delayMs: 5 });
      // a real fetch body errors once its request is aborted
      const reader = res.body.getReader();
      res.body = new ReadableStream({
        async pull(c) {
          if (opts.signal.aborted) { c.error(new DOMException('aborted', 'AbortError')); return; }
          const { done, value } = await reader.read();
          if (done) c.close(); else c.enqueue(value);
        },
      });
      return res;
    },
  });
  let err = null;
  try { await p; } catch (e) { err = e; }
  check('Stop reaches the network request', fetchSignal?.aborted, true);
  check('...and ends the call as interrupted', err?.aborted, true);
}
{
  let err = null;
  try {
    await streamLLM('P', { provider: 'openai', model: 'm', apiKey: 'k' }, undefined, {
      idleTimeoutMs: 50,
      fetchImpl: async (url, opts) => ({
        ok: true, status: 200,
        body: new ReadableStream({
          start(c) { opts.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
        }),
      }),
    });
  } catch (e) { err = e; }
  check('a silent connection times out instead of hanging', /no data received/.test(err?.message || ''), true);
  check('...as a retriable error', isRetriable(err), true);
}

// ── parseSSE edge cases ──
{
  const seen = [];
  await parseSSE(sse(['data: line1\ndata: line2\n\n', 'event: ping\ndata: {"a":1}\n\n']).body, (e, d) => seen.push([e, d]));
  check('multi-line data joined', seen[0][1], 'line1\nline2');
  check('event name passed', seen[1][0], 'ping');
  check('json parsed', seen[1][1].a, 1);
}

finish();
