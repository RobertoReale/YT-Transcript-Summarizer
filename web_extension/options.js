import { PROMPTS, DEFAULT_PROMPTS, initPrompts } from './modules/config.js';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const stored = await chrome.storage.local.get(['provider', 'apiKeys']);
  const provider = stored.provider || 'gemini';
  const apiKeys = stored.apiKeys || {};
  
  document.getElementById('provider-select').value = provider;
  document.getElementById('api-key').value = apiKeys[provider] || '';
  
  updateHelpLink();

  document.getElementById('provider-select').addEventListener('change', updateHelpLink);
  document.getElementById('btn-save').addEventListener('click', saveSettings);

  await initPrompts();
  setupTemplates();
}

function updateHelpLink() {
  const provider = document.getElementById('provider-select').value;
  const link = document.getElementById('help-link');
  
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
    document.getElementById('api-key').value = apiKeys[provider] || '';
  });
}

async function saveSettings() {
  const provider = document.getElementById('provider-select').value;
  const key = document.getElementById('api-key').value.trim();
  
  const stored = await chrome.storage.local.get(['apiKeys']);
  const apiKeys = stored.apiKeys || {};
  if (key) {
    apiKeys[provider] = key;
  }
  
  await chrome.storage.local.set({ provider, apiKeys });
  
  const msg = document.getElementById('save-msg');
  msg.classList.remove('hidden');
  setTimeout(() => {
    msg.classList.add('hidden');
  }, 2500);
}

// --- Prompt Templates Logic ---
let customTemplatesCache = {};

async function setupTemplates() {
  const { customTemplates } = await chrome.storage.local.get('customTemplates');
  customTemplatesCache = customTemplates || {};
  
  const langSel = document.getElementById('tpl-lang');
  const fmtSel = document.getElementById('tpl-fmt');
  const lenSel = document.getElementById('tpl-len');
  
  const updateTextarea = () => {
    const lang = langSel.value;
    const fmt = fmtSel.value;
    const len = lenSel.value;
    document.getElementById('tpl-textarea').value = PROMPTS[lang]?.[fmt]?.[len] || '';
  };

  langSel.addEventListener('change', updateTextarea);
  fmtSel.addEventListener('change', updateTextarea);
  lenSel.addEventListener('change', updateTextarea);
  
  document.getElementById('btn-save-tpl').addEventListener('click', async () => {
    const lang = langSel.value;
    const fmt = fmtSel.value;
    const len = lenSel.value;
    const val = document.getElementById('tpl-textarea').value.trim();
    if (!val) return;
    
    if (!customTemplatesCache[lang]) customTemplatesCache[lang] = {};
    if (!customTemplatesCache[lang][fmt]) customTemplatesCache[lang][fmt] = {};
    customTemplatesCache[lang][fmt][len] = val;
    
    await chrome.storage.local.set({ customTemplates: customTemplatesCache });
    PROMPTS[lang][fmt][len] = val; // update local memory too
    
    const msg = document.getElementById('tpl-msg');
    msg.textContent = 'Saved!';
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2500);
  });

  document.getElementById('btn-reset-tpl').addEventListener('click', async () => {
    const lang = langSel.value;
    const fmt = fmtSel.value;
    const len = lenSel.value;
    
    if (customTemplatesCache[lang]?.[fmt]?.[len]) {
      delete customTemplatesCache[lang][fmt][len];
      await chrome.storage.local.set({ customTemplates: customTemplatesCache });
      PROMPTS[lang][fmt][len] = DEFAULT_PROMPTS[lang][fmt][len];
      
      const msg = document.getElementById('tpl-msg');
      msg.textContent = 'Reset!';
      msg.classList.remove('hidden');
      setTimeout(() => msg.classList.add('hidden'), 2500);
      
      updateTextarea();
    }
  });

  updateTextarea();
}
