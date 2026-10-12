// ── Version ────────────────────────────────────────────────────────────────────
// Automatically read from package.json — bump the version there, not here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const APP_VERSION: string = require("../../package.json").version;

// ── YouTube InnerTube config ───────────────────────────────────────────────────
// Update these values when YouTube changes its internal API versions.
export const CONFIG = {
  youtube: {
    // InnerTube public API key
    apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    // Known working client versions
    androidClientVersion: "20.10.38",
    androidSdkVersion: 34,
    webClientVersion: "2.20240530.02.00",
    iosClientVersion: "20.10.4",
    iosDeviceModel: "iPhone16,2",
    iosOsVersion: "17.5.1.21F90",
    tvClientVersion: "7.20231021.0.0",
  },

  // ── Provider Web URLs ──────────────────────────────────────────────────────
  // Used when the user wants to open the chat in a new tab instead of via API.
  // Add a new key here if you add a provider with hasWebUI: true in PROVIDERS.
  providerWebUrls: {
    anthropic:  "https://claude.ai/new",
    openai:     "https://chatgpt.com/",
    gemini:     "https://gemini.google.com/app",
  } as Record<string, string>
};

export type ProviderConfig = {
  name: string;
  models: { value: string; label: string }[];
  defaultModel: string;
  supportsThinking: boolean;
  hasWebUI: boolean;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
};

// ── Providers & Models ─────────────────────────────────────────────────────────
// HOW TO ADD A PROVIDER:
//   1. Add a new key below with the required fields.
//   2. If it has a web UI, add its URL to CONFIG.providerWebUrls above.
//   3. If it needs a paste script, create web_extension/<provider>_paste.js
//      and register it in web_extension/manifest.json > content_scripts.
//
// HOW TO ADD/REMOVE A MODEL:
//   - Edit the `models` array of the relevant provider.
//   - Update `defaultModel` if the current default is removed.
// ─────────────────────────────────────────────────────────────────────────────
export const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    name: "Anthropic Claude",
    models: [
      { value: "claude-sonnet-5-5", label: "claude-sonnet-5-5 (Recommended)" },
      { value: "claude-opus-5-5",   label: "claude-opus-5-5 (Most capable Opus)" },
      { value: "claude-haiku-5-5",  label: "claude-haiku-5-5 (Fastest)" },
    ],
    defaultModel:      "claude-sonnet-5-5",
    supportsThinking:  true,
    hasWebUI:          true,
    apiKeyLabel:       "API Key",
    apiKeyPlaceholder: "sk-ant-...",
  },
  openai: {
    name: "OpenAI",
    models: [
      { value: "gpt-6.1-sol", label: "gpt-6.1-sol (Recommended)" },
      { value: "gpt-6-astra", label: "gpt-6-astra (Flagship)" },
      { value: "gpt-6-luna",  label: "gpt-6-luna (Fast)" },
    ],
    defaultModel:      "gpt-6.1-sol",
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       "API Key",
    apiKeyPlaceholder: "sk-...",
  },
  gemini: {
    name: "Google Gemini",
    models: [
      { value: "gemini-3.8-flash",      label: "gemini-3.8-flash (Recommended)" },
      { value: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite (Fast)" },
    ],
    defaultModel:      "gemini-3.8-flash",
    supportsThinking:  false,
    hasWebUI:          true,
    apiKeyLabel:       "API Key (Google AI Studio)",
    apiKeyPlaceholder: "AIza...",
  },
};

// ── Supported Languages ────────────────────────────────────────────────────────
// Master list of languages shown in the UI dropdown.
// Key = ISO 639-1 code, value = display name.
// Languages without a PROMPTS entry below fall back to the English prompt.
// ─────────────────────────────────────────────────────────────────────────────
export const LANGUAGES: Record<string, string> = {
  it: "Italiano",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  ar: "العربية",
  ru: "Русский",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  hi: "हिन्दी",
};

// ── Prompts ────────────────────────────────────────────────────────────────────
// HOW TO ADD A LANGUAGE:
//   1. Add its ISO 639-1 code + display name to LANGUAGES above.
//   2. Add a new top-level key here using the same code.
//   3. Copy the structure from an existing block (md + chat, short/normal/long).
// Languages not listed here fall back to the English prompt automatically.
//
// HOW TO EDIT A PROMPT:
//   - Find the language key (e.g. "en"), then the format ("md" or "chat"),
//     then the length ("short", "normal", "long") and update the string.
// ─────────────────────────────────────────────────────────────────────────────
type PromptsMap = {
  [lang: string]: {
    [fmt: string]: {
      [len: string]: string;
    };
  };
};

export const PROMPTS: PromptsMap = {
  // ── English ──────────────────────────────────────────────────────────────
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
  // ── Italian ───────────────────────────────────────────────────────────────
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
  // ── Spanish ───────────────────────────────────────────────────────────────
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

export function getPreset(lang: string, len: string = "normal"): string {
  const langKey = PROMPTS[lang] ? lang : "en";
  return PROMPTS[langKey]["chat"][len] || PROMPTS[langKey]["chat"]["normal"];
}
