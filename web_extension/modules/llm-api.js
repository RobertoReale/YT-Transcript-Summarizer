// ── LLM API Calls ─────────────────────────────────────────────────────────────
import { CONFIG } from './config.js';
const chunkNotes = (lang) => ({
  part: 'Part',
  instruction: () => '',
  mergeChat: () => '',
  mergeApi: () => ''
});
async function fetchLLM(url, headers, bodyObj, providerName) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000); // 3 min timeout

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: headers,
      body: JSON.stringify(bodyObj)
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout ${providerName} API (>3 min)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`${providerName} API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }
  try {
    return await resp.json();
  } catch (e) {
    throw new Error(`${providerName} returned a malformed (non-JSON) response`);
  }
}

/**
 * Clamp the transcript to what the selected provider can take. The old flat
 * 120k-char cap silently dropped the tail of anything longer than ~2 h even on
 * 200k+ token models, and nothing downstream ever learned about it — the .md
 * looked like a summary of the whole video. Callers now receive the flag.
 */
function trimTranscript(transcript, provider) {
  const max = CONFIG.maxTranscriptChars[provider] ?? CONFIG.maxTranscriptChars.default;
  if (transcript.length <= max) {
    return { text: transcript, truncated: false, kept: transcript.length, total: transcript.length };
  }
  return {
    text: transcript.slice(0, max) + '\n\n[... transcript truncated — the video is longer than the model context ...]',
    truncated: true,
    kept: max,
    total: transcript.length
  };
}

/**
 * Split a transcript into `parts` slices of roughly equal size, snapping each
 * cut to the nearest line break or sentence end so a chunk never starts
 * mid-word. Returns a single-element array when splitting is not requested.
 */
export function splitTranscript(text, parts) {
  return [String(text || '')];
}

/**
 * How many parts this transcript is actually split into.
 *
 * The number the user picked is adjusted down when the transcript is too short
 * to fill that many parts, and up when a single part would not fit the target's
 * per-message limit (`settings.maxMessageChars`, web mode only — a composer that
 * truncates silently makes the user's choice actively harmful).
 * @returns {number} 1 when the transcript should be sent in a single request
 */
/**
 * The number of parts the USER asked for, clamped to the user-facing ceiling.
 *
 * Deliberately separate from what actually gets sent: an automatic raise (a
 * composer that would truncate) and a deliberate split mean opposite things
 * downstream — for the merge, and for what the status line owes the user.
 */
export function requestedChunkCount(settings) {
  return 1;
}

export function plannedChunkCount(transcript, settings) {
  return 1;
}

// Worst-case length of the chunk instruction glued to each part, plus the two
// `---` separators. Deliberately generous: overshooting costs a few characters
// of headroom, undershooting brings back the silent truncation.
const CHUNK_NOTE_CHARS = 500;

/** The prompt sent with chunk `i` of `n` (1-based), in the transcript language. */
export function chunkPrompt(basePrompt, i, n, lang) {
  return `${basePrompt}\n\n---\n\n${chunkNotes(lang).instruction(i, n)}`;
}

/** Heading placed above each partial summary when the parts are joined. */
export function chunkHeading(i, n, lang) {
  return `## ${chunkNotes(lang).part} ${i}/${n}`;
}

/** Follow-up message asking a web chat to fuse the parts it has already seen. */
export function mergeChatPrompt(n, lang) {
  return chunkNotes(lang).mergeChat(n);
}

/** Prompt for the extra API call that fuses the partial summaries. */
export function mergeApiPrompt(basePrompt, n, lang) {
  return `${basePrompt}\n\n---\n\n${chunkNotes(lang).mergeApi(n)}`;
}

/**
 * Everything the content script needs to rebuild the merge message out of the
 * partial answers it can read on the page, instead of asking the model to
 * remember them.
 *
 * Why: a web chat does NOT reliably re-read its own distant turns. Observed
 * 2026-07-27 on Gemini — four parts posted, four correct partial summaries, and
 * a "summary of the whole video" that fused only parts 3 and 4 and never
 * mentioned 1 and 2. Nothing was lost by the extension; the model simply
 * ignored the older turns. API mode never had the problem because it hands the
 * partials back as text (`mergeApiPrompt`), and this is what makes web mode do
 * the same: the content script sees the DOM, so it can read the partial answers
 * and paste them into the merge request.
 *
 * `at` is the index of the merge message in `parts`; if the replies cannot be
 * read the message already sitting there ("merge the summaries above") stands.
 */
function mergePlanFor(settings, count, lang, cap) {
  return {
    at: count,                                   // parts = count chunks + merge
    count,
    head: mergeApiPrompt(settings.prompt, count, lang),
    label: chunkNotes(lang).part,
    cap: cap || 0
  };
}

/**
 * The full sequence of messages a run produces: one per chunk, plus the merge
 * request when asked for. Web mode posts them into one conversation; API mode
 * uses the chunk messages and merges separately (it has the partials in hand).
 */
export function buildChunkMessages(transcript, settings) {
  const lang = settings.transcriptLang || 'en';
  const asked = requestedChunkCount(settings);
  const n = plannedChunkCount(transcript, settings);
  const cap = Math.floor(settings?.maxMessageChars) || 0;
  // Even at maxParts a very long video can stay over the composer's limit. The
  // caller has to be able to say so instead of pretending the whole thing went.
  const overflowOf = parts => cap ? parts.reduce((w, p) => Math.max(w, p.length - cap), 0) : 0;

  if (n === 1) {
    const parts = [`${settings.prompt}\n\n---\n\n${transcript}`];
    return { parts, chunks: 1, asked, autoSplit: false, merged: false, mergePlan: null, overflow: overflowOf(parts) };
  }

  const slices = splitTranscript(transcript, n);
  const count = slices.length;
  const parts = slices.map((s, i) => `${chunkPrompt(settings.prompt, i + 1, count, lang)}\n\n---\n\n${s}`);
  // The split was forced by the composer's own limit, not chosen. The caller has
  // to be able to say which of the two happened: "✂️ 7 parts" after the user
  // picked "1 part" reads as a bug unless the reason travels with it.
  const autoSplit = count > asked;
  // Whoever asked for a single part asked for a SINGLE summary. Leaving them
  // with N partial summaries and no whole one would answer a question nobody
  // put — so the merge is not optional here, and the checkbox (hidden at
  // "1 part", and therefore carrying whatever it happened to hold from an
  // earlier setting) does not get a vote. It only governs a deliberate split.
  const merged = asked === 1 ? true : !!settings.chunkMerge;
  if (merged) parts.push(mergeChatPrompt(count, lang));
  return {
    parts, chunks: count, asked, autoSplit, merged,
    mergePlan: merged ? mergePlanFor(settings, count, lang, cap) : null,
    overflow: overflowOf(parts)
  };
}

function requireKey(apiKey, providerName) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error(`${providerName}: no API key configured (Advanced Settings ⚙️).`);
  }
}

/**
 * Dispatcher: routes to the right provider.
 * @returns {Promise<{summary: string, truncated: boolean, kept: number, total: number}>}
 */
export async function callLLM(transcript, settings) {
  const provider = settings.provider || 'anthropic';
  const apiKey = (settings.apiKeys && settings.apiKeys[provider]) || settings.apiKey || '';
  const s = { ...settings, apiKey };
  const trimmed = trimTranscript(String(transcript ?? ''), provider);

  let summary;
  switch (provider) {
    case 'openai':
      summary = await callOpenAICompat(trimmed.text, s, 'https://api.openai.com/v1/chat/completions', 'OpenAI');
      break;
    case 'gemini':
      summary = await callGemini(trimmed.text, s);
      break;
    case 'openrouter':
      summary = await callOpenAICompat(trimmed.text, s, 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter');
      break;
    case 'custom': {
      const endpoint = s.customEndpointUrl;
      if (!endpoint) throw new Error('Custom endpoint URL not configured. Set it in Advanced Settings.');
      summary = await callOpenAICompat(trimmed.text, s, endpoint, 'Custom');
      break;
    }
    default:
      summary = await callAnthropic(trimmed.text, s);
  }

  return { summary, truncated: trimmed.truncated, kept: trimmed.kept, total: trimmed.total };
}

// Anthropic Claude
async function callAnthropic(trimmed, settings) {
  requireKey(settings.apiKey, 'Anthropic');

  const model = settings.model || '';
  // Claude 4.6+ takes adaptive thinking; the old fixed `budget_tokens` form was
  // removed on Opus 4.7/4.8, Sonnet 5 and Fable 5 and now returns HTTP 400.
  const ADAPTIVE = /^claude-(fable-5|mythos-5|opus-4-(6|7|8)|sonnet-(5|4-6))/;
  const LEGACY_THINKING = /^claude-(3-7-sonnet|opus-4-5|sonnet-4-5|haiku-4-5)/;
  const useThinking = !!settings.useThinking && (ADAPTIVE.test(model) || LEGACY_THINKING.test(model));
  const maxTokens = useThinking ? 16000 : 8192;

  const bodyObj = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: `${settings.prompt}\n\n---\n\n${trimmed}` }]
  };
  if (useThinking) {
    if (ADAPTIVE.test(model)) {
      bodyObj.thinking = { type: 'adaptive' };
      bodyObj.output_config = { effort: 'high' };
    } else {
      bodyObj.thinking = { type: 'enabled', budget_tokens: 4096 };
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };

  const data = await fetchLLM('https://api.anthropic.com/v1/messages', headers, bodyObj, 'Anthropic');
  // `data.content.filter(...)` used to throw a bare "Cannot read properties of
  // undefined" whenever the shape was unexpected (HTTP 200 with an error body,
  // refusal, empty completion).
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('');
  if (!text.trim()) {
    throw new Error(`Anthropic returned an empty summary (stop_reason: ${data?.stop_reason || 'unknown'})`);
  }
  return text;
}

// OpenAI-compatible (OpenAI, OpenRouter, Custom)
async function callOpenAICompat(trimmed, settings, endpoint, providerName) {
  if (providerName !== 'Custom') requireKey(settings.apiKey, providerName);
  const model = settings.model;
  if (!model) throw new Error(`${providerName}: no model selected.`);

  const bodyObj = {
    model,
    messages: [{ role: 'user', content: `${settings.prompt}\n\n---\n\n${trimmed}` }]
  };

  // o1/o3/gpt-5 style reasoning models use max_completion_tokens; others max_tokens
  if (/^(o\d|gpt-5)/.test(model)) {
    bodyObj.max_completion_tokens = 8192;
  } else {
    bodyObj.max_tokens = 8192;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

  const data = await fetchLLM(endpoint, headers, bodyObj, providerName);
  const choice = data?.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (!String(text).trim()) {
    const reason = choice?.finish_reason || data?.error?.message || 'unknown';
    throw new Error(`${providerName} returned an empty summary (finish_reason: ${reason})`);
  }
  return text;
}

// Google Gemini
async function callGemini(trimmed, settings) {
  requireKey(settings.apiKey, 'Gemini');
  const model = settings.model || 'gemini-2.0-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const bodyObj = {
    contents: [{
      role: 'user',
      parts: [{ text: `${settings.prompt}\n\n---\n\n${trimmed}` }]
    }],
    generationConfig: { maxOutputTokens: 16384 }
  };

  // The key travels in a header rather than the query string so it cannot leak
  // through referrers, proxy logs or an error message echoing the URL.
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey };

  const data = await fetchLLM(endpoint, headers, bodyObj, 'Gemini');
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p?.text || '').join('');
  if (!text.trim()) {
    // On 2.5-family models the thinking tokens are billed against
    // maxOutputTokens, so a small budget yields MAX_TOKENS with no parts at all.
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || 'unknown';
    throw new Error(
      reason === 'MAX_TOKENS'
        ? 'Gemini hit the output limit before writing anything (thinking tokens consumed the budget) — try a shorter summary or another model.'
        : `Gemini returned an empty summary (finishReason: ${reason})`
    );
  }
  return text;
}
