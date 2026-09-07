# PLAN.md — YouTube Transcript Summarizer v2

L'estensione esistente rifatta **solo molto meglio**: interfaccia persistente in **Chrome Side Panel** (non si chiude cliccando sulla pagina), riassunti in **streaming in tempo reale (SSE)** con invio a **passaggio singolo** (niente split artificiali a pezzi), **timestamp cliccabili** che muovono il player di YouTube, e copie/download puliti. Zero funzioni superflue o bloat inutile.

---

## 1. How this plan is executed

### 1.1 The gates

Every commit must leave all of these green. They are the only definition of "it works" that both you and the agent share, so they must be exact commands, runnable from a stated directory, with a stated expected result.

| Gate | Command | Green means |
|---|---|---|
| unit tests | `npm test` | exit 0 (all test suites pass) |

### 1.2 Rules of engagement

1. **One task, one commit.** Conventional Commit message (`feat:`, `fix:`, `refactor:`, `test:`). A task that cannot be one commit is two tasks.
2. **Gates green before every commit**, not at the end of the phase.
3. **No extra bloat or unnecessary functions.** Mantenere lo scopo originale dell'estensione (estrarre trascrizione, riassumere, copiare, scaricare) facendolo in modo moderno ed efficiente.
4. **No external runtime dependencies.** ES modules vanilla per Manifest V3; niente bundler, niente npm a runtime.
5. **No behaviour change inside a refactor commit.**
6. **If a task turns out to be wrong or impossible, stop and report.** Do not improvise.
7. **Tick the ledger only after the commit exists.**

### 1.3 Session protocol

Each run executes exactly one phase (or one task via `phasekit run X.Y`) and stops.

---

## 2. Invariants

1. **InnerTube PO-Token Bypass (`modules/youtube-api.js` & `rules.json`)** — La catena di fallback client (Android -> iOS -> TV -> Web) e le regole DeclarativeNetRequest (`rules.json`) aggirano i blocchi 403 / BotGuard senza richiedere login o cookie. Non toccare questa logica fondamentale.
2. **Zero-Dependency Vanilla Runtime** — L'estensione si carica non pacchettizzata direttamente dalla cartella `web_extension/`.
3. **Robustezza Parsing Trascrizioni (`modules/transcript-parse.js`)** — Conservare la gestione di formati `json3`, `srv3`, rimozione rumori di fondo (`[Musica]`) e continuità temporale.
4. **Nessuno Split Artificiale a Caratteri** — I modelli LLM moderni (Gemini, Claude, GPT-4o, Groq) ricevono l'intera trascrizione in una singola richiesta streaming. Eliminare slider di parti, checkbox di merge e spezzettamenti a 32k.
5. **Sincronizzazione Seek del Player** — Il clic su un timestamp `[mm:ss]` nel riassunto deve posizionare il video di YouTube al tempo indicato (`player.seekTo(t, true)`).

---

## 3. Code Recycling & Architecture Audit

Valutazione mirata: cosa riciclare per non reinventare la ruota, cosa eliminare per togliere complessità inutile, e cosa rendere migliore.

| Modulo / File | Verdetto | % Riuso | Motivazione & Decisione |
|---|---|:---:|---|
| `modules/youtube-api.js` | **RICICLA AL 100%** | 100% | **Asset essenziale.** Aggira i blocchi BotGuard/PO-Token con il fallback client InnerTube. Funziona perfettamente, zero motivi per complicarlo o riscriverlo. |
| `modules/transcript-parse.js` | **RICICLA AL 100%** | 100% | Estrae e pulisce perfettamente i sottotitoli con timestamp e durata. Coperto da 11 test unitari. Si mantiene intatto. |
| `rules.json` | **RICICLA AL 100%** | 100% | Regole DNR per riscrivere `Origin` e `Referer` verso InnerTube. Si mantiene intatto. |
| `modules/downloads.js` | **RICICLA AL 100%** | 100% | Funzioni semplici e collaudate per scaricare file Markdown o TXT con un click. |
| `tts_offscreen.*` | **RICICLA AL 100%** | 100% | Documento offscreen per Text-to-Speech. |
| `modules/config.js` | **RICICLA CON PURGA** | 70% | **Si mantiene**: Configurazione InnerTube, API key, prompt e modelli. **Si elimina**: Tutta la complessità dello split del 27 luglio (`chunking`, `maxWebMessageChars`, `CHUNK_NOTES`). **Si aggiunge**: Supporto a Groq e Gemini 2.5 Flash. |
| `modules/llm-api.js` | **SOSTITUISCI CON VERSIONE STREAMING** | 10% | Il vecchio file usava chiamate REST sincrone bloccanti (spinner fermo per 30s) e pipeline di merge parziali. Viene sostituito dal modulo leggero `modules/llm-stream.js` che usa Server-Sent Events (SSE) per mostrare il testo mentre viene generato. |
| `popup.*` | **SEMPLIFICA** | 60% | Conserva la coda batch e l'aggiunta rapida del video. Rimuove slider e opzioni di split/merge. Aggiunge pulsante "Apri nel Side Panel". |
| `sidepanel.*` | **NUOVO (CORE V2 ESSENZIALE)** | 0% (Nuovo) | Risolve il vero difetto del popup: rimane aperto a fianco del video mentre navighi o guardi YouTube, mostra il riassunto in streaming e i timestamp cliccabili. Zero funzioni extra o bloat inutile (niente chatbot complessi o esportatori proprietari). |
| `content_youtube.js` | **NUOVO (MINIMALE)** | 0% (Nuovo) | Script leggerissimo (poche righe) iniettato in YouTube per eseguire il `seekTo(seconds)` quando l'utente clicca su un timestamp nel Side Panel. |

---

## 4. Phase 0 — Baseline & De-Chunking Cleanup

**Why this phase exists:** Rimuovere il codice e le opzioni dello split del 27 luglio da configurazione e UI, lasciando il codice pulito e i test esistenti verdi.

### 0.1 Purge Split/Chunking Configuration from `modules/config.js`

**Problem.** `modules/config.js` contiene proprietà obsolete di split (`chunking`, `maxWebMessageChars`, `CHUNK_NOTES`) che creano complessità inutile e spezzavano artificialmente i prompt.

**Change.** In `modules/config.js`:
- Rimuovere la proprietà `chunking` da `DEFAULT_CONFIG`.
- Rimuovere `maxWebMessageChars` e le istruzioni `CHUNK_NOTES`.
- Aggiungere modelli moderni e veloci nei preset (Groq `llama-3.3-70b-versatile`, Gemini `gemini-2.5-flash`).

**Blast radius.** `modules/config.js`, `test/chunking.test.mjs`.

**Done when.** `npm test` passa con codice 0 e `modules/config.js` non contiene riferimenti a `chunking`.

### 0.2 Remove Artificial Split UI Controls from `popup.html` and `popup.js`

**Problem.** In `popup.html` e `popup.js` sono presenti controlli superflui per selezionare il numero di parti (`#split-select-inline`, `#chip-merge`, `#split-cap-note`).

**Change.**
- In `popup.html`: rimuovere `#split-select-inline`, `#chip-merge` e `#split-cap-note`. Aggiungere `#open-sidepanel-btn` nella testata.
- In `popup.js`: rimuovere i listener e lo stato associati allo split.

**Blast radius.** `popup.html`, `popup.css`, `popup.js`.

**Done when.** La UI del popup è pulita e priva di controlli di split, e `npm test` passa con codice 0.

---

## 5. Phase 1 — Manifest V3 Side Panel & YouTube Seek Bridge

**Why this phase exists:** Permettere all'estensione di aprirsi nel pannello laterale persistente di Chrome e fornire il ponte minimo per saltare nel video di YouTube.

### 1.1 Manifest V3 Side Panel & Content Script Declarations

**Problem.** `manifest.json` non dichiara il permesso `sidePanel` né la pagina `sidepanel.html`, impedendo l'uso del pannello laterale nativo di Chrome.

**Change.** In `manifest.json`:
- Aggiungere `"sidePanel"` a `"permissions"`.
- Aggiungere `"side_panel": { "default_path": "sidepanel.html" }`.
- Registrare `content_youtube.js` sotto `"content_scripts"` per `*://*.youtube.com/watch*` con `run_at: "document_idle"`.

**Blast radius.** `manifest.json`.

**Done when.** `manifest.json` è valido, include `"sidePanel"`, e `npm test` passa.

### 1.2 YouTube Player Seek Bridge (`content_youtube.js`)

**Problem.** Il Side Panel non può interagire con il player video della pagina senza uno script di contenuto iniettato.

**Change.** Creare `content_youtube.js` (script minimale e robusto):
- Ascolta messaggi runtime da background/sidepanel:
  - `GET_VIDEO_INFO`: Restituisce `{ videoId, currentTime, duration, title }`.
  - `SEEK_TO`: Esegue `document.querySelector('#movie_player')?.seekTo(message.seconds, true)` o imposta `video.currentTime`.

**Blast radius.** Nuovo file `content_youtube.js`.

**Done when.** `content_youtube.js` esiste, privo di errori di sintassi, e `npm test` passa.

---

## 6. Phase 2 — Universal Streaming LLM Client

**Why this phase exists:** Sostituire le vecchie chiamate sincrone bloccanti con uno streaming reattivo token-by-token (SSE) a passaggio unico.

### 2.1 Universal Single-Pass Streaming LLM Client (`modules/llm-stream.js`)

**Problem.** L'estensione precedente attendeva il completamento dell'intera risposta con uno spinner fermo per decine di secondi. Se la richiesta falliva a metà, non c'era feedback.

**Change.** Creare `modules/llm-stream.js`:
- Esportare `async function* streamCompletion({ provider, apiKey, model, messages, systemPrompt, signal })`:
  - Gestisce SSE standard per Anthropic, OpenAI, Gemini e Groq.
  - Genera via yield token incrementali: `{ type: 'token', text: string }`.
  - Gestione chiara degli errori HTTP (401 per API key errata, 429 per rate limit).
- Nessuna logica di merge o frammentazione a pezzi: il testo viene inviato integro.

**Blast radius.** Nuovo file `modules/llm-stream.js`.

**Done when.** `modules/llm-stream.js` esiste, esporta `streamCompletion`, e `npm test` passa.

---

## 7. Phase 3 — Streamlined Side Panel UI & Controller

**Why this phase exists:** Creare l'interfaccia principale dell'estensione: persistente a fianco del video, focalizzata al 100% su trascrizione, riassunto immediato e timestamp cliccabili.

### 3.1 Streamlined Side Panel HTML & Modern CSS (`sidepanel.html`, `sidepanel.css`)

**Problem.** Il popup tradizionale si chiude appena l'utente clicca sul video. Serve un'interfaccia laterale persistente, pulita e moderna, senza bloat superfluo.

**Change.**
- Creare `sidepanel.html`:
  - Testata minimale con titolo video corrente e pulsante impostazioni rapide (Provider / API Key / Lingua).
  - Azioni primarie: "Riassumi Video" (bottone principale), "Copia Trascrizione", "Salva .md".
  - Area riassunto: contenitore Markdown con supporto allo streaming in tempo reale.
  - Zero tab complesse o funzioni superflue: focus totale sulla sintesi e sulla trascrizione.
- Creare `sidepanel.css`:
  - Tema scuro elegante (CSS custom properties), tipografia chiara, scrollbar rifinita, animazione fluida del cursore di streaming.

**Blast radius.** Nuovi file `sidepanel.html`, `sidepanel.css`.

**Done when.** File creati con markup semantico e stili privi di errori, e `npm test` passa.

### 3.2 Side Panel Controller: Live Streaming & Timestamp Seek (`sidepanel.js`)

**Problem.** Il pannello laterale deve identificare il video attivo, estrarre la trascrizione, inviarla al client streaming e rendere i timestamp interattivi.

**Change.** Creare `sidepanel.js`:
- Rileva automaticamente la scheda YouTube attiva (`chrome.tabs.query({ active: true, currentWindow: true })`).
- Recupera la trascrizione riutilizzando al 100% `modules/youtube-api.js` e `modules/transcript-parse.js`.
- Al clic su "Riassumi":
  - Avvia lo streaming da `modules/llm-stream.js`.
  - Converte al volo i timestamp nel formato `[mm:ss]` o `[hh:mm:ss]` in link interattivi.
  - Cliccando sul timestamp, invia il messaggio `SEEK_TO` a `content_youtube.js` per saltare istantaneamente nel video.
- Azioni rapide: "Copia Riassunto" e "Scarica .md".

**Blast radius.** Nuovo file `sidepanel.js`.

**Done when.** `sidepanel.js` è integrato con `youtube-api.js` e `llm-stream.js`, e `npm test` passa.

---

## 8. Phase 4 — Background Routing & Verification

**Why this phase exists:** Collegare l'apertura del Side Panel dalle azioni della toolbar e garantire che tutti i test e la build dell'estensione passino senza errori.

### 4.1 Side Panel Activation & Background Routing (`background.js`, `popup.js`)

**Problem.** L'utente deve poter aprire il Side Panel con un click dal popup o tramite azione dell'estensione.

**Change.**
- In `background.js`:
  - Aggiungere il listener per il messaggio `OPEN_SIDEPANEL` che invoca `chrome.sidePanel.open({ tabId })`.
- In `popup.js`:
  - Collegare il pulsante `#open-sidepanel-btn` per inviare `OPEN_SIDEPANEL` e aprire il pannello laterale.

**Blast radius.** `background.js`, `popup.js`.

**Done when.** `background.js` e `popup.js` gestiscono `OPEN_SIDEPANEL` e `npm test` passa.

### 4.2 Verification & Gates Green

**Problem.** Assicurarsi che le nuove funzionalità non rompano la validità dell'estensione o le suite di test esistenti.

**Change.**
- Eseguire `npm test` per verificare la completa assenza di regressioni.
- Eseguire `npm run build:dry` per verificare che il pacchetto dell'estensione sia integro e pronto per l'uso.

**Blast radius.** Test suite ed esportazione dell'estensione.

**Done when.** `npm test` e `npm run build:dry` terminano entrambi con exit code 0.

---

## 9. Progress ledger

- [x] 0.1 Purge Split/Chunking Configuration from modules/config.js
- [x] 0.2 Remove Artificial Split UI Controls from popup.html and popup.js
- [x] 1.1 Manifest V3 Side Panel & Content Script Declarations
- [x] 1.2 YouTube Player Seek Bridge (content_youtube.js)
- [x] 2.1 Universal Single-Pass Streaming LLM Client (modules/llm-stream.js)
- [x] 3.1 Streamlined Side Panel HTML & Modern CSS (sidepanel.html, sidepanel.css)
- [x] 3.2 Side Panel Controller: Live Streaming & Timestamp Seek (sidepanel.js)
- [x] 4.1 Side Panel Activation & Background Routing
- [x] 4.2 Verification & Gates Green
