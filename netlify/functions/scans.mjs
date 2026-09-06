import crypto from 'node:crypto';
import { requireApiToken, json } from '../../_src/auth.mjs';
import { validatePublicHttpUrl } from '../../_src/security.mjs';
import { setJson } from '../../_src/storage.mjs';
import { normalizeScanMode } from '../../_src/cloud-scan.mjs';
export default async (req)=>{
  if(req.method!=='POST') return json({ok:false,error:'method_not_allowed'},405);
  const auth=requireApiToken(req); if(!auth.ok) return json({ok:false,error:auth.error},auth.status);
  let body; try{body=await req.json();}catch{return json({ok:false,error:'invalid_json'},400)}
  const url=String(body.url||'').trim(); const external_ref=String(body.external_ref||'').trim()||null; const project_name=String(body.project_name||external_ref||url).slice(0,200);
  let mode; try{mode=normalizeScanMode(body.mode||'crawl'); await validatePublicHttpUrl(url);}catch(e){return json({ok:false,error:e.message},400)}
  const max_pages=mode==='single_url'?1:Math.max(1,Math.min(50,Number(body.max_pages||20)));
  const job_id=crypto.randomUUID(); const report_key=crypto.randomBytes(24).toString('hex'); const now=new Date().toISOString();
  const job={ok:true,job_id,kind:'api-scan',status:'queued',created_at:now,finished_at:null,meta:{external_ref,project_name,scan_mode:mode,url,max_pages},error:null,result:null,report_key};
  await setJson(`jobs/${job_id}.json`,job);
  const origin=new URL(req.url).origin;
  const worker=await fetch(`${origin}/api/v1/scan-worker`,{method:'POST',headers:{'content-type':'application/json','authorization':req.headers.get('authorization')||''},body:JSON.stringify({job_id})});
  if(worker.status!==202){const t=await worker.text().catch(()=> ''); job.status='failed'; job.error=`worker_invocation_failed:${worker.status}:${t.slice(0,200)}`; job.finished_at=new Date().toISOString(); await setJson(`jobs/${job_id}.json`,job); return json(job,502);}
  return json({...job,poll_url:`${origin}/api/v1/jobs/${job_id}`},202);
};
export const config={path:'/api/v1/scans'};
