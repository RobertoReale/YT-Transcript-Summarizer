// ── Config ─────────────────────────────────────────────────────────────────────
// Centralized configuration for the YT Summarizer extension.

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
  // A transcript is sent whole, except in web mode when one message would not
  // fit the chat composer (maxWebMessageChars below): then it is split just
  // enough to fit, within these bounds.
  chunking: {
    maxAutoParts: 20,     // past this the overflow warning takes over
    minPartChars: 2000    // never cut a short transcript into pointless slivers
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
// Last checked against the providers' own model and deprecation pages on
// 2026-10-12. The model field is an editable combobox, so a stale list never
// blocks anyone — but the *default* must be a model a brand-new key can call.
export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude',
    models: [
      { value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5 (Recommended)' },
      { value: 'claude-opus-5-5',   label: 'claude-opus-5-5 (Most capable Opus)' },
      { value: 'claude-haiku-5-5',  label: 'claude-haiku-5-5 (Fastest, cheapest)' },
      { value: 'claude-fable-5-1',  label: 'claude-fable-5-1 (Top tier, premium price)' },
      { value: 'claude-opus-4-8',   label: 'claude-opus-4-8' },
    ],
    defaultModel:      'claude-sonnet-5-5',
    supportsThinking:  true,
    hasWebUI:          true,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'sk-ant-...',
  },
  openai: {
    name: 'OpenAI',
    models: [
      { value: 'gpt-6.1-sol',  label: 'gpt-6.1-sol (Recommended)' },
      { value: 'gpt-6-astra',  label: 'gpt-6-astra (Flagship)' },
      { value: 'gpt-6-luna',   label: 'gpt-6-luna (Fast, cheapest)' },
      { value: 'gpt-5.6-sol',  label: 'gpt-5.6-sol' },
    ],
    defaultModel:      'gpt-6.1-sol',
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'sk-...',
  },
  gemini: {
    name: 'Google Gemini',
    models: [
      { value: 'gemini-3.8-flash',      label: 'gemini-3.8-flash (Recommended)' },
      { value: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Fastest, cheapest)' },
      { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
    ],
    defaultModel:      'gemini-3.8-flash',
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       'API Key (Google AI Studio)',
    apiKeyPlaceholder: 'AIza...',
  },
  groq: {
    name: 'Groq',
    models: [
      { value: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (Recommended)' },
      { value: 'openai/gpt-oss-20b',  label: 'gpt-oss-20b (Fastest)' },
      { value: 'qwen/qwen3.8-27b',    label: 'qwen3.8-27b (Preview)' },
    ],
    defaultModel:      'openai/gpt-oss-120b',
    supportsThinking:  false,
    hasWebUI:          false,
    apiKeyLabel:       'API Key',
    apiKeyPlaceholder: 'gsk_...',
  },
  openrouter: {
    name: 'OpenRouter',
    models: [
      { value: 'anthropic/claude-sonnet-5.5', label: 'claude-sonnet-5.5' },
      { value: 'openai/gpt-6.1-sol',          label: 'gpt-6.1-sol' },
      { value: 'google/gemini-3.8-flash',     label: 'gemini-3.8-flash' },
      { value: 'deepseek/deepseek-v4-flash',  label: 'deepseek-v4-flash' },
      { value: 'openai/gpt-oss-120b',         label: 'gpt-oss-120b' },
    ],
    defaultModel:      'anthropic/claude-sonnet-5.5',
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

// Models whose shutdown is confirmed (or already past) on the provider's own
// deprecation page. A stored model matching one of these would only produce an
// API error, so it is replaced by the provider's current default at use time.
const RETIRED_MODELS = {
  anthropic:  /^claude-(2|3|instant)|^claude-(sonnet|opus)-4-(0|2025)/,
  openai:     /^(gpt-4o-2024-05-13|gpt-4-turbo|gpt-4\.1-nano|o1|o4-mini|gpt-3\.5)/,
  gemini:     /^gemini-(1\.|2\.0)/,
  groq:       /^(llama-3\.[13]-|llama3-|gemma2-|mixtral-|qwen\/qwen3(-32b|\.6-))/,
  openrouter: /^google\/gemini-(1\.|2\.0)/,
};

// The defaults older versions shipped. persistSettings saves whatever the model
// field shows, so a user who never touched it has one of these frozen in
// storage. Migrated once — after that, a deliberate choice is left alone.
const OLD_DEFAULTS = {
  openai:     ['gpt-4o'],
  gemini:     ['gemini-2.5-flash', 'gemini-2.0-flash'],
  groq:       ['llama-3.3-70b-versatile'],
  openrouter: ['anthropic/claude-sonnet-4-6', 'google/gemini-2.0-flash-exp'],
};
const MODEL_MIGRATION_VERSION = 1;

/** The model to actually use: the stored one, unless it is empty or retired. */
export function resolveModel(provider, stored) {
  const info = PROVIDERS[provider];
  const m = String(stored || '').trim();
  if (!info) return m;
  if (!m) return info.defaultModel;
  return RETIRED_MODELS[provider]?.test(m) ? info.defaultModel : m;
}

/** Rewrite retired (and, once, stale default) model ids in storage. */
export async function migrateStoredModels() {
  const { models, model, modelMigration = 0 } =
    await chrome.storage.local.get(['models', 'model', 'modelMigration']);
  const next = { ...(models || {}) };
  let changed = false;
  for (const [provider, m] of Object.entries(next)) {
    let r = resolveModel(provider, m);
    if (modelMigration < MODEL_MIGRATION_VERSION && OLD_DEFAULTS[provider]?.includes(m)) {
      r = PROVIDERS[provider].defaultModel;
    }
    if (m && r !== m) { next[provider] = r; changed = true; }
  }
  const patch = { modelMigration: MODEL_MIGRATION_VERSION };
  if (changed) patch.models = next;
  // Legacy single-provider key from the Anthropic-only days.
  if (model && resolveModel('anthropic', model) !== model) patch.model = resolveModel('anthropic', model);
  await chrome.storage.local.set(patch);
}

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
      normal: "Generate a complete and detailed summary of the following video as a markdown file (.md). You must consider the entire video. Make sure you don't leave out any important points, explanations, or details.",
      long:   "Generate an in-depth, structured summary of the following video as a markdown file (.md). Cover every section, argument, example, and detail mentioned. Organize the output with clear headings and subheadings. Include topic transitions where relevant. Do not omit anything."
    },
    chat: {
      short:  "Summarize the following video. Focus only on the key takeaways.",
      normal: "Generate a complete and detailed summary of the following video. Consider the entire video. Make sure you don't leave out any important points, explanations, or details.",
      long:   "Generate an in-depth, structured summary of the following video. Cover every section, argument, example, and detail mentioned. Organize the output with clear sections. Include topic transitions where relevant. Do not omit anything."
    }
  },
  // ── Italian ────────────────────────────────────────────────────────────────
  it: {
    md: {
      short:  "Riassumi il seguente video in un file markdown (.md). Concentrati solo sui punti chiave.",
      normal: "Genera un riassunto completo e dettagliato del seguente video in un file markdown (.md). Devi considerare l'intero video. Assicurati di non tralasciare alcun punto, spiegazione o dettaglio importante.",
      long:   "Genera un riassunto approfondito e strutturato del seguente video in un file markdown (.md). Tratta ogni sezione, argomento, esempio e dettaglio menzionato. Organizza l'output con titoli e sottotitoli chiari. Includi le transizioni tra argomenti dove rilevante. Non omettere nulla."
    },
    chat: {
      short:  "Riassumi il seguente video. Concentrati solo sui punti chiave.",
      normal: "Genera un riassunto completo e dettagliato del seguente video. Devi considerare l'intero video. Assicurati di non tralasciare alcun punto, spiegazione o dettaglio importante.",
      long:   "Genera un riassunto approfondito e strutturato del seguente video. Tratta ogni sezione, argomento, esempio e dettaglio menzionato. Organizza l'output con sezioni chiare. Includi le transizioni tra argomenti dove rilevante. Non omettere nulla."
    }
  },
  // ── Spanish ────────────────────────────────────────────────────────────────
  es: {
    md: {
      short:  "Resume el siguiente video en un archivo markdown (.md). Céntrate solo en los puntos clave.",
      normal: "Genera un resumen completo y detallado del siguiente video en un archivo markdown (.md). Debes considerar el video completo. Asegúrate de no omitir ningún punto, explicación o detalle importante.",
      long:   "Genera un resumen detallado y estructurado del siguiente video en un archivo markdown (.md). Cubre cada sección, argumento, ejemplo y detalle mencionado. Organiza el resultado con títulos y subtítulos claros. Incluye transiciones entre temas donde sea relevante. No omitas nada."
    },
    chat: {
      short:  "Resume el siguiente video. Céntrate solo en los puntos clave.",
      normal: "Genera un resumen completo y detallado del siguiente video. Debes considerar el video completo. Asegúrate de no omitir ningún punto, explicación o detalle importante.",
      long:   "Genera un resumen detallado y estructurado del siguiente video. Cubre cada sección, argumento, ejemplo y detalle mencionado. Organiza el resultado con secciones claras. Incluye transiciones entre temas donde sea relevante. No omitas nada."
    }
  },
  // ── French ───────────────────────────────────────────────────────────────
  fr: {
    md: {
      short:  "Résume la vidéo suivante dans un fichier markdown (.md). Concentre-toi uniquement sur les points clés.",
      normal: "Génère un résumé complet et détaillé de la vidéo suivante dans un fichier markdown (.md). Considère l'intégralité de la vidéo. Assure-toi de ne manquer aucun point, explication ou détail important.",
      long:   "Génère un résumé approfondi et structuré de la vidéo suivante dans un fichier markdown (.md). Couvre chaque section, argument, exemple et détail mentionné. Organise le résultat avec des titres et sous-titres clairs. Inclus les transitions entre sujets lorsque c'est pertinent. N'omets rien."
    },
    chat: {
      short:  "Résume la vidéo suivante. Concentre-toi uniquement sur les points clés.",
      normal: "Génère un résumé complet et détaillé de la vidéo suivante. Considère l'intégralité de la vidéo. Assure-toi de ne manquer aucun point, explication ou détail important.",
      long:   "Génère un résumé approfondi et structuré de la vidéo suivante. Couvre chaque section, argument, exemple et détail mentionné. Organise le résultat avec des sections claires. Inclus les transitions entre sujets lorsque c'est pertinent. N'omets rien."
    }
  },
  // ── German ────────────────────────────────────────────────────────────────
  de: {
    md: {
      short:  "Fasse das folgende Video als Markdown-Datei (.md) zusammen. Konzentriere dich nur auf die wichtigsten Punkte.",
      normal: "Erstelle eine vollständige und detaillierte Zusammenfassung des folgenden Videos als Markdown-Datei (.md). Berücksichtige das gesamte Video. Stelle sicher, dass du keine wichtigen Punkte, Erklärungen oder Details auslässt.",
      long:   "Erstelle eine ausführliche, strukturierte Zusammenfassung des folgenden Videos als Markdown-Datei (.md). Erfasse jeden Abschnitt, jedes Argument, Beispiel und Detail. Organisiere die Ausgabe mit klaren Überschriften und Unterüberschriften. Füge Themenübergänge ein, wo relevant. Lasse nichts aus."
    },
    chat: {
      short:  "Fasse das folgende Video zusammen. Konzentriere dich nur auf die wichtigsten Punkte.",
      normal: "Erstelle eine vollständige und detaillierte Zusammenfassung des folgenden Videos. Berücksichtige das gesamte Video. Stelle sicher, dass du keine wichtigen Punkte, Erklärungen oder Details auslässt.",
      long:   "Erstelle eine ausführliche, strukturierte Zusammenfassung des folgenden Videos. Erfasse jeden Abschnitt, jedes Argument, Beispiel und Detail. Organisiere die Ausgabe mit klaren Abschnitten. Füge Themenübergänge ein, wo relevant. Lasse nichts aus."
    }
  },
  // ── Portuguese ────────────────────────────────────────────────────────────
  pt: {
    md: {
      short:  "Resume o seguinte vídeo num ficheiro markdown (.md). Concentra-te apenas nos pontos principais.",
      normal: "Gera um resumo completo e detalhado do seguinte vídeo num ficheiro markdown (.md). Considera o vídeo na íntegra. Certifica-te de que não omites nenhum ponto, explicação ou detalhe importante.",
      long:   "Gera um resumo aprofundado e estruturado do seguinte vídeo num ficheiro markdown (.md). Aborda cada secção, argumento, exemplo e detalhe mencionado. Organiza o resultado com títulos e subtítulos claros. Inclui as transições entre temas onde relevante. Não omitas nada."
    },
    chat: {
      short:  "Resume o seguinte vídeo. Concentra-te apenas nos pontos principais.",
      normal: "Gera um resumo completo e detalhado do seguinte vídeo. Considera o vídeo na íntegra. Certifica-te de que não omites nenhum ponto, explicação ou detalhe importante.",
      long:   "Gera um resumo aprofundado e estruturado do seguinte vídeo. Aborda cada secção, argumento, exemplo e detalhe mencionado. Organiza o resultado com secções claras. Inclui as transições entre temas onde relevante. Não omitas nada."
    }
  }
  // ── Add new languages below following the same structure ──────────────────
};

export const DEFAULT_PROMPTS = JSON.parse(JSON.stringify(PROMPTS));

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

export async function initPrompts() {
  try {
    const { customTemplates } = await chrome.storage.local.get('customTemplates');
    if (!customTemplates) return;
    
    for (const lang of Object.keys(customTemplates)) {
      if (!PROMPTS[lang]) continue;
      for (const fmt of Object.keys(customTemplates[lang])) {
        if (!PROMPTS[lang][fmt]) continue;
        for (const len of Object.keys(customTemplates[lang][fmt])) {
          if (PROMPTS[lang][fmt][len] !== undefined) {
            PROMPTS[lang][fmt][len] = customTemplates[lang][fmt][len];
          }
        }
      }
    }
  } catch (e) {
    console.warn("Failed to load custom prompt templates", e);
  }
}
