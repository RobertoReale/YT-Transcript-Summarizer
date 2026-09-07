# YT Transcript Summarizer (Web Extension)

A browser extension (Chrome/Firefox) that extracts transcripts from YouTube videos and summarizes them using your AI of choice — Claude, ChatGPT, Gemini, OpenRouter, or any local OpenAI-compatible model.

---

## Features at a glance

- **5 AI providers** — Anthropic Claude, OpenAI, Google Gemini, OpenRouter, and custom/local endpoints
- **3 operating modes** — Web (paste into the AI chat UI), Transcript Only (download raw text), API (call the AI directly)
- **Batch queue** — add multiple YouTube URLs and process them all at once
- **Bulk add** — paste a whole list of links (one per line, or space/comma-separated) and queue them in one click
- **Playlist expansion** — paste a playlist URL and every video in it is fetched and queued automatically
- **Per-video settings** — override format and summary length for each video individually
- **Summary length** — Short, Normal, or Long presets, each with English and Italian prompts
- **Output format** — Markdown (`.md`) or plain Chat format
- **Reliable extraction** — three fallback strategies to handle YouTube's PO Token restrictions
- **Combine all** — merge all queued transcripts into a single AI prompt
- **Thinking mode** — extended reasoning for supported Claude models
- **Video history** — log of all processed videos with timestamps and links
- **Text-to-Speech** — read any text aloud directly from the popup, with voice and speed selection; optional local TTS server support for higher-quality voices
- **Dark / Light theme**
- **Language preference** — 15 supported languages, or auto-detect transcript language

---

## Providers

Select your provider from the tab bar at the top of the popup. Each provider has its own API key and model selection stored separately.

| Provider | Web mode | API mode | Notes |
|----------|----------|----------|-------|
| **Anthropic Claude** | Claude.ai | ✅ | Supports Thinking mode |
| **OpenAI** | ChatGPT | ✅ | |
| **Google Gemini** | Gemini | ✅ | |
| **OpenRouter** | — | ✅ | Aggregates many models |
| **Custom** | — | ✅ | Any OpenAI-compatible endpoint (e.g. Ollama) |

---

## Modes

| Mode | What it does |
|------|-------------|
| **🌐 Web** | Downloads the transcript as `.txt`, opens the provider's chat UI, and optionally auto-pastes and auto-submits the prompt |
| **📄 Transcript** | Downloads the raw transcript as `.txt` — no AI involved |
| **🤖 API** | Calls the AI API directly and saves the summary as a `.md` file |

---

## Summary options

### Format

| Chip | Output |
|------|--------|
| **💬 Chat** | Plain prose, optimised for pasting into a chat UI |
| **📄 .md** | Markdown with headings, lists, and structure (default) |

### Length

| Chip | Prompt behavior |
|------|----------------|
| **📝 Short** | Key takeaways only |
| **📄 Normal** | Complete and detailed, nothing omitted (default) |
| **📖 Long** | In-depth, structured with headings, every section covered |

Switching format or length automatically updates the prompt with the correct preset for your language. You can still edit the prompt manually.

### Per-video settings

Click **✎** on any queued job to expand its settings panel. You can override the format, length, and prompt individually for that video. The **✎** button turns purple when custom settings are active. Click **↺ reset** to revert to global settings.

---

## Other features

### 📋 Video history
Click the **📋** button in the header to view a log of all videos processed, with title, URL, and timestamp. Click any entry to open the video.

### 🧠 Thinking mode
Available in API mode for supported Claude models (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-3-7-sonnet`). Enables extended reasoning before the summary.

### 📎 Combine all
When enabled, all queued transcripts are merged into a single prompt and sent as one request — useful for comparing or cross-referencing multiple videos.

### 🔊 Text-to-Speech
Click **🔊** in the header to open the TTS panel. Paste any text, select a voice, adjust speed (0.5×–2×), and hit **▶ Play**. You can change the speed while audio is playing; the new rate takes effect from the next passage. Supports pause and stop. Playback continues even when the popup is closed.

**Local TTS server (optional):** Enter the URL of an OpenAI-compatible TTS endpoint in the **Local TTS server** field (e.g. `http://localhost:8880/v1/audio/speech` for [kokoro-fastapi](https://github.com/remsky/kokoro-fastapi)). When set, the extension sends a POST request with `{ "model": "tts-1", "input": "..." }` and plays back the returned audio — Voice and Speed controls do not apply in this mode. Leave the field empty to use the browser's built-in Web Speech API.

### 🌙 / ☀️ Theme
Toggle dark/light theme from the header. Preference is saved.

---

## Installation

### Firefox (AMO)

Install directly from the [Firefox Add-ons page](https://addons.mozilla.org/it/firefox/addon/yt-transcript-summarizer/). Requires Firefox 128+.

### Chrome / Chromium (unpacked)

1. Download or clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder

### Firefox (manual / temporary)

1. Download or clone this repository
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and select `manifest.json`

> Temporary add-ons are removed on Firefox restart. For a persistent install, use AMO or sign the extension with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).

---

## Usage

1. Click the extension icon to open the popup
2. Select your **provider** from the tab bar
3. Select your **mode** (Web / Transcript / API)
4. Choose **format** and **length** from the chips row
5. Add YouTube URLs manually, click **📌** while on a YouTube tab, click **📋** to paste a whole list of links at once, or paste a **playlist URL** to queue all its videos
6. *(Optional)* Click **✎** on individual jobs to override their settings
7. Click **▶ START PROCESSING**

To interrupt a running batch, click the **⏹** button. This stops the queue immediately — no further videos are started. The single video currently being fetched finishes its in-flight network request, and any video left mid-processing is marked *Interrupted*.

### Bulk add

Click the **📋** button next to the URL field to open the bulk-add box. Paste any list of YouTube links — one per line, or separated by spaces or commas (numbered lists work too). Click **Add all to queue** (or press **Ctrl/Cmd + Enter**). Duplicates are skipped and previously failed videos are re-queued; you'll get a summary such as *"5 added, 2 re-queued"*.

### Playlist expansion

Paste a **playlist URL** (e.g. `https://www.youtube.com/playlist?list=…`) into either the URL field or the bulk box, and every video in the playlist is fetched and added to the queue automatically — titles included. It works for playlists of any size (paged 100 at a time, capped at 500 videos to keep the queue manageable). A `watch?v=…&list=…` link is treated as the single chosen video, not the whole playlist; auto-generated Mix/Radio playlists (`list=RD…`) can't be expanded.

Under the hood this uses YouTube's internal `browse` API (the same one the site itself uses), with a self-healing fallback that refreshes the API key from the live playlist page if the shipped one ever rotates.

### API mode setup

1. Open **Advanced Settings** (⚙️ button in the header)
2. Paste your API key in the **API Key** field and click **Save**
3. Select your model from the dropdown

API keys are stored locally in browser storage and are only ever sent to the respective provider's API endpoint.

### Splitting long transcripts

A very long video can exceed what one request handles well — the transcript gets truncated to the model's context, or the summary thins out towards the end. The **✂️** dropdown in the options bar sets how many equal parts the transcript is cut into (`1 part` = off, up to 10), and applies to every video in the queue. To override it for a single video, open that video's **✎** panel and pick a number next to **✂️ Split** — `🔗 Global` keeps whatever the dropdown says.

The transcript is cut into that many slices at line/sentence boundaries, and each is sent with a note telling the model it is seeing part *i* of *n* of a single video, in your transcript language. The number you pick is adjusted automatically in two cases:

- **Downwards** — a transcript too short to fill the requested parts (under ~2 000 characters each) is split into fewer, so a 3-minute video never becomes 8 pointless requests.
- **Upwards, in Web mode only** — a chat composer has its own hard limit, far below the model's context. Gemini keeps the first 32 000 characters of a message and silently drops the rest, so a 3-hour video split into "2 parts" lost ~40% of itself without a word. The number of parts is raised until every message fits (prompt and part note included). Claude.ai and ChatGPT have no verified limit and are left alone. If even 10 parts are not enough, the status line says how far over the limit the run went instead of pretending it all arrived.

**API mode** — each part is summarized in its own call and the partial summaries are concatenated under `## Part i/n` headings. Each part is a separate billed call and gets its own rate-limit retries, so a 429 on part 3 never re-sends parts 1 and 2.

**Web mode** — the parts are pasted one after another into the *same* conversation, so the model keeps the earlier parts as context. Claude and ChatGPT sometimes turn a large paste into an attachment instead of composer text; that works just as well (the model reads the attachment in full), and the instruction is re-typed into the message so the request never gets buried inside the file. The extension waits for each answer to finish (it watches the provider's "stop generating" button) before sending the next part. This needs **↵ Auto-submit**: without permission to press Send only part 1 is pasted, and the status line says so. With **💾 Save .txt** enabled each part is also written to its own `_part1of3.txt` file, so you can paste the rest by hand.

The status line stays at **📤 Sending to …** until the chat tab confirms what actually landed — only then does it become **✅ Sent**. A paste that fails, or a sequence that stops halfway, reports **⚠️ Only part *n* of *m*** / **❌ Paste failed** and raises a desktop notification, because the queue row has usually faded by the time the last part goes out. When merge is on and every part arrived but the final merge message did not, the run says so explicitly rather than counting the merge as a missing part — the whole video did reach the model. Without auto-submit the line ends at **✅ Pasted**, never **✅ Sent**. For **📎 Combine all** the single verdict updates every row of the run at once.

**🧩 Merge parts** (optional, appears next to the dropdown as soon as you pick more than one part) asks for one more answer that fuses the partial summaries into a single unified summary. In API mode it is an extra call that receives the partials — and if that call fails, the partial summaries are kept rather than the whole run being lost.

In web mode the extension does the same thing rather than relying on the chat's memory: it reads the partial answers back out of the page and pastes them into the merge message. Asking a chat model to "merge the summaries above" is not reliable — measured on a four-part video, the answer covered only the last two parts and read as if it covered the whole video. If the answers cannot be read back (an interface change, a composer too small to hold them), the merge still goes out as a plain follow-up and the status line says the merge **relied on the chat's memory**, so a half-covered summary never looks like a complete one.

Both work for single videos and for **📎 Combine all**.

### Web mode auto-paste / auto-submit

Enable **📋 Auto-paste** to have the transcript automatically pasted into the chat input when the AI tab opens. Enable **↵ Auto-submit** to also press Send (implies auto-paste).

Auto-paste is supported for Claude.ai, ChatGPT, and Gemini via dedicated content scripts. The extension includes a robust retry mechanism to ensure successful auto-submission even if the AI web interface takes a few seconds to load.

### Custom / local endpoint

Select **Custom** as the provider, enter your endpoint URL (e.g. `http://localhost:11434/v1/chat/completions` for Ollama) in Advanced Settings, and type the model name in the model field.

---

## Transcript extraction

The extension tries three strategies in order, falling back to the next if one fails:

1. **Watch page + `get_transcript` endpoint** — downloads the watch page (with browser cookies) to extract fresh caption URLs, then falls back to the InnerTube `get_transcript` API
2. **InnerTube Player API** — calls the internal player endpoint directly, trying the Android then iOS clients (two independent attestation paths that still return caption tracks without a PO token)
3. **Real tab fallback** — opens the video in a background tab and reads the transcript from the page (reuses an existing tab if the video is already open)

If all three strategies fail, a `debug_<videoId>.txt` file is downloaded with full diagnostic output.

---

## Supported models

**Anthropic Claude**
- `claude-sonnet-4-6` (recommended)
- `claude-opus-4-7` (most capable)
- `claude-3-7-sonnet`
- `claude-3-5-sonnet`

**OpenAI**
- `gpt-4o` (recommended)
- `gpt-4o-mini`
- `o1`, `o1-mini`
- `gpt-4-turbo`

**Google Gemini**
- `gemini-2.0-flash` (recommended)
- `gemini-1.5-pro`
- `gemini-1.5-flash`

**OpenRouter** — any model available on openrouter.ai (defaults provided as a starting point)

**Custom** — any OpenAI-compatible model; type the model name manually

> **Model field & keeping it current.** For every provider the model field is an editable combobox: the known models appear as dropdown suggestions, but you can always **type any model name** — so a new release is never blocked by a stale list. The suggestions live in one place, [`modules/config.js`](modules/config.js) (`PROVIDERS` → each provider's `models` array, plus `defaultModel`). Updating them is now optional cosmetic maintenance, not a requirement: if a suggestion is outdated, just type the current model name.

---

## Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Save settings, API keys, job queue, and history locally |
| `tabs` | Read current tab URL; open provider chat tabs |
| `scripting` | Run transcript extraction in YouTube tabs (fallback strategy) |
| `downloads` | Save transcript and summary files |
| `notifications` | Notify when batch processing completes |
| `alarms` | Keep the service worker alive during long-running jobs |
| `offscreen` | Text-to-Speech audio playback via Web Speech API or local TTS server |
| `http://localhost/*`, `http://127.0.0.1/*` | Fetch audio from an optional local TTS server |

---

## Files

```
manifest.json           Extension manifest (Manifest V3)
background.js           Service worker: transcript extraction, API calls, TTS routing
popup.html              Extension popup UI
popup.css               Popup styles (light + dark theme)
popup.js                Popup orchestrator: init, port, job CRUD, batch runner
claude_paste.js         Content script: auto-paste into Claude.ai
chatgpt_paste.js        Content script: auto-paste into ChatGPT
gemini_paste.js         Content script: auto-paste into Gemini
tts_offscreen.html      Offscreen document for Web Speech API audio playback
logo.png                Extension icon
modules/
  config.js             Providers, prompts, YouTube API config
  llm-api.js            AI provider integrations
  youtube-api.js        Transcript extraction strategies (3 strategies)
  popup-state.js        Shared mutable state object for popup modules
  popup-history.js      History panel logic
  popup-tts.js          TTS panel logic
  popup-render.js       Job rendering, chips, per-job settings UI
  popup-settings.js     Provider/settings panel logic
  ui-utils.js           escHtml, showMsg
  utils.js              sleep, fetchWithTimeout, findInObject
```

---

## Known compatibility issues

### Duplicate-tab prevention extensions

Extensions like *Prevent Duplicate Tabs* can block Strategy 4 (tab fallback) from opening a YouTube background tab. The extension already minimises this by reusing an open tab for the video if one exists — so the conflict only occurs when Strategies 1–2 all failed **and** the video isn't already open in a tab.

**Fix:** add `youtube.com` to the allowlist of the duplicate-tab extension.

---

## Roadmap

Future improvements planned for this extension:

1. **Code Minification & Bundling**: Transitioning the build process to use tools like Vite or Rollup to bundle and minify the JavaScript and CSS assets. This will significantly reduce the extension's footprint, improve load times, and offer a basic level of code obfuscation.

---

## License

MIT
