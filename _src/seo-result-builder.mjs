import crypto from 'node:crypto';

export const SEO_RESULT_SCHEMA = 'wdc014.seo-result.v1';
export const SEO_SCANNER_VERSION = '0.3.0-netlify';

const SEVERITY_WEIGHT = { critical:30, high:12, medium:5, low:2 };
const STATUS = {
  good: { key:'good', label_it:'Buona' },
  opportunities: { key:'opportunities', label_it:'Opportunità rilevate' },
  critical: { key:'critical', label_it:'Critica' },
  blocked: { key:'blocked', label_it:'Bloccata' },
};

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

function fp(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
}

function addIssue(list, {id,type,severity,url=null,message,evidence=null}) {
  list.push({
    id, type, severity, url, message, evidence,
    fingerprint: fp([id,url||'',message]),
  });
}

function groupIssues(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.id}\u0000${row.type}\u0000${row.severity}`;
    let g = map.get(key);
    if (!g) {
      g = {
        id:row.id, type:row.type, severity:row.severity,
        occurrences:0, urls:[], examples:[],
      };
      map.set(key,g);
    }
    g.occurrences++;
    if (row.url && !g.urls.includes(row.url)) g.urls.push(row.url);
    if (g.examples.length < 5) g.examples.push({url:row.url,message:row.message,evidence:row.evidence});
  }
  return [...map.values()].sort((a,b)=>{
    const rank={critical:4,high:3,medium:2,low:1};
    return (rank[b.severity]||0)-(rank[a.severity]||0) || b.occurrences-a.occurrences || a.id.localeCompare(b.id);
  });
}

function canonicalIdentity(p) {
  return String(p.canonical_key || p.canonical_normalized || p.final_url || p.url || '').trim();
}

function uniqueCanonicalPages(pages) {
  const seen = new Set();
  const out = [];
  for (const p of pages) {
    if (p.error) continue;
    const key = canonicalIdentity(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function duplicates(pages, field) {
  const map = new Map();
  for (const p of uniqueCanonicalPages(pages)) {
    const v = String(p[field] || '').trim().toLowerCase();
    if (!v) continue;
    const arr = map.get(v) || [];
    arr.push(p.final_url || p.url);
    map.set(v,arr);
  }
  return [...map.entries()].filter(([,urls])=>urls.length>1);
}

function analyze(scan) {
  const issues = [];
  const pages = scan.pages || [];
  const start = pages[0] || null;

  if (!start || start.error || (start.http_status != null && start.http_status >= 400)) {
    addIssue(issues,{
      id:'homepage-blocked',type:'technical',severity:'critical',url:scan.start_url,
      message:`Homepage non analizzabile${start?.error ? `: ${start.error}` : ''}`,
    });
  }

  if (scan.robots?.disallow_all) {
    addIssue(issues,{
      id:'robots-disallow-all',type:'technical',severity:'critical',url:scan.robots.url,
      message:'robots.txt contiene Disallow: / per User-agent: *; verificare se il blocco totale è intenzionale.',
    });
  }

  if (!scan.robots?.status || scan.robots.status >= 400) {
    addIssue(issues,{
      id:'robots-unavailable',type:'opportunity',severity:'low',url:scan.robots?.url || null,
      message:'robots.txt non disponibile o non verificabile.',
      evidence:{status:scan.robots?.status,error:scan.robots?.error},
    });
  }

  if (!scan.sitemap?.urls?.length) {
    addIssue(issues,{
      id:'sitemap-unavailable',type:'opportunity',severity:'medium',url:scan.start_url,
      message:'Nessuna sitemap XML con URL <loc> è stata rilevata.',
      evidence:{checked:scan.sitemap?.checked_urls || [],error:scan.sitemap?.error || null},
    });
  }

  const scannedByUrl = new Map();
  for (const p of pages) {
    scannedByUrl.set(p.final_url || p.url,p);
    const url = p.final_url || p.url;
    if (p.error || (p.http_status != null && p.http_status >= 400)) {
      addIssue(issues,{
        id:'internal-page-error',type:'technical',severity:'high',url,
        message:p.error || `HTTP ${p.http_status}`,
        evidence:{http_status:p.http_status},
      });
      continue;
    }

    if (!p.title) addIssue(issues,{id:'missing-title',type:'technical',severity:'high',url,message:'Elemento <title> mancante o vuoto.'});
    else {
      if (p.title_length < 25) addIssue(issues,{id:'title-short',type:'opportunity',severity:'low',url,message:`Title molto corto (${p.title_length} caratteri).`});
      if (p.title_length > 65) addIssue(issues,{id:'title-long',type:'opportunity',severity:'medium',url,message:`Title lungo (${p.title_length} caratteri); potrebbe essere troncato nei risultati.`});
    }

    if (!p.meta_description) addIssue(issues,{id:'missing-meta-description',type:'opportunity',severity:'medium',url,message:'Meta description mancante.'});
    else {
      if (p.meta_description_length < 70) addIssue(issues,{id:'meta-description-short',type:'opportunity',severity:'low',url,message:`Meta description molto corta (${p.meta_description_length} caratteri).`});
      if (p.meta_description_length > 170) addIssue(issues,{id:'meta-description-long',type:'opportunity',severity:'low',url,message:`Meta description lunga (${p.meta_description_length} caratteri).`});
    }

    if (!p.h1_count) addIssue(issues,{id:'missing-h1',type:'technical',severity:'medium',url,message:'H1 mancante.'});
    if (p.h1_count > 1) addIssue(issues,{id:'multiple-h1',type:'review',severity:'low',url,message:`Rilevati ${p.h1_count} H1; verificare la gerarchia dei contenuti.`});

    if (!p.canonical) addIssue(issues,{id:'missing-canonical',type:'opportunity',severity:'low',url,message:'Canonical non dichiarato.'});
    else {
      try {
        const canonical = new URL(p.canonical,p.final_url).toString();
        if (new URL(canonical).origin !== new URL(scan.start_url).origin) {
          addIssue(issues,{id:'cross-origin-canonical',type:'review',severity:'high',url,message:'Canonical punta a un dominio differente.',evidence:{canonical}});
        } else if (canonical !== p.final_url) {
          addIssue(issues,{
            id:'canonical-alternate-url',type:'review',severity:'low',url,
            message:'URL analizzata diversa dal canonical; verificare coerenza tra link interni, sitemap e URL preferita.',
            evidence:{canonical}
          });
        }
      } catch {
        addIssue(issues,{id:'invalid-canonical',type:'technical',severity:'medium',url,message:'Canonical non valido.',evidence:{canonical:p.canonical}});
      }
    }

    if (p.noindex) {
      addIssue(issues,{
        id:p.depth===0?'homepage-noindex':'page-noindex',
        type:'review',
        severity:p.depth===0?'critical':'medium',
        url,
        message:p.depth===0?'Homepage marcata noindex.':'Pagina marcata noindex; verificare che sia intenzionale.',
      });
    }

    if (!p.viewport) addIssue(issues,{id:'missing-viewport',type:'technical',severity:'medium',url,message:'Meta viewport mancante.'});
    if (!p.lang) addIssue(issues,{id:'missing-html-lang',type:'technical',severity:'low',url,message:'Attributo lang su <html> mancante.'});
    if (p.json_ld_invalid > 0) addIssue(issues,{id:'invalid-json-ld',type:'technical',severity:'medium',url,message:`${p.json_ld_invalid} blocco/i JSON-LD non validi.`});

    if (p.images_without_alt > 0) addIssue(issues,{
      id:'images-without-alt',type:'opportunity',severity:'low',url,
      message:`${p.images_without_alt} immagine/i senza attributo alt.`,
      evidence:{images:p.images_count,without_alt:p.images_without_alt},
    });

    if (p.word_count < 120 && !p.noindex) addIssue(issues,{
      id:'thin-content',type:'opportunity',severity:'low',url,
      message:`Contenuto testuale molto ridotto (${p.word_count} parole); valutare se la pagina soddisfa l'intento di ricerca.`,
    });

    if (p.mixed_content_count > 0) addIssue(issues,{
      id:'mixed-content',type:'technical',severity:'high',url,
      message:`Rilevati ${p.mixed_content_count} riferimenti HTTP in una pagina HTTPS.`,
    });

    if (p.url_length > 120) addIssue(issues,{id:'long-url',type:'opportunity',severity:'low',url,message:`URL lunga (${p.url_length} caratteri).`});
    if (p.query_param_count > 2) addIssue(issues,{id:'many-query-params',type:'review',severity:'low',url,message:`URL con ${p.query_param_count} parametri; verificare indicizzazione/canonical.`});

    if (!p.og_title || !p.og_description) addIssue(issues,{
      id:'open-graph-incomplete',type:'opportunity',severity:'low',url,
      message:'Metadati Open Graph essenziali incompleti (og:title/og:description).',
    });

    if (p.source === 'sitemap' && p.depth == null && (p.inbound_links || 0) === 0 && p.final_url !== scan.start_url) {
      addIssue(issues,{
        id:'possible-orphan-page',type:'opportunity',severity:'medium',url,
        message:'Pagina trovata dalla sitemap ma senza link interni rilevati nel crawl; possibile pagina orfana.',
      });
    }
  }

  for (const alias of scan.aliases || []) {
    addIssue(issues,{
      id:'canonical-alias-accessible',type:'review',severity:'low',url:alias.url,
      message:'URL alternativa raggiungibile con HTTP 200 e canonical verso un’altra URL; verificare che sia una scelta intenzionale.',
      evidence:{canonical:alias.canonical,duplicate_of:alias.duplicate_of,http_status:alias.http_status},
    });
  }

  for (const [value,urls] of duplicates(pages,'title')) {
    for (const url of urls) addIssue(issues,{
      id:'duplicate-title',type:'technical',severity:'medium',url,
      message:`Title duplicato su ${urls.length} pagine canonicalmente distinte.`,
      evidence:{value,urls},
    });
  }

  for (const [value,urls] of duplicates(pages,'meta_description')) {
    for (const url of urls) addIssue(issues,{
      id:'duplicate-meta-description',type:'opportunity',severity:'low',url,
      message:`Meta description duplicata su ${urls.length} pagine canonicalmente distinte.`,
      evidence:{value,urls},
    });
  }

  const brokenTargets = new Map();
  for (const p of pages) {
    for (const target of p.internal_links || []) {
      const targetPage = scannedByUrl.get(target);
      if (targetPage?.error || (targetPage?.http_status != null && targetPage.http_status >= 400)) {
        const arr = brokenTargets.get(target) || [];
        arr.push(p.final_url || p.url);
        brokenTargets.set(target,arr);
      }
    }
  }
  for (const [target,sources] of brokenTargets) addIssue(issues,{
    id:'broken-internal-link',type:'technical',severity:'high',url:target,
    message:`Link interno verso pagina non disponibile, trovato da ${sources.length} pagina/e.`,
    evidence:{sources},
  });

  return issues;
}

function buildText(groups, types) {
  const selected = groups.filter(g => types.includes(g.type));
  if (!selected.length) return '- Nessun elemento rilevato.';
  return selected.slice(0,20).map(g =>
    `- [${g.severity.toUpperCase()}][${g.id}] ${g.occurrences} occorrenza/e su ${g.urls.length || 1} URL`
  ).join('\n');
}

export function buildSeoResult({jobId,externalRef=null,scan,previousResult=null,baseUrl}) {
  const issues = analyze(scan);
  const groups = groupIssues(issues);
  const scoreableGroups = groups.filter(g=>g.type!=='review');

  let penalty = 0;
  for (const g of scoreableGroups) {
    const perRule = Math.min(
      g.severity === 'critical' ? 40 : g.severity === 'high' ? 24 : g.severity === 'medium' ? 12 : 6,
      (SEVERITY_WEIGHT[g.severity] || 2) * Math.min(g.occurrences,3)
    );
    penalty += perRule;
  }
  let score = clamp(100-penalty,0,100);

  const homepageBlocked = groups.some(g=>g.id==='homepage-blocked');
  const critical = groups.some(g=>g.severity==='critical');
  let status='good';
  if (homepageBlocked) status='blocked';
  else if (critical || score < 50) status='critical';
  else if (groups.length) status='opportunities';
  if (status === 'blocked') score = 0;

  const currentFp = new Set(issues.map(x=>x.fingerprint));
  let diff={comparable:false,new_count:0,resolved_count:0};
  const pageUrls=scan.pages.map(p=>p.final_url||p.url);
  if (
    previousResult &&
    JSON.stringify((previousResult.details?.page_urls||[]).slice().sort()) === JSON.stringify(pageUrls.slice().sort())
  ) {
    const old = new Set(previousResult.details?.issue_fingerprints || []);
    diff = {
      comparable:true,
      new_count:[...currentFp].filter(x=>!old.has(x)).length,
      resolved_count:[...old].filter(x=>!currentFp.has(x)).length,
    };
  }

  const technicalGroups = groups.filter(g=>g.type==='technical');
  const reviewGroups = groups.filter(g=>g.type==='review');
  const opportunityGroups = groups.filter(g=>g.type==='opportunity');
  const technicalText = buildText(groups,['technical']);
  const reviewText = buildText(groups,['review']);
  const opportunitiesText = buildText(groups,['opportunity']);

  const recs=[];
  if (groups.some(g=>g.severity==='critical')) recs.push('- Correggere o confermare prima gli elementi critical che possono impedire o alterare l’indicizzazione.');
  if (technicalGroups.some(g=>g.severity==='high')) recs.push('- Correggere i problemi tecnici high prima delle ottimizzazioni on-page.');
  if (reviewGroups.length) recs.push('- Confermare manualmente gli elementi di review prima di considerarli errori SEO: canonical, noindex e casi contestuali possono essere intenzionali.');
  if (opportunityGroups.length) recs.push('- Valutare le opportunità on-page in base alla funzione reale di ogni pagina; non applicare automaticamente limiti di lunghezza come regole assolute.');
  if (!scan.sitemap?.urls?.length) recs.push('- Verificare la presenza e la correttezza della sitemap XML.');
  recs.push('- Per opportunità keyword/CTR/posizionamento servono dati reali di Google Search Console; questo scanner non inventa volumi o keyword.');

  const auditHash=stableHash({
    schema:SEO_RESULT_SCHEMA,
    scanner:SEO_SCANNER_VERSION,
    url:baseUrl,
    status,
    score,
    pages:pageUrls,
    aliases:scan.aliases || [],
    groups:groups.map(g=>({id:g.id,type:g.type,severity:g.severity,occurrences:g.occurrences,urls:g.urls})),
  });
  const odoo=STATUS[status] || STATUS.opportunities;
  const now=new Date().toISOString();

  return {
    schema_version:SEO_RESULT_SCHEMA,
    scanner_version:SEO_SCANNER_VERSION,
    ok:status!=='blocked',
    job_id:jobId,
    external_ref:externalRef,
    url:baseUrl,
    scan_mode:'crawl',
    status,
    score,
    audited_pages:scan.pages.length,
    failed_pages:scan.pages.filter(p=>p.error || (p.http_status!=null && p.http_status>=400)).length,
    summary:{
      status,score,
      audited_pages:scan.pages.length,
      canonical_aliases_detected:(scan.aliases || []).length,
      technical_issue_rules:technicalGroups.length,
      review_rules:reviewGroups.length,
      opportunity_rules:opportunityGroups.length,
      total_issue_occurrences:issues.length,
      robots:scan.robots,
      sitemap_urls_detected:scan.sitemap?.urls?.length || 0,
      diff,
    },
    wdc014:{
      odoo_status_key:odoo.key,
      odoo_status_label_it:odoo.label_it,
      seo_score:score,
      last_audit_at:now,
      technical_issues_text:technicalText,
      review_text:reviewText,
      opportunities_text:opportunitiesText,
      recommendations_text:recs.join('\n'),
      report_path:`/api/v1/seo/reports/${jobId}`,
      audit_hash:auditHash,
      automatic_status:status,
    },
    issues:{
      technical:technicalGroups,
      review:reviewGroups,
      opportunities:opportunityGroups,
      all:groups,
    },
    diff,
    details:{
      pages:scan.pages,
      aliases:scan.aliases || [],
      robots:scan.robots,
      sitemap:scan.sitemap,
      issue_rows:issues,
      issue_fingerprints:[...currentFp],
      page_urls:pageUrls,
    },
    methodology:'Playwright Chromium crawl + controlli SEO tecnici/on-page deterministici; review contestuali separate dal punteggio; non include dati Search Console, ranking o volumi keyword.',
    audit_hash:auditHash,
    generated_at:now,
    report:{
      html_path:`/api/v1/seo/reports/${jobId}`,
      pdf_path:`/api/v1/seo/reports/${jobId}/pdf`,
    },
  };
}

function esc(s){return String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}

export function buildSeoHtmlReport(result) {
  const groups=result.issues?.all || [];
  const pages=result.details?.pages || [];
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SEO Audit — ${esc(result.url)}</title><style>body{font-family:system-ui,sans-serif;max-width:1180px;margin:40px auto;padding:0 20px;color:#172033}h1,h2{color:#0b1739}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric,.card{border:1px solid #dfe5ef;border-radius:12px;padding:16px}.card{margin:18px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #e7ebf2;padding:9px;vertical-align:top}pre{white-space:pre-wrap;background:#f7f9fc;padding:14px;border-radius:8px}.muted{color:#667085}</style></head><body><h1>SEO Audit automatico</h1><p class="muted">Scanner ${esc(result.scanner_version)} · ${esc(result.generated_at)}</p><div class="grid"><div class="metric"><b>Stato</b><br>${esc(result.status)}</div><div class="metric"><b>SEO Score</b><br>${esc(result.score)}/100</div><div class="metric"><b>Pagine</b><br>${result.audited_pages}</div><div class="metric"><b>Problemi tecnici</b><br>${result.summary.technical_issue_rules}</div><div class="metric"><b>Review</b><br>${result.summary.review_rules}</div><div class="metric"><b>Opportunità</b><br>${result.summary.opportunity_rules}</div></div><div class="card"><h2>Problemi, review e opportunità</h2><table><thead><tr><th>Regola</th><th>Tipo</th><th>Severità</th><th>Occorrenze</th><th>URL</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.id)}</td><td>${esc(g.type)}</td><td>${esc(g.severity)}</td><td>${g.occurrences}</td><td>${g.urls.slice(0,4).map(esc).join('<br>')}</td></tr>`).join('')||'<tr><td colspan="5">Nessun problema/opportunità automatico rilevato</td></tr>'}</tbody></table></div><div class="card"><h2>Pagine analizzate</h2><table><thead><tr><th>URL</th><th>HTTP</th><th>Title</th><th>H1</th><th>Words</th><th>Index</th></tr></thead><tbody>${pages.map(p=>`<tr><td>${esc(p.final_url||p.url)}</td><td>${esc(p.http_status??'')}</td><td>${esc(p.title||'')}</td><td>${esc(p.h1_count??'')}</td><td>${esc(p.word_count??'')}</td><td>${p.noindex?'noindex':'index'}</td></tr>`).join('')}</tbody></table></div><div class="card"><h2>Problemi tecnici</h2><pre>${esc(result.wdc014.technical_issues_text)}</pre></div><div class="card"><h2>Review manuale</h2><pre>${esc(result.wdc014.review_text)}</pre></div><div class="card"><h2>Opportunità</h2><pre>${esc(result.wdc014.opportunities_text)}</pre></div><div class="card"><h2>Azioni consigliate</h2><pre>${esc(result.wdc014.recommendations_text)}</pre></div><p class="muted">${esc(result.methodology)}</p></body></html>`;
}
