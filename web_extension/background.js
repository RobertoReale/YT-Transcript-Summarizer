// ── background.js — Service Worker ───────────────────────────────────────────
import { callLLM, splitTranscript, plannedChunkCount, chunkPrompt, chunkHeading, mergeApiPrompt, buildChunkMessages } from './modules/llm-api.js';
import { fetchViaAndroidPlayer, fetchViaGetTranscript, tabFetchTranscript, tabBrowseContinuations } from './modules/youtube-api.js';
import { CONFIG, timestampNote } from './modules/config.js';
import { hasTimestamps } from './modules/transcript-parse.js';
import { sleep, fetchWithTimeout } from './modules/utils.js';
import { downloadText, safeFilename, ensureOffscreenDocument } from './modules/downloads.js';

let popupPort = null;
let isRunning = false;
// Set true when the user presses Stop/Reset. The batch loops poll this so an
// in-progress run can actually be interrupted (not just the *next* scheduled job).
let cancelRequested = false;

// True if a stop was requested (same-worker flag) or the persisted running flag
// was cleared (covers a service-worker restart mid-batch).
async function batchCancelled() {
  if (cancelRequested) return true;
  const { running } = await chrome.storage.local.get('running');
  return !running;
}

// A sleep that returns early with `true` as soon as a stop is requested — both
// in this worker and via the persisted flag (a Stop pressed while this worker
// was asleep only shows up in storage).
async function cancellableSleep(ms) {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelRequested) return true;
    // Polling storage on every step would be wasteful; once a second is plenty.
    if (waited % 1000 === 0 && waited > 0 && await batchCancelled()) return true;
    await sleep(Math.min(step, ms - waited));
  }
  return await batchCancelled();
}

/**
 * Claim the batch runner. The claim (`isRunning = true`) happens synchronously,
 * before any await: the alarm handler and the setTimeout backstop both fire for
 * the same job and used to interleave their async storage reads, starting the
 * runner twice — the same video processed twice, two chat tabs opened.
 */
function startRun(startJobId) {
  if (isRunning) return;
  isRunning = true;
  (async () => {
    try {
      const { running } = await chrome.storage.local.get('running');
      if (!running || cancelRequested) { isRunning = false; return; }
      await runBatch(startJobId);
    } catch (e) {
      console.error('[YT Summarizer] batch crashed:', e);
      isRunning = false;
      await chrome.storage.local.set({ running: false }).catch(() => {});
    }
  })();
}

// Resume batch if service worker was restarted mid-batch
chrome.storage.local.get(['running', 'nextJobId', 'nextJobAt']).then(({ running, nextJobId, nextJobAt }) => {
  if (!running || isRunning) return;
  if (nextJobAt && Date.now() < nextJobAt) {
    // Still in the delay window — recreate the alarm for the remaining time.
    const ms = nextJobAt - Date.now();
    chrome.alarms.create('nextJob', { delayInMinutes: ms / 60000 });
    if (ms < 60000) setTimeout(() => startRun(nextJobId ?? null), ms);
  } else {
    startRun(nextJobId ?? null);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'nextJob') return;
  chrome.storage.local.get('nextJobId').then(({ nextJobId }) => startRun(nextJobId ?? null));
});

// ── TTS Offscreen ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'tts-state' && sender.url === chrome.runtime.getURL('tts_offscreen.html')) {
    const { type, ...state } = msg;
    chrome.storage.local.set({ ttsState: state }).catch(() => {});
    safePost(msg);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'startBatch') {
      cancelRequested = false;
      chrome.alarms.clear('nextJob');
      await chrome.storage.local.set({
        jobs: msg.jobs, settings: msg.settings,
        running: true, nextJobId: null, nextJobAt: null
      });
      startRun(null);
    }
    if (msg.type === 'resetState') {
      cancelRequested = true;
      isRunning = false;
      chrome.alarms.clear('nextJob');
      chrome.alarms.clear('keepAlive');
      await chrome.storage.local.set({ running: false, nextJobId: null, nextJobAt: null });
    }
    if (msg.type && msg.type.startsWith('tts-')) {
      const ok = await ensureOffscreenDocument();
      if (ok) {
        chrome.runtime.sendMessage(msg).catch(() => {});
      } else {
        safePost({ type: 'tts-state', playing: false, paused: false, error: 'tts_unsupported' });
      }
    }
  });

  port.onDisconnect.addListener(() => { popupPort = null; });
});

// ── Batch Runner ──────────────────────────────────────────────────────────────
// A job still needs work while it is queued or active. `error` is terminal for
// the current run (a failed job must not be picked up again by the same loop);
// `done` and `unavailable` are terminal for good — those videos genuinely have
// no captions, and retrying them on every Run cost a full three-strategy sweep
// (including a 55 s throwaway tab) per video.
const isPending = (j) => j.status === 'queued' || j.status === 'active';

// A fresh run retries whatever failed last time and re-queues jobs left "active"
// by a crash, which is what the index-based loop used to do implicitly.
async function requeueFailedJobs() {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  let changed = false;
  for (const j of jobs) {
    if (j.status === 'error' || j.status === 'active') {
      j.status = 'queued';
      j.statusText = 'Queued';
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ jobs });
  return jobs;
}

/**
 * @param {number|null} startJobId resume point, addressed by job *id*.
 *   It used to be an array index, but the popup rewrites the jobs array while
 *   the batch is between videos — every removal shifted the indices down and the
 *   runner silently skipped a video on resume.
 */
async function runBatch(startJobId = null) {
  // Keep the worker alive for the whole batch, including runs resumed after a
  // worker restart (where this alarm was previously never re-created).
  chrome.alarms.create('keepAlive', { periodInMinutes: 1 });

  const { settings = {} } = await chrome.storage.local.get('settings');
  const mode = settings.mode || 'web';

  if (startJobId === null) await requeueFailedJobs();

  if (settings.combinedPrompt && startJobId === null) {
    const { jobs = [] } = await chrome.storage.local.get('jobs');
    if (jobs.filter(isPending).length > 1) {
      await runBatchCombined(jobs, settings);
      if (await batchCancelled()) { isRunning = false; return; }
      await finalizeBatch();
      return;
    }
  }

  let resumeId = startJobId;
  // Belt and braces: if a status write is ever lost, the id-based selector would
  // otherwise hand back the same job forever.
  const processed = new Set();

  for (;;) {
    if (await batchCancelled()) { isRunning = false; return; }

    // Re-read every iteration: processJob writes statuses back through storage,
    // so a snapshot taken once at the top goes stale immediately.
    const { jobs = [] } = await chrome.storage.local.get('jobs');

    let idx = -1;
    if (resumeId !== null && resumeId !== undefined) {
      const at = jobs.findIndex(j => j.id === resumeId);
      if (at !== -1 && isPending(jobs[at])) idx = at;
      resumeId = null; // only honoured once
    }
    if (idx === -1) idx = jobs.findIndex(j => isPending(j) && !processed.has(j.id));
    if (idx === -1) break; // nothing left to do

    const job = jobs[idx];
    processed.add(job.id);
    await processJob(job, settings);

    if (await batchCancelled()) { isRunning = false; return; }

    const { jobs: after = [] } = await chrome.storage.local.get('jobs');
    const next = after.find(j => j.id !== job.id && isPending(j) && !processed.has(j.id));
    if (!next) break;

    if (mode === 'web') {
      const ms = Math.max(1000, (settings.webDelay ?? 30) * 1000);
      const nextJobAt = Date.now() + ms;
      await chrome.storage.local.set({ nextJobId: next.id, nextJobAt });
      safePost({ type: 'countdown', nextJobAt });
      // chrome.alarms clamps sub-30 s delays, so a short webDelay relies on the
      // setTimeout; startRun() makes the double trigger harmless.
      chrome.alarms.create('nextJob', { delayInMinutes: ms / 60000 });
      if (ms < 60000) setTimeout(() => startRun(next.id), ms);
      isRunning = false;
      return;
    }

    const pause = mode === 'api' ? 8000 + Math.random() * 7000 : 3000 + Math.random() * 4000;
    if (await cancellableSleep(pause)) { isRunning = false; return; }
  }

  await finalizeBatch();
}

async function finalizeBatch() {
  isRunning = false;
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const noTxCount = jobs.filter(j => j.status === 'unavailable').length;
  const failedCount = jobs.filter(j => j.status === 'error').length;
  // Jobs the popup faded out of the list are only dropped here, once nothing
  // can address them by id any more.
  const kept = jobs.filter(j => !j.cleared);
  await chrome.storage.local.set({ jobs: kept, running: false, nextJobId: null, nextJobAt: null });
  chrome.alarms.clear('keepAlive');
  chrome.alarms.clear('nextJob');
  safePost({ type: 'batchDone', summary: { done: doneCount, noTranscript: noTxCount, failed: failedCount } });

  if (doneCount + noTxCount + failedCount > 0) {
    // Break the outcome down so "12 without transcript" reads as expected rather
    // than as silent failures — especially for long playlists.
    const parts = [`${doneCount} completed`];
    if (noTxCount) parts.push(`${noTxCount} without transcript`);
    if (failedCount) parts.push(`${failedCount} failed`);
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('logo.png'),
        title: 'YT Summarizer',
        message: parts.join(', ')
      });
    } catch (_) {}
  }
}

// ── Transcript acquisition ────────────────────────────────────────────────────
function videoIdOf(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|\/v\/|live\/)([0-9A-Za-z_-]{11})/);
  return m ? m[1] : null;
}

// A partial transcript is worse than a late one: keep looking, and only fall
// back to the best partial result once every strategy has been tried.
async function acquireTranscript(videoId, transcriptLang, log) {
  const strategies = [
    ['S1-PageScrape', fetchViaGetTranscript],
    ['S2-Android', fetchViaAndroidPlayer],
    ['S3-Tab', tabFetchTranscript]
  ];

  let best = null;
  for (const [tag, fn] of strategies) {
    try {
      const r = await fn(videoId, (msg) => log(`[${tag}] ${msg}`), transcriptLang);
      if (r?.transcript) {
        if (r.complete !== false) { log(`[${tag}] ✅ Success (coverage ${r.coverage ?? 'unknown'})`); return r; }
        log(`[${tag}] ⚠️ Partial transcript (coverage ${r.coverage}) — trying the next strategy`);
        if (!best || r.transcript.length > best.transcript.length) best = r;
      }
    } catch (e) {
      log(`[${tag}] ❌ Exception: ${e.message}`);
    }
  }
  if (best) log(`⚠️ No complete transcript; using the longest partial one (coverage ${best.coverage})`);
  return best;
}

// ── Process Single Job ────────────────────────────────────────────────────────
async function processJob(job, settings) {
  let debugLog = '';
  try {
    const videoId = videoIdOf(job.url);
    if (!videoId) throw new Error('Unable to extract video ID from URL.');

    debugLog = `=== DEBUG LOG v2.0 per ${videoId} ===\nURL: ${job.url}\n\n`;
    const transcriptLang = job.lang || settings.transcriptLang || 'en';
    debugLog += `Preferred transcript language: "${transcriptLang}"\n\n`;
    const effectivePrompt = job.prompt || settings.prompt;
    // Per-video overrides (the ✎ panel) win over the values chosen for the run.
    const jobSettings = {
      ...settings,
      prompt: effectivePrompt,
      transcriptLang,
      chunkParts: job.split ?? settings.chunkParts
    };

    await updateJobStatus(job.id, 'active', '📋 Fetching transcript...');
    const result = await acquireTranscript(videoId, transcriptLang, (m) => { debugLog += `${m}\n`; });

    if (!result?.transcript) {
      // Expected outcome for captionless / region- or age-restricted videos —
      // not a bug to alarm about, and not worth dumping a debug file per video
      // (a long playlist could trigger dozens). Flag it so the catch marks the
      // job "unavailable" (a soft warning) rather than a hard error, and keep the
      // diagnostics in the console for anyone who needs them.
      debugLog += '\n❌ ALL STRATEGIES FAILED\n';
      console.warn(`[YT Summarizer] No transcript for ${videoId} (${job.url})\n${debugLog}`);
      const e = new Error('No transcript/captions available for this video.');
      e.noTranscript = true;
      throw e;
    }

    const { title, transcript } = result;
    debugLog += `\n✅ Transcript obtained: ${transcript.length} chars, coverage ${result.coverage ?? 'unknown'}, lang "${result.lang || '?'}", title="${title}"\n`;

    // Warnings the user must see in the output file, not only in the console.
    const notes = [];
    if (result.complete === false) {
      notes.push(`⚠️ Incomplete transcript: the captions only cover ~${result.coverage} of the video.`);
    }
    if (transcriptLang !== 'auto' && result.lang && result.lang.split('-')[0] !== transcriptLang) {
      notes.push(`ℹ️ No "${transcriptLang}" captions — used the "${result.lang}" track instead.`);
    }
    for (const n of notes) debugLog += `${n}\n`;

    // Ask for timestamps only when the transcript actually carries them (the
    // get_transcript fallback returns bare cue text, and promising anchors that
    // are not there is how a model starts inventing them) and the user has not
    // opted out via the Timestamps chip.
    const timed = hasTimestamps(transcript) && settings.includeTimestamps !== false;
    const jobSettingsTs = timed
      ? { ...jobSettings, prompt: `${jobSettings.prompt}\n\n${timestampNote(transcriptLang)}` }
      : jobSettings;

    const displayTitle = title || videoId;
    safePost({ type: 'jobTitleUpdate', jobId: job.id, title: displayTitle });
    const mode = settings.mode || 'web';
    const shortTitle = displayTitle.slice(0, 40);
    const warn = result.complete === false ? ` (⚠️ ${result.coverage} covered)` : '';

    // ── Mode: transcript only
    if (mode === 'transcript') {
      await updateJobStatus(job.id, 'active', '💾 Saving transcript...');
      const header = notes.length ? notes.join('\n') + '\n\n' : '';
      await downloadText(header + transcript, safeFilename(displayTitle, videoId, { suffix: '_transcript', ext: 'txt' }));
      await addToHistory(job.url, displayTitle);
      await updateJobStatus(job.id, 'done', `✅ Transcript saved${warn}: ${shortTitle}`);
      return;
    }

    // ── Mode: web
    if (mode === 'web') {
      const provider = settings.provider || 'anthropic';
      const webUrl = CONFIG.providerWebUrls[provider];
      if (!webUrl) throw new Error(`${provider} does not support Web mode. Use API mode instead.`);

      const providerLabel = providerLabelOf(provider);
      await updateJobStatus(job.id, 'active', `🌐 Opening ${providerLabel}...`);
      // A split transcript becomes several messages posted one after another
      // into the same conversation (see paste_common.js), so the model still
      // sees the whole video without any single message being enormous.
      // `maxMessageChars` is what keeps a part inside the composer's own limit;
      // it can only be acted on when we are allowed to send the follow-up parts.
      const web = buildChunkMessages(transcript, webChunkSettings(jobSettingsTs, provider, settings.autoSubmit));

      if (settings.saveTranscriptFile) {
        await saveWebParts(web.parts, displayTitle, videoId);
      }
      const willPaste = !!(settings.autoPaste || settings.autoSubmit);
      if (willPaste) {
        await setPendingLLMContent(web.parts, !!settings.autoSubmit, job.id, web.mergePlan);
      }
      await chrome.tabs.create({ url: webUrl, active: true });

      const splitNote = webSplitNote(web, settings, providerLabel);
      const overflowNote = webOverflowNote(web, providerLabel);
      await addToHistory(job.url, displayTitle);
      // Only the content script knows whether the text actually landed, so the
      // status stays provisional until it reports back (see pasteReport).
      const label = willPaste
        ? `📤 Sending to ${providerLabel}`
        : `✅ Opened ${providerLabel} (transcript saved)`;
      await updateJobStatus(job.id, 'done',
        `${label}${splitNote}${overflowNote}${warn}: ${displayTitle.slice(0, 35)}`);
      if (willPaste) {
        await pasteWatchAdd(job.id, {
          providerLabel, title: displayTitle, chunks: web.chunks, warn, overflowNote,
          merged: web.merged, autoSplit: web.autoSplit, autoSubmit: !!settings.autoSubmit
        });
      }
      return;
    }

    // ── Mode: LLM API
    const providerName = settings.provider || 'anthropic';
    await updateJobStatus(job.id, 'active', `🤖 ${providerName} (${settings.model}) — transcript ${(transcript.length / 1000).toFixed(1)}k chars...`);

    let llm;
    try {
      llm = await summarizeTranscript(transcript, jobSettingsTs, job.id, (m) => { debugLog += m; }, `🤖 ${providerName}`);
    } catch (llmErr) {
      // Keep the per-video debug dump the API path has always produced, but
      // never let a failed dump replace the real error message.
      try {
        await downloadText(debugLog, safeFilename(`debug_${videoId}`, `debug_${videoId}`, { ext: 'txt' }));
      } catch (dlErr) {
        console.warn('[YT Summarizer] could not save debug log:', dlErr);
      }
      throw llmErr;
    }
    if (llm.truncated) {
      notes.push(`⚠️ Transcript truncated to ${Math.round(llm.kept / 1000)}k of ${Math.round(llm.total / 1000)}k characters to fit the model's context — the summary does not cover the end of the video.`);
    }
    if (llm.chunks > 1) {
      notes.push(llm.merged
        ? `✂️ The transcript was split into ${llm.chunks} parts and the partial summaries were merged in a final API call.`
        : `✂️ The transcript was split into ${llm.chunks} parts, each summarized in a separate API call.`);
      if (llm.mergeError) notes.push(`⚠️ The final merge call failed (${llm.mergeError}) — the partial summaries are shown as-is.`);
    }

    const banner = notes.length ? `> ${notes.join('\n> ')}\n\n` : '';
    const mdContent = `# ${displayTitle}\n\n${banner}${linkTimestamps(llm.summary, videoId)}`;
    await downloadText(mdContent, safeFilename(displayTitle, videoId, { ext: 'md' }), 'text/markdown;charset=utf-8');

    await addToHistory(job.url, displayTitle);
    const apiWarn = llm.truncated ? ' (⚠️ truncated)' : warn;
    await updateJobStatus(job.id, 'done', `✅ Completed${apiWarn}: ${shortTitle}`);

  } catch (err) {
    const msg = err.message || String(err);
    if (err.noTranscript) {
      await updateJobStatus(job.id, 'unavailable', '⚠️ No transcript available for this video');
    } else {
      await updateJobStatus(job.id, 'error', `❌ ${msg.slice(0, 200)}`);
    }
    console.warn(`[YT Summarizer] Error on ${job.url}:`, err, '\n', debugLog);
  }
}

/**
 * Turn the `[m:ss]` anchors the model copied out of the transcript into links
 * that actually jump to that moment. Pure post-processing on the .md: the model
 * is never asked to write a URL, which it would get wrong.
 *
 * Deliberately not applied in combined mode — with several videos in one
 * transcript there is no way to tell which one a timestamp belongs to, and a
 * link to the wrong video is worse than no link.
 *
 * The `(?!\()` guard is the one that matters: without it a model that already
 * wrote `[1:23](url)` would come out as `[1:23](url)(url)`.
 */
function linkTimestamps(md, videoId) {
  if (!videoId || !md) return md;
  return String(md).replace(/\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\](?!\()/g, (whole, a, b, c) => {
    const [h, m, s] = c !== undefined ? [+a, +b, +c] : [0, +a, +b];
    const at = h * 3600 + m * 60 + s;
    return `[${whole.slice(1, -1)}](https://www.youtube.com/watch?v=${videoId}&t=${at}s)`;
  });
}

function providerLabelOf(provider) {
  return provider === 'anthropic' ? 'Claude.ai'
       : provider === 'openai'    ? 'ChatGPT'
       : provider === 'gemini'    ? 'Gemini'
       : provider;
}

// The pasted payload is claimed by the content script only after it lands in the
// chat box, and it expires: the old code deleted it up-front (losing the whole
// transcript if the page was slow or the user was logged out) and kept it
// forever otherwise, so an unrelated visit to claude.ai days later got a
// surprise paste.
async function setPendingLLMContent(parts, autoSubmit, jobId = null, mergePlan = null) {
  const list = Array.isArray(parts) ? parts : [parts];
  await dropOrphanPending(jobId);
  await chrome.storage.local.set({
    // `text` stays for the single-message case so nothing else has to care.
    // `jobId` travels with the payload so the content script can report the
    // real outcome back to the job it belongs to.
    // `merge` lets the content script rebuild the last message out of the
    // partial answers it can read on the page (see mergePlanFor in llm-api.js).
    pendingLLMContent: { parts: list, text: list[0], autoSubmit, jobId, merge: mergePlan, ts: Date.now() }
  });
}

/**
 * There is one pending payload for the whole browser, so the next video in a web
 * batch overwrites the previous one. `webDelay` (30 s by default) is usually
 * enough for the chat tab to have claimed it — but a cold Gemini tab can take
 * longer, and then the payload is simply gone: nothing is ever pasted for that
 * video and its row sits at "📤 Sending" forever.
 *
 * The transcript cannot be rescued (the new video's turn has come), but the
 * silence can: close the abandoned job honestly instead of leaving it hanging.
 */
async function dropOrphanPending(newJobId) {
  const { pendingLLMContent } = await chrome.storage.local.get('pendingLLMContent');
  const orphan = pendingLLMContent?.jobId;
  if (orphan == null || orphan === newJobId) return;
  // A claimed payload is already in a content script's hands: it works from its
  // own copy from here on, so overwriting the storage key costs it nothing and
  // declaring it failed would be a lie (its report is still coming).
  if (pendingLLMContent.claimedBy) return;

  const info = await pasteWatchTake(orphan);
  if (!info) return;
  // Covers both shapes of the same outcome: a tab that never claimed it, and one
  // that claimed it, failed, and handed it back for a retry that can no longer
  // happen. In either case this video's text is not going anywhere, and the
  // previous status ("reload the tab to retry") would now be bad advice.
  const title = String(info.title || '').slice(0, 35);
  await updateJobStatus(info.jobIds || orphan, 'error',
    `❌ ${info.providerLabel} never received this transcript — the next video's turn came first: ${title}`);
}

// Jobs whose status is still provisional, waiting for the content script's
// verdict. Kept in storage, not in a Map: posting a split transcript takes
// minutes and MV3 recycles the service worker long before the last part goes
// out, which would drop the report — and with it the only failure signal.
async function pasteWatchAdd(jobId, info) {
  const { pasteWatch = {} } = await chrome.storage.local.get('pasteWatch');
  // Entries only ever leave via a report or this cleanup, so an abandoned tab
  // cannot make the map grow forever.
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, e] of Object.entries(pasteWatch)) if ((e.ts || 0) < cutoff) delete pasteWatch[id];
  pasteWatch[jobId] = { ...info, ts: Date.now() };
  await chrome.storage.local.set({ pasteWatch });
}

async function pasteWatchTake(jobId) {
  const { pasteWatch = {} } = await chrome.storage.local.get('pasteWatch');
  const info = pasteWatch[jobId];
  if (!info) return null;
  delete pasteWatch[jobId];
  await chrome.storage.local.set({ pasteWatch });
  return info;
}

/**
 * Look at the watch entry without consuming it. A FAILED paste can still be
 * retried (the status line says "reload the tab to retry"), and the retry sends
 * a second report under the same job id — which the old take-on-first-report
 * dropped on the floor, leaving a job that had actually succeeded marked ❌
 * forever. So the entry only leaves on success, or via the 6 h cleanup.
 */
async function pasteWatchPeek(jobId) {
  const { pasteWatch = {} } = await chrome.storage.local.get('pasteWatch');
  return pasteWatch[jobId] || null;
}

/**
 * The content script telling us what actually happened in the chat tab. Web mode
 * used to declare "✅ Sent" the moment the tab was created, which was a lie
 * whenever the paste failed or stopped halfway through a split transcript.
 */
async function handlePasteReport(msg) {
  const info = await pasteWatchPeek(msg.jobId);
  if (!info) return;

  const { providerLabel, title, warn = '', overflowNote = '' } = info;
  // Two different counts, and mixing them up has already produced a wrong status
  // once: `total` counts MESSAGES (one more than the parts when a merge request
  // was appended, and exactly 1 when auto-submit is off), while `chunks` counts
  // transcript PARTS. Compare on messages, speak to the user in parts.
  const parts = info.chunks || 1;
  const total = msg.total || parts;
  const sent = msg.sent || 0;
  const tail = `${warn}${overflowNote}: ${String(title).slice(0, 35)}`;
  const scope = info.combined ? ' (combined)' : '';

  let status = 'done';
  let text;
  if (msg.ok && sent >= total) {
    if (!info.autoSubmit) {
      // Only part 1 was ever pasted, and nothing was submitted. Saying
      // "✅ Sent (✂️ 4 parts)" here would be the old lie in a new place.
      const note = parts > 1 ? ` (✂️ part 1 of ${parts} — auto-submit off)` : '';
      text = `✅ Pasted into ${providerLabel}${scope}${note}${tail}`;
    } else {
      const why = info.autoSplit ? ` — over ${providerLabel}'s message limit` : '';
      const note = parts > 1 ? ` (✂️ ${parts} parts${why}${info.merged ? ' + merge' : ''})` : '';
      // The merge message normally carries the partial answers back as text. When
      // the content script could not read them off the page it falls back to
      // "merge the summaries above" — which is exactly the case where the model
      // may quietly summarize only its most recent turns. Say so: a merge that
      // covered half the video used to look identical to one that covered it all.
      text = `✅ Sent to ${providerLabel}${scope}${note}${mergeFallbackNote(info, msg)}${tail}`;
    }
  } else if (total > parts && sent >= parts) {
    // Every transcript part landed; only the appended merge request did not.
    // The video did reach the model in full, so this is a soft failure.
    // Keyed on `total > parts` (there really was an extra message) rather than on
    // the `merged` flag, so a stale watch entry can't produce this line.
    status = 'error';
    text = `⚠️ All ${parts} parts reached ${providerLabel}${scope}, but the merge request did not${tail}`;
  } else if (sent > 0) {
    status = 'error';
    text = `⚠️ Only part ${sent} of ${parts} reached ${providerLabel}${scope}${tail}`;
  } else {
    status = 'error';
    text = `❌ Paste into ${providerLabel}${scope} failed — reload the tab to retry${tail}`;
  }
  // A failure is not the end of the story — the payload may still be in storage
  // and a reload retries it — so the entry stays until it either succeeds or is
  // aged out. Keeping it is what lets a successful retry correct the ❌.
  if (status === 'done') await pasteWatchTake(msg.jobId);

  // Combined mode drives several queue rows from one paste sequence.
  const rowUpdated = await updateJobStatus(info.jobIds || msg.jobId, status, text);

  // Failures always get a notification. Successes only when the queue row is
  // already gone: a split run outlives the popup, which prunes finished jobs on
  // open, so otherwise the one outcome the user waited minutes for would land
  // nowhere at all. When the row is still there it speaks for itself.
  if (status === 'error' || !rowUpdated) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('logo.png'),
        title: 'YT Summarizer',
        message: text
      });
    } catch (_) {}
  }
}

// `mergeInline === false` means the plan was there and the partial answers could
// not be read; `null`/undefined means there was no merge to inline in the first
// place (no merge requested, or a report from an older content script).
function mergeFallbackNote(info, msg) {
  if (!info.merged || msg.mergeInline !== false) return '';
  return ' (⚠️ merge relied on the chat’s memory — it may cover only the last parts)';
}

// One .txt per message when the transcript was split, so the user can paste the
// remaining parts by hand if auto-submit is off (or a page misbehaves).
async function saveWebParts(parts, displayTitle, videoId) {
  if (parts.length === 1) {
    await downloadText(parts[0], safeFilename(displayTitle, videoId, { suffix: '_transcript', ext: 'txt' }));
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    await downloadText(parts[i], safeFilename(displayTitle, videoId, { suffix: `_transcript_part${i + 1}of${parts.length}`, ext: 'txt' }));
  }
}

// Web mode can't send the follow-up parts unless it is allowed to press Send —
// say so in the status line instead of silently dropping most of the video.
//
// When the split was NOT the user's idea (the composer would have truncated the
// message) the reason has to travel with the number: "✂️ 7 parts" under a
// selector that says "1 part" reads as a bug rather than as a rescue.
function webSplitNote(web, settings, providerLabel = '') {
  if (web.chunks <= 1) return '';
  const why = web.autoSplit ? ` — over ${providerLabel ? `${providerLabel}'s` : 'the'} message limit` : '';
  if (!settings.autoSubmit) return ` (✂️ ${web.chunks} parts — auto-submit off, only part 1 pasted)`;
  return ` (✂️ ${web.chunks} parts${why}${web.merged ? ' + merge' : ''})`;
}

// Even at maxParts the worst message can stay over the composer's cap. This is
// the only signal the user gets that the tail of a part may vanish, so it has to
// survive into the final status too (see handlePasteReport), not just the
// provisional one.
function webOverflowNote(web, providerLabel) {
  if (!web.overflow) return '';
  return ` (⚠️ ${Math.ceil(web.overflow / 1000)}k chars over ${providerLabel}'s message limit — the tail of a part may be dropped)`;
}

// The per-provider composer cap, applied only in web mode and only when we are
// actually allowed to press Send (see plannedChunkCount / the splitToFit gate).
function webChunkSettings(base, provider, autoSubmit) {
  return {
    ...base,
    maxMessageChars: 0,
    splitToFit: !!autoSubmit
  };
}

/**
 * One summary out of a transcript, sent either in a single call or — when the
 * user asked for it in Advanced Settings and the transcript is long enough —
 * split into N sequential calls whose partial summaries are concatenated.
 *
 * The split lives here rather than inside callLLM so every chunk gets its own
 * rate-limit retries and its own cancellation check: a 429 on part 3 must not
 * re-send (and re-bill) parts 1 and 2.
 *
 * @returns {Promise<{summary: string, truncated: boolean, kept: number, total: number, chunks: number}>}
 */
async function summarizeTranscript(transcript, settings, jobId, appendLog, label = '🤖') {
  const chunks = plannedChunkCount(transcript, settings);
  if (chunks === 1) {
    const llm = await callLLMWithRetries(transcript, settings, jobId, appendLog);
    return { ...llm, chunks: 1, merged: false };
  }

  const lang = settings.transcriptLang || 'en';
  const parts = splitTranscript(transcript, chunks);
  const n = parts.length;
  appendLog(`\n✂️ Split into ${n} parts (${parts.map(p => Math.round(p.length / 1000) + 'k').join(' + ')} chars)\n`);

  const pieces = [];
  let truncated = false, kept = 0, total = 0;

  for (let i = 0; i < n; i++) {
    if (await batchCancelled()) throw new Error('Interrupted by user');
    await updateJobStatus(jobId, 'active', `${label} Part ${i + 1}/${n} — ${(parts[i].length / 1000).toFixed(1)}k chars...`);
    const llm = await callLLMWithRetries(parts[i], { ...settings, prompt: chunkPrompt(settings.prompt, i + 1, n, lang) }, jobId, appendLog);
    pieces.push(`${chunkHeading(i + 1, n, lang)}\n\n${llm.summary.trim()}`);
    truncated = truncated || llm.truncated;
    kept += llm.kept;
    total += llm.total;
    // A short pause between parts: N back-to-back calls on the same key is the
    // fastest way to trip a per-minute rate limit.
    if (i < n - 1 && await cancellableSleep(1500)) throw new Error('Interrupted by user');
  }

  const joined = pieces.join('\n\n');
  if (!settings.chunkMerge) return { summary: joined, truncated, kept, total, chunks: n, merged: false };

  // Optional extra call: fuse the partials into one summary. If it fails there
  // is no reason to throw away N successful calls — keep the joined parts.
  if (await batchCancelled()) throw new Error('Interrupted by user');
  await updateJobStatus(jobId, 'active', `${label} Merging ${n} parts...`);
  try {
    if (await cancellableSleep(1500)) throw new Error('Interrupted by user');
    const lang = settings.transcriptLang || 'en';
    const merge = await callLLMWithRetries(joined, { ...settings, prompt: mergeApiPrompt(settings.prompt, n, lang) }, jobId, appendLog);
    return { summary: merge.summary, truncated, kept, total, chunks: n, merged: true };
  } catch (e) {
    if (/Interrupted by user/.test(e.message || '')) throw e;
    appendLog(`\n⚠️ Merge pass failed (${e.message}) — keeping the ${n} partial summaries.\n`);
    return { summary: joined, truncated, kept, total, chunks: n, merged: false, mergeError: e.message };
  }
}

async function callLLMWithRetries(transcript, settings, jobId, appendLog) {
  const maxRetries = 3;
  const baseWaitSec = 60;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(transcript, settings);
    } catch (llmErr) {
      const m = llmErr.message || String(llmErr);
      const retriable = m.includes('429') || m.includes('Too Many Requests') || m.includes('overloaded') || m.includes('503');
      if (retriable && attempt < maxRetries) {
        const waitSec = baseWaitSec * Math.pow(2, attempt);
        appendLog(`\n⚠️ Rate limit (attempt ${attempt + 1}/${maxRetries}), waiting ${waitSec}s...\n`);
        for (let rem = waitSec; rem > 0; rem--) {
          if (await batchCancelled()) throw new Error('Interrupted by user');
          await updateJobStatus(jobId, 'active', `⏳ API rate limit — retry in ${rem}s (${attempt + 1}/${maxRetries})...`);
          await sleep(1000);
        }
        lastErr = llmErr;
        continue;
      }
      lastErr = llmErr;
      break;
    }
  }
  appendLog(`\n❌ LLM error: ${lastErr?.message}\n`);
  throw lastErr;
}

// ── Fetch transcript only (used by combined mode) ─────────────────────────────
async function fetchTranscriptForJob(job, settings) {
  const videoId = videoIdOf(job.url);
  if (!videoId) throw new Error('Unable to extract video ID from URL.');

  const transcriptLang = job.lang || settings.transcriptLang || 'en';
  const result = await acquireTranscript(videoId, transcriptLang, () => {});

  if (!result?.transcript) {
    const e = new Error('No transcript/captions available for this video.');
    e.noTranscript = true;
    throw e;
  }
  return { videoId, title: result.title, transcript: result.transcript, coverage: result.coverage, complete: result.complete };
}

// ── Combined Batch: all transcripts → single prompt ───────────────────────────
async function runBatchCombined(jobs, settings) {
  const pending = jobs.filter(isPending);

  const fetched = [];
  for (let i = 0; i < pending.length; i++) {
    if (await batchCancelled()) return;
    const job = pending[i];
    await updateJobStatus(job.id, 'active', `📥 Fetching transcript ${i + 1}/${pending.length}...`);
    try {
      const result = await fetchTranscriptForJob(job, settings);
      fetched.push({ job, ...result });
      const warn = result.complete === false ? ` (⚠️ ${result.coverage})` : '';
      await updateJobStatus(job.id, 'active', `📄 Transcript ready${warn} (${i + 1}/${pending.length})`);
    } catch (err) {
      if (err.noTranscript) {
        await updateJobStatus(job.id, 'unavailable', '⚠️ No transcript available for this video');
      } else {
        await updateJobStatus(job.id, 'error', `❌ ${(err.message || String(err)).slice(0, 200)}`);
      }
    }
    if (i < pending.length - 1) {
      if (await cancellableSleep(1500 + Math.random() * 2000)) return;
    }
  }

  if (fetched.length === 0 || await batchCancelled()) return;

  const combinedTranscript = fetched.map((r, i) =>
    `## Video ${i + 1}: ${r.title || r.videoId}\nSource: ${r.job.url}\n` +
    (r.complete === false ? `> ⚠️ Incomplete transcript (~${r.coverage} of the video)\n` : '') +
    `\n${r.transcript}`
  ).join('\n\n---\n\n');

  // Same gate as the single-video path (§ processJob): only promise citations
  // when at least one video actually carries anchors, and only when the user
  // has not opted out via the Timestamps chip.
  const timed = hasTimestamps(combinedTranscript) && settings.includeTimestamps !== false;
  const settingsTs = timed
    ? { ...settings, prompt: `${settings.prompt}\n\n${timestampNote(settings.transcriptLang || 'en')}` }
    : settings;

  const combinedContent = `${settingsTs.prompt}\n\n---\n\n${combinedTranscript}`;
  const mode = settings.mode || 'web';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  try {
    if (mode === 'transcript') {
      await downloadText(combinedTranscript, `combined_transcripts_${stamp}.txt`);
      for (const r of fetched) {
        await addToHistory(r.job.url, r.title);
        await updateJobStatus(r.job.id, 'done', '✅ Combined transcript saved');
      }
      return;
    }

    if (mode === 'web') {
      const provider = settings.provider || 'anthropic';
      const webUrl = CONFIG.providerWebUrls[provider];
      if (!webUrl) {
        for (const r of fetched) await updateJobStatus(r.job.id, 'error', `❌ ${provider} does not support Web mode.`);
        return;
      }
      const providerLabel = providerLabelOf(provider);
      // Combined is the case with the MOST text of all, so it is the one the
      // composer cap truncates hardest — it needs the same treatment as the
      // single-video branch, not the old unbounded split.
      const web = buildChunkMessages(combinedTranscript, webChunkSettings(settingsTs, provider, settings.autoSubmit));
      await downloadText(combinedContent, `combined_transcripts_${stamp}.txt`);

      const ids = fetched.map(r => r.job.id);
      const title = fetched.map(r => r.title || r.videoId).join(' + ');
      const willPaste = !!(settings.autoPaste || settings.autoSubmit);
      if (willPaste) {
        // `pasteReport` carries a single jobId, so the first job stands for the
        // whole set; the full list rides in the watch entry and every row is
        // updated together when the verdict comes back.
        await setPendingLLMContent(web.parts, !!settings.autoSubmit, ids[0], web.mergePlan);
      }
      await chrome.tabs.create({ url: webUrl, active: true });

      const splitNote = webSplitNote(web, settings, providerLabel);
      const overflowNote = webOverflowNote(web, providerLabel);
      for (const r of fetched) await addToHistory(r.job.url, r.title);
      // Provisional until the content script reports back — see pasteReport.
      const label = willPaste ? `📤 Sending to ${providerLabel}` : `✅ Opened ${providerLabel}`;
      await updateJobStatus(ids, 'done', `${label} (combined)${splitNote}${overflowNote}`);
      if (willPaste) {
        await pasteWatchAdd(ids[0], {
          providerLabel, title, chunks: web.chunks, warn: '', overflowNote,
          merged: web.merged, autoSplit: web.autoSplit, autoSubmit: !!settings.autoSubmit,
          jobIds: ids, combined: true
        });
      }
      return;
    }

    const ids = fetched.map(r => r.job.id);
    await updateJobStatus(ids, 'active', `🤖 Sending combined to ${settings.provider || 'anthropic'} API...`);
    const llm = await summarizeTranscript(combinedTranscript, settingsTs, ids, (m) => console.log('[combined]', m), '🤖 Combined');
    const titles = fetched.map(r => r.title || r.videoId).join(' + ');
    const notes = [];
    if (llm.truncated) {
      notes.push(`> ⚠️ Combined transcript truncated to ${Math.round(llm.kept / 1000)}k of ${Math.round(llm.total / 1000)}k characters — the last videos may be missing.`);
    }
    if (llm.chunks > 1) {
      notes.push(llm.merged
        ? `> ✂️ The combined transcript was split into ${llm.chunks} parts and the partial summaries were merged in a final API call.`
        : `> ✂️ The combined transcript was split into ${llm.chunks} parts, each summarized in a separate API call.`);
      if (llm.mergeError) notes.push(`> ⚠️ The final merge call failed (${llm.mergeError}) — the partial summaries are shown as-is.`);
    }
    const note = notes.length ? notes.join('\n') + '\n\n' : '';
    const mdContent = `# Combined Summary\n\n_Videos: ${titles}_\n\n${note}${llm.summary}`;
    await downloadText(mdContent, `combined_summary_${stamp}.md`, 'text/markdown;charset=utf-8');
    for (const r of fetched) await addToHistory(r.job.url, r.title);
    await updateJobStatus(ids, 'done', llm.truncated ? '✅ Combined summary saved (⚠️ truncated)' : '✅ Combined summary saved');
  } catch (err) {
    const msg = (err.message || String(err)).slice(0, 200);
    for (const r of fetched) await updateJobStatus(r.job.id, 'error', `❌ ${msg}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
// Serialize the read-modify-write of the shared jobs array: two overlapping
// status updates (or one racing the popup) used to clobber each other.
let jobWriteChain = Promise.resolve();

// `jobId` may also be an array: combined mode drives several queue entries from
// a single API call and they must all show the same progress.
// @returns {Promise<boolean>} whether any queue row was actually found. The popup
// prunes finished jobs from storage when it opens, so a long web run often has no
// row left by the time its verdict arrives — the caller needs to know that to
// decide whether the outcome would otherwise be visible nowhere.
async function updateJobStatus(jobId, status, statusText) {
  const ids = Array.isArray(jobId) ? jobId : [jobId];
  let found = false;
  jobWriteChain = jobWriteChain.then(async () => {
    const { jobs = [] } = await chrome.storage.local.get('jobs');
    let dirty = false;
    for (const id of ids) {
      const job = jobs.find(j => j.id === id);
      if (job) {
        job.status = status;
        job.statusText = statusText;
        dirty = true;
      }
    }
    if (dirty) await chrome.storage.local.set({ jobs });
    found = dirty;
  }).catch(e => console.warn('[YT Summarizer] job write failed:', e));
  await jobWriteChain;
  for (const id of ids) safePost({ type: 'jobUpdate', jobId: id, status, statusText });
  return found;
}

function safePost(msg) {
  try { if (popupPort) popupPort.postMessage(msg); } catch (_) {}
}

const HISTORY_MAX = 500;

async function addToHistory(url, title) {
  const { videoHistory = [] } = await chrome.storage.local.get('videoHistory');
  const idx = videoHistory.findIndex(e => e.url === url);
  const entry = { url, title: title || url, date: new Date().toISOString() };
  if (idx !== -1) videoHistory.splice(idx, 1);
  videoHistory.unshift(entry);
  await chrome.storage.local.set({ videoHistory: videoHistory.slice(0, HISTORY_MAX) });
}

// ── Playlist expansion ────────────────────────────────────────────────────────
// Turn a playlist URL into the list of its video URLs by scraping the playlist
// page's embedded ytInitialData, then following browse continuations for the
// (100-at-a-time) rest. Capped to keep huge playlists from flooding the queue.
const PLAYLIST_MAX = 5000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'pasteReport' && msg.jobId != null) {
    handlePasteReport(msg).catch(e => console.warn('[YT Summarizer] paste report failed:', e));
    return; // fire and forget
  }
  if (msg?.type === 'expandPlaylist') {
    expandPlaylist(msg.url)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message || String(e) }));
    return true; // keep the message channel open for the async response
  }
});

// Depth-unbounded search for the first value stored under `key`.
function deepFind(node, key, depth = 30) {
  if (!node || typeof node !== 'object' || depth < 0) return null;
  if (node[key] !== undefined) return node[key];
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = deepFind(v, key, depth - 1);
      if (r != null) return r;
    }
  }
  return null;
}

// Walk the whole tree collecting every playlist video (id + title). YouTube
// migrated the playlist layout to `lockupViewModel`; the legacy
// `playlistVideoRenderer` is still handled for older responses/clients.
function collectPlaylistVideos(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectPlaylistVideos(n, out, seen);
    return;
  }
  const lv = node.lockupViewModel;
  if (lv?.contentId && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && !seen.has(lv.contentId)) {
    seen.add(lv.contentId);
    out.push({ videoId: lv.contentId, title: lv.metadata?.lockupMetadataViewModel?.title?.content || null });
  }
  const r = node.playlistVideoRenderer;
  if (r?.videoId && !seen.has(r.videoId)) {
    seen.add(r.videoId);
    out.push({ videoId: r.videoId, title: r.title?.runs?.map(x => x.text).join('') || r.title?.simpleText || null });
  }
  for (const k in node) {
    if (k === 'lockupViewModel' || k === 'playlistVideoRenderer') continue;
    collectPlaylistVideos(node[k], out, seen);
  }
}

function extractYtInitialData(html) {
  const idx = html.indexOf('ytInitialData');
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// The "load more" token for a playlist lives in a continuationItemRenderer that
// sits in the SAME array as the video items. ytInitialData contains several
// unrelated continuationItemRenderers (header shelves, related sections); a
// plain first-match deepFind often returns one of those, whose token fetches
// something other than the next playlist page — so the loop makes no progress
// and stops at the first 100. Scope the search to the array holding the videos.
function isPlaylistVideoNode(n) {
  return !!(n && typeof n === 'object' && (n.playlistVideoRenderer
    || (n.lockupViewModel && n.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')));
}
function tokenFromContinuationItem(cir) {
  return cir?.continuationEndpoint?.continuationCommand?.token
    || cir?.button?.buttonRenderer?.command?.continuationCommand?.token
    || deepFind(cir, 'token') || null;
}
function findContinuationToken(root) {
  let found = null;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.some(isPlaylistVideoNode)) {
        const cir = node.find(x => x?.continuationItemRenderer)?.continuationItemRenderer;
        const t = cir && tokenFromContinuationItem(cir);
        if (t) { found = t; return; }
      }
      for (const n of node) walk(n);
      return;
    }
    for (const k in node) walk(node[k]);
  };
  walk(root);
  // Fall back to the old global search if the scoped one came up empty.
  if (!found) {
    const cir = deepFind(root, 'continuationItemRenderer');
    found = cir ? deepFind(cir, 'token') : null;
  }
  return found;
}

// "1,234 videos" / "1.234 video" / "1.2K videos". A bare /\d+/ used to read
// "1.2K videos" as 1, which then made a truncated import look complete.
function parseVideoCount(text) {
  const s = String(text || '');
  const m = s.match(/([\d][\d.,\s]*)\s*([KMkm])?\s*(?:video|videos|filmati)\b/i);
  if (!m) return NaN;
  const digits = m[1].replace(/[.,\s]/g, '');
  let n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return NaN;
  if (m[2]) {
    // Approximate counts ("1.2K") lose precision; reconstruct from the decimals.
    const dec = m[1].match(/[.,](\d)\s*$/);
    const base = dec ? parseInt(m[1].replace(/[.,]\d\s*$/, '').replace(/[.,\s]/g, ''), 10) + parseInt(dec[1], 10) / 10 : n;
    n = Math.round(base * (m[2].toUpperCase() === 'K' ? 1000 : 1000000));
  }
  return n;
}

function textOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (typeof v === 'string') return v;
  return v.runs?.map(r => r.text).join('') || v.simpleText || v.content || '';
}

async function expandPlaylist(url) {
  let listId;
  try { listId = new URL(url).searchParams.get('list'); } catch { listId = null; }
  if (!listId) throw new Error('No playlist id in URL');
  if (/^RD/.test(listId)) throw new Error('Mix/radio playlists are auto-generated and cannot be expanded');

  const seen = new Set();
  const videos = [];
  let total = null; // videos the playlist declares it has (may exceed what we load)
  let contDbg = null; // continuation diagnostics, surfaced when we can't load them all
  let dupes = 0; // playlist entries that repeat a video we already have

  // Scrape the playlist HTML page for the first ~100 videos. Hitting
  // /youtubei/v1/browse straight from the service worker gets served Google's
  // "Sorry" anti-abuse 403 (the chrome-extension Origin trips it, and the
  // declarativeNetRequest Origin rewrite doesn't reliably apply here), so we read
  // the plain HTML page instead — it embeds ytInitialData with the first page —
  // and page through the rest, when the playlist is longer, from a YouTube tab.
  //
  // credentials:'include' is required: an anonymous request from an EU visitor
  // is redirected to consent.youtube.com (not in host_permissions, so the fetch
  // then fails CORS). Sending the browser's existing consent cookie keeps the
  // request on www.youtube.com, whose host permission makes the response readable.
  try {
    const pageResp = await fetchWithTimeout(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
      { credentials: 'include', headers: { 'Accept-Language': 'en-US,en;q=0.9' } },
      15000
    );
    if (pageResp.ok) {
      const html = await pageResp.text();
      let apiKey = CONFIG.youtube.apiKey, clientVersion = CONFIG.youtube.webClientVersion;
      const km = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/); if (km) apiKey = km[1];
      const vm = html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/); if (vm) clientVersion = vm[1];
      const data = extractYtInitialData(html);
      if (data) {
        // The playlist's declared size. Different layouts expose it under
        // different keys (e.g. numVideosText = "26 videos"), so try each in turn,
        // then fall back to scraping the raw HTML for an "N videos" string.
        let n = NaN;
        for (const key of ['numVideosText', 'videoCountText', 'videoCountShortText', 'stats']) {
          n = parseVideoCount(textOf(deepFind(data, key)));
          if (Number.isFinite(n)) break;
        }
        if (!Number.isFinite(n)) n = parseVideoCount(html.match(/[\d][\d.,\s]*\s*[KMkm]?\s*videos?\b/i)?.[0]);
        if (Number.isFinite(n)) total = n;
        collectPlaylistVideos(data, videos, seen);
        const token = findContinuationToken(data);
        // Finish longer playlists from a real youtube.com tab, where the browse
        // continuation endpoint isn't hit with the anti-abuse 403. Attempt this
        // whenever the first page looks full even if we couldn't parse a token
        // here — the tab derives a valid token from its own live ytInitialData.
        const firstPage = videos.length;
        const shouldPage = firstPage < PLAYLIST_MAX && (token || firstPage >= 90 || (total && total > firstPage));
        console.log(`[playlist] listId=${listId} firstPage=${firstPage} declaredTotal=${total} htmlToken=${token ? 'yes' : 'no'} paging=${shouldPage ? 'yes' : 'no'}`);
        if (shouldPage) {
          const more = await tabBrowseContinuations(listId, token, apiKey, clientVersion, PLAYLIST_MAX, msg => {
            console.log('[playlist]', msg);
            const dm = /continuations dbg:\s*(\{.*\})/.exec(msg);
            if (dm) { try { contDbg = JSON.parse(dm[1]); } catch { /* keep null */ } }
          });
          for (const v of more.videos) {
            if (v?.videoId && !seen.has(v.videoId)) { seen.add(v.videoId); videos.push(v); }
          }
          // The live playlist tab reads the declared size more reliably than the
          // background HTML fetch; trust it when it isn't below what we loaded.
          if (Number.isFinite(more.total) && more.total >= videos.length) total = more.total;
          dupes = more.dupes || 0;
          console.log(`[playlist] after continuations: ${videos.length} videos (added ${videos.length - firstPage}, dupes ${dupes})`);
        }
      }
    }
  } catch (e) { console.log('[playlist] expand error:', e?.message || e); }

  if (videos.length === 0) throw new Error('No videos found (private, empty, or unavailable playlist)');

  const out = videos.slice(0, PLAYLIST_MAX).map(v => ({
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    title: v.title
  }));
  // "truncated" = we couldn't load every video the playlist claims to have
  // (hit PLAYLIST_MAX, or continuations were blocked past the first page).
  if (total == null || out.length > total) total = out.length;
  // If unique videos + repeats accounts for the declared total, we actually
  // loaded the whole playlist — the shortfall is just duplicate entries we
  // (correctly) collapsed, so it isn't truncated.
  const allSeen = out.length + dupes >= total;
  const truncated = out.length < total && !allSeen;
  const cappedAt = videos.length > PLAYLIST_MAX ? PLAYLIST_MAX : null;
  // A non-2xx continuation status means YouTube actively blocked a page. If every
  // fetch was fine and we simply ran out, the shortfall is unavailable videos
  // (private/deleted) that the playlist still counts in its total.
  const blocked = !!(contDbg?.statuses?.some(s => !/:2\d\d$/.test(String(s))));
  console.log(`[playlist] result: ${out.length}/${total} dupes=${dupes} truncated=${truncated} blocked=${blocked}`, contDbg || '(no continuation dbg)');
  return { videos: out, count: out.length, total, dupes, truncated, blocked, cappedAt, contDbg };
}
