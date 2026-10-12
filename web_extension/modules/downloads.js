// ── downloads.js — safe filenames + large-file downloads ─────────────────────
// Everything used to be saved through `data:text/plain,` + encodeURIComponent(),
// which inflates non-ASCII text ~3× and blows past the browser's URL length cap
// on long transcripts (and on every "combined" batch). The download then failed
// while the job was still reported as done. We build a blob: URL in the offscreen
// document instead — service workers have no URL.createObjectURL — and fall back
// to a data: URL only when the payload is small or offscreen isn't available
// (Firefox), where an oversized payload now raises instead of failing silently.

const OFFSCREEN_PATH = 'tts_offscreen.html';
const DATA_URL_LIMIT = 1_500_000; // conservative; browsers reject ~2 MB URLs

let offscreenCreating = null;

// One offscreen document is allowed per extension, so the TTS page doubles as
// the blob host and must declare both reasons.
export async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  try {
    if (await chrome.offscreen.hasDocument()) return true;
    if (!offscreenCreating) {
      const reasons = [chrome.offscreen.Reason.AUDIO_PLAYBACK];
      if (chrome.offscreen.Reason.BLOBS) reasons.push(chrome.offscreen.Reason.BLOBS);
      offscreenCreating = chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_PATH),
        reasons,
        justification: 'Text-to-Speech playback and blob URLs for saving large transcripts'
      }).finally(() => { offscreenCreating = null; });
    }
    await offscreenCreating;
    return true;
  } catch (_) {
    // A concurrent caller may have created it between the check and the call.
    try { return await chrome.offscreen.hasDocument(); } catch (_) { return false; }
  }
}

function revokeBlobUrl(url) {
  if (!url || !url.startsWith('blob:')) return;
  chrome.runtime.sendMessage({ type: 'revoke-blob-url', url }).catch(() => {});
}

// Revoke as soon as the browser is done reading the blob, with a timed backstop
// in case the download never reaches a terminal state.
function scheduleRevoke(downloadId, url) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { chrome.downloads.onChanged.removeListener(onChanged); } catch (_) {}
    revokeBlobUrl(url);
  };
  const onChanged = (delta) => {
    if (delta.id !== downloadId) return;
    const s = delta.state?.current;
    if (s === 'complete' || s === 'interrupted') finish();
  };
  try { chrome.downloads.onChanged.addListener(onChanged); } catch (_) {}
  setTimeout(finish, 120000);
}

/**
 * Save `text` as `filename`. Resolves with the download id, rejects with a
 * descriptive Error — callers must not treat a failed save as a success.
 */
export async function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  const body = String(text ?? '');
  let url = null;
  let isBlob = false;

  // Firefox runs the background as an event page, which — unlike Chrome's
  // service worker — can mint blob: URLs itself. No offscreen round trip, and
  // no data: URL size ceiling.
  if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const local = URL.createObjectURL(new Blob([body], { type: mime }));
    try {
      const id = await chrome.downloads.download({ url: local, filename, saveAs: false });
      if (id === undefined) throw new Error(chrome.runtime.lastError?.message || 'download rejected');
      setTimeout(() => URL.revokeObjectURL(local), 120000);
      return id;
    } catch (e) {
      URL.revokeObjectURL(local);
      throw new Error(`Could not save "${filename}": ${e?.message || e}`);
    }
  }

  if (await ensureOffscreenDocument()) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'make-blob-url', text: body, mime });
      if (res?.url) { url = res.url; isBlob = true; }
    } catch (_) { /* fall through to the data: URL path */ }
  }

  if (!url) {
    const dataUrl = `data:${mime},` + encodeURIComponent(body);
    if (dataUrl.length > DATA_URL_LIMIT) {
      throw new Error(
        `File too large to save without an offscreen document ` +
        `(${Math.round(body.length / 1024)} KB of text). Update the browser or split the batch.`
      );
    }
    url = dataUrl;
  }

  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    if (id === undefined) throw new Error(chrome.runtime.lastError?.message || 'download rejected');
    if (isBlob) scheduleRevoke(id, url);
    return id;
  } catch (e) {
    if (isBlob) revokeBlobUrl(url);
    throw new Error(`Could not save "${filename}": ${e?.message || e}`);
  }
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Build a filesystem-safe filename. The previous version trimmed *before*
 * slicing (so a name could still end in a space, which Windows rejects) and
 * could produce an empty base — yielding filenames like ".md" that the
 * downloads API refuses outright.
 */
export function safeFilename(title, fallback = 'video', { suffix = '', ext = 'txt', max = 100 } = {}) {
  let base = String(title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (RESERVED.test(base)) base = `_${base}`;
  if (!base) {
    base = String(fallback ?? '').replace(/[^\w.-]+/g, '') || 'video';
  }
  return `${base}${suffix}.${ext}`;
}
