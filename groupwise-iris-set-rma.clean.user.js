// ==UserScript==
// @name         Groupwise IRIS SET RMA (Samsung)
// @namespace    https://groupwise.cerepair.nl/
// @version      1.0.0
// @description  Samsung-only: adds "IRIS SET RMA" and fills IRIS codes (5th field = penultimate option).
// @author       Alex + OpenClaw Copilot
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// @homepageURL  https://github.com/YOUR_ORG/YOUR_REPO
// @supportURL   https://github.com/YOUR_ORG/YOUR_REPO/issues
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-iris-set-rma.clean.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/groupwise-iris-set-rma.clean.user.js
// ==/UserScript==

(function () {
  'use strict';

  const C = {
    id: 'tm-iris-rma-btn',
    text: 'IRIS SET RMA',
    delay: 120,
    openTimeout: 15000,
    poll: 150,
    remount: 1000,
    fields: ['lst_condition', 'lst_symptom', 'lst_section', 'lst_defect', 'lst_repair']
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function docs(root = window.top) {
    const out = [];
    const seen = new WeakSet();
    const walk = (w) => {
      let d;
      try { d = w.document; } catch { return; }
      if (!d || seen.has(d)) return;
      seen.add(d);
      out.push({ win: w, doc: d });
      let n = 0;
      try { n = w.frames.length; } catch { n = 0; }
      for (let i = 0; i < n; i++) {
        try { walk(w.frames[i]); } catch {}
      }
    };
    walk(root);
    return out;
  }

  function byIdDeep(id) {
    for (const { win, doc } of docs()) {
      const el = doc.getElementById(id);
      if (el) return { win, doc, el };
    }
    return null;
  }

  async function waitFor(fn, timeout = 10000, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch {}
      await sleep(step);
    }
    return null;
  }

  function visible(el) {
    if (!el) return false;
    const d = el.ownerDocument || document;
    const w = d.defaultView || window;
    const cs = w.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function validOptions(sel) {
    return Array.from(sel.options || []).filter((o) => {
      const v = String(o.value || '').trim();
      const t = String(o.textContent || '').trim();
      return !!v && !/^[-\s]+$/.test(t);
    });
  }

  function first(sel) {
    const v = validOptions(sel);
    return v[0] || null;
  }

  function penultimate(sel) {
    const v = validOptions(sel);
    if (!v.length) return null;
    return v.length === 1 ? v[0] : v[v.length - 2];
  }

  function setValue(sel, value) {
    sel.value = value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function toast(msg, ok = true, d = document) {
    const n = d.createElement('div');
    n.textContent = msg;
    n.style.cssText = `position:fixed;right:14px;bottom:14px;z-index:999999;max-width:420px;padding:10px 12px;border-radius:10px;color:#fff;font:12px/1.3 system-ui;background:${ok ? 'rgba(22,163,74,.95)' : 'rgba(220,38,38,.95)'};box-shadow:0 8px 20px rgba(0,0,0,.35);`;
    (d.body || d.documentElement).appendChild(n);
    setTimeout(() => n.remove(), 3000);
  }

  function isSamsung(doc) {
    try {
      return Array.from(doc.querySelectorAll('legend')).some((l) => /\bsamsung\b/i.test(String(l.textContent || '')));
    } catch {
      return false;
    }
  }

  async function ensureIrisOpen() {
    const t = byIdDeep('tbl_iris');
    if (t && visible(t.el)) return true;

    const b = byIdDeep('btn_iriscodes');
    if (!b?.el) return false;

    try { b.el.click(); } catch {}
    try { if (typeof b.win.showiris === 'function') b.win.showiris(); } catch {}

    const ok = await waitFor(() => {
      const x = byIdDeep('tbl_iris');
      return x?.el && visible(x.el) ? x : null;
    }, C.openTimeout, C.poll);

    return !!ok;
  }

  async function fillAll() {
    const report = [];
    for (const id of C.fields) {
      const ctx = await waitFor(() => {
        const x = byIdDeep(id);
        return x?.el && x.el.tagName === 'SELECT' ? x : null;
      }, 8000, C.poll);

      if (!ctx?.el) {
        report.push({ id, ok: false });
        continue;
      }

      const opt = id === 'lst_repair' ? penultimate(ctx.el) : first(ctx.el);
      if (!opt) {
        report.push({ id, ok: false });
        continue;
      }

      setValue(ctx.el, opt.value);
      report.push({ id, ok: true, value: opt.value });
      await sleep(C.delay);
    }
    return report;
  }

  function mountButton(doc, anchor) {
    if (doc.getElementById(C.id)) return;

    const b = doc.createElement('button');
    b.id = C.id;
    b.type = 'button';
    b.textContent = C.text;
    b.style.cssText = 'margin-left:8px;padding:2px 8px;height:22px;border:1px solid #7aa2b8;background:#cfe4ef;color:#1f3b4d;border-radius:4px;cursor:pointer;font:700 11px/1 Arial,sans-serif;vertical-align:middle;';

    b.addEventListener('click', async () => {
      b.disabled = true;
      const txt = b.textContent;
      b.textContent = 'RUN...';
      try {
        const opened = await ensureIrisOpen();
        if (!opened) {
          toast('IRIS panel not found/opened', false, doc);
          return;
        }
        const r = await fillAll();
        const ok = r.filter((x) => x.ok).length;
        toast(ok === 5 ? 'IRIS filled: 5/5' : `IRIS partial: ${ok}/5`, ok === 5, doc);
      } finally {
        b.disabled = false;
        b.textContent = txt;
      }
    });

    anchor.insertAdjacentElement('afterend', b);
  }

  function remount() {
    const ctx = byIdDeep('btn_iriscodes');
    if (!ctx?.el || !ctx.doc) return;

    const show = isSamsung(ctx.doc);
    const ex = ctx.doc.getElementById(C.id);

    if (!show) {
      if (ex) ex.remove();
      return;
    }

    mountButton(ctx.doc, ctx.el);
  }

  (async () => {
    if (!/groupwise\.cerepair\.nl$/i.test(location.hostname)) return;
    await waitFor(() => document.body, 15000, 100);
    remount();
    setInterval(() => { try { remount(); } catch {} }, C.remount);
  })();
})();
