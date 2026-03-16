// ==UserScript==
// @name         Groupwise Send Email + SMS (Mini)
// @namespace    https://groupwise.cerepair.nl/
// @version      0.2.3
// @description  Mini script for Credit flow points 12/13: SEND_EMAIL (Credit Akkoord) and SEND_SMS (Melding reactie op Email)
// @author       Alex + OpenClaw Copilot
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-send-email-sms-mini.user.js
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-send-email-sms-mini.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    debug: true,
    timeoutMs: 15000,
    pollMs: 220,
    hostSelector: '#btn_mail_klant, #btn_sms, #btn_iriscodes, #comments',
    emailTemplateNeedle: 'credit akkoord',
    smsTemplateNeedle: 'melding reactie op email',
    requestTtlMs: 30000,
    smsWaitMs: 10000
  };

  const REQ_KEY = 'gw_email_sms_mini_request_v1';
  const RES_KEY = 'gw_email_sms_mini_result_v1';
  const NO06_PHRASE = 'mobiel nummer is niet valide';

  const log = (...a) => CFG.debug && console.log('[GW-EMAIL-SMS-MINI]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const popupRefs = [];

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

  function q(sel) {
    for (const d of allDocs()) {
      const el = d.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function qAll(sel) {
    const out = [];
    for (const d of allDocs()) out.push(...d.querySelectorAll(sel));
    return out;
  }

  async function waitFor(fn, timeout = CFG.timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(CFG.pollMs);
    }
    return null;
  }

  function installPopupTracker() {
    const w = window;
    if (w.__gwMiniPopupTrackerInstalled) return;
    w.__gwMiniPopupTrackerInstalled = true;

    const origOpen = w.open;
    w.open = function (...args) {
      const child = origOpen.apply(this, args);
      try {
        if (child) {
          popupRefs.push({ win: child, ts: Date.now(), url: String(args?.[0] || '') });
          log('popup tracked', args?.[0] || '(no-url)');
        }
      } catch {}
      return child;
    };
  }

  async function waitForPopupWindow(timeoutMs = CFG.timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (let i = popupRefs.length - 1; i >= 0; i--) {
        const ref = popupRefs[i];
        try {
          const w = ref?.win;
          if (!w || w.closed) continue;
          const d = w.document;
          if (d && d.readyState !== 'loading') return w;
        } catch {}
      }
      await sleep(160);
    }
    return null;
  }

  async function waitForDocWithSelector(selector, timeoutMs = CFG.timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const d of allDocs()) {
        try {
          if (d.querySelector(selector)) return d;
        } catch {}
      }
      await sleep(160);
    }
    return null;
  }

  async function resolveContextBySelector(selector) {
    const popup = await waitForPopupWindow(2200);
    if (popup) {
      try { return { kind: 'popup', win: popup, doc: popup.document }; } catch {}
    }
    const d = await waitForDocWithSelector(selector, CFG.timeoutMs);
    if (d) return { kind: 'inline', doc: d };
    return null;
  }

  function closeInlineDialog(doc) {
    if (!doc) return;
    const candidates = [
      '#btnclose',
      '#btn_sluiten',
      '.ui-dialog-titlebar-close',
      '.x-tool-close'
    ];
    for (const s of candidates) {
      const el = doc.querySelector(s);
      if (el) { try { el.click(); return; } catch {} }
    }
    const closeTxt = findButtonByTextInDoc(doc, 'sluiten') || findButtonByTextInDoc(doc, 'close');
    if (closeTxt) { try { closeTxt.click(); } catch {} }
  }

  function findButtonByTextInDoc(d, txt) {
    const target = String(txt || '').trim().toLowerCase();
    const btns = [...d.querySelectorAll('button,input[type="button"],input[type="submit"],a')];
    return btns.find((b) => String((b.textContent || b.value || '')).trim().toLowerCase() === target) || null;
  }

  function selectByNeedle(selectEl, needle) {
    if (!selectEl) return false;
    const n = String(needle || '').trim().toLowerCase();
    const opt = [...selectEl.options].find((o) => String(o.textContent || '').toLowerCase().includes(n));
    if (!opt) return false;
    selectEl.value = opt.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function lsGet(k) {
    try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

  function smsSentKey(reqId) { return 'gw_sms_sent_' + String(reqId || ''); }
  function isSmsSent(reqId) { try { return localStorage.getItem(smsSentKey(reqId)) === '1'; } catch { return false; } }
  function markSmsSent(reqId) { try { localStorage.setItem(smsSentKey(reqId), '1'); } catch {} }

  function markRequest(type) {
    const req = { type, ts: Date.now(), id: String(Date.now()) + '_' + Math.random().toString(16).slice(2) };
    lsSet(REQ_KEY, req);
    lsDel(RES_KEY);
    if (type === 'sms') {
      try { localStorage.removeItem(smsSentKey(req.id)); } catch {}
    }
    log('REQ set', req);
    return req;
  }

  function getFreshRequest(expectedType) {
    const req = lsGet(REQ_KEY);
    if (!req || req.type !== expectedType) return null;
    if ((Date.now() - Number(req.ts || 0)) > CFG.requestTtlMs) return null;
    return req;
  }

  function completeRequest(reqId, ok, msg) {
    const res = { id: reqId, ok: !!ok, msg: msg || '', ts: Date.now() };
    lsSet(RES_KEY, res);
    lsDel(REQ_KEY);
    log('REQ complete', res);
  }

  async function waitForResult(reqId, timeoutMs = CFG.timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const res = lsGet(RES_KEY);
      if (res && res.id === reqId) return res;
      await sleep(180);
    }
    return null;
  }

  function isEmailComposeContext() {
    return !!q('#naam,select#naam,select[name="naam"]');
  }

  function isSmsComposeContext() {
    return !!q('#lst_tekst,select#lst_tekst,select[name="lst_tekst"]');
  }

  function detectNo06ModalDom() {
    for (const d of allDocs()) {
      const hit = Array.from(d.querySelectorAll('div,span,td,p,strong,b,li'))
        .find(el => String(el.innerText || el.textContent || '').toLowerCase().includes(NO06_PHRASE));
      if (hit) return hit;
    }
    return null;
  }

  function clickNo06OkButton() {
    const msgEl = detectNo06ModalDom();
    if (!msgEl) return false;

    let container = msgEl;
    for (let depth = 0; depth < 8 && container; depth++) {
      const btns = Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      const okBtn = btns.find(b => String((b.textContent || b.value || '')).trim().toLowerCase() === 'ok');
      if (okBtn) { try { okBtn.click(); } catch {} return true; }
      container = container.parentElement;
    }

    for (const d of allDocs()) {
      const anyOk = Array.from(d.querySelectorAll('button,input[type="button"],input[type="submit"]'))
        .find(b => String((b.textContent || b.value || '')).trim().toLowerCase() === 'ok');
      if (anyOk) { try { anyOk.click(); return true; } catch {} }
    }

    return false;
  }

  function addBlogCommentGeen06() {
    function applyInDoc(d) {
      if (!d) return false;
      const ta = d.getElementById('comment') || d.querySelector('#comment');
      if (!ta) return false;

      try { ta.focus(); } catch {}
      ta.value = 'Geen 06';
      try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch {}

      // WVB-style preferred path
      try {
        const w = d.defaultView || window;
        if (typeof w.addcomment === 'function') { w.addcomment(); return true; }
      } catch {}

      // Fallback add button
      const addBtn = d.querySelector('#btn_addcomment') || findButtonByTextInDoc(d, 'add');
      if (addBtn) {
        try { addBtn.click(); return true; } catch {}
      }
      return false;
    }

    // current page + all frames
    for (const d of allDocs()) {
      if (applyInDoc(d)) return true;
    }

    // if called from popup, try opener docs/frames
    try {
      if (window.opener && window.opener.document) {
        const od = window.opener.document;
        if (applyInDoc(od)) return true;
        const frames = od.querySelectorAll('frame,iframe');
        for (const f of frames) {
          try {
            const fd = f.contentDocument || f.contentWindow?.document;
            if (applyInDoc(fd)) return true;
          } catch {}
        }
      }
    } catch {}

    return false;
  }

  function getCurrentItemIdFromUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('item_id') || '';
    } catch {
      const m = String(location.href).match(/[?&]item_id=(\d+)/i);
      return m ? m[1] : '';
    }
  }

  function getOrderPartyLabel() {
    const currentItemId = getCurrentItemIdFromUrl();
    const links = qAll('a[href*="neworder3.aspx"]');

    // Prefer exact item_id match first
    if (currentItemId) {
      const exact = links.find(a => String(a.getAttribute('href') || '').includes('item_id=' + currentItemId));
      if (exact) return String(exact.textContent || '').trim();
    }

    // Fallback: first visible candidate
    const first = links.find(a => String(a.textContent || '').trim().length > 0);
    return first ? String(first.textContent || '').trim() : '';
  }

  function findEmailOwnerButton() {
    return q('#btn_mail_eigenaar') ||
      q('#btn_mail_owner') ||
      qAll('input.button,button').find(b => {
        const t = String(b.textContent || b.value || '').toLowerCase();
        return t.includes('bericht eig') || t.includes('bericht eigenaar') || t.includes('mail eig');
      }) || null;
  }

  function findEmailCustomerButton() {
    return q('#btn_mail_klant') ||
      qAll('input.button,button').find(b => {
        const t = String(b.textContent || b.value || '').toLowerCase();
        return t.includes('bericht klant') || t.includes('mail klant');
      }) || null;
  }

  function chooseEmailButtonByParty() {
    const party = String(getOrderPartyLabel() || '').toLowerCase();
    const isSamsungFlow = party.includes('samsung'); // includes "Samsung WS"

    const ownerBtn = findEmailOwnerButton();
    const customerBtn = findEmailCustomerButton();

    if (isSamsungFlow) {
      log('Email route by party:', party || '(empty)', '-> Bericht eig.');
      return ownerBtn || customerBtn || null;
    }

    if (party) {
      log('Email route by party:', party, '-> Bericht klant');
      return customerBtn || ownerBtn || null;
    }

    // unknown party fallback to previous behavior
    log('Email route by party: unknown -> fallback Bericht eig.');
    return ownerBtn || customerBtn || null;
  }

  async function sendEmailOnly() {
    const mailBtn = chooseEmailButtonByParty();
    if (!mailBtn) {
      alert('SEND_EMAIL: email button not found (Bericht eig./Bericht klant)');
      return false;
    }

    const req = markRequest('email');
    mailBtn.click();

    // fallback: sometimes compose is inline and available in same page
    if (isEmailComposeContext()) {
      const d = document;
      const tpl = d.querySelector('#naam,select#naam,select[name="naam"]');
      if (!selectByNeedle(tpl, CFG.emailTemplateNeedle)) {
        alert('SEND_EMAIL: template "Credit Akkoord" not found');
        return false;
      }
      await sleep(250);
      const stuur = findButtonByTextInDoc(d, 'stuur');
      if (!stuur) {
        alert('SEND_EMAIL: button "Stuur" not found');
        return false;
      }
      stuur.click();
      await sleep(450);
      closeInlineDialog(d);
      completeRequest(req.id, true, 'inline ok');
      return true;
    }

    const res = await waitForResult(req.id, CFG.timeoutMs);
    if (!res) {
      alert('SEND_EMAIL: no result from popup/dialog');
      return false;
    }
    if (!res.ok) {
      alert('SEND_EMAIL failed: ' + (res.msg || 'unknown'));
      return false;
    }
    log('SEND_EMAIL done via remote popup handler');
    return true;
  }

  async function sendSmsOnly() {
    const smsBtn = q('#btn_sms');
    if (!smsBtn) {
      alert('SEND_SMS: #btn_sms not found');
      return false;
    }

    const req = markRequest('sms');
    log('SEND_SMS start', { reqId: req.id });

    let capturedNo06 = false;
    const patched = [];

    // WVB-style: patch alert only around click
    for (const d of allDocs()) {
      try {
        const w = d.defaultView;
        if (!w || patched.find(x => x.w === w)) continue;
        const orig = w.alert;
        w.alert = (msg) => {
          const s = String(msg || '').toLowerCase();
          if (s.includes(NO06_PHRASE)) { capturedNo06 = true; return; }
          try { orig(msg); } catch {}
        };
        patched.push({ w, orig });
      } catch {}
    }

    try {
      smsBtn.click();
    } finally {
      for (const p of patched) {
        try { p.w.alert = p.orig; } catch {}
      }
    }

    if (capturedNo06) {
      const okClosed = clickNo06OkButton();
      const blogOk = addBlogCommentGeen06();
      completeRequest(req.id, true, `no06 handled: ok=${okClosed}, blog=${blogOk}`);
      log('SEND_SMS skipped with NO06 fallback', { okClosed, blogOk });
      return true;
    }

    // fallback: sometimes compose is inline and available in same page
    if (isSmsComposeContext()) {
      const d = document;
      const tpl = d.querySelector('#lst_tekst,select#lst_tekst,select[name="lst_tekst"]');
      if (!selectByNeedle(tpl, CFG.smsTemplateNeedle)) {
        alert('SEND_SMS: template "Melding reactie op Email" not found');
        return false;
      }
      await sleep(250);
      const sendBtn = d.querySelector('#btnsend') || findButtonByTextInDoc(d, 'stuur');
      if (!sendBtn) {
        alert('SEND_SMS: send button not found');
        return false;
      }
      sendBtn.click();
      await sleep(450);
      closeInlineDialog(d);
      completeRequest(req.id, true, 'inline ok');
      return true;
    }

    const res = await waitForResult(req.id, CFG.smsWaitMs);
    if (!res) {
      // Fallback: avoid hard-fail popup; leave diagnostic in console
      log('SEND_SMS timeout: no popup result received');
      return false;
    }
    if (!res.ok) {
      alert('SEND_SMS failed: ' + (res.msg || 'unknown'));
      return false;
    }

    if (String(res.msg || '').toLowerCase().includes('no06 handled')) {
      log('SEND_SMS handled via NO06 fallback (not sent)');
      return 'NO06';
    }

    log('SEND_SMS sent via remote popup handler');
    return true;
  }

  async function processEmailComposeIfRequested() {
    const req = getFreshRequest('email');
    if (!req) return false;
    if (!isEmailComposeContext()) return false;

    const stageKey = 'gw_email_stage_' + req.id;
    const triesKey = 'gw_email_tries_' + req.id;

    function getStage() { try { return sessionStorage.getItem(stageKey) || 'init'; } catch { return 'init'; } }
    function setStage(v) { try { sessionStorage.setItem(stageKey, v); } catch {} log('EMAIL stage ->', v, 'req', req.id); }
    function getTries() { try { return Number(sessionStorage.getItem(triesKey) || '0'); } catch { return 0; } }
    function incTry() { const n = getTries() + 1; try { sessionStorage.setItem(triesKey, String(n)); } catch {} return n; }

    try {
      const d = document;
      const tpl = d.querySelector('#naam,select#naam,select[name="naam"]');
      const body = d.querySelector('#tekst,textarea#tekst,textarea[name="tekst"],#txt_tekst');
      const stuur = findButtonByTextInDoc(d, 'stuur');

      log('EMAIL compose detected', { reqId: req.id, stage: getStage(), hasTpl: !!tpl, hasBody: !!body, hasStuur: !!stuur, href: location.href });

      if (!tpl || !stuur) {
        completeRequest(req.id, false, 'email compose missing controls (naam/stuur)');
        return true;
      }

      const stage = getStage();

      if (stage === 'init' || stage === 'selecting') {
        const selected = selectByNeedle(tpl, CFG.emailTemplateNeedle);
        if (!selected) {
          completeRequest(req.id, false, 'template Credit Akkoord not found');
          return true;
        }
        const tr = incTry();
        setStage('waiting_ready');
        log('EMAIL template selected, try', tr, 'value=', tpl.value);
        return true;
      }

      if (stage === 'waiting_ready') {
        const tr = getTries();
        // wait until body appears (if available), otherwise allow delayed send after few rounds
        const bodyReady = body ? !!(body.value || '').trim() : (tr >= 2);
        if (bodyReady) {
          setStage('sending');
          stuur.click();
          await sleep(700);
          completeRequest(req.id, true, 'ok');
          try { window.close(); } catch {}
          return true;
        }
        if (tr > 8) {
          completeRequest(req.id, false, 'email body not ready after template select');
          return true;
        }
        incTry();
        log('EMAIL waiting ready...', { reqId: req.id, tries: getTries(), bodyLen: body ? (body.value || '').trim().length : -1 });
        return true;
      }

      return true;
    } catch (e) {
      log('processEmailComposeIfRequested error', e);
      completeRequest(req.id, false, String(e?.message || e));
      return true;
    }
  }

  async function processSmsComposeIfRequested() {
    const req = getFreshRequest('sms');
    if (!req) return false;
    if (!isSmsComposeContext()) return false;

    const stageKey = 'gw_sms_stage_' + req.id;
    const triesKey = 'gw_sms_tries_' + req.id;

    function getStage() { try { return sessionStorage.getItem(stageKey) || 'init'; } catch { return 'init'; } }
    function setStage(v) { try { sessionStorage.setItem(stageKey, v); } catch {} log('SMS stage ->', v, 'req', req.id); }
    function getTries() { try { return Number(sessionStorage.getItem(triesKey) || '0'); } catch { return 0; } }
    function incTry() { const n = getTries() + 1; try { sessionStorage.setItem(triesKey, String(n)); } catch {} return n; }

    try {
      const d = document;
      const txt = d.querySelector('#tekst');
      const tpl = d.querySelector('#lst_tekst,select#lst_tekst,select[name="lst_tekst"]');
      const sendBtn = d.querySelector('#btnsend') || findButtonByTextInDoc(d, 'stuur');

      if (isSmsSent(req.id)) {
        log('SMS send locked: already sent for req', req.id);
        completeRequest(req.id, true, 'already sent (lock)');
        try { window.close(); } catch {}
        return true;
      }

      log('SMS compose detected', { reqId: req.id, stage: getStage(), hasTxt: !!txt, hasTpl: !!tpl, hasSend: !!sendBtn, href: location.href });

      if (!txt || !tpl || !sendBtn) {
        completeRequest(req.id, false, 'sms compose missing controls (tekst/lst_tekst/btnsend)');
        return true;
      }

      // If template already produced text, just send once
      if ((txt.value || '').trim()) {
        setStage('sending');

        let capturedNo06 = false;
        const origAlert = window.alert;
        try {
          window.alert = (msg) => {
            const s = String(msg || '').toLowerCase();
            if (s.includes(NO06_PHRASE)) { capturedNo06 = true; return; }
            try { origAlert(msg); } catch {}
          };

          markSmsSent(req.id);
          sendBtn.click();
        } finally {
          try { window.alert = origAlert; } catch {}
        }

        await sleep(700);

        if (capturedNo06 || detectNo06ModalDom()) {
          clickNo06OkButton();
          addBlogCommentGeen06();
          completeRequest(req.id, true, 'no06 handled');
          try { window.close(); } catch {}
          return true;
        }

        completeRequest(req.id, true, 'ok');
        try { window.close(); } catch {}
        return true;
      }

      const stage = getStage();
      if (stage === 'init' || stage === 'selecting') {
        const selected = selectByNeedle(tpl, CFG.smsTemplateNeedle);
        if (!selected) {
          completeRequest(req.id, false, 'template Melding reactie op Email not found');
          return true;
        }
        const tr = incTry();
        setStage('waiting_text');
        log('SMS template selected, try', tr, 'value=', tpl.value);
        return true;
      }

      if (stage === 'waiting_text') {
        const tr = getTries();
        if (tr > 8) {
          completeRequest(req.id, false, 'sms text not generated after template select');
          return true;
        }
        // bump counter on each pass to avoid infinite loop
        incTry();
        log('SMS waiting text...', { reqId: req.id, tries: getTries(), textLen: (txt.value || '').trim().length });
        return true;
      }

      return true;
    } catch (e) {
      log('processSmsComposeIfRequested error', e);
      completeRequest(req.id, false, String(e?.message || e));
      return true;
    }
  }

  async function sendBoth(btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'RUN...';
    try {
      const okEmail = await sendEmailOnly();
      await sleep(300);
      const smsRes = await sendSmsOnly();
      const smsLabel = smsRes === 'NO06' ? 'NO06_HANDLED' : (smsRes ? 'SENT' : 'FAIL');
      log(`Done. SEND_EMAIL=${okEmail ? 'OK' : 'FAIL'}, SEND_SMS=${smsLabel}`);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function createBtn(doc, id, text, css, onClick) {
    let b = doc.getElementById(id);
    if (b) return b;
    b = doc.createElement('button');
    b.id = id;
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = css;
    b.addEventListener('click', onClick);
    return b;
  }

  function mountButtons() {
    const anchor = q(CFG.hostSelector);
    if (!anchor) return;
    const d = anchor.ownerDocument || document;

    if (d.getElementById('tm-send-email-sms-both')) return;

    const wrap = d.createElement('span');
    wrap.style.cssText = 'margin-left:8px;display:inline-flex;gap:6px;vertical-align:middle;';

    const both = createBtn(
      d,
      'tm-send-email-sms-both',
      'EMAIL+SMS',
      'padding:2px 8px;height:22px;border:1px solid #4c1d95;background:#ede9fe;color:#3b0764;border-radius:4px;cursor:pointer;font:700 11px/1 Arial,sans-serif;',
      () => sendBoth(both)
    );

    wrap.appendChild(both);
    anchor.insertAdjacentElement('afterend', wrap);
  }

  function boot() {
    if (window.top !== window) return;
    installPopupTracker();

    // Popup/dialog auto-handlers (WVB-like opener flow)
    setTimeout(() => { processEmailComposeIfRequested(); }, 200);
    setTimeout(() => { processSmsComposeIfRequested(); }, 300);

    setInterval(() => {
      try { processEmailComposeIfRequested(); } catch {}
      try { processSmsComposeIfRequested(); } catch {}
      try { mountButtons(); } catch (e) { log('mount error', e); }
    }, 900);
  }

  boot();
})();
