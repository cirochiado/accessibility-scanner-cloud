# WDC-018 Internal Performance

Endpoint autenticato: `POST /api/v1/performance`

Body:

```json
{ "url": "https://example.com/" }
```

Autenticazione: stesso Bearer `A11Y_API_TOKEN` usato dagli scanner WDC-013/WDC-014.

Output schema: `wdc018.performance-result.v1`.

La misura usa Chromium/Playwright con viewport mobile e raccoglie TTFB, FCP, LCP, CLS, long-task blocking, load time, numero risorse e transfer size. Lo score è deterministico e serve alla prioritizzazione commerciale/tecnica di WDC-018.

Non è Google PageSpeed Insights, non è un report Lighthouse e non usa dati CrUX real-user.
