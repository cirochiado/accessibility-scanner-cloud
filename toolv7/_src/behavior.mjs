const INTERACTIVE_AX_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider',
  'spinbutton', 'option', 'treeitem',
]);

function check(voce, stato, confidence, url, evidence = {}, nota = null) {
  return { voce, stato, confidence, url, evidence, nota };
}

async function accessibilityTreeCheck(page, url) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Accessibility.enable');
    const { nodes = [] } = await session.send('Accessibility.getFullAXTree');
    await session.detach().catch(() => {});

    const unnamed = [];
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = String(n.role?.value || '').toLowerCase();
      if (!INTERACTIVE_AX_ROLES.has(role)) continue;
      const name = String(n.name?.value || '').trim();
      if (name) continue;
      unnamed.push({ role, nodeId: n.nodeId || null });
      if (unnamed.length >= 12) break;
    }
    if (unnamed.length) {
      return check('ax-interactive-names', 'fail', 'high', url, { unnamed },
        `${unnamed.length} elemento/i interattivo/i nell’Accessibility Tree senza nome accessibile.`);
    }
    return check('ax-interactive-names', 'pass', 'high', url, { checkedNodes: nodes.length },
      'Nessun elemento interattivo senza nome rilevato nell’Accessibility Tree di Chromium.');
  } catch (err) {
    return check('ax-interactive-names', 'inconclusive', 'low', url, { error: err.message },
      'Accessibility Tree non disponibile in questa esecuzione.');
  }
}

async function reflowCheck(page, url) {
  const original = page.viewportSize() || { width: 1366, height: 900 };
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      bodyScroll: document.body?.scrollWidth ?? 0,
      bodyClient: document.body?.clientWidth ?? 0,
    }));
    const overflow = Math.max(m.docScroll - m.docClient, m.bodyScroll - m.bodyClient);
    if (overflow > 4) {
      return check('reflow-320', 'warning', 'medium', url, { ...m, overflowPx: overflow },
        `Possibile overflow orizzontale a viewport 320px (${overflow}px). Verifica manuale richiesta: alcune eccezioni WCAG sono legittime.`);
    }
    return check('reflow-320', 'pass', 'medium', url, { ...m, overflowPx: Math.max(0, overflow) },
      'Nessun overflow orizzontale evidente a viewport 320px.');
  } catch (err) {
    return check('reflow-320', 'inconclusive', 'low', url, { error: err.message }, 'Test reflow non conclusivo.');
  } finally {
    await page.setViewportSize(original).catch(() => {});
  }
}

async function keyboardFocusCheck(page, url, requestedMaxTabs = null) {
  try {
    const candidateInfo = await page.evaluate(() => {
      const selector = [
        'a[href]', 'area[href]', 'button', 'input:not([type="hidden"])',
        'select', 'textarea', 'iframe', 'object', 'embed',
        '[contenteditable="true"]', '[tabindex]'
      ].join(',');
      const visible = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const items = [...document.querySelectorAll(selector)].filter((el) => {
        if (!visible(el)) return false;
        if (el.matches(':disabled,[aria-disabled="true"]')) return false;
        const ti = el.getAttribute('tabindex');
        if (ti !== null && Number(ti) < 0) return false;
        return true;
      });
      return {
        total: items.length,
        sample: items.slice(0, 12).map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          href: el.getAttribute('href') || null,
          text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80),
        })),
      };
    });

    // Il vecchio limite fisso di 25 Tab poteva rendere "non conclusivo"
    // un sito con 30-40 elementi anche quando la sequenza era corretta.
    // Ora il budget scala col numero di candidati, con un tetto di sicurezza.
    const autoBudget = Math.min(120, Math.max(25, candidateInfo.total + 5));
    const tabBudget = requestedMaxTabs == null
      ? autoBudget
      : Math.min(120, Math.max(1, Number(requestedMaxTabs) || autoBudget));

    await page.evaluate(() => {
      const a = document.activeElement;
      if (a && typeof a.blur === 'function') a.blur();
    }).catch(() => {});

    const visited = [];
    const weak = [];
    const visitedKeys = new Set();
    let loopDetected = false;

    for (let i = 0; i < tabBudget; i++) {
      await page.keyboard.press('Tab');

      const info = await page.evaluate(() => {
        const selector = [
          'a[href]', 'area[href]', 'button', 'input:not([type="hidden"])',
          'select', 'textarea', 'iframe', 'object', 'embed',
          '[contenteditable="true"]', '[tabindex]'
        ].join(',');

        const visibleCandidate = (node) => {
          const cs = getComputedStyle(node);
          const r = node.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          if (node.matches(':disabled,[aria-disabled="true"]')) return false;
          const ti = node.getAttribute('tabindex');
          if (ti !== null && Number(ti) < 0) return false;
          return true;
        };

        const candidates = [...document.querySelectorAll(selector)].filter(visibleCandidate);
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;

        const candidateIndex = candidates.indexOf(el);
        const rect = el.getBoundingClientRect();

        const readStyle = () => {
          const cs = getComputedStyle(el);
          return {
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
            outlineColor: cs.outlineColor,
            outlineOffset: cs.outlineOffset,
            boxShadow: cs.boxShadow,
            borderColor: cs.borderColor,
            borderWidth: cs.borderWidth,
            backgroundColor: cs.backgroundColor,
            color: cs.color,
            textDecoration: cs.textDecorationLine,
          };
        };

        const focused = readStyle();
        const focusVisibleMatch = typeof el.matches === 'function' ? el.matches(':focus-visible') : null;

        el.blur();
        const blurred = readStyle();
        el.focus();

        const changed = Object.keys(focused).filter((k) => focused[k] !== blurred[k]);
        const outlineWidth = Number.parseFloat(focused.outlineWidth) || 0;
        const explicitIndicator =
          (focused.outlineStyle !== 'none' && outlineWidth > 0) ||
          (focused.boxShadow && focused.boxShadow !== 'none') ||
          changed.length > 0;

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(el).visibility !== 'hidden' &&
          getComputedStyle(el).display !== 'none';

        // candidateIndex identifica l'elemento DOM reale. Due link identici
        // in header e footer non vengono più scambiati per un focus loop.
        const fallbackKey = [
          el.tagName.toLowerCase(),
          el.id ? `#${el.id}` : '',
          el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '',
          el.getAttribute('href') ? `[href="${String(el.getAttribute('href')).slice(0, 120)}"]` : '',
          String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 50),
        ].join('');

        return {
          key: candidateIndex >= 0 ? `idx:${candidateIndex}` : `fallback:${fallbackKey}`,
          candidateIndex,
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 100),
          focusVisibleMatch,
          styleChangedProperties: changed,
          explicitIndicator,
          visible,
        };
      });

      if (!info) continue;

      if (visitedKeys.has(info.key)) {
        loopDetected = true;
        break;
      }

      visitedKeys.add(info.key);
      visited.push(info);

      // Non basta che :focus-visible sia false per dichiarare un problema:
      // alcuni siti mostrano il focus tramite background/border/box-shadow.
      if (info.visible && !info.explicitIndicator) weak.push(info);
    }

    const coverage = candidateInfo.total
      ? Math.min(1, visited.length / candidateInfo.total)
      : 1;

    const evidence = {
      visited: visited.length,
      candidateCount: candidateInfo.total,
      coverage: Number(coverage.toFixed(3)),
      tabBudget,
      loopDetected,
      candidateSample: candidateInfo.sample,
    };

    if (!visited.length && candidateInfo.total > 0) {
      return check('keyboard-focus', 'inconclusive', 'medium', url, evidence,
        `${candidateInfo.total} possibile/i elemento/i tabbabile/i rilevato/i nel DOM, ma nessuno è stato raggiunto con Tab. Verifica manuale richiesta.`);
    }

    if (candidateInfo.total >= 5 && coverage < 0.6) {
      return check('keyboard-focus', 'inconclusive', 'medium', url, evidence,
        `Copertura tastiera insufficiente: raggiunti ${visited.length} di circa ${candidateInfo.total} elementi tabbabili rilevati (${Math.round(coverage * 100)}%). Il test non può essere considerato superato.`);
    }

    if (loopDetected && candidateInfo.total > visited.length + 2 && coverage < 0.85) {
      return check('keyboard-focus', 'warning', 'medium', url, evidence,
        `La sequenza Tab è tornata su un elemento già visitato dopo ${visited.length} elementi, mentre il DOM espone circa ${candidateInfo.total} candidati. Possibile focus loop o differenza tra candidati DOM e ordine reale di tabulazione: confermare manualmente.`);
    }

    if (weak.length) {
      return check('keyboard-focus', 'warning', 'medium', url,
        { ...evidence, possibleWeakIndicators: weak.slice(0, 8) },
        `${weak.length} elemento/i focalizzati senza indicatore visivo rilevabile con questa euristica. Confermare manualmente.`);
    }

    if (!candidateInfo.total && !visited.length) {
      return check('keyboard-focus', 'pass', 'medium', url, evidence,
        'Nessun elemento tabbabile rilevato nel DOM e nessun focus raggiunto con Tab.');
    }

    return check('keyboard-focus', 'pass', 'medium', url, evidence,
      `${visited.length} elemento/i raggiunti con Tab su circa ${candidateInfo.total} candidati (${Math.round(coverage * 100)}%); nessuna anomalia evidente secondo l’euristica automatica.`);
  } catch (err) {
    return check('keyboard-focus', 'inconclusive', 'low', url, { error: err.message }, 'Test tastiera/focus non conclusivo.');
  }
}
export async function runBehavioralChecks(page, { maxTabs = null } = {}) {
  const url = page.url();
  const results = [];
  results.push(await accessibilityTreeCheck(page, url));
  results.push(await reflowCheck(page, url));
  results.push(await keyboardFocusCheck(page, url, maxTabs));
  return results;
}
