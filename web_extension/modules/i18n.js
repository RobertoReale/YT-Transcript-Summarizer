export function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) {
      // If it's an input with placeholder, i18n applies to placeholder
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = msg;
      } 
      // Some elements might have a title instead of text content, but usually we use a specific dataset for that.
      else {
        el.innerHTML = msg;
      }
    }
  });
  
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) {
      el.title = msg;
    }
  });
}

// Auto-run when imported
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyI18n);
} else {
  applyI18n();
}
