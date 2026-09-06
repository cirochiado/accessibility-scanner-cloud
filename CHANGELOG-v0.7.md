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
