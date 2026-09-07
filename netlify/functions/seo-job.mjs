import { requireApiToken, json } from '../../_src/auth.mjs';
import { getJson,setJson } from '../../_src/storage.mjs';

const STALE_RUNNING_MS=12*60*1000;

export default async (req,context)=>{
  const auth=requireApiToken(req);
  if(!auth.ok) return json({ok:false,error:auth.error},auth.status);

  const id=context.params.id;
  const key=`seo/jobs/${id}.json`;
  const job=await getJson(key);
  if(!job) return json({ok:false,error:'seo_job_not_found'},404);

  if(job.status==='running'){
    const startedAt=Date.parse(job.started_at || job.created_at || '');
    if(Number.isFinite(startedAt) && Date.now()-startedAt > STALE_RUNNING_MS){
      job.status='failed';
      job.finished_at=new Date().toISOString();
      job.error='worker_timeout_or_terminated';
      job.progress={
        ...(job.progress || {}),
        stage:'failed',
        current_status:'failed',
        error:job.error,
        updated_at:job.finished_at,
      };
      await setJson(key,job);
    }
  }

  const origin=new URL(req.url).origin;
  let out={...job,poll_url:`${origin}/api/v1/seo/jobs/${id}`};

  if(out.result){
    out.result={
      ...out.result,
      wdc014:{
        ...out.result.wdc014,
        report_url:`${origin}/api/v1/seo/reports/${id}?k=${job.report_key}`,
        report_pdf_url:`${origin}/api/v1/seo/reports/${id}/pdf?k=${job.report_key}`
      },
      report:{
        ...out.result.report,
        html_url:`${origin}/api/v1/seo/reports/${id}?k=${job.report_key}`,
        pdf_url:`${origin}/api/v1/seo/reports/${id}/pdf?k=${job.report_key}`
      }
    };
  }

  return json(out);
};

export const config={path:'/api/v1/seo/jobs/:id'};
