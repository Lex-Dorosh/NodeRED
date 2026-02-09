// ==UserScript==
// @name         Remarks quick helper (comments presets)
// @namespace    https://groupwise.cerepair.nl/
// @version      1.5
// @description  Quick buttons and device-specific snippets for "Remarks (for technician on workorder)" field. Adds MONITOR as separate device type. Fix: Alle appends+save once (no multi popups). Suppress native "update geslaagd" alerts. Detect vacuum by model prefix VS/VR/VCA.
// @author       you
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  function log(...args) { console.log('[Remarks-helper]', ...args); }

  // ---------------------------------------------------------
  // Popup auto-close: "update geslaagd" + OK
  // + suppress native alert("update geslaagd")
  // ---------------------------------------------------------
  const POPUP_TEXT = 'update geslaagd';

  function normText(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  (function suppressNativeUpdateAlert() {
    try {
      const origAlert = window.alert;
      if (typeof origAlert === 'function' && !window.__remarksHelperAlertWrapped) {
        window.__remarksHelperAlertWrapped = true;
        window.alert = function (msg) {
          const t = normText(String(msg || ''));
          if (t.includes(POPUP_TEXT)) {
            log('Suppressed native alert:', msg);
            return; // auto-dismiss
          }
          return origAlert.call(window, msg);
        };
      }
    } catch (e) {
      // ignore
    }
  })();

  function clickElement(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) {}
    try {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(evt);
      return true;
    } catch (e2) { return false; }
  }

  function findOkButtonIn(root) {
    if (!root) return null;
    const candidates = root.querySelectorAll('button, input[type="button"], input[type="submit"], a');
    for (const c of candidates) {
      const t = normText(c.textContent || c.value || '');
      if (t === 'ok' || t === 'oke' || t === 'sluiten' || t === 'close') return c;
    }
    return null;
  }

  function tryCloseUpdateGeslaagdPopupOnce() {
    const all = document.querySelectorAll('body *');
    let hit = null;

    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el && el.id === 'remarks-helper-panel') continue;
      const txt = normText(el.textContent);
      if (txt && txt.includes(POPUP_TEXT)) { hit = el; break; }
    }
    if (!hit) return false;

    let container = hit;
    for (let i = 0; i < 6; i++) {
      if (!container || container === document.body) break;
      const btn = findOkButtonIn(container);
      if (btn && clickElement(btn)) {
        log('Auto-closed popup via OK in container.');
        return true;
      }
      container = container.parentElement;
    }

    const globalOk = findOkButtonIn(document.body);
    if (globalOk && clickElement(globalOk)) {
      log('Auto-closed popup via global OK fallback.');
      return true;
    }
    return false;
  }

  function scheduleAutoClosePopup() {
    const delays = [0, 80, 180, 350, 700, 1200];
    delays.forEach(d => setTimeout(() => { tryCloseUpdateGeslaagdPopupOnce(); }, d));
  }

  function installPopupObserver() {
    if (window.__remarksHelperPopupObserverInstalled) return;
    window.__remarksHelperPopupObserverInstalled = true;

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes || []) {
          if (!n || n.nodeType !== 1) continue;
          const t = normText(n.textContent);
          if (t && t.includes(POPUP_TEXT)) {
            scheduleAutoClosePopup();
            return;
          }
        }
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });
    log('Popup observer installed.');
  }

  // ---------------------------------------------------------
  // Device/model helpers
  // ---------------------------------------------------------
  function getModelCode() {
    const el =
      document.getElementById('modelcode') ||
      document.querySelector('input#modelcode, input[name="modelcode"]');
    const v = (el && el.value) ? String(el.value).trim() : '';
    return v.toUpperCase();
  }

  function detectDeviceType() {
    const legends = document.querySelectorAll('fieldset legend');
    let targetLegend = null;

    for (const lg of legends) {
      const t = (lg.textContent || '').toLowerCase();
      if (t.includes('toestel')) { targetLegend = lg; break; }
    }

    if (!targetLegend) {
      log('No legend with "Toestel" found.');
      return null;
    }

    const txt = (targetLegend.textContent || '').toLowerCase().trim();
    log('Toestel legend raw text:', txt);

    // Existing explicit cases
    if (txt.includes('soundbar')) return 'soundbar';
    if (txt.includes('monitor')) return 'monitor';
    if (txt.includes(' tv') || txt.endsWith('tv')) return 'tv';

    // Vacuum: distinguish by model prefix
    if (txt.includes('stofzuiger')) {
      const model = getModelCode();
      if (model) log('Modelcode detected:', model);

      // Robot vacuum
      if (model.startsWith('VR')) return 'robot';

      // Accessory-only
      if (model.startsWith('VCA')) return 'vac_accessory';

      // Stick vacuum (default)
      if (model.startsWith('VS')) return 'stofzuiger';

      // Fallback if model missing
      return 'stofzuiger';
    }

    // Generic robot (if legend explicitly says robot)
    if (txt.includes('robot')) return 'robot';

    return null;
  }

  function deviceTypeLabel(type) {
    switch (type) {
      case 'robot':         return 'Robot';
      case 'soundbar':      return 'Soundbar';
      case 'tv':            return 'TV';
      case 'monitor':       return 'Monitor';
      case 'stofzuiger':    return 'Stofzuiger (VS)';
      case 'vac_accessory': return 'Accessoire (VCA)';
      default:              return 'Toestel';
    }
  }

  function getButtonDefs(type) {
    switch (type) {
      case 'robot':
        return [
          { code: 'Robot', title: 'robot//', snippet: 'robot//' },
          { code: 'Base',  title: 'base//',  snippet: 'base//' }
        ];

      case 'soundbar':
        return [
          { code: 'SB', title: 'soundbar//',          snippet: 'soundbar//' },
          { code: 'SW', title: 'subwoofer',           snippet: 'subwoofer' },
          { code: 'SR', title: '//surroudspeakers//', snippet: '//surroudspeakers//' },
          { code: 'AB', title: 'afstandsbediening//', snippet: 'afstandsbediening//' }
        ];

      case 'tv':
        return [
          {
            code: 'OCB',
            title: 'OCB// (HEEFT OCB - LET OP: SIERLIJST BIJ KLANT LATEN)',
            snippet: 'OCB// (HEEFT OCB - LET OP: SIERLIJST BIJ KLANT LATEN)'
          },
          { code: 'G OCB', title: 'GEEN OCB//', snippet: 'GEEN OCB//' }
        ];

      case 'monitor':
        return [
          { code: 'AB',      title: 'afstandsbediening//', snippet: 'afstandsbediening//' },
          { code: 'Kabel',   title: 'kabel//',             snippet: 'kabel//' },
          { code: 'Adaptor', title: 'adapter//',           snippet: 'adapter//' }
        ];

      case 'stofzuiger': // stick vac (VS)
        return [
          { code: 'Motor', title: 'motor//',    snippet: 'motor//' },
          { code: 'Stang', title: 'stang//',    snippet: 'stang//' },
          { code: 'Mond',  title: 'mondstuk//', snippet: 'mondstuk//' },
          { code: 'Accu',  title: 'accu//',     snippet: 'accu//' },
          { code: 'Opl',   title: 'oplader//',  snippet: 'oplader//' }
        ];

      case 'vac_accessory': // VCA*
        return [
          { code: 'Acc', title: 'accessoire//', snippet: 'accessoire//' }
        ];

      default:
        return [];
    }
  }

  // ---------------------------------------------------------
  // Append helpers
  // ---------------------------------------------------------
  function saveTextarea(textarea) {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    if (typeof window.appendeditedfield === 'function') {
      const fieldName = textarea.name || textarea.id;
      try {
        window.appendeditedfield(fieldName, false);
        log('appendeditedfield called for', fieldName);
      } catch (e) {
        log('appendeditedfield error', e);
      }
    } else {
      log('appendeditedfield not available on this page.');
    }

    scheduleAutoClosePopup();
  }

  function appendSnippet(textarea, snippet) {
    if (!textarea) return;
    const cur = textarea.value || '';
    let out = cur;

    if (!cur.trim()) out = snippet;
    else {
      out = cur;
      if (!/\s$/.test(out)) out += ' ';
      out += snippet;
    }

    textarea.value = out;
    saveTextarea(textarea);
  }

  // IMPORTANT FIX: append multiple snippets + SAVE ONCE
  function appendSnippetsBulk(textarea, snippets) {
    if (!textarea) return;
    let out = (textarea.value || '').trim();

    for (const sn of (snippets || [])) {
      if (!sn) continue;
      if (out && !/\s$/.test(out)) out += ' ';
      out += sn;
    }

    textarea.value = out;
    saveTextarea(textarea);
  }

  function addDeviceButtons(panel, comments, deviceType) {
    const defs = getButtonDefs(deviceType);
    if (!defs.length) {
      log('No button defs for device type', deviceType);
      return;
    }

    const group = document.createElement('div');
    group.style.display = 'flex';
    group.style.flexWrap = 'wrap';
    group.style.alignItems = 'center';
    group.style.gap = '4px';
    group.style.marginLeft = '8px';

    const label = document.createElement('span');
    label.textContent = deviceTypeLabel(deviceType) + ':';
    label.style.fontWeight = 'bold';
    group.appendChild(label);

    defs.forEach(def => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button';
      btn.textContent = def.code;
      btn.title = def.title;
      btn.style.fontSize = '9px';
      btn.addEventListener('click', () => appendSnippet(comments, def.snippet));
      group.appendChild(btn);
    });

    const btnAll = document.createElement('button');
    btnAll.type = 'button';
    btnAll.className = 'button';
    btnAll.textContent = 'Alle';
    btnAll.title = 'Alle accessoires toevoegen (1x opslaan)';
    btnAll.style.fontSize = '9px';
    btnAll.addEventListener('click', () => appendSnippetsBulk(comments, defs.map(d => d.snippet)));
    group.appendChild(btnAll);

    panel.appendChild(group);
  }

  function init() {
    installPopupObserver();

    const comments = document.getElementById('comments');
    if (!comments) {
      log('comments field not found in this frame, stop.');
      return;
    }

    if (document.getElementById('remarks-helper-panel')) return;

    const deviceType = detectDeviceType();
    log('Detected device type:', deviceType || 'unknown');

    const panel = document.createElement('div');
    panel.id = 'remarks-helper-panel';
    panel.style.marginTop = '4px';
    panel.style.fontSize = '9px';
    panel.style.display = 'flex';
    panel.style.flexWrap = 'wrap';
    panel.style.alignItems = 'center';
    panel.style.gap = '4px';

    const btnAP = document.createElement('button');
    btnAP.type = 'button';
    btnAP.className = 'button';
    btnAP.textContent = 'AP';
    btnAP.title = 'OPHALEN//';
    btnAP.style.fontSize = '9px';
    btnAP.addEventListener('click', () => appendSnippet(comments, 'OPHALEN//'));

    const btnPO = document.createElement('button');
    btnPO.type = 'button';
    btnPO.className = 'button';
    btnPO.textContent = 'PO';
    btnPO.title = 'VERZENDLABEL//';
    btnPO.style.fontSize = '9px';
    btnPO.addEventListener('click', () => appendSnippet(comments, 'VERZENDLABEL//'));

    panel.appendChild(btnAP);
    panel.appendChild(btnPO);

    if (deviceType) addDeviceButtons(panel, comments, deviceType);

    comments.insertAdjacentElement('afterend', panel);
    log('Remarks-helper panel added.');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
