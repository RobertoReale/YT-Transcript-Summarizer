// claude_paste.js — Content script for claude.ai
// Selectors only; the paste/claim/submit logic lives in paste_common.js.

ytsRunPaste({
  inputSelectors: [
    '[contenteditable="true"][role="textbox"]',
    '.ProseMirror',
    '[contenteditable="true"]',
    'textarea',
  ],
  sendSelectors: [
    'button[aria-label*="send" i]',
    'button[aria-label*="invia" i]', // IT
    'button[data-testid*="send" i]',
    'button[data-testid*="submit" i]',
    'button[type="submit"]',
  ],
  // Claude turns a large paste into a "PASTED" attachment and leaves the composer
  // empty. That is a success, not a failure — the model reads the attachment in
  // full — but it is invisible to a check that only looks at the composer, which
  // is why every long web run on Claude used to end in "❌ Paste failed".
  attachmentSelectors: [
    '[data-testid="file-thumbnail"]',
  ],
  // The model's own answers, read back so the merge request can carry the
  // partial summaries as text instead of pointing at earlier turns.
  replySelectors: [
    '[data-testid="conversation-turn"] .font-claude-response',
    '.font-claude-response',
    '.font-claude-message',
    '[data-is-streaming="false"] .standard-markdown',
    '[data-is-streaming="false"]',
  ],
  // Shown while Claude is answering; used to pace a multi-part transcript.
  stopSelectors: [
    'button[aria-label*="stop" i]',
    'button[aria-label*="interrompi" i]', // IT
    'button[data-testid="stop-button"]',
  ],
});
