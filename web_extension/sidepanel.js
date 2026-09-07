import { streamLLM } from './modules/llm-stream.js';
import { CONFIG, getPreset } from './modules/config.js';
import { parseMarkdown } from './modules/markdown.js';

let currentTabId = null;
let currentVideoId = null;
let abortController = null;

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url && tabs[0].url.includes('youtube.com/watch')) {
    currentTabId = tabs[0].id;
    await fetchVideoInfo();
    document.getElementById('btn-summarize').disabled = false;
  } else {
    document.getElementById('video-title').textContent = 'No active YouTube video';
  }

  document.getElementById('btn-summarize').addEventListener('click', startSummarization);
  document.getElementById('btn-stop').addEventListener('click', stopSummarization);
  document.getElementById('btn-copy').addEventListener('click', copySummary);
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-modal').addEventListener('click', closeSettingsModal);
  document.getElementById('modal-overlay').addEventListener('click', closeSettingsModal);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('modal-provider-select').addEventListener('change', updateHelpLink);

  document.getElementById('summary-output').addEventListener('click', (e) => {
    if (e.target.classList.contains('timestamp-link')) {
      e.preventDefault();
      const seconds = parseInt(e.target.dataset.time, 10);
      if (!isNaN(seconds) && currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'SEEK_TO', seconds });
      }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'YOUTUBE_NAVIGATED') {
      fetchVideoInfo().then(() => {
        checkCacheAndResetUI();
      });
    }
  });
}

async function checkCacheAndResetUI() {
  if (!currentVideoId) return;
  const key = `summary_cache_${currentVideoId}`;
  const data = await chrome.storage.local.get(key);
  const cached = data[key];

  const btnSum = document.getElementById('btn-summarize');
  const output = document.getElementById('summary-output');
  
  stopSummarization();
  
  if (cached) {
    btnSum.innerText = chrome.i18n.getMessage('btnRegenerate') || '🔄 Regenerate';
    output.innerHTML = parseMarkdown(cached);
    document.getElementById('btn-copy').disabled = false;
  } else {
    btnSum.innerText = chrome.i18n.getMessage('btnSummarize') || 'Summarize';
    output.innerHTML = '';
    document.getElementById('btn-copy').disabled = true;
  }
}

async function fetchVideoInfo() {
  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_VIDEO_INFO' });
    if (res && res.title) {
      document.getElementById('video-title').textContent = res.title;
      currentVideoId = res.videoId;
      await checkCacheAndResetUI();
    }
  } catch (err) {
    console.error('Could not fetch video info', err);
    document.getElementById('video-title').textContent = 'Error connecting to video page';
  }
}



async function startSummarization() {
  if (!currentVideoId || !currentTabId) return;

  const btnSum = document.getElementById('btn-summarize');
  const btnStop = document.getElementById('btn-stop');
  const output = document.getElementById('summary-output');
  const loader = document.getElementById('loading-indicator');
  
  btnSum.classList.add('hidden');
  btnStop.classList.remove('hidden');
  output.innerHTML = '';
  loader.classList.remove('hidden');
  document.getElementById('btn-copy').disabled = true;

  try {
    const bgRes = await chrome.runtime.sendMessage({
      type: 'GET_TRANSCRIPT',
      videoId: currentVideoId
    });

    if (bgRes && bgRes.error) {
      throw new Error(bgRes.error);
    }
    if (!bgRes || !bgRes.transcript) {
      throw new Error('No transcript received from background');
    }

    const transcriptText = bgRes.transcript;

    const stored = await chrome.storage.local.get([
      'provider', 'apiKeys', 'models', 'customEndpointUrl', 
      'transcriptLang', 'outputFormat', 'summaryLength', 'customPrompt'
    ]);
    
    const provider = stored.provider || 'gemini';
    const apiKey = stored.apiKeys?.[provider];
    
    if (provider !== 'custom' && (!apiKey || apiKey.trim() === '')) {
      const msg = chrome.i18n.getMessage('sidepanelMissingKey') || '👋 To summarize in the Side Panel, please enter an API key...';
      output.innerHTML = `<p>${msg}</p>`;
      openSettingsModal();
      loader.classList.add('hidden');
      btnStop.classList.add('hidden');
      btnSum.classList.remove('hidden');
      return;
    }

    const config = {
      provider,
      model: stored.models?.[provider],
      apiKey: apiKey,
      endpoint: stored.customEndpointUrl
    };

    const lang = stored.transcriptLang || 'en';
    const fmt = stored.outputFormat || 'chat';
    const len = stored.summaryLength || 'normal';
    const instructions = stored.customPrompt || getPreset(lang, fmt, len);

    const fullPrompt = `${instructions}\n\nTranscript:\n${transcriptText}`;

    let rawMarkdown = '';
    abortController = new AbortController();

    await streamLLM(fullPrompt, config, (chunk) => {
      if (abortController.signal.aborted) return;
      rawMarkdown += chunk;
      
      let html = parseMarkdown(rawMarkdown);
      
      output.innerHTML = html;
      
      const contentArea = document.getElementById('content-area');
      contentArea.scrollTop = contentArea.scrollHeight;
    });

    await chrome.storage.local.set({ [`summary_cache_${currentVideoId}`]: rawMarkdown });

  } catch (err) {
    output.innerHTML = `<p style="color:var(--danger)">Error: ${err.message}</p>`;
  } finally {
    loader.classList.add('hidden');
    btnStop.classList.add('hidden');
    btnSum.classList.remove('hidden');
    document.getElementById('btn-copy').disabled = false;
    abortController = null;
  }
}

function stopSummarization() {
  if (abortController) {
    abortController.abort();
    abortController = null;
    document.getElementById('loading-indicator').classList.add('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    document.getElementById('btn-summarize').classList.remove('hidden');
    document.getElementById('btn-copy').disabled = false;
  }
}

function copySummary() {
  const text = document.getElementById('summary-output').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy');
    const orig = btn.innerHTML;
    btn.innerHTML = chrome.i18n.getMessage('copied') || '✅ Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
}

async function openSettingsModal() {
  const stored = await chrome.storage.local.get(['provider', 'apiKeys']);
  const provider = stored.provider || 'gemini';
  const apiKeys = stored.apiKeys || {};
  
  document.getElementById('modal-provider-select').value = provider;
  document.getElementById('modal-api-key').value = apiKeys[provider] || '';
  
  updateHelpLink();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function updateHelpLink() {
  const provider = document.getElementById('modal-provider-select').value;
  const link = document.getElementById('modal-help-link');
  if (provider === 'gemini') {
    link.href = 'https://aistudio.google.com/app/apikey';
    link.textContent = chrome.i18n.getMessage('helpGemini') || 'Ottieni chiave gratis su Google AI Studio ↗';
    link.style.display = 'block';
  } else if (provider === 'groq') {
    link.href = 'https://console.groq.com/keys';
    link.textContent = chrome.i18n.getMessage('helpGroq') || 'Ottieni chiave gratis su GroqCloud ↗';
    link.style.display = 'block';
  } else if (provider === 'anthropic') {
    link.href = 'https://console.anthropic.com/settings/keys';
    link.textContent = chrome.i18n.getMessage('helpAnthropic') || 'Ottieni chiave su Anthropic Console ↗';
    link.style.display = 'block';
  } else if (provider === 'openai') {
    link.href = 'https://platform.openai.com/api-keys';
    link.textContent = chrome.i18n.getMessage('helpOpenai') || 'Ottieni chiave su OpenAI Platform ↗';
    link.style.display = 'block';
  } else {
    link.style.display = 'none';
  }
  
  chrome.storage.local.get(['apiKeys']).then(stored => {
    const apiKeys = stored.apiKeys || {};
    document.getElementById('modal-api-key').value = apiKeys[provider] || '';
  });
}

async function saveSettings() {
  const provider = document.getElementById('modal-provider-select').value;
  const key = document.getElementById('modal-api-key').value.trim();
  
  const stored = await chrome.storage.local.get(['apiKeys']);
  const apiKeys = stored.apiKeys || {};
  if (key) {
    apiKeys[provider] = key;
  }
  
  await chrome.storage.local.set({ provider, apiKeys });
  closeSettingsModal();
}

document.addEventListener('DOMContentLoaded', init);
