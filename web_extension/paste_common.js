// paste_common.js — shared auto-paste logic for the provider content scripts.
// Loaded before claude_paste.js / chatgpt_paste.js / gemini_paste.js, which now
// only declare their selectors. The three files used to carry three drifting
// copies of this code.

// The payload is only valid for a short while after the background opened the
// tab. Without this, a payload left behind by a tab that was closed before it
// loaded stayed in storage forever and got pasted into an unrelated visit days
// later.
const PENDING_TTL_MS = 5 * 60 * 1000;

// A payload that no tab managed to paste is worth exactly one more try (the
// status line tells the user to reload). Past that it is only a hazard: every
// later visit to the provider would replay a transcript the user has moved on
// from.
const PENDING_MAX_ATTEMPTS = 2;

function ytsSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Take ownership of the pending payload without deleting it yet: two chat tabs
 * loading at the same time must not both paste, but a paste that never happens
 * (slow page, logged out) must not destroy the transcript either.
 */
async function ytsClaimPending() {
  const { pendingLLMContent } = await chrome.storage.local.get('pendingLLMContent');
  // `parts` is the split-transcript form (one message per part, plus an optional
  // merge request); `text` is the single-message form.
  const parts = Array.isArray(pendingLLMContent?.parts) && pendingLLMContent.parts.length
    ? pendingLLMContent.parts
    : (pendingLLMContent?.text ? [pendingLLMContent.text] : null);
  if (!parts) return null;

  if (pendingLLMContent.ts && Date.now() - pendingLLMContent.ts > PENDING_TTL_MS) {
    await chrome.storage.local.remove('pendingLLMContent');
    return null;
  }
  if (pendingLLMContent.claimedBy && Date.now() - (pendingLLMContent.claimedAt || 0) < 60000) {
    return null; // another tab is already handling it
  }
  // A payload written AFTER this document started belongs to a tab that has not
  // opened yet — the background writes it and only then calls tabs.create. In a
  // web batch the next video overwrites the key while the previous chat tab is
  // still booting, and that tab would cheerfully paste the wrong video's
  // transcript and report it under the wrong job. The same rule keeps a
  // provider tab the user opened by hand out of a run it has nothing to do with.
  const startedAt = (typeof performance !== 'undefined' && performance.timeOrigin) || 0;
  if (startedAt && pendingLLMContent.ts > startedAt) {
    return null;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({
    pendingLLMContent: { ...pendingLLMContent, claimedBy: token, claimedAt: Date.now() }
  });
  // Re-read: if another tab claimed it in the meantime, its token wins.
  const { pendingLLMContent: after } = await chrome.storage.local.get('pendingLLMContent');
  if (after?.claimedBy !== token) return null;
  return { parts, autoSubmit: after.autoSubmit, jobId: after.jobId ?? null, merge: after.merge || null, needReplyText: after.needReplyText || false, partIndex: after.partIndex ?? 0 };
}

async function ytsReleasePending(consumed) {
  if (consumed) {
    await chrome.storage.local.remove('pendingLLMContent');
    return;
  }
  // Hand it back so the next attempt (a reload, or another tab) can pick it up.
  const { pendingLLMContent } = await chrome.storage.local.get('pendingLLMContent');
  if (!pendingLLMContent) return;
  const { claimedBy, claimedAt, attempts, ...rest } = pendingLLMContent;
  const used = (attempts || 0) + 1;
  // Retrying forever is how a payload nobody wants any more ends up pasted into
  // an unrelated conversation. One retry, then it goes.
  if (used >= PENDING_MAX_ATTEMPTS) {
    await chrome.storage.local.remove('pendingLLMContent');
    return;
  }
  await chrome.storage.local.set({ pendingLLMContent: { ...rest, attempts: used } });
}

function ytsWaitForInput(selectors, timeoutMs) {
  return new Promise((resolve) => {
    const find = () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      return null;
    };

    const el = find();
    if (el) return resolve(el);

    let timer = null;
    const obs = new MutationObserver(() => {
      const found = find();
      if (found) { clearTimeout(timer); obs.disconnect(); resolve(found); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => { obs.disconnect(); resolve(find()); }, timeoutMs);
  });
}

function ytsPasteText(el, text) {
  // Method 1: ClipboardEvent — ProseMirror/Lexical/React editors handle this and call
  // preventDefault(), which makes dispatchEvent() return false. Use that as the signal
  // that the framework took over, so we skip Method 2 (avoiding double-paste).
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });

    // Gecko ignores `clipboardData` in the constructor, so the editor would receive an
    // EMPTY clipboard, call preventDefault() anyway, and we would read that as "handled"
    // and skip Method 2 — returning success having inserted nothing. Measured on Firefox
    // 153: 0 of 2019 characters landed while this function returned true. Same failure
    // class as fix H, on the provider the extension actually ships to.
    if (!ev.clipboardData || ev.clipboardData.getData('text/plain') !== text) {
      try { Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true }); } catch (_) {}
    }

    const notCancelled = el.dispatchEvent(ev);
    if (!notCancelled) return true; // framework called preventDefault() → paste was handled
  } catch (_) {}

  // Method 2: execCommand fallback — only reached if no framework intercepted the event
  try { if (document.execCommand('insertText', false, text)) return true; } catch (_) {}

  // Method 3: plain <textarea>/<input>, where neither of the above applies.
  try {
    if ('value' in el) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Empty the composer. Used before a second paste attempt: the first one may have
 * been slow rather than lost, and stacking a retry on top of it produces one
 * message carrying the prompt and the transcript twice.
 */
function ytsClearInput(el) {
  if (!el) return;
  try {
    if ('value' in el && typeof el.value === 'string') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  } catch (_) {}
  // contenteditable: select the whole editor and delete through the framework,
  // so ProseMirror/Lexical update their own model instead of being written over.
  try {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    if (!document.execCommand('delete')) el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (_) {}
}

function ytsReadInput(el) {
  if (!el) return '';
  return ('value' in el && typeof el.value === 'string') ? el.value : (el.innerText || el.textContent || '');
}

// Did any of the text actually make it into the editor? Guards against silently
// dropping the transcript when a site changes its input handling.
function ytsInputHasText(el, text) {
  const probe = text.slice(0, 40).trim();
  const current = ytsReadInput(el);
  return current.length > 20 && (!probe || current.includes(probe.slice(0, 20)));
}

// How many attachment chips the composer is showing. Only Claude declares these
// selectors; everywhere else this is a constant 0 and costs nothing.
function ytsCountAttachments(cfg) {
  let n = 0;
  for (const sel of (cfg.attachmentSelectors || [])) {
    try { n += document.querySelectorAll(sel).length; } catch (_) {}
  }
  return n;
}

/**
 * Wait for the pasted text to actually arrive, instead of checking once after a
 * fixed delay. On a chat tab that has just opened, the SPA is still mounting and
 * a large paste can take seconds to show up in the DOM — the old single 600 ms
 * check declared failure while the text was still on its way, so nothing was
 * ever submitted and the payload was handed back for a retry that never came.
 *
 * The element is re-queried on every tick: these editors get re-created while
 * the app boots, and the node we pasted into may no longer be the live one.
 *
 * "Arrived" is not always "is in the composer". Claude turns a large paste into a
 * **PASTED attachment** and leaves the composer empty — the text is there, just
 * not where we were looking. Reading only the composer made every long web run on
 * Claude fail outright (observed 2026-07-28, two chips and `❌ Paste failed`,
 * because the retry pasted a second time). The attachment is a fine outcome: the
 * model reads it in full, verified on a 300k positional probe (§5.4).
 *
 * @returns {Promise<{input: Element, attached: boolean}|null>}
 */
async function ytsWaitForLanded(cfg, el, text, baseline = 0, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ytsInputHasText(el, text)) return { input: el, attached: false };
    for (const sel of cfg.inputSelectors) {
      const alt = document.querySelector(sel);
      if (alt && alt !== el && ytsInputHasText(alt, text)) return { input: alt, attached: false };
    }
    if (ytsCountAttachments(cfg) > baseline) return { input: el, attached: true };
    await ytsSleep(250);
  }
  return null;
}

// `offsetParent` is null for position:fixed elements, which is exactly what the
// floating "stop generating" button often is.
function ytsIsVisible(el) {
  return !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
}

/**
 * Block until the assistant has finished answering, so the next part isn't
 * typed into a busy composer. Detection is the provider's "stop generating"
 * button: wait for it to appear, then for it to go away. If it never appears
 * (selector drift, an instant reply) fall back to a fixed grace period rather
 * than stalling the whole sequence.
 */
async function ytsWaitForReply(cfg, maxMs = 300000) {
  const sel = cfg.stopSelectors || [];
  const busy = () => sel.some(s => ytsIsVisible(document.querySelector(s)));

  const startedBy = Date.now() + 15000;
  while (Date.now() < startedBy && !busy()) await ytsSleep(500);
  if (!busy()) { await ytsSleep(6000); return; }

  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && busy()) await ytsSleep(1000);
  await ytsSleep(2000); // let the composer re-enable before typing into it
}

function ytsClickSend(selectors) {
  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return true; }
  }
  return false;
}

function ytsSubmitViaKey(el) {
  // Dispatch both keydown and keyup — some frameworks listen to one, some to both
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));

  // Ultimate fallback: native form submit
  const form = el.closest('form');
  if (form) { try { form.requestSubmit(); } catch (_) {} }
}

/**
 * Clicking Send is not proof the message went out. Observed 2026-07-27 on Gemini:
 * after a wedged turn the "stop generating" button never disappeared, the composer
 * stayed disabled, and both the click and the Enter fallback were swallowed — the
 * 27k-char part just sat there. The composer emptying is the only real signal.
 */
async function ytsWaitForSubmitted(cfg, text, timeoutMs = 20000, attachedBaseline = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let stillThere;
    if (attachedBaseline === null) {
      stillThere = false;
      for (const sel of cfg.inputSelectors) {
        const el = document.querySelector(sel);
        if (el && ytsInputHasText(el, text)) { stillThere = true; break; }
      }
    } else {
      // The text went in as an attachment, so the composer was ALWAYS empty and
      // "the composer emptied" would report success before anything was sent —
      // the fix H bug, rebuilt. Here the chip going away is the real signal.
      stillThere = ytsCountAttachments(cfg) > attachedBaseline;
    }
    if (!stillThere) return true;
    await ytsSleep(500);
  }
  return false;
}

/**
 * The text of the newest answer on the page, used to feed the partial summaries
 * back into the merge request instead of trusting the model to re-read its own
 * older turns (see mergePlanFor in modules/llm-api.js).
 *
 * The length floor keeps a spinner, a "thinking" placeholder or an empty
 * scaffold node from being mistaken for a summary: a partial summary of a
 * transcript slice is never a couple of hundred characters.
 */
function ytsReadLastReply(cfg) {
  for (const sel of (cfg.replySelectors || [])) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const t = (nodes[i].innerText || nodes[i].textContent || '').trim();
      if (t.length > 400) return t;
    }
  }
  return '';
}

/**
 * The answer to the part we have just sent — once it is actually a NEW one.
 *
 * `ytsWaitForReply` watches the "stop generating" button, and when that button
 * never shows up it falls back to a fixed grace period. On ChatGPT that fallback
 * fired before the answer existed, so the newest node on the page was still the
 * PREVIOUS part's answer: the merge message ended up carrying partial 1 twice
 * and partial 2 not at all (observed 2026-07-28 — two byte-identical partials in
 * an 8.857-char merge, with a status line saying ✅ and nothing amiss).
 *
 * That is the §4.4 bug wearing a different hat, so the rule here is: an answer
 * only counts if it is not the one we already have. If it never changes we
 * return nothing, the count no longer matches, and the merge falls back to the
 * old wording — which the status line then declares.
 */
async function ytsReadNewReply(cfg, previous, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = ytsReadLastReply(cfg);
    if (t && t !== previous) return t;
    await ytsSleep(1000);
  }
  console.warn('[YT Summarizer] the answer never changed — refusing to reuse the previous one');
  return '';
}

// Cut at a paragraph or sentence boundary near the end of the budget, and say
// so: an invisible cut is the very failure this whole feature exists to avoid.
function ytsTrimTo(text, budget) {
  if (text.length <= budget) return text;
  const marker = '\n\n[…]';
  const room = Math.max(1, budget - marker.length);
  const head = text.slice(0, room);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
  return (cut > room * 0.7 ? head.slice(0, cut) : head).trimEnd() + marker;
}

/**
 * Rebuild the merge message with the partial answers inlined as text.
 * @returns {string|null} null when it cannot be done honestly — a missing reply,
 * or a composer so small that the parts would be shredded. The caller then sends
 * the original "merge the summaries above" message, which is no worse than before.
 */
function ytsBuildMergeMessage(plan, replies) {
  if (!plan || plan.count < 2 || replies.length !== plan.count) return null;

  const head = `${plan.head}\n\n---\n\n`;
  const sep = '\n\n---\n\n';
  const headings = replies.map((_, i) => `## ${plan.label} ${i + 1}/${plan.count}\n\n`);

  const cap = Math.floor(plan.cap) || 0;
  let bodies = replies;
  if (cap) {
    const fixed = head.length + headings.reduce((n, h) => n + h.length, 0) + sep.length * (replies.length - 1);
    const budget = Math.floor((cap - fixed) / replies.length);
    // Below this there is no summary left, only a stub per part — worse than
    // asking the model to look up, because it reads as if it were complete.
    if (budget < 600) return null;
    bodies = replies.map(r => ytsTrimTo(r, budget));
  }
  return head + bodies.map((r, i) => headings[i] + r).join(sep);
}

/**
 * The instruction at the top of a message: everything before the `---` that
 * separates it from the transcript slice (or from the partial summaries, in the
 * merge message). Every message this extension builds has that shape.
 * @returns {string} empty when there is no separator, or when the head is so
 * long that re-typing it might itself turn into a second attachment.
 */
function ytsInstructionHead(text) {
  const i = text.indexOf('\n\n---\n\n');
  if (i <= 0 || i > 4000) return '';
  return text.slice(0, i);
}

/**
 * Paste one message and send it.
 * @returns {Promise<{landed: boolean, submitted: boolean}>} `landed` is "the text
 * reached the editor", `submitted` is "it actually left as a message". They are
 * NOT the same thing, and reporting the first as if it were the second is how a
 * run of four parts could be announced as sent with three still in the composer.
 */
async function ytsSendOne(cfg, text, autoSubmit) {
  let input = await ytsWaitForInput(cfg.inputSelectors, 20000);
  if (!input) return { landed: false, submitted: false };

  // Measured before the first attempt: on Claude a retry that thought it had
  // failed left a SECOND identical attachment behind, so "how many chips are
  // there now" only means something against what was there before.
  const baseline = ytsCountAttachments(cfg);

  // Two attempts: a paste into a half-mounted editor can be swallowed outright.
  // The retry is NOT free, though: "we did not see it land in 15 s" is not the
  // same as "nothing landed", and a first paste that was merely slow would be
  // stacked under a second copy — one message carrying the prompt and the whole
  // transcript twice. So before pasting again, look once more, then wipe.
  let landed = null;
  for (let attempt = 0; attempt < 2 && !landed; attempt++) {
    if (attempt > 0) {
      landed = await ytsWaitForLanded(cfg, input, text, baseline, 2500);
      if (landed) break;
      ytsClearInput(input);
      await ytsSleep(300);
    }
    input.focus();
    await ytsSleep(400);
    ytsPasteText(input, text);
    landed = await ytsWaitForLanded(cfg, input, text, baseline, attempt === 0 ? 15000 : 8000);
    if (!landed) {
      console.warn(`[YT Summarizer] paste attempt ${attempt + 1} did not reach the editor`);
      input = (await ytsWaitForInput(cfg.inputSelectors, 5000)) || input;
    }
  }
  if (!landed) return { landed: false, submitted: false };
  input = landed.input;

  // When the whole message becomes an attachment, the INSTRUCTION goes in with it
  // and the message itself arrives empty. ChatGPT answered exactly that on
  // 2026-07-28: «ho ricevuto il file, ma nel tuo ultimo messaggio non c'è una
  // richiesta specifica» — a wasted turn, and with merge on, a wasted partial
  // summary. So put the instruction back where the model looks for it: the few
  // hundred characters before the `---` separator are the prompt plus the
  // "part i of n" note, and they are small enough to stay plain text.
  if (landed.attached) {
    const head = ytsInstructionHead(text);
    if (head) {
      input.focus();
      await ytsSleep(300);
      ytsPasteText(input, head);
      await ytsSleep(600);
    }
  }

  if (!autoSubmit) return { landed: true, submitted: false };

  await ytsSleep(landed.attached ? 2500 : 800);

  // One click is enough when the text is in the composer. With an attachment it
  // is not: the Send button is enabled while the chip is still being processed,
  // so the click is simply swallowed — observed on ChatGPT 2026-07-28, chip in
  // place, button enabled, nothing sent. So keep clicking until the chip leaves.
  let submitted = false;
  const rounds = landed.attached ? 4 : 1;
  for (let round = 0; round < rounds && !submitted; round++) {
    if (round) await ytsSleep(2000);
    let clicked = false;
    for (let attempts = 0; attempts < 6 && !clicked; attempts++) {
      if (ytsClickSend(cfg.sendSelectors)) clicked = true;
      else await ytsSleep(500);
    }
    if (!clicked) ytsSubmitViaKey(input);
    submitted = await ytsWaitForSubmitted(cfg, text,
      landed.attached ? 8000 : 20000, landed.attached ? baseline : null);
  }
  if (!submitted) console.warn('[YT Summarizer] the text landed but was never submitted');
  return { landed: true, submitted };
}

/**
 * Entry point used by each provider script.
 * @param {{inputSelectors: string[], sendSelectors: string[], stopSelectors?: string[]}} cfg
 */
async function ytsRunPaste(cfg) {
  const pending = await ytsClaimPending();
  if (!pending) return;

  // A split transcript is posted as several messages into the SAME conversation,
  // which is the whole point: the model keeps the earlier parts as context. That
  // only works if we're allowed to press Send — without auto-submit we can just
  // drop the first part in the composer and leave the rest to the user.
  const parts = pending.autoSubmit ? pending.parts : pending.parts.slice(0, 1);

  // Only meaningful when the whole sequence runs: with auto-submit off there is
  // no merge message to reach anyway.
  const plan = pending.autoSubmit ? pending.merge : null;
  const replies = [];
  let mergeInline = plan ? false : null;

  let consumed = false;
  let sent = 0;
  try {
    for (let i = 0; i < parts.length; i++) {
      let text = parts[i];
      if (plan && i === plan.at) {
        // Hand the model its own partial summaries back as text. Without this the
        // message says "merge the summaries above", and a chat model may fuse only
        // its most recent turns — a plausible summary of half the video.
        const inlined = ytsBuildMergeMessage(plan, replies);
        if (inlined) { text = inlined; mergeInline = true; }
        else console.warn('[YT Summarizer] could not read the partial answers — merging from chat memory');
      }
      const res = await ytsSendOne(cfg, text, pending.autoSubmit);
      // With auto-submit the bar is "it left as a message"; without it, the most
      // that can happen is the paste, so landing IS the success condition.
      const ok = pending.autoSubmit ? res.submitted : res.landed;
      if (!ok) {
        if (i === 0) {
          // Leave the payload for a reload ONLY when nothing reached the editor.
          // If the text is sitting in the composer, "not submitted" may simply
          // mean we could not tell — the message may well have gone out. Replaying
          // it then posts the same transcript twice, which is a worse failure than
          // the one being recovered from; the user can press Enter themselves.
          consumed = res.landed;
          return;
        }
        console.warn(`[YT Summarizer] stopped after part ${i}/${parts.length}`);
        break;
      }
      sent = i + 1;
      if (i === 0) {
        // Drop the payload as soon as the first part lands: the rest of the
        // sequence can take minutes, and the claim only holds off other tabs
        // for 60 s — a second tab must never replay this conversation.
        consumed = true;
        await chrome.storage.local.remove('pendingLLMContent');
      }
      if (i < parts.length - 1 || pending.needReplyText) {
        await ytsWaitForReply(cfg);
        // Read it now, while it is the newest node on the page: at the end of a
        // long conversation "which answer belongs to which part" is guesswork.
        if (pending.needReplyText || (plan && i < plan.at)) {
          const reply = await ytsReadNewReply(cfg, replies[replies.length - 1] || '');
          if (reply) replies.push(reply);
          else console.warn(`[YT Summarizer] could not read the answer to part ${i + 1}`);
        }
      }
    }
  } finally {
    await ytsReleasePending(consumed);
    // Tell the background what really happened, so the job status stops
    // claiming "✅ Sent" for a paste that never made it.
    if (pending.jobId != null) {
      try {
        chrome.runtime.sendMessage({
          type: 'pasteReport',
          jobId: pending.jobId,
          ok: sent >= parts.length,
          sent,
          total: parts.length,
          // true: the partials were pasted into the merge message. false: they
          // could not be read and the merge leans on the chat's memory, which is
          // the case the status line has to warn about. null: no merge at all.
          mergeInline,
          replyText: pending.needReplyText ? (replies[replies.length - 1] || null) : null,
          partIndex: pending.partIndex
        });
      } catch (_) {}
    }
  }
}
