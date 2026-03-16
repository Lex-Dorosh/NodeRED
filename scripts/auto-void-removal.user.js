// ==UserScript==
// @name         Groupwise/GSPN - AUTO VOID REMOVAL
// @namespace    froopt/groupwise
// @version      0.1.4
// @description  Semi-automatic VOID removal flow: Groupwise -> GSPN
// @match        https://groupwise.cerepair.nl/*
// @match        https://biz1.samsungcsportal.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY = 'avr_ctx_v1';
  const CFG = {
    debug: true,
    groupwiseVoidCode: '', // empty value => ---------
    gspnUrl: 'https://biz1.samsungcsportal.com/gspn/operate.do',
    gspnAscAllValue: '', // --ALL--
    pollMs: 500,
    maxWaitMs: 30000,
  };

  function log(...args) {
    if (CFG.debug) console.log('[AUTO-VOID]', ...args);
  }

  async function setState(patch) {
    const prev = (await GM_getValue(KEY, {})) || {};
    const next = { ...prev, ...patch, ts: Date.now() };
    await GM_setValue(KEY, next);
    log('STATE ->', next);
    return next;
  }

  function toast(msg, type = 'ok') {
    const map = { ok: '#1f8b4c', warn: '#b7791f', err: '#b91c1c' };
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      padding: '10px 12px', color: '#fff', background: map[type] || map.ok,
      borderRadius: '8px', fontSize: '13px', boxShadow: '0 6px 20px rgba(0,0,0,.25)'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function allDocs() {
    const docs = [];
    const seen = new Set();
    function add(d){ if (d && !seen.has(d)) { seen.add(d); docs.push(d); } }
    function walk(w){
      try { add(w.document); } catch { return; }
      let fr=[]; try { fr = [...w.document.querySelectorAll('frame,iframe')]; } catch {}
      for (const f of fr) { try { if (f.contentWindow) walk(f.contentWindow); else add(f.contentDocument); } catch {} }
    }
    walk(window); try { if (window.top !== window) walk(window.top); } catch {}
    return docs;
  }

  function q(selector) {
    for (const d of allDocs()) {
      const el = d.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function visible(el) {
    if (!el) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
    if (!style) return true;
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function qAll(selector) {
    const out = [];
    for (const d of allDocs()) out.push(...d.querySelectorAll(selector));
    return out;
  }

  async function waitFor(fn, timeout = CFG.maxWaitMs, label = 'unknown') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) {
        log(`waitFor(${label}) -> OK in ${Date.now() - t0}ms`);
        return v;
      }
      await sleep(CFG.pollMs);
    }
    log(`waitFor(${label}) -> TIMEOUT after ${timeout}ms`);
    return null;
  }

  function clickTabByText(tabText) {
    const tabs = qAll('td[id^="td"]');
    const td = tabs.find(t => (t.textContent || '').toLowerCase().includes(tabText.toLowerCase()));
    if (!td) return false;
    td.click();
    return true;
  }

  function getPageName() {
    const m = location.href.match(/[?&]name=([^&]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  }

  function getItemId() {
    const m = location.href.match(/[?&]item_id=(\d+)/i);
    return m ? m[1] : '';
  }

  function getOrderNr() {
    const h3 = q('h3');
    const txt = (h3?.textContent || '').trim();
    const m = txt.match(/reparatie\s+(\d+)/i) || txt.match(/\b(\d{6,})\b/);
    return m ? m[1] : '';
  }

  function getAuthNr() {
    return (q('#authorisationnumber')?.value || '').trim();
  }

  async function runGroupwiseFlow() {
    log('Groupwise flow started');
    const itemId = getItemId();
    await setState({ flow: 'groupwise', step: 'claim_requested', itemId });

    if (!clickTabByText('Claim')) {
      await setState({ step: 'error_claim_tab' });
      toast('Claim tab not found', 'err');
      return;
    }

    toast('Opening Claim tab...', 'ok');
  }

  async function continueGroupwiseFlowIfNeeded() {
    const ctx = await GM_getValue(KEY, null);
    if (!ctx || ctx.flow !== 'groupwise') return;

    const page = getPageName();
    const itemId = getItemId();
    if (ctx.itemId && itemId && ctx.itemId !== itemId) return;

    log('Resume groupwise flow', { page, ctx });

    if (ctx.step === 'claim_requested' && page === 'claim') {
      const cancelSel = await waitFor(() => {
        const el = q('#cancelreason');
        return visible(el) ? el : null;
      }, CFG.maxWaitMs, 'cancelreason_visible');

      if (!cancelSel) {
        await setState({ step: 'error_cancelreason_not_found' });
        return toast('Cancel Reason not found', 'err');
      }

      cancelSel.focus();
      cancelSel.click();
      await sleep(120);

      const firstOpt = cancelSel.querySelector('option[value=""]') || cancelSel.options[0];
      if (!firstOpt) {
        await setState({ step: 'error_cancelreason_option_missing' });
        return toast('Cancel Reason empty option not found', 'err');
      }

      cancelSel.value = firstOpt.value;
      firstOpt.selected = true;
      cancelSel.dispatchEvent(new Event('input', { bubbles: true }));
      cancelSel.dispatchEvent(new Event('change', { bubbles: true }));
      cancelSel.blur();

      await setState({ step: 'cancel_reason_set_empty' });

      const saveBtn = await waitFor(() => {
        const b = q('#opslaan') || q('button#opslaan');
        return visible(b) ? b : null;
      }, CFG.maxWaitMs, 'opslaan_visible');

      if (!saveBtn) {
        await setState({ step: 'error_opslaan_not_found' });
        return toast('Opslaan not found', 'err');
      }

      saveBtn.focus();
      saveBtn.click();
      await setState({ step: 'repair_requested' });
      await sleep(900);

      if (!clickTabByText('Repair')) {
        await setState({ step: 'error_repair_tab_not_found' });
        return toast('Repair tab not found', 'err');
      }

      return;
    }

    if (ctx.step === 'repair_requested' && page === 'reparatie') {
      const auth = await waitFor(() => getAuthNr(), CFG.maxWaitMs, 'authorisationnumber');
      const order = getOrderNr();
      log('Collected order/auth:', { order, auth });

      if (!auth) {
        await setState({ step: 'error_auth_missing', order });
        return toast('Auth number missing', 'err');
      }

      await setState({ flow: 'handover_to_gspn', step: 'gspn_open', order, auth, itemId });
      GM_setClipboard(auth, { type: 'text', mimetype: 'text/plain' });
      window.open(CFG.gspnUrl, '_blank');
      toast(`VOID saved. Auth ${auth} copied. Opening GSPN...`, 'ok');
    }
  }

  async function gspnOpenMenu() {
    const svcTracking = qAll('td').find(td => (td.textContent || '').trim() === 'Service Tracking');
    if (svcTracking) svcTracking.click();
    await sleep(300);

    const lite = qAll('td').find(td => /Service Order Management Lite/i.test(td.textContent || ''));
    if (!lite) return false;
    lite.click();
    return true;
  }

  async function runGspnFlow() {
    const ctx = await GM_getValue(KEY, null);
    if (!ctx || ctx.step !== 'gspn_open') {
      log('GSPN flow skipped: no pending context', ctx);
      return;
    }

    log('GSPN flow started with context:', ctx);
    await setState({ flow: 'gspn', step: 'gspn_start' });

    const okMenu = await gspnOpenMenu();
    if (!okMenu) {
      await setState({ step: 'error_gspn_menu_not_found' });
      return toast('GSPN menu not found. Open Service Tracking > Service Order Management Lite manually.', 'warn');
    }
    await setState({ step: 'gspn_lite_opened' });

    const input = await waitFor(() => q('#service_order_no'), CFG.maxWaitMs, 'service_order_no');
    if (!input) {
      await setState({ step: 'error_service_order_no_not_found' });
      return toast('service_order_no not found', 'err');
    }

    input.value = ctx.auth;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await setState({ step: 'gspn_auth_filled', auth: ctx.auth });

    const asc = q('#asc_code');
    if (asc) {
      asc.value = CFG.gspnAscAllValue;
      asc.dispatchEvent(new Event('change', { bubbles: true }));
      await setState({ step: 'gspn_branch_all_selected' });
    } else {
      log('asc_code select not found, continue');
    }

    const searchLink = qAll('a').find(a => (a.textContent || '').trim().toLowerCase() === 'search');
    if (!searchLink) {
      await setState({ step: 'error_search_link_not_found' });
      return toast('Search link not found', 'err');
    }
    searchLink.click();
    await setState({ step: 'gspn_search_clicked' });

    await sleep(1100);
    const editLink = qAll('a').find(a => /edit/i.test(a.textContent || '') && (a.getAttribute('href') || '').includes('svcOrderLinkLiteEdit'));
    if (!editLink) {
      await setState({ step: 'error_edit_link_not_found' });
      toast('Edit link not found. Check results/filter.', 'warn');
      return;
    }
    editLink.click();

    await setState({ step: 'gspn_status_pending' });
    toast('Opened Edit in GSPN. Next: set Status/Reason = Pending (step 11).', 'ok');
  }

  function injectButtonGroupwise() {
    const comments = q('#comments');
    if (!comments) return false;
    if (q('#btnAutoVoidRemoval')) return true;

    const btn = document.createElement('button');
    btn.id = 'btnAutoVoidRemoval';
    btn.type = 'button';
    btn.textContent = 'VOID REM.';
    Object.assign(btn.style, {
      marginLeft: '8px', padding: '4px 8px', cursor: 'pointer',
      background: '#b91c1c', color: '#fff', border: '1px solid #7f1d1d', borderRadius: '4px'
    });
    btn.addEventListener('click', runGroupwiseFlow);
    comments.insertAdjacentElement('afterend', btn);
    log('Button VOID REM injected');
    return true;
  }

  function bootGroupwise() {
    continueGroupwiseFlowIfNeeded();

    if (injectButtonGroupwise()) return;
    const t = setInterval(() => { if (injectButtonGroupwise()) clearInterval(t); }, 600);
    setTimeout(() => clearInterval(t), 15000);
  }

  function boot() {
    const h = location.hostname;
    log('Boot on host:', h, 'url:', location.href);

    // Groupwise UI usually lives in nested frames; allow injection in frame with #comments
    if (h.includes('groupwise.cerepair.nl')) bootGroupwise();

    // GSPN flow can run from top window context
    if (h.includes('samsungcsportal.com') && window.top === window) runGspnFlow();
  }

  boot();
})();
