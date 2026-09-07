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
  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('summary-output').addEventListener('click', (e) => {
    if (e.target.classList.contains('timestamp-link')) {
      e.preventDefault();
      const seconds = parseInt(e.target.dataset.time, 10);
      if (!isNaN(seconds) && currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'SEEK_TO', seconds });
      }
    }
  });
}

async function fetchVideoInfo() {
  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_VIDEO_INFO' });
    if (res && res.title) {
      document.getElementById('video-title').textContent = res.title;
      currentVideoId = res.videoId;
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
    
    const provider = stored.provider || 'anthropic';
    const config = {
      provider,
      model: stored.models?.[provider],
      apiKey: stored.apiKeys?.[provider],
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
    btn.innerHTML = '✅ Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', init);
