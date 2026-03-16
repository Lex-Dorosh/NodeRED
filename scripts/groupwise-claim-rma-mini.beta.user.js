// ==UserScript==
// @name         Groupwise Claim RMA (Samsung) [BETA]
// @namespace    https://groupwise.cerepair.nl/
// @version      0.1.1-beta
// @description  Samsung-only: robust Claim/Repair navigation -> Exchange reason = G (Commerciele redenen) -> Opslaan -> Repair
// @author       Alex + OpenClaw Copilot
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/gxo-beta/scripts/groupwise-claim-rma-mini.beta.user.js
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/gxo-beta/scripts/groupwise-claim-rma-mini.beta.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    debug: true,
    btnId: 'tm-claim-rma-btn',
    btnText: 'CLAIM RMA',
    retryMs: 220,
    timeoutMs: 12000,
  };

  const log = (...a) => CFG.debug && console.log('[CLAIM-RMA]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function allDocs() {
    const docs = [];
    const seen = new Set();
    const add = (d) => { if (d && !seen.has(d)) { seen.add(d); docs.push(d); } };

    function walk(w) {
      try { add(w.document); } catch { return; }
      let frames = [];
      try { frames = [...w.document.querySelectorAll('frame,iframe')]; } catch {}
      for (const f of frames) {
        try { if (f.contentWindow) walk(f.contentWindow); else add(f.contentDocument); } catch {}
      }
    }

    walk(window);
    try { if (window.top !== window) walk(window.top); } catch {}
    return docs;
  }

  function q(selector) {
    for (const d of allDocs()) {
      const el = d.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function qAll(selector) {
    const out = [];
    for (const d of allDocs()) out.push(...d.querySelectorAll(selector));
    return out;
  }

  async function waitFor(fn, timeout = CFG.timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(CFG.retryMs);
    }
    return null;
  }

  function triggerChange(el) {
    if (!el) return;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  }

  function isSamsungOrder() {
    const legends = qAll('legend');
    return legends.some((l) => /\bsamsung\b/i.test(String(l.textContent || '')));
  }

  function clickTabByText(text) {
    const target = String(text || '').trim().toLowerCase();

    // Pattern 1 (stable from PUR helper): #rw_tabs div.tab -> click parent td
    const tabs = qAll('#rw_tabs div.tab');
    const tab = tabs.find((t) => String(t.textContent || '').trim().toLowerCase() === target);
    if (tab && tab.parentElement) {
      tab.parentElement.click();
      return true;
    }

    // Pattern 2 fallback: td with text
    const tds = qAll('td[id^="td"]');
    const td = tds.find((t) => (t.textContent || '').toLowerCase().includes(target));
    if (!td) return false;
    td.click();
    return true;
  }

  function onClaimPage() {
    return /name=claim/i.test(location.href) || !!q('#reason_of_exchange');
  }

  function onRepairPage() {
    return /name=reparatie/i.test(location.href) || !!q('#workdescription');
  }

  async function runFlow(btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'RUN...';

    try {
      if (!isSamsungOrder()) {
        alert('Samsung order niet gedetecteerd. Script werkt alleen voor Samsung.');
        return;
      }

      if (!onClaimPage()) {
        const okTab = clickTabByText('Claim');
        if (!okTab) {
          alert('Claim tab niet gevonden.');
          return;
        }
        const claimReady = await waitFor(() => onClaimPage());
        if (!claimReady) {
          alert('Claim tab niet geladen op tijd.');
          return;
        }
      }

      const sel = await waitFor(() => q('#reason_of_exchange'));
      if (!sel) {
        alert('Exchange reason veld (#reason_of_exchange) niet gevonden.');
        return;
      }

      const optionG = sel.querySelector('option[value="G"]') || Array.from(sel.options || []).find(o => /G:\s*Commerciele redenen/i.test(String(o.textContent || '')));
      if (!optionG) {
        alert('Optie G: Commerciele redenen niet gevonden.');
        return;
      }

      sel.value = optionG.value;
      optionG.selected = true;
      triggerChange(sel);
      log('Exchange reason ->', optionG.value, optionG.textContent || '');

      const saveBtn = await waitFor(() => q('#opslaan,button#opslaan,input#opslaan'));
      if (!saveBtn) {
        alert('Opslaan knop niet gevonden (#opslaan).');
        return;
      }

      saveBtn.click();
      await sleep(800);

      const back = clickTabByText('Repair');
      if (!back) {
        alert('Repair tab niet gevonden na save.');
        return;
      }

      await waitFor(() => onRepairPage());
      log('Flow done');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function mountButton() {
    if (!isSamsungOrder()) {
      const ex = q('#' + CFG.btnId);
      if (ex) ex.remove();
      return;
    }

    const anchor = q('#comments') || q('#btn_iriscodes') || q('h3');
    if (!anchor) return;
    if (q('#' + CFG.btnId)) return;

    const d = anchor.ownerDocument || document;
    const btn = d.createElement('button');
    btn.id = CFG.btnId;
    btn.type = 'button';
    btn.textContent = CFG.btnText;
    btn.style.cssText = 'margin-left:8px;padding:2px 8px;height:22px;border:1px solid #6e8b5b;background:#dcebd3;color:#234019;border-radius:4px;cursor:pointer;font:700 11px/1 Arial,sans-serif;vertical-align:middle;';
    btn.addEventListener('click', () => runFlow(btn));

    anchor.insertAdjacentElement('afterend', btn);
  }

  setInterval(() => {
    try { mountButton(); } catch {}
  }, 1000);
})();
