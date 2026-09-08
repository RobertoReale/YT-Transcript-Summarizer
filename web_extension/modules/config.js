// ── Config ─────────────────────────────────────────────────────────────────────
// Centralized configuration for the YT Transcript Summarizer extension.

// ── YouTube InnerTube config ───────────────────────────────────────────────────
// Update these values when YouTube changes its internal API versions.
export const CONFIG = {
  youtube: {
    // InnerTube public API key
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    // Known working client versions
    androidClientVersion: '20.10.38',
    androidSdkVersion: 34,
    // IOS is a second, independent attestation path (iOSGuard vs DroidGuard):
    // when YouTube tightens PO-token enforcement on ANDROID, IOS often still
    // returns caption tracks. Verified working without a PO token.
    iosClientVersion: '20.10.4',
    iosDeviceModel: 'iPhone16,2',
    webClientVersion: '2.20240530.02.00'
  },

  // ── Provider Web URLs ──────────────────────────────────────────────────────
  // Used when the user wants to open the chat in a new tab instead of via API.
  // Add a new key here if you add a provider with hasWebUI: true in PROVIDERS.
  providerWebUrls: {
    anthropic:  'https://claude.ai/new',
    openai:     'https://chatgpt.com/',
    gemini:     'https://gemini.google.com/app',
  },

  transcript: {
    // A caption track is accepted only if its last cue lands within this fraction
    // of the video's real duration. YouTube sometimes serves a partial timedtext
    // body (expired URL / partial PO-token enforcement); without this check a
    // half-transcript would be summarized as if it were the whole video.
    minCoverage: 0.80,
    // Cue texts that are pure sound annotations and carry no speech. Only these
    // are dropped — a blanket /^\[.*\]$/ filter also removed legitimate lines
    // (stage directions, speaker labels) present in many manual caption tracks.
    noiseCues: /^\[(music|musica|música|musique|musik|applause|applausi|aplausos|applaudissements|laughter|risate|risas|rires|silence|silenzio|no audio|sound effects?|[^\]]*\bmusic\b[^\]]*)\]$/i
  },

  // Per-provider transcript budget, in characters. The old flat 120k cap silently
  // dropped the tail of any video longer than ~2 h even on 200k+ token models.
  // Values leave generous room for the prompt and the response.
  maxTranscriptChars: {
    anthropic:  500000,   // 200k-token context
    openai:     350000,   // 128k-token context
    gemini:     900000,   // 1M-token context
    openrouter: 300000,   // unknown model — conservative
    groq:       100000,   // 128k-token context
    custom:     200000,   // typically a small local model
    default:    200000
  },

  // ── Chunking config ─────────────────────────────────────────────────────────
  // Controls transcript splitting into multiple parts for long videos.
  chunking: {
    defaultParts: 1,      // send the transcript in one go by default
    maxParts:     10      // ceiling for the split selector
  },

  // ── Web mode composer character limits ──────────────────────────────────────
  // Per-provider hard cap on what the chat composer accepts in a single message.
  // A transcript exceeding this is split automatically (even if the user picked
  // "1 part") so the tail isn't silently truncated by the composer.
  maxWebMessageChars: {
    anthropic:  90000,    // Claude.ai truncates around 95k
    openai:     60000,    // ChatGPT truncates around 65k
    gemini:     32000,    // Gemini truncates at exactly 32k
    default:    0         // 0 = no cap known, don't auto-split
  }
};



// The transcript carries `[m:ss]` anchors every half minute, but a model only
// uses them if it is told to. Deliberately NOT folded into PROMPTS: `isPreset()`
// compares a stored prompt against those strings to decide whether it may still
// be auto-updated, so editing a preset would quietly turn every existing user's
// prompt into a "custom" one, frozen forever. This is appended at send time
// instead, and only when the transcript really has anchors.
export const TIMESTAMP_NOTES = {
  en: 'The transcript is marked with [m:ss] timestamps. Cite the relevant one in square brackets next to each point you make, copied exactly as it appears.',
  it: 'La trascrizione è marcata con timestamp [m:ss]. Cita quello pertinente tra parentesi quadre accanto a ogni punto, copiandolo esattamente come appare.',
  es: 'La transcripción está marcada con marcas de tiempo [m:ss]. Cita la correspondiente entre corchetes junto a cada punto, copiándola exactamente como aparece.',
  fr: 'La transcription est marquée avec des horodatages [m:ss]. Cite celui qui convient entre crochets à côté de chaque point, copié exactement tel quel.',
  de: 'Das Transkript ist mit [m:ss]-Zeitstempeln versehen. Nenne den passenden in eckigen Klammern neben jedem Punkt, exakt so kopiert, wie er dasteht.',
  pt: 'A transcrição está marcada com carimbos de tempo [m:ss]. Cite o relevante entre colchetes ao lado de cada ponto, copiado exatamente como aparece.',
};

export function timestampNote(lang) {
  return TIMESTAMP_NOTES[lang] || TIMESTAMP_NOTES.en;
}

// ── Providers & Models ─────────────────────────────────────────────────────────
// HOW TO ADD A PROVIDER:
//   1. Add a new key below with the required fields.
//   2. If it has a web UI, add its URL to CONFIG.providerWebUrls above.
//   3. If it needs a paste script, create <provider>_paste.js in the extension
//      root and register it in manifest.json > content_scripts.
//
// HOW TO ADD/REMOVE A MODEL:
//   - Edit the `models` array of the relevant provider.
//   - Update `defaultModel` if the current default is removed.
// ─────────────────────────────────────────────────────────────────────────────
export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude',
    models: [
      { value: 'claude-opus-4-8',   label: 'claude-opus-4-8 (Recommended)' },
      { value: 'claude-sonnet-5',   label: 'claude-sonnet-5 (Fast + capable)' },
      { value: 'claude-haiku-4-5',  label: 'claude-haiku-4-5 (Cheapest)' },
      { value: 'claude-opus-4-7',   label: 'claude-opus-4-7' },
      { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    ],
    defaultModel:      'claude-opus-4-8',
    supportsThinking:  true,
    hasWebUI:          true,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'sk-ant-...',
  },
  openai: {
    name: 'OpenAI',
    models: [
      { value: 'gpt-4o',       label: 'gpt-4o (Recommended)' },
      { value: 'gpt-4o-mini',  label: 'gpt-4o-mini (Fast)' },
      { value: 'o1',           label: 'o1 (Reasoning)' },
      { value: 'o1-mini',      label: 'o1-mini' },
      { value: 'gpt-4-turbo',  label: 'gpt-4-turbo' },
    ],
    defaultModel:      'gpt-4o',
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'sk-...',
  },
  gemini: {
    name: 'Google Gemini',
    models: [
      { value: 'gemini-2.5-flash',  label: 'gemini-2.5-flash (Fast & Recommended)' },
      { value: 'gemini-2.0-flash',  label: 'gemini-2.0-flash' },
      { value: 'gemini-1.5-pro',    label: 'gemini-1.5-pro' },
      { value: 'gemini-1.5-flash',  label: 'gemini-1.5-flash' },
    ],
    defaultModel:      'gemini-2.5-flash',
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       'API Key (Google AI Studio)',
    apiKeyPlaceholder: 'AIza...',
  },
  groq: {
    name: 'Groq',
    models: [
      { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (Recommended)' }
    ],
    defaultModel:      'llama-3.3-70b-versatile',
    supportsThinking:  false,
    hasWebUI:          false,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'gsk_...',
  },
  openrouter: {
    name: 'OpenRouter',
    models: [
      { value: 'anthropic/claude-sonnet-4-6',          label: 'claude-sonnet-4-6' },
      { value: 'openai/gpt-4o',                        label: 'gpt-4o' },
      { value: 'google/gemini-2.0-flash-exp',          label: 'gemini-2.0-flash' },
      { value: 'meta-llama/llama-3.3-70b-instruct',    label: 'llama-3.3-70b' },
      { value: 'mistralai/mistral-large',              label: 'mistral-large' },
    ],
    defaultModel:      'anthropic/claude-sonnet-4-6',
    supportsThinking:  false,
    hasWebUI:          false,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'sk-or-...',
  },
  custom: {
    name: 'Custom (OpenAI-compatible)',
    models:            [],
    defaultModel:      '',
    supportsThinking:  false,
    hasWebUI:          false,
    apiKeyLabel:       'API Key (optional)',
    apiKeyPlaceholder: '...',
  },
};

// ── Prompts ────────────────────────────────────────────────────────────────────
// HOW TO ADD A LANGUAGE:
//   1. Add a new top-level key using the ISO 639-1 code (e.g. "fr", "de", "pt").
//   2. Copy the structure from an existing language block (md + chat, each with
//      short / normal / long variants) and translate the prompt text.
//   3. The UI will automatically pick up the new language — no other changes needed.
//
// HOW TO EDIT A PROMPT:
//   - Find the language key (e.g. "en"), then the format ("md" or "chat"),
//     then the length ("short", "normal", "long") and update the string.
// ─────────────────────────────────────────────────────────────────────────────
export const PROMPTS = {
  // ── English ────────────────────────────────────────────────────────────────
  en: {
    md: {
      short:  "Summarize the following video as a markdown file (.md). Focus only on the key takeaways.",
      normal: "Generate a complete and detailed summary of the following video as a markdown file (.md). You must consider the entire video. Make sure you don't leave out any important points, explanations, or details. Always include an Executive Summary (TL;DR) and a reasoned timeline of the key points.",
      long:   "Generate an in-depth, structured summary of the following video as a markdown file (.md). Cover every section, argument, example, and detail mentioned. Organize the output with clear headings and subheadings. Include topic transitions where relevant. Do not omit anything. Always include an Executive Summary (TL;DR) and a reasoned timeline of the key points."
    },
    chat: {
      short:  "Summarize the following video. Focus only on the key takeaways.",
      normal: "Generate a complete and detailed summary of the following video. Consider the entire video. Make sure you don't leave out any important points, explanations, or details. Always include an Executive Summary (TL;DR) and a reasoned timeline of the key points.",
      long:   "Generate an in-depth, structured summary of the following video. Cover every section, argument, example, and detail mentioned. Organize the output with clear sections. Include topic transitions where relevant. Do not omit anything. Always include an Executive Summary (TL;DR) and a reasoned timeline of the key points."
    }
  },
  // ── Italian ────────────────────────────────────────────────────────────────
  it: {
    md: {
      short:  "Riassumi il seguente video in un file markdown (.md). Concentrati solo sui punti chiave.",
      normal: "Genera un riassunto completo e dettagliato del seguente video in un file markdown (.md). Devi considerare l'intero video. Assicurati di non tralasciare alcun punto, spiegazione o dettaglio importante. Includi sempre un Executive Summary (TL;DR) e una timeline ragionata dei punti chiave.",
      long:   "Genera un riassunto approfondito e strutturato del seguente video in un file markdown (.md). Tratta ogni sezione, argomento, esempio e dettaglio menzionato. Organizza l'output con titoli e sottotitoli chiari. Includi le transizioni tra argomenti dove rilevante. Non omettere nulla. Includi sempre un Executive Summary (TL;DR) e una timeline ragionata dei punti chiave."
    },
    chat: {
      short:  "Riassumi il seguente video. Concentrati solo sui punti chiave.",
      normal: "Genera un riassunto completo e dettagliato del seguente video. Devi considerare l'intero video. Assicurati di non tralasciare alcun punto, spiegazione o dettaglio importante. Includi sempre un Executive Summary (TL;DR) e una timeline ragionata dei punti chiave.",
      long:   "Genera un riassunto approfondito e strutturato del seguente video. Tratta ogni sezione, argomento, esempio e dettaglio menzionato. Organizza l'output con sezioni chiare. Includi le transizioni tra argomenti dove rilevante. Non omettere nulla. Includi sempre un Executive Summary (TL;DR) e una timeline ragionata dei punti chiave."
    }
  },
  // ── Spanish ────────────────────────────────────────────────────────────────
  es: {
    md: {
      short:  "Resume el siguiente video en un archivo markdown (.md). Céntrate solo en los puntos clave.",
      normal: "Genera un resumen completo y detallado del siguiente video en un archivo markdown (.md). Debes considerar el video completo. Asegúrate de no omitir ningún punto, explicación o detalle importante. Incluye siempre un Resumen Ejecutivo (TL;DR) y una línea de tiempo razonada de los puntos clave.",
      long:   "Genera un resumen detallado y estructurado del siguiente video en un archivo markdown (.md). Cubre cada sección, argumento, ejemplo y detalle mencionado. Organiza el resultado con títulos y subtítulos claros. Incluye transiciones entre temas donde sea relevante. No omitas nada. Incluye siempre un Resumen Ejecutivo (TL;DR) y una línea de tiempo razonada de los puntos clave."
    },
    chat: {
      short:  "Resume el siguiente video. Céntrate solo en los puntos clave.",
      normal: "Genera un resumen completo y detallado del siguiente video. Debes considerar el video completo. Asegúrate de no omitir ningún punto, explicación o detalle importante. Incluye siempre un Resumen Ejecutivo (TL;DR) y una línea de tiempo razonada de los puntos clave.",
      long:   "Genera un resumen detallado y estructurado del siguiente video. Cubre cada sección, argumento, ejemplo y detalle mencionado. Organiza el resultado con secciones claras. Incluye transiciones entre temas donde sea relevante. No omitas nada. Incluye siempre un Resumen Ejecutivo (TL;DR) y una línea de tiempo razonada de los puntos clave."
    }
  },
  // ── French ───────────────────────────────────────────────────────────────
  fr: {
    md: {
      short:  "Résume la vidéo suivante dans un fichier markdown (.md). Concentre-toi uniquement sur les points clés.",
      normal: "Génère un résumé complet et détaillé de la vidéo suivante dans un fichier markdown (.md). Considère l'intégralité de la vidéo. Assure-toi de ne manquer aucun point, explication ou détail important. Inclus toujours un Résumé Exécutif (TL;DR) et une chronologie raisonnée des points clés.",
      long:   "Génère un résumé approfondi et structuré de la vidéo suivante dans un fichier markdown (.md). Couvre chaque section, argument, exemple et détail mentionné. Organise le résultat avec des titres et sous-titres clairs. Inclus les transitions entre sujets lorsque c'est pertinent. N'omets rien. Inclus toujours un Résumé Exécutif (TL;DR) et une chronologie raisonnée des points clés."
    },
    chat: {
      short:  "Résume la vidéo suivante. Concentre-toi uniquement sur les points clés.",
      normal: "Génère un résumé complet et détaillé de la vidéo suivante. Considère l'intégralité de la vidéo. Assure-toi de ne manquer aucun point, explication ou détail important. Inclus toujours un Résumé Exécutif (TL;DR) et une chronologie raisonnée des points clés.",
      long:   "Génère un résumé approfondi et structuré de la vidéo suivante. Couvre chaque section, argument, exemple et détail mentionné. Organise le résultat avec des sections claires. Inclus les transitions entre sujets lorsque c'est pertinent. N'omets rien. Inclus toujours un Résumé Exécutif (TL;DR) et une chronologie raisonnée des points clés."
    }
  },
  // ── German ────────────────────────────────────────────────────────────────
  de: {
    md: {
      short:  "Fasse das folgende Video als Markdown-Datei (.md) zusammen. Konzentriere dich nur auf die wichtigsten Punkte.",
      normal: "Erstelle eine vollständige und detaillierte Zusammenfassung des folgenden Videos als Markdown-Datei (.md). Berücksichtige das gesamte Video. Stelle sicher, dass du keine wichtigen Punkte, Erklärungen oder Details auslässt. Füge immer eine Executive Summary (TL;DR) und eine begründete Zeitleiste der wichtigsten Punkte bei.",
      long:   "Erstelle eine ausführliche, strukturierte Zusammenfassung des folgenden Videos als Markdown-Datei (.md). Erfasse jeden Abschnitt, jedes Argument, Beispiel und Detail. Organisiere die Ausgabe mit klaren Überschriften und Unterüberschriften. Füge Themenübergänge ein, wo relevant. Lasse nichts aus. Füge immer eine Executive Summary (TL;DR) und eine begründete Zeitleiste der wichtigsten Punkte bei."
    },
    chat: {
      short:  "Fasse das folgende Video zusammen. Konzentriere dich nur auf die wichtigsten Punkte.",
      normal: "Erstelle eine vollständige und detaillierte Zusammenfassung des folgenden Videos. Berücksichtige das gesamte Video. Stelle sicher, dass du keine wichtigen Punkte, Erklärungen oder Details auslässt. Füge immer eine Executive Summary (TL;DR) und eine begründete Zeitleiste der wichtigsten Punkte bei.",
      long:   "Erstelle eine ausführliche, strukturierte Zusammenfassung des folgenden Videos. Erfasse jeden Abschnitt, jedes Argument, Beispiel und Detail. Organisiere die Ausgabe mit klaren Abschnitten. Füge Themenübergänge ein, wo relevant. Lasse nichts aus. Füge immer eine Executive Summary (TL;DR) und eine begründete Zeitleiste der wichtigsten Punkte bei."
    }
  },
  // ── Portuguese ────────────────────────────────────────────────────────────
  pt: {
    md: {
      short:  "Resume o seguinte vídeo num ficheiro markdown (.md). Concentra-te apenas nos pontos principais.",
      normal: "Gera um resumo completo e detalhado do seguinte vídeo num ficheiro markdown (.md). Considera o vídeo na íntegra. Certifica-te de que não omites nenhum ponto, explicação ou detalhe importante. Inclui sempre um Resumo Executivo (TL;DR) e uma cronologia fundamentada dos pontos-chave.",
      long:   "Gera um resumo aprofundado e estruturado do seguinte vídeo num ficheiro markdown (.md). Aborda cada secção, argumento, exemplo e detalhe mencionado. Organiza o resultado com títulos e subtítulos claros. Inclui as transições entre temas onde relevante. Não omitas nada. Inclui sempre um Resumo Executivo (TL;DR) e uma cronologia fundamentada dos pontos-chave."
    },
    chat: {
      short:  "Resume o seguinte vídeo. Concentra-te apenas nos pontos principais.",
      normal: "Gera um resumo completo e detalhado do seguinte vídeo. Considera o vídeo na íntegra. Certifica-te de que não omites nenhum ponto, explicação ou detalhe importante. Inclui sempre um Resumo Executivo (TL;DR) e uma cronologia fundamentada dos pontos-chave.",
      long:   "Gera um resumo aprofundado e estruturado do seguinte vídeo. Aborda cada secção, argumento, exemplo e detalhe mencionado. Organiza o resultado com secções claras. Inclui as transições entre temas onde relevante. Não omitas nada. Inclui sempre um Resumo Executivo (TL;DR) e uma cronologia fundamentada dos pontos-chave."
    }
  }
  // ── Add new languages below following the same structure ──────────────────
};

export function getPreset(lang, fmt, len = 'normal') {
  const isMD = fmt !== 'chat';
  const langKey = PROMPTS[lang] ? lang : 'en';
  const fmtKey = isMD ? 'md' : 'chat';
  return PROMPTS[langKey][fmtKey][len] || PROMPTS[langKey][fmtKey]['normal'];
}

export function isPreset(text) {
  if (!text) return false;
  const trimmed = text.trim();
  for (const lang of Object.values(PROMPTS)) {
    for (const fmt of Object.values(lang)) {
      for (const preset of Object.values(fmt)) {
        if (preset.trim() === trimmed) return true;
      }
    }
  }
  return false;
}
