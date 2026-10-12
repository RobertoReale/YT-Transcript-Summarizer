// ── LLM API Calls ─────────────────────────────────────────────────────────────
import { CONFIG } from './config.js';
import { streamLLM } from './llm-stream.js';
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
    // The last slice takes whatever is left: snapping cuts to line ends can
    // leave a sliver past n·size, which used to become an extra (n+1)th part.
    if (slices.length === parts - 1) next = content.length;
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
 * The number of parts the USER asked for. The manual split selector was removed
 * (modern models take a whole transcript in one request), so this is always 1;
 * it stays a function so the "asked vs. forced" distinction below keeps a name.
 */
export function requestedChunkCount() {
  return 1;
}

/**
 * How many parts this transcript is actually split into: one, unless a single
 * message would not fit the chat composer's own limit (`settings.maxMessageChars`,
 * web mode only — a composer that truncates silently would drop the tail).
 * @returns {number} 1 when the transcript should be sent in a single request
 */
export function plannedChunkCount(transcript, settings) {
  const asked = requestedChunkCount(settings);
  const len = String(transcript ?? '').length;

  // Each message also carries the prompt and the "part i of n" note, so the
  // budget for transcript text is smaller than the raw cap — sizing on the
  // transcript alone let every part overrun the composer by the prompt's length.
  // `splitToFit` gates this: when nothing will paste the follow-up parts, only
  // part 1 would ever be sent, so splitting would drop text rather than rescue it.
  const cap = settings?.splitToFit ? (Math.floor(settings?.maxMessageChars) || 0) : 0;
  const overhead = String(settings?.prompt ?? '').length + CHUNK_NOTE_CHARS;
  const needed = (cap > overhead && len > 0) ? Math.ceil(len / (cap - overhead)) : 1;

  // Past maxAutoParts the overflow warning takes over: a run of dozens of
  // messages, each waiting for a full reply, is not a rescue either.
  const wanted = Math.min(CONFIG.chunking.maxAutoParts, Math.max(asked, needed));
  if (wanted === 1) return 1;
  const fits = Math.floor(len / CONFIG.chunking.minPartChars);
  return Math.max(1, Math.min(wanted, fits));
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

  // plannedChunkCount sizes on averages; cuts snapped to line ends can still
  // leave one slice over the cap. Add a part until every message fits, within
  // the same ceiling the planner uses.
  const build = (k) => {
    const sl = splitTranscript(transcript, k);
    return sl.map((s, i) => `${chunkPrompt(settings.prompt, i + 1, sl.length, lang)}\n\n---\n\n${s}`);
  };
  let parts = build(n);
  for (let k = n + 1; settings?.splitToFit && overflowOf(parts) > 0 && k <= CONFIG.chunking.maxAutoParts; k++) {
    parts = build(k);
  }
  const count = parts.length;
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

/**
 * One summary from the configured provider, streamed and accumulated.
 *
 * `onProgress(charsSoFar)` fires as text arrives. In the service worker it is
 * what keeps the batch alive and visible: each status write is an extension API
 * call, which resets MV3's 30 s idle timer during a multi-minute generation.
 *
 * @returns {Promise<{summary: string, truncated: boolean, kept: number, total: number, outputTruncated: boolean}>}
 */
export async function callLLM(transcript, settings, { onProgress, signal } = {}) {
  const provider = settings.provider || 'anthropic';
  const apiKey = (settings.apiKeys && settings.apiKeys[provider]) || settings.apiKey || '';
  const trimmed = trimTranscript(String(transcript ?? ''), provider);

  let chars = 0;
  const { text, truncated: outputTruncated } = await streamLLM(
    `${settings.prompt}\n\n---\n\n${trimmed.text}`,
    {
      provider,
      model: settings.model,
      apiKey,
      endpoint: settings.customEndpointUrl,
      useThinking: !!settings.useThinking,
    },
    (chunk) => { chars += chunk.length; onProgress?.(chars); },
    { signal }
  );

  return { summary: text, truncated: trimmed.truncated, kept: trimmed.kept, total: trimmed.total, outputTruncated };
}
