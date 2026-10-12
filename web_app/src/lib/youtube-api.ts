/* eslint-disable @typescript-eslint/no-explicit-any */
import { YoutubeTranscript } from 'youtube-transcript';
import { CONFIG } from './config';
import { fetchWithTimeout, findInObject } from './utils';

export async function fetchViaSupadata(
  videoId: string,
  log: (msg: string) => void,
  lang = 'en',
  customApiKey?: string
): Promise<{ title: string; transcript: string } | null> {
  const apiKey = customApiKey || process.env.SUPADATA_API_KEY;
  if (!apiKey) {
    // We don't log "skipping" here by default to avoid clutter, 
    // unless you want to explicitly notify the user
    return null;
  }

  log('Trying Supadata API...');
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const langParam = lang === 'auto' ? 'en' : lang;

  const supadataFetch = async (l: string) => {
    const resp = await fetchWithTimeout(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&lang=${l}&text=true`,
      { headers: { 'x-api-key': apiKey } },
      55000 // Increased timeout to 55s for Supadata since transcription can take long
    );
    const rawBody = await resp.text().catch(() => '');
    log(`Supadata [HTTP ${resp.status}] raw: ${rawBody.slice(0, 500)}`);
    if (!resp.ok) return null;
    try {
      return JSON.parse(rawBody) as { content?: string; lang?: string; availableLangs?: string[] };
    } catch {
      if (rawBody.length > 10) return { content: rawBody };
      return null;
    }
  };

  try {
    let data = await supadataFetch(langParam);
    if (!data) return null;

    let transcript = typeof data.content === 'string' ? data.content : null;

    if ((!transcript || transcript.length < 10) && Array.isArray(data.availableLangs) && data.availableLangs.length > 0) {
      const fallbackLang = data.availableLangs[0];
      log(`Supadata: lang=${langParam} not found, retrying with ${fallbackLang}...`);
      data = await supadataFetch(fallbackLang);
      if (!data) return null;
      transcript = typeof data.content === 'string' ? data.content : null;
    }

    if (!transcript || transcript.length < 10) {
      log(`Supadata: no transcript available (availableLangs=${JSON.stringify(data.availableLangs)})`);
      return null;
    }

    log(`Supadata: ✅ ${transcript.length} chars (lang=${data.lang})`);
    return { title: videoId, transcript };
  } catch (e: any) {
    log(`Supadata: ${e.message}`);
    return null;
  }
}

type CaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string };

/**
 * Pick a caption track: exact language, then same base language, then English,
 * preferring a human-written track over the auto-generated (ASR) one — the
 * first match by language alone is often the ASR track even when a manual one
 * exists. Same rules as the browser extension's pickTrack().
 */
function pickTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | null {
  if (!tracks.length) return null;
  const scored = tracks.map((t, i) => {
    const code = String(t.languageCode || '');
    let s = 0;
    if (lang && lang !== 'auto') {
      if (code === lang) s += 100;
      else if (code.split('-')[0] === lang) s += 80;
      else if (code.split('-')[0] === 'en') s += 20;
    }
    if (t.kind !== 'asr') s += 10;
    return { t, i, s };
  });
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored[0].t.baseUrl ? scored[0].t : (tracks.find(t => t.baseUrl) || null);
}

export async function fetchViaAndroidPlayer(
  videoId: string,
  log: (msg: string) => void,
  transcriptLang = 'en'
): Promise<{ title: string; transcript: string } | null> {
  const clients = [
    { clientName: 'ANDROID', clientVersion: CONFIG.youtube.androidClientVersion, androidSdkVersion: CONFIG.youtube.androidSdkVersion, hl: 'en', gl: 'US', utcOffsetMinutes: 0 },
    { clientName: 'IOS', clientVersion: CONFIG.youtube.iosClientVersion, deviceModel: CONFIG.youtube.iosDeviceModel, deviceMake: 'Apple', osName: 'iPhone', osVersion: CONFIG.youtube.iosOsVersion, hl: 'en', gl: 'US' },
    { clientName: 'TVHTML5', clientVersion: CONFIG.youtube.tvClientVersion, hl: 'en', gl: 'US' }
  ];

  const clientUserAgents: Record<string, string> = {
    ANDROID: `com.google.android.youtube/${CONFIG.youtube.androidClientVersion} (Linux; U; Android 12; GB) gzip`,
    IOS: `com.google.ios.youtube/${CONFIG.youtube.iosClientVersion} like Mobile/1C25 CFNetwork/3826.400.120 Darwin/24.3.0`,
    TVHTML5: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
  };

  for (const clientInfo of clients) {
    log(`Calling /youtubei/v1/player (client ${clientInfo.clientName}) for ${videoId}, lang="${transcriptLang}"`);
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': clientUserAgents[clientInfo.clientName] || clientUserAgents.ANDROID,
          'X-Goog-Api-Key': CONFIG.youtube.apiKey,
        },
        body: JSON.stringify({
          context: { client: clientInfo },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      }, 25000); // Increased timeout to 25s

      if (!resp.ok) { log(`${clientInfo.clientName}: HTTP ${resp.status} — skip`); continue; }

      const data = await resp.json();
      const title = data?.videoDetails?.title || videoId;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      log(`${clientInfo.clientName}: title="${title}", tracks=${tracks.length}`);

      if (!tracks.length) {
        const reason = data?.playabilityStatus?.reason || 'unknown';
        log(`${clientInfo.clientName}: No tracks. Playability reason: "${reason}"`);
        continue;
      }

      const track = pickTrack(tracks, transcriptLang);

      if (!track?.baseUrl) { log(`${clientInfo.clientName}: Track has no baseUrl`); continue; }

      const needsTranslation = transcriptLang !== 'auto' &&
        track.languageCode && !track.languageCode.startsWith(transcriptLang);
      log(`${clientInfo.clientName}: Track lang="${track.languageCode}", kind="${track.kind || 'standard'}"${needsTranslation ? ` → tlang=${transcriptLang}` : ''}`);

      let baseUrl = track.baseUrl.replace(/&fmt=[^&]*/g, '');
      if (needsTranslation) baseUrl += `&tlang=${transcriptLang}`;
      for (const suffix of ['&fmt=json3', '', '&fmt=srv3']) {
        try {
          const tResp = await fetchWithTimeout(baseUrl + suffix, {}, 12000);
          if (!tResp.ok) { log(`${clientInfo.clientName}: caption HTTP ${tResp.status}${tResp.status === 429 ? ' (rate-limited by YouTube)' : ''}`); continue; }
          const text = await tResp.text();
          log(`${clientInfo.clientName}: Body length: ${text.length}`);
          if (text.length < 10) { log('Empty body — PO token issue or expired URL'); continue; }
          const parsed = parseTranscriptText(text);
          if (parsed) {
            log(`${clientInfo.clientName}: ✅ Parsed (${parsed.length} chars)`);
            return { title, transcript: parsed };
          }
        } catch (e: any) { log(`Fetch error: ${e.message}`); }
      }
    } catch (e: any) { log(`${clientInfo.clientName}: Exception: ${e.message}`); }
  }

  log('No client succeeded');
  return null;
}

export async function fetchViaGetTranscript(
  videoId: string,
  log: (msg: string) => void,
  transcriptLang = 'en'
): Promise<{ title: string; transcript: string } | null> {
  log(`Fetching YouTube watch page...`);

  let title = videoId;
  let apiKey = CONFIG.youtube.apiKey;
  let clientVersion = CONFIG.youtube.webClientVersion;
  let playerData: any = null;

  // Direct only. Routing the request through public CORS proxies (allorigins,
  // corsproxy.io) handed every user's video choice to third parties, and their
  // HTML still carries caption URLs that need a PO token — no gain for the leak.
  log('Trying direct connection...');
  try {
    const pageResp = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`,
      {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          // Bypass GDPR consent wall served to EU datacenter IPs
          'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        },
      },
      25000
    );
    if (pageResp.ok) {
      const html = await pageResp.text();
      log(`Page downloaded (${html.length} chars)`);
      playerData = extractYtInitialPlayerResponse(html);
      if (playerData) {
        title = playerData?.videoDetails?.title || videoId;
        log(`Title: "${title}"`);
        const km = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/);
        if (km) apiKey = km[1];
        const vm = html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/);
        if (vm) clientVersion = vm[1];
        log(`apiKey=${apiKey.slice(0, 20)}..., clientVersion=${clientVersion}`);
      } else {
        log('No player data found in HTML (bot challenge?)');
      }
    } else {
      log(`HTTP ${pageResp.status}`);
    }
  } catch (e: any) { log(`Page error: ${e.message}`); }

  if (playerData) {
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    log(`Page extraction: ${tracks.length} caption track(s) found`);

    if (tracks.length > 0) {
      const track = pickTrack(tracks, transcriptLang);

      if (track?.baseUrl) {
        const needsTranslation = transcriptLang !== 'auto' &&
          track.languageCode && !track.languageCode.startsWith(transcriptLang);
        log(`Page extraction: using track lang="${track.languageCode}"${needsTranslation ? ` → tlang=${transcriptLang}` : ''}`);
        let baseUrl = track.baseUrl.replace(/&fmt=[^&]*/g, '');
        if (needsTranslation) baseUrl += `&tlang=${transcriptLang}`;
        for (const suffix of ['&fmt=json3', '', '&fmt=srv3']) {
          try {
            const tResp = await fetchWithTimeout(baseUrl + suffix, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              }
            }, 12000);
            if (!tResp.ok) { log(`Page extraction: caption HTTP ${tResp.status}${tResp.status === 429 ? ' (rate-limited by YouTube)' : ''}`); continue; }
            const text = await tResp.text();
            log(`Page extraction: body length ${text.length}`);
            if (text.length < 10) continue;
            const parsed = parseTranscriptText(text);
            if (parsed) {
              log(`Page extraction: ✅ Parsed (${parsed.length} chars)`);
              return { title, transcript: parsed };
            }
          } catch (e: any) { log(`Fetch error: ${e.message}`); }
        }
      }
    }
  }

  log(`Falling back to get_transcript API...`);
  const params = encodeTranscriptParams(videoId);
  log(`params (base64): ${params}`);

  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': clientVersion,
          'Origin': 'https://www.youtube.com',
          'Referer': `https://www.youtube.com/watch?v=${videoId}`,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion,
              hl: 'en',
              gl: 'US'
            }
          },
          params
        })
      },
      15000
    );

    log(`HTTP ${resp.status}`);
    if (!resp.ok) { log(`HTTP error`); return null; }

    const data = await resp.json();
    const transcript = parseGetTranscriptResponse(data, log);

    if (transcript) {
      log(`Transcript extracted (${transcript.length} chars)`);
      return { title, transcript };
    }
    log('No transcript content in response');
    return null;
  } catch (e: any) {
    log(`Exception: ${e.message}`);
    return null;
  }
}

export async function fetchViaTimedText(
  videoId: string,
  log: (msg: string) => void,
  lang = 'en'
): Promise<{ title: string; transcript: string } | null> {
  log('Trying timedtext API...');
  const primary = lang === 'auto' ? 'en' : lang;

  const tryTimedText = async (urlLang: string, extra: string, label: string) => {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${urlLang}${extra}&fmt=json3`;
    try {
      const resp = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
        }
      }, 12000);
      if (!resp.ok) { log(`timedtext ${label}: HTTP ${resp.status}`); return null; }
      const text = await resp.text();
      if (text.length < 10) { log(`timedtext ${label}: empty`); return null; }
      const parsed = parseTranscriptText(text);
      if (parsed) { log(`timedtext ${label}: ✅ ${parsed.length} chars`); return parsed; }
    } catch (e: any) { log(`timedtext ${label}: ${e.message}`); }
    return null;
  };

  // Phase 1: direct captions in the requested language
  for (const extra of ['', '&kind=asr']) {
    const parsed = await tryTimedText(primary, extra, `${primary}${extra}`);
    if (parsed) return { title: videoId, transcript: parsed };
  }

  if (primary !== 'en') {
    // Phase 2: auto-translate English captions → requested language (better than raw English)
    for (const extra of ['', '&kind=asr']) {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en${extra}&tlang=${primary}&fmt=json3`;
      try {
        const resp = await fetchWithTimeout(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Cookie': 'SOCS=CAI; CONSENT=YES+cb',
          }
        }, 12000);
        if (!resp.ok) { log(`timedtext tlang=${primary}${extra}: HTTP ${resp.status}`); continue; }
        const text = await resp.text();
        if (text.length < 10) { log(`timedtext tlang=${primary}${extra}: empty`); continue; }
        const parsed = parseTranscriptText(text);
        if (parsed) {
          log(`timedtext tlang=${primary}${extra}: ✅ ${parsed.length} chars`);
          return { title: videoId, transcript: parsed };
        }
      } catch (e: any) { log(`timedtext tlang=${primary}${extra}: ${e.message}`); }
    }

    // Phase 3: raw English as last resort
    for (const extra of ['', '&kind=asr']) {
      const parsed = await tryTimedText('en', extra, `en${extra} (fallback)`);
      if (parsed) return { title: videoId, transcript: parsed };
    }
  }

  return null;
}

export async function fetchViaYoutubeTranscriptPackage(
  videoId: string,
  log: (msg: string) => void,
  lang = 'en'
): Promise<{ title: string; transcript: string } | null> {
  log('Trying youtube-transcript package...');
  try {
    const langCode = lang === 'auto' ? undefined : lang;
    const items = await YoutubeTranscript.fetchTranscript(videoId, langCode ? { lang: langCode } : {});
    if (!items?.length) { log('youtube-transcript: no items'); return null; }
    const transcript = items.map((i: any) => i.text.replace(/\n/g, ' ').trim()).filter(Boolean).join('\n');
    log(`youtube-transcript: ✅ ${transcript.length} chars`);
    return { title: videoId, transcript };
  } catch (e: any) {
    if (lang !== 'en' && lang !== 'auto') {
      log(`youtube-transcript (${lang}) failed: ${e.message} — retrying en`);
      try {
        const items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
        if (items?.length) {
          const transcript = items.map((i: any) => i.text.replace(/\n/g, ' ').trim()).filter(Boolean).join('\n');
          log(`youtube-transcript (en fallback): ✅ ${transcript.length} chars`);
          return { title: videoId, transcript };
        }
      } catch {
        // Ignored
      }
    }
    log(`youtube-transcript: ${e.message}`);
    return null;
  }
}

function parseTranscriptText(text: string): string | null {
  try {
    const json = JSON.parse(text);
    const lines = (json.events || [])
      .filter((e: any) => e.segs)
      .map((e: any) => e.segs.map((s: any) => s.utf8 || '').join('').replace(/\n/g, ' ').trim())
      .filter((t: any) => t && !/^\[.*\]$/.test(t));
    if (lines.length > 0) return lines.join('\n');
  } catch {
    // Ignored
  }

  // Use [\s\S]*? instead of [^<]* so that inline tags (e.g. <font>) inside
  // <text> elements are captured and then stripped.
  const xmlLines = [...text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(m => m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim())
    .filter(Boolean);
  if (xmlLines.length > 0) return xmlLines.join('\n');

  return null;
}

function extractYtInitialPlayerResponse(html: string): any {
  const idx = html.indexOf('ytInitialPlayerResponse');
  if (idx === -1) return null;
  const jsonStart = html.indexOf('{', idx);
  if (jsonStart === -1) return null;

  let depth = 0, inString = false, escaped = false;
  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(jsonStart, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function encodeTranscriptParams(videoId: string): string {
  // Buffer.from avoids the TextEncoder+btoa path which behaves differently in Node
  const idBytes = Buffer.from(videoId);
  const inner = new Uint8Array([0x0a, idBytes.length, ...idBytes]);
  const outer = new Uint8Array([0x0a, inner.length, ...inner]);
  return Buffer.from(outer).toString('base64');
}

function parseGetTranscriptResponse(data: any, log: (msg: string) => void): string | null {
  const segments = findInObject(data, 'initialSegments');
  if (!segments?.length) {
    log('initialSegments not found in response');
    const renderer = findInObject(data, 'transcriptSegmentListRenderer');
    if (renderer) log(`transcriptSegmentListRenderer found but initialSegments missing`);
    return null;
  }

  const lines = segments
    .map((s: any) => {
      const runs = s?.transcriptSegmentRenderer?.snippet?.runs || [];
      return runs.map((r: any) => r.text || '').join('').replace(/\n/g, ' ').trim();
    })
    .filter((t: any) => t && !/^\[.*\]$/.test(t));

  log(`Segments found: ${segments.length}, valid lines: ${lines.length}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function fetchViaTranscriptAPI(
  videoId: string,
  log: (msg: string) => void,
  lang = 'en',
  customApiKey?: string
): Promise<{ title: string; transcript: string } | null> {
  const apiKey = customApiKey || process.env.TRANSCRIPTAPI_KEY;
  if (!apiKey) {
    // Hidden log by default to avoid clutter, since this is an optional SaaS
    return null;
  }

  log('Trying TranscriptAPI.com fallback...');
  try {
    const resp = await fetchWithTimeout(
      `https://api.transcriptapi.com/v1/youtube/${videoId}?lang=${lang}`,
      {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      },
      20000
    );
    if (!resp.ok) {
      log(`TranscriptAPI HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (data?.transcript) {
      log(`TranscriptAPI: ✅ Transcribed successfully! (${data.transcript.length} chars)`);
      return { title: videoId, transcript: data.transcript };
    }
    return null;
  } catch (e: any) {
    log(`TranscriptAPI: Exception: ${e.message}`);
    return null;
  }
}
