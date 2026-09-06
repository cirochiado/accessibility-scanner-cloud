import { json } from '../../_src/auth.mjs';
export default async ()=>json({ok:true,service:'a11y-scanner-netlify',version:'0.7.0',result_schema:'wdc013.a11y-result.v1',scan_modes:['single_url','crawl'],storage:'netlify-blobs',runtime:'netlify-functions'});
export const config={path:'/api/v1/health'};
