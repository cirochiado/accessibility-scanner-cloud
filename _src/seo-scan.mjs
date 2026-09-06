import { chromium as playwrightChromium } from 'playwright-core';
import serverlessChromium from '@sparticuz/chromium';
import { createPublicRequestGuard, validatePublicHttpUrl } from './security.mjs';

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|mp[34]|avi|mov|docx?|xlsx?|pptx?|csv|txt|xml|json)(\?|$)/i;
const STRIP_PARAMS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','_ga']);

export function normalizeSeoUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!['http:','https:'].includes(u.protocol)) return null;
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (STRIP_PARAMS.has(p)) u.searchParams.delete(p);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0,-1);
    return u.toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

async function installSafeRouting(context) {
  const guard = createPublicRequestGuard();
  await context.route('**/*', async route => {
    if (await guard(route.request().url())) return route.continue();
    return route.abort('blockedbyclient');
  });
}

async function launchBrowser() {
  const executablePath = await serverlessChromium.executablePath();
  return await playwrightChromium.launch({
    args: serverlessChromium.args,
    executablePath,
    headless: true,
  });
}

function parseRobots(text='') {
  const lines = String(text).split(/\r?\n/);
  const sitemaps = [];
  let currentAgents = [];
  let disallowAll = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      currentAgents = [value.toLowerCase()];
    } else if (key === 'disallow' && currentAgents.includes('*') && value === '/') {
      disallowAll = true;
    } else if (key === 'sitemap' && value) {
      sitemaps.push(value);
    }
  }
  return { sitemaps: [...new Set(sitemaps)], disallow_all: disallowAll };
}

function parseSitemapUrls(xml='') {
  const out = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml)))) {
    const v = m[1]
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&')
      .trim();
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

async function fetchTextDocument(context, url, timeout=15000) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout });
    const status = response?.status() ?? null;
    const text = response ? await response.text().catch(()=> '') : '';
    return { url: page.url(), status, text, error: status && status >= 400 ? `HTTP ${status}` : null };
  } catch (e) {
    return { url, status:null, text:'', error:String(e?.message || e).slice(0,350) };
  } finally {
    await page.close().catch(()=>{});
  }
}

async function extractPageSeo(page) {
  return await page.evaluate(() => {
    const getMeta = name =>
      document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';
    const getProp = prop =>
      document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content')?.trim() || '';
    const canonical = document.querySelector('link[rel~="canonical"]')?.href || '';
    const h1s = [...document.querySelectorAll('h1')].map(x => (x.textContent || '').trim()).filter(Boolean);
    const imgs = [...document.images];
    const internalLinks = [...document.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean);
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let invalidJsonLd = 0;
    for (const s of scripts) {
      try { JSON.parse(s.textContent || ''); } catch { invalidJsonLd++; }
    }
    const bodyText = (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
    const mixed = [...document.querySelectorAll('[src],[href]')]
      .map(el => el.getAttribute('src') || el.getAttribute('href') || '')
      .filter(v => /^http:\/\//i.test(v)).length;
    return {
      lang: document.documentElement.getAttribute('lang') || '',
      title: document.title?.trim() || '',
      meta_description: getMeta('description'),
      robots_meta: getMeta('robots'),
      viewport: getMeta('viewport'),
      canonical,
      h1s,
      h1_count: h1s.length,
      og_title: getProp('og:title'),
      og_description: getProp('og:description'),
      og_image: getProp('og:image'),
      json_ld_count: scripts.length,
      json_ld_invalid: invalidJsonLd,
      word_count: words,
      images_count: imgs.length,
      images_without_alt: imgs.filter(img => !img.hasAttribute('alt')).length,
      internal_links_raw: internalLinks,
      mixed_content_count: mixed,
    };
  });
}

export async function runSeoScan({ url, max_pages=12, onProgress=()=>{} }) {
  const start = normalizeSeoUrl(url, url);
  if (!start) throw new Error('URL non valido');
  await validatePublicHttpUrl(start);

  const hardMax = Math.max(1, Math.min(30, Number(process.env.SEO_MAX_PAGES || 12)));
  const maxPages = Math.max(1, Math.min(hardMax, Number(max_pages || 12)));
  const browser = await launchBrowser();

  const pages = [];
  const queue = [{ url:start, depth:0, source:'start' }];
  const seen = new Set([start]);
  const inbound = new Map([[start, 0]]);
  let robots = { url:new URL('/robots.txt', start).toString(), status:null, error:null, disallow_all:false, sitemaps:[] };
  let sitemap = { checked_urls:[], status:null, error:null, urls:[] };

  try {
    const context = await browser.newContext({
      userAgent: 'ciro-seo-scanner/0.1 (+WDC-014)',
      viewport: { width:1366, height:900 },
      ignoreHTTPSErrors:false,
    });
    await installSafeRouting(context);

    const origin = new URL(start).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const robotsRes = await fetchTextDocument(context, robotsUrl);
    const parsedRobots = parseRobots(robotsRes.text);
    robots = {
      url: robotsUrl,
      status: robotsRes.status,
      error: robotsRes.error,
      disallow_all: parsedRobots.disallow_all,
      sitemaps: parsedRobots.sitemaps,
    };

    const sitemapCandidates = [
      ...parsedRobots.sitemaps,
      `${origin}/sitemap.xml`,
    ].map(x => normalizeSeoUrl(x, start)).filter(Boolean);
    const uniqueSitemaps = [...new Set(sitemapCandidates)].slice(0,3);

    for (const smUrl of uniqueSitemaps) {
      if (!sameOrigin(smUrl, start)) continue;
      try { await validatePublicHttpUrl(smUrl); } catch { continue; }
      const res = await fetchTextDocument(context, smUrl);
      sitemap.checked_urls.push({ url:smUrl, status:res.status, error:res.error });
      if (!res.error && res.text) {
        const urls = parseSitemapUrls(res.text)
          .map(x => normalizeSeoUrl(x, start))
          .filter(x => x && sameOrigin(x, start) && !SKIP_EXT.test(x));
        if (urls.length) {
          sitemap.status = res.status;
          sitemap.urls = [...new Set([...sitemap.urls, ...urls])].slice(0,500);
        }
      }
    }
    if (!sitemap.checked_urls.length) {
      sitemap.error = 'Nessuna sitemap verificabile';
    } else if (!sitemap.urls.length) {
      const ok = sitemap.checked_urls.find(x => x.status && x.status < 400);
      sitemap.status = ok?.status ?? sitemap.checked_urls[0]?.status ?? null;
      sitemap.error = ok ? 'Sitemap raggiungibile ma nessuna URL <loc> estratta' : 'Sitemap non disponibile';
    }

    for (const smPage of sitemap.urls.slice(0, Math.max(0, Math.floor(maxPages / 3)))) {
      if (seen.has(smPage)) continue;
      seen.add(smPage);
      inbound.set(smPage, 0);
      queue.push({ url:smPage, depth:null, source:'sitemap' });
    }

    while (queue.length && pages.length < maxPages) {
      const item = queue.shift();
      const current = item.url;
      const page = await context.newPage();
      const rec = {
        url: current,
        final_url: current,
        depth: item.depth,
        source: item.source,
        title: '',
        http_status: null,
        error: null,
      };
      try {
        let response;
        try {
          response = await page.goto(current, { waitUntil:'domcontentloaded', timeout:30000 });
          await page.waitForTimeout(800);
        } catch (e) {
          rec.error = `Navigazione fallita: ${String(e?.message || e).slice(0,400)}`;
          pages.push(rec);
          onProgress({url:current,status:'failed',error:rec.error});
          continue;
        }

        rec.final_url = page.url();
        rec.http_status = response?.status() ?? null;
        if (rec.http_status != null && rec.http_status >= 400) rec.error = `HTTP ${rec.http_status}`;

        try { await validatePublicHttpUrl(rec.final_url); }
        catch (e) { rec.error = `Redirect/destinazione rifiutata: ${e.message}`; }

        const contentType = String(await response?.headerValue('content-type').catch(()=> '') || '');
        if (!rec.error && !contentType.toLowerCase().includes('text/html') && !(await page.locator('html').count().catch(()=>0))) {
          rec.error = `Contenuto non HTML (${contentType || 'sconosciuto'})`;
        }

        if (!rec.error) {
          Object.assign(rec, await extractPageSeo(page));
          const robotsMeta = String(rec.robots_meta || '').toLowerCase();
          rec.noindex = /\bnoindex\b/.test(robotsMeta);
          rec.nofollow = /\bnofollow\b/.test(robotsMeta);
          rec.title_length = rec.title.length;
          rec.meta_description_length = rec.meta_description.length;
          rec.url_length = rec.final_url.length;
          rec.query_param_count = new URL(rec.final_url).searchParams.size;

          const normalizedLinks = [];
          let external = 0;
          for (const rawHref of rec.internal_links_raw || []) {
            const n = normalizeSeoUrl(rawHref, rec.final_url);
            if (!n || SKIP_EXT.test(n)) continue;
            if (!sameOrigin(n, start)) { external++; continue; }
            normalizedLinks.push(n);
            inbound.set(n, (inbound.get(n) || 0) + 1);
            if (!seen.has(n) && seen.size < maxPages * 8) {
              try { await validatePublicHttpUrl(n); } catch { continue; }
              seen.add(n);
              queue.push({
                url:n,
                depth:Number.isInteger(item.depth) ? item.depth + 1 : null,
                source:'internal_link',
              });
            }
          }
          rec.internal_links = [...new Set(normalizedLinks)];
          rec.external_links_count = external;
          delete rec.internal_links_raw;
        }

        pages.push(rec);
        onProgress({url:current,status:rec.error?'failed':'ok',pages:pages.length,queued:queue.length});
      } finally {
        await page.close().catch(()=>{});
      }
    }

    await context.close().catch(()=>{});
  } finally {
    await browser.close().catch(()=>{});
  }

  for (const p of pages) p.inbound_links = inbound.get(p.final_url || p.url) || 0;

  return {
    scan_mode:'crawl',
    start_url:start,
    max_pages:maxPages,
    pages,
    robots,
    sitemap,
  };
}
