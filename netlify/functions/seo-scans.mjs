import crypto from 'node:crypto';
import { requireApiToken, json } from '../../_src/auth.mjs';
import { validatePublicHttpUrl } from '../../_src/security.mjs';
import { setJson } from '../../_src/storage.mjs';

export default async (req)=>{
  if(req.method!=='POST') return json({ok:false,error:'method_not_allowed'},405);
  const auth=requireApiToken(req); if(!auth.ok) return json({ok:false,error:auth.error},auth.status);

  let body;
  try{body=await req.json();}catch{return json({ok:false,error:'invalid_json'},400)}

  const url=String(body.url||'').trim();
  const external_ref=String(body.external_ref||'').trim()||null;
  const project_name=String(body.project_name||external_ref||url).slice(0,200);

  try{await validatePublicHttpUrl(url);}catch(e){return json({ok:false,error:e.message},400)}

  const max_pages=Math.max(1,Math.min(30,Number(body.max_pages||12)));
  const job_id=crypto.randomUUID();
  const report_key=crypto.randomBytes(24).toString('hex');
  const now=new Date().toISOString();

  const job={
    ok:true,job_id,kind:'seo-scan',status:'queued',created_at:now,finished_at:null,
    meta:{external_ref,project_name,url,max_pages},
    error:null,result:null,report_key
  };

  await setJson(`seo/jobs/${job_id}.json`,job);
  const origin=new URL(req.url).origin;
  const worker=await fetch(`${origin}/api/v1/seo/scan-worker`,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'authorization':req.headers.get('authorization')||''
    },
    body:JSON.stringify({job_id})
  });

  if(worker.status!==202){
    const t=await worker.text().catch(()=> '');
    job.status='failed';
    job.error=`worker_invocation_failed:${worker.status}:${t.slice(0,200)}`;
    job.finished_at=new Date().toISOString();
    await setJson(`seo/jobs/${job_id}.json`,job);
    return json(job,502);
  }

  return json({...job,poll_url:`${origin}/api/v1/seo/jobs/${job_id}`},202);
};

export const config={path:'/api/v1/seo/scans'};
