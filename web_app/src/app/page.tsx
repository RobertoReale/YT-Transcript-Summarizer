"use client";

import { useState, useEffect, useRef } from "react";
import TranscriptForm from "@/components/TranscriptForm";
import ActionButtons from "@/components/ActionButtons";
import SettingsModal from "@/components/SettingsModal";
import { getPreset, APP_VERSION } from "@/lib/config";

// ── Cache constants ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_PREFIX = "yt_cache_";
const MAX_CACHE_ENTRIES = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:v=|youtu\.be\/|shorts\/|embed\/|\/v\/|\/live\/)([0-9A-Za-z_-]{11})/
  );
  return match ? match[1] : null;
}

function readCache(
  videoId: string,
  lang: string
): {
  transcript: string;
  title: string;
  strategy: string;
  lang?: string;
  length?: string;
} | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${videoId}_${lang}`);
    if (!raw) return null;
    const { transcript, title, strategy, length, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(`${CACHE_PREFIX}${videoId}_${lang}`);
      return null;
    }
    return { transcript, title, strategy, lang, length };
  } catch {
    return null;
  }
}

/**
 * Evict the oldest cache entries so we stay under MAX_CACHE_ENTRIES.
 * `extraEvictions` removes additional entries beyond the limit (used when
 * localStorage throws QuotaExceededError and we need to free more space).
 */
function evictOldCacheEntries(extraEvictions = 0) {
  const entries: { key: string; timestamp: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    try {
      const { timestamp } = JSON.parse(localStorage.getItem(key)!);
      entries.push({ key, timestamp: timestamp || 0 });
    } catch {
      // Corrupt entry — mark for removal with oldest possible timestamp
      entries.push({ key, timestamp: 0 });
    }
  }

  // Oldest first
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // +1 because we're about to write a new entry
  const toRemove =
    Math.max(0, entries.length - MAX_CACHE_ENTRIES + 1) + extraEvictions;
  for (let i = 0; i < Math.min(toRemove, entries.length); i++) {
    localStorage.removeItem(entries[i].key);
  }
}

function clearAllCache() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(CACHE_PREFIX)) keysToRemove.push(key);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
}

function writeCache(
  videoId: string,
  transcript: string,
  title: string,
  strategy: string,
  lang: string,
  length: string
) {
  const key = `${CACHE_PREFIX}${videoId}_${lang}`;
  const value = JSON.stringify({
    transcript,
    title,
    strategy,
    lang,
    length,
    timestamp: Date.now(),
  });

  // If the key already exists we're overwriting it, not adding a new entry,
  // so eviction is not needed (the total count won't increase).
  const isUpdate = localStorage.getItem(key) !== null;

  try {
    if (!isUpdate) evictOldCacheEntries();
    localStorage.setItem(key, value);
  } catch {
    // QuotaExceeded — evict more aggressively and retry
    try {
      evictOldCacheEntries(5);
      localStorage.setItem(key, value);
    } catch {
      // Still can't write — give up silently
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type CacheChoice = {
  url: string;
  provider: string;
  length: string;
  lang: string;
  cached: {
    transcript: string;
    title: string;
    strategy: string;
    lang?: string;
    length?: string;
  };
};

type PromptReady = {
  text: string;
  provider: string;
  strategy: string;
  truncated?: boolean;
  timedOut?: boolean;
  transcript?: string;
  title?: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [streamLogs, setStreamLogs] = useState<string[]>([]);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [promptReady, setPromptReady] = useState<PromptReady | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [history, setHistory] = useState<
    { url: string; title: string; date: string }[]
  >([]);
  const [selectedUrl, setSelectedUrl] = useState<string | undefined>(undefined);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [copiedResultLog, setCopiedResultLog] = useState(false);
  const [resultLogs, setResultLogs] = useState<string[]>([]);
  const [pendingCacheChoice, setPendingCacheChoice] =
    useState<CacheChoice | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiKeys, setApiKeys] = useState<{ supadata?: string; transcriptApi?: string }>({});

  const abortControllerRef = useRef<AbortController | null>(null);

  // Load history, URL params, and API keys on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("videoHistory");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setHistory(JSON.parse(saved));
      
      setApiKeys({
        supadata: localStorage.getItem("SUPADATA_API_KEY") || undefined,
        transcriptApi: localStorage.getItem("TRANSCRIPTAPI_KEY") || undefined,
      });
    } catch {}
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get("url") || params.get("text");
    if (urlParam) setSelectedUrl(urlParam);
  }, []);

  // Theme toggle
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  // Elapsed time counter (ticks every second while loading)
  useEffect(() => {
    if (!isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElapsedTime(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isLoading]);

  // ── Cancel extraction ──────────────────────────────────────────────────

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // ── Extract transcript (SSE streaming) ─────────────────────────────────

  const handleExtract = async (
    url: string,
    provider: string,
    length: string,
    lang: string,
    forceRefresh = false
  ) => {
    setIsLoading(true);
    setError(null);
    setDebugLogs([]);
    setStreamLogs([]);
    setResultLogs([]);
    setPromptReady(null);
    setPendingCacheChoice(null);

    try {
      const videoId = extractVideoId(url);

      // ── Check cache first ──────────────────────────────────────────
      if (videoId && !forceRefresh) {
        const cached = readCache(videoId, lang);
        if (cached) {
          setIsLoading(false);
          setPendingCacheChoice({ url, provider, length, lang, cached });
          return;
        }
      }

      // ── Fetch with AbortController for cancel support ──────────────
      const ctrl = new AbortController();
      abortControllerRef.current = ctrl;

      const res = await fetch("/api/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, lang, apiKeys }),
        signal: ctrl.signal,
      });

      // Validation errors (400) come as regular JSON, not SSE
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to extract transcript.");
      }

      // ── Read SSE stream ────────────────────────────────────────────
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resultData: {
        title: string;
        transcript: string;
        strategy: string;
        truncated: boolean;
        timedOut: boolean;
      } | null = null;
      const logs: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;

            let eventData;
            try {
              eventData = JSON.parse(line.slice(6));
            } catch {
              continue; // Skip malformed SSE lines
            }

            if (eventData.type === "log") {
              logs.push(eventData.message);
              setStreamLogs([...logs]);
            } else if (eventData.type === "result") {
              resultData = eventData;
            } else if (eventData.type === "error") {
              setDebugLogs([...logs]);
              throw new Error(eventData.message);
            }
          }
        }
      }

      if (!resultData) {
        setDebugLogs([...logs]);
        throw new Error("No response received from server.");
      }

      // ── Success — persist and display ──────────────────────────────
      if (videoId) {
        writeCache(
          videoId,
          resultData.transcript,
          resultData.title || url,
          resultData.strategy || "",
          lang,
          length
        );
      }

      setHistory((prev) => {
        const title = resultData!.title || url;
        const newEntry = { url, title, date: new Date().toISOString() };
        let updated = [...prev];
        const idx = updated.findIndex((h) => h.url === url);
        if (idx >= 0) updated.splice(idx, 1);
        updated.unshift(newEntry);
        if (updated.length > 50) updated = updated.slice(0, 50);
        try {
          localStorage.setItem("videoHistory", JSON.stringify(updated));
        } catch {}
        return updated;
      });

      const promptInstruction = getPreset(lang, length);
      const fullPrompt = `${promptInstruction}\n\n---\n\n${resultData.transcript}`;
      setPromptReady({
        text: fullPrompt,
        provider,
        strategy: resultData.strategy || "",
        truncated: !!resultData.truncated,
        timedOut: !!resultData.timedOut,
        transcript: resultData.transcript,
        title: resultData.title,
      });
      setResultLogs([...logs]);
      setStreamLogs([]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // User cancelled — just reset, no error
        setStreamLogs([]);
      } else {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  // ── Use cached transcript ──────────────────────────────────────────────

  const handleUseCached = () => {
    if (!pendingCacheChoice) return;
    const { url, provider, length, lang, cached } = pendingCacheChoice;
    const promptInstruction = getPreset(lang, length);
    const fullPrompt = `${promptInstruction}\n\n---\n\n${cached.transcript}`;
    setResultLogs([]);
    setPromptReady({
      text: fullPrompt,
      provider,
      strategy: `${cached.strategy} (cached)`,
      transcript: cached.transcript,
      title: cached.title,
    });
    setPendingCacheChoice(null);
    const videoId = extractVideoId(url);
    if (videoId) {
      setHistory((prev) => {
        const newEntry = {
          url,
          title: cached.title,
          date: new Date().toISOString(),
        };
        let updated = [...prev];
        const idx = updated.findIndex((h) => h.url === url);
        if (idx >= 0) updated.splice(idx, 1);
        updated.unshift(newEntry);
        if (updated.length > 50) updated = updated.slice(0, 50);
        try {
          localStorage.setItem("videoHistory", JSON.stringify(updated));
        } catch {}
        return updated;
      });
    }
  };

  // ── Clear all cached transcripts ──────────────────────────────────────

  const handleClearCache = () => {
    clearAllCache();
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  };

  // ── Re-fetch (bypass cache) ────────────────────────────────────────────

  const handleRefetch = () => {
    if (!pendingCacheChoice) return;
    const { url, provider, length, lang } = pendingCacheChoice;
    setPendingCacheChoice(null);
    handleExtract(url, provider, length, lang, true);
  };

  // ── Derived values ─────────────────────────────────────────────────────

  const LANG_LABELS: Record<string, string> = {
    it: "Italiano",
    en: "English",
    es: "Español",
  };
  const LENGTH_LABELS: Record<string, string> = {
    short: "Short",
    normal: "Normal",
    long: "Long",
  };
  const cacheDiffLabel = (() => {
    if (!pendingCacheChoice) return "";
    const { cached, lang, length } = pendingCacheChoice;
    const parts: string[] = [];
    if (cached.lang && cached.lang !== lang)
      parts.push(LANG_LABELS[cached.lang] ?? cached.lang);
    if (cached.length && cached.length !== length)
      parts.push(LENGTH_LABELS[cached.length] ?? cached.length);
    return parts.join(", ");
  })();

  const charCount = promptReady?.text.length ?? 0;
  const charColorClass =
    charCount > 100000
      ? "text-red-500"
      : charCount > 50000
        ? "text-amber-500"
        : "text-green-600 dark:text-green-400 opacity-60";

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-lg mx-auto relative z-10">
      {/* Theme Toggle Button */}
      <button
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="absolute top-6 right-6 p-2 rounded-full bg-[var(--card-bg)] border border-[var(--card-border)] text-[var(--foreground)] shadow-sm hover:scale-105 active:scale-95 transition-all z-50"
        aria-label="Toggle Theme"
      >
        {theme === "dark" ? (
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
            ></path>
          </svg>
        ) : (
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
            ></path>
          </svg>
        )}
      </button>

      {/* Settings Button */}
      <button
        onClick={() => setIsSettingsOpen(true)}
        className="absolute top-6 right-20 p-2 rounded-full bg-[var(--card-bg)] border border-[var(--card-border)] text-[var(--foreground)] shadow-sm hover:scale-105 active:scale-95 transition-all z-50"
        aria-label="API Settings"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
        </svg>
      </button>

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        onSave={(keys) => setApiKeys(keys)} 
      />

      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute -top-[10%] -left-[10%] w-[50%] h-[50%] rounded-full bg-brand-500/10 blur-[100px]" />
        <div className="absolute top-[20%] -right-[10%] w-[40%] h-[40%] rounded-full bg-purple-500/10 blur-[80px]" />
      </div>

      <div className="flex flex-col items-center mb-8 text-center animate-in fade-in slide-in-from-top-4 duration-500">
        <div className="w-16 h-16 bg-gradient-to-br from-brand-500 to-purple-600 rounded-2xl shadow-xl flex items-center justify-center mb-4 transform -rotate-6">
          <svg
            className="w-8 h-8 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            ></path>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
        </div>
        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[var(--foreground)] to-gray-500">
          YT Summarizer
        </h1>
        <p className="text-sm text-[var(--foreground)] opacity-60 mt-2">
          Extract transcripts and generate AI summaries effortlessly on mobile.
        </p>
        <p className="text-xs text-[var(--foreground)] opacity-30 mt-1">
          v{APP_VERSION}
        </p>
        <p className="text-xs text-[var(--foreground)] opacity-40 mt-1">
          Made with ❤️ by{" "}
          <a
            href="https://github.com/RobertoReale"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-purple-500 dark:text-purple-400 hover:opacity-75 transition-opacity"
          >
            Roberto Reale
          </a>
        </p>
      </div>

      <div className="w-full flex flex-col gap-6 animate-in fade-in zoom-in-95 duration-500 delay-150 fill-mode-both">
        <TranscriptForm
          onSubmit={handleExtract}
          isLoading={isLoading}
          selectedUrl={selectedUrl}
        />

        {/* ── Progress panel (visible during extraction) ──────────── */}
        {isLoading && (
          <div className="glass rounded-3xl p-5 flex flex-col gap-4 border border-white/10 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-brand-500" />
                </div>
                <span className="text-sm font-medium text-[var(--foreground)]">
                  Extracting transcript…
                </span>
              </div>
              <span className="text-xs text-[var(--foreground)] opacity-50 tabular-nums font-mono">
                {elapsedTime}s
              </span>
            </div>

            {streamLogs.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-brand-600 dark:text-brand-400 font-medium truncate">
                  {streamLogs[streamLogs.length - 1]}
                </p>
                {streamLogs.length > 1 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-[var(--foreground)] opacity-50 hover:opacity-80 transition-opacity">
                      Show all logs ({streamLogs.length})
                    </summary>
                    <pre className="mt-2 text-xs opacity-60 whitespace-pre-wrap break-all font-mono bg-[var(--background)] rounded-xl p-3 max-h-48 overflow-y-auto border border-[var(--card-border)]">
                      {streamLogs.join("\n")}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <button
              onClick={handleCancel}
              className="w-full py-2.5 rounded-2xl text-sm font-medium text-red-500 dark:text-red-400 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/30 active:scale-[0.98] transition-all"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Cache choice panel ──────────────────────────────────── */}
        {pendingCacheChoice && (
          <div className="glass rounded-3xl p-5 flex flex-col gap-4 border border-white/10 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-4 h-4 text-blue-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--foreground)]">
                  Cached transcript found
                </p>
                <p className="text-xs text-[var(--foreground)] opacity-50 truncate">
                  {pendingCacheChoice.cached.title}
                </p>
                {cacheDiffLabel && (
                  <p className="text-xs text-amber-500 dark:text-amber-400 mt-0.5">
                    Cached with: {cacheDiffLabel}
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleUseCached}
                className="flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold bg-brand-600 hover:bg-brand-700 active:scale-[0.98] text-white transition-all shadow-lg shadow-brand-500/25"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                Use cached
              </button>
              <button
                onClick={handleRefetch}
                className="flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold bg-[var(--card-bg)] hover:bg-[var(--card-border)]/60 active:scale-[0.98] text-[var(--foreground)] border border-[var(--card-border)] transition-all"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Re-fetch
              </button>
            </div>
          </div>
        )}

        {/* ── Error panel ─────────────────────────────────────────── */}
        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 p-4 rounded-2xl text-sm border border-red-200 dark:border-red-900/50 animate-in fade-in">
            <p className="font-medium text-center mb-2">{error}</p>
            {debugLogs.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
                  Debug logs ({debugLogs.length})
                </summary>
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          debugLogs.join("\n")
                        );
                        setCopiedDebug(true);
                        setTimeout(() => setCopiedDebug(false), 2000);
                      } catch {}
                    }}
                    className="text-xs px-2 py-1 rounded-lg bg-red-200 dark:bg-red-900/60 hover:bg-red-300 dark:hover:bg-red-800/60 transition-colors"
                  >
                    {copiedDebug ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <pre className="mt-1 text-xs opacity-80 whitespace-pre-wrap break-all font-mono bg-red-100 dark:bg-red-950/50 rounded-xl p-3 max-h-48 overflow-y-auto">
                  {debugLogs.join("\n")}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* ── Prompt result panel ─────────────────────────────────── */}
        {promptReady && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-4 duration-500 w-full mt-2">
            {/* Truncation warning */}
            {promptReady.truncated && (
              <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 p-4 rounded-2xl text-sm border border-amber-200 dark:border-amber-900/50 animate-in fade-in">
                <svg
                  className="w-5 h-5 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <div>
                  <p className="font-semibold">Transcript may be truncated</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    The transcript appears to be cut off. The summary may be
                    incomplete. Try a different video source or re-fetch.
                  </p>
                </div>
              </div>
            )}

            {/* Timeout warning */}
            {promptReady.timedOut && (
              <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 p-4 rounded-2xl text-sm border border-amber-200 dark:border-amber-900/50 animate-in fade-in">
                <svg
                  className="w-5 h-5 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <p className="font-semibold">Extraction timed out</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    The extraction reached the time limit. The result may come
                    from a fallback source. You can try again.
                  </p>
                </div>
              </div>
            )}

            {/* Strategy badge + log export */}
            {promptReady.strategy && (
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--foreground)] opacity-50">
                    via
                  </span>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      promptReady.strategy.startsWith("Supadata")
                        ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50"
                        : "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800/50"
                    }`}
                  >
                    {promptReady.strategy}
                  </span>
                  {promptReady.strategy.startsWith("Supadata") &&
                    !promptReady.strategy.includes("cached") && (
                      <span className="text-xs text-amber-500 dark:text-amber-400 opacity-70">
                        uses quota (100/mo free)
                      </span>
                    )}
                </div>
                {resultLogs.length > 0 && (
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(resultLogs.join("\n"));
                        setCopiedResultLog(true);
                        setTimeout(() => setCopiedResultLog(false), 2000);
                      } catch {}
                    }}
                    className="text-xs text-[var(--foreground)] opacity-40 hover:opacity-80 transition-opacity px-2 py-0.5 rounded-lg hover:bg-[var(--card-border)]/50"
                  >
                    {copiedResultLog ? "✓ Log copiato" : "Copia log"}
                  </button>
                )}
              </div>
            )}

            <label className="text-sm font-medium text-[var(--foreground)] opacity-80 pl-1">
              Edit Prompt (Optional)
            </label>
            <textarea
              className="w-full h-48 bg-[var(--background)] border border-[var(--card-border)] rounded-2xl p-4 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-brand-500/50 resize-y"
              value={promptReady.text}
              onChange={(e) =>
                setPromptReady({ ...promptReady, text: e.target.value })
              }
            />

            {/* ── Character counter + size warning ────────────────── */}
            <div className="flex items-center justify-between px-1 -mt-1">
              <span className={`text-xs font-mono ${charColorClass}`}>
                {charCount.toLocaleString()} chars
              </span>
              {charCount > 100000 && (
                <span className="text-xs text-red-500 dark:text-red-400">
                  ⚠ Very large — some AI chats may truncate
                </span>
              )}
              {charCount > 50000 && charCount <= 100000 && (
                <span className="text-xs text-amber-500 dark:text-amber-400">
                  Large prompt
                </span>
              )}
            </div>

            <ActionButtons
              promptText={promptReady.text}
              provider={promptReady.provider}
              transcriptText={promptReady.transcript}
              transcriptTitle={promptReady.title}
            />
          </div>
        )}

        {/* ── Recent videos ───────────────────────────────────────── */}
        {!promptReady && history.length > 0 && (
          <div className="flex flex-col gap-3 mt-4 animate-in fade-in">
            <div className="flex items-center justify-between px-2">
              <h3 className="text-sm font-semibold text-[var(--foreground)] opacity-80">
                Recent Videos
              </h3>
              <button
                onClick={handleClearCache}
                className="text-xs text-[var(--foreground)] opacity-40 hover:opacity-80 transition-opacity px-2 py-0.5 rounded-lg hover:bg-[var(--card-border)]/50"
              >
                {cacheCleared ? "✓ Cache cleared" : "Clear cache"}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {history.map((item) => (
                <button
                  key={item.url}
                  onClick={() => setSelectedUrl(item.url)}
                  className="text-left bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl px-4 py-3 text-sm text-[var(--foreground)] hover:bg-[var(--card-border)]/50 transition-colors truncate"
                >
                  {item.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
