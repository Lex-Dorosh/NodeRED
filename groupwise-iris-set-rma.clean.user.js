// ==UserScript==
// @name         GROUPWISE IRIS RMA Mini Autofill [BETA]
// @namespace    https://groupwise.cerepair.nl/
// @version      0.1.3-beta
// @description  Adds "IRIS SET RMA" button and fills IRIS codes (Defect=N, Repair=Z, others=first valid option).
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// @downloadURL https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-iris-set-rma.clean.user.js
// @updateURL https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-iris-set-rma.clean.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: true,
    logPrefix: '[IRIS-RMA v0.1.2]',
    buttonId: 'tm-iris-rma-btn',
    buttonText: 'IRIS SET RMA',
    fillDelayMs: 120,
    openTimeoutMs: 15000,
    waitIntervalMs: 150,
    mountRetryEveryMs: 1000,
    targetSelectIds: ['lst_condition', 'lst_symptom', 'lst_section', 'lst_defect', 'lst_repair']
  };

  const log = (...args) => CONFIG.debug && console.log(CONFIG.logPrefix, ...args);
  const warn = (...args) => console.warn(CONFIG.logPrefix, ...args);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function getAccessibleDocs(rootWin = window.top) {
    const out = [];
    const seen = new WeakSet();

    const visit = (w) => {
      let d;
      try { d = w.document; } catch { return; }
      if (!d || seen.has(d)) return;
      seen.add(d);
      out.push({ win: w, doc: d });

      let len = 0;
      try { len = w.frames.length; } catch { len = 0; }
      for (let i = 0; i < len; i++) {
        try { visit(w.frames[i]); } catch {}
      }
    };

    visit(rootWin);
    return out;
  }

  function findByIdDeep(id) {
    for (const { win, doc } of getAccessibleDocs()) {
      const el = doc.getElementById(id);
      if (el) return { win, doc, el };
    }
    return null;
  }

  async function waitFor(checkFn, timeoutMs = 10000, intervalMs = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const value = checkFn();
        if (value) return value;
      } catch {}
      await sleep(intervalMs);
    }
    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const cs = win.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function getValidOptions(selectEl) {
    const options = Array.from(selectEl.options || []);
    return options.filter(opt => {
      const value = String(opt.value || '').trim();
      const text = String(opt.textContent || '').trim();
      if (!value) return false;
      if (/^[-\s]+$/.test(text)) return false;
      return true;
    });
  }

  function getFirstValidOption(selectEl) {
    const valid = getValidOptions(selectEl);
    return valid[0] || null;
  }

  function getOptionByValue(selectEl, wantedValue) {
    const valid = getValidOptions(selectEl);
    return valid.find(opt => String(opt.value) === String(wantedValue)) || null;
  }

  function getPenultimateValidOption(selectEl) {
    const valid = getValidOptions(selectEl);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];
    return valid[valid.length - 2];
  }

  function setSelectValue(selectEl, value) {
    selectEl.value = value;
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function showToast(message, ok = true, targetDoc = document) {
    const d = targetDoc.createElement('div');
    d.textContent = message;
    d.style.cssText = `
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      max-width: 420px;
      padding: 10px 12px;
      border-radius: 10px;
      color: #fff;
      font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: ${ok ? 'rgba(22,163,74,.95)' : 'rgba(220,38,38,.95)'};
      box-shadow: 0 8px 20px rgba(0,0,0,.35);
    `;
    (targetDoc.body || targetDoc.documentElement).appendChild(d);
    setTimeout(() => d.remove(), 3500);
  }

  async function ensureIrisPanelOpen() {
    const existing = findByIdDeep('tbl_iris');
    if (existing && isElementVisible(existing.el)) {
      log('IRIS panel already open');
      return true;
    }

    const btnCtx = findByIdDeep('btn_iriscodes');
    if (!btnCtx?.el) {
      warn('btn_iriscodes not found');
      return false;
    }

    try { btnCtx.el.click(); } catch {}
    try { if (typeof btnCtx.win.showiris === 'function') btnCtx.win.showiris(); } catch {}

    const opened = await waitFor(() => {
      const irisCtx = findByIdDeep('tbl_iris');
      if (!irisCtx?.el) return null;
      return isElementVisible(irisCtx.el) ? irisCtx : null;
    }, CONFIG.openTimeoutMs, CONFIG.waitIntervalMs);

    if (!opened) {
      warn('IRIS panel did not open in time');
      return false;
    }

    log('IRIS panel opened');
    return true;
  }

  async function fillAllIrisSelectsWithFirstOption() {
    const report = [];

    for (const selectId of CONFIG.targetSelectIds) {
      const selCtx = await waitFor(() => {
        const ctx = findByIdDeep(selectId);
        if (!ctx?.el || ctx.el.tagName !== 'SELECT') return null;
        return ctx;
      }, 8000, CONFIG.waitIntervalMs);

      if (!selCtx?.el) {
        report.push({ id: selectId, ok: false, reason: 'SELECT not found' });
        warn(`SELECT not found: #${selectId}`);
        continue;
      }

      let opt = null;
      if (selectId === 'lst_defect') {
        opt = getOptionByValue(selCtx.el, 'N');
      } else if (selectId === 'lst_repair') {
        opt = getOptionByValue(selCtx.el, 'Z');
      } else {
        opt = getFirstValidOption(selCtx.el);
      }

      if (!opt) {
        report.push({ id: selectId, ok: false, reason: 'No valid options' });
        warn(`No valid option for #${selectId}`);
        continue;
      }

      setSelectValue(selCtx.el, opt.value);
      report.push({ id: selectId, ok: true, value: opt.value, text: (opt.textContent || '').trim() });
      log(`Filled #${selectId} -> value="${opt.value}" text="${(opt.textContent || '').trim()}"${selectId === 'lst_repair' ? ' (penultimate)' : ''}`);

      await sleep(CONFIG.fillDelayMs);
    }

    return report;
  }

  function isSamsungOrder(hostDoc) {
    try {
      const legends = Array.from(hostDoc.querySelectorAll('legend'));
      return legends.some(l => /\bsamsung\b/i.test(String(l.textContent || '')));
    } catch {
      return false;
    }
  }

  function createInlineButton(hostDoc, hostEl) {
    if (!hostDoc || !hostEl) return null;
    if (hostDoc.getElementById(CONFIG.buttonId)) return hostDoc.getElementById(CONFIG.buttonId);

    const btn = hostDoc.createElement('button');
    btn.id = CONFIG.buttonId;
    btn.type = 'button';
    btn.textContent = CONFIG.buttonText;
    btn.style.cssText = `
      margin-left: 8px;
      padding: 2px 8px;
      height: 22px;
      border: 1px solid #7aa2b8;
      background: #cfe4ef;
      color: #1f3b4d;
      border-radius: 4px;
      cursor: pointer;
      font: 700 11px/1 Arial, sans-serif;
      vertical-align: middle;
    `;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'RUN...';
      try {
        log('IRIS RMA started');
        const opened = await ensureIrisPanelOpen();
        if (!opened) {
          showToast('IRIS panel not found/opened', false, hostDoc);
          return;
        }

        const results = await fillAllIrisSelectsWithFirstOption();
        const okCount = results.filter(r => r.ok).length;
        const failCount = results.length - okCount;

        if (failCount === 0) showToast(`IRIS filled: ${okCount}/5`, true, hostDoc);
        else showToast(`IRIS partial: ${okCount}/5 (check console)`, false, hostDoc);

        log('IRIS RMA finished', results);
      } catch (err) {
        warn('IRIS RMA failed', err);
        showToast(`IRIS RMA error: ${String(err?.message || err)}`, false, hostDoc);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });

    hostEl.insertAdjacentElement('afterend', btn);
    log('IRIS RMA button mounted near btn_iriscodes');
    return btn;
  }

  function tryMountButton() {
    const irisBtnCtx = findByIdDeep('btn_iriscodes');
    if (!irisBtnCtx?.el || !irisBtnCtx.doc) return false;

    const allowed = isSamsungOrder(irisBtnCtx.doc);
    const existing = irisBtnCtx.doc.getElementById(CONFIG.buttonId);

    if (!allowed) {
      if (existing) existing.remove();
      return false;
    }

    createInlineButton(irisBtnCtx.doc, irisBtnCtx.el);
    return true;
  }

  async function boot() {
    if (!/groupwise\.cerepair\.nl$/i.test(location.hostname)) return;

    await waitFor(() => document.body, 15000, 100);

    tryMountButton();

    setInterval(() => {
      try { tryMountButton(); } catch {}
    }, CONFIG.mountRetryEveryMs);
  }

  boot().catch(err => warn('Boot error', err));
})();
