// gemini_paste.js — Content script for gemini.google.com
// Selectors only; the paste/claim/submit logic lives in paste_common.js.

ytsRunPaste({
  inputSelectors: [
    'rich-textarea .ql-editor',
    '.ql-editor',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
  ],
  sendSelectors: [
    'button[aria-label*="send" i]',
    'button[aria-label*="invia" i]',
    'button[mattooltip*="send" i]',
    'button[mattooltip*="invia" i]',
    'button[data-testid*="send" i]',
    '.send-button',
    'button[type="submit"]',
  ],
  // The model's own answers, read back so the merge request can carry the
  // partial summaries as text instead of pointing at earlier turns.
  replySelectors: [
    'model-response message-content',
    'message-content.model-response-text',
    '.model-response-text',
    'model-response .markdown',
    '.markdown',
  ],
  // Gemini may turn very large pastes into file attachments.
  attachmentSelectors: [
    'file-attachment-chip',
    '[data-testid*="attachment"]',
    '[aria-label*="attachment" i]',
    '[aria-label*="allegat" i]', // IT
  ],
  // Shown while Gemini is answering; used to pace a multi-part transcript.
  stopSelectors: [
    'button[aria-label*="stop" i]',
    'button[aria-label*="interrompi" i]',
    'button[mattooltip*="stop" i]',
    'button[mattooltip*="interrompi" i]',
    '.stop-icon',
    '[data-testid*="stop" i]',
  ],
});
