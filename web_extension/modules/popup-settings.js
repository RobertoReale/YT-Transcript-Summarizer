import { state } from './popup-state.js';
import { CONFIG, PROVIDERS } from './config.js';
import { escHtml } from './ui-utils.js';
import { setMode, updateChipsForMode } from './popup-render.js';

export async function applyProvider(provider, apiKeys = {}, models = {}, customEndpointUrl = '') {
  state.currentProvider = provider;
  const info = PROVIDERS[provider] || PROVIDERS.anthropic;

  document.getElementById('provider-select').value = provider;
  document.querySelectorAll('.provider-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.provider === provider)
  );

  document.getElementById('api-key-label').innerHTML =
    `🔑 ${info.apiKeyLabel} <span class="label-note">— required for API mode</span>`;
  document.getElementById('api-key').placeholder = info.apiKeyPlaceholder;
  document.getElementById('api-key').value = apiKeys[provider] || '';

  document.getElementById('field-custom-endpoint').classList.toggle('hidden', provider !== 'custom');
  if (provider === 'custom') {
    document.getElementById('custom-endpoint').value = customEndpointUrl;
  }

  // Editable combobox: known models are suggestions, but any name can be typed.
  const modelInput = document.getElementById('model-input');
  const modelList  = document.getElementById('model-list');
  modelList.innerHTML = info.models.map(m =>
    `<option value="${escHtml(m.value)}" label="${escHtml(m.label)}"></option>`
  ).join('');
  modelInput.value = models[provider] || info.defaultModel || '';
  modelInput.placeholder = provider === 'custom'
    ? 'e.g. llama3, phi3, mistral'
    : info.models.length ? 'Select or type a model name…' : 'Type a model name…';

  document.querySelectorAll('.mode-tab').forEach(tab => {
    if (tab.dataset.mode === 'web') {
      tab.classList.toggle('disabled', !info.hasWebUI);
    }
  });

  if (!info.hasWebUI && document.getElementById('mode-select').value === 'web') {
    setMode('api');
  }

  updateChipsForMode(document.getElementById('mode-select').value);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export async function persistSettings() {
  const provider = document.getElementById('provider-select').value;
  const isCustom = provider === 'custom';
  const model = document.getElementById('model-input').value.trim();
  const apiKey            = document.getElementById('api-key').value.trim();
  const customEndpointUrl = isCustom ? document.getElementById('custom-endpoint').value.trim() : '';
  const transcriptLang    = document.getElementById('transcript-lang-select').value;
  const customPrompt      = document.getElementById('prompt-input').value.trim();
  const mode              = document.getElementById('mode-select').value;
  const useThinking       = document.getElementById('thinking-cb').checked;
  const autoPaste         = document.getElementById('autopaste-cb').checked;
  const autoSubmit        = document.getElementById('autosubmit-cb').checked;
  const combinedPrompt    = document.getElementById('combined-prompt-cb').checked;
  const saveTranscriptFile = document.getElementById('save-file-cb').checked;
  const includeTimestamps  = document.getElementById('timestamps-cb').checked;
  const summaryLength     = [...document.querySelectorAll('.chip-len')].find(c => c.classList.contains('on'))?.dataset.len || 'normal';
  const webDelay          = Math.max(10, parseInt(document.getElementById('web-delay').value, 10) || 30);

  const { apiKeys: storedKeys = {}, models: storedModels = {} } =
    await chrome.storage.local.get(['apiKeys', 'models']);

  const newApiKeys = { ...storedKeys, [provider]: apiKey };
  const newModels  = { ...storedModels, [provider]: model };

  await chrome.storage.local.set({
    provider, apiKeys: newApiKeys, models: newModels, customEndpointUrl,
    apiKey: provider === 'anthropic' ? apiKey : (storedKeys.anthropic || ''),
    model:  provider === 'anthropic' ? model  : (storedModels.anthropic || 'claude-sonnet-4-6'),
    transcriptLang, customPrompt, mode, useThinking, autoPaste, autoSubmit, combinedPrompt, saveTranscriptFile, summaryLength, webDelay,
    includeTimestamps
  });
}

export async function saveSettings() {
  await persistSettings();
  const btn = document.getElementById('btn-save-key');
  btn.textContent = '✅';
  setTimeout(() => { btn.textContent = 'Save'; }, 1500);
}

export function updatePromptPreview(text) {
  const el = document.getElementById('prompt-header-preview');
  if (el) el.textContent = text ? text.slice(0, 60) + (text.length > 60 ? '…' : '') : '';
}

export function togglePromptEditor() {
  document.getElementById('prompt-editor').classList.toggle('hidden');
}
