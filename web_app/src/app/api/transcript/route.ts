/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
  fetchViaSupadata,
  fetchViaAndroidPlayer,
  fetchViaGetTranscript,
  fetchViaTimedText,
  fetchViaYoutubeTranscriptPackage,
  fetchViaTranscriptAPI,
} from '@/lib/youtube-api';

// Allow long-running extraction for videos up to 2+ hours (Vercel/serverless)
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:v=|youtu\.be\/|shorts\/|embed\/|\/v\/|\/live\/)([0-9A-Za-z_-]{11})/
  );
  return match ? match[1] : null;
}

async function fetchVideoTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.title as string) || null;
  } catch {
    return null;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────
// 20s buffer: the in-progress strategy's fetch can take up to 15s after the
// timer fires. We need to finish and flush the SSE response before Vercel's
// hard maxDuration=120s deadline kills the process.
const GLOBAL_TIMEOUT_MS = 100_000;

export async function POST(request: Request) {
  // ── Synchronous validation (no streaming needed for instant errors) ─────
  let body: { 
    url?: string; 
    lang?: string;
    apiKeys?: { supadata?: string; transcriptApi?: string };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { url, lang = 'en', apiKeys } = body;

  if (!url) {
    return NextResponse.json(
      { error: 'Missing YouTube URL' },
      { status: 400 }
    );
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return NextResponse.json(
      { error: 'Invalid YouTube URL' },
      { status: 400 }
    );
  }

  // ── SSE streaming response ─────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          /* controller may be closed if client disconnected */
        }
      };

      const log = (msg: string) => send({ type: 'log', message: msg });

      type TranscriptResult = { title: string; transcript: string };
      let result: TranscriptResult | null = null;
      let strategy = '';
      let timedOut = false;

      /** Returns true if we should try the next strategy. */
      const shouldContinue = (): boolean =>
        !timedOut && !request.signal.aborted && !result;

      // ── Global timeout ─────────────────────────────────────────────────
      // Prevents the entire strategy chain from running forever.
      // When it fires, the current in-progress strategy finishes but no new
      // ones start.
      const globalTimer = setTimeout(() => {
        timedOut = true;
      }, GLOBAL_TIMEOUT_MS);

      // Cheapest and most reliable first. The InnerTube ANDROID/iOS clients
      // return caption URLs that need no PO token; the paid services (only
      // when a key is configured) are the answer when YouTube blocks this
      // server's IP; the rest are long shots kept as free last resorts.
      // Piped/Invidious and the Cobalt-based Whisper fallback were removed:
      // Piped shut down, the listed Invidious instances are gone, and the
      // Cobalt v7 API was switched off in November 2024.
      const strategies: Array<[string, () => Promise<TranscriptResult | null>]> = [
        ['Android Player', () => fetchViaAndroidPlayer(videoId, log, lang)],
        ['Supadata API', () => fetchViaSupadata(videoId, log, lang, apiKeys?.supadata)],
        ['TranscriptAPI', () => fetchViaTranscriptAPI(videoId, log, lang, apiKeys?.transcriptApi)],
        ['Watch Page', () => fetchViaGetTranscript(videoId, log, lang)],
        ['Timedtext API', () => fetchViaTimedText(videoId, log, lang)],
        ['youtube-transcript', () => fetchViaYoutubeTranscriptPackage(videoId, log, lang)],
      ];

      try {
        for (const [name, run] of strategies) {
          if (!shouldContinue()) break;
          try {
            const r = await run();
            if (r?.transcript) {
              result = r;
              strategy = name;
            }
          } catch (e: any) {
            log(`${name} error: ${e.message}`);
          }
        }

        clearTimeout(globalTimer);

        if (timedOut && !result) {
          log(
            `⏱ Global timeout reached (${GLOBAL_TIMEOUT_MS / 1000}s). Stopped trying further strategies.`
          );
        }

        // ── No result ────────────────────────────────────────────────────
        if (!result?.transcript) {
          send({
            type: 'error',
            message: 'No transcript found or could not be extracted.',
          });
          controller.close();
          return;
        }

        // ── Success ──────────────────────────────────────────────────────

        const title =
          result.title && result.title !== videoId
            ? result.title
            : ((await fetchVideoTitle(videoId)) ?? videoId);

        send({
          type: 'result',
          title,
          transcript: result.transcript,
          strategy,
          truncated: false,
          timedOut,
        });
      } catch (error: any) {
        clearTimeout(globalTimer);
        send({
          type: 'error',
          message: error.message || 'Internal Server Error',
        });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx/reverse-proxy buffering
    },
  });
}
