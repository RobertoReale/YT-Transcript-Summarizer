// Shared rig for the tests that drive the REAL background.js end to end:
// real processJob, real summarizeTranscript / buildChunkMessages, real callLLM.
// Only three things are stubbed, and each for a stated reason:
//
//   chrome.*             — no browser here; the store is a plain object so a test
//                          can seed it (e.g. an aged pasteWatch entry) and read
//                          back exactly what the extension wrote.
//   modules/youtube-api  — a synthetic transcript instead of a live InnerTube
//                          fetch, so the split is deterministic and offline.
//   modules/utils.sleep  — the 1.5 s pacing pause between chunk calls is real
//                          rate-limit protection but costs seconds of wall clock
//                          per run and is not what these tests are about.
//
// globalThis.fetch is left to the caller: what the extension puts on the wire is
// usually the thing under test.
//
// `install()` MUST be called before importing background.js — the module hooks
// have to be registered first, and background.js has import side effects.
import { registerHooks } from 'node:module';

export const store = {};
export const saved = [];          // every downloadText() payload, in order
export const notifications = [];
export const openedTabs = [];     // chrome.tabs.create URLs

let portListener = null;
let messageListener = null;

/**
 * A transcript of exactly `chars` characters, as `chars / 60` lines of exactly
 * 60 characters (59 + the newline). Every line is numbered, so a slice can be
 * traced back to the region of the video it came from and the parts can be
 * proved to cover the whole thing with no gap and no overlap.
 * `chars` must be a multiple of 60.
 */
export function makeTranscript(chars) {
  if (chars % 60) throw new Error('makeTranscript: chars must be a multiple of 60');
  return Array.from({ length: chars / 60 },
    (_, i) => `[${String(i).padStart(4, '0')}] parlato di prova per il test di merge.`.padEnd(59, '.')
  ).join('\n') + '\n';
}

/**
 * Swap the transcript the stubbed strategy returns, mid-file.
 *
 * `install()` can only run once per process — `registerHooks` compiles the stub
 * module the first time it is asked for, and a second install() silently has no
 * effect. A test that needs two different transcripts (with anchors and without,
 * say) would then quietly assert twice about the same one. So the stub reads a
 * global instead of a baked-in constant.
 */
export function setTranscript({ transcript, title, lang }) {
  const cur = globalThis.__ytsStub || {};
  globalThis.__ytsStub = {
    transcript: transcript ?? cur.transcript,
    title: title ?? cur.title,
    lang: lang ?? cur.lang,
  };
}

export function install({ transcript, title = 'Video di prova', lang = 'it' }) {
  setTranscript({ transcript, title, lang });
  registerHooks({
    load(url, ctx, next) {
      if (url.endsWith('modules/youtube-api.js')) {
        return {
          format: 'module', shortCircuit: true,
          source: `
            export async function fetchViaGetTranscript() {
              const s = globalThis.__ytsStub;
              return { transcript: s.transcript, title: s.title,
                       coverage: '100%', complete: true, lang: s.lang };
            }
            export async function fetchViaAndroidPlayer() { return null; }
            export async function tabFetchTranscript() { return null; }
            export async function tabBrowseContinuations() { return null; }
          `,
        };
      }
      if (url.endsWith('modules/utils.js') && !url.includes('?real')) {
        return {
          format: 'module', shortCircuit: true,
          source: `
            export * from './utils.js?real';
            export function sleep() { return Promise.resolve(); }
          `,
        };
      }
      return next(url, ctx);
    },
  });

  globalThis.chrome = {
    alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
    runtime: {
      onMessage: { addListener(fn) { if (fn.length === 3) messageListener = fn; } },
      onConnect: { addListener(fn) { portListener = fn; } },
      getURL: p => p,
      lastError: null,
      // downloads.js asks the offscreen document for a blob: URL — that message
      // is where the file body passes through, so it is where we capture it.
      async sendMessage(msg) {
        if (msg?.type === 'make-blob-url') { saved.push(msg.text); return { url: 'blob:stub' }; }
        return undefined;
      },
    },
    storage: {
      local: {
        async get(keys) {
          const k = keys == null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const key of k) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        },
        async set(obj) { Object.assign(store, structuredClone(obj)); },
        async remove(key) { for (const k of [].concat(key)) delete store[k]; },
      },
    },
    tabs: {
      create: async (o) => { openedTabs.push(o?.url); return { id: 1 }; },
      query: async () => [], sendMessage: async () => {},
    },
    notifications: { create: (o) => notifications.push(o) },
    downloads: { download: async () => 1, onChanged: { addListener() {}, removeListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    offscreen: {
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', BLOBS: 'BLOBS' },
      hasDocument: async () => true, createDocument: async () => {},
    },
    scripting: { executeScript: async () => [] },
  };
}

let sendToPort = null;

/** Import background.js and connect a fake popup port. */
export async function boot() {
  await import(new URL('../background.js', import.meta.url).href);
  if (!portListener) throw new Error('the popup onConnect listener was never registered');
  portListener({
    name: 'popup',
    onMessage: { addListener(fn) { sendToPort = fn; } },
    onDisconnect: { addListener() {} },
    postMessage() {},
  });
  if (!sendToPort) throw new Error('the popup port never registered a message listener');
}

/** Deliver a chrome.runtime message (e.g. a pasteReport) to background.js. */
export function sendMessage(msg) {
  if (!messageListener) throw new Error('no chrome.runtime.onMessage listener was registered');
  messageListener(msg, {}, () => {});
}

/** Wipe the recorded state between runs. `keep` survives (e.g. a seeded pasteWatch). */
export function reset(keep = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, structuredClone(keep));
  saved.length = 0; notifications.length = 0; openedTabs.length = 0;
}

/**
 * Run a batch to completion through startBatch, exactly as the popup would.
 * @returns the job rows the extension left in storage.
 */
export async function runJobs(settings, jobs) {
  await sendToPort({ type: 'startBatch', jobs, settings });
  for (let i = 0; i < 400 && store.running !== false; i++) await new Promise(r => setTimeout(r, 25));
  return store.jobs ?? [];
}

/** The single-job case, which is most of them. @returns the one job row. */
export async function runJob(settings, job = {}) {
  const rows = await runJobs(settings,
    [{ id: 'j1', url: 'https://www.youtube.com/watch?v=TESTMERGE01', status: 'queued', ...job }]);
  return rows[0];
}

/**
 * A fetch Response streaming `text` the way the Anthropic Messages API does
 * (callLLM always streams). Split into a few deltas so the accumulation is
 * exercised, not just the happy single-event case.
 */
export function anthropicStream(text, stopReason = 'end_turn') {
  const enc = new TextEncoder();
  const ev = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
  const pieces = String(text).match(/[\s\S]{1,40}/g) || [];
  const events = [
    ev('message_start', { type: 'message_start' }),
    ...pieces.map(t => ev('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: t } })),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason } }),
  ];
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); },
    }),
  };
}

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0;
export function check(name, actual, expect) {
  const ok = actual === expect;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected: ${expect}\n      actual:   ${actual}`);
}
export function finish() {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
  process.exit(failures ? 1 : 0);
}
