// ── sidepanel.js — summarize the video in the active tab, live ───────────────
// Runs as Chrome's side panel and as Firefox's sidebar (same page). It follows
// the active tab of its own window, streams the summary as it is written, and
// turns every [m:ss] in it into a link that seeks the player.
import { streamLLM, PROVIDER_LABELS } from './modules/llm-stream.js';
import { PROVIDERS, getPreset, initPrompts, resolveModel, timestampNote } from './modules/config.js';
import { hasTimestamps } from './modules/transcript-parse.js';
import { parseMarkdown } from './modules/markdown.js';
import { safeFilename } from './modules/downloads.js';

const $ = (id) => document.getElementById(id);
const t = (key, fallback, subs) => chrome.i18n.getMessage(key, subs) || fallback;

const CACHE_PREFIX = 'summary_cache_';
const CACHE_INDEX = 'summaryCacheIndex';
const CACHE_MAX = 100;

const state = {
  windowId: null,
  tabId: null,
  videoId: null,
  title: '',
  markdown: '',      // raw text of what is on screen (copy/download use this)
  controller: null,  // AbortController of the running summary
  settings: {},      // mirror of storage, so click handlers need no await
};

// ── settings mirror ──────────────────────────────────────────────────────────
const SETTING_KEYS = ['provider', 'apiKeys', 'models', 'customEndpointUrl', 'transcriptLang',
  'outputFormat', 'summaryLength', 'customPrompt', 'useThinking', 'includeTimestamps'];

async function loadSettings() {
  state.settings = await chrome.storage.local.get(SETTING_KEYS);
}

function currentConfig() {
  const s = state.settings;
  const provider = PROVIDERS[s.provider] ? s.provider : 'gemini';
  return {
    provider,
    model: resolveModel(provider, s.models?.[provider]),
    apiKey: (s.apiKeys?.[provider] || '').trim(),
    endpoint: s.customEndpointUrl || '',
    useThinking: !!s.useThinking,
  };
}

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([initPrompts(), loadSettings()]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of SETTING_KEYS) if (k in changes) state.settings[k] = changes[k].newValue;
  });

  try { state.windowId = (await chrome.windows.getCurrent()).id; } catch { /* sidebar: any window */ }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await handleTab(tab);

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (state.windowId != null && windowId !== state.windowId) return;
    handleTab(await chrome.tabs.get(tabId).catch(() => null));
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active || (state.windowId != null && tab.windowId !== state.windowId)) return;
    // YouTube is a single-page app: the URL changes first, the title a moment
    // later. React to both so the header never shows the previous video.
    if (changeInfo.url || (changeInfo.title && tabId === state.tabId)) handleTab(tab);
  });

  $('btn-summarize').addEventListener('click', startSummarization);
  $('btn-stop').addEventListener('click', stopSummarization);
  $('btn-copy').addEventListener('click', copySummary);
  $('btn-download').addEventListener('click', downloadSummary);
  $('btn-settings').addEventListener('click', openSettingsModal);
  $('btn-close-modal').addEventListener('click', closeSettingsModal);
  $('modal-overlay').addEventListener('click', closeSettingsModal);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('modal-provider-select').addEventListener('change', () => fillProviderFields($('modal-provider-select').value));

  $('summary-output').addEventListener('click', (e) => {
    const link = e.target.closest('.timestamp-link');
    if (!link) return;
    e.preventDefault();
    const seconds = Number(link.dataset.time);
    if (Number.isFinite(seconds) && state.tabId != null) seekTo(state.tabId, seconds);
  });
}

// The content script only exists in tabs loaded after the extension was
// installed or updated; for an older tab, inject the same two lines directly.
function seekTo(tabId, seconds) {
  chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', seconds }).catch(() =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: (s) => {
        const v = document.querySelector('video');
        if (v) { v.currentTime = s; if (v.paused) v.play().catch(() => {}); }
      },
      args: [seconds],
    }).catch(() => {}));
}

// ── active tab tracking ──────────────────────────────────────────────────────
function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function handleTab(tab) {
  const videoId = tab?.url ? videoIdFromUrl(tab.url) : null;
  if (!videoId) {
    if (state.controller) return; // keep a running summary on screen
    state.tabId = tab?.id ?? null;
    state.videoId = null;
    setHeader(t('noVideoDetected', 'No video detected'), t('openVideoToSummarize', 'Open a YouTube video to summarize'));
    $('btn-summarize').disabled = true;
    showMarkdown('');
    showEmpty(t('openVideoToSummarize', 'Open a YouTube video to summarize'));
    return;
  }

  // Same video, only the title changed: update the header, keep everything else.
  if (videoId === state.videoId && tab.id === state.tabId) {
    const title = cleanTitle(tab.title);
    if (title) { state.title = title; $('video-title').textContent = title; }
    return;
  }

  if (state.controller) stopSummarization();
  state.tabId = tab.id;
  state.videoId = videoId;
  state.title = cleanTitle(tab.title) || videoId;
  setHeader(state.title, '');
  $('btn-summarize').disabled = false;
  await showCached();
}

// Tab titles read "(3) Video name - YouTube" — the notification count and the
// suffix are not part of the name.
function cleanTitle(title) {
  return String(title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
}

function setHeader(title, status) {
  $('video-title').textContent = title;
  $('video-title').title = title;
  $('video-status').textContent = status || '';
}

// ── cache ────────────────────────────────────────────────────────────────────
async function readCache(videoId) {
  const key = CACHE_PREFIX + videoId;
  const v = (await chrome.storage.local.get(key))[key];
  if (!v) return null;
  return typeof v === 'string' ? { text: v } : v; // older versions stored the bare string
}

async function writeCache(videoId, entry) {
  const { [CACHE_INDEX]: index = [] } = await chrome.storage.local.get(CACHE_INDEX);
  const next = [videoId, ...index.filter((id) => id !== videoId)];
  const evicted = next.splice(CACHE_MAX);
  await chrome.storage.local.set({ [CACHE_PREFIX + videoId]: entry, [CACHE_INDEX]: next });
  if (evicted.length) await chrome.storage.local.remove(evicted.map((id) => CACHE_PREFIX + id));
}

async function showCached() {
  const cached = state.videoId ? await readCache(state.videoId) : null;
  if (cached?.text) {
    showMarkdown(cached.text);
    $('btn-summarize').textContent = t('btnRegenerate', '🔄 Regenerate');
    const when = cached.ts ? new Date(cached.ts).toLocaleString() : '';
    $('video-status').textContent = [cached.model, when].filter(Boolean).join(' · ');
  } else {
    showMarkdown('');
    $('btn-summarize').textContent = t('btnSummarize', 'Summarize');
  }
}

// ── rendering ────────────────────────────────────────────────────────────────
let renderQueued = false;
function showMarkdown(md, { live = false } = {}) {
  state.markdown = md;
  $('btn-copy').disabled = !md;
  $('btn-download').disabled = !md;
  if (!live) { renderNow(); return; }
  // Re-parsing on every token is quadratic on a long summary; once per frame
  // is plenty for the eye.
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(true); });
}

function renderNow(follow = false) {
  const area = $('content-area');
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
  // parseMarkdown escapes every piece of model text before adding tags; going
  // through DOMParser (an inert document — no scripts run) rather than
  // innerHTML keeps that guarantee explicit for store reviewers too.
  const doc = new DOMParser().parseFromString(parseMarkdown(state.markdown), 'text/html');
  $('summary-output').replaceChildren(...doc.body.childNodes);
  // Follow the text only if the reader has not scrolled up to read.
  if (follow && atBottom) area.scrollTop = area.scrollHeight;
}

function showEmpty(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = text;
  $('summary-output').replaceChildren(div);
}

function showNotice(text, kind = 'info') {
  const div = document.createElement('div');
  div.className = `notice notice-${kind}`;
  div.textContent = text;
  $('summary-output').prepend(div);
}

function setBusy(busy) {
  $('btn-summarize').classList.toggle('hidden', busy);
  $('btn-stop').classList.toggle('hidden', !busy);
  $('loading-indicator').classList.toggle('hidden', !busy);
}

// ── summarize ────────────────────────────────────────────────────────────────
async function startSummarization() {
  if (!state.videoId || state.controller) return;
  const config = currentConfig();
  const label = PROVIDER_LABELS[config.provider] || config.provider;

  if (config.provider !== 'custom' && !config.apiKey) {
    showMarkdown('');
    showEmpty(t('sidepanelMissingKey', '👋 Enter an API key to summarize here, or use the free Web mode from the popup.'));
    openSettingsModal();
    return;
  }
  if (config.provider === 'custom') {
    if (!config.endpoint) { openSettingsModal(); return; }
    // Must be the first call in the click handler: permission prompts need the
    // user gesture, which an earlier await would have used up.
    if (!await ensureHostPermission(config.endpoint)) {
      showEmpty(t('sidepanelPermissionDenied', 'Permission for the custom endpoint was denied.'));
      return;
    }
  }

  const videoId = state.videoId;
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  showMarkdown('');
  $('loading-text').textContent = t('fetchingTranscript', 'Fetching transcript…');

  let text = '';
  try {
    const s = state.settings;
    const lang = s.transcriptLang || 'auto';
    const res = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPT', videoId, lang });
    if (controller.signal.aborted) return;
    if (!res?.transcript) {
      throw new Error(res?.error === 'noTranscript' || !res?.error
        ? t('noTranscript', 'This video has no captions, so there is no transcript to summarize.')
        : res.error);
    }
    if (res.title) { state.title = res.title; $('video-title').textContent = res.title; }

    const promptLang = lang === 'auto' ? (res.lang || 'en').split('-')[0] : lang;
    let prompt = s.customPrompt || getPreset(promptLang, s.outputFormat || 'md', s.summaryLength || 'normal');
    if (hasTimestamps(res.transcript) && s.includeTimestamps !== false) prompt += `\n\n${timestampNote(promptLang)}`;

    $('loading-text').textContent = t('generatingSummary', 'Generating summary…');
    $('video-status').textContent = `${label} · ${config.model}`;

    const result = await streamLLM(`${prompt}\n\n---\n\n${res.transcript}`, config, (chunk) => {
      text += chunk;
      showMarkdown(text, { live: true });
    }, { signal: controller.signal });

    showMarkdown(result.text);
    if (res.complete === false) {
      showNotice(t('partialTranscript', `⚠️ The captions only cover about ${res.coverage} of the video.`, [String(res.coverage)]), 'warn');
    }
    if (result.truncated) showNotice(t('outputTruncated', '⚠️ The model hit its output limit — the summary ends abruptly.'), 'warn');
    await writeCache(videoId, { text: result.text, model: config.model, ts: Date.now() });
    if (state.videoId === videoId) $('btn-summarize').textContent = t('btnRegenerate', '🔄 Regenerate');
  } catch (err) {
    if (err?.aborted || controller.signal.aborted) {
      // Keep what was written so far; it is not cached, so a reopen starts clean.
      if (text) showNotice(t('summaryStopped', '⏹ Stopped — this summary is incomplete.'), 'warn');
    } else {
      if (!text) showMarkdown('');
      showNotice(`${t('errorPrefix', 'Error')}: ${err?.message || err}`, 'error');
    }
  } finally {
    if (state.controller === controller) state.controller = null;
    setBusy(false);
  }
}

function stopSummarization() {
  state.controller?.abort();
}

async function ensureHostPermission(endpointUrl) {
  let origin;
  try { origin = new URL(endpointUrl).origin + '/*'; } catch { return false; }
  try {
    const request = chrome.permissions.request({ origins: [origin] });
    return await request;
  } catch {
    return true; // let the request itself fail loudly instead
  }
}

// ── copy / download ──────────────────────────────────────────────────────────
async function copySummary() {
  if (!state.markdown) return;
  await navigator.clipboard.writeText(state.markdown);
  const btn = $('btn-copy');
  const orig = btn.textContent;
  btn.textContent = t('copied', '✅ Copied!');
  setTimeout(() => { btn.textContent = orig; }, 2000);
}

function downloadSummary() {
  if (!state.markdown) return;
  const body = `# ${state.title}\n\nhttps://www.youtube.com/watch?v=${state.videoId}\n\n${state.markdown}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
  chrome.downloads.download({ url, filename: safeFilename(state.title, state.videoId, { ext: 'md' }), saveAs: false })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}

// ── settings modal ───────────────────────────────────────────────────────────
const HELP_LINKS = {
  gemini:     ['https://aistudio.google.com/app/apikey', 'helpGemini', 'Get a free key on Google AI Studio ↗'],
  groq:       ['https://console.groq.com/keys', 'helpGroq', 'Get a free key on GroqCloud ↗'],
  anthropic:  ['https://console.anthropic.com/settings/keys', 'helpAnthropic', 'Get a key on the Anthropic Console ↗'],
  openai:     ['https://platform.openai.com/api-keys', 'helpOpenai', 'Get a key on the OpenAI Platform ↗'],
  openrouter: ['https://openrouter.ai/settings/keys', 'helpOpenrouter', 'Get a key on OpenRouter ↗'],
};

function fillProviderFields(provider) {
  const s = state.settings;
  const info = PROVIDERS[provider];
  $('modal-api-key').value = s.apiKeys?.[provider] || '';
  $('modal-api-key').placeholder = info?.apiKeyPlaceholder || '';
  $('modal-model').value = resolveModel(provider, s.models?.[provider]);
  $('modal-model-list').replaceChildren(...(info?.models || []).map((m) => {
    const o = document.createElement('option');
    o.value = m.value;
    o.label = m.label;
    return o;
  }));
  $('field-endpoint').classList.toggle('hidden', provider !== 'custom');
  $('modal-endpoint').value = s.customEndpointUrl || '';
  const link = $('modal-help-link');
  const help = HELP_LINKS[provider];
  link.classList.toggle('hidden', !help);
  if (help) { link.href = help[0]; link.textContent = t(help[1], help[2]); }
}

function openSettingsModal() {
  const provider = currentConfig().provider;
  $('modal-provider-select').value = provider;
  fillProviderFields(provider);
  $('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
  $('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const provider = $('modal-provider-select').value;
  const { apiKeys = {}, models = {} } = await chrome.storage.local.get(['apiKeys', 'models']);
  const patch = {
    provider,
    apiKeys: { ...apiKeys, [provider]: $('modal-api-key').value.trim() },
    models: { ...models, [provider]: $('modal-model').value.trim() || PROVIDERS[provider]?.defaultModel || '' },
  };
  if (provider === 'custom') patch.customEndpointUrl = $('modal-endpoint').value.trim();
  await chrome.storage.local.set(patch);
  Object.assign(state.settings, patch);
  closeSettingsModal();
}

document.addEventListener('DOMContentLoaded', init);
