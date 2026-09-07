# ONBOARDING_UX.md — Miglioramenti Usabilità & Esperienza Nuovo Utente

Piano operativo per rendere l'estensione immediatamente chiara, intuitiva e priva di blocchi per chiunque la installi per la prima volta.

---

## 1. Problemi Rilevati per il Nuovo Utente

1. **Il pulsante `⚙️` nel Side Panel non funziona**:
   - In `sidepanel.js`, il pulsante impostazioni chiama `chrome.runtime.openOptionsPage()`.
   - In `manifest.json` **non è definita alcuna options page**.
   - Cliccando su `⚙️`, non succede nulla.
2. **Errore 401 immediato al primo click su "Summarize"**:
   - Un nuovo utente non ha chiavi API salvate in memoria.
   - Cliccando su "Summarize", il codice tenta una chiamata ad Anthropic e restituisce in rosso: `Error: Anthropic error: 401`.
   - L'utente non sa dove inserire la chiave e pensa che l'estensione non funzioni.
3. **Il pulsante `"S"` nel Popup è criptico**:
   - In `popup.html` c'è `<button id="open-sidepanel-btn">S</button>`. Nessun utente può intuire che quella "S" apre il Side Panel persistente.
4. **Mancanza di distinzione tra Web Mode e Side Panel**:
   - Non è spiegato che la **Web Mode (nel Popup) è 100% gratuita** (apre Claude/ChatGPT senza chiavi API), mentre il **Side Panel richiede una chiave API** (es. Gemini gratuita su Google AI Studio).

---

## 2. Soluzioni da Implementare

### A. Pannello Impostazioni Integrato nel Side Panel (`sidepanel.html`, `sidepanel.css`, `sidepanel.js`)
- Creare un drawer/modal a comparsa direttamente nel Side Panel:
  - **Selettore Provider**: Google Gemini (Consigliato, gratis), Claude, OpenAI, Groq (ultra-veloce), OpenRouter, Custom.
  - **Campo Chiave API**: input password con salvataggio sicuro in `chrome.storage.local`.
  - **Link di supporto contestuale**:
    - Se seleziona Gemini: link diretto `"Ottieni chiave gratis su Google AI Studio ↗"`.
    - Se seleziona Groq: link diretto `"Ottieni chiave gratis su GroqCloud ↗"`.
  - **Pulsante Salva**: chiude il pannello e aggiorna lo stato.
- Al click su `⚙️`, aprire questo pannello invece di chiamare `openOptionsPage()`.

### B. Gestione Intelligente della Mancanza di Chiave API
- In `sidepanel.js`, prima di lanciare la generazione:
  - Se il provider selezionato non ha una chiave API configurata:
    - **Non fare la chiamata di rete** e non mostrare l'errore 401.
    - Mostrare un messaggio chiaro e amichevole:
      > *"👋 Per riassumere nel Side Panel inserisci una chiave API (consigliata Google Gemini, 100% gratuita) oppure usa la modalità Web gratuita dal popup."*
    - Aprire automaticamente il pannellino delle impostazioni per guidare l'utente.

### C. Restyling del Pulsante Side Panel nel Popup (`popup.html`, `popup.css`)
- Sostituire il pulsante `S` con un badge/pulsante evidente nella testata:
  ```html
  <button id="open-sidepanel-btn" class="sidepanel-launch-btn" title="Apri nel Side Panel persistente">
    ◨ Side Panel ↗
  </button>
  ```
- Stile evidente in `popup.css`: pill gradient o pulsante accent che inviti l'utente a cliccarlo.

### D. Badge del Provider Attivo nel Side Panel
- Mostrare nel Side Panel un badge discreto che indichi il modello attivo (es. `Gemini 2.5 Flash` o `Claude 3.5`), così l'utente sa sempre quale AI sta rispondendo.

---

## 3. Checklist di Verifica

- [ ] Cliccando su `⚙️` nel Side Panel si apre il pannello impostazioni locale (senza errori di options page mancante).
- [ ] L'inserimento e il salvataggio della chiave API (Gemini/Claude/OpenAI/Groq) funziona e persiste.
- [ ] Cliccando su "Summarize" senza chiave, l'utente viene guidato gentilmente ad inserirla anziché ricevere un errore 401.
- [ ] Il popup mostra un pulsante `"◨ Side Panel ↗"` chiaro e invitante.
- [ ] `npm test` passa con codice 0.
- [ ] `npm run build:dry` valida tutti i file della build.
