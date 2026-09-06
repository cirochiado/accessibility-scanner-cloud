# Accessibility Scanner v0.7 — Netlify proof of production

Questa versione NON sostituisce ancora la v0.6 locale: serve a fare la regressione cloud prima di collegare WDC-013.

## Architettura

- Netlify Function `POST /api/v1/scans`: crea il job e risponde 202.
- Netlify Background Function `/api/v1/scan-worker`: esegue Chromium + axe + behavioral fino a 15 minuti.
- Netlify Blobs: job, storico, JSON risultato, report HTML/PDF.
- `GET /api/v1/jobs/:id`: polling n8n/dashboard.
- Risultato: contratto `wdc013.a11y-result.v1` con blocco `result.wdc013`.

## Deploy consigliato

1. Crea un NUOVO progetto Netlify da questa cartella usando Git oppure Netlify CLI. Non usare il semplice drag-and-drop statico, perché servono build e Functions.
2. In Project configuration > Environment variables crea `A11Y_API_TOKEN` con un valore lungo e casuale.
3. Deploy/redeploy.
4. Apri `https://NOME-PROGETTO.netlify.app/api/v1/health`.
5. Apri la home del progetto, inserisci il token e lancia la regressione Setik in modalità `Singola URL`.

### Netlify CLI (alternativa rapida)

Dalla cartella:

```bash
npm install
npx netlify login
npx netlify init
npx netlify env:set A11Y_API_TOKEN "TOKEN_LUNGO_CASUALE"
npx netlify deploy --build --prod
```

## Sicurezza

L'API di scansione e il polling richiedono Bearer token. I report hanno un link casuale separato `?k=...`. Lo scanner blocca URL/IP privati e anche le richieste secondarie del browser verso reti private per ridurre il rischio SSRF.

## Regression gate prima di WDC-013 PROD

Confrontare cloud vs v0.6 locale su:

1. webdeveloperciro.com
2. Setik homepage
3. Setik prodotto (single URL): atteso recupero di `nested-interactive` e `aria-input-field-name`
4. Setik categoria: atteso recupero di `select-name`

Non pretendere conteggi pixel-identici: l'ambiente browser Linux serverless può cambiare alcuni risultati visivi. Le famiglie di regole e i segnali principali devono restare coerenti.

## Nota

Il PDF viene generato in un secondo lancio Chromium nello stesso background job. Se durante la prima prova Netlify dovesse essere vicino al limite di memoria/tempo, il JSON e l'HTML restano prioritari e il PDF può essere reso asincrono in una patch successiva.
