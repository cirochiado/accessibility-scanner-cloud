import crypto from 'node:crypto';
import { requireApiToken } from '../../_src/auth.mjs';
import { getJson,setJson,setText,setBinary } from '../../_src/storage.mjs';
import { runSeoScan } from '../../_src/seo-scan.mjs';
import { buildSeoResult,buildSeoHtmlReport } from '../../_src/seo-result-builder.mjs';
import { renderPdfFromHtml } from '../../_src/cloud-scan.mjs';

export default async (req)=>{
  const auth=requireApiToken(req);
  if(!auth.ok) throw new Error(auth.error);

  const {job_id}=await req.json();
  const jobKey=`seo/jobs/${job_id}.json`;
  const job=await getJson(jobKey);
  if(!job) throw new Error('seo_job_not_found');

  const now=new Date().toISOString();
  job.status='running';
  job.started_at=job.started_at || now;
  job.progress={
    stage:'starting',
    pages_done:0,
    max_pages:Number(job.meta?.max_pages || 0) || null,
    current_url:job.meta?.url || null,
    current_status:null,
    queued:null,
    updated_at:now,
  };
  await setJson(jobKey,job);

  let progressWrites=Promise.resolve();
  const queueProgress=(progress={})=>{
    job.progress={
      stage:'scanning',
      pages_done:Number.isFinite(Number(progress.pages)) ? Number(progress.pages) : (job.progress?.pages_done || 0),
      max_pages:Number(job.meta?.max_pages || 0) || null,
      current_url:progress.url || job.progress?.current_url || job.meta?.url || null,
      current_status:progress.status || null,
      queued:Number.isFinite(Number(progress.queued)) ? Number(progress.queued) : null,
      canonical:progress.canonical || null,
      error:progress.error || null,
      updated_at:new Date().toISOString(),
    };
    const snapshot=JSON.parse(JSON.stringify(job));
    progressWrites=progressWrites.catch(()=>{}).then(()=>setJson(jobKey,snapshot));
  };

  const persistStage=async(stage,extra={})=>{
    await progressWrites.catch(()=>{});
    job.progress={
      ...(job.progress || {}),
      stage,
      ...extra,
      updated_at:new Date().toISOString(),
    };
    await setJson(jobKey,job);
  };

  try{
    const refKey=crypto.createHash('sha256')
      .update(job.meta.external_ref||job.meta.url)
      .digest('hex').slice(0,32);

    const prev=await getJson(`seo/latest/${refKey}.json`);
    const scan=await runSeoScan({
      url:job.meta.url,
      max_pages:job.meta.max_pages,
      onProgress:queueProgress,
    });
    await progressWrites.catch(()=>{});

    await persistStage('building_result',{pages_done:scan.pages?.length || job.progress?.pages_done || 0});
    const result=buildSeoResult({
      jobId:job_id,
      externalRef:job.meta.external_ref,
      scan,
      previousResult:prev?.result||null,
      baseUrl:job.meta.url
    });

    await persistStage('building_html_report');
    const html=buildSeoHtmlReport(result);
    await setText(`seo/reports/${job_id}.html`,html,{contentType:'text/html; charset=utf-8'});

    await persistStage('building_pdf_report');
    try{
      const pdf=await renderPdfFromHtml(html);
      await setBinary(`seo/reports/${job_id}.pdf`,pdf,{contentType:'application/pdf'});
    }catch(e){
      result.report_pdf_error=String(e?.message||e);
    }

    job.status='completed';
    job.finished_at=new Date().toISOString();
    job.result=result;
    job.progress={
      ...(job.progress || {}),
      stage:'completed',
      pages_done:scan.pages?.length || job.progress?.pages_done || 0,
      current_status:'completed',
      updated_at:job.finished_at,
    };

    await setJson(jobKey,job);
    await setJson(`seo/latest/${refKey}.json`,{job_id,result});
    await setJson(`seo/history/${refKey}/${job.finished_at}-${job_id}.json`,{job_id,result});
  }catch(e){
    await progressWrites.catch(()=>{});
    job.status='failed';
    job.finished_at=new Date().toISOString();
    job.error=String(e?.message||e);
    job.progress={
      ...(job.progress || {}),
      stage:'failed',
      current_status:'failed',
      error:job.error,
      updated_at:job.finished_at,
    };
    await setJson(jobKey,job);
    throw e;
  }
};

export const config={path:'/api/v1/seo/scan-worker'};
