import { getJson,getBinary } from '../../_src/storage.mjs';

export default async (req,context)=>{
  const id=context.params.id;
  const job=await getJson(`seo/jobs/${id}.json`);
  const k=new URL(req.url).searchParams.get('k');

  if(!job||!k||k!==job.report_key) return new Response('Not found',{status:404});

  const pdf=await getBinary(`seo/reports/${id}.pdf`);
  if(!pdf) return new Response('PDF SEO non disponibile',{status:404});

  return new Response(pdf,{
    headers:{
      'content-type':'application/pdf',
      'content-disposition':`inline; filename="seo-audit-${id}.pdf"`,
      'cache-control':'private, max-age=60'
    }
  });
};

export const config={path:'/api/v1/seo/reports/:id/pdf'};
