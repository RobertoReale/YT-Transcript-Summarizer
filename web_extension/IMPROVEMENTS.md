# IMPROVEMENTS.md — YouTube Transcript Summarizer v2 Pro

Piano di ottimizzazione avanzata per risolvere il bug critico di Content Security Policy (CSP), gestire in modo intelligente i video molto lunghi (2–4+ ore) e rendere l'estensione reattiva e fluida.

---

## 1. Problema Critico: Blocco CSP su CDN Esterno (`marked.js`)

### Diagnosi
In `sidepanel.html` è presente:
```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```
Nelle estensioni Chrome Manifest V3, **i CDN remoti sono bloccati per motivi di sicurezza** dalla policy `script-src 'self'`. L'estensione fallisce con `Refused to load the script` e al click su "Summarize" solleva `ReferenceError: marked is not defined`.

### Soluzione
1. Rimuovere il tag `<script src="https://...">` da `sidepanel.html`.
2. Creare un modulo interno `modules/markdown.js` autonomo e leggero (senza dipendenze esterne) che:
   - Converte intestazioni (`#`, `##`, `###`), grassetti (`**`), elenchi puntati (`- ` o `* `), corsivi (`*`), blockquote (`>`) e blocchi di codice.
   - Trasforma automaticamente tutti i timestamp nel formato `[mm:ss]` o `[hh:mm:ss]` in link interattivi con attributo `data-time` in secondi:
     ```html
     <a href="#" class="timestamp-link" data-time="185">[03:05]</a>
     ```
3. In `sidepanel.js`, importare ed eseguire `parseMarkdown(rawMarkdown)` direttamente dal modulo locale.

---

## 2. Gestione Intelligente dei Video Molto Lunghi (2–4+ Ore)

Nei video lunghi (fino a 50.000 parole), passare centinaia di timestamp ogni 2 secondi causa amnesia al modello ("lost in the middle") e spreca token.

### Soluzione: Condensazione Semantica Automatica (Pre-processing)
Creare una funzione di condensazione del transcript in `modules/transcript-parse.js` (o `modules/transcript-condense.js`):
1. **Filtro del rumore**: eliminare tag ripetuti come `[Musica]`, `[Applausi]`, pause e ripetizioni ravvicinate di sottotitoli identici.
2. **Aggregazione temporale**: raggruppare i sottotitoli in blocchi logici (paragrafi di testo continuo), posizionando un timestamp `[mm:ss]` ogni 60-90 secondi invece che a ogni singola riga di 2 secondi.
3. **Risultato**: Riduzione immediata del **40–50% dei token** mantenendo il 100% delle parole dette dal relatore. Un video di 4 ore scende da 350.000 caratteri a meno di 180.000, rientrando agevolmente e senza perdite nel contesto di qualsiasi modello (Gemini 2.5 Flash, Claude 3.5/3.7, GPT-4o).

### Struttura del Prompt per Video Lunghi
Per evitare che il modello riassuma solo inizio e fine del video, il prompt deve imporre:
- **Panoramica Esecutiva (Executive TL;DR)**: i 5 concetti e decisioni chiave del video.
- **Indice Cronologico Dettagliato**: suddivisione per blocchi orari con timestamp cliccabili `[mm:ss]`.
- **Argomenti Chiave & Citazioni**: approfondimento di ogni sezione senza salti logici.

---

## 3. Sincronizzazione YouTube SPA (`yt-navigate-finish`)

### Problema
YouTube è una Single Page Application (SPA). Cliccando su un altro video nella barra laterale, la pagina non si ricarica; cambia solo l'URL. Se l'utente non riapre il Side Panel, l'estensione rimane bloccata sul vecchio video.

### Soluzione
1. In `content_youtube.js`:
   - Ascoltare l'evento di navigazione nativo di YouTube:
     ```javascript
     document.addEventListener('yt-navigate-finish', () => {
       const urlParams = new URLSearchParams(window.location.search);
       const videoId = urlParams.get('v');
       if (videoId) {
         chrome.runtime.sendMessage({
           type: 'YOUTUBE_NAVIGATED',
           videoId,
           title: document.title.replace(/ - YouTube$/, '')
         }).catch(() => {});
       }
     });
     ```
2. In `sidepanel.js`:
   - Ascoltare `YOUTUBE_NAVIGATED` o `chrome.tabs.onUpdated`: quando cambia il video, aggiornare il titolo, caricare l'eventuale riassunto in cache e abilitare il pulsante "Summarize".

---

## 4. Cache Locale dei Riassunti (`chrome.storage.local`)

### Problema
Se l'utente chiude il Side Panel per sbaglio o cambia tab e poi torna sullo stesso video, il riassunto va perso e deve essere rigenerato da zero, spendendo altri token e attendendo nuovamente.

### Soluzione
1. Al completamento dello streaming in `sidepanel.js`:
   - Salvare il riassunto in `chrome.storage.local` con chiave `summary_cache_${videoId}`.
2. Quando il Side Panel rileva un video:
   - Controllare se esiste un riassunto in cache: se presente, mostrarlo **istantaneamente**.
   - Aggiungere un piccolo pulsante *"🔄 Rigenera"* per consentire all'utente di rifare il riassunto se desidera.

---

## 5. Checklist di Verifica Finale

- [ ] `sidepanel.html` non contiene alcun link a CDN esterni (100% conforme a CSP MV3).
- [ ] `modules/markdown.js` renderizza Markdown pulito e converte i timestamp in link cliccabili funzionanti.
- [ ] I video lunghi vengono pre-elaborati con condensazione dei sottotitoli prima dell'invio all'LLM.
- [ ] La navigazione tra video diversi su YouTube aggiorna automaticamente il Side Panel.
- [ ] I riassunti generati vengono salvati e ripristinati istantaneamente dalla cache.
- [ ] `npm test` passa con codice di uscita 0.
- [ ] `npm run build:dry` conferma che tutti i file staged sono presenti e coerenti.
