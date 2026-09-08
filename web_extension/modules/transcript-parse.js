// ── transcript-parse.js — timedtext parsing, one implementation ──────────────
// Parsing used to be copy-pasted in four places (two in the service worker, two
// inside the injected page script) and none of them checked that what came back
// actually covered the whole video. Everything funnels through here now.

import { CONFIG } from './config.js';

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  // Run twice: YouTube's XML tracks are double-escaped (`&amp;#39;`), so a
  // single pass leaves a literal `&#39;` in the text.
  const once = (t) => t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const named = HTML_ENTITIES[ent.toLowerCase()];
    return named !== undefined ? named : m;
  });
  return once(once(s));
}

function isNoise(line) {
  return CONFIG.transcript.noiseCues.test(line);
}

// Auto-generated tracks emit a rolling window: the same words are re-sent in the
// following cue so the on-screen caption can grow. Joining them verbatim used to
// duplicate large parts of the text; drop a cue that only repeats the previous one.
//
// `startMs` rides along so the rendered transcript can carry timestamps. It used
// to be read (for coverage) and thrown away, which is why a summary could never
// point at a moment in the video.
function pushCue(cues, text, startMs) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || isNoise(t)) return;
  const prev = cues[cues.length - 1];
  if (prev && prev.s === t) return;
  if (prev && (prev.s.endsWith(t) || t.startsWith(prev.s)) && Math.abs(prev.s.length - t.length) < 3) {
    // Keep the longer wording, but the EARLIER time: the cue started when the
    // first fragment of it appeared, not when it finished growing.
    if (t.length >= prev.s.length) prev.s = t;
    return;
  }
  cues.push({ s: t, t: Number(startMs) || 0 });
}

// One marker per half-minute of video, not one per cue. Per-cue timestamps would
// add ~120k characters to a two-hour transcript — eating exactly the composer
// budget the split in §3.1 exists to protect — while these cost ~2.4k and are
// still fine enough to point at a moment.
const MARKER_INTERVAL_MS = 60000;

/** `[m:ss]`, or `[h:mm:ss]` once the video is over an hour. */
export function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000 | 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function render(cues) {
  const out = [];
  let currentBlock = [];
  let nextMark = 0;
  for (const c of cues) {
    if (c.t >= nextMark) {
      if (currentBlock.length > 0) {
        out.push(currentBlock.join(' '));
        currentBlock = [];
      }
      currentBlock.push(`[${formatTimestamp(c.t)}] ${c.s}`);
      nextMark = c.t + MARKER_INTERVAL_MS;
    } else {
      currentBlock.push(c.s);
    }
  }
  if (currentBlock.length > 0) {
    out.push(currentBlock.join(' '));
  }
  return out.join('\n\n');
}

// Does this transcript carry anchors the model can actually cite? The
// get_transcript fallback returns bare cue text with no timings at all, so the
// prompt must not promise timestamps that are not there.
export function hasTimestamps(text) {
  return /^\[\d{1,2}:\d{2}(?::\d{2})?\] /m.test(String(text || ''));
}

export function parseTimeStr(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.trim().split(':').reverse();
  if (parts.length === 0) return null;
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) {
    const v = parseFloat(parts[i]);
    if (!isNaN(v)) seconds += v * Math.pow(60, i);
  }
  return seconds * 1000;
}

function parseJson3(text, options = {}) {
  const json = JSON.parse(text); // caller catches
  const events = Array.isArray(json?.events) ? json.events : [];
  if (!events.length) return null;
  const cues = [];
  let endMs = 0;
  const startMsLimit = parseTimeStr(options.timeStart);
  const endMsLimit = parseTimeStr(options.timeEnd);

  for (const e of events) {
    if (!Array.isArray(e.segs)) continue;
    const start = Number(e.tStartMs) || 0;
    const dur = Number(e.dDurationMs) || 0;
    endMs = Math.max(endMs, start + dur);
    if (startMsLimit !== null && (start + dur) < startMsLimit) continue;
    if (endMsLimit !== null && start > endMsLimit) continue;
    pushCue(cues, e.segs.map(s => s.utf8 || '').join(''), start);
  }
  return cues.length ? { text: render(cues), endMs, cues: cues.length } : null;
}

// Legacy `?lang=xx` (no fmt) format: <text start="12.3" dur="4.5">…</text>
function parseLegacyXml(text, options = {}) {
  const matches = [...text.matchAll(/<text([^>]*)>([\s\S]*?)<\/text>/g)];
  if (!matches.length) return null;
  const cues = [];
  let endMs = 0;
  const startMsLimit = parseTimeStr(options.timeStart);
  const endMsLimit = parseTimeStr(options.timeEnd);

  for (const m of matches) {
    const start = parseFloat(/\bstart="([\d.]+)"/.exec(m[1])?.[1] ?? '0') || 0;
    const dur = parseFloat(/\bdur="([\d.]+)"/.exec(m[1])?.[1] ?? '0') || 0;
    const endT = (start + dur) * 1000;
    const startT = start * 1000;
    endMs = Math.max(endMs, endT);
    if (startMsLimit !== null && endT < startMsLimit) continue;
    if (endMsLimit !== null && startT > endMsLimit) continue;
    pushCue(cues, decodeEntities(m[2].replace(/<[^>]+>/g, '')), startT);
  }
  return cues.length ? { text: render(cues), endMs, cues: cues.length } : null;
}

// srv3: <p t="12300" d="4500"><s>word</s><s> more</s></p>. The old code looked
// for <text> tags here too, so the srv3 fallback could never match anything and
// was effectively dead — the strategy silently had two attempts, not three.
function parseSrv3(text, options = {}) {
  const paragraphs = [...text.matchAll(/<p([^>]*)>([\s\S]*?)<\/p>/g)];
  if (!paragraphs.length) return null;
  const cues = [];
  let endMs = 0;
  const startMsLimit = parseTimeStr(options.timeStart);
  const endMsLimit = parseTimeStr(options.timeEnd);

  for (const p of paragraphs) {
    const t = parseInt(/\bt="(\d+)"/.exec(p[1])?.[1] ?? '0', 10) || 0;
    const d = parseInt(/\bd="(\d+)"/.exec(p[1])?.[1] ?? '0', 10) || 0;
    endMs = Math.max(endMs, t + d);
    if (startMsLimit !== null && (t + d) < startMsLimit) continue;
    if (endMsLimit !== null && t > endMsLimit) continue;

    const inner = p[2];
    const segs = [...inner.matchAll(/<s[^>]*>([\s\S]*?)<\/s>/g)];
    const raw = segs.length ? segs.map(s => s[1]).join('') : inner.replace(/<[^>]+>/g, '');
    pushCue(cues, decodeEntities(raw), t);
  }
  return cues.length ? { text: render(cues), endMs, cues: cues.length } : null;
}

/**
 * Parse any timedtext payload.
 * @returns {{text: string, endMs: number, cues: number}|null}
 */
export function parseTranscript(body, options = {}) {
  if (typeof body !== 'string' || body.length < 10) return null;
  const trimmed = body.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const r = parseJson3(body, options);
      if (r) return r;
    } catch (_) { /* not json3 — fall through to the XML parsers */ }
  }
  return parseSrv3(body, options) || parseLegacyXml(body, options);
}

/**
 * How much of the video the parsed cues actually span.
 * `lengthSeconds` comes from videoDetails; when it is unknown we cannot judge,
 * so coverage is reported as `null` and the caller accepts the result.
 */
export function coverageOf(parsed, lengthSeconds) {
  const total = Number(lengthSeconds);
  if (!parsed || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(1, (parsed.endMs / 1000) / total);
}

export function isComplete(parsed, lengthSeconds) {
  const cov = coverageOf(parsed, lengthSeconds);
  // Very short clips have too little signal for the ratio to mean anything.
  if (cov === null || Number(lengthSeconds) < 30) return true;
  return cov >= CONFIG.transcript.minCoverage;
}

export function coverageLabel(parsed, lengthSeconds) {
  const cov = coverageOf(parsed, lengthSeconds);
  return cov === null ? 'unknown' : `${Math.round(cov * 100)}%`;
}

/**
 * Plausibility check for transcripts that carry no timings at all (the
 * get_transcript endpoint returns plain cue text). Without this an obviously
 * truncated response counted as "complete" and short-circuited the remaining
 * strategies. Continuous speech runs ~12–18 chars/s; 4 chars/s is low enough
 * that only a genuinely truncated result — or a video that is mostly silence —
 * trips it, and a false positive merely costs one extra strategy attempt.
 */
const MIN_CHARS_PER_SECOND = 4;

export function looksTruncated(text, lengthSeconds) {
  const total = Number(lengthSeconds);
  if (!Number.isFinite(total) || total < 120) return false; // too short to judge
  return String(text || '').length < total * MIN_CHARS_PER_SECOND;
}
