// Timestamps: the anchors were being parsed and thrown away.
//
// All three timedtext parsers read the cue start time — they need it for the
// coverage check — and then dropped it on the floor. A summary therefore could
// never point at a moment in the video, which is the one feature every rival
// extension leads with.
//
// Three things have to hold, and the third is the one that bites:
//   1. the transcript carries anchors, SPARSELY (one per 30 s, not one per cue:
//      per-cue stamps would add ~120k chars to a 2 h video and eat the composer
//      budget the split exists to protect);
//   2. the model is told to cite them — but only when they are really there;
//   3. the .md turns them into links that jump, without mangling a link the
//      model may have written itself.
import { parseTranscript, hasTimestamps, formatTimestamp } from '../modules/transcript-parse.js';
import { timestampNote, PROMPTS, isPreset } from '../modules/config.js';

let failures = 0;
const check = (name, actual, expect) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}`}`);
};

// ── formatting ───────────────────────────────────────────────────────────────
check('seconds', formatTimestamp(0), '0:00');
check('under a minute', formatTimestamp(7000), '0:07');
check('minutes', formatTimestamp(83000), '1:23');
check('past an hour switches to h:mm:ss', formatTimestamp(3723000), '1:02:03');
check('rounds down to the second, never up past it', formatTimestamp(59999), '0:59');

// ── json3: the format YouTube serves most often ──────────────────────────────
const events = [];
for (let i = 0; i < 12; i++) {
  events.push({ tStartMs: i * 10000, dDurationMs: 9000, segs: [{ utf8: `frase numero ${i}` }] });
}
const json3 = parseTranscript(JSON.stringify({ events }));

check('json3 still parses', json3.cues, 12);
check('json3 still measures the span for the coverage check', json3.endMs, 119000);

const marked = json3.text.split('\n\n').filter(l => /^\[\d/.test(l));
// 12 cues over 110 s, one marker allowed per 60 s → 0:00, 1:00.
check('anchors are sparse, not one per cue', marked.length, 2);
check('the anchors are the right moments',
  marked.map(l => l.slice(1, l.indexOf(']'))), ['0:00', '1:00']);
check('an unmarked line keeps its text untouched', json3.text.split('\n\n')[1], '[1:00] frase numero 6 frase numero 7 frase numero 8 frase numero 9 frase numero 10 frase numero 11');
check('a marked line keeps its text too', json3.text.split('\n\n')[0], '[0:00] frase numero 0 frase numero 1 frase numero 2 frase numero 3 frase numero 4 frase numero 5');
check('hasTimestamps sees them', hasTimestamps(json3.text), true);

// ── srv3 and the legacy XML must agree ───────────────────────────────────────
const srv3 = parseTranscript(
  '<timedtext><p t="0" d="4000"><s>prima riga</s></p>' +
  '<p t="45000" d="4000"><s>dopo il minuto</s></p></timedtext>');
check('srv3 anchors', srv3.text, '[0:00] prima riga dopo il minuto');

const legacy = parseTranscript(
  '<transcript><text start="0" dur="4">prima riga</text>' +
  '<text start="45.5" dur="4">dopo il minuto</text></transcript>');
check('legacy xml anchors (seconds → ms)', legacy.text, '[0:00] prima riga dopo il minuto');

// ── the rolling-window dedupe must not lose the EARLIER time ─────────────────
// Auto-generated tracks re-send a caption that grows by a character or two. That
// dedupe is unchanged (it only merges near-identical cues, length delta < 3);
// what is new is that a merge now has to pick a timestamp, and picking the later
// fragment's would drift every anchor towards the end of the phrase.
const rolling = parseTranscript(JSON.stringify({
  events: [
    { tStartMs: 5000,  dDurationMs: 2000, segs: [{ utf8: 'ciao a tutti' }] },
    { tStartMs: 7000,  dDurationMs: 2000, segs: [{ utf8: 'ciao a tutti!' }] },
    { tStartMs: 40000, dDurationMs: 2000, segs: [{ utf8: 'la prossima' }] },
  ],
}));
check('the growing caption is still merged into one cue', rolling.cues, 2);
check('...keeping the longer wording at the EARLIER time',
  rolling.text.split('\n\n')[0], '[0:05] ciao a tutti! la prossima');
check('an identical repeat is still dropped',
  parseTranscript(JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'uguale' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'uguale' }] },
  ] })).cues, 1);

// ── a transcript with no timings must not pretend ────────────────────────────
// The get_transcript fallback returns bare cue text. Promising anchors that are
// not there is how a model starts inventing them.
check('no anchors → hasTimestamps is false',
  hasTimestamps('prima riga\nseconda riga\nterza riga'), false);
check('a bare [12:34] mid-sentence is not an anchor',
  hasTimestamps('come detto [12:34] eccetera'), false);

// ── the instruction is appended, never baked into the presets ────────────────
// isPreset() decides whether a stored prompt may still be auto-updated by
// comparing it to these strings. Folding the note into them would freeze every
// existing user's prompt as "custom" forever.
check('the note is not part of any preset',
  Object.values(PROMPTS).some(l => Object.values(l).some(f =>
    Object.values(f).some(p => p.includes('[m:ss]')))), false);
check('every preset still matches isPreset', isPreset(PROMPTS.it.md.normal), true);
check('the note exists per language', timestampNote('it').includes('[m:ss]'), true);
check('an unknown language falls back to English', timestampNote('zz'), timestampNote('en'));

// ── the .md links ────────────────────────────────────────────────────────────
// linkTimestamps lives in background.js (no exports — it is a service worker),
// so the regex is mirrored here. Guarded below by a check that the two agree.
const linkTimestamps = (md, videoId) => {
  if (!videoId || !md) return md;
  return String(md).replace(/\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\](?!\()/g, (whole, a, b, c) => {
    const [h, m, s] = c !== undefined ? [+a, +b, +c] : [0, +a, +b];
    const at = h * 3600 + m * 60 + s;
    return `[${whole.slice(1, -1)}](https://www.youtube.com/watch?v=${videoId}&t=${at}s)`;
  });
};
const V = 'dQw4w9WgXcQ';

check('a plain anchor becomes a jump link',
  linkTimestamps('Il punto chiave [1:23] è questo.', V),
  'Il punto chiave [1:23](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s) è questo.');
check('h:mm:ss is converted in seconds correctly',
  linkTimestamps('[1:02:03]', V),
  '[1:02:03](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3723s)');
// The guard that matters: a model that already wrote a link must not be mangled.
check('an existing link is left alone',
  linkTimestamps('[1:23](https://example.com)', V), '[1:23](https://example.com)');
check('no video id → nothing is invented', linkTimestamps('[1:23]', null), '[1:23]');
check('a non-time bracket is untouched', linkTimestamps('[nota] e [99:99]', V), '[nota] e [99:99]');

// The mirrored regex must be the one that actually ships.
const bg = await import('node:fs').then(fs =>
  fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8'));
check('the test mirrors the regex background.js really uses',
  bg.includes(String.raw`/\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\](?!\()/g`), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
process.exit(failures ? 1 : 0);
