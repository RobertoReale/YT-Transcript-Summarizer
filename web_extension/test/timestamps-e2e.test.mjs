// Timestamps, end to end through the REAL background.js.
//
// timestamps.test.mjs proves the pieces (parser, formatting, the link regex).
// This proves the wiring, which is where a feature like this actually dies:
// the instruction has to reach the model, and the .md has to come back with
// links that jump — and neither must happen when the transcript has no anchors
// to begin with (the get_transcript fallback returns bare cue text).
import { install, setTranscript, boot, runJob, reset, saved, check, finish, anthropicStream } from './harness.mjs';

// A transcript shaped like one the parser now produces: sparse [m:ss] anchors.
const TIMED = Array.from({ length: 60 }, (_, i) =>
  (i % 3 === 0 ? `[${Math.floor(i / 2)}:${String((i * 30) % 60).padStart(2, '0')}] ` : '') +
  `riga ${i} del parlato di prova, abbastanza lunga da contare qualcosa.`
).join('\n');

install({ transcript: TIMED });

let sentPrompts = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  sentPrompts.push(body.messages[0].content);
  // What a model does when it has been told to cite the anchors.
  return anthropicStream(
    'Il primo punto [0:00] apre il video.\n' +
    'Il secondo [1:30] è il nocciolo.\n' +
    'Una nota già linkata [2:00](https://example.com) non va toccata.\n' +
    'E una parentesi qualsiasi [nota] nemmeno.');
};

await boot();

const BASE = {
  mode: 'api', provider: 'anthropic', model: 'claude-sonnet-5',
  apiKeys: { anthropic: 'sk-test' }, prompt: 'Riassumi questo video.',
  transcriptLang: 'it', chunkParts: 1,
};

// ── with anchors: the instruction goes out, the links come back ──────────────
reset(); sentPrompts = [];
let row = await runJob(BASE);
const md = saved[saved.length - 1];

check('the job completed', row.status, 'done');
check('the model was told to cite the anchors',
  sentPrompts[0].includes('[m:ss]'), true);
check('...in the transcript language, not English',
  sentPrompts[0].includes('Cita quello pertinente'), true);
check('the transcript itself still carries the anchors',
  /\n\[0:00\] riga 0/.test(sentPrompts[0]), true);

check('a plain anchor became a jump link',
  md.includes('[0:00](https://www.youtube.com/watch?v=TESTMERGE01&t=0s)'), true);
check('...and so did the later one, in seconds',
  md.includes('[1:30](https://www.youtube.com/watch?v=TESTMERGE01&t=90s)'), true);
check('a link the model wrote itself was left alone',
  md.includes('[2:00](https://example.com)'), true);
check('...and was not double-wrapped', md.includes('(https://example.com)(http'), false);
check('a non-time bracket is untouched', md.includes('[nota]'), true);

// ── without anchors: nothing is promised and nothing is invented ─────────────
// Same run, transcript stripped of its anchors — the shape the get_transcript
// fallback returns.
setTranscript({ transcript: TIMED.replace(/^\[\d+:\d\d\] /gm, '') });
reset(); sentPrompts = [];
row = await runJob(BASE);

check('a transcript with no anchors completes too', row.status, 'done');
check('...and the model is NOT told to cite timestamps',
  sentPrompts[0].includes('[m:ss]'), false);

finish();
