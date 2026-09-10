import { CONFIG, PROVIDERS, getPreset, isPreset, initPrompts } from './modules/config.js';
import { showMsg, showBanner } from './modules/ui-utils.js';
import { state } from './modules/popup-state.js';
import { renderHistory, clearHistory } from './modules/popup-history.js';
import { populateTTSVoices, sendTTS, ttsPlay, ttsPauseResume, ttsStop, updateTTSStatus } from './modules/popup-tts.js';
import { applyProvider, persistSettings, saveSettings, updatePromptPreview, togglePromptEditor } from './modules/popup-settings.js';
import { renderJobs, updateJob, setUIAsRunning, setUIAsStopped, setMode, setChip, setOutputFormat, setSummaryLength, toggleJobSettings, updateJobEditBtn, setJobFormat, setJobLength, resetJobSettings, setJobLang, setJobTimeStart, setJobTimeEnd } from './modules/popup-render.js';

const PANELS = ['panel-settings', 'panel-history', 'panel-tts'];

let countdownInterval = null;

// `Date.now() + i` handed out ids in a contiguous block (500 of them when
// importing a playlist), so any job added in the next half second collided with
// one already in the queue — and every lookup is by id: the wrong row was
// updated, and removing one job deleted two.
let idSeq = 0;
function newJobId() {
  let id = Date.now() * 1000 + (idSeq++ % 1000);
  while (state.jobs.some(j => j.id === id)) id++;
  return id;
}

function makeJob(url, title = null) {
  return {
    id: newJobId(), url, title,
    status: 'queued', statusText: 'Queued',
    prompt: null, format: null, length: null, split: null
  };
}

async function updateApiKeyWarning() {
  const mode = document.getElementById('mode-select').value;
  const provider = document.getElementById('provider-select').value;
  const { apiKeys = {} } = await chrome.storage.local.get('apiKeys');
  const warn = mode === 'api' && !(apiKeys[provider] || '').trim();
  document.getElementById('btn-settings').dataset.warn = warn ? '1' : '';
}

function startCountdown(nextJobAt) {
  clearInterval(countdownInterval);
  const bar = document.getElementById('countdown-bar');
  const text = document.getElementById('countdown-text');
  if (!bar || !text) return;
  bar.classList.remove('hidden');
  function tick() {
    const rem = Math.max(0, Math.ceil((nextJobAt - Date.now()) / 1000));
    text.textContent = `Next video in ${rem}s`;
    if (rem === 0) { clearInterval(countdownInterval); bar.classList.add('hidden'); }
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  document.getElementById('countdown-bar')?.classList.add('hidden');
}

function closeAllPanels() {
  PANELS.forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('main-view').classList.remove('hidden');
}

function openPanel(panelId, onOpen) {
  PANELS.forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById(panelId).classList.remove('hidden');
  document.getElementById('main-view').classList.add('hidden');
  if (onOpen) onOpen();
}

function togglePanel(panelId, onOpen) {
  const panel = document.getElementById(panelId);
  if (panel.classList.contains('hidden')) {
    openPanel(panelId, onOpen);
  } else {
    closeAllPanels();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await initPrompts();
  const stored = await chrome.storage.local.get([
    'provider', 'apiKey', 'apiKeys', 'models', 'customEndpointUrl',
    'transcriptLang', 'customPrompt', 'mode',
    'useThinking', 'autoPaste', 'autoSubmit', 'combinedPrompt', 'saveTranscriptFile',
    'outputFormat', 'summaryLength', 'jobs', 'running', 'theme',
    'ttsState', 'ttsRate', 'ttsVoice', 'ttsText', 'webDelay', 'ttsLocalUrl',
    'includeTimestamps', 'chunkMode', 'chunkMerge', 'timeStart', 'timeEnd'
  ]);

  const {
    transcriptLang, customPrompt, mode,
    useThinking, autoPaste, autoSubmit, combinedPrompt, saveTranscriptFile,
    outputFormat, summaryLength, jobs: savedJobs, running: savedRunning, theme,
    ttsState, ttsRate, ttsVoice, ttsText, webDelay, ttsLocalUrl,
    includeTimestamps, chunkMode, chunkAuto, chunkAutoNum, chunkMerge, timeStart, timeEnd
  } = stored;

  // Migrate legacy apiKey → apiKeys.anthropic
  let apiKeys = stored.apiKeys || {};
  if (stored.apiKey && !apiKeys.anthropic) {
    apiKeys = { ...apiKeys, anthropic: stored.apiKey };
    await chrome.storage.local.set({ apiKeys });
  }
  const models = stored.models || {};

  if (theme === 'dark') document.body.classList.add('dark');
  document.getElementById('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  document.getElementById('app-version').textContent = 'v' + chrome.runtime.getManifest().version;

  if (savedJobs) state.jobs = savedJobs;
  if (savedRunning) state.running = savedRunning;

  if (savedRunning) {
    const { nextJobAt } = await chrome.storage.local.get('nextJobAt');
    if (nextJobAt && nextJobAt > Date.now()) startCountdown(nextJobAt);
  }

  if (!savedRunning && state.jobs.some(j => j.status === 'done' || j.cleared)) {
    state.jobs = state.jobs.filter(j => j.status !== 'done' && !j.cleared);
    chrome.storage.local.set({ jobs: state.jobs });
  }

  // TTS
  const savedRate = ttsRate ?? 1.0;
  document.getElementById('tts-rate').value = savedRate;
  document.getElementById('tts-rate-label').textContent = savedRate.toFixed(1) + '×';
  populateTTSVoices(ttsVoice);
  speechSynthesis.onvoiceschanged = () => populateTTSVoices(ttsVoice);
  if (ttsText) document.getElementById('tts-text').value = ttsText;
  if (ttsState) updateTTSStatus(ttsState);
  if (ttsLocalUrl) document.getElementById('tts-local-url').value = ttsLocalUrl;
  document.getElementById('web-delay').value = webDelay ?? 30;

  if (timeStart) document.getElementById('time-start').value = timeStart;
  if (timeEnd) document.getElementById('time-end').value = timeEnd;

  const modeSel = document.getElementById('chunk-mode-select');
  const mergeCb = document.getElementById('chunk-merge-cb');
  const autoCb = document.getElementById('chunk-auto-cb');
  const autoNum = document.getElementById('chunk-auto-num');
  const fieldAuto = document.getElementById('field-chunk-auto');

  if (modeSel) {
    modeSel.value = chunkMode || 'same';
    fieldAuto.classList.toggle('hidden', modeSel.value !== 'same');
    modeSel.addEventListener('change', () => {
      fieldAuto.classList.toggle('hidden', modeSel.value !== 'same');
      persistSettings();
    });
  }
  if (mergeCb) {
    mergeCb.checked = chunkMerge ?? true;
    mergeCb.addEventListener('change', persistSettings);
  }
  if (autoCb) {
    autoCb.checked = chunkAuto ?? false;
    autoCb.addEventListener('change', persistSettings);
  }
  if (autoNum) {
    autoNum.value = chunkAutoNum ?? 3;
    autoNum.addEventListener('change', persistSettings);
  }

  const currentLang = transcriptLang || 'auto';
  document.getElementById('transcript-lang-select').value = currentLang;
  const inlineSel = document.getElementById('lang-select-inline');
  if (inlineSel) inlineSel.value = currentLang;

  const currentFmt = outputFormat || 'chat';
  const currentLen = summaryLength || 'normal';
  const prompt = customPrompt || getPreset(currentLang, currentFmt, currentLen);
  document.getElementById('prompt-input').value = prompt;
  updatePromptPreview(prompt);

  const savedProvider = stored.provider || 'anthropic';
  await applyProvider(savedProvider, apiKeys, models, stored.customEndpointUrl || '');

  const currentAutoSubmit = autoSubmit ?? true;
  const currentAutoPaste = autoPaste ?? true;

  setMode(mode || 'web');
  setChip('chip-autopaste', !!currentAutoPaste || !!currentAutoSubmit);
  setChip('chip-autosubmit', !!currentAutoSubmit);
  setChip('chip-combine', !!combinedPrompt);
  setChip('chip-thinking', !!useThinking);
  setChip('chip-save-file', !!saveTranscriptFile);
  setChip('chip-timestamps', includeTimestamps !== false);
  setOutputFormat(currentFmt);
  setSummaryLength(currentLen);
  if (currentAutoSubmit) document.getElementById('chip-autopaste').classList.add('locked');
  // Last, deliberately: the note depends on the provider, the mode AND the
  // auto-submit chip, and all three are only settled by this point.

  // ── Event listeners ───────────────────────────────────────────────────────
  
  let currentWindowId = null;
  let isSidePanelOpen = false;
  
  chrome.windows.getCurrent(w => { currentWindowId = w.id; });
  if (chrome.runtime.getContexts) {
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }, (contexts) => {
      isSidePanelOpen = contexts.length > 0;
    });
  }
  
  document.getElementById('open-sidepanel-btn').addEventListener('click', () => {
    if (isSidePanelOpen) {
      // Toggle off by disabling and re-enabling
      chrome.sidePanel.setOptions({ enabled: false }, () => {
        chrome.sidePanel.setOptions({ enabled: true });
      });
      isSidePanelOpen = false;
    } else {
      if (currentWindowId) {
        chrome.sidePanel.open({ windowId: currentWindowId });
        isSidePanelOpen = true;
      } else {
        // Fallback if getCurrent hasn't resolved yet
        chrome.windows.getCurrent(w => chrome.sidePanel.open({ windowId: w.id }));
      }
    }
  });

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-history').addEventListener('click', () => togglePanel('panel-history', renderHistory));
  document.getElementById('btn-settings').addEventListener('click', () => togglePanel('panel-settings'));
  document.getElementById('btn-tts').addEventListener('click', () => togglePanel('panel-tts'));
  document.getElementById('btn-back-settings').addEventListener('click', closeAllPanels);
  document.getElementById('btn-back-history').addEventListener('click', closeAllPanels);
  document.getElementById('btn-back-tts').addEventListener('click', closeAllPanels);
  document.getElementById('tts-btn-play').addEventListener('click', ttsPlay);
  document.getElementById('tts-btn-pauseresume').addEventListener('click', ttsPauseResume);
  document.getElementById('tts-btn-stop').addEventListener('click', ttsStop);
  document.getElementById('tts-rate').addEventListener('input', async e => {
    const rate = parseFloat(e.target.value);
    document.getElementById('tts-rate-label').textContent = rate.toFixed(1) + '×';
    await chrome.storage.local.set({ ttsRate: rate });
    if (state.ttsPlaying) sendTTS({ type: 'tts-rate', rate });
  });
  document.getElementById('tts-voice').addEventListener('change', e => {
    const voiceName = e.target.value;
    if (voiceName) chrome.storage.local.set({ ttsVoice: voiceName });
    if (state.ttsPlaying) sendTTS({ type: 'tts-voice', voiceName: voiceName || undefined });
  });
  let ttsSaveTimer;
  document.getElementById('tts-text').addEventListener('input', e => {
    clearTimeout(ttsSaveTimer);
    ttsSaveTimer = setTimeout(() => chrome.storage.local.set({ ttsText: e.target.value }), 500);
  });
  document.getElementById('tts-local-url').addEventListener('input', e => {
    chrome.storage.local.set({ ttsLocalUrl: e.target.value.trim() });
  });
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory);
  document.getElementById('history-list').addEventListener('click', e => {
    const link = e.target.closest('.history-link');
    if (link) { e.preventDefault(); chrome.tabs.create({ url: link.dataset.url }); }
  });

  document.getElementById('btn-donate').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://paypal.me/RobertoReale12' });
  });
  document.getElementById('btn-save-key').addEventListener('click', async () => {
    await saveSettings();
    updateApiKeyWarning();
  });
  document.getElementById('btn-add').addEventListener('click', addUrl);
  document.getElementById('btn-add-tab').addEventListener('click', addCurrentTab);
  document.getElementById('btn-clear-queue').addEventListener('click', clearQueue);
  document.getElementById('import-banner-close').addEventListener('click', () => showBanner(''));
  document.getElementById('btn-bulk-toggle').addEventListener('click', () => toggleBulkAdd());
  document.getElementById('btn-bulk-add').addEventListener('click', bulkAddUrls);
  document.getElementById('btn-bulk-cancel').addEventListener('click', () => {
    document.getElementById('bulk-input').value = '';
    toggleBulkAdd(false);
  });
  document.getElementById('bulk-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bulkAddUrls(); }
  });
  document.getElementById('btn-run').addEventListener('click', startBatch);
  document.getElementById('btn-reset').addEventListener('click', resetBatch);
  document.getElementById('btn-prompt-toggle').addEventListener('click', togglePromptEditor);

  // ── Inline language selector ─────────────────────────────────────────────
  document.getElementById('lang-select-inline').addEventListener('change', async (e) => {
    const lang = e.target.value;
    // Keep settings selector in sync
    document.getElementById('transcript-lang-select').value = lang;
    await chrome.storage.local.set({ transcriptLang: lang });
    // Refresh prompt preview with new lang
    const { outputFormat: fmt, summaryLength: len } =
      await chrome.storage.local.get(['outputFormat', 'summaryLength']);
    const { customPrompt } = await chrome.storage.local.get('customPrompt');
    // Only auto-update if not using a fully custom prompt
    const preset = getPreset(lang, fmt || 'chat', len || 'normal');
    if (!customPrompt || isPreset(customPrompt)) {
      document.getElementById('prompt-input').value = preset;
      updatePromptPreview(preset);
      await chrome.storage.local.set({ customPrompt: preset });
    }
  });

  // Keep the Advanced Settings lang selector in sync with inline one
  document.getElementById('transcript-lang-select').addEventListener('change', async (e) => {
    const lang = e.target.value;
    document.getElementById('lang-select-inline').value = lang;
    await chrome.storage.local.set({ transcriptLang: lang });
    const { outputFormat: fmt, summaryLength: len } =
      await chrome.storage.local.get(['outputFormat', 'summaryLength']);
    const { customPrompt: currentPrompt } = await chrome.storage.local.get('customPrompt');
    const preset = getPreset(lang, fmt || 'chat', len || 'normal');
    if (!currentPrompt || isPreset(currentPrompt)) {
      document.getElementById('prompt-input').value = preset;
      updatePromptPreview(preset);
      await chrome.storage.local.set({ customPrompt: preset });
    }
  });


  document.getElementById('url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addUrl();
  });

  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      const { apiKeys: storedKeys = {}, models: storedModels = {}, customEndpointUrl = '' } =
        await chrome.storage.local.get(['apiKeys', 'models', 'customEndpointUrl']);
      await applyProvider(tab.dataset.provider, storedKeys, storedModels, customEndpointUrl);
      persistSettings();
      updateApiKeyWarning();
    });
  });

  let promptTimer = null;
  document.getElementById('prompt-input').addEventListener('input', () => {
    const val = document.getElementById('prompt-input').value;
    updatePromptPreview(val);
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
      chrome.storage.local.set({ customPrompt: val.trim() });
    }, 600);
  });

  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('disabled')) return;
      setMode(tab.dataset.mode);
      persistSettings();
      updateApiKeyWarning();
    });
  });

  document.querySelectorAll('.chip:not(.chip-fmt):not(.chip-len)').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.classList.contains('locked')) return;
      const newOn = !chip.classList.contains('on');
      setChip(chip.id, newOn);
      if (chip.id === 'chip-autosubmit') {
        if (newOn) {
          setChip('chip-autopaste', true);
          document.getElementById('chip-autopaste').classList.add('locked');
        } else {
          document.getElementById('chip-autopaste').classList.remove('locked');
        }
      }
      persistSettings();
    });
  });

  document.querySelectorAll('.chip-fmt').forEach(chip => {
    chip.addEventListener('click', async () => {
      const fmt = chip.dataset.fmt;
      const { transcriptLang: lang, summaryLength: len } =
        await chrome.storage.local.get(['transcriptLang', 'summaryLength']);
      const preset = getPreset(lang || 'en', fmt, len || 'normal');
      const { customPrompt } = await chrome.storage.local.get('customPrompt');
      if (!customPrompt || isPreset(customPrompt)) {
        document.getElementById('prompt-input').value = preset;
        updatePromptPreview(preset);
        await chrome.storage.local.set({ outputFormat: fmt, customPrompt: preset });
      } else {
        await chrome.storage.local.set({ outputFormat: fmt });
      }
      setOutputFormat(fmt);
    });
  });

  document.querySelectorAll('.chip-len').forEach(chip => {
    chip.addEventListener('click', async () => {
      const len = chip.dataset.len;
      const { transcriptLang: lang, outputFormat: fmt } =
        await chrome.storage.local.get(['transcriptLang', 'outputFormat']);
      const preset = getPreset(lang || 'en', fmt || 'chat', len);
      const { customPrompt } = await chrome.storage.local.get('customPrompt');
      if (!customPrompt || isPreset(customPrompt)) {
        document.getElementById('prompt-input').value = preset;
        updatePromptPreview(preset);
        await chrome.storage.local.set({ summaryLength: len, customPrompt: preset });
      } else {
        await chrome.storage.local.set({ summaryLength: len });
      }
      setSummaryLength(len);
    });
  });

  document.getElementById('job-list').addEventListener('click', e => {
    if (e.target.closest('.job-remove')?.dataset.jobId && !e.target.closest('.job-remove').disabled) {
      removeJob(Number(e.target.closest('.job-remove').dataset.jobId));
      return;
    }
    const editBtn = e.target.closest('.job-edit-btn');
    if (editBtn && !editBtn.disabled) { toggleJobSettings(Number(editBtn.dataset.jobId)); return; }
    const fmtChip = e.target.closest('.job-chip-fmt');
    if (fmtChip && !fmtChip.disabled) { setJobFormat(Number(fmtChip.dataset.jobId), fmtChip.dataset.fmt); return; }
    const lenChip = e.target.closest('.job-chip-len');
    if (lenChip && !lenChip.disabled) { setJobLength(Number(lenChip.dataset.jobId), lenChip.dataset.len); return; }
    const resetBtn = e.target.closest('.job-reset-btn');
    if (resetBtn && !resetBtn.disabled) { resetJobSettings(Number(resetBtn.dataset.jobId)); return; }
  });

  // Per-job selects use 'change' event (not click)
  document.getElementById('job-list').addEventListener('change', e => {
    const langSel = e.target.closest('.job-lang-select');
    if (langSel && !langSel.disabled) {
      setJobLang(Number(langSel.dataset.jobId), langSel.value);
      return;
    }
  });

  let jobPromptTimer = null;
  document.getElementById('job-list').addEventListener('input', e => {
    const timeInput = e.target.closest('.job-time-input');
    if (timeInput) {
      const id = Number(timeInput.dataset.jobId);
      const type = timeInput.dataset.timeType; // 'start' or 'end'
      if (type === 'start') setJobTimeStart(id, timeInput.value.trim());
      else if (type === 'end') setJobTimeEnd(id, timeInput.value.trim());
      return;
    }

    const ta = e.target.closest('.job-prompt-input');
    if (!ta) return;
    const id = Number(ta.dataset.jobId);
    clearTimeout(jobPromptTimer);
    jobPromptTimer = setTimeout(async () => {
      const job = state.jobs.find(j => j.id === id);
      if (job) {
        job.prompt = ta.value.trim() || null;
        updateJobEditBtn(id, job);
        await chrome.storage.local.set({ jobs: state.jobs });
      }
    }, 600);
  });

  renderJobs();
  if (state.running) setUIAsRunning();
  connectPort();
  updateApiKeyWarning();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ── Port ──────────────────────────────────────────────────────────────────────
function connectPort() {
  try {
    state.port = chrome.runtime.connect({ name: 'popup' });
    state.port.onMessage.addListener(msg => {
      if (msg.type === 'jobUpdate') {
        updateJob(msg.jobId, msg.status, msg.statusText);
      } else if (msg.type === 'jobTitleUpdate') {
        const job = state.jobs.find(j => j.id === msg.jobId);
        if (job && !job.title) {
          job.title = msg.title;
          chrome.storage.local.set({ jobs: state.jobs });
          const el = document.querySelector(`.job-title[data-job-id="${msg.jobId}"]`);
          if (el) { el.textContent = msg.title; el.classList.remove('loading'); }
        }
      } else if (msg.type === 'countdown') {
        startCountdown(msg.nextJobAt);
      } else if (msg.type === 'batchDone') {
        stopCountdown();
        state.running = false;
        // The background just pruned the faded-out jobs; re-read instead of
        // writing our stale copy back over its result.
        chrome.storage.local.get('jobs').then(({ jobs = [] }) => {
          state.jobs = jobs;
          renderJobs();
        });
        setUIAsStopped();
        const s = msg.summary;
        if (s && (s.noTranscript || s.failed)) {
          const bits = [`${s.done} done`];
          if (s.noTranscript) bits.push(`${s.noTranscript} without transcript`);
          if (s.failed) bits.push(`${s.failed} failed`);
          showMsg(`✅ Complete — ${bits.join(', ')}`, s.failed ? 'warn' : 'ok');
        } else {
          showMsg('✅ Processing complete!', 'ok');
        }
      } else if (msg.type === 'tts-state') {
        updateTTSStatus(msg);
      }
    });
    state.port.onDisconnect.addListener(() => { state.port = null; });
  } catch (_) {
    state.port = null;
  }
}

function ensurePort() {
  if (!state.port) connectPort();
  return state.port;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
async function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  document.getElementById('btn-theme').textContent = isDark ? '☀️' : '🌙';
  await chrome.storage.local.set({ theme: isDark ? 'dark' : 'light' });
}

// ── Job Management ────────────────────────────────────────────────────────────

// Extract every YouTube URL from an arbitrary blob of text (one-per-line,
// space-separated, comma-separated or a mix — numbered lists are fine too).
function extractYouTubeUrls(text) {
  const seen = new Set();
  const urls = [];
  for (let tok of String(text).split(/[\s,]+/)) {
    tok = tok.trim().replace(/^[<("'\[]+|[>)"'\].]+$/g, '');
    if (!tok) continue;
    if (!tok.includes('youtube.com') && !tok.includes('youtu.be')) continue;
    if (!/^https?:\/\//i.test(tok)) tok = 'https://' + tok;
    if (seen.has(tok)) continue;
    seen.add(tok);
    urls.push(tok);
  }
  return urls;
}

// Lazily fetch and fill in the video title for a freshly-added job.
function loadTitle(jobId, url) {
  fetchVideoTitle(url).then(title => {
    if (!title) return;
    const j = state.jobs.find(j => j.id === jobId);
    if (j && !j.title) {
      j.title = title;
      chrome.storage.local.set({ jobs: state.jobs });
      const el = document.querySelector(`.job-title[data-job-id="${jobId}"]`);
      if (el) { el.textContent = title; el.classList.remove('loading'); }
    }
  });
}

// Add a list of items to the queue, de-duplicating against existing jobs and
// re-queueing ones that previously errored. Each item is a URL string or a
// { url, title } object (title known up-front skips the oembed lookup).
async function enqueueUrls(items) {
  let added = 0, requeued = 0;
  const fresh = [];
  items.forEach((item) => {
    const url = typeof item === 'string' ? item : item.url;
    const title = typeof item === 'string' ? null : (item.title || null);
    const existing = state.jobs.find(j => j.url === url && !j.cleared);
    if (existing) {
      if (existing.status === 'error' || existing.status === 'unavailable') {
        existing.status = 'queued';
        existing.statusText = 'Queued';
        requeued++;
      }
      return;
    }
    const job = makeJob(url, title);
    state.jobs.push(job);
    fresh.push(job);
    added++;
  });

  if (added || requeued) {
    await chrome.storage.local.set({ jobs: state.jobs });
    renderJobs();
  }
  fresh.forEach(job => { if (!job.title) loadTitle(job.id, job.url); });
  return { added, requeued };
}

// Classify a URL as a playlist worth expanding. A specific video *within* a
// playlist (watch?v=…&list=…) is treated as a single video, not the whole list.
function playlistInfo(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    const isPlaylistPath = u.pathname === '/playlist';
    if (!list && !isPlaylistPath) return null;
    if (u.searchParams.get('v')) return null; // a chosen video inside a playlist
    if (!list) return null;
    return { id: list, expandable: !/^RD/.test(list) };
  } catch { return null; }
}

// Expand any playlist links among the tokens into individual video items,
// leaving plain video URLs untouched. Returns { items, playlistVideos, errors }.
async function resolvePlaylists(tokens) {
  const items = [];
  let playlistVideos = 0, playlistTotal = 0, playlistDupes = 0, errors = 0, truncated = false, blocked = false, capped = false;
  for (const url of tokens) {
    const pl = playlistInfo(url);
    if (!pl) { items.push(url); continue; }
    if (!pl.expandable) {
      errors++;
      showMsg('Mix/radio playlists cannot be expanded — skipped.', 'warn');
      continue;
    }
    showMsg('⏳ Expanding playlist…', 'warn');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'expandPlaylist', url });
      console.log('[playlist expand]', url, res && { count: res.count, total: res.total, dupes: res.dupes, truncated: res.truncated, blocked: res.blocked, contDbg: res.contDbg });
      if (res?.error) { errors++; showMsg(`Playlist: ${res.error}`, 'error'); continue; }
      const vids = res?.videos || [];
      const declared = res?.total ?? vids.length;
      items.push(...vids);
      playlistVideos += vids.length;
      playlistTotal += declared;
      playlistDupes += (res?.dupes || 0);
      if (res?.cappedAt) capped = true;
      if (res?.truncated) {
        truncated = true;
        if (res?.blocked) blocked = true;
        showMsg(`⏳ Playlist: loaded ${vids.length} of ${declared} videos…`, 'warn');
      } else {
        showMsg(`✅ Playlist: ${vids.length} videos detected`, 'ok');
      }
    } catch (e) {
      errors++;
      showMsg(`Playlist expansion failed: ${e.message || e}`, 'error');
    }
  }
  return { items, playlistVideos, playlistTotal, playlistDupes, errors, truncated, blocked, capped };
}

// Build the persistent top banner text for a playlist import.
function playlistBanner(imported, total, dupes, truncated, blocked, capped) {
  if (capped) {
    return { text: `⚠️ Imported the first ${imported} of ${total} videos — per-playlist import limit`, type: 'warn' };
  }
  if (!truncated || total <= imported) {
    // Loaded everything. If the playlist lists more entries than unique videos,
    // the extras are repeats we collapsed — explain the number, don't alarm.
    if (dupes > 0 && total > imported) {
      return { text: `✅ Imported ${imported} videos — the playlist's ${total} entries include ${dupes} duplicate${dupes === 1 ? '' : 's'}`, type: 'ok' };
    }
    return { text: `✅ Imported ${imported} videos from the playlist`, type: 'ok' };
  }
  if (blocked) {
    return { text: `⚠️ Imported ${imported} of ${total} playlist videos — YouTube blocked the rest (reload and retry to get more)`, type: 'warn' };
  }
  return { text: `ℹ️ Imported ${imported} of ${total} playlist videos — the other ${total - imported} are private, deleted or unavailable`, type: 'warn' };
}

async function addUrl() {
  const input = document.getElementById('url-input');
  const tokens = extractYouTubeUrls(input.value);
  if (tokens.length === 0) {
    showMsg('Please enter a valid YouTube URL.', 'error');
    return;
  }
  input.value = '';
  const { items, playlistVideos, playlistTotal, playlistDupes, truncated, blocked, capped } = await resolvePlaylists(tokens);
  if (items.length === 0) return;
  const { added, requeued } = await enqueueUrls(items);
  if (playlistVideos) {
    const short = truncated && playlistTotal > playlistVideos;
    const fromPlaylist = short
      ? `${playlistVideos} of ${playlistTotal} from playlist`
      : `${playlistVideos} from playlist`;
    showMsg(`✅ ${added} added${requeued ? `, ${requeued} re-queued` : ''} (${fromPlaylist})`, 'ok');
    const b = playlistBanner(playlistVideos, playlistTotal, playlistDupes, truncated, blocked, capped);
    showBanner(b.text, b.type);
  } else if (added + requeued === 0) {
    showMsg('Already in the queue.', 'warn');
  }
}

async function bulkAddUrls() {
  const ta = document.getElementById('bulk-input');
  const tokens = extractYouTubeUrls(ta.value);
  if (tokens.length === 0) {
    showMsg('No valid YouTube links found.', 'error');
    return;
  }
  const { items, playlistVideos, playlistTotal, playlistDupes, truncated, blocked, capped } = await resolvePlaylists(tokens);
  if (items.length === 0) { showMsg('No videos found.', 'error'); return; }
  const { added, requeued } = await enqueueUrls(items);
  ta.value = '';
  toggleBulkAdd(false);
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (requeued) parts.push(`${requeued} re-queued`);
  const short = truncated && playlistTotal > playlistVideos;
  if (playlistVideos) {
    parts.push(short
      ? `${playlistVideos} of ${playlistTotal} from playlist`
      : `${playlistVideos} from playlist`);
  }
  showMsg(parts.length ? `✅ ${parts.join(', ')}` : 'All links already in the queue.', parts.length ? 'ok' : 'warn');
  if (playlistVideos) {
    const b = playlistBanner(playlistVideos, playlistTotal, playlistDupes, truncated, blocked, capped);
    showBanner(b.text, b.type);
  }
}

function toggleBulkAdd(force) {
  const panel = document.getElementById('bulk-add');
  const btn = document.getElementById('btn-bulk-toggle');
  const show = force ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  btn.classList.toggle('active', show);
  if (show) document.getElementById('bulk-input').focus();
}

async function addCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || (!tab.url.includes('youtube.com/watch') && !tab.url.includes('youtu.be/') && !tab.url.includes('youtube.com/shorts/'))) {
    showMsg('Open a YouTube video in the current tab first.', 'error');
    return;
  }
  const existing = state.jobs.find(j => j.url === tab.url);
  if (existing) {
    if (existing.status === 'error') {
      existing.status = 'queued';
      existing.statusText = 'Queued';
      await chrome.storage.local.set({ jobs: state.jobs });
      renderJobs();
    }
    return;
  }
  const cleanTitle = tab.title ? tab.title.replace(/ - YouTube$/, '').trim() : null;
  state.jobs.push(makeJob(tab.url, cleanTitle || null));
  await chrome.storage.local.set({ jobs: state.jobs });
  renderJobs();
}

async function removeJob(id) {
  if (state.running) return;
  state.jobs = state.jobs.filter(j => j.id !== id);
  await chrome.storage.local.set({ jobs: state.jobs });
  renderJobs();
}

async function clearQueue() {
  if (state.running || state.jobs.length === 0) return;
  const n = state.jobs.length;
  if (!confirm(`Remove all ${n} video${n === 1 ? '' : 's'} from the queue?`)) return;
  state.jobs = [];
  await chrome.storage.local.set({ jobs: state.jobs });
  renderJobs();
  showBanner('');
  showMsg('Queue cleared.', 'ok');
}

// ── Batch ─────────────────────────────────────────────────────────────────────
async function startBatch() {
  const { apiKeys = {}, provider = 'anthropic' } =
    await chrome.storage.local.get(['apiKeys', 'provider']);

  let pending = state.jobs.filter(j => j.status === 'queued' || j.status === 'error');
  if (pending.length === 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtu.be/') || tab.url.includes('youtube.com/shorts/'))) {
      const cleanTitle = tab.title ? tab.title.replace(/ - YouTube$/, '').trim() : null;
      const newJob = makeJob(tab.url, cleanTitle || null);
      state.jobs.push(newJob);
      await chrome.storage.local.set({ jobs: state.jobs });
      renderJobs();
      pending = [newJob];
    } else {
      const msgEl = document.getElementById('btn-msg');
      if (msgEl) {
        msgEl.textContent = 'No videos queued for processing.';
        msgEl.classList.remove('hidden');
        setTimeout(() => msgEl.classList.add('hidden'), 3000);
      }
      return;
    }
  }

  await persistSettings();
  const {
    models = {}, customEndpointUrl, transcriptLang, customPrompt, mode,
    useThinking, autoPaste, autoSubmit, combinedPrompt, saveTranscriptFile, webDelay: storedDelay,
    includeTimestamps, timeStart, timeEnd
  } = await chrome.storage.local.get([
    'models', 'customEndpointUrl', 'transcriptLang', 'customPrompt', 'mode',
    'useThinking', 'autoPaste', 'autoSubmit', 'combinedPrompt', 'saveTranscriptFile', 'webDelay',
    'includeTimestamps', 'timeStart', 'timeEnd'
  ]);

  const globalFmt = [...document.querySelectorAll('.chip-fmt')].find(c => c.classList.contains('on'))?.dataset.fmt || 'chat';
  const globalLen = [...document.querySelectorAll('.chip-len')].find(c => c.classList.contains('on'))?.dataset.len || 'normal';
  const resolvedJobs = state.jobs.map(job => {
    if (job.prompt) return job;
    if (job.format != null || job.length != null) {
      const fmt = job.format ?? globalFmt;
      const len = job.length ?? globalLen;
      return { ...job, prompt: getPreset(transcriptLang || 'en', fmt, len) };
    }
    return { ...job, prompt: customPrompt || getPreset(transcriptLang || 'en', globalFmt, globalLen) };
  });

  const info          = PROVIDERS[provider] || PROVIDERS.anthropic;
  const currentApiKey = apiKeys[provider] || '';
  const currentModel  = models[provider] || info.defaultModel;
  const currentMode   = mode || 'web';

  if (currentMode === 'api' && !currentApiKey && provider !== 'custom') {
    showMsg(`API mode: set your ${info.name} API Key in Advanced Settings (⚙️) first.`, 'error');
    openPanel('panel-settings');
    return;
  }

  // A custom endpoint on an arbitrary host isn't covered by host_permissions, so
  // the fetch would die with an opaque CORS failure. Ask for the host up front.
  if (currentMode === 'api' && provider === 'custom') {
    if (!customEndpointUrl) {
      showMsg('Custom provider: set the endpoint URL in Advanced Settings (⚙️) first.', 'error');
      openPanel('panel-settings');
      return;
    }
    if (!await ensureHostPermission(customEndpointUrl)) {
      showMsg('Permission for the custom endpoint host was denied — cannot call it.', 'error');
      return;
    }
  }

  state.running = true;
  await chrome.storage.local.set({ running: true });
  setUIAsRunning();

  const p = ensurePort();
  if (!p) {
    showMsg('Unable to connect to background. Please reload the extension.', 'error');
    state.running = false;
    await chrome.storage.local.set({ running: false });
    setUIAsStopped();
    return;
  }

  p.postMessage({
    type: 'startBatch',
    jobs: resolvedJobs,
    settings: {
      provider,
      apiKey: currentApiKey,
      apiKeys,
      model: currentModel,
      customEndpointUrl: customEndpointUrl || '',
      prompt: customPrompt || getPreset(transcriptLang || 'en', globalFmt, globalLen),
      mode: currentMode,
      transcriptLang: transcriptLang || 'en',
      useThinking: !!useThinking,
      autoPaste: !!autoPaste,
      autoSubmit: !!autoSubmit,
      combinedPrompt: !!combinedPrompt,
      saveTranscriptFile: !!saveTranscriptFile,
      webDelay: storedDelay ?? 30,
      includeTimestamps: includeTimestamps !== false,
      timeStart: timeStart || '',
      timeEnd: timeEnd || ''
    }
  });
}

// Request the optional host permission for an arbitrary endpoint. Must be called
// from a user gesture, which is why it lives on the Start click path.
async function ensureHostPermission(endpointUrl) {
  let origin;
  try { origin = new URL(endpointUrl).origin + '/*'; } catch { return false; }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return true; // Firefox/older builds: let the request itself fail loudly instead
  }
}

async function fetchVideoTitle(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch { return null; }
}

async function resetBatch() {
  stopCountdown();
  state.jobs = state.jobs
    .filter(j => !j.cleared)
    .map(j => j.status === 'active' ? { ...j, status: 'error', statusText: '❌ Interrupted' } : j);
  await chrome.storage.local.set({ jobs: state.jobs, running: false, nextJobAt: null, nextJobId: null });

  const p = ensurePort();
  if (p) { try { p.postMessage({ type: 'resetState' }); } catch (_) {} }

  state.running = false;
  setUIAsStopped();
  renderJobs();
  showMsg('State reset. You can restart processing.', 'ok');
}
