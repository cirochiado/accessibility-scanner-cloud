// Triage dei risultati axe `incomplete`.
//
// IMPORTANTISSIMO: un `incomplete` non viene mai promosso automaticamente
// a violazione WCAG confermata. Questo modulo serve solo a stabilire la
// PRIORITA' DELLA REVISIONE UMANA e a non mettere nello stesso calderone
// casi molto diversi.
//
// Le categorie sono volutamente conservative:
// - probable_issue: segnale semantico forte che merita revisione prioritaria;
// - targeted_review: controllo mirato (spesso visivo/contestuale);
// - manual_review: axe non ha deciso, serve verifica umana generica.

const PROBABLE_RULES = new Set([
  'aria-prohibited-attr',
]);

const TARGETED_RULES = new Set([
  'color-contrast',
  'link-in-text-block',
]);

export const TRIAGE_LABELS = {
  probable_issue: 'Probabile problema — confermare',
  targeted_review: 'Da verificare con controllo mirato',
  manual_review: 'Verifica umana necessaria',
};

export function classifyIncompleteRule(rule) {
  const r = String(rule || '').trim().toLowerCase();
  if (PROBABLE_RULES.has(r)) return 'probable_issue';
  if (TARGETED_RULES.has(r)) return 'targeted_review';
  return 'manual_review';
}

// Il selettore viene normalizzato SOLO per deduplicare varianti strutturali
// quasi identiche prodotte da :nth-child/:nth-of-type. Non rimuoviamo id,
// href, classi o attributi significativi: collassare troppo aggressivamente
// potrebbe nascondere problemi distinti.
export function canonicalSelector(selector) {
  return String(selector || '')
    .trim()
    .replace(/:nth-(?:child|of-type)\(\s*\d+\s*\)/gi, ':nth-*')
    .replace(/\s+/g, ' ');
}

export function summarizeIncompleteRows(rows) {
  const byRule = new Map();

  for (const row of rows) {
    const rule = String(row.regola || 'sconosciuto');
    const key = `${rule}\u0000${row.impatto || ''}`;
    let group = byRule.get(key);
    if (!group) {
      group = {
        regola: rule,
        impatto: row.impatto || null,
        classification: classifyIncompleteRule(rule),
        occurrences: 0,
        pages: new Set(),
        components: new Map(),
      };
      byRule.set(key, group);
    }

    group.occurrences++;
    group.pages.add(row.url);

    const canonical = canonicalSelector(row.selettore);
    let comp = group.components.get(canonical);
    if (!comp) {
      comp = {
        selector: canonical,
        occurrences: 0,
        pages: new Set(),
        sample_url: row.url,
        sample_selector: row.selettore,
        sample_snippet: row.snippet_html || null,
      };
      group.components.set(canonical, comp);
    }
    comp.occurrences++;
    comp.pages.add(row.url);
  }

  const perRule = [...byRule.values()].map((g) => {
    const components = [...g.components.values()].map((c) => ({
      selector: c.selector,
      occurrences: c.occurrences,
      pages: c.pages.size,
      sample_url: c.sample_url,
      sample_selector: c.sample_selector,
      sample_snippet: c.sample_snippet,
      repeated_template: c.pages.size > 1,
    }));

    return {
      regola: g.regola,
      impatto: g.impatto,
      classification: g.classification,
      occurrences: g.occurrences,
      pages: g.pages.size,
      unique_components: components.length,
      repeated_template_components: components.filter((c) => c.repeated_template).length,
      repeated_template_occurrences: components
        .filter((c) => c.repeated_template)
        .reduce((sum, c) => sum + c.occurrences, 0),
      components,
    };
  }).sort((a, b) =>
    b.occurrences - a.occurrences ||
    a.regola.localeCompare(b.regola)
  );

  const totals = {
    occurrences: perRule.reduce((s, r) => s + r.occurrences, 0),
    unique_components: perRule.reduce((s, r) => s + r.unique_components, 0),
    rules: perRule.length,
    probable_issue: { rules: 0, occurrences: 0, unique_components: 0 },
    targeted_review: { rules: 0, occurrences: 0, unique_components: 0 },
    manual_review: { rules: 0, occurrences: 0, unique_components: 0 },
  };

  for (const r of perRule) {
    const t = totals[r.classification];
    t.rules++;
    t.occurrences += r.occurrences;
    t.unique_components += r.unique_components;
  }

  return { totals, perRule };
}
