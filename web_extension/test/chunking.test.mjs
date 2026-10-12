// Web mode sends a transcript whole, unless one message would not fit the chat
// composer — Gemini silently keeps only the first 32 000 characters, so a long
// video "sent" in one message lost its tail without a word. These pin the rules:
// split just enough to fit, count the prompt and the part note against the cap,
// never split when the follow-up parts would not be delivered, lose nothing.
import { buildChunkMessages, plannedChunkCount, splitTranscript } from '../modules/llm-api.js';
import { CONFIG, getPreset } from '../modules/config.js';
import { check, finish } from './harness.mjs';

const GEMINI = CONFIG.maxWebMessageChars.gemini;
const PROMPT = getPreset('it', 'chat', 'normal');

function transcript(chars) {
  let s = '';
  for (let i = 1; s.length < chars; i++) s += `[${String(i).padStart(6, '0')}] parola parola parola parola parola.\n`;
  return s.slice(0, chars);
}
const build = (chars, extra = {}) => buildChunkMessages(transcript(chars), {
  prompt: PROMPT, transcriptLang: 'it', maxMessageChars: GEMINI, splitToFit: true, chunkMerge: false, ...extra,
});

// ── fits → one message ──
let w = build(20000);
check('short transcript: one message', w.chunks, 1);
check('...carrying prompt and transcript', w.parts[0].startsWith(PROMPT), true);

// ── over the cap → split, every message inside it ──
w = build(107000);
check('long transcript: split', w.chunks > 1, true);
check('the split was forced, not asked', w.autoSplit, true);
check('every message (prompt + note included) fits the composer', w.parts.every(p => p.length <= GEMINI), true);
check('no overflow left', w.overflow, 0);

// ── nothing lost, nothing duplicated ──
const T = transcript(107000);
const slices = splitTranscript(T, 4);
const words = (s) => s.split(/\s+/).filter(Boolean);
check('slices rejoin to the whole transcript', words(slices.join('\n')).join(' '), words(T).join(' '));

// ── follow-ups would not be delivered → do not split, report instead ──
w = build(107000, { splitToFit: false });
check('no auto-submit: single message', w.chunks, 1);
check('...and the overflow is reported, not hidden', w.overflow > 0, true);

// ── API mode never passes a cap ──
check('API mode: one call', plannedChunkCount(T, { prompt: PROMPT }), 1);

// ── merge request ──
w = build(107000, { chunkMerge: true });
check('merge: one extra message after the parts', w.parts.length, w.chunks + 1);
check('merge: plan points at it', w.mergePlan?.at, w.chunks);

// ── separate mode: one tab per part, no in-chat merge message ──
w = build(107000, { chunkMerge: true, chunkMode: 'separate' });
check('separate: flagged', w.isSeparate, true);
check('separate: no merge message appended', w.parts.length, w.chunks);

// ── a very long video stays bounded ──
w = build(2_000_000);
check('huge transcript: capped at maxAutoParts', w.chunks, CONFIG.chunking.maxAutoParts);
check('...and the remaining overflow is reported', w.overflow > 0, true);

finish();
