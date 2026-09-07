# v0.7.0 Netlify

- Port cloud separato dalla v0.6 locale validata.
- Playwright Core + @sparticuz/chromium per ambiente serverless Linux.
- Background Function per scansioni lunghe.
- Netlify Blobs al posto di SQLite locale per job/storico/report.
- API `wdc013.a11y-result.v1` mantenuta.
- Bearer token obbligatorio per scan/job.
- Report HTML/PDF con access key casuale separata.
- SSRF guard mantenuta anche sulle richieste browser.
- Modalità `single_url` e `crawl` mantenute.
- Dashboard cloud minimale per regression test.

## Deploy validation 2026-09-06

- Rimossa la configurazione di memoria custom dalla Background Function `scan-worker` per compatibilità con il piano Netlify attuale.
- Configurato `A11Y_API_TOKEN` come secret nel solo contesto Production di Netlify.
- Redeploy di validazione attivato via commit GitHub prima del regression test cloud.
- Impostato `A11Y_BEHAVIOR_MAX_PAGES=8` per eseguire i behavioral checks su tutte le 8 pagine del crawl WDC-013.
- Forzato un nuovo deploy dopo l'aggiornamento della variabile runtime, così la nuova configurazione viene caricata dalle Netlify Functions.

## WDC-014 SEO Scanner Cloud

- Aggiunta API separata `/api/v1/seo/*` con contratto `wdc014.seo-result.v1`.
- Aggiunti crawl SEO tecnico, robots/sitemap, metadata on-page, report HTML/PDF e storico separato nei Netlify Blobs.
- WDC-013 resta isolato e invariato.
- 2026-09-07: nuovo commit di redeploy dopo rinnovo crediti Netlify, per pubblicare le Functions WDC-014 insieme a WDC-013.
