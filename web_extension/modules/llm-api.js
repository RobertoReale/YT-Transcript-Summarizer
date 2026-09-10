// ── LLM API Calls ─────────────────────────────────────────────────────────────
import { CONFIG } from './config.js';
const CHUNK_NOTES = {
  en: {
    part: 'Part',
    instruction: (i, n) => `This is part ${i} of ${n} of the transcript. Summarize this part only. Do not repeat context from earlier parts.`,
    mergeChat: (n) => `You have just summarized ${n} parts of a video transcript. Now write a single, cohesive, final summary that combines all ${n} partial summaries above. Do not simply concatenate them — synthesize the key points into a unified document.`,
    mergeApi: (n) => `The following are ${n} partial summaries of consecutive parts of a video transcript. Write a single, cohesive, final summary that combines all of them. Do not simply concatenate — synthesize the key points into a unified document.`
  },
  it: {
    part: 'Parte',
    instruction: (i, n) => `Questa è la parte ${i} di ${n} della trascrizione. Riassumi solo questa parte. Non ripetere il contesto delle parti precedenti.`,
    mergeChat: (n) => `Hai appena riassunto ${n} parti della trascrizione di un video. Ora scrivi un unico riassunto finale e coeso che combini tutti i ${n} riassunti parziali sopra. Non limitarti a concatenarli — sintetizza i punti chiave in un documento unificato.`,
    mergeApi: (n) => `I seguenti sono ${n} riassunti parziali di parti consecutive della trascrizione di un video. Scrivi un unico riassunto finale e coeso che li combini tutti. Non limitarti a concatenarli — sintetizza i punti chiave in un documento unificato.`
  },
  es: {
    part: 'Parte',
    instruction: (i, n) => `Esta es la parte ${i} de ${n} de la transcripción. Resume solo esta parte. No repitas el contexto de partes anteriores.`,
    mergeChat: (n) => `Acabas de resumir ${n} partes de la transcripción de un video. Ahora escribe un único resumen final y cohesivo que combine todos los ${n} resúmenes parciales anteriores. No los concatenes simplemente — sintetiza los puntos clave en un documento unificado.`,
    mergeApi: (n) => `Los siguientes son ${n} resúmenes parciales de partes consecutivas de la transcripción de un video. Escribe un único resumen final y cohesivo que los combine todos. No los concatenes simplemente — sintetiza los puntos clave en un documento unificado.`
  },
  fr: {
    part: 'Partie',
    instruction: (i, n) => `Ceci est la partie ${i} sur ${n} de la transcription. Résume uniquement cette partie. Ne répète pas le contexte des parties précédentes.`,
    mergeChat: (n) => `Tu viens de résumer ${n} parties de la transcription d'une vidéo. Écris maintenant un résumé final unique et cohérent qui combine les ${n} résumés partiels ci-dessus. Ne les concatène pas simplement — synthétise les points clés en un document unifié.`,
    mergeApi: (n) => `Ce qui suit sont ${n} résumés partiels de parties consécutives de la transcription d'une vidéo. Écris un résumé final unique et cohérent qui les combine tous. Ne les concatène pas simplement — synthétise les points clés en un document unifié.`
  },
  de: {
    part: 'Teil',
    instruction: (i, n) => `Dies ist Teil ${i} von ${n} des Transkripts. Fasse nur diesen Teil zusammen. Wiederhole keinen Kontext aus früheren Teilen.`,
    mergeChat: (n) => `Du hast gerade ${n} Teile eines Videotranskripts zusammengefasst. Schreibe nun eine einzige, zusammenhängende Endzusammenfassung, die alle ${n} Teilzusammenfassungen oben vereint. Verkette sie nicht einfach — fasse die Kernpunkte in einem einheitlichen Dokument zusammen.`,
    mergeApi: (n) => `Das Folgende sind ${n} Teilzusammenfassungen aufeinanderfolgender Abschnitte eines Videotranskripts. Schreibe eine einzige, zusammenhängende Endzusammenfassung, die alle vereint. Verkette sie nicht einfach — fasse die Kernpunkte in einem einheitlichen Dokument zusammen.`
  },
  pt: {
    part: 'Parte',
    instruction: (i, n) => `Esta é a parte ${i} de ${n} da transcrição. Resume apenas esta parte. Não repitas o contexto de partes anteriores.`,
    mergeChat: (n) => `Acabaste de resumir ${n} partes da transcrição de um vídeo. Agora escreve um único resumo final e coeso que combine todos os ${n} resumos parciais acima. Não os concatenes simplesmente — sintetiza os pontos-chave num documento unificado.`,
    mergeApi: (n) => `Os seguintes são ${n} resumos parciais de partes consecutivas da transcrição de um vídeo. Escreve um único resumo final e coeso que os combine todos. Não os concatenes simplesmente — sintetiza os pontos-chave num documento unificado.`
  }
};

const chunkNotes = (lang) => CHUNK_NOTES[lang] || CHUNK_NOTES.en;
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
  const content = String(text || '');
  if (parts <= 1 || !content) return [content];

  const size = Math.ceil(content.length / parts);
  const slices = [];
  let pos = 0;

  while (pos < content.length) {
    let next = pos + size;
    if (next < content.length) {
      let n = Math.max(content.lastIndexOf('\n', next), content.lastIndexOf('. ', next));
      if (n > pos + size * 0.7) {
        next = n + 1;
      } else {
        // Fallback: look forward if no good cut point was found backward
        n = Math.max(content.indexOf('\n', next), content.indexOf('. ', next));
        if (n !== -1 && n < pos + size * 1.3) next = n + 1;
      }
    } else {
      next = content.length;
    }
    slices.push(content.slice(pos, next).trim());
    pos = next;
  }
  return slices;
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
  const asked = requestedChunkCount(settings);
  if ((settings.mode || 'web') !== 'web') return asked;

  const cap = settings.maxMessageChars || 0;
  if (!cap || transcript.length <= cap) return asked;

  return Math.max(asked, Math.ceil(transcript.length / cap));
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
  const isSeparate = settings.chunkMode === 'separate' || 
                     (settings.chunkMode === 'same' && settings.chunkAuto && count > (settings.chunkAutoNum || 3));
  const merged = settings.chunkMerge ?? true;
  if (merged && !isSeparate) parts.push(mergeChatPrompt(count, lang));
  return {
    parts, chunks: count, asked, autoSplit, merged, isSeparate,
    mergePlan: (merged && !isSeparate) ? mergePlanFor(settings, count, lang, cap) : null,
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
    case 'groq':
      summary = await callOpenAICompat(trimmed.text, s, 'https://api.groq.com/openai/v1/chat/completions', 'Groq');
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
