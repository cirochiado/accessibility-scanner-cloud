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
  const job=await getJson(`seo/jobs/${job_id}.json`);
  if(!job) throw new Error('seo_job_not_found');

  job.status='running';
  await setJson(`seo/jobs/${job_id}.json`,job);

  try{
    const refKey=crypto.createHash('sha256')
      .update(job.meta.external_ref||job.meta.url)
      .digest('hex').slice(0,32);

    const prev=await getJson(`seo/latest/${refKey}.json`);
    const scan=await runSeoScan({url:job.meta.url,max_pages:job.meta.max_pages});

    const result=buildSeoResult({
      jobId:job_id,
      externalRef:job.meta.external_ref,
      scan,
      previousResult:prev?.result||null,
      baseUrl:job.meta.url
    });

    const html=buildSeoHtmlReport(result);
    await setText(`seo/reports/${job_id}.html`,html,{contentType:'text/html; charset=utf-8'});

    try{
      const pdf=await renderPdfFromHtml(html);
      await setBinary(`seo/reports/${job_id}.pdf`,pdf,{contentType:'application/pdf'});
    }catch(e){
      result.report_pdf_error=String(e?.message||e);
    }

    job.status='completed';
    job.finished_at=new Date().toISOString();
    job.result=result;

    await setJson(`seo/jobs/${job_id}.json`,job);
    await setJson(`seo/latest/${refKey}.json`,{job_id,result});
    await setJson(`seo/history/${refKey}/${job.finished_at}-${job_id}.json`,{job_id,result});
  }catch(e){
    job.status='failed';
    job.finished_at=new Date().toISOString();
    job.error=String(e?.message||e);
    await setJson(`seo/jobs/${job_id}.json`,job);
    throw e;
  }
};

export const config={path:'/api/v1/seo/scan-worker'};
