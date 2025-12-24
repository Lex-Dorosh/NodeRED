// ==UserScript==
// @name         Werkvoorbereiding GG PUR helper (flow per stap, Claim+Opslaan, Mail+SMS+Status)
// @namespace    https://groupwise.cerepair.nl/
// @version      4.11
// @description  GG PUR helper: Samsung gets AUTO 42,50 full flow (Financials+Bereken+Claim VOID1+Mail direct+SMS+Status). Other brands: Fill-only buttons. Frame-safe Claim tab detection, order-scoped flow state + stale auto-clean, reset button + hotkey, no06 handling.
// @author       you
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-end
// @grant        none

// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/gxo-pur-helper.user.js
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/gxo-pur-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // =========================
  // CONFIG
  // =========================
  const DEBUG = false; // release default

  const FLOW_STATE_KEY = 'gxo_pur_flow_state_v2';
  const PENDING_KEY    = 'gxo_pur_pending_preset_v3';
  const MSG_MARK       = '__PUR_HELPER__';

  const LEGACY_FLOW_KEY      = 'gxo_pur_flow_step';
  const LEGACY_AUTO_MAIL_KEY = 'gxo_pur_auto_mail';
  const LEGACY_AUTO_SMS_KEY  = 'gxo_pur_auto_sms';

  const SMS_POP_STAGE_KEY = 'gxo_pur_sms_popup_stage';
  const SMS_POP_TS_KEY    = 'gxo_pur_sms_popup_ts';
  const SMS_POP_TRIES_KEY = 'gxo_pur_sms_popup_tries';

  const INV_POP_STAGE_KEY = 'gxo_pur_invoice_popup_stage';
  const INV_POP_TS_KEY    = 'gxo_pur_invoice_popup_ts';

  const SMS_NO06_WD_KEY = 'gxo_pur_sms_no06_watchdog_ts';

  const PENDING_TTL_MS              = 10 * 60 * 1000;
  const FLOW_STALE_MS               = 10 * 60 * 1000;
  const AFTERSMS_SOFT_STALE_MS      = 2 * 60 * 1000;
  const BEREKEN_STAGE_FRESH_MS      = 20 * 1000;

  const FIND_RETRY_MAX              = 25;
  const FIND_RETRY_MS               = 250;

  const BEREKEN_FIND_RETRY_MAX      = 25;
  const BEREKEN_FIND_RETRY_MS       = 250;

  const POPUP_BTN_RETRY_MAX         = 40;
  const POPUP_BTN_RETRY_MS          = 250;

  const AFTER_SWAP_RESTORE_CONFIRM_MS = 1800;

  const CLAIM_RETRY_MAX             = 30;
  const CLAIM_RETRY_MS              = 200;

  const SMS_TEMPLATE_MIN_RETRY_GAP_MS = 2500;
  const SMS_TEMPLATE_MAX_TRIES        = 2;
  const SMS_POLL_ROUNDS               = 20;
  const SMS_POLL_INTERVAL_MS          = 200;

  const INV_CLOSE_TTL_MS            = 30 * 1000;
  const INV_CLOSE_TRIES             = 30;
  const INV_CLOSE_INTERVAL_MS       = 250;

  const NO06_WATCHDOG_TOTAL_MS      = 15000;
  const NO06_WATCHDOG_INTERVAL_MS   = 500;

  const NO06_PHRASE = 'mobiel nummer is niet valide';

  // =========================
  // LOG
  // =========================
  function log(...args) { if (DEBUG) console.log('[PUR-helper]', ...args); }

  function sGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
  function sSet(key, val) { try { sessionStorage.setItem(key, val); return true; } catch { return false; } }
  function sRemove(key) { try { sessionStorage.removeItem(key); } catch {} }

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  function triggerChange(el) {
    if (!el) return;
    try {
      if (typeof el.onchange === 'function') el.onchange();
      else el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }
  }

  function triggerBlur(el) {
    if (!el) return;
    try {
      if (typeof el.onblur === 'function') el.onblur();
      else el.dispatchEvent(new Event('blur', { bubbles: true }));
    } catch {
      try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
    }
  }

  function setValueRich(el, val, label) {
    if (!el) return false;
    const before = el.value;
    el.value = val;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    triggerChange(el);
    triggerBlur(el);
    const after = el.value;
    if (label) log(`Set ${label}: "${before}" -> "${after}" (target="${val}")`);
    return true;
  }

  function isRepairPage() { return location.pathname.includes('edit.ashx') && location.search.includes('name=reparatie'); }
  function isClaimPage()  { return location.pathname.includes('edit.ashx') && location.search.includes('name=claim'); }
  function isInvoicePopup() { return /factuur\.aspx/i.test(location.pathname); }
  function isSmsPopup()     { return /sms\.aspx/i.test(location.pathname); }

  function getOrderIdFromUrl() {
    try {
      const url = new URL(window.location.href);
      const id = url.searchParams.get('item_id');
      return (id && /^\d+$/.test(id)) ? id : null;
    } catch { return null; }
  }

  function getOrderNumberFromLegend() {
    const legends = document.querySelectorAll('legend.cec-legend-strong');
    for (const lg of legends) {
      const text = (lg.textContent || '').trim();
      const firstToken = text.split(/\s+/)[0];
      if (/^\d+$/.test(firstToken)) return firstToken;
    }
    return null;
  }

  function getOrderNumber() {
    const nr = getOrderNumberFromLegend() || getOrderIdFromUrl();
    if (!nr) log('Could not find order number, using XXX');
    else log('Order number:', nr);
    return nr;
  }

  function getAllDocsCrossFrames() {
    const docs = [];
    const add = (d) => { if (d && !docs.includes(d)) docs.push(d); };

    add(document);

    try { if (window.top && window.top.document) add(window.top.document); } catch {}
    try {
      const topWin = window.top;
      if (topWin && topWin.frames && topWin.frames.length) {
        for (let i = 0; i < topWin.frames.length; i++) {
          try { add(topWin.frames[i].document); } catch {}
        }
      }
    } catch {}
    return docs;
  }

  function findByIdCrossFrames(id) {
    for (const d of getAllDocsCrossFrames()) {
      try {
        const el = d.getElementById(id);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function hasClaimTabCrossFrames() {
    for (const d of getAllDocsCrossFrames()) {
      try {
        const tabs = Array.from(d.querySelectorAll('#rw_tabs div.tab'));
        if (tabs.some(t => (t.textContent || '').trim() === 'Claim')) return true;
      } catch {}
    }
    return false;
  }

  function clickTabByText(tabText) {
    for (const d of getAllDocsCrossFrames()) {
      try {
        const tabs = Array.from(d.querySelectorAll('#rw_tabs div.tab'));
        const tab = tabs.find(t => (t.textContent || '').trim() === tabText);
        if (tab && tab.parentElement) {
          log('Click tab:', tabText);
          tab.parentElement.click();
          return true;
        }
      } catch {}
    }
    log('Tab not found:', tabText);
    return false;
  }

  function readFlowStateRaw() {
    const raw = sGet(FLOW_STATE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function writeFlowState(st) {
    sSet(FLOW_STATE_KEY, JSON.stringify(st || {}));
  }

  function ensureFlowState() {
    let st = readFlowStateRaw();
    if (!st || typeof st !== 'object') {
      st = { orderId: null, step: 'idle', autoMail: '0', autoSms: '0', ts: Date.now() };
    }
    if (!st.step) st.step = 'idle';
    if (st.autoMail !== '1') st.autoMail = '0';
    if (st.autoSms !== '1') st.autoSms = '0';
    if (!st.ts) st.ts = Date.now();
    return st;
  }

  function getFlowStep() { return ensureFlowState().step || 'idle'; }
  function setFlowStep(step) {
    const st = ensureFlowState();
    st.step = step;
    st.orderId = getOrderIdFromUrl() || st.orderId || null;
    st.ts = Date.now();
    writeFlowState(st);
    log('Flow step ->', step);
  }

  function setAutoMailFlag(on) {
    const st = ensureFlowState();
    st.autoMail = on ? '1' : '0';
    st.orderId = getOrderIdFromUrl() || st.orderId || null;
    st.ts = Date.now();
    writeFlowState(st);
    log('Auto-mail flag ->', on);
  }

  function setAutoSmsFlag(on) {
    const st = ensureFlowState();
    st.autoSms = on ? '1' : '0';
    st.orderId = getOrderIdFromUrl() || st.orderId || null;
    st.ts = Date.now();
    writeFlowState(st);
    log('Auto-sms flag ->', on);
  }

  function resetAllState() {
    sRemove(FLOW_STATE_KEY);
    sRemove(PENDING_KEY);
    sRemove(SMS_NO06_WD_KEY);

    sRemove(LEGACY_FLOW_KEY);
    sRemove(LEGACY_AUTO_MAIL_KEY);
    sRemove(LEGACY_AUTO_SMS_KEY);

    log('State reset (flow+pending+flags cleared).');
  }

  function migrateLegacyFlowIfPresent() {
    const alreadyNew = !!sGet(FLOW_STATE_KEY);
    if (alreadyNew) {
      sRemove(LEGACY_FLOW_KEY); sRemove(LEGACY_AUTO_MAIL_KEY); sRemove(LEGACY_AUTO_SMS_KEY);
      return;
    }

    const legacyStep = sGet(LEGACY_FLOW_KEY);
    const legacyMail = sGet(LEGACY_AUTO_MAIL_KEY);
    const legacySms  = sGet(LEGACY_AUTO_SMS_KEY);

    if (legacyStep || legacyMail || legacySms) {
      const st = ensureFlowState();
      st.orderId = getOrderIdFromUrl() || st.orderId || null;
      st.step = legacyStep || st.step || 'idle';
      st.autoMail = (legacyMail === '1') ? '1' : '0';
      st.autoSms  = (legacySms === '1') ? '1' : '0';
      st.ts = Date.now();
      writeFlowState(st);

      log('Migrated legacy flow -> new FLOW_STATE:', st);

      sRemove(LEGACY_FLOW_KEY); sRemove(LEGACY_AUTO_MAIL_KEY); sRemove(LEGACY_AUTO_SMS_KEY);
    }
  }

  function sanitizeFlowForCurrentOrder() {
    const st = readFlowStateRaw();
    if (!st) return;

    const currentOrderId = getOrderIdFromUrl();
    if (st.orderId && currentOrderId && st.orderId !== currentOrderId) {
      log('Flow belongs to another order -> auto-reset. stored=', st.orderId, 'current=', currentOrderId);
      resetAllState();
      return;
    }

    const age = Date.now() - (Number(st.ts) || 0);

    if (age > FLOW_STALE_MS) {
      log('Flow stale (>10min) -> auto-reset. step=', st.step, 'ageMs=', age);
      resetAllState();
      return;
    }

    if (st.step === 'afterSms' && st.autoSms !== '1') {
      log('Flow at afterSms but autoSms=0 -> promote to afterSmsDone');
      setFlowStep('afterSmsDone');
      return;
    }

    if (st.step === 'afterInvoice' && st.autoMail !== '1') {
      log('Flow at afterInvoice but autoMail=0 -> promote to afterInvoiceDone');
      setFlowStep('afterInvoiceDone');
      return;
    }

    if (st.step === 'afterSms' && age > AFTERSMS_SOFT_STALE_MS) {
      log('Flow stuck at afterSms (>2min) -> reset to idle');
      setAutoSmsFlag(false);
      setFlowStep('idle');
    }
  }

  function setPending(obj) { sSet(PENDING_KEY, JSON.stringify(obj)); }
  function getPending() {
    const raw = sGet(PENDING_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  function clearPending() { sRemove(PENDING_KEY); }

  function detectBrandFromLegends() {
    const legends = Array.from(document.querySelectorAll('legend'));
    for (const lg of legends) {
      const t = (lg.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t) continue;

      if (t.startsWith('toestel ')) {
        const after = t.replace(/^toestel\s+/, '');
        const first = after.split(' ')[0];
        if (first && /^[a-z0-9]+$/.test(first)) return first;
      }

      const m = t.match(/toestel\s+([a-z0-9]+)/);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function ensureWorkdescriptionClearedOrConfirmed() {
    const wd = findByIdCrossFrames('workdescription');
    if (!wd) { log('Workdescription not found'); return true; }

    if (!wd.value || wd.value.trim() === '') {
      log('Workdescription empty, no confirm needed');
      return true;
    }

    const proceed = window.confirm('Workdescription bevat al tekst. Wil je deze vervangen door de PUR-tekst?');
    if (!proceed) { log('User cancelled overwrite'); return false; }

    log('User confirmed overwrite of Workdescription');
    setValueRich(wd, '', 'workdescription(clear)');
    return true;
  }

  function withAutoConfirm(fn) {
    const orig = window.confirm;
    try {
      window.confirm = () => true;
      fn();
    } catch (e) {
      log('withAutoConfirm error:', e);
    } finally {
      setTimeout(() => {
        try { window.confirm = orig; } catch {}
      }, AFTER_SWAP_RESTORE_CONFIRM_MS);
    }
  }

  function ensureGeenGarantieAndMaybeSwap() {
    const sel = findByIdCrossFrames('debitaccount');
    if (!sel) { log('debitaccount select not found'); return { ok: false, swapped: false }; }

    log('Current Garantie value:', sel.value || '(empty)');
    if (sel.value !== 'G') {
      log('Garantie is not G, no swap needed');
      return { ok: true, swapped: false };
    }

    sel.value = 'GG';
    log('Garantie changed: G -> GG');
    triggerChange(sel);

    const btn = findByIdCrossFrames('btn_swapdebitaccount');
    if (!btn) { log('btn_swapdebitaccount not found'); return { ok: false, swapped: false }; }

    log('Click btn_swapdebitaccount (Ok) with auto-confirm');
    withAutoConfirm(() => btn.click());

    return { ok: true, swapped: true };
  }

  function buildPur42Text(orderNr) {
    const nr = orderNr || 'XXX';
    return (
      'Het opgetreden defect valt niet onder de garantie-/coulancevoorwaarden. </br>' +
      'Wij kunnen op afstand een beoordeling maken of uw toestel nog te herstellen is. ' +
      'Hiervoor vragen wij u eerst € 42,50 behandelingskosten over te maken naar onze bankrekening ' +
      'NL87ABNA0608265721 o.v.v. order nr. ' + nr + ' (Max 5 d.)</br><br/>' +
      'Na ontvangst van uw betaling sturen wij u binnen 2 werkdagen een email met een prijsopgave.<br/>' +
      'Als u met een prijsopgave (max 10 d.) akkoord gaat, wordt de betaalde behandelkosten à € 42,50 in mindering gebracht. ' +
      'Bij niet akkoord of geen reactie, dan blijft de betaalde € 42,50 bij GXO.'
    );
  }

  function buildPur63Text(orderNr) {
    const nr = orderNr || 'XXX';
    return (
      'Uw toestel valt buiten de gestelde fabrieksgarantie.<br /></br>' +
      'Wij vragen u het bedrag  € 63,80 (incl. btw, transport- en behandelingskosten) over te maken op onze bankrekening ' +
      'NL87 ABNA 0608265721 o.v.v. order nr. ' + nr + ' (max 5 d.) </br></br>' +
      'Heeft u betaald? Dan ontvangt u een email binnen 2 werkdagen voor een ophaal- of verzend verzoek, ' +
      'na inspectie ontvangt u een prijsopgave (max 10 d.) Bij prijsopgave akkoord wordt dit bedrag in mindering gebracht. ' +
      'Gaat u niet akkoord dan blijven deze kosten bij GXO.'
    );
  }

  function setWorkdescriptionPur(type) {
    const wd = findByIdCrossFrames('workdescription');
    if (!wd) { log('Workdescription not found'); return false; }

    const orderNr = getOrderNumber();
    const text = (type === 42) ? buildPur42Text(orderNr) : buildPur63Text(orderNr);

    log('Write PUR text to Workdescription. type=', type, 'order=', orderNr);
    return setValueRich(wd, text, 'workdescription');
  }

  function applyFinancialPreset(type, attempt, onDone) {
    const freight = findByIdCrossFrames('freightcost');
    const basic   = findByIdCrossFrames('finalbasiccharge');

    if (!basic) {
      if (attempt < FIND_RETRY_MAX) return setTimeout(() => applyFinancialPreset(type, attempt + 1, onDone), FIND_RETRY_MS);
      log('finalbasiccharge not found (timeout)');
      if (typeof onDone === 'function') onDone(false);
      return;
    }

    const targetBasic   = '35,12';
    const targetFreight = (type === 42) ? '0,00' : '17,61';

    if (freight) setValueRich(freight, targetFreight, 'freightcost');
    else log('freightcost not found (continue)');

    setValueRich(basic, targetBasic, 'finalbasiccharge');

    if (typeof onDone === 'function') onDone(true);
  }

  function findBerekenButtonInDoc(doc) {
    const els = Array.from(doc.querySelectorAll('input[type="button"], input.button, button, button.button'));
    return els.find(el => {
      const t = norm(el.textContent);
      const v = norm(el.value);
      const id = norm(el.id);
      return t.includes('bereken') || v.includes('bereken') || id.includes('bereken') ||
             t.includes('calculate') || v.includes('calculate') || id.includes('calculate');
    }) || null;
  }

  function findBerekenButtonCrossFrames() {
    for (const d of getAllDocsCrossFrames()) {
      try {
        const btn = findBerekenButtonInDoc(d);
        if (btn) return btn;
      } catch {}
    }
    return null;
  }

  function clickBerekenWithRetry(attempt, onDone) {
    const btn = findBerekenButtonCrossFrames();
    if (!btn) {
      if (attempt < BEREKEN_FIND_RETRY_MAX) return setTimeout(() => clickBerekenWithRetry(attempt + 1, onDone), BEREKEN_FIND_RETRY_MS);
      log('Bereken button not found (timeout). Continue without it.');
      if (typeof onDone === 'function') onDone(false);
      return;
    }
    log('Click Bereken (Financials)');
    try { btn.click(); } catch (e) { log('Bereken click failed:', e); }
    if (typeof onDone === 'function') onDone(true);
  }

  function finishFillOnly() {
    setAutoMailFlag(false);
    setAutoSmsFlag(false);
    setFlowStep('idle');
    clearPending();
    log('Fill-only finished (no Claim/Mail/SMS/Status).');
  }

  function beginAutoFlowAndClearPending() {
    setAutoMailFlag(true);
    setAutoSmsFlag(true);
    setFlowStep('goClaim');
    clearPending();
    log('Go to Claim tab (pending cleared)');
    clickTabByText('Claim');
  }

  function applyThenBerekenThenNext(type, mode, runId) {
    applyFinancialPreset(type, 0, () => {
      setWorkdescriptionPur(type);

      const p = getPending();
      if (p && p.runId === runId) {
        p.stage = 'berekenClicked';
        p.ts = Date.now();
        setPending(p);
        log('Pending stage -> berekenClicked (saved before Bereken)');
      }

      clickBerekenWithRetry(0, () => {
        setTimeout(() => {
          if (mode === 'auto') beginAutoFlowAndClearPending();
          else finishFillOnly();
        }, 900);
      });
    });
  }

  function startPreset(type, mode) {
    const orderId = getOrderIdFromUrl() || getOrderNumber() || 'unknown';
    const runId = String(Date.now()) + '_' + Math.random().toString(16).slice(2);

    setFlowStep('idle');
    setAutoMailFlag(false);
    setAutoSmsFlag(false);

    setPending({ type, mode, orderId, stage: 'start', ts: Date.now(), runId });

    const res = ensureGeenGarantieAndMaybeSwap();
    if (res.swapped) {
      const p = getPending();
      if (p && p.runId === runId) { p.stage = 'swapped'; p.ts = Date.now(); setPending(p); }
      return;
    }

    applyThenBerekenThenNext(type, mode, runId);
  }

  function resumePendingIfNeeded() {
    const p = getPending();
    if (!p) return;

    const now = Date.now();
    if (!p.ts || (now - p.ts) > PENDING_TTL_MS) { clearPending(); return; }

    const currentOrderId = getOrderIdFromUrl();
    if (p.orderId && currentOrderId && p.orderId !== currentOrderId) { clearPending(); return; }

    if (p.stage === 'berekenClicked') {
      const age = now - (p.ts || now);
      if (age <= BEREKEN_STAGE_FRESH_MS) {
        if (p.mode === 'auto') beginAutoFlowAndClearPending();
        else finishFillOnly();
      } else {
        clearPending();
      }
      return;
    }

    if (p.stage === 'swapped' || p.stage === 'start') {
      const sel = findByIdCrossFrames('debitaccount');
      if (sel && sel.value === 'G') {
        const res = ensureGeenGarantieAndMaybeSwap();
        if (res.swapped) { p.stage = 'swapped'; p.ts = Date.now(); setPending(p); return; }
      }
      applyThenBerekenThenNext(p.type, p.mode, p.runId);
      return;
    }

    clearPending();
  }

  function runClaimStepIfAny(attempt = 0) {
    const step = getFlowStep();
    if (step !== 'goClaim') return;

    const cancelSel = findByIdCrossFrames('cancelreason');
    const saveBtn   = findByIdCrossFrames('opslaan');

    if (!cancelSel || !saveBtn) {
      if (attempt < CLAIM_RETRY_MAX) return setTimeout(() => runClaimStepIfAny(attempt + 1), CLAIM_RETRY_MS);
      return;
    }

    if (cancelSel.value !== 'VOID1') setValueRich(cancelSel, 'VOID1', 'cancelreason');

    setTimeout(() => {
      setFlowStep('afterClaim');
      try { saveBtn.click(); } catch {}
    }, 250);
  }

  function detectNo06ModalDom() {
    return Array.from(document.querySelectorAll('div,span,td,p,strong,b,li'))
      .find(el => norm(el.innerText || el.textContent).includes(NO06_PHRASE)) || null;
  }

  function clickNo06OkButton() {
    const msgEl = detectNo06ModalDom();
    if (!msgEl) return false;

    let container = msgEl;
    for (let depth = 0; depth < 6 && container; depth++) {
      const btns = Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      const okBtn = btns.find(b => norm(b.textContent || b.value) === 'ok');
      if (okBtn) { try { okBtn.click(); } catch {} return true; }
      container = container.parentElement;
    }

    const anyOk = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
      .find(b => norm(b.textContent || b.value) === 'ok');
    if (anyOk) { try { anyOk.click(); } catch {} return true; }

    return false;
  }

  function addBlogComment(text) {
    const ta = document.getElementById('comment');
    if (!ta) return false;

    try { ta.focus(); } catch {}
    ta.value = text;
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch {}

    if (typeof window.addcomment === 'function') {
      try { window.addcomment(); return true; } catch {}
    }

    const tr = ta.closest('tr');
    if (tr) {
      const btn = tr.querySelector('button.button, button, input[type="button"], input.button');
      if (btn) { try { btn.click(); return true; } catch {} }
    }
    return false;
  }

  function handleNo06AndContinue() {
    clickNo06OkButton();
    addBlogComment('Geen 06');
    setAutoSmsFlag(false);
    setFlowStep('afterSmsDone');
    setTimeout(() => handleRepairFlowOnRepairPage(), 350);
  }

  function startNo06WatchdogOnce() {
    if (getFlowStep() !== 'afterSms') return;

    const lastTs = Number(sGet(SMS_NO06_WD_KEY) || '0');
    const now = Date.now();
    if (lastTs && (now - lastTs) < 5000) return;

    sSet(SMS_NO06_WD_KEY, String(now));

    const startedAt = now;
    const tick = () => {
      if (getFlowStep() !== 'afterSms') return;

      if (detectNo06ModalDom()) { handleNo06AndContinue(); return; }

      if ((Date.now() - startedAt) >= NO06_WATCHDOG_TOTAL_MS) return;
      setTimeout(tick, NO06_WATCHDOG_INTERVAL_MS);
    };

    setTimeout(tick, 400);
  }

  function clickContantbon() {
    const btn = Array.from(document.querySelectorAll('input.button')).find(b => norm(b.value).includes('contantbon'));
    if (!btn) return false;
    btn.click();
    return true;
  }

  function clickSmsEigenaar() {
    const smsBtn = findByIdCrossFrames('btn_sms') ||
      Array.from(document.querySelectorAll('input.button')).find(b => norm(b.value).includes('sms eigenaar'));
    if (!smsBtn) return false;

    let capturedNo06 = false;
    const origAlert = window.alert;
    try {
      window.alert = (msg) => {
        const s = String(msg || '');
        if (norm(s).includes(NO06_PHRASE)) { capturedNo06 = true; return; }
        try { origAlert(s); } catch {}
      };
      smsBtn.click();
    } finally {
      try { window.alert = origAlert; } catch {}
    }

    if (capturedNo06) return 'no06';
    return true;
  }

  function setWaitForCustomerStatus() {
    const wachtBtn = document.querySelector('button.button[onclick*="waitforcustomer"]');
    if (!wachtBtn) return false;

    wachtBtn.click();

    setTimeout(() => {
      const assist = findByIdCrossFrames('assistoption');
      if (assist) { assist.value = '74'; triggerChange(assist); }
    }, 800);

    return true;
  }

  function handleRepairFlowOnRepairPage() {
    const step = getFlowStep();

    switch (step) {
      case 'afterClaim':
        if (clickContantbon()) setFlowStep('afterInvoice');
        break;

      case 'afterInvoiceDone': {
        const res = clickSmsEigenaar();
        if (res === true) { setFlowStep('afterSms'); startNo06WatchdogOnce(); }
        else if (res === 'no06') handleNo06AndContinue();
        break;
      }

      case 'afterSms':
        startNo06WatchdogOnce();
        break;

      case 'afterSmsDone':
        if (setWaitForCustomerStatus()) setFlowStep('done');
        break;

      default:
        break;
    }
  }

  function installOpenerContinueHooks() {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.origin !== location.origin) return;
        const data = ev.data || {};
        if (!data[MSG_MARK]) return;
        if (data.action !== 'continueFlow') return;
        setTimeout(() => handleRepairFlowOnRepairPage(), 250);
      } catch {}
    });

    window.addEventListener('focus', () => {
      const step = getFlowStep();
      if (step === 'afterInvoiceDone' || step === 'afterSmsDone' || step === 'afterSms') {
        setTimeout(() => handleRepairFlowOnRepairPage(), 200);
      }
    });
  }

  function pingOpenerContinue(reason) {
    try {
      if (!window.opener) return;
      window.opener.postMessage({ [MSG_MARK]: 1, action: 'continueFlow', reason: reason || '' }, location.origin);
    } catch {}
  }

  function openerGetFlowState() {
    try {
      if (!window.opener) return null;
      const raw = window.opener.sessionStorage.getItem(FLOW_STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function openerSetFlowState(st) {
    try {
      if (!window.opener) return false;
      window.opener.sessionStorage.setItem(FLOW_STATE_KEY, JSON.stringify(st || {}));
      return true;
    } catch { return false; }
  }

  function openerPatchFlow(patch) {
    const st = openerGetFlowState() || { orderId: null, step: 'idle', autoMail: '0', autoSms: '0', ts: Date.now() };
    Object.assign(st, patch || {});
    st.ts = Date.now();
    openerSetFlowState(st);
  }

  function findMailDirectButton() {
    const candidates = Array.from(document.querySelectorAll('button.button, button, input[type="button"], input.button'));
    return candidates.find(b => norm(b.textContent || b.value).includes('mail direct')) || null;
  }

  function tryCloseWindow() { try { window.close(); return true; } catch { return false; } }

  function invGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function invSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } }
  function invStage() { return invGet(INV_POP_STAGE_KEY) || 'init'; }
  function invTs() { return Number(invGet(INV_POP_TS_KEY) || '0'); }
  function invMark(stage) { invSet(INV_POP_STAGE_KEY, stage); invSet(INV_POP_TS_KEY, String(Date.now())); }

  function closeInvoicePopupLoop(tryNo = 0) {
    tryCloseWindow();
    if (tryNo >= INV_CLOSE_TRIES) return;
    setTimeout(() => closeInvoicePopupLoop(tryNo + 1), INV_CLOSE_INTERVAL_MS);
  }

  function initInvoicePopup(attempt = 0) {
    const stg = invStage();
    const age = Date.now() - invTs();

    if (stg === 'clickedMail' && age >= 0 && age <= INV_CLOSE_TTL_MS) {
      pingOpenerContinue('afterInvoiceDone');
      closeInvoicePopupLoop(0);
      return;
    }

    if (!window.opener) return;

    const openerFlow = openerGetFlowState();
    const autoMail = openerFlow && openerFlow.autoMail;
    const flowStep = openerFlow && openerFlow.step;

    if (autoMail !== '1' || flowStep !== 'afterInvoice') return;

    const btn = findMailDirectButton();
    if (!btn) {
      if (attempt < POPUP_BTN_RETRY_MAX) return setTimeout(() => initInvoicePopup(attempt + 1), POPUP_BTN_RETRY_MS);
      return;
    }

    invMark('clickedMail');
    try { btn.click(); } catch {}

    openerPatchFlow({ autoMail: '0', step: 'afterInvoiceDone' });

    setTimeout(() => {
      pingOpenerContinue('afterInvoiceDone');
      closeInvoicePopupLoop(0);
    }, 350);
  }

  function popGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function popSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } }
  function popStage() { return popGet(SMS_POP_STAGE_KEY) || 'init'; }
  function popTs() { return Number(popGet(SMS_POP_TS_KEY) || '0'); }
  function popTries() { return Number(popGet(SMS_POP_TRIES_KEY) || '0'); }
  function popMark(stage) { popSet(SMS_POP_STAGE_KEY, stage); popSet(SMS_POP_TS_KEY, String(Date.now())); }
  function popIncTry() { const t = popTries() + 1; popSet(SMS_POP_TRIES_KEY, String(t)); return t; }

  function initSmsPopup() {
    if (!window.opener) return;

    const openerFlow = openerGetFlowState();
    const autoSms = openerFlow && openerFlow.autoSms;
    const flowStep = openerFlow && openerFlow.step;

    if (autoSms !== '1' || flowStep !== 'afterSms') return;

    const txtArea = document.getElementById('tekst');
    const sel = document.getElementById('lst_tekst');
    if (!txtArea || !sel) return;

    function finalizeSend() {
      openerPatchFlow({ autoSms: '0', step: 'afterSmsDone' });
      popMark('sending');

      const sendBtn = document.getElementById('btnsend');
      if (sendBtn) { try { sendBtn.click(); } catch {} }

      setTimeout(() => {
        popMark('done');
        pingOpenerContinue('afterSmsDone');
        tryCloseWindow();
      }, 850);
    }

    function pollForTextAndSend(round = 0) {
      const val = (txtArea.value || '').trim();
      if (val) { finalizeSend(); return; }
      if (round >= SMS_POLL_ROUNDS) { popMark('waitingManual'); return; }
      setTimeout(() => pollForTextAndSend(round + 1), SMS_POLL_INTERVAL_MS);
    }

    if ((txtArea.value || '').trim()) { finalizeSend(); return; }

    const stage = popStage();
    const tries = popTries();
    const last = popTs();
    const age = Date.now() - last;

    if (stage === 'templateRequested' && age < SMS_TEMPLATE_MIN_RETRY_GAP_MS) {
      pollForTextAndSend(0);
      return;
    }

    if (tries >= SMS_TEMPLATE_MAX_TRIES) {
      popMark('waitingManual');
      return;
    }

    const opt = Array.from(sel.options).find(o => norm(o.text).includes('melding reactie op email'));
    if (!opt) { popMark('waitingManual'); return; }

    if (sel.value !== opt.value) {
      sel.value = opt.value;
      popIncTry();
      popMark('templateRequested');
      triggerChange(sel);
    } else {
      popMark('templateRequested');
    }

    setTimeout(() => pollForTextAndSend(0), 650);
  }

  function installResetHotkey() {
    const handler = (e) => {
      const key = (e.key || '').toLowerCase();
      if (e.ctrlKey && e.altKey && key === 'r') {
        e.preventDefault();
        resetAllState();
        try { alert('PUR-helper status gereset.'); } catch {}
      }
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);

    try {
      if (window.top && window.top !== window) {
        window.top.addEventListener('keydown', handler, true);
        window.top.document.addEventListener('keydown', handler, true);
      }
    } catch {}
  }

  function initRepairPurButtons() {
    const legend = Array.from(document.querySelectorAll('fieldset > legend'))
      .find(l => (l.textContent || '').trim() === 'Financials');
    if (!legend) return;

    const fieldset = legend.parentElement;
    if (!fieldset) return;

    if (fieldset.querySelector('.pur-helper-container')) return;

    const brand = detectBrandFromLegends();
    const isSamsung = (brand === 'samsung');
    const claimTabOk = hasClaimTabCrossFrames();

    const container = document.createElement('div');
    container.className = 'pur-helper-container';
    container.style.marginTop = '6px';
    container.style.display = 'flex';
    container.style.justifyContent = 'flex-end';
    container.style.gap = '4px';
    container.style.flexWrap = 'wrap';

    function styleBtn(btn) {
      btn.type = 'button';
      btn.className = 'button';
      btn.style.whiteSpace = 'nowrap';
      btn.style.fontSize = '9px';
      btn.style.padding = '2px 6px';
      btn.style.minHeight = '18px';
    }

    const btnReset = document.createElement('button');
    btnReset.textContent = '↺';
    styleBtn(btnReset);
    btnReset.style.width = '26px';
    btnReset.title = 'Reset helper state (zelfde als Ctrl+Alt+R)';
    btnReset.addEventListener('click', () => {
      resetAllState();
      alert('PUR-helper status gereset.');
      location.reload();
    });

    const btnFill42 = document.createElement('button');
    btnFill42.textContent = 'Fill 42,50';
    styleBtn(btnFill42);
    btnFill42.title = 'Vult alleen Financials (0,00 + 35,12), Workdescription, Garantie->GG, Bereken. Geen Claim/Mail/SMS/Status.';
    btnFill42.addEventListener('click', () => {
      if (!ensureWorkdescriptionClearedOrConfirmed()) return;
      startPreset(42, 'fill');
    });

    const btnFill63 = document.createElement('button');
    btnFill63.textContent = 'Fill 63,80';
    styleBtn(btnFill63);
    btnFill63.title = 'Vult alleen Financials (17,61 + 35,12), Workdescription, Garantie->GG, Bereken. Geen Claim/Mail/SMS/Status.';
    btnFill63.addEventListener('click', () => {
      if (!ensureWorkdescriptionClearedOrConfirmed()) return;
      startPreset(63, 'fill');
    });

    if (isSamsung && claimTabOk) {
      const btnAuto42 = document.createElement('button');
      btnAuto42.textContent = 'AUTO 42,50';
      styleBtn(btnAuto42);
      btnAuto42.title =
        'Volledige flow (Samsung): Financials+Workdescription, Garantie->GG, Bereken, Claim=VOID1+Opslaan, Mail direct, SMS (bij Geen 06: blog "Geen 06"), status Wacht op betaling onderzoekskosten PO.';
      btnAuto42.addEventListener('click', () => {
        if (!ensureWorkdescriptionClearedOrConfirmed()) return;
        startPreset(42, 'auto');
      });

      container.appendChild(btnAuto42);
      container.appendChild(btnFill42);
      container.appendChild(btnFill63);
      container.appendChild(btnReset);
    } else {
      container.appendChild(btnFill42);
      container.appendChild(btnFill63);
      container.appendChild(btnReset);
    }

    fieldset.appendChild(container);
  }

  function handleRepairEntry() {
    migrateLegacyFlowIfPresent();
    installResetHotkey();
    installOpenerContinueHooks();
    sanitizeFlowForCurrentOrder();

    setTimeout(() => {
      initRepairPurButtons();
      resumePendingIfNeeded();
      handleRepairFlowOnRepairPage();
    }, 500);
  }

  window.addEventListener('load', () => {
    if (isInvoicePopup()) { setTimeout(() => initInvoicePopup(0), 250); return; }
    if (isSmsPopup())     { setTimeout(initSmsPopup, 250); return; }
    if (isClaimPage())    { setTimeout(() => runClaimStepIfAny(0), 300); return; }

    if (isRepairPage()) {
      handleRepairEntry();
      return;
    }
  });
})();
