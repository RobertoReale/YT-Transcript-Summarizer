import { state } from './popup-state.js';
import { escHtml } from './ui-utils.js';
import { CONFIG, getPreset, isPreset, PROVIDERS } from './config.js';

function shortUrl(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return v ? `youtu.be/${v}` : url.replace(/^https?:\/\//, '').slice(0, 42);
  } catch { return url.slice(0, 42); }
}

// ── UI State ──────────────────────────────────────────────────────────────────
export function setUIAsRunning() {
  document.getElementById('btn-run').disabled = true;
  document.getElementById('btn-run').textContent = '⏳ Processing...';
  document.getElementById('btn-reset').classList.remove('hidden');
  document.getElementById('progress-wrap').classList.remove('hidden');
  updateProgress();
}

export function setUIAsStopped() {
  document.getElementById('btn-run').disabled = false;
  document.getElementById('btn-run').textContent = '▶ START PROCESSING';
  document.getElementById('btn-reset').classList.add('hidden');
  document.getElementById('progress-wrap').classList.add('hidden');
}

// ── Mode & Chips ──────────────────────────────────────────────────────────────
export function setMode(mode) {
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode)
  );
  document.getElementById('mode-select').value = mode;
  updateChipsForMode(mode);
}

export function updateChipsForMode(mode) {
  const isTranscript = mode === 'transcript';
  const info = PROVIDERS[state.currentProvider] || PROVIDERS.anthropic;

  document.getElementById('chip-autopaste').classList.toggle('hidden', mode !== 'web');
  document.getElementById('chip-autosubmit').classList.toggle('hidden', mode !== 'web');
  document.getElementById('chip-save-file').classList.toggle('hidden', mode !== 'web');
  document.getElementById('chip-timestamps').classList.toggle('hidden', isTranscript);
  document.getElementById('chip-thinking').classList.toggle('hidden',
    mode !== 'api' || !info.supportsThinking);

  document.getElementById('chip-fmt-chat').classList.toggle('hidden', isTranscript);
  document.getElementById('chip-fmt-md').classList.toggle('hidden', isTranscript);
  document.getElementById('chip-len-short').classList.toggle('hidden', isTranscript);
  document.getElementById('chip-len-normal').classList.toggle('hidden', isTranscript);
  document.getElementById('chip-len-long').classList.toggle('hidden', isTranscript);
  document.getElementById('prompt-section').classList.toggle('hidden', isTranscript);
}

export function setChip(chipId, on) {
  const chip = document.getElementById(chipId);
  if (!chip) return;
  chip.classList.toggle('on', on);
  const cbId = chip.dataset.cb;
  if (cbId) document.getElementById(cbId).checked = on;
}

export function setOutputFormat(fmt) {
  document.getElementById('chip-fmt-chat').classList.toggle('on', fmt === 'chat');
  document.getElementById('chip-fmt-md').classList.toggle('on', fmt === 'md');
}

export function setSummaryLength(len) {
  document.getElementById('chip-len-short').classList.toggle('on', len === 'short');
  document.getElementById('chip-len-normal').classList.toggle('on', len === 'normal');
  document.getElementById('chip-len-long').classList.toggle('on', len === 'long');
}

// ── Transcript splitting (Feature stubbed out in backend) ─────────────────
// Split logic removed.



// ── Per-job settings ──────────────────────────────────────────────────────────
export function toggleJobSettings(id) {
  const el = document.getElementById(`job-settings-${id}`);
  if (el) el.classList.toggle('hidden');
}

function jobHasCustom(job) {
  return !!job.prompt || (job.format != null) || (job.length != null) || (job.lang != null) || !!job.timeStart || !!job.timeEnd;
}

export function updateJobEditBtn(id, job) {
  const btn = document.querySelector(`.job-edit-btn[data-job-id="${id}"]`);
  if (!btn) return;
  const hasCustom = jobHasCustom(job);
  btn.classList.toggle('has-custom', hasCustom);
  btn.title = hasCustom ? 'Custom settings active — click to edit' : 'Customize settings for this video';
  const resetBtn = document.querySelector(`.job-reset-btn[data-job-id="${id}"]`);
  if (resetBtn) resetBtn.classList.toggle('hidden', !hasCustom);
}

export async function setJobFormat(id, fmt) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.format = fmt;
  const len = job.length ?? ([...document.querySelectorAll('.chip-len')].find(c => c.classList.contains('on'))?.dataset.len || 'normal');
  const { transcriptLang: lang } = await chrome.storage.local.get('transcriptLang');
  const preset = getPreset(lang || 'en', fmt, len);
  if (!job.prompt || isPreset(job.prompt)) {
    job.prompt = preset;
    const ta = document.querySelector(`.job-prompt-input[data-job-id="${id}"]`);
    if (ta) ta.value = preset;
  }
  document.querySelectorAll(`.job-chip-fmt[data-job-id="${id}"]`).forEach(c =>
    c.classList.toggle('on', c.dataset.fmt === fmt)
  );
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

export async function setJobLength(id, len) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.length = len;
  const fmt = job.format ?? ([...document.querySelectorAll('.chip-fmt')].find(c => c.classList.contains('on'))?.dataset.fmt || 'chat');
  const { transcriptLang: globalLang } = await chrome.storage.local.get('transcriptLang');
  const effectiveLang = job.lang || globalLang || 'en';
  const preset = getPreset(effectiveLang, fmt, len);
  if (!job.prompt || isPreset(job.prompt)) {
    job.prompt = preset;
    const ta = document.querySelector(`.job-prompt-input[data-job-id="${id}"]`);
    if (ta) ta.value = preset;
  }
  document.querySelectorAll(`.job-chip-len[data-job-id="${id}"]`).forEach(c =>
    c.classList.toggle('on', c.dataset.len === len)
  );
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

export async function setJobSplit(id, parts) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.split = parts; // null means "use the value chosen for the whole run"
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

export async function setJobTimeStart(id, val) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.timeStart = val || null;
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

export async function setJobTimeEnd(id, val) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.timeEnd = val || null;
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

export async function resetJobSettings(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.format = null;
  job.length = null;
  job.lang = null;
  job.prompt = null;
  job.split = null;
  job.timeStart = null;
  job.timeEnd = null;
  await chrome.storage.local.set({ jobs: state.jobs });
  renderJobs();
  const el = document.getElementById(`job-settings-${id}`);
  if (el) el.classList.remove('hidden');
}

export async function setJobLang(id, lang) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.lang = lang || null; // null means "use global"
  // Regenerate preset with the new lang
  const fmt = job.format ?? ([...document.querySelectorAll('.chip-fmt')].find(c => c.classList.contains('on'))?.dataset.fmt || 'chat');
  const len = job.length ?? ([...document.querySelectorAll('.chip-len')].find(c => c.classList.contains('on'))?.dataset.len || 'normal');
  const { transcriptLang: globalLang } = await chrome.storage.local.get('transcriptLang');
  const effectiveLang = lang || globalLang || 'en';
  const preset = getPreset(effectiveLang, fmt, len);
  if (!job.prompt || isPreset(job.prompt)) {
    job.prompt = preset;
    const ta = document.querySelector(`.job-prompt-input[data-job-id="${id}"]`);
    if (ta) ta.value = preset;
  }
  updateJobEditBtn(id, job);
  await chrome.storage.local.set({ jobs: state.jobs });
}

// ── Job Rendering ─────────────────────────────────────────────────────────────
export function renderJobs() {
  const clearBtn = document.getElementById('btn-clear-queue');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', state.jobs.filter(j => !j.cleared).length === 0);
    clearBtn.disabled = state.running;
  }
  const list = document.getElementById('job-list');
  const visibleJobs = state.jobs.filter(j => !j.cleared);
  if (visibleJobs.length === 0) {
    list.innerHTML = '<div class="empty-state">Add a URL or open a YouTube video and click 📌<span class="empty-hint">Hover the mode tabs above for a description of each mode</span></div>';
    return;
  }

  const mode = document.getElementById('mode-select').value;
  const isTranscript = mode === 'transcript';
  const globalFmt = [...document.querySelectorAll('.chip-fmt')].find(c => c.classList.contains('on'))?.dataset.fmt || 'chat';
  const globalLen = document.querySelector('.chip-len.on')?.dataset.len || 'normal';
  const dis = state.running ? 'disabled' : '';

  list.innerHTML = visibleJobs.map(j => {
    const hasCustom = jobHasCustom(j);
    const activeFmt = j.format ?? globalFmt;
    const activeLen = j.length ?? globalLen;

    const chipsHtml = isTranscript ? '' : `
      <div class="job-chips-row">
        <button class="chip chip-sm job-chip-fmt${activeFmt === 'chat' ? ' on' : ''}" data-job-id="${j.id}" data-fmt="chat" ${dis}>💬 Chat</button>
        <button class="chip chip-sm job-chip-fmt${activeFmt === 'md'   ? ' on' : ''}" data-job-id="${j.id}" data-fmt="md"   ${dis}>📄 .md</button>
        <span class="chips-sep"></span>
        <button class="chip chip-sm job-chip-len${activeLen === 'short'  ? ' on' : ''}" data-job-id="${j.id}" data-len="short"  ${dis}>📝 Short</button>
        <button class="chip chip-sm job-chip-len${activeLen === 'normal' ? ' on' : ''}" data-job-id="${j.id}" data-len="normal" ${dis}>📄 Normal</button>
        <button class="chip chip-sm job-chip-len${activeLen === 'long'   ? ' on' : ''}" data-job-id="${j.id}" data-len="long"   ${dis}>📖 Long</button>
        <button class="job-reset-btn${hasCustom ? '' : ' hidden'}" data-job-id="${j.id}" ${dis} title="Reset to global settings">↺ reset</button>
      </div>
      <div class="job-lang-row">
        <span class="job-lang-label">🌐 Lang</span>
        <select class="job-lang-select" data-job-id="${j.id}" ${dis}>
          <option value="" ${!j.lang ? 'selected' : ''}>🔗 Global</option>
          <option value="en" ${j.lang === 'en' ? 'selected' : ''}>🇬🇧 EN</option>
          <option value="it" ${j.lang === 'it' ? 'selected' : ''}>🇮🇹 IT</option>
          <option value="es" ${j.lang === 'es' ? 'selected' : ''}>🇪🇸 ES</option>
          <option value="fr" ${j.lang === 'fr' ? 'selected' : ''}>🇫🇷 FR</option>
          <option value="de" ${j.lang === 'de' ? 'selected' : ''}>🇩🇪 DE</option>
          <option value="pt" ${j.lang === 'pt' ? 'selected' : ''}>🇵🇹 PT</option>
          <option value="zh" ${j.lang === 'zh' ? 'selected' : ''}>🇨🇳 ZH</option>
          <option value="ja" ${j.lang === 'ja' ? 'selected' : ''}>🇯🇵 JA</option>
          <option value="ko" ${j.lang === 'ko' ? 'selected' : ''}>🇰🇷 KO</option>
          <option value="ar" ${j.lang === 'ar' ? 'selected' : ''}>🇸🇦 AR</option>
          <option value="ru" ${j.lang === 'ru' ? 'selected' : ''}>🇷🇺 RU</option>
          <option value="nl" ${j.lang === 'nl' ? 'selected' : ''}>🇳🇱 NL</option>
          <option value="pl" ${j.lang === 'pl' ? 'selected' : ''}>🇵🇱 PL</option>
          <option value="tr" ${j.lang === 'tr' ? 'selected' : ''}>🇹🇷 TR</option>
          <option value="hi" ${j.lang === 'hi' ? 'selected' : ''}>🇮🇳 HI</option>
          <option value="auto" ${j.lang === 'auto' ? 'selected' : ''}>🌐 Auto</option>
        </select>
      </div>
      <div class="job-time-row" style="margin-top: 8px;">
        <div class="row-input">
          <input type="text" class="job-time-input" data-job-id="${j.id}" data-time-type="start" placeholder="Start time (e.g. 05:00)" value="${escHtml(j.timeStart || '')}" autocomplete="off" ${dis}>
          <input type="text" class="job-time-input" data-job-id="${j.id}" data-time-type="end" placeholder="End time (e.g. 10:00)" value="${escHtml(j.timeEnd || '')}" autocomplete="off" ${dis}>
        </div>
      </div>`;

    return `
    <div class="job-entry" id="job-entry-${j.id}">
      <div class="job-item status-${j.status}" id="job-${j.id}">
        <div class="job-info">
          <div class="job-title${j.title ? '' : ' loading'}" data-job-id="${j.id}" title="${escHtml(j.url)}">${escHtml(j.title || shortUrl(j.url))}</div>
          <div class="job-status ${j.status}" title="${escHtml(j.statusText)}">${escHtml(j.statusText)}</div>
        </div>
        <button class="job-edit-btn${hasCustom ? ' has-custom' : ''}" data-job-id="${j.id}" ${dis} title="${hasCustom ? 'Custom settings active — click to edit' : 'Customize settings for this video'}">✎</button>
        <button class="job-remove" data-job-id="${j.id}" ${dis} title="Remove">✕</button>
      </div>
      <div class="job-settings-panel hidden" id="job-settings-${j.id}">
        ${chipsHtml}
        <textarea class="job-prompt-input" data-job-id="${j.id}" placeholder="Custom prompt (leave empty to use global)…" rows="2">${j.prompt ? escHtml(j.prompt) : ''}</textarea>
      </div>
    </div>`;
  }).join('');
}

export function updateJob(id, status, statusText) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  job.status = status;
  job.statusText = statusText;
  const el = document.getElementById(`job-${id}`);
  if (el) {
    el.className = `job-item status-${status}`;
    el.querySelector('.job-status').className = `job-status ${status}`;
    el.querySelector('.job-status').textContent = statusText;
    el.querySelector('.job-status').title = statusText;
  }
  updateProgress();
  if (status === 'done') scheduleJobAutoClear(id);
}

export function updateProgress() {
  const done  = state.jobs.filter(j => j.status === 'done' || j.status === 'error' || j.status === 'unavailable').length;
  const total = state.jobs.length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `${done}/${total}`;
}

// Fade a finished job out of the list. It is only *flagged*, never spliced out
// of the stored array while a batch is running: the background addresses jobs by
// id and rewrites the same array, so deleting entries here used to make status
// updates land on nothing (and, with the old index-based resume, made the runner
// skip the next video entirely). finalizeBatch() drops the flagged ones.
export function scheduleJobAutoClear(id) {
  setTimeout(async () => {
    const job = state.jobs.find(j => j.id === id);
    if (!job) return;
    job.cleared = true;
    if (!state.running) {
      state.jobs = state.jobs.filter(j => !j.cleared);
    }
    await chrome.storage.local.set({ jobs: state.jobs });

    const entry = document.getElementById(`job-entry-${id}`);
    const visible = state.jobs.filter(j => !j.cleared).length;
    if (entry) {
      entry.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      entry.style.opacity = '0';
      entry.style.transform = 'translateX(24px)';
      setTimeout(() => {
        entry.remove();
        if (visible === 0) renderJobs();
      }, 500);
    } else if (visible === 0) {
      renderJobs();
    }
  }, 3000);
}
