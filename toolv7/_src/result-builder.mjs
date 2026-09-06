import crypto from 'node:crypto';
import { summarizeIncompleteRows, TRIAGE_LABELS } from './triage.mjs';

export const API_RESULT_SCHEMA = 'wdc013.a11y-result.v1';
export const SCANNER_VERSION = '0.7.0-netlify';
const IMPACT_WEIGHT = { critical: 28, serious: 18, moderate: 8, minor: 3, unknown: 5 };
const BEHAVIOR_WEIGHT = { fail: 18, warning: 6 };
const ODOO_STATUS = {
  good: { key: 'good', label_it: 'Buona' },
  review_required: { key: 'attention', label_it: 'Attenzione' },
  issues_found: { key: 'attention', label_it: 'Attenzione' },
  critical: { key: 'critical', label_it: 'Critica' },
  blocked: { key: 'blocked', label_it: 'Bloccata' },
};
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

function groupConfirmed(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.regola}\u0000${r.impatto || ''}`;
    let g = map.get(key);
    if (!g) g = { rule:r.regola, impact:r.impatto||'unknown', occurrences:0, pages:new Set(), help:r.aiuto||null, help_url:r.help_url||null };
    g.occurrences++; g.pages.add(r.url); map.set(key,g);
  }
  return [...map.values()].map(g=>({...g,pages:g.pages.size})).sort((a,b)=>b.occurrences-a.occurrences || a.rule.localeCompare(b.rule));
}

function stableHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,16);
}

function behaviorCounts(rows) {
  const out={pass:0,fail:0,warning:0,inconclusive:0};
  for(const b of rows) out[b.stato]=(out[b.stato]||0)+1;
  return out;
}

export function buildResult({ jobId, externalRef=null, scan, previousResult=null, baseUrl }) {
  const confirmed = groupConfirmed(scan.violations);
  const incompleteTriage = summarizeIncompleteRows(scan.incomplete);
  const failedPages = scan.pages.filter(p=>p.error || (p.http_status!=null && p.http_status>=400));
  const byImpact={};
  let penalty=0;
  for(const r of confirmed){byImpact[r.impact]=(byImpact[r.impact]||0)+1; penalty += Math.min(60,(IMPACT_WEIGHT[r.impact]||5));}
  const bc=behaviorCounts(scan.behavioral);
  for(const [s,n] of Object.entries(bc)) penalty += (BEHAVIOR_WEIGHT[s]||0)*n;
  if(failedPages.length) penalty += Math.min(15, failedPages.length*5);
  const provisionalScore=clamp(100-penalty,0,100);
  let score=provisionalScore;
  const first=scan.pages[0];
  const homepageBlocked=!first || first.error || (first.http_status!=null && first.http_status>=400);
  const behavioralNeedsReview=scan.behavioral.some(b=>['warning','inconclusive'].includes(b.stato));
  const automationReviewRequired=scan.incomplete.length>0 || behavioralNeedsReview;
  let status='good';
  if(homepageBlocked) {status='blocked'; score=0;}
  else if((byImpact.critical||0)>0 || bc.fail>0 || provisionalScore<60) status='critical';
  else if(confirmed.length || failedPages.length) status='issues_found';
  else if(automationReviewRequired){status='review_required'; score=null;}

  const issueLines=[];
  for(const r of confirmed.slice(0,12)) issueLines.push(`- [AXE][${String(r.impact).toUpperCase()}] ${r.rule}: ${r.occurrences} occorrenza/e su ${r.pages} pagina/e`);
  for(const r of incompleteTriage.perRule.slice(0,10)) issueLines.push(`- [AXE-INCOMPLETE][${r.classification.toUpperCase()}][${String(r.impatto||'unknown').toUpperCase()}] ${r.regola}: ${r.occurrences} occorrenza/e, ${r.unique_components} componente/i unico/i su ${r.pages} pagina/e; ${TRIAGE_LABELS[r.classification]}. Non è una violazione confermata.`);
  for(const b of scan.behavioral.filter(x=>['fail','warning','inconclusive'].includes(x.stato)).slice(0,10)) issueLines.push(`- [BEHAVIOR][${b.stato.toUpperCase()}] ${b.voce}: ${b.nota||'anomalia rilevata'}`);
  for(const p of failedPages.slice(0,8)) issueLines.push(`- [PAGE] ${p.url}: ${p.error || `HTTP ${p.http_status}`}`);
  if(!issueLines.length) issueLines.push('- Nessuna violazione automatica, risultato incomplete o anomalia comportamentale rilevata nei controlli eseguiti.');

  const recs=[];
  if(confirmed.length) recs.push('- Correggere prima le violazioni axe con impatto critical/serious, poi moderate/minor.');
  if(bc.fail||bc.warning) recs.push('- Verificare manualmente le anomalie comportamentali e conservarne evidenza prima di considerarle risolte.');
  if(scan.incomplete.length){const t=incompleteTriage.totals; recs.push(`- Revisionare ${t.occurrences} occorrenza/e axe “incomplete”, raggruppate in ${t.unique_components} componente/i unici.`); if(t.probable_issue.unique_components) recs.push(`- Dare priorità ai ${t.probable_issue.unique_components} componente/i classificati come probabile problema da confermare.`);}
  recs.push('- Eseguire comunque la checklist umana: screen reader reale, significatività dei testi alternativi, ordine di lettura e casi contestuali.');
  recs.push('- Il punteggio è uno score tecnico automatico del monitoraggio, non una certificazione di conformità WCAG.');

  const currentFp=new Set(scan.violations.map(v=>v.fingerprint));
  let diff={comparable:false,new_count:0,resolved_count:0};
  if(previousResult && previousResult.scan_mode===scan.scan_mode && JSON.stringify((previousResult.details?.page_urls||[]).slice().sort())===JSON.stringify(scan.pages.map(p=>p.url).slice().sort())){
    const old=new Set(previousResult.details?.confirmed_fingerprints||[]);
    diff={comparable:true,new_count:[...currentFp].filter(x=>!old.has(x)).length,resolved_count:[...old].filter(x=>!currentFp.has(x)).length};
  }

  const incompleteRules=incompleteTriage.perRule.map(r=>({rule:r.regola,impact:r.impatto,classification:r.classification,classification_label:TRIAGE_LABELS[r.classification],occurrences:r.occurrences,unique_components:r.unique_components,pages:r.pages,repeated_template_components:r.repeated_template_components}));
  const behaviorDetails=scan.behavioral.map(b=>({check:b.voce,status:b.stato,confidence:b.confidence,url:b.url,note:b.nota||null,evidence:b.evidence||{}}));
  const auditHash=stableHash({schema:API_RESULT_SCHEMA,url:baseUrl,scan_mode:scan.scan_mode,status,score,confirmed:confirmed.map(({rule,impact,occurrences,pages})=>({rule,impact,occurrences,pages})),incomplete:incompleteRules.map(({rule,impact,classification,occurrences,unique_components,pages})=>({rule,impact,classification,occurrences,unique_components,pages})),behavior:behaviorDetails.map(({check,status,confidence,url})=>({check,status,confidence,url})),failed:failedPages.map(p=>({url:p.url,status:p.http_status,error:p.error||null}))});
  const odoo=ODOO_STATUS[status]||ODOO_STATUS.review_required;
  const now=new Date().toISOString();

  return {
    schema_version:API_RESULT_SCHEMA, scanner_version:SCANNER_VERSION, ok:status!=='blocked',
    site_id:externalRef||jobId, scan_id:jobId, external_ref:externalRef, url:baseUrl, scan_mode:scan.scan_mode,
    status, score, provisional_score:provisionalScore, score_is_provisional:status==='review_required', automation_review_required:automationReviewRequired,
    audited_pages:scan.pages.length, failed_pages:failedPages.length,
    summary:{status,score,provisional_score:provisionalScore,review_required:automationReviewRequired,audited_pages:scan.pages.length,failed_pages:failedPages.length,confirmed_violation_occurrences:scan.violations.length,confirmed_distinct_rules:confirmed.length,incomplete_occurrences:incompleteTriage.totals.occurrences,incomplete_unique_components:incompleteTriage.totals.unique_components,behavioral:bc,diff},
    wdc013:{odoo_status_key:odoo.key,odoo_status_label_it:odoo.label_it,accessibility_score:score,last_audit_at:now,issues_text:issueLines.join('\n'),recommendations_text:recs.join('\n'),report_path:`/api/v1/reports/${jobId}`,audit_hash:auditHash,automatic_status:status,review_required:automationReviewRequired},
    axe:{violation_occurrences:scan.violations.length,distinct_rules:confirmed.length,by_impact:byImpact,passes_total:scan.passes_total||0,incomplete_total:scan.incomplete.length,incomplete_distinct_rules:incompleteRules.length,incomplete_serious_or_critical_rules:incompleteRules.filter(r=>['critical','serious'].includes(String(r.impact||'').toLowerCase())).map(r=>({rule:r.rule,impact:r.impact,occurrences:r.occurrences,pages:r.pages})),incomplete_triage:{raw_occurrences:incompleteTriage.totals.occurrences,unique_components:incompleteTriage.totals.unique_components,probable_issue:incompleteTriage.totals.probable_issue,targeted_review:incompleteTriage.totals.targeted_review,manual_review:incompleteTriage.totals.manual_review,rules:incompleteRules}},
    behavioral:bc, manual_review_required:true, human_required:['screen_reader_reale','significativita_alt','ordine_lettura_semantico','chiarezza_messaggi_e_contesto'],
    issues_text:issueLines.join('\n'), recommendations_text:recs.join('\n'), diff,
    details:{confirmed_rules:confirmed,incomplete_rules:incompleteRules,behavioral_checks:behaviorDetails,failed_pages:failedPages.map(p=>({url:p.url,http_status:p.http_status,error:p.error||null})),page_urls:scan.pages.map(p=>p.url),confirmed_fingerprints:[...currentFp]},
    report:{html_path:`/api/v1/reports/${jobId}`,pdf_path:`/api/v1/reports/${jobId}/pdf`}, audit_hash:auditHash,
    methodology:'axe-core WCAG 2.1 A/AA + Playwright behavioral checks + Chromium Accessibility Tree; non equivale a audit WCAG completo.', generated_at:now,
  };
}

function esc(s){return String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}
export function buildHtmlReport(result) {
  const r=result; const rules=r.details.confirmed_rules||[]; const incomplete=r.details.incomplete_rules||[]; const behavior=r.details.behavioral_checks||[];
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audit accessibilità — ${esc(r.url)}</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#172033}h1,h2{color:#0b1739}.card{border:1px solid #dfe5ef;border-radius:12px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric{background:#f7f9fc;border-radius:10px;padding:14px}.bad{font-weight:700}.muted{color:#667085}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #e7ebf2;padding:10px;vertical-align:top}pre{white-space:pre-wrap;background:#f7f9fc;padding:14px;border-radius:8px}</style></head><body><h1>Audit accessibilità automatico</h1><p class="muted">Scanner ${esc(r.scanner_version)} · ${esc(r.generated_at)} · Modalità ${esc(r.scan_mode)}</p><div class="grid"><div class="metric"><b>Stato</b><br>${esc(r.status)}</div><div class="metric"><b>Score tecnico</b><br>${r.score==null?'Non conclusivo':esc(r.score)+'/100'}</div><div class="metric"><b>Pagine</b><br>${r.audited_pages}</div><div class="metric"><b>Violazioni confermate</b><br>${r.summary.confirmed_violation_occurrences}</div><div class="metric"><b>Incomplete</b><br>${r.summary.incomplete_occurrences}</div></div><div class="card"><h2>Violazioni confermate</h2><table><thead><tr><th>Regola</th><th>Impatto</th><th>Occorrenze</th><th>Pagine</th></tr></thead><tbody>${rules.map(x=>`<tr><td>${esc(x.rule)}</td><td>${esc(x.impact)}</td><td>${x.occurrences}</td><td>${x.pages}</td></tr>`).join('')||'<tr><td colspan="4">Nessuna violazione confermata</td></tr>'}</tbody></table></div><div class="card"><h2>Risultati incomplete</h2><table><thead><tr><th>Regola</th><th>Classificazione</th><th>Occorrenze</th><th>Componenti unici</th></tr></thead><tbody>${incomplete.map(x=>`<tr><td>${esc(x.rule)}</td><td>${esc(x.classification_label)}</td><td>${x.occurrences}</td><td>${x.unique_components}</td></tr>`).join('')||'<tr><td colspan="4">Nessun incomplete</td></tr>'}</tbody></table></div><div class="card"><h2>Behavioral checks</h2><table><thead><tr><th>Check</th><th>Stato</th><th>Confidenza</th><th>Nota</th></tr></thead><tbody>${behavior.map(x=>`<tr><td>${esc(x.check)}</td><td>${esc(x.status)}</td><td>${esc(x.confidence)}</td><td>${esc(x.note)}</td></tr>`).join('')}</tbody></table></div><div class="card"><h2>Problemi / segnali</h2><pre>${esc(r.issues_text)}</pre></div><div class="card"><h2>Azioni consigliate</h2><pre>${esc(r.recommendations_text)}</pre></div><p class="muted">${esc(r.methodology)}</p></body></html>`;
}
