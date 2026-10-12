# YT Summarizer (Web Extension)

A browser extension (Chrome/Firefox) that extracts transcripts from YouTube videos and summarizes them using your AI of choice — Claude, ChatGPT, Gemini, Groq, OpenRouter, or any local OpenAI-compatible model.

---

## Features at a glance

- **Side panel** (Chrome) / **sidebar** (Firefox) — summarize the video you are watching, streamed live next to it; every `[m:ss]` in the summary seeks the player
- **6 AI providers** — Anthropic Claude, OpenAI, Google Gemini, Groq, OpenRouter, and custom/local endpoints
- **3 operating modes** — Web (paste into the AI chat UI), Transcript Only (download raw text), API (call the AI directly)
- **Batch queue** — add multiple YouTube URLs and process them all at once
- **Bulk add** — paste a whole list of links (one per line, or space/comma-separated) and queue them in one click
- **Playlist expansion** — paste a playlist URL and every video in it is fetched and queued automatically
- **Per-video settings** — override format and summary length for each video individually
- **Summary length** — Short, Normal, or Long presets, each with English and Italian prompts
- **Output format** — Markdown (`.md`) or plain Chat format
- **Reliable extraction** — InnerTube ANDROID/iOS clients first, with page and real-tab fallbacks, plus a coverage check so a partial transcript is never passed off as complete
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
| **Groq** | — | ✅ | Fast open models (gpt-oss) |
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

## Side panel

Click **◨** in the popup header to open the side panel (Chrome) or sidebar (Firefox). It follows the YouTube video in the active tab — including YouTube's in-page navigation — and **Summarize** streams the summary as it is written. **Stop** really stops it (the request is cancelled and nothing half-finished is cached). The summary supports headings, nested lists, tables and code; every `[m:ss]` is a link that jumps the player to that moment. **📋 Copy** copies the Markdown, **⬇ .md** saves it.

The side panel calls the provider's API directly, so it needs an API key (⚙️ in the panel; Google Gemini and Groq have free tiers) or a custom/local endpoint. Language, summary length and prompt are shared with the popup. The last 100 summaries are cached per video.

---

## Other features

### 📋 Video history
Click the **📋** button in the header to view a log of all videos processed, with title, URL, and timestamp. Click any entry to open the video.

### 🧠 Thinking mode
Available in API mode and in the side panel for Claude models. Current models get adaptive thinking at high effort (Claude 5.x models think by default; the chip makes them think harder); older models with a fixed thinking budget get that instead.

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

Install directly from the [Firefox Add-ons page](https://addons.mozilla.org/it/firefox/addon/yt-transcript-summarizer/). Requires Firefox 140+.

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

### Long transcripts

Current models take a whole transcript in one request, so there is no manual split: API mode and the side panel send it in one go (clamped to a generous per-provider budget, with a warning in the output if anything had to be cut).

**Web mode** is the exception, because a chat composer has its own hard limit far below the model's context — Gemini keeps the first 32 000 characters of a message and silently drops the rest. When one message would not fit, the transcript is split *just enough* to fit (prompt and part note included), at line/sentence boundaries, and the parts are pasted one after another into the same conversation; the extension waits for each answer before sending the next. This needs **↵ Auto-submit** (or the *separate tabs* mode): without it only part 1 could be delivered, so the transcript is sent whole and the status line says how far over the limit it is. With **💾 Save .txt** each part is also written to its own `_part1of3.txt` file.

The status line stays at **📤 Sending to …** until the chat tab confirms what actually landed — only then does it become **✅ Sent**. A paste that fails, or a sequence that stops halfway, reports **⚠️ Only part *n* of *m*** / **❌ Paste failed** and raises a desktop notification.

**Merge** (Advanced Settings) asks for one more answer that fuses the partial summaries. The extension reads the partial answers back out of the page and pastes them into the merge message rather than relying on the chat's memory — measured on a four-part video, "merge the summaries above" covered only the last two parts. If the answers cannot be read back, the merge goes out as a plain follow-up and the status line says it **relied on the chat's memory**.

### Web mode auto-paste / auto-submit

Enable **📋 Auto-paste** to have the transcript automatically pasted into the chat input when the AI tab opens. Enable **↵ Auto-submit** to also press Send (implies auto-paste).

Auto-paste is supported for Claude.ai, ChatGPT, and Gemini via dedicated content scripts. The extension includes a robust retry mechanism to ensure successful auto-submission even if the AI web interface takes a few seconds to load.

### Custom / local endpoint

Select **Custom** as the provider, enter your endpoint URL (e.g. `http://localhost:11434/v1/chat/completions` for Ollama) in Advanced Settings, and type the model name in the model field.

---

## Transcript extraction

The extension tries three strategies in order, moving on when one fails or returns only part of the video:

1. **InnerTube Player API** — YouTube's internal player endpoint with the Android, then iOS client (two independent attestation paths that still return caption URLs without a PO token). About a second.
2. **Watch page** — downloads the watch page with your cookies and reads its caption tracks, then tries the `get_transcript` endpoint. Since YouTube began requiring a PO token on the web client's caption URLs this rarely succeeds; it is kept as a second chance.
3. **Real tab fallback** — opens the video in a background tab and reads the transcript from inside the page (reuses an existing tab if the video is already open).

Each result is checked against the video's duration: a transcript covering less than 80 % of it is only used if nothing better turns up, and the output says so. Diagnostics go to the service worker console; an HTTP 429 there means YouTube is rate-limiting your IP for a few minutes.

---

## Supported models

Suggestions as of October 2026, checked against each provider's model and deprecation pages:

| Provider | Default | Also suggested |
|---|---|---|
| Anthropic | `claude-sonnet-5-5` | `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-opus-4-8` |
| OpenAI | `gpt-6.1-sol` | `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol` |
| Gemini | `gemini-3.8-flash` | `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview` |
| Groq | `openai/gpt-oss-120b` | `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` |
| OpenRouter | `anthropic/claude-sonnet-5.5` | any model on openrouter.ai |
| Custom | — | type the model name |

A stored model the provider has shut down (Gemini 1.5/2.0, Groq Llama 3.x, Claude 3.x, OpenAI o1 / gpt-4-turbo, …) is replaced by the current default automatically, so an old setting cannot turn into a stream of API errors.

> **Model field & keeping it current.** For every provider the model field is an editable combobox: the known models appear as dropdown suggestions, but you can always **type any model name** — so a new release is never blocked by a stale list. The suggestions live in one place, [`modules/config.js`](modules/config.js) (`PROVIDERS` → each provider's `models` array, plus `defaultModel`). Updating them is now optional cosmetic maintenance, not a requirement: if a suggestion is outdated, just type the current model name.

---

## Permissions

| Permission | Reason |
|------------|--------|
| `storage`, `unlimitedStorage` | Settings, API keys, job queue, history and cached summaries, all local |
| `tabs` | Read the current tab URL; open provider chat tabs; follow the active video in the side panel |
| `scripting` | Transcript extraction inside a YouTube tab (fallback strategy); seeking the player |
| `downloads` | Save transcript and summary files |
| `notifications` | Notify when batch processing completes |
| `alarms` | Keep the service worker alive during long-running jobs |
| `offscreen` (Chrome) | Text-to-Speech playback and blob URLs for large downloads |
| `declarativeNetRequest` | Give InnerTube requests a youtube.com Origin (see `rules.json`) |
| `sidePanel` (Chrome) | The side panel |
| `http://localhost/*`, `http://127.0.0.1/*` | Local models (Ollama, LM Studio) and an optional local TTS server |
| optional `https://*/*` | Requested at run time, only for a custom endpoint on another host |

---

## Files

```
manifest.json           Manifest V3, with both Chrome and Firefox keys
background.js           Service worker / event page: extraction, batch runner, API calls
popup.html/css/js       Popup: queue, modes, providers, batch
sidepanel.html/css/js   Side panel / sidebar: live summary of the current video
options.html/css/js     Options page: API key, prompt templates
content_youtube.js      Seek bridge for [m:ss] links
*_paste.js, paste_common.js   Content scripts that paste into Claude.ai, ChatGPT, Gemini
tts_offscreen.*         Offscreen document (Text-to-Speech, blob URLs)
rules.json              declarativeNetRequest Origin/Referer rewrite for InnerTube
modules/
  config.js             Providers, models, prompts, YouTube client config
  llm-stream.js         The one streaming client for every provider
  llm-api.js            Batch summaries, web-mode splitting and merge
  markdown.js           Dependency-free Markdown renderer (side panel)
  transcript-parse.js   Caption parsing, timestamps, coverage check
  youtube-api.js        Transcript extraction strategies, playlist paging
  downloads.js          Safe filenames, large downloads
  popup-*.js, ui-utils.js, utils.js, i18n.js
test/                   `npm test` suites; test/e2e/ drives a real browser
tools/build-zip.mjs     Store packages
```

---

## Known compatibility issues

### Duplicate-tab prevention extensions

Extensions like *Prevent Duplicate Tabs* can block Strategy 3 (tab fallback) from opening a YouTube background tab. The extension already minimises this by reusing an open tab for the video if one exists — so the conflict only occurs when Strategies 1–2 both failed **and** the video isn't already open in a tab.

**Fix:** add `youtube.com` to the allowlist of the duplicate-tab extension.

---

## Development

```bash
npm test          # unit and wiring tests (Node 22+, no dependencies to install)
npm run build     # dist/yt-transcript-summarizer-<version>-{chrome,firefox}.zip
```

`manifest.json` carries both browsers' keys so the folder loads unpacked in either; the build writes one manifest per store with only the keys that browser understands. [ROADMAP.md](ROADMAP.md) lists what is not built yet.

---

## License

MIT
