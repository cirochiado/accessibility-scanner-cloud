import crypto from 'node:crypto';
import { chromium as playwrightChromium } from 'playwright-core';
import serverlessChromium from '@sparticuz/chromium';
import AxeBuilder from '@axe-core/playwright';
import { createPublicRequestGuard, validatePublicHttpUrl } from './security.mjs';
import { runBehavioralChecks } from './behavior.mjs';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
export const SCAN_MODES = ['single_url', 'crawl'];
const STRIP_PARAMS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','_ga','SubmitCurrency','id_currency']);
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|mp[34]|avi|mov|docx?|xlsx?|pptx?|csv|txt|xml|json)(\?|$)/i;

export function normalizeScanMode(v='crawl') {
  const x = String(v || '').trim().toLowerCase();
  if (['single_url','single-url','single','url'].includes(x)) return 'single_url';
  if (['crawl','site','sito'].includes(x)) return 'crawl';
  throw new Error('mode deve essere single_url oppure crawl');
}

export function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!['http:','https:'].includes(u.protocol)) return null;
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (STRIP_PARAMS.has(p)) u.searchParams.delete(p);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0,-1);
    return u.toString();
  } catch { return null; }
}

function sameOrigin(url, base) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

function fingerprint(url, rule, selector) {
  return crypto.createHash('sha1').update(`${url}|${rule}|${selector}`).digest('hex');
}

function axeRows(result, url, kind='violations') {
  const rows = [];
  for (const v of result?.[kind] || []) {
    for (const node of v.nodes || []) {
      const selector = Array.isArray(node.target) ? node.target.flat().join(' ') : String(node.target || '');
      if (!selector) continue;
      rows.push({
        url,
        regola: v.id,
        impatto: node.impact || v.impact || null,
        tags: v.tags || [],
        descrizione: v.description || null,
        aiuto: v.help || null,
        help_url: v.helpUrl || null,
        selettore: selector,
        snippet_html: String(node.html || '').slice(0,800),
        fingerprint: fingerprint(url, v.id, selector),
      });
    }
  }
  return rows;
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

export async function runCloudScan({ url, mode='crawl', max_pages=20, onProgress=()=>{} }) {
  const scanMode = normalizeScanMode(mode);
  const start = normalizeUrl(url, url);
  if (!start) throw new Error('URL non valido');
  await validatePublicHttpUrl(start);

  const hardMax = Math.max(1, Math.min(50, Number(process.env.A11Y_MAX_PAGES || 20)));
  const maxPages = scanMode === 'single_url' ? 1 : Math.max(1, Math.min(hardMax, Number(max_pages || 20)));
  const behaviorMax = Math.max(0, Math.min(maxPages, Number(process.env.A11Y_BEHAVIOR_MAX_PAGES || 8)));

  const browser = await launchBrowser();
  const pages = [];
  const violations = [];
  const incomplete = [];
  const behavioral = [];
  let passesTotal = 0;
  const queue = [start];
  const seen = new Set(queue);

  try {
    const context = await browser.newContext({
      userAgent: 'a11y-scanner/0.7-netlify (+WDC-013)',
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: false,
    });
    await installSafeRouting(context);

    while (queue.length && pages.length < maxPages) {
      const current = queue.shift();
      const page = await context.newPage();
      const rec = { url: current, final_url: current, title: null, http_status: null, error: null };
      try {
        let response;
        try {
          response = await page.goto(current, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForTimeout(1200);
        } catch (err) {
          rec.error = `Navigazione fallita: ${String(err.message).slice(0,430)}`;
          pages.push(rec);
          onProgress({ url: current, status: 'failed', error: rec.error });
          continue;
        }

        rec.final_url = page.url();
        rec.title = await page.title().catch(()=>null);
        rec.http_status = response?.status() ?? null;
        try { await validatePublicHttpUrl(rec.final_url); }
        catch (err) { rec.error = `Redirect/destinazione rifiutata: ${err.message}`; pages.push(rec); continue; }

        const contentType = String(await response?.headerValue('content-type').catch(()=> '') || '');
        if (rec.http_status != null && rec.http_status >= 400) rec.error = `HTTP ${rec.http_status}`;
        else if (!contentType.toLowerCase().includes('text/html') && !(await page.locator('html').count().catch(()=>0))) rec.error = `Contenuto non HTML (${contentType || 'sconosciuto'})`;

        if (!rec.error) {
          const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
          violations.push(...axeRows(axe, rec.final_url, 'violations'));
          incomplete.push(...axeRows(axe, rec.final_url, 'incomplete'));
          passesTotal += axe.passes?.length || 0;

          if (behavioral.filter(x=>x.url===rec.final_url).length === 0 && behavioral.length / 3 < behaviorMax) {
            behavioral.push(...await runBehavioralChecks(page));
          }

          if (scanMode === 'crawl') {
            const hrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href'))).catch(()=>[]);
            for (const href of hrefs) {
              const n = normalizeUrl(href, rec.final_url);
              if (!n || seen.has(n) || SKIP_EXT.test(n) || !sameOrigin(n, start)) continue;
              try { await validatePublicHttpUrl(n); } catch { continue; }
              seen.add(n); queue.push(n);
              if (seen.size >= maxPages * 6) break;
            }
          }
        }
        pages.push(rec);
        onProgress({ url: current, status: rec.error ? 'failed' : 'ok', pages: pages.length, queued: queue.length });
      } finally {
        await page.close().catch(()=>{});
      }
    }
    await context.close().catch(()=>{});
  } finally {
    await browser.close().catch(()=>{});
  }

  return { scan_mode: scanMode, start_url: start, pages, violations, incomplete, behavioral, passes_total: passesTotal };
}

export async function renderPdfFromHtml(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
  } finally { await browser.close().catch(()=>{}); }
}
