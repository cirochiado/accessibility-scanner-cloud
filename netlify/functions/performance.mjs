import { requireApiToken, json } from '../../_src/auth.mjs';
import { runPerformanceScan } from '../../_src/performance-scan.mjs';

export default async (req)=>{
  if(req.method!=='POST') return json({ok:false,error:'method_not_allowed'},405);

  const auth=requireApiToken(req);
  if(!auth.ok) return json({ok:false,error:auth.error},auth.status);

  let body;
  try{body=await req.json();}
  catch{return json({ok:false,error:'invalid_json'},400);}

  const url=String(body.url||'').trim();
  if(!url) return json({ok:false,error:'url_required'},400);

  try{
    const result=await runPerformanceScan({url});
    return json(result,200);
  }catch(err){
    return json({
      ok:false,
      schema_version:'wdc018.performance-result.v1',
      error:String(err?.message||err||'performance_scan_failed').slice(0,700)
    },400);
  }
};

export const config={path:'/api/v1/performance'};
