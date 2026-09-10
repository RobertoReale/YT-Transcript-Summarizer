// chatgpt_paste.js — Content script for chatgpt.com
// Selectors only; the paste/claim/submit logic lives in paste_common.js.

ytsRunPaste({
  inputSelectors: [
    '#prompt-textarea',
    '[contenteditable="true"][data-testid]',
    '.ProseMirror',
    '[contenteditable="true"]',
    'textarea',
  ],
  sendSelectors: [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="invia" i]', // IT
    'button[data-testid*="send" i]',
    'button[type="submit"]',
  ],
  // Like Claude, ChatGPT turns a large paste into an attachment ("Pasted text —
  // too long to show in text field") and leaves the composer empty. Observed
  // 2026-07-28: part 1 went in as text, part 2 became a chip, and the run stopped
  // at "⚠️ Only part 1 of 2". Which of the two happens depends on how far the app
  // has booted, so both have to count as the text having arrived.
  // The aria-label is the precise handle; the class is the structural fallback.
  // NOT `[data-testid*="file"]`: that also matches the account button.
  attachmentSelectors: [
    'button[aria-label*="pasted text attachment" i]',
    'form [class*="file-tile"]',
  ],
  // The model's own answers, read back so the merge request can carry the
  // partial summaries as text instead of pointing at earlier turns.
  replySelectors: [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
    'article .markdown.prose',
    '.markdown.prose',
  ],
  // Shown while ChatGPT is answering; used to pace a multi-part transcript.
  stopSelectors: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="interrompi" i]', // IT
  ],
});
