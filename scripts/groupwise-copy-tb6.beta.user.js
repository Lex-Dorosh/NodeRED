// ==UserScript==
// @name         Groupwise - Copy TB6 line [BETA]
// @namespace    froopt/groupwise
// @version      0.1.5-beta
// @description  Adds "copy TB6" button near Remarks and copies order fields as one tab-separated line for Excel
// @match        https://groupwise.cerepair.nl/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const debug = false;

  function log(...args) {
    if (debug) console.log('[TB6]', ...args);
  }

  function getAllAccessibleDocs() {
    const docs = [];
    const seen = new Set();

    function addDoc(d) {
      if (!d || seen.has(d)) return;
      seen.add(d);
      docs.push(d);
    }

    function walkFrameWindow(w) {
      try {
        addDoc(w.document);
      } catch (e) {
        return;
      }

      let frameEls = [];
      try {
        frameEls = Array.from(w.document.querySelectorAll('iframe, frame'));
      } catch (e) {
        frameEls = [];
      }

      for (const fr of frameEls) {
        try {
          if (fr.contentWindow) walkFrameWindow(fr.contentWindow);
          else if (fr.contentDocument) addDoc(fr.contentDocument);
        } catch (e) {
          // ignore inaccessible frames
        }
      }
    }

    // Current window tree
    walkFrameWindow(window);

    // Top window tree (important when script runs inside nested frame)
    try {
      if (window.top && window.top !== window) walkFrameWindow(window.top);
    } catch (e) {
      // ignore
    }

    // Parent chain fallback
    try {
      let p = window.parent;
      let guard = 0;
      while (p && p !== window && guard < 10) {
        walkFrameWindow(p);
        if (p === p.parent) break;
        p = p.parent;
        guard++;
      }
    } catch (e) {
      // ignore
    }

    return docs;
  }

  function findFirstInDocs(selector) {
    for (const d of getAllAccessibleDocs()) {
      const el = d.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function parseOrderNumber() {
    // Example: "reparatie 3328578 G Samsung"
    for (const d of getAllAccessibleDocs()) {
      const h3 = d.querySelector('h3');
      const txt = (h3?.textContent || '').trim();
      if (!txt) continue;
      const m = txt.match(/reparatie\s+(\d+)/i) || txt.match(/\b(\d{6,})\b/);
      if (m) return m[1];
    }
    return '';
  }

  function getValue(selector) {
    const el = findFirstInDocs(selector);
    if (!el) return '';
    return (el.value ?? el.textContent ?? '').toString().trim();
  }

  function parseDealer() {
    // Prefer dealer block near "changeorderdatabytechnician" button
    for (const d of getAllAccessibleDocs()) {
      const btn = d.querySelector('button[onclick*="changeorderdatabytechnician"]');
      if (!btn) continue;
      const td = btn.closest('td');
      const div = td?.querySelector('div');
      if (div?.textContent?.trim()) return div.textContent.trim();
    }
    return '';
  }

  function parseOrderDateFromLegend() {
    // Example: <legend> Orderdate: 29-12-2025 10:08:07 ... </legend>
    for (const d of getAllAccessibleDocs()) {
      const legends = Array.from(d.querySelectorAll('legend'));
      for (const lg of legends) {
        const txt = (lg.textContent || '').trim();
        if (!/orderdate\s*:/i.test(txt)) continue;
        const m = txt.match(/orderdate\s*:\s*(\d{2}-\d{2}-\d{4})/i);
        if (m) return nlDateToExcel(m[1]);
      }
    }
    return '';
  }

  function parseOrderDateFromBlogFallback() {
    // Fallback when legend Orderdate is missing:
    // Prefer line with status "Apparaat ontvangen" and take its dd-mm date.
    const currentYear = new Date().getFullYear();

    for (const d of getAllAccessibleDocs()) {
      const blog = d.querySelector('#div_comment');
      if (!blog) continue;

      const txt = (blog.innerText || blog.textContent || '').replace(/\u00a0/g, ' ');

      // Example line:
      // - 08-01 12:46 stage3: Apparaat ontvangen
      const statusMatch = txt.match(/(?:^|\n|\r)\s*-?\s*(\d{2})-(\d{2})\s+\d{2}:\d{2}[\s\S]{0,120}?Apparaat\s+ontvangen/iu);
      if (statusMatch) {
        const dd = Number(statusMatch[1]);
        const mm = Number(statusMatch[2]);
        return `${mm}/${dd}/${currentYear}`;
      }

      // Last-resort fallback: oldest date in blog
      const matches = [...txt.matchAll(/\b(\d{2})-(\d{2})\s+\d{2}:\d{2}\b/g)];
      if (!matches.length) continue;
      const dates = matches.map(m => new Date(currentYear, Number(m[2]) - 1, Number(m[1]))).filter(dt => !Number.isNaN(dt.getTime()));
      if (!dates.length) continue;
      dates.sort((a, b) => a - b);
      const oldest = dates[0];
      return `${oldest.getMonth() + 1}/${oldest.getDate()}/${oldest.getFullYear()}`;
    }

    return '';
  }

  function nlDateToExcel(val) {
    // dd-mm-yyyy -> m/d/yyyy
    const m = (val || '').trim().match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
    if (!m) return (val || '').trim();
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3];
    return `${mm}/${dd}/${yyyy}`;
  }

  function collectData() {
    const orderNr = parseOrderNumber();
    const authNr = getValue('#authorisationnumber');
    const dealer = parseDealer();
    const klantRef = getValue('#custordernumber');
    const model = getValue('#modelcode');
    const serial = getValue('#serialnumber');
    const purchaseDate = nlDateToExcel(getValue('#purchasedate'));
    let serviceOrderDate = parseOrderDateFromLegend();
    if (!serviceOrderDate) serviceOrderDate = parseOrderDateFromBlogFallback();

    return [orderNr, authNr, dealer, klantRef, model, serial, purchaseDate, serviceOrderDate];
  }

  function showToast(message, type = 'ok') {
    const colors = {
      ok: { bg: '#1f8b4c', border: '#166534' },
      warn: { bg: '#b7791f', border: '#92400e' },
      error: { bg: '#b91c1c', border: '#7f1d1d' },
    };
    const style = colors[type] || colors.ok;

    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.right = '16px';
    toast.style.bottom = '16px';
    toast.style.zIndex = '2147483647';
    toast.style.padding = '10px 12px';
    toast.style.color = '#fff';
    toast.style.background = style.bg;
    toast.style.border = `1px solid ${style.border}`;
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '13px';
    toast.style.boxShadow = '0 6px 20px rgba(0,0,0,.25)';
    toast.style.maxWidth = '420px';

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  async function copyLine() {
    const fields = collectData();
    const missing = [];

    if (!fields[0]) missing.push('order number');
    if (!fields[1]) missing.push('auth number');
    if (!fields[4]) missing.push('model');
    if (!fields[7]) missing.push('service order date');

    const line = fields.join('\t');

    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(line, { type: 'text', mimetype: 'text/plain' });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(line);
      } else {
        const ta = document.createElement('textarea');
        ta.value = line;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }

      const msg = missing.length
        ? `⚠ Copied with missing: ${missing.join(', ')}`
        : '✅ TB6 line copied';
      showToast(msg, missing.length ? 'warn' : 'ok');
      log('Copied:', line, 'Missing:', missing);
    } catch (e) {
      console.error('[TB6] Copy failed:', e);
      showToast('❌ Copy failed. Check console/permissions.', 'error');
    }
  }

  let notFoundLogged = false;

  function injectButton() {
    const comments = findFirstInDocs('#comments');
    if (!comments) {
      if (!notFoundLogged) {
        log('comments textarea not found yet (waiting)');
        notFoundLogged = true;
      }
      return false;
    }

    if (findFirstInDocs('#tb6CopyBtn')) return true;

    const btn = document.createElement('button');
    btn.id = 'tb6CopyBtn';
    btn.type = 'button';
    btn.textContent = 'copy TB6';
    btn.style.marginLeft = '8px';
    btn.style.padding = '4px 8px';
    btn.style.cursor = 'pointer';
    btn.style.background = '#1f6feb';
    btn.style.color = '#fff';
    btn.style.border = '1px solid #1f6feb';
    btn.style.borderRadius = '4px';
    btn.addEventListener('click', copyLine);

    comments.insertAdjacentElement('afterend', btn);
    log('Button injected');
    return true;
  }

  function boot() {
    if (injectButton()) return;
    const timer = setInterval(() => {
      if (injectButton()) clearInterval(timer);
    }, 600);
    setTimeout(() => clearInterval(timer), 15000);
  }

  boot();
})();
