// ==UserScript==
// @name         Screen Service Report helper
// @namespace    https://groupwise.cerepair.nl/
// @version      1.15.2
// @description  FULL: SSR for Magnetron/Stofzuiger/Soundbar/TV + Admin + NL/EN UI (report NL). Photos gating on Next. Saved final card after reload + autosave draft + History modal with export/import JSON. Safe init + safe Workdescription detection (textarea/CKEditor). Overwrite Workdescription by default.
// @author       you
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/Screen-Service-Report-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/Screen-Service-Report-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ====== CONFIG ======
  const MAX_TRIES = 50;
  const INTERVAL_MS = 500;
  const DEV_TO = 'alex.dorosh@gxo.com';

  // LocalStorage key (domain storage; easiest + @grant none)
  const STORAGE_KEY = 'ssr_cases_v1';

  // ====== SAFE WRAPPER ======
  function safe(fn, label) {
    try { return fn(); }
    catch (e) {
      console.error('[SSR] ERROR in ' + (label || 'unknown') + ':', e);
      try { window.__SSR_LAST_ERROR = { label: label || 'unknown', message: String(e), stack: e && e.stack }; } catch (_) {}
      return null;
    }
  }

  // ====== STATE ======
  function makeDefaultState() {
    return {
      damaged: null,
      photos: null,

      damageParts: { behuizing: false, bodemplaat: false, deur: false },
      techComplaint: null,
      ndf: null,

      // Vacuum cleaner
      stofFiltersClean: null,
      stofFilterRing: false,
      stofFilterMicro: false,
      stofFilterBase: false,
      stofFilterOtherText: '',
      stofMotorWorks: null,
      stofMotorCauseUser: null,
      stofMotorReasonPowder: false,
      stofMotorReasonFineDust: false,
      stofMotorReasonDirtyFilters: false,
      stofMotorReasonOtherText: '',

      // Soundbar
      sbPartTop: false,
      sbPartBottom: false,
      sbPartSub: false,
      sbPartOther: false,
      sbPartOtherText: '',

      finalConfirm: null
    };
  }

  function mergeState(saved) {
    const base = makeDefaultState();
    if (!saved || typeof saved !== 'object') return base;

    Object.keys(base).forEach((k) => {
      if (k === 'damageParts') return;
      if (saved[k] !== undefined) base[k] = saved[k];
    });

    if (saved.damageParts && typeof saved.damageParts === 'object') {
      Object.keys(base.damageParts).forEach((k) => {
        if (saved.damageParts[k] !== undefined) base.damageParts[k] = !!saved.damageParts[k];
      });
    }
    return base;
  }

  let state = makeDefaultState();
  let currentStep = 1;
  let currentDeviceInfo = null;
  let isAdmin = false;
  let tries = 0;
  let timer = null;
  let autosaveTimer = null;
  let lastEmailText = '';

  // UI language (questions/buttons). Report NL always.
  let currentLanguage = 'NL';
  safe(() => {
    const savedLang = localStorage.getItem('ssr_language');
    if (savedLang === 'EN' || savedLang === 'NL') currentLanguage = savedLang;
  }, 'load language');

  // ====== UTIL ======
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function normText(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case '\'': return '&#039;';
        default: return ch;
      }
    });
  }

  function nowIso() { return new Date().toISOString(); }

  // ====== WORKDESCRIPTION DETECTION (SAFE) ======
  function findWorkdescription(doc) {
    const el = doc.getElementById('workdescription');
    if (el && el.tagName && el.tagName.toLowerCase() === 'textarea') return { kind: 'textarea', el, anchor: el };

    const allTa = Array.from(doc.querySelectorAll('textarea'));
    for (const ta of allTa) {
      const id = (ta.id || '').toLowerCase();
      const nm = (ta.name || '').toLowerCase();
      if (id.includes('workdescription') || nm.includes('workdescription')) return { kind: 'textarea', el: ta, anchor: ta };
    }

    const cke = doc.getElementById('cke_workdescription');
    if (cke) return { kind: 'ckeditor', el: null, anchor: cke };

    // last resort: any contenteditable that looks like workdescription
    const allCE = Array.from(doc.querySelectorAll('[contenteditable="true"]'));
    for (const ce of allCE) {
      const id = (ce.id || '').toLowerCase();
      if (id.includes('workdescription')) return { kind: 'contenteditable', el: ce, anchor: ce };
    }
    return null;
  }

  function setWorkDescOverwrite(workDescInfo, text) {
    const value = text || '';

    // CKEditor instance if present
    if (window.CKEDITOR && CKEDITOR.instances && CKEDITOR.instances.workdescription) {
      try {
        CKEDITOR.instances.workdescription.setData(value);
        CKEDITOR.instances.workdescription.updateElement();
        return true;
      } catch (e) {
        console.log('[SSR] CKEditor setData failed:', e);
      }
    }

    // normal textarea
    if (workDescInfo && workDescInfo.el && workDescInfo.el.tagName && workDescInfo.el.tagName.toLowerCase() === 'textarea') {
      const ta = workDescInfo.el;
      ta.value = value;
      try { ta.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      ta.style.backgroundColor = '#ffffcc';
      setTimeout(() => { ta.style.backgroundColor = ''; }, 800);
      return true;
    }

    // contenteditable fallback
    if (workDescInfo && workDescInfo.kind === 'contenteditable' && workDescInfo.el) {
      workDescInfo.el.textContent = value;
      return true;
    }

    alert('Workdescription veld niet gevonden.');
    return false;
  }

  // ====== DEVICE DETECTION ======
  function findToestelLegend(doc) {
    const fs = doc.getElementById('fieldset_toestel');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) return lg;
    }

    // avoid CSS4 case-insensitive; iterate
    const fieldsets = Array.from(doc.querySelectorAll('fieldset'));
    for (const f of fieldsets) {
      const id = (f.id || '').toLowerCase();
      if (id.includes('toestel')) {
        const lg = f.querySelector('legend');
        if (lg) return lg;
      }
    }

    const legends = Array.from(doc.querySelectorAll('legend'));
    return legends.find(l => /toestel/i.test(normText(l.textContent))) || null;
  }

  function detectDeviceInfo(doc) {
    const info = { brand: null, deviceType: null, rawLegend: null, rawType: null, magnetronMode: null };

    const legendEl = findToestelLegend(doc);
    if (!legendEl) { info.deviceType = 'Unknown'; return info; }

    const raw = normText(legendEl.textContent);
    info.rawLegend = raw;

    let text = raw.replace(/^Toestel\s*/i, '').trim();
    if (!text) { info.deviceType = 'Unknown'; return info; }

    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length) { info.deviceType = 'Unknown'; return info; }

    let brandTokens = 1;
    let brandGuess = tokens[0];

    const firstLower = (tokens[0] || '').toLowerCase();
    const secondLower = (tokens[1] || '').toLowerCase();
    if (firstLower === 'harman' && secondLower === 'kardon') { brandGuess = tokens[0] + ' ' + tokens[1]; brandTokens = 2; }

    const bl = brandGuess.toLowerCase();
    if (bl === 'samsung') info.brand = 'Samsung';
    else if (bl === 'sharp') info.brand = 'Sharp';
    else if (bl === 'tcl') info.brand = 'TCL';
    else if (bl === 'lg') info.brand = 'LG';
    else if (bl === 'philips') info.brand = 'Philips';
    else if (bl === 'toshiba') info.brand = 'Toshiba';
    else if (bl === 'jbl') info.brand = 'JBL';
    else if (bl === 'panasonic') info.brand = 'Panasonic';
    else if (bl === 'harmankard' || bl === 'harman') info.brand = 'Harman Kardon';
    else info.brand = brandGuess;

    const typeTokens = tokens.slice(brandTokens);
    const typeText = typeTokens.join(' ').trim();
    info.rawType = typeText;

    const lt = typeText.toLowerCase();

    if (/\btv\b/.test(lt) || lt.includes('tv/monitor') || lt.includes('monitor')) info.deviceType = 'TV';
    else if (lt.includes('soundbar')) info.deviceType = 'Soundbar';
    else if (lt.includes('stofzuiger')) info.deviceType = 'Stofzuiger';
    else if (lt.includes('magnetron')) {
      info.deviceType = 'Magnetron';
      if (lt.includes('solo')) info.magnetronMode = 'Solo';
      else if (lt.includes('combi')) info.magnetronMode = 'Combi';
    } else if (lt.includes('broodbakker')) info.deviceType = 'Broodbakker';
    else info.deviceType = 'Unknown';

    return info;
  }

  function getCaseNumber(doc) {
    try {
      const u = new URL(window.location.href);
      const id = u.searchParams.get('item_id') || u.searchParams.get('caseid') || u.searchParams.get('order');
      if (id) return String(id).trim();
    } catch (e) {}

    const m2 = (doc && doc.body ? doc.body.textContent : '').match(/\b\d{5,}\b/);
    return m2 ? String(m2[0]).trim() : null;
  }

  function getCaseKey(doc) {
    const id = getCaseNumber(doc);
    if (id) return id;
    // fallback (still unique-ish)
    return 'url:' + location.pathname + location.search;
  }

  function getDealerName(doc) {
    const dealerLink1 = doc.querySelector('legend.cec-legend-strong a[href*="neworder3.aspx"]');
    if (dealerLink1) return normText(dealerLink1.textContent || '');
    const dealerLink2 = doc.querySelector('a[href*="neworder3.aspx"]');
    if (dealerLink2) return normText(dealerLink2.textContent || '');
    return null;
  }

  function isSpecialDealer(doc) {
    const name = getDealerName(doc);
    if (!name) return false;
    const dn = name.toLowerCase();
    return dn === 'coolblue b.v.' || dn === 'z.e.s. goes b.v.';
  }

  function getModelCode(doc) {
    const modelInput = doc.getElementById('modelcode');
    return modelInput ? (modelInput.value || '').trim() : '';
  }

  // ====== STORAGE ======
  function safeParseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  function loadAllCases() {
    return safe(() => {
      const raw = localStorage.getItem(STORAGE_KEY);
      const obj = safeParseJson(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    }, 'loadAllCases') || {};
  }

  function saveAllCases(obj) {
    return safe(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj || {}));
      return true;
    }, 'saveAllCases') || false;
  }

  function loadCaseRecord(caseKey) {
    const all = loadAllCases();
    return (caseKey && all[caseKey]) ? all[caseKey] : null;
  }

  function upsertCaseRecord(caseKey, record) {
    const all = loadAllCases();
    all[caseKey] = record;
    return saveAllCases(all);
  }

  function deleteCaseRecord(caseKey) {
    const all = loadAllCases();
    if (all[caseKey]) delete all[caseKey];
    return saveAllCases(all);
  }

  function scheduleAutosaveDraft(doc, deviceInfo) {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      saveDraft(doc, deviceInfo);
    }, 220);
  }

  function saveDraft(doc, deviceInfo) {
    const caseKey = getCaseKey(doc);
    const prev = loadCaseRecord(caseKey) || {};
    const rec = {
      caseKey,
      isFinal: !!prev.isFinal,
      deviceType: deviceInfo && deviceInfo.deviceType ? deviceInfo.deviceType : (prev.deviceType || null),
      brand: deviceInfo && deviceInfo.brand ? deviceInfo.brand : (prev.brand || null),
      rawType: deviceInfo && deviceInfo.rawType ? deviceInfo.rawType : (prev.rawType || null),
      magnetronMode: deviceInfo && deviceInfo.magnetronMode ? deviceInfo.magnetronMode : (prev.magnetronMode || null),
      model: getModelCode(doc) || prev.model || '',
      language: currentLanguage || 'NL',
      updatedAt: nowIso(),
      createdAt: prev.createdAt || nowIso(),
      state: state,
      currentStep: currentStep,
      reportText: prev.reportText || '',
      emailText: prev.emailText || ''
    };
    upsertCaseRecord(caseKey, rec);
  }

  function saveFinal(doc, deviceInfo, reportText, emailText) {
    const caseKey = getCaseKey(doc);
    const prev = loadCaseRecord(caseKey) || {};
    const rec = {
      caseKey,
      isFinal: true,
      deviceType: deviceInfo && deviceInfo.deviceType ? deviceInfo.deviceType : (prev.deviceType || null),
      brand: deviceInfo && deviceInfo.brand ? deviceInfo.brand : (prev.brand || null),
      rawType: deviceInfo && deviceInfo.rawType ? deviceInfo.rawType : (prev.rawType || null),
      magnetronMode: deviceInfo && deviceInfo.magnetronMode ? deviceInfo.magnetronMode : (prev.magnetronMode || null),
      model: getModelCode(doc) || prev.model || '',
      language: currentLanguage || 'NL',
      updatedAt: nowIso(),
      createdAt: prev.createdAt || nowIso(),
      state: state,
      currentStep: currentStep,
      reportText: reportText || '',
      emailText: emailText || ''
    };
    upsertCaseRecord(caseKey, rec);
    return rec;
  }

  // ====== CSS ======
  function injectStyles(doc) {
    if (doc.getElementById('ssr_styles')) return;
    const style = doc.createElement('style');
    style.id = 'ssr_styles';
    style.textContent = `
#ssr_container{margin-top:10px;padding:10px;border:2px solid #000;background:#fff3cd;font-size:12px;font-family:inherit;box-shadow:0 0 5px rgba(0,0,0,0.2);}
#ssr_container h3{margin:0 0 6px 0;font-size:14px;font-weight:900;color:#b00000;text-transform:uppercase;}
#ssr_title_text{margin-right:6px;}
#ssr_admin_toggle{display:inline-block;margin-left:4px;padding:0 4px;font-size:10px;font-weight:bold;border:1px solid #999;border-radius:3px;cursor:pointer;background:#f0f0f0;color:#333;}
#ssr_admin_toggle.ssr-admin-active{background:#007bff;color:#fff;border-color:#007bff;}
.ssr-settings-icon{display:inline-block;margin-left:4px;font-size:11px;cursor:pointer;}
.ssr-history-icon{display:inline-block;margin-left:6px;font-size:12px;cursor:pointer;}
.ssr-warning{font-size:12px;font-weight:bold;color:#b00000;margin-bottom:6px;animation:ssr-blink 1s step-start infinite;}
@keyframes ssr-blink{50%{opacity:0;}}
#ssr_device_debug{display:none;font-size:11px;margin-bottom:6px;}
#ssr_device_info_line{margin-top:2px;}
.ssr-admin-only{display:none;}
.ssr-step{display:none;margin-bottom:8px;}
.ssr-step.active{display:block;}
.ssr-question{font-weight:bold;margin-bottom:4px;}
.ssr-buttons{margin-bottom:4px;}
.ssr-btn-choice{border:1px solid #999;background:#eee;padding:2px 8px;margin-right:4px;cursor:pointer;border-radius:3px;font-size:12px;}
.ssr-btn-choice.ssr-active{background:#007bff;color:#fff;border-color:#007bff;}
.ssr-multi-option{margin-right:10px;}
.ssr-nav{margin:8px 0;}
.ssr-nav button{border:1px solid #999;background:#e0e0e0;padding:3px 8px;margin-right:4px;border-radius:3px;cursor:pointer;font-size:12px;}
#ssr_output{width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;margin-top:4px;}
.ssr-success{padding:10px;background:#d4edda;border:2px solid #155724;color:#155724;font-weight:bold;font-size:13px;}
.ssr-success-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.ssr-success-actions button{border:1px solid #155724;background:#fff;color:#155724;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;margin-right:4px;margin-top:4px;}
.ssr-success-actions button:hover{background:#c3e6cb;}
.ssr-success-note{margin-top:6px;font-size:11px;font-weight:normal;}
.ssr-placeholder-main{margin-top:6px;padding:6px;background:#fffbe6;border:1px dashed #d39e00;}
.ssr-placeholder-main button{border:1px solid #d39e00;background:#fff;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;}
.ssr-placeholder-main button:hover{background:#ffe8a1;}
.ssr-photo-note{display:none;font-size:11px;color:#b00000;margin-top:4px;}
.ssr-photo-note.ssr-blink{animation:ssr-blink 1s step-start infinite;}

#ssr_modal_overlay{position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.45);z-index:999999;display:flex;align-items:center;justify-content:center;}
#ssr_modal{width:min(980px,95vw);max-height:90vh;overflow:auto;background:#fff;border:2px solid #000;padding:10px;box-shadow:0 0 12px rgba(0,0,0,0.35);font-family:inherit;font-size:12px;}
#ssr_modal h4{margin:0 0 8px 0;font-size:14px;font-weight:900;}
.ssr-modal-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.ssr-modal-row{border-top:1px solid #ddd;padding:8px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.ssr-modal-meta{font-size:11px;color:#444;}
.ssr-modal-actions button{border:1px solid #999;background:#eee;padding:2px 8px;margin-right:4px;border-radius:3px;cursor:pointer;font-size:12px;}
.ssr-modal-actions button:hover{background:#e0e0e0;}
#ssr_modal textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:11px;}
    `;
    doc.head.appendChild(style);
  }

  // ====== COMMON HEADER HTML ======
  function headerHtml(title) {
    return `
<h3>
  <span id="ssr_title_text">${escapeHtml(title)}</span>
  <span id="ssr_admin_toggle" title="Admin">A</span>
  <span id="ssr_settings_toggle" class="ssr-settings-icon" title="Instellingen / Settings">⚙</span>
  <span id="ssr_history_toggle" class="ssr-history-icon" title="Historie / History">🗂</span>
</h3>`;
  }

  function deviceDebugHtml(info) {
    const brand = info.brand || '(onbekend merk)';
    const type = info.deviceType || '(onbekend type)';
    const rawType = info.rawType || '';
    const extra = info.magnetronMode ? ' (' + info.magnetronMode + ')' : '';
    return `
<div id="ssr_device_debug" class="ssr-admin-only">
  <label><input type="checkbox" id="ssr_hide_device_info"> Toestel/merk info verbergen</label>
  <div id="ssr_device_info_line">
    Gedetecteerd toestel: <b>${escapeHtml(brand)}</b> – <b>${escapeHtml(type + extra)}</b> ${rawType ? '(ruwe type-tekst: ' + escapeHtml(rawType) + ')' : ''}
  </div>
</div>`;
  }

  // ====== DEVICE HTML (from your 1.14.1, only header/history added) ======
  function createMagnetronHTML(info) {
    const brand = info.brand || '(onbekend merk)';
    const type = info.deviceType || '(onbekend type)';
    const extra = info.magnetronMode ? ' (' + info.magnetronMode + ')' : '';
    const rawType = info.rawType || '';

    return `
${headerHtml('Screening servicerapport VERPLICHT')}
<div id="ssr_warning" class="ssr-warning">Servicerapport nog niet ingevuld</div>

${deviceDebugHtml(info)}

<div id="ssr_steps">
  <div class="ssr-step ssr-step-1 active" data-step="1">
    <div class="ssr-question" id="ssr_q1">1. Is het toestel beschadigd (zichtbare transportschade / behuizingsschade)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-2" data-step="2">
    <div class="ssr-question" id="ssr_q2">2. Zijn er foto's van de schade gemaakt en bij "Bijlagen" toegevoegd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="photos" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="photos" data-val="nee">Nee</button>
    </div>
    <div id="ssr_photos_note" class="ssr-photo-note">Foto's van de schade ontbreken, graag toevoegen bij "Bijlagen".</div>

    <div id="ssr_magn_damage_parts" style="margin-top:6px;">
      <div class="ssr-question" id="ssr_magn_damage_label">Indien ja: selecteer de onderdelen waarop de schade betrekking heeft:</div>
      <label class="ssr-multi-option"><input type="checkbox" data-part="behuizing"> Behuizing</label>
      <label class="ssr-multi-option"><input type="checkbox" data-part="bodemplaat"> Bodemplaat</label>
      <label class="ssr-multi-option"><input type="checkbox" data-part="deur"> Deur</label>
    </div>
  </div>

  <div class="ssr-step ssr-step-3" data-step="3">
    <div class="ssr-question" id="ssr_q3">3. Is de technische klacht, zoals door de klant omschreven, geconstateerd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-4" data-step="4">
    <div class="ssr-question" id="ssr_q4">4. Is het toestel NDF (No fault found)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-5" data-step="5">
    <div class="ssr-question" id="ssr_q5">5. Zijn alle vragen voor het servicerapport ingevuld en is de tekst correct voor dit geval?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="nee">Nee</button>
    </div>
  </div>
</div>

<div class="ssr-nav">
  <button type="button" id="ssr_prev">← Vorige</button>
  <button type="button" id="ssr_next">Volgende →</button>
  <button type="button" id="ssr_generate" class="ssr-admin-only">Rapport genereren</button>
</div>

<label for="ssr_output" id="ssr_output_label"><b>Screening servicerapport (resultaat):</b></label>
<textarea id="ssr_output" rows="4" placeholder="Hier verschijnt het automatisch gegenereerde rapport..."></textarea>
    `;
  }

  function createStofzuigerHTML(info) {
    return `
${headerHtml('Screening servicerapport VERPLICHT')}
<div id="ssr_warning" class="ssr-warning">Servicerapport nog niet ingevuld</div>
${deviceDebugHtml(info)}

<div id="ssr_steps">

  <div class="ssr-step ssr-step-1 active" data-step="1">
    <div class="ssr-question" id="ssr_q1">
      1. Zijn het toestel en de accessoires visueel in orde? Zijn er cosmetische beschadigingen bij ontvangst?
    </div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="ja">Ja, cosmetische schade aanwezig</button>
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="nee">Nee, geen cosmetische schade</button>
    </div>
    <div id="ssr_stof_cosmetic_info" class="ssr-admin-only" style="font-size:11px;">
      Bij <b>Ja</b> wordt in het rapport vermeld dat er cosmetische schade is en dat hiervoor een prijsopgave wordt opgesteld.
      De technische klacht wordt wel beoordeeld en indien van toepassing onder garantie opgelost.
    </div>

    <div id="ssr_stof_photos_block" style="margin-top:6px; display:none;">
      <div class="ssr-question" id="ssr_q1b">Zijn er foto's van de schade gemaakt en bij "Bijlagen" toegevoegd?</div>
      <div class="ssr-buttons">
        <button type="button" class="ssr-btn-choice" data-q="photos" data-val="ja">Ja</button>
        <button type="button" class="ssr-btn-choice" data-q="photos" data-val="nee">Nee</button>
      </div>
      <div id="ssr_photos_note" class="ssr-photo-note">Foto's van de schade ontbreken, graag toevoegen bij "Bijlagen".</div>
    </div>
  </div>

  <div class="ssr-step ssr-step-2" data-step="2">
    <div class="ssr-question" id="ssr_q2">2. Zijn de filters van het toestel en/of het laadstation schoon en goed onderhouden?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="stofFiltersClean" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="stofFiltersClean" data-val="nee">Nee</button>
    </div>

    <div id="ssr_stof_filters_details" style="margin-top:4px; display:none;">
      <div class="ssr-question" id="ssr_stof_filter_label">Indien Nee: welke filters zijn vervuild en moeten worden vervangen?</div>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-filter="ring"> RING-filter</label>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-filter="micro"> Microfilter</label>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-filter="base"> Filter basestation</label>
      <div style="margin-top:4px;font-size:11px;">Anders filter: <input type="text" id="ssr_stof_filter_other" style="width:160px;font-size:11px;"></div>
    </div>
  </div>

  <div class="ssr-step ssr-step-3" data-step="3">
    <div class="ssr-question" id="ssr_q3">3. Werkt de motor van het toestel?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="stofMotorWorks" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="stofMotorWorks" data-val="nee">Nee</button>
    </div>
    <div id="ssr_stof_motor_info" style="font-size:11px;">Bij Nee wordt vermeld dat de motor vervangen moet worden.</div>
  </div>

  <div class="ssr-step ssr-step-4" data-step="4">
    <div class="ssr-question" id="ssr_q4">
      4. Indien de motor niet werkt: is het motordefect ontstaan door gebruik/onderhoud door de klant
      (bijv. (was)poeder, verstoppingen, onvoldoende onderhoud)?
    </div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="stofMotorCauseUser" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="stofMotorCauseUser" data-val="nee">Nee</button>
    </div>

    <div id="ssr_stof_motor_reason_details" style="margin-top:4px; display:none;">
      <div class="ssr-question" id="ssr_stof_motor_cause_label" style="font-weight:normal;">
        Indien Ja: wat is de meest waarschijnlijke oorzaak van het motordefect?
      </div>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-motor-reason="powder"> (Was)poeder / vloeistoffen in toestel</label>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-motor-reason="fineDust"> Fijne stof / bouwstof / fijn vuil</label>
      <label class="ssr-multi-option"><input type="checkbox" data-stof-motor-reason="dirtyFilters"> Sterk vervuilde / verstopte filters</label>
      <div style="margin-top:4px;font-size:11px;">Anders oorzaak: <input type="text" id="ssr_stof_motor_other" style="width:180px;font-size:11px;"></div>
    </div>
  </div>

  <div class="ssr-step ssr-step-5" data-step="5">
    <div class="ssr-question" id="ssr_q5">5. Is de technische klacht, zoals door de klant omschreven, geconstateerd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-6" data-step="6">
    <div class="ssr-question" id="ssr_q6">6. Is het toestel NDF (No fault found)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-7" data-step="7">
    <div class="ssr-question" id="ssr_q7">7. Zijn alle vragen voor het servicerapport ingevuld en is de tekst correct voor dit geval?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="nee">Nee</button>
    </div>
  </div>

</div>

<div class="ssr-nav">
  <button type="button" id="ssr_prev">← Vorige</button>
  <button type="button" id="ssr_next">Volgende →</button>
  <button type="button" id="ssr_generate" class="ssr-admin-only">Rapport genereren</button>
</div>

<label for="ssr_output" id="ssr_output_label"><b>Screening servicerapport (resultaat):</b></label>
<textarea id="ssr_output" rows="4" placeholder="Hier verschijnt het automatisch gegenereerde rapport..."></textarea>
    `;
  }

  function createSoundbarHTML(info) {
    return `
${headerHtml('Screening servicerapport VERPLICHT')}
<div id="ssr_warning" class="ssr-warning">Servicerapport nog niet ingevuld</div>
${deviceDebugHtml(info)}

<div id="ssr_steps">

  <div class="ssr-step ssr-step-1 active" data-step="1">
    <div class="ssr-question" id="ssr_q1">
      1. Zijn de soundbar en accessoires visueel in orde? Zijn er cosmetische beschadigingen bij ontvangst?
    </div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="ja">Ja, cosmetische schade aanwezig</button>
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="nee">Nee, geen cosmetische schade</button>
    </div>
    <div id="ssr_sb_cosmetic_info" class="ssr-admin-only" style="font-size:11px;">
      Bij <b>Ja</b> wordt in het rapport vermeld dat er cosmetische schade is en dat hiervoor een prijsopgave wordt opgesteld.
      De technische klacht wordt wel beoordeeld en indien van toepassing onder garantie opgelost.
    </div>

    <div id="ssr_sb_photos_block" style="margin-top:6px; display:none;">
      <div class="ssr-question" id="ssr_q1b">Zijn er foto's van de schade gemaakt en bij "Bijlagen" toegevoegd?</div>
      <div class="ssr-buttons">
        <button type="button" class="ssr-btn-choice" data-q="photos" data-val="ja">Ja</button>
        <button type="button" class="ssr-btn-choice" data-q="photos" data-val="nee">Nee</button>
      </div>
      <div id="ssr_photos_note" class="ssr-photo-note">Foto's van de schade ontbreken, graag toevoegen bij "Bijlagen".</div>
    </div>
  </div>

  <div class="ssr-step ssr-step-2" data-step="2">
    <div class="ssr-question" id="ssr_q2">2. Indien cosmetische schade: welke onderdelen zijn beschadigd?</div>
    <label class="ssr-multi-option"><input type="checkbox" data-sb-part="top"> Soundbar top case</label>
    <label class="ssr-multi-option"><input type="checkbox" data-sb-part="bottom"> Soundbar bottom case</label>
    <label class="ssr-multi-option"><input type="checkbox" data-sb-part="sub"> Subwoofer</label>
    <label class="ssr-multi-option"><input type="checkbox" data-sb-part="other"> Anders (overige cosmetische schade)</label>
    <div style="margin-top:4px;font-size:11px;">Toelichting "anders": <input type="text" id="ssr_sb_other_text" style="width:180px;font-size:11px;"></div>
    <div id="ssr_sb_note" style="font-size:11px;margin-top:4px;">De geselecteerde onderdelen worden in het servicerapport genoemd.</div>
  </div>

  <div class="ssr-step ssr-step-3" data-step="3">
    <div class="ssr-question" id="ssr_q3">3. Is de technische klacht, zoals door de klant omschreven, geconstateerd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-4" data-step="4">
    <div class="ssr-question" id="ssr_q4">4. Is het toestel NDF (No fault found)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-5" data-step="5">
    <div class="ssr-question" id="ssr_q5">5. Zijn alle vragen voor het servicerapport ingevuld en is de tekst correct voor dit geval?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="nee">Nee</button>
    </div>
  </div>

</div>

<div class="ssr-nav">
  <button type="button" id="ssr_prev">← Vorige</button>
  <button type="button" id="ssr_next">Volgende →</button>
  <button type="button" id="ssr_generate" class="ssr-admin-only">Rapport genereren</button>
</div>

<label for="ssr_output" id="ssr_output_label"><b>Screening servicerapport (resultaat):</b></label>
<textarea id="ssr_output" rows="4" placeholder="Hier verschijnt het automatisch gegenereerde rapport..."></textarea>
    `;
  }

  function createTVHTML(info) {
    return `
${headerHtml('Screening servicerapport VERPLICHT')}
<div id="ssr_warning" class="ssr-warning">Servicerapport nog niet ingevuld</div>
${deviceDebugHtml(info)}

<div id="ssr_steps">

  <div class="ssr-step ssr-step-1 active" data-step="1">
    <div class="ssr-question" id="ssr_q1">1. Is het toestel (TV) beschadigd (zichtbare transportschade / scherm- of behuizingsschade)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="damaged" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-2" data-step="2">
    <div class="ssr-question" id="ssr_q2">2. Zijn er foto's van de schade gemaakt en bij "Bijlagen" toegevoegd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="photos" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="photos" data-val="nee">Nee</button>
    </div>
    <div id="ssr_photos_note" class="ssr-photo-note">Foto's van de schade ontbreken, graag toevoegen bij "Bijlagen".</div>
  </div>

  <div class="ssr-step ssr-step-3" data-step="3">
    <div class="ssr-question" id="ssr_q3">3. Is de technische klacht, zoals door de klant omschreven, geconstateerd?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="techComplaint" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-4" data-step="4">
    <div class="ssr-question" id="ssr_q4">4. Is het toestel NDF (No fault found)?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="ndf" data-val="nee">Nee</button>
    </div>
  </div>

  <div class="ssr-step ssr-step-5" data-step="5">
    <div class="ssr-question" id="ssr_q5">5. Zijn alle vragen voor het servicerapport ingevuld en is de tekst correct voor dit geval?</div>
    <div class="ssr-buttons">
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="ja">Ja</button>
      <button type="button" class="ssr-btn-choice" data-q="finalConfirm" data-val="nee">Nee</button>
    </div>
  </div>

</div>

<div class="ssr-nav">
  <button type="button" id="ssr_prev">← Vorige</button>
  <button type="button" id="ssr_next">Volgende →</button>
  <button type="button" id="ssr_generate" class="ssr-admin-only">Rapport genereren</button>
</div>

<label for="ssr_output" id="ssr_output_label"><b>Screening servicerapport (resultaat):</b></label>
<textarea id="ssr_output" rows="4" placeholder="Hier verschijnt het automatisch gegenereerde rapport..."></textarea>
    `;
  }

  function createPlaceholderHTML(info) {
    const type = info.deviceType || '(onbekend type)';
    return `
${headerHtml('Screening servicerapport')}
${deviceDebugHtml(info)}
<div class="ssr-placeholder-main">
  <p id="ssr_placeholder_p1"><b style="color:#b00000;">Het genereren van een servicerapport voor dit toesteltype is nog in ontwikkeling.</b></p>
  <p id="ssr_placeholder_type_line">Type: <b>${escapeHtml(type)}</b>. U kunt de standaard werkwijze volgen en de Workdescription handmatig invullen.</p>
  <button type="button" id="ssr_request_form_btn">Formulier voor dit toesteltype aanvragen</button>
  <p id="ssr_placeholder_p2" style="font-size:11px;margin-top:4px;">Bij klikken wordt een e-mail voor de ontwikkelaar klaargezet met ordernummer, model en toestelinformatie.</p>
</div>
    `;
  }

  // ====== ADMIN / SETTINGS / HISTORY ======
  function attachDeviceDebugLogic(container) {
    const cb = container.querySelector('#ssr_hide_device_info');
    const line = container.querySelector('#ssr_device_info_line');
    if (!cb || !line) return;
    cb.addEventListener('change', () => { line.style.display = cb.checked ? 'none' : ''; });
  }

  function showAdminElements(container) {
    container.querySelectorAll('.ssr-admin-only').forEach(el => { el.style.display = (el.tagName.toLowerCase() === 'button' ? 'inline-block' : 'block'); });
    const dbg = container.querySelector('#ssr_device_debug');
    if (dbg) dbg.style.display = 'block';
  }

  function hideAdminElements(container) {
    container.querySelectorAll('.ssr-admin-only').forEach(el => { el.style.display = 'none'; });
    const dbg = container.querySelector('#ssr_device_debug');
    if (dbg) dbg.style.display = 'none';
  }

  function attachAdminLogic(container) {
    const toggle = container.querySelector('#ssr_admin_toggle');
    if (!toggle) return;

    if (isAdmin) { toggle.classList.add('ssr-admin-active'); showAdminElements(container); }
    else { toggle.classList.remove('ssr-admin-active'); hideAdminElements(container); }

    toggle.addEventListener('click', () => {
      if (!isAdmin) {
        const pw = prompt('Voer admin-wachtwoord in:');
        if (pw === null) return;
        if (pw === 'NodeRED') {
          isAdmin = true;
          toggle.classList.add('ssr-admin-active');
          showAdminElements(container);
        } else alert('Ongeldig wachtwoord.');
      } else {
        isAdmin = false;
        toggle.classList.remove('ssr-admin-active');
        hideAdminElements(container);
      }
    });
  }

  function attachSettingsLogic(container, deviceInfo) {
    const gear = container.querySelector('#ssr_settings_toggle');
    if (!gear) return;
    gear.addEventListener('click', () => {
      const lang = prompt('Kies taal / Choose language: NL of EN', currentLanguage);
      if (!lang) return;
      const up = lang.toUpperCase().trim();
      if (up !== 'NL' && up !== 'EN') return alert('Ongeldige taal. Gebruik "NL" of "EN".');
      currentLanguage = up;
      try { localStorage.setItem('ssr_language', currentLanguage); } catch (e) {}
      applyLanguage(container, deviceInfo);
      scheduleAutosaveDraft(document, currentDeviceInfo);
    });
  }

  // ====== HISTORY MODAL ======
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function openHistoryModal(doc, currentCaseKey, workDescInfo) {
    const existing = doc.getElementById('ssr_modal_overlay');
    if (existing) existing.remove();

    const overlay = doc.createElement('div');
    overlay.id = 'ssr_modal_overlay';
    const modal = doc.createElement('div');
    modal.id = 'ssr_modal';

    const all = loadAllCases();
    const list = Object.values(all || {});
    list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    const header = doc.createElement('div');
    header.className = 'ssr-modal-top';
    header.innerHTML = `
      <h4>SSR Historie / Saved cases</h4>
      <div>
        <button type="button" id="ssr_hist_export_all">Export JSON</button>
        <button type="button" id="ssr_hist_import_btn">Import JSON</button>
        <input type="file" id="ssr_hist_import_file" accept="application/json" style="display:none;">
        <button type="button" id="ssr_hist_close">Close</button>
      </div>
    `;
    modal.appendChild(header);

    const meta = doc.createElement('div');
    meta.className = 'ssr-modal-meta';
    meta.textContent = 'Total saved: ' + list.length + ' | Storage key: ' + STORAGE_KEY;
    modal.appendChild(meta);

    const body = doc.createElement('div');

    if (list.length === 0) {
      body.innerHTML = '<div class="ssr-modal-row"><div>No saved cases yet.</div></div>';
    } else {
      list.forEach((rec) => {
        const row = doc.createElement('div');
        row.className = 'ssr-modal-row';

        const left = doc.createElement('div');
        const isFinalTxt = rec.isFinal ? 'FINAL' : 'DRAFT';
        left.innerHTML = `
          <div><b>Case:</b> ${escapeHtml(rec.caseKey || '')} <span style="margin-left:8px; font-weight:bold;">${isFinalTxt}</span></div>
          <div class="ssr-modal-meta">
            ${escapeHtml(rec.deviceType || 'Unknown')} | ${escapeHtml(rec.brand || '')} | model: ${escapeHtml(rec.model || '')}
            <br>updated: ${escapeHtml(rec.updatedAt || '')}
          </div>
        `;

        const actions = doc.createElement('div');
        actions.className = 'ssr-modal-actions';
        actions.innerHTML = `
          <button type="button" data-act="load">Load</button>
          <button type="button" data-act="copy_report">Copy report</button>
          <button type="button" data-act="copy_email">Copy email</button>
          <button type="button" data-act="export_one">Export</button>
          <button type="button" data-act="delete">Delete</button>
        `;

        // hide copy_email when not admin
        if (!isAdmin) {
          const ce = actions.querySelector('button[data-act="copy_email"]');
          if (ce) ce.style.display = 'none';
        }

        actions.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest('button');
          if (!btn) return;
          const act = btn.getAttribute('data-act');

          if (act === 'load') {
            if (String(rec.caseKey) !== String(currentCaseKey)) {
              alert('This saved record belongs to another case. Open that case page to load it.');
              return;
            }
            overlay.remove();
            // load record into current page
            state = mergeState(rec.state);
            currentStep = rec.currentStep || 1;
            lastEmailText = rec.emailText || '';
            if (rec.isFinal) renderFinalCard(doc, rec, workDescInfo, currentDeviceInfo);
            else {
              renderQuestionnaire(doc, workDescInfo, currentDeviceInfo);
              hydrateUIFromState(doc.getElementById('ssr_container'), currentDeviceInfo.deviceType);
            }
          }

          if (act === 'copy_report') {
            copyToClipboard(rec.reportText || '');
            alert('Report copied.');
          }

          if (act === 'copy_email') {
            if (!isAdmin) return;
            copyToClipboard(rec.emailText || '');
            alert('Email copied.');
          }

          if (act === 'export_one') {
            downloadJson('ssr_case_' + String(rec.caseKey).replace(/[^a-z0-9_-]+/gi, '_') + '.json', rec);
          }

          if (act === 'delete') {
            if (!confirm('Delete saved case ' + rec.caseKey + '?')) return;
            deleteCaseRecord(rec.caseKey);
            overlay.remove();
            openHistoryModal(doc, currentCaseKey, workDescInfo);
          }
        });

        row.appendChild(left);
        row.appendChild(actions);
        body.appendChild(row);
      });
    }

    modal.appendChild(body);

    // admin-only: clear all
    if (isAdmin) {
      const adminRow = doc.createElement('div');
      adminRow.className = 'ssr-modal-row';
      adminRow.innerHTML = `
        <div class="ssr-modal-meta"><b>Admin tools:</b> clear all local saved cases</div>
        <div class="ssr-modal-actions"><button type="button" id="ssr_hist_clear_all">Clear ALL</button></div>
      `;
      modal.appendChild(adminRow);

      adminRow.querySelector('#ssr_hist_clear_all').addEventListener('click', () => {
        if (!confirm('CLEAR ALL saved SSR cases from localStorage?')) return;
        saveAllCases({});
        overlay.remove();
        openHistoryModal(doc, currentCaseKey, workDescInfo);
      });
    }

    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

    // close handlers
    modal.querySelector('#ssr_hist_close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // export all
    modal.querySelector('#ssr_hist_export_all').addEventListener('click', () => {
      const obj = loadAllCases();
      downloadJson('ssr_cases_export.json', obj);
    });

    // import
    const importBtn = modal.querySelector('#ssr_hist_import_btn');
    const importFile = modal.querySelector('#ssr_hist_import_file');
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      const f = importFile.files && importFile.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = safeParseJson(reader.result);
        if (!parsed || typeof parsed !== 'object') return alert('Invalid JSON.');
        // accept either: full export object {caseKey: rec} OR single record {caseKey,...}
        const current = loadAllCases();
        if (parsed.caseKey) {
          current[parsed.caseKey] = parsed;
        } else {
          Object.keys(parsed).forEach(k => { current[k] = parsed[k]; });
        }
        saveAllCases(current);
        overlay.remove();
        openHistoryModal(doc, currentCaseKey, workDescInfo);
      };
      reader.readAsText(f);
    });
  }

  function attachHistoryLogic(container, doc, workDescInfo) {
    const hist = container.querySelector('#ssr_history_toggle');
    if (!hist) return;
    hist.addEventListener('click', () => {
      openHistoryModal(doc, getCaseKey(doc), workDescInfo);
    });
  }

  function attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo) {
    attachAdminLogic(container);
    attachSettingsLogic(container, deviceInfo);
    attachHistoryLogic(container, doc, workDescInfo);
    attachDeviceDebugLogic(container);
    applyLanguage(container, deviceInfo);
  }

  // ====== CLIPBOARD / EMAIL HELPERS ======
  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const tmp = document.createElement('textarea');
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); } catch (e) {}
      tmp.remove();
    }
  }

  function buildEmailText(reportText, deviceInfo, doc) {
    const caseNumber = getCaseNumber(doc);
    const model = getModelCode(doc);
    const brand = deviceInfo && deviceInfo.brand ? deviceInfo.brand : '';
    const type = deviceInfo && (deviceInfo.rawType || deviceInfo.deviceType) || '';

    const lines = [];
    lines.push('Geachte klant,');
    lines.push('');
    lines.push('Wij hebben uw toestel getest en gescreend. Hieronder vindt u ons service-screeningrapport:');
    lines.push('');
    if (brand || model || type) {
      lines.push(['Merk: ' + (brand || 'onbekend'), 'Type: ' + (type || 'onbekend'), 'Model: ' + (model || 'onbekend')].join(' | '));
      lines.push('');
    }
    lines.push(reportText);
    if (caseNumber) { lines.push(''); lines.push('Order-/casenummer: ' + caseNumber); }
    lines.push('');
    lines.push('Met vriendelijke groet,');
    lines.push('C.E. Repair');
    return lines.join('\n');
  }

  // ====== PHOTO NOTE BLINK / VALIDATION ======
  function blinkPhotosNote(container) {
    const note = container.querySelector('#ssr_photos_note');
    if (!note) return;
    note.style.display = 'block';
    note.classList.add('ssr-blink');
    setTimeout(() => note.classList.remove('ssr-blink'), 1600);
  }

  function hidePhotosNote(container) {
    const note = container.querySelector('#ssr_photos_note');
    if (!note) return;
    note.style.display = 'none';
    note.classList.remove('ssr-blink');
  }

  function validateBeforeNext(container, dt) {
    // common checks: require answers per step
    if (dt === 'Magnetron' || dt === 'TV') {
      if (currentStep === 1) {
        if (state.damaged !== 'ja' && state.damaged !== 'nee') return false;
      }
      if (currentStep === 2) {
        // only relevant when damaged=yes
        if (state.damaged === 'ja' && state.photos !== 'ja') { blinkPhotosNote(container); return false; }
      }
      if (currentStep === 3) {
        if (state.techComplaint !== 'ja' && state.techComplaint !== 'nee') return false;
      }
      if (currentStep === 4) {
        if (state.ndf !== 'ja' && state.ndf !== 'nee') return false;
      }
      return true;
    }

    if (dt === 'Soundbar') {
      if (currentStep === 1) {
        if (state.damaged !== 'ja' && state.damaged !== 'nee') return false;
        if (state.damaged === 'ja' && state.photos !== 'ja') { blinkPhotosNote(container); return false; }
      }
      if (currentStep === 3) {
        if (state.techComplaint !== 'ja' && state.techComplaint !== 'nee') return false;
      }
      if (currentStep === 4) {
        if (state.ndf !== 'ja' && state.ndf !== 'nee') return false;
      }
      return true;
    }

    if (dt === 'Stofzuiger') {
      if (currentStep === 1) {
        if (state.damaged !== 'ja' && state.damaged !== 'nee') return false;
        if (state.damaged === 'ja' && state.photos !== 'ja') { blinkPhotosNote(container); return false; }
      }
      if (currentStep === 2) {
        if (state.stofFiltersClean !== 'ja' && state.stofFiltersClean !== 'nee') return false;
      }
      if (currentStep === 3) {
        if (state.stofMotorWorks !== 'ja' && state.stofMotorWorks !== 'nee') return false;
      }
      if (currentStep === 4) {
        if (state.stofMotorWorks === 'nee') {
          if (state.stofMotorCauseUser !== 'ja' && state.stofMotorCauseUser !== 'nee') return false;
        }
      }
      if (currentStep === 5) {
        if (state.techComplaint !== 'ja' && state.techComplaint !== 'nee') return false;
      }
      if (currentStep === 6) {
        if (state.ndf !== 'ja' && state.ndf !== 'nee') return false;
      }
      return true;
    }

    return true;
  }

  function sanitizeStepForDevice(dt) {
    if (dt === 'TV' || dt === 'Magnetron') {
      // if damaged=no, step2 must not be active
      if (state.damaged === 'nee' && currentStep === 2) currentStep = 3;
    }
    if (dt === 'Soundbar') {
      // step2 only relevant if damaged=yes
      if (state.damaged === 'nee' && currentStep === 2) currentStep = 3;
    }
  }

  // ====== NAVIGATION ======
  function goToNextStep(dt) {
    if (dt === 'Magnetron') {
      if (currentStep === 1) currentStep = (state.damaged === 'nee') ? 3 : 2;
      else if (currentStep === 2) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.techComplaint === 'nee') ? 4 : 5;
      else if (currentStep === 4) currentStep = 5;
    } else if (dt === 'TV') {
      if (currentStep === 1) currentStep = (state.damaged === 'nee') ? 3 : 2; // FIX: skip photos if no damage
      else if (currentStep === 2) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.techComplaint === 'nee') ? 4 : 5;
      else if (currentStep === 4) currentStep = 5;
    } else if (dt === 'Soundbar') {
      if (currentStep === 1) currentStep = (state.damaged === 'ja') ? 2 : 3;
      else if (currentStep === 2) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.techComplaint === 'nee') ? 4 : 5;
      else if (currentStep === 4) currentStep = 5;
    } else if (dt === 'Stofzuiger') {
      if (currentStep === 1) currentStep = 2;
      else if (currentStep === 2) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.stofMotorWorks === 'nee') ? 4 : 5;
      else if (currentStep === 4) currentStep = 5;
      else if (currentStep === 5) currentStep = (state.techComplaint === 'nee') ? 6 : 7;
      else if (currentStep === 6) currentStep = 7;
    } else {
      currentStep++;
    }
  }

  function goToPrevStep(dt) {
    if (dt === 'Magnetron') {
      if (currentStep === 5) currentStep = (state.techComplaint === 'nee') ? 4 : 3;
      else if (currentStep === 4) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.damaged === 'nee') ? 1 : 2;
      else if (currentStep === 2) currentStep = 1;
    } else if (dt === 'TV') {
      if (currentStep === 5) currentStep = (state.techComplaint === 'nee') ? 4 : 3;
      else if (currentStep === 4) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.damaged === 'nee') ? 1 : 2; // FIX: skip photos on back too
      else if (currentStep === 2) currentStep = 1;
    } else if (dt === 'Soundbar') {
      if (currentStep === 5) currentStep = (state.techComplaint === 'nee') ? 4 : 3;
      else if (currentStep === 4) currentStep = 3;
      else if (currentStep === 3) currentStep = (state.damaged === 'ja') ? 2 : 1;
      else if (currentStep === 2) currentStep = 1;
    } else if (dt === 'Stofzuiger') {
      if (currentStep === 7) currentStep = (state.techComplaint === 'nee') ? 6 : 5;
      else if (currentStep === 6) currentStep = 5;
      else if (currentStep === 5) currentStep = (state.stofMotorWorks === 'nee') ? 4 : 3;
      else if (currentStep === 4) currentStep = 3;
      else if (currentStep === 3) currentStep = 2;
      else if (currentStep === 2) currentStep = 1;
    } else {
      if (currentStep > 1) currentStep--;
    }
  }

  function updateStepVisibility(container) {
    container.querySelectorAll('.ssr-step').forEach(step => {
      const n = parseInt(step.getAttribute('data-step'), 10);
      if (n === currentStep) step.classList.add('active');
      else step.classList.remove('active');
    });
  }

  // ====== REPORT TEXT (always NL) ======
  function appendTechComplaintNdfLines(lines) {
    if (state.techComplaint === 'ja') {
      lines.push('De technische klacht, zoals opgegeven door de klant, is bevestigd.');
    } else if (state.techComplaint === 'nee') {
      if (state.ndf === 'ja') {
        lines.push('De technische klacht, zoals opgegeven door de klant, is niet bevestigd; toestel geclassificeerd als NDF (No fault found).');
      } else {
        lines.push('De technische klacht, zoals opgegeven door de klant, is niet bevestigd.');
      }
    }
  }

  function buildReportTextMagnetron() {
    const lines = [];
    if (state.damaged === 'ja') {
      const parts = [];
      if (state.damageParts.behuizing) parts.push('behuizing');
      if (state.damageParts.bodemplaat) parts.push('bodemplaat');
      if (state.damageParts.deur) parts.push('deur');

      if (parts.length > 0) {
        let partsText = parts.length === 1 ? parts[0] : (parts.length === 2 ? parts[0] + ' en ' + parts[1] : parts[0] + ', ' + parts[1] + ' en ' + parts[2]);
        lines.push('Toestel ontvangen met zichtbare schade aan ' + partsText + '.');
      } else {
        lines.push('Toestel ontvangen met zichtbare schade.');
      }
    } else if (state.damaged === 'nee') {
      lines.push('Geen zichtbare schade aan het toestel geconstateerd.');
    }
    appendTechComplaintNdfLines(lines);
    return lines.join(' ');
  }

  function buildReportTextTV() {
    const lines = [];
    if (state.damaged === 'ja') lines.push('Toestel (TV) ontvangen met zichtbare schade (transport- en/of scherm-/behuizingsschade).');
    else if (state.damaged === 'nee') lines.push('Geen zichtbare schade aan het toestel (TV) geconstateerd.');
    appendTechComplaintNdfLines(lines);
    return lines.join(' ');
  }

  function buildReportTextSoundbar() {
    const lines = [];
    if (state.damaged === 'ja') {
      lines.push('Soundbar en/of accessoires ontvangen met cosmetische beschadigingen. Er wordt een prijsopgave opgesteld voor herstel van deze schade. De technische klacht wordt wel beoordeeld en indien van toepassing onder garantie opgelost.');
      const parts = [];
      if (state.sbPartTop) parts.push('soundbar top case');
      if (state.sbPartBottom) parts.push('soundbar bottom case');
      if (state.sbPartSub) parts.push('subwoofer');
      if (state.sbPartOther) parts.push('overige cosmetische delen');

      if (parts.length > 0) {
        let partText = parts.length === 1 ? parts[0] : (parts.length === 2 ? parts[0] + ' en ' + parts[1] : parts.slice(0, -1).join(', ') + ' en ' + parts[parts.length - 1]);
        lines.push('Cosmetische schade geconstateerd aan: ' + partText + '.');
      }
      const otherText = (state.sbPartOtherText || '').trim();
      if (state.sbPartOther && otherText) lines.push('Toelichting overige cosmetische schade: ' + otherText + '.');
    } else if (state.damaged === 'nee') {
      lines.push('Geen cosmetische beschadigingen aan soundbar en accessoires geconstateerd bij ontvangst.');
    }
    appendTechComplaintNdfLines(lines);
    return lines.join(' ');
  }

  function buildReportTextStofzuiger() {
    const lines = [];

    if (state.damaged === 'ja') {
      lines.push('Toestel en/of accessoires ontvangen met cosmetische beschadigingen. Er wordt een prijsopgave opgesteld voor het herstellen van deze schade. De technische klacht wordt wel beoordeeld en indien van toepassing onder garantie opgelost.');
    } else if (state.damaged === 'nee') {
      lines.push('Geen cosmetische beschadigingen aan toestel of accessoires geconstateerd bij ontvangst.');
    }

    if (state.stofFiltersClean === 'ja') {
      lines.push('Filters van het toestel en/of laadstation zijn schoon en in een goed onderhouden staat.');
    } else if (state.stofFiltersClean === 'nee') {
      const vervuild = [];
      if (state.stofFilterRing) vervuild.push('RING-filter');
      if (state.stofFilterMicro) vervuild.push('microfilter');
      if (state.stofFilterBase) vervuild.push('filter van het basestation');
      const otherText = (state.stofFilterOtherText || '').trim();
      if (otherText) vervuild.push('overig filter: ' + otherText);

      if (vervuild.length === 0) lines.push('Filters zijn vervuild en dienen vervangen te worden.');
      else if (vervuild.length === 1) lines.push('Het ' + vervuild[0] + ' is vervuild en dient vervangen te worden.');
      else lines.push('De volgende filters zijn vervuild en dienen vervangen te worden: ' + vervuild.join(', ') + '.');
    }

    if (state.stofMotorWorks === 'ja') {
      lines.push('De motor van het toestel werkt normaal.');
    } else if (state.stofMotorWorks === 'nee') {
      lines.push('Motor van het toestel functioneert niet; vervanging is noodzakelijk.');
      if (state.stofMotorCauseUser === 'ja') {
        const reasons = [];
        if (state.stofMotorReasonPowder) reasons.push('(was)poeder / vloeistoffen in toestel');
        if (state.stofMotorReasonFineDust) reasons.push('fijne stof / bouwstof / fijn vuil');
        if (state.stofMotorReasonDirtyFilters) reasons.push('sterk vervuilde of verstopte filters');
        const otherReason = (state.stofMotorReasonOtherText || '').trim();
        if (otherReason) reasons.push(otherReason);

        if (reasons.length > 0) lines.push('Motordefect veroorzaakt door: ' + reasons.join(', ') + '.');
        else lines.push('Motordefect veroorzaakt door gebruiksomstandigheden of onvoldoende onderhoud door de klant.');
      } else if (state.stofMotorCauseUser === 'nee') {
        lines.push('Geen duidelijke aanwijzingen dat het motordefect door verkeerd gebruik of onvoldoende onderhoud is veroorzaakt.');
      }
    }

    appendTechComplaintNdfLines(lines);
    return lines.join(' ');
  }

  function buildReportText() {
    const dt = currentDeviceInfo && currentDeviceInfo.deviceType;
    if (dt === 'Magnetron') return buildReportTextMagnetron();
    if (dt === 'TV') return buildReportTextTV();
    if (dt === 'Soundbar') return buildReportTextSoundbar();
    if (dt === 'Stofzuiger') return buildReportTextStofzuiger();
    return buildReportTextMagnetron();
  }

  function updateReport(container) {
    const out = container.querySelector('#ssr_output');
    if (!out) return;
    out.value = buildReportText();
  }

  // ====== FINALIZE + SAVED CARD ======
  function renderFinalCard(doc, rec, workDescInfo, deviceInfo) {
    const container = doc.getElementById('ssr_container');
    if (!container) return;

    const reportText = (rec && rec.reportText) ? rec.reportText : buildReportText();
    const caseKey = rec && rec.caseKey ? rec.caseKey : getCaseKey(doc);

    container.innerHTML = `
${headerHtml('Screening servicerapport')}
<div class="ssr-success">
  <div class="ssr-success-header">
    <span>Servicerapport opgeslagen</span>
    <span style="font-size:11px;font-weight:normal;">Case: <b>${escapeHtml(caseKey)}</b></span>
  </div>
  <div class="ssr-success-note">
    Report is opgeslagen in localStorage. Je kunt opnieuw invoegen (overschrijven), bewerken of versturen.
  </div>

  <div class="ssr-success-actions">
    <button type="button" id="ssr_final_insert">Insert to Workdescription (overwrite)</button>
    <button type="button" id="ssr_final_edit">Bewerk</button>
    <button type="button" id="ssr_final_send">Stuur servicerapport</button>
    <button type="button" id="ssr_final_copy_email" class="ssr-admin-only">Kopieer e-mailtekst</button>
  </div>

  <div style="margin-top:8px;">
    <div style="font-size:11px;font-weight:normal;margin-bottom:4px;">Opgeslagen rapporttekst:</div>
    <textarea rows="4" readonly>${escapeHtml(reportText)}</textarea>
  </div>
</div>
    `;

    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);

    const btnInsert = container.querySelector('#ssr_final_insert');
    const btnEdit = container.querySelector('#ssr_final_edit');
    const btnSend = container.querySelector('#ssr_final_send');
    const btnCopy = container.querySelector('#ssr_final_copy_email');

    btnInsert && btnInsert.addEventListener('click', () => setWorkDescOverwrite(workDescInfo, reportText));

    btnCopy && btnCopy.addEventListener('click', () => {
      if (!isAdmin) return;
      copyToClipboard(rec.emailText || lastEmailText || '');
      alert('E-mailtekst gekopieerd.');
    });

    btnSend && btnSend.addEventListener('click', () => {
      const emailText = rec.emailText || lastEmailText || buildEmailText(reportText, deviceInfo, doc);
      copyToClipboard(emailText);
      if (isSpecialDealer(doc)) {
        const mailBtn = doc.getElementById('btn_mail_klant');
        if (mailBtn) mailBtn.click();
        else alert('Knop "bericht klant" (btn_mail_klant) niet gevonden.');
      } else {
        alert('E-mailtekst is gekopieerd naar het klembord. Plak deze in de gewenste e-mail (Ctrl+V).');
      }
    });

    btnEdit && btnEdit.addEventListener('click', () => {
      // restore questionnaire with saved state
      state = mergeState(rec.state);
      currentStep = rec.currentStep || 1;
      renderQuestionnaire(doc, workDescInfo, deviceInfo);
      hydrateUIFromState(doc.getElementById('ssr_container'), deviceInfo.deviceType);
    });
  }

  function finalizeReport(container, workDescInfo, doc, deviceInfo) {
    updateReport(container);
    const out = container.querySelector('#ssr_output');
    const reportText = (out && out.value || '').trim();
    if (!reportText) return alert('Geen rapport om te kopiëren. Vul eerst de vragen in.');

    // overwrite (per your request)
    setWorkDescOverwrite(workDescInfo, reportText);

    lastEmailText = buildEmailText(reportText, deviceInfo, doc);
    copyToClipboard(lastEmailText);

    const rec = saveFinal(doc, deviceInfo, reportText, lastEmailText);
    renderFinalCard(doc, rec, workDescInfo, deviceInfo);
  }

  // ====== HYDRATE UI FROM STATE (for edit / restore draft) ======
  function setActiveChoice(container, q, val) {
    if (!q || !val) return;
    const btn = container.querySelector('.ssr-btn-choice[data-q="' + q + '"][data-val="' + val + '"]');
    if (!btn) return;
    container.querySelectorAll('.ssr-btn-choice[data-q="' + q + '"]').forEach(b => b.classList.remove('ssr-active'));
    btn.classList.add('ssr-active');
  }

  function hydrateUIFromState(container, dt) {
    if (!container) return;

    // choices
    setActiveChoice(container, 'damaged', state.damaged);
    setActiveChoice(container, 'photos', state.photos);
    setActiveChoice(container, 'techComplaint', state.techComplaint);
    setActiveChoice(container, 'ndf', state.ndf);
    setActiveChoice(container, 'finalConfirm', state.finalConfirm);

    // TV/Magnetron photos note visibility
    if (dt === 'TV' || dt === 'Magnetron') {
      if (state.damaged === 'nee') hidePhotosNote(container);
      else {
        if (state.photos === 'nee' || state.photos === null) {
          // keep hidden unless user tries Next (we still keep consistent)
          const note = container.querySelector('#ssr_photos_note');
          if (note) note.style.display = 'none';
        } else hidePhotosNote(container);
      }
      // magnetron damage parts
      const partBoxes = container.querySelectorAll('input[type="checkbox"][data-part]');
      partBoxes.forEach(cb => {
        const p = cb.getAttribute('data-part');
        cb.checked = !!(state.damageParts && state.damageParts[p]);
      });
    }

    if (dt === 'Soundbar') {
      // show photos block only if damaged yes
      const ph = container.querySelector('#ssr_sb_photos_block');
      if (ph) ph.style.display = (state.damaged === 'ja') ? 'block' : 'none';
      if (state.damaged !== 'ja') hidePhotosNote(container);

      // parts
      const sbBoxes = container.querySelectorAll('input[type="checkbox"][data-sb-part]');
      sbBoxes.forEach(cb => {
        const w = cb.getAttribute('data-sb-part');
        if (w === 'top') cb.checked = !!state.sbPartTop;
        if (w === 'bottom') cb.checked = !!state.sbPartBottom;
        if (w === 'sub') cb.checked = !!state.sbPartSub;
        if (w === 'other') cb.checked = !!state.sbPartOther;
      });
      const sbOther = container.querySelector('#ssr_sb_other_text');
      if (sbOther) sbOther.value = state.sbPartOtherText || '';
    }

    if (dt === 'Stofzuiger') {
      const ph = container.querySelector('#ssr_stof_photos_block');
      if (ph) ph.style.display = (state.damaged === 'ja') ? 'block' : 'none';
      if (state.damaged !== 'ja') hidePhotosNote(container);

      setActiveChoice(container, 'stofFiltersClean', state.stofFiltersClean);
      setActiveChoice(container, 'stofMotorWorks', state.stofMotorWorks);
      setActiveChoice(container, 'stofMotorCauseUser', state.stofMotorCauseUser);

      const filterDetails = container.querySelector('#ssr_stof_filters_details');
      if (filterDetails) filterDetails.style.display = (state.stofFiltersClean === 'nee') ? 'block' : 'none';

      const cbsF = container.querySelectorAll('input[type="checkbox"][data-stof-filter]');
      cbsF.forEach(cb => {
        const w = cb.getAttribute('data-stof-filter');
        if (w === 'ring') cb.checked = !!state.stofFilterRing;
        if (w === 'micro') cb.checked = !!state.stofFilterMicro;
        if (w === 'base') cb.checked = !!state.stofFilterBase;
      });
      const otherF = container.querySelector('#ssr_stof_filter_other');
      if (otherF) otherF.value = state.stofFilterOtherText || '';

      const motorReasonDetails = container.querySelector('#ssr_stof_motor_reason_details');
      if (motorReasonDetails) motorReasonDetails.style.display = (state.stofMotorCauseUser === 'ja') ? 'block' : 'none';

      const cbsM = container.querySelectorAll('input[type="checkbox"][data-stof-motor-reason]');
      cbsM.forEach(cb => {
        const w = cb.getAttribute('data-stof-motor-reason');
        if (w === 'powder') cb.checked = !!state.stofMotorReasonPowder;
        if (w === 'fineDust') cb.checked = !!state.stofMotorReasonFineDust;
        if (w === 'dirtyFilters') cb.checked = !!state.stofMotorReasonDirtyFilters;
      });
      const otherM = container.querySelector('#ssr_stof_motor_other');
      if (otherM) otherM.value = state.stofMotorReasonOtherText || '';
    }

    sanitizeStepForDevice(dt);
    updateStepVisibility(container);
    updateReport(container);
  }

  // ====== DEVICE LOGIC ATTACH ======
  function attachChoiceButtons(container, doc, workDescInfo, deviceInfo) {
    const dt = deviceInfo.deviceType;
    container.querySelectorAll('.ssr-btn-choice').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.getAttribute('data-q');
        const val = btn.getAttribute('data-val');
        if (!q) return;

        state[q] = val;

        container.querySelectorAll('.ssr-btn-choice[data-q="' + q + '"]').forEach(b => b.classList.remove('ssr-active'));
        btn.classList.add('ssr-active');

        if (q === 'damaged') {
          // clear photos when damage is no
          if (val === 'nee') {
            state.photos = null;
            container.querySelectorAll('.ssr-btn-choice[data-q="photos"]').forEach(b => b.classList.remove('ssr-active'));
            hidePhotosNote(container);

            // hide photos blocks in stof/sb
            const ph1 = container.querySelector('#ssr_sb_photos_block');
            if (ph1) ph1.style.display = 'none';
            const ph2 = container.querySelector('#ssr_stof_photos_block');
            if (ph2) ph2.style.display = 'none';

            // clear magnetron parts if switching to no
            if (dt === 'Magnetron') {
              state.damageParts = { behuizing: false, bodemplaat: false, deur: false };
              container.querySelectorAll('input[type="checkbox"][data-part]').forEach(cb => cb.checked = false);
            }
          } else if (val === 'ja') {
            // show photos blocks for stof/sb
            const ph1 = container.querySelector('#ssr_sb_photos_block');
            if (ph1) ph1.style.display = 'block';
            const ph2 = container.querySelector('#ssr_stof_photos_block');
            if (ph2) ph2.style.display = 'block';
          }
        }

        if (q === 'photos') {
          if (val === 'nee') {
            const note = container.querySelector('#ssr_photos_note');
            if (note) note.style.display = 'block';
          } else {
            hidePhotosNote(container);
          }
        }

        if (q === 'finalConfirm') {
          if (val === 'ja') {
            finalizeReport(container, workDescInfo, doc, deviceInfo);
            return;
          } else if (val === 'nee') {
            currentStep = 1;
            sanitizeStepForDevice(dt);
            updateStepVisibility(container);
            updateReport(container);
          }
        }

        scheduleAutosaveDraft(doc, deviceInfo);
        updateReport(container);
      });
    });
  }

  function attachMagnetronLogic(container, doc, workDescInfo, deviceInfo) {
    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);
    attachChoiceButtons(container, doc, workDescInfo, deviceInfo);

    container.querySelectorAll('input[type="checkbox"][data-part]').forEach(chk => {
      chk.addEventListener('change', () => {
        const part = chk.getAttribute('data-part');
        if (!part) return;
        state.damageParts[part] = chk.checked;
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    });

    const prevBtn = container.querySelector('#ssr_prev');
    const nextBtn = container.querySelector('#ssr_next');
    const genBtn = container.querySelector('#ssr_generate');

    prevBtn.addEventListener('click', () => {
      goToPrevStep('Magnetron');
      sanitizeStepForDevice('Magnetron');
      updateStepVisibility(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    nextBtn.addEventListener('click', () => {
      if (!validateBeforeNext(container, 'Magnetron')) return;
      goToNextStep('Magnetron');
      sanitizeStepForDevice('Magnetron');
      updateStepVisibility(container);
      updateReport(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    genBtn.addEventListener('click', () => updateReport(container));

    sanitizeStepForDevice('Magnetron');
    updateStepVisibility(container);
    updateReport(container);
  }

  function attachTVLogic(container, doc, workDescInfo, deviceInfo) {
    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);
    attachChoiceButtons(container, doc, workDescInfo, deviceInfo);

    const prevBtn = container.querySelector('#ssr_prev');
    const nextBtn = container.querySelector('#ssr_next');
    const genBtn = container.querySelector('#ssr_generate');

    prevBtn.addEventListener('click', () => {
      goToPrevStep('TV');
      sanitizeStepForDevice('TV');
      updateStepVisibility(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    nextBtn.addEventListener('click', () => {
      if (!validateBeforeNext(container, 'TV')) return;
      goToNextStep('TV');
      sanitizeStepForDevice('TV');
      updateStepVisibility(container);
      updateReport(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    genBtn.addEventListener('click', () => updateReport(container));

    sanitizeStepForDevice('TV');
    updateStepVisibility(container);
    updateReport(container);
  }

  function attachSoundbarLogic(container, doc, workDescInfo, deviceInfo) {
    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);
    attachChoiceButtons(container, doc, workDescInfo, deviceInfo);

    container.querySelectorAll('input[type="checkbox"][data-sb-part]').forEach(chk => {
      chk.addEventListener('change', () => {
        const which = chk.getAttribute('data-sb-part');
        if (which === 'top') state.sbPartTop = chk.checked;
        if (which === 'bottom') state.sbPartBottom = chk.checked;
        if (which === 'sub') state.sbPartSub = chk.checked;
        if (which === 'other') state.sbPartOther = chk.checked;
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    });

    const sbOtherInput = container.querySelector('#ssr_sb_other_text');
    if (sbOtherInput) {
      sbOtherInput.addEventListener('input', () => {
        state.sbPartOtherText = sbOtherInput.value || '';
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    }

    const prevBtn = container.querySelector('#ssr_prev');
    const nextBtn = container.querySelector('#ssr_next');
    const genBtn = container.querySelector('#ssr_generate');

    prevBtn.addEventListener('click', () => {
      goToPrevStep('Soundbar');
      sanitizeStepForDevice('Soundbar');
      updateStepVisibility(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    nextBtn.addEventListener('click', () => {
      if (!validateBeforeNext(container, 'Soundbar')) return;
      goToNextStep('Soundbar');
      sanitizeStepForDevice('Soundbar');
      updateStepVisibility(container);
      updateReport(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    genBtn.addEventListener('click', () => updateReport(container));

    sanitizeStepForDevice('Soundbar');
    updateStepVisibility(container);
    updateReport(container);
  }

  function attachStofzuigerLogic(container, doc, workDescInfo, deviceInfo) {
    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);
    attachChoiceButtons(container, doc, workDescInfo, deviceInfo);

    const filterDetails = container.querySelector('#ssr_stof_filters_details');
    const filterOtherInput = container.querySelector('#ssr_stof_filter_other');

    const motorReasonDetails = container.querySelector('#ssr_stof_motor_reason_details');
    const motorOtherInput = container.querySelector('#ssr_stof_motor_other');

    // extra: show/hide details when choice changes
    container.querySelectorAll('.ssr-btn-choice[data-q="stofFiltersClean"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!filterDetails) return;
        if (state.stofFiltersClean === 'nee') filterDetails.style.display = 'block';
        else {
          filterDetails.style.display = 'none';
          state.stofFilterRing = false;
          state.stofFilterMicro = false;
          state.stofFilterBase = false;
          state.stofFilterOtherText = '';
          filterDetails.querySelectorAll('input[type="checkbox"][data-stof-filter]').forEach(cb => cb.checked = false);
          if (filterOtherInput) filterOtherInput.value = '';
        }
      });
    });

    container.querySelectorAll('.ssr-btn-choice[data-q="stofMotorCauseUser"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!motorReasonDetails) return;
        if (state.stofMotorCauseUser === 'ja') motorReasonDetails.style.display = 'block';
        else {
          motorReasonDetails.style.display = 'none';
          state.stofMotorReasonPowder = false;
          state.stofMotorReasonFineDust = false;
          state.stofMotorReasonDirtyFilters = false;
          state.stofMotorReasonOtherText = '';
          motorReasonDetails.querySelectorAll('input[type="checkbox"][data-stof-motor-reason]').forEach(cb => cb.checked = false);
          if (motorOtherInput) motorOtherInput.value = '';
        }
      });
    });

    container.querySelectorAll('input[type="checkbox"][data-stof-filter]').forEach(chk => {
      chk.addEventListener('change', () => {
        const which = chk.getAttribute('data-stof-filter');
        if (which === 'ring') state.stofFilterRing = chk.checked;
        if (which === 'micro') state.stofFilterMicro = chk.checked;
        if (which === 'base') state.stofFilterBase = chk.checked;
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    });

    if (filterOtherInput) {
      filterOtherInput.addEventListener('input', () => {
        state.stofFilterOtherText = filterOtherInput.value || '';
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    }

    container.querySelectorAll('input[type="checkbox"][data-stof-motor-reason]').forEach(chk => {
      chk.addEventListener('change', () => {
        const which = chk.getAttribute('data-stof-motor-reason');
        if (which === 'powder') state.stofMotorReasonPowder = chk.checked;
        if (which === 'fineDust') state.stofMotorReasonFineDust = chk.checked;
        if (which === 'dirtyFilters') state.stofMotorReasonDirtyFilters = chk.checked;
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    });

    if (motorOtherInput) {
      motorOtherInput.addEventListener('input', () => {
        state.stofMotorReasonOtherText = motorOtherInput.value || '';
        scheduleAutosaveDraft(doc, deviceInfo);
      });
    }

    const prevBtn = container.querySelector('#ssr_prev');
    const nextBtn = container.querySelector('#ssr_next');
    const genBtn = container.querySelector('#ssr_generate');

    prevBtn.addEventListener('click', () => {
      goToPrevStep('Stofzuiger');
      sanitizeStepForDevice('Stofzuiger');
      updateStepVisibility(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    nextBtn.addEventListener('click', () => {
      if (!validateBeforeNext(container, 'Stofzuiger')) return;
      goToNextStep('Stofzuiger');
      sanitizeStepForDevice('Stofzuiger');
      updateStepVisibility(container);
      updateReport(container);
      scheduleAutosaveDraft(doc, deviceInfo);
    });

    genBtn.addEventListener('click', () => updateReport(container));

    sanitizeStepForDevice('Stofzuiger');
    updateStepVisibility(container);
    updateReport(container);
  }

  function triggerBerichtEig(doc) {
    let btn = doc.getElementById('btn_mail_eig') || doc.getElementById('btn_mail_eigenaar');
    if (!btn) {
      const candidates = Array.from(doc.querySelectorAll('input[type="button"], button'));
      btn = candidates.find(el => {
        const v = (el.value || el.textContent || '').toLowerCase();
        return v.includes('bericht eig') || v.includes('bericht eigenaar');
      });
    }
    if (btn) btn.click();
    else alert('Knop "bericht eig." niet gevonden. Neem contact op met de ontwikkelaar.');
  }

  function buildDevEmailSubject(deviceInfo, doc) {
    const caseNumber = getCaseNumber(doc);
    const type = deviceInfo.deviceType || 'toestel';
    let subj = 'Aanvraag servicerapport formulier - ' + type;
    if (caseNumber) subj += ' (case ' + caseNumber + ')';
    return subj;
  }

  function buildDevEmailText(deviceInfo, doc) {
    const caseNumber = getCaseNumber(doc);
    const model = getModelCode(doc);

    const lines = [];
    lines.push('Beste collega,');
    lines.push('');
    lines.push('Graag een (automatisch) Screen Service Report formulier ontwikkelen voor het volgende toesteltype:');
    lines.push('');
    lines.push('Order-/casenummer: ' + (caseNumber || 'onbekend'));
    lines.push('Model: ' + (model || 'onbekend'));
    lines.push('Merk: ' + (deviceInfo.brand || 'onbekend'));
    lines.push('Toesteltype (geclassificeerd): ' + (deviceInfo.deviceType || 'onbekend'));
    if (deviceInfo.rawType) lines.push('Oorspronkelijke type-tekst uit systeem: ' + deviceInfo.rawType);
    lines.push('');
    lines.push('Alvast bedankt!');
    return lines.join('\n');
  }

  function attachPlaceholderLogic(container, doc, workDescInfo, deviceInfo) {
    attachCommonHeaderLogic(container, doc, workDescInfo, deviceInfo);

    const btn = container.querySelector('#ssr_request_form_btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const body = buildDevEmailText(deviceInfo, doc);
        const subject = buildDevEmailSubject(deviceInfo, doc);

        try {
          sessionStorage.setItem('ssr_dev_email_body', body);
          sessionStorage.setItem('ssr_dev_email_to', DEV_TO);
          sessionStorage.setItem('ssr_dev_email_subject', subject);
        } catch (e) {
          console.log('[SSR] Cannot use sessionStorage for dev email:', e);
        }

        triggerBerichtEig(doc);
      });
    }
  }

  // ====== RENDER QUESTIONNAIRE (device switch) ======
  function renderQuestionnaire(doc, workDescInfo, deviceInfo) {
    const container = doc.getElementById('ssr_container');
    if (!container) return;

    const dt = deviceInfo.deviceType;

    if (dt === 'Magnetron') {
      container.innerHTML = createMagnetronHTML(deviceInfo);
      attachMagnetronLogic(container, doc, workDescInfo, deviceInfo);
    } else if (dt === 'TV') {
      container.innerHTML = createTVHTML(deviceInfo);
      attachTVLogic(container, doc, workDescInfo, deviceInfo);
    } else if (dt === 'Soundbar') {
      container.innerHTML = createSoundbarHTML(deviceInfo);
      attachSoundbarLogic(container, doc, workDescInfo, deviceInfo);
    } else if (dt === 'Stofzuiger') {
      container.innerHTML = createStofzuigerHTML(deviceInfo);
      attachStofzuigerLogic(container, doc, workDescInfo, deviceInfo);
    } else {
      container.innerHTML = createPlaceholderHTML(deviceInfo);
      attachPlaceholderLogic(container, doc, workDescInfo, deviceInfo);
    }
  }

  // ====== LANGUAGE SWITCH (from 1.14.1, shortened: UI only) ======
  function setText(el, text) { if (el) el.textContent = text; }

  function applyLanguage(container, deviceInfo) {
    if (!container) return;
    const lang = currentLanguage || 'NL';
    const titleEl = container.querySelector('#ssr_title_text');
    const warning = container.querySelector('#ssr_warning');
    const prevBtn = container.querySelector('#ssr_prev');
    const nextBtn = container.querySelector('#ssr_next');
    const genBtn = container.querySelector('#ssr_generate');
    const outLabel = container.querySelector('#ssr_output_label');

    const isPlaceholder = !warning;

    if (!isPlaceholder) {
      if (lang === 'EN') {
        setText(titleEl, 'Screening service report MANDATORY');
        setText(warning, 'Service report not yet filled');
      } else {
        setText(titleEl, 'Screening servicerapport VERPLICHT');
        setText(warning, 'Servicerapport nog niet ingevuld');
      }
    } else {
      if (lang === 'EN') setText(titleEl, 'Screening service report');
      else setText(titleEl, 'Screening servicerapport');
    }

    if (prevBtn && nextBtn) {
      if (lang === 'EN') { setText(prevBtn, '← Previous'); setText(nextBtn, 'Next →'); }
      else { setText(prevBtn, '← Vorige'); setText(nextBtn, 'Volgende →'); }
    }
    if (genBtn) {
      if (lang === 'EN') setText(genBtn, 'Generate report');
      else setText(genBtn, 'Rapport genereren');
    }
    if (outLabel) {
      outLabel.innerHTML = (lang === 'EN') ? '<b>Screening service report (result):</b>' : '<b>Screening servicerapport (resultaat):</b>';
    }
  }

  // ====== MAILCLIENT POPUP (DEV EMAIL) ======
  function isMailClientPage(doc) {
    if (!doc) return false;
    if (doc.title && doc.title.toLowerCase().includes('mailclient')) return true;
    if (doc.getElementById('maintable') && doc.getElementById('body') && doc.getElementById('to')) return true;
    return false;
  }

  function handleMailClient(doc) {
    let body = null, to = null, subj = null;
    try {
      body = sessionStorage.getItem('ssr_dev_email_body');
      to = sessionStorage.getItem('ssr_dev_email_to');
      subj = sessionStorage.getItem('ssr_dev_email_subject');
    } catch (e) {
      console.log('[SSR] Cannot read sessionStorage in mailclient:', e);
    }
    if (!body && !to && !subj) return;

    const toInput = doc.getElementById('to');
    if (toInput && to) toInput.value = to;

    const subjInput = doc.getElementById('subject');
    if (subjInput && subj) subjInput.value = subj;

    if (body) {
      if (window.CKEDITOR && CKEDITOR.instances && CKEDITOR.instances.body) {
        CKEDITOR.instances.body.setData(body);
        try { if (typeof appendeditedfield === 'function') appendeditedfield('body'); } catch (e) {}
      } else {
        const ta = doc.getElementById('body');
        if (ta) ta.value = body;
      }
    }

    try {
      sessionStorage.removeItem('ssr_dev_email_body');
      sessionStorage.removeItem('ssr_dev_email_to');
      sessionStorage.removeItem('ssr_dev_email_subject');
    } catch (e) {}
  }

  // ====== INIT ======
  function init() {
    return safe(() => {
      tries++;

      if (document.getElementById('ssr_container')) { stop(); return; }

      const workDescInfo = findWorkdescription(document);
      if (!workDescInfo || !workDescInfo.anchor) {
        if (tries >= MAX_TRIES) { console.log('[SSR] Workdescription not found; stopping.'); stop(); }
        return;
      }

      injectStyles(document);

      const deviceInfo = detectDeviceInfo(document);
      currentDeviceInfo = deviceInfo;

      const container = document.createElement('div');
      container.id = 'ssr_container';

      // insert after anchor
      const anchor = workDescInfo.anchor;
      if (anchor.insertAdjacentElement) anchor.insertAdjacentElement('afterend', container);
      else anchor.parentNode.insertBefore(container, anchor.nextSibling);

      const caseKey = getCaseKey(document);
      const saved = loadCaseRecord(caseKey);

      if (saved && saved.state) {
        state = mergeState(saved.state);
        currentStep = saved.currentStep || 1;
        lastEmailText = saved.emailText || '';
        // autoshow final card if finalized; else restore questionnaire prefilled
        if (saved.isFinal) {
          renderFinalCard(document, saved, workDescInfo, deviceInfo);
        } else {
          renderQuestionnaire(document, workDescInfo, deviceInfo);
          hydrateUIFromState(document.getElementById('ssr_container'), deviceInfo.deviceType);
        }
      } else {
        // fresh
        state = makeDefaultState();
        currentStep = 1;
        renderQuestionnaire(document, workDescInfo, deviceInfo);
        saveDraft(document, deviceInfo);
      }

      console.log('[SSR] 1.15.2 FULL injected. device=', deviceInfo, 'workDescKind=', workDescInfo.kind, 'caseKey=', caseKey);
      stop();
    }, 'init');
  }

  // ====== START ======
  if (isMailClientPage(document)) {
    handleMailClient(document);
  } else {
    timer = setInterval(init, INTERVAL_MS);
  }
})();
