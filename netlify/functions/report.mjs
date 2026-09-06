import { getJson,getText } from '../../_src/storage.mjs';
export default async (req,context)=>{const id=context.params.id; const job=await getJson(`jobs/${id}.json`); const k=new URL(req.url).searchParams.get('k'); if(!job||!k||k!==job.report_key)return new Response('Not found',{status:404}); const html=await getText(`reports/${id}.html`); if(!html)return new Response('Report non disponibile',{status:404}); return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, max-age=60'}});};
export const config={path:'/api/v1/reports/:id'};
