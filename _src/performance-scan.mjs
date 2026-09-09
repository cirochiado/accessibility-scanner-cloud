import crypto from 'node:crypto';
import { chromium as playwrightChromium } from 'playwright-core';
import serverlessChromium from '@sparticuz/chromium';
import { createPublicRequestGuard, validatePublicHttpUrl } from './security.mjs';

function round(v,digits=0){const p=10**digits;return Math.round(v*p)/p;}

export function scoreLowerBetter(value, good, poor) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= good) return 100;
  if (value <= poor) {
    const t=(value-good)/(poor-good);
    return Math.round(100-(50*t));
  }
  const tail=Math.min(1,(value-poor)/Math.max(poor,1));
  return Math.round(50-(50*tail));
}

function weightedScore(metrics){
  const parts=[
    ['lcp_ms',30,2500,4000],
    ['fcp_ms',20,1800,3000],
    ['ttfb_ms',15,800,1800],
    ['cls',15,0.10,0.25],
    ['blocking_ms',10,200,600],
    ['load_ms',10,3000,6000],
  ];
  let weighted=0,weights=0;
  for(const [key,w,good,poor] of parts){
    const raw=metrics[key];
    const s=scoreLowerBetter(typeof raw==='number' ? raw : Number.NaN,good,poor);
    if(s===null) continue;
    weighted+=s*w;weights+=w;
  }
  return weights ? Math.round(weighted/weights) : null;
}

function stableHash(value){
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
}

async function launchBrowser(){
  const executablePath=await serverlessChromium.executablePath();
  return playwrightChromium.launch({args:serverlessChromium.args,executablePath,headless:true});
}

async function installSafeRouting(context){
  const guard=createPublicRequestGuard();
  await context.route('**/*',async route=>{
    if(await guard(route.request().url())) return route.continue();
    return route.abort('blockedbyclient');
  });
}

function buildTexts(metrics,score){
  const issues=[];
  const opportunities=[];

  if(score!==null){
    if(score<50) issues.push(`- Performance browser critica: score ${score}/100.`);
    else if(score<90) issues.push(`- Performance browser migliorabile: score ${score}/100.`);
  }

  if(Number.isFinite(metrics.ttfb_ms) && metrics.ttfb_ms>800){
    issues.push(`- TTFB elevato: ${Math.round(metrics.ttfb_ms)} ms.`);
    opportunities.push('- Ridurre il tempo di risposta iniziale del server/CDN e verificare cache, redirect e backend.');
  }
  if(Number.isFinite(metrics.fcp_ms) && metrics.fcp_ms>1800){
    issues.push(`- First Contentful Paint lento: ${Math.round(metrics.fcp_ms)} ms.`);
    opportunities.push('- Ridurre risorse render-blocking e priorità non necessarie prima del primo contenuto visibile.');
  }
  if(Number.isFinite(metrics.lcp_ms) && metrics.lcp_ms>2500){
    issues.push(`- Largest Contentful Paint lento: ${Math.round(metrics.lcp_ms)} ms.`);
    opportunities.push('- Ottimizzare la risorsa LCP, preload critici, immagini hero e catena di caricamento iniziale.');
  }
  if(Number.isFinite(metrics.cls) && metrics.cls>0.10){
    issues.push(`- Layout shift rilevante: CLS ${round(metrics.cls,3)}.`);
    opportunities.push('- Stabilizzare dimensioni di immagini, iframe, font e contenuti inseriti dinamicamente.');
  }
  if(Number.isFinite(metrics.blocking_ms) && metrics.blocking_ms>200){
    issues.push(`- Tempo bloccante da long task elevato: ~${Math.round(metrics.blocking_ms)} ms.`);
    opportunities.push('- Ridurre JavaScript eseguito sul main thread, suddividere long task e rimandare script non critici.');
  }
  if(Number.isFinite(metrics.load_ms) && metrics.load_ms>6000){
    issues.push(`- Evento load tardivo: ${Math.round(metrics.load_ms)} ms.`);
  }
  if(Number.isFinite(metrics.transfer_kb) && metrics.transfer_kb>2500){
    issues.push(`- Trasferimento pagina elevato: ~${Math.round(metrics.transfer_kb)} KB.`);
    opportunities.push('- Ridurre peso di immagini, font e asset non indispensabili; verificare compressione e caching.');
  }
  if(Number.isFinite(metrics.resource_count) && metrics.resource_count>120){
    issues.push(`- Numero elevato di richieste: ${metrics.resource_count} risorse.`);
    opportunities.push('- Ridurre richieste non necessarie e consolidare asset dove ha senso.');
  }

  if(!issues.length) issues.push('- Nessun problema performance prioritario rilevato dal browser lab test corrente.');
  if(!opportunities.length) opportunities.push('- Nessuna opportunità performance prioritaria rilevata dal browser lab test corrente.');

  return {issues_text:issues.join('\n'),opportunities_text:opportunities.join('\n')};
}

export async function runPerformanceScan({url}){
  const start=(await validatePublicHttpUrl(url)).toString();
  const browser=await launchBrowser();
  try{
    const context=await browser.newContext({
      userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36 WDC018/0.1',
      viewport:{width:390,height:844},
      deviceScaleFactor:1,
      isMobile:true,
      hasTouch:true,
      ignoreHTTPSErrors:false,
    });
    await installSafeRouting(context);
    const page=await context.newPage();

    await page.addInitScript(()=>{
      window.__wdcPerf={lcp:null,cls:0,longTasks:[]};
      try{
        new PerformanceObserver(list=>{
          const entries=list.getEntries();
          const last=entries[entries.length-1];
          if(last) window.__wdcPerf.lcp=last.startTime;
        }).observe({type:'largest-contentful-paint',buffered:true});
      }catch{}
      try{
        new PerformanceObserver(list=>{
          for(const e of list.getEntries()) if(!e.hadRecentInput) window.__wdcPerf.cls+=e.value||0;
        }).observe({type:'layout-shift',buffered:true});
      }catch{}
      try{
        new PerformanceObserver(list=>{
          for(const e of list.getEntries()) window.__wdcPerf.longTasks.push({startTime:e.startTime,duration:e.duration});
        }).observe({type:'longtask',buffered:true});
      }catch{}
    });

    const response=await page.goto(start,{waitUntil:'domcontentloaded',timeout:30_000});
    await page.waitForLoadState('load',{timeout:12_000}).catch(()=>{});
    await page.waitForTimeout(2500);

    const finalUrl=page.url();
    await validatePublicHttpUrl(finalUrl);

    const metrics=await page.evaluate(()=>{
      const nav=performance.getEntriesByType('navigation')[0]||null;
      const fcp=performance.getEntriesByName('first-contentful-paint')[0]||null;
      const resources=performance.getEntriesByType('resource')||[];
      const p=window.__wdcPerf||{};
      const blocking=(p.longTasks||[]).reduce((sum,e)=>sum+Math.max(0,(e.duration||0)-50),0);
      const transfer=resources.reduce((sum,e)=>sum+Number(e.transferSize||0),0);
      return {
        ttfb_ms:nav?nav.responseStart:null,
        fcp_ms:fcp?fcp.startTime:null,
        lcp_ms:Number.isFinite(p.lcp)?p.lcp:null,
        cls:Number.isFinite(p.cls)?p.cls:null,
        blocking_ms:Number.isFinite(blocking)?blocking:null,
        dom_content_loaded_ms:nav?nav.domContentLoadedEventEnd:null,
        load_ms:nav&&nav.loadEventEnd>0?nav.loadEventEnd:performance.now(),
        resource_count:resources.length,
        transfer_kb:transfer/1024,
      };
    });

    for(const key of Object.keys(metrics)){
      if(typeof metrics[key]==='number') metrics[key]=round(metrics[key],key==='cls'?3:1);
    }

    const score=weightedScore(metrics);
    const texts=buildTexts(metrics,score);
    const fingerprint={
      score,
      ttfb_ms:metrics.ttfb_ms,
      fcp_ms:metrics.fcp_ms,
      lcp_ms:metrics.lcp_ms,
      cls:metrics.cls,
      blocking_ms:metrics.blocking_ms,
      load_ms:metrics.load_ms,
      resource_count:metrics.resource_count,
      transfer_kb:metrics.transfer_kb,
    };

    return {
      ok:true,
      schema_version:'wdc018.performance-result.v1',
      scanner_version:'0.1.0-netlify',
      url:start,
      final_url:finalUrl,
      http_status:response?.status()??null,
      performance_score:score,
      metrics,
      ...texts,
      performance_hash:stableHash(fingerprint),
      methodology:'Chromium/Playwright mobile viewport lab measurement. Non equivale a Google PageSpeed Insights o Lighthouse e non usa dati CrUX real-user.',
      generated_at:new Date().toISOString(),
    };
  }finally{
    await browser.close().catch(()=>{});
  }
}
