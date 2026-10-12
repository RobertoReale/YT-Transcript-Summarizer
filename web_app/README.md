# YT Summarizer — Web App

Mobile-first Progressive Web App (PWA) for extracting YouTube transcripts and preparing AI summaries. Designed for quick, on-the-go use from a smartphone.

Part of the [YT Transcript Summarizer](../README.md) project. For the desktop browser extension see [`../web_extension/`](../web_extension/) — Firefox users can install it directly from the [Firefox Add-ons page](https://addons.mozilla.org/it/firefox/addon/yt-transcript-summarizer/).

---

## Features

- Paste a YouTube URL, choose a provider and summary length, and get a ready-to-paste prompt in seconds
- Supported AI providers: **Anthropic Claude**, **OpenAI**, **Google Gemini**
- Languages: **English**, **Italian**
- Summary lengths: **Short** (key takeaways), **Normal** (detailed), **Long** (in-depth)
- Editable prompt before copying
- **Copy & Open** — copies the prompt to the clipboard and opens the provider's chat UI in one tap
- **Share** — native Web Share API for passing the prompt to any app
- **Strategy badge** — shows which extraction method succeeded (amber for Supadata with quota warning, green for all others)
- **7-day transcript cache** — repeated requests for the same video are served instantly from localStorage
- Recent video history (stored locally)
- Dark / light theme toggle
- Installable as a PWA (Add to Home Screen)

---

## How it works

The transcript is extracted server-side via a Next.js API route. Strategies are tried in order until one succeeds:

1. **InnerTube Player API** — Android, iOS and TV clients; caption URLs from these need no PO token. Free and fast, and the one that works from a home connection.
2. **Supadata API** — paid service that works around YouTube's blocks on datacenter IPs (only with a key: `SUPADATA_API_KEY` or the in-app ⚙️ settings)
3. **TranscriptAPI.com** — same idea, alternative provider (only with a key)
4. **Watch page** — reads caption URLs from the watch page HTML, then tries `get_transcript`
5. **Legacy timedtext API**
6. **`youtube-transcript` npm package** — community library as a last resort

**Hosting note.** YouTube often answers requests from cloud/datacenter IPs (Vercel included) with "Sign in to confirm you're not a bot" or HTTP 429. If extraction fails on your deployment but works with `npm run dev` at home, that is why — add a Supadata or TranscriptAPI key, or use the browser extension, which runs from your own connection.

The Piped/Invidious rotator and the Whisper fallback were removed in 1.6.0: Piped has shut down, the listed Invidious instances are gone, and the Cobalt API the Whisper fallback used to fetch audio was switched off in November 2024.

After a successful extraction, the result is cached in localStorage for 7 days. Subsequent requests for the same video skip the API call entirely and show the strategy name with `(cached)`.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPADATA_API_KEY` | Optional | Enables Strategy 1 (Supadata). Free tier: 100 requests/month. Without it the app falls through to Strategy 2. |

Set in a `.env.local` file for local development, or in the Vercel project settings for production.

---

## Tech stack

- [Next.js](https://nextjs.org/) (App Router, Turbopack)
- [React](https://react.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- TypeScript 5

---

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm run build   # production build
npm run start   # start production server
npm run lint    # ESLint
```

---

## Deployment

### Vercel (recommended)

**Option A — Vercel dashboard (no CLI needed)**

1. Push the repository to GitHub (or GitLab / Bitbucket).
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. In the **Configure Project** step set **Root Directory** to `web_app/`.  
   Vercel auto-detects Next.js — no build command changes needed.
4. Add the environment variable `SUPADATA_API_KEY` under **Environment Variables** (optional, see below).
5. Click **Deploy**. Vercel assigns a `*.vercel.app` URL immediately.

On every subsequent push to `main` (or the branch you chose) Vercel rebuilds and redeploys automatically.

**Option B — Vercel CLI**

```bash
npm i -g vercel      # install once globally
cd web_app
vercel               # first deploy: follow the interactive prompts
vercel --prod        # promote to production after testing
```

To set the secret from the CLI:

```bash
vercel env add SUPADATA_API_KEY production
```

**Custom domain**

In the Vercel project dashboard → **Settings → Domains**, add your domain and follow the DNS instructions.

---

### Other Node.js hosts

Any platform that supports Next.js works (Railway, Render, Fly.io, self-hosted Node).  
Run `npm run build` then `npm run start`. Set `SUPADATA_API_KEY` in the host's environment variables panel if desired.

`SUPADATA_API_KEY` and `TRANSCRIPTAPI_KEY` are optional — without them those two strategies are skipped.

---

## Project structure

```
src/
├── app/
│   ├── page.tsx              Main page (form, cache, strategy badge, prompt editor, history)
│   ├── layout.tsx            Root layout, PWA metadata, fonts
│   ├── globals.css           Tailwind base + theme variables
│   └── api/transcript/
│       └── route.ts          POST /api/transcript — extraction with fallbacks, streamed as SSE
├── components/
│   ├── TranscriptForm.tsx    URL input, provider/language/length selectors
│   ├── ActionButtons.tsx     Copy & Open, Share
│   └── SettingsModal.tsx     Optional Supadata / TranscriptAPI keys
└── lib/
    ├── config.ts             Providers, prompts, YouTube API config
    ├── youtube-api.ts        Transcript extraction strategies
    └── utils.ts              sleep, fetchWithTimeout, findInObject
```

---

## License

MIT
