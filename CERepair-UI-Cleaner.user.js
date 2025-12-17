// ==UserScript==
// @name         CERepair UI Cleaner v2.4 — Clean (frames + toggles + highlights)
// @namespace    https://groupwise.cerepair.nl/
// @version      2.4.14
// @description  Stable toggles only on pages with real targets; hide/toggle fields across frames/iframes; ZIR as button; hide Monteur/route; modernize model & product-code buttons; highlight Technician when empty/Onbekend; hide Variant/Website and dealer row.
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-end
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/CERepair-UI-Cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/CERepair-UI-Cleaner.user.js
// ==/UserScript==

(function () {
  'use strict';

  const qs  = (sel, root=document) => root.querySelector(sel);
  const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const rowOf = el => el && el.closest && el.closest('tr');

  const norm = s => String(s||'')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.:]+$/g, '')
    .trim()
    .toLowerCase();

  const TARGETS_GENERAL = [
    { byId:'tr_visualdefects' },
    { byId:'tr_software_old' },
    { byId:'tr_software_new' },
    { byInputId:'errorcode' },
    { byThText:'Errorcode' },
    { byInputId:'insurancenumber' },
    { byThText:'Insurancenr.' },
    { byThText:'Chassis' },
  ];

  const TARGETS_PLANNING = [
    { byId:'tr_startdate' }, { byThText:'Plandate' },
    { byId:'tr_priority' },  { byThText:'Timeframe' },
    { byId:'tr_timeframe' }, { byThText:'Timeframe (txt)' },
    { byId:'tr_preferreddate_repair' }, { byThText:'Voorkeursdatum' },
    { byId:'tr_schedulefromdate_repair' }, { byThText:'Plan vanaf' },
    { byId:'tr_planning_buttons' }, { byId:'tr_planadvies' },
    { byId:'tr_arrivaldate' },
    { byId:'tr_arrivaltimeframe' },
    { byId:'tr_arrivaltimeframetxt' },
    { byId:'tr_arrivalbuttons' },
  ];

  const FIELDSETS_CUSTOMER = [
    { bySelector:'fieldset > legend > a[onclick*="showhide_owner"]', upToFieldset:true },
    { byLegendText:'owner', upToFieldset:true },
    { byId:'fs_delivery', upToFieldset:true },
  ];

  const state = { hideGeneral:true, hidePlanning:true, hideCustomer:true };

  const CSS = `
    .cec-hidden { display:none!important; }

    .cec-toggle {
      position:fixed; z-index:2147483000; right:10px;
      padding:8px 12px; background:#2b3648; color:#fff; border-radius:8px;
      font:12px/1.2 system-ui,sans-serif; cursor:pointer; border:none;
      box-shadow:0 2px 10px rgba(0,0,0,.25);
    }
    .cec-toggle:hover { filter:brightness(1.05); }
    .cec-toggle.cec-pos1 { bottom:110px; }
    .cec-toggle.cec-pos2 { bottom:70px; }
    .cec-toggle.cec-pos3 { bottom:30px; }
    .cec-never-hide { display:inline-block!important; }

    .cec-zir-btn{
      display:inline-block!important;
      padding:4px 8px!important;
      border:1px solid #ef4444!important;
      border-radius:8px!important;
      background:#fff!important;
      color:#b91c1c!important;
      font-weight:800!important;
      text-decoration:none!important;
      cursor:pointer!important;
      white-space:nowrap!important;
      margin-left:4px;
    }
    .cec-zir-btn:hover{ filter:brightness(0.95); }

    .cec-btn {
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:4px 10px;
      border-radius:8px;
      border:1px solid #CBD5E1;
      background:#fff;
      color:#0F172A;
      font-weight:700;
      line-height:1.2;
      cursor:pointer;
      box-shadow:0 1px 2px rgba(0,0,0,.06);
      vertical-align: middle;
    }
    .cec-btn:hover { filter:brightness(0.98); }
    .cec-btn-icon { display:inline-flex; width:16px; height:16px; }
    .cec-btn-clean { width:auto!important; min-width:unset!important; height:auto!important; }

    button.cec-btn.cec-btn-clean{
      vertical-align: middle !important;
      margin: 0 !important;
      height: 26px !important;
      line-height: 26px !important;
      box-sizing: border-box !important;
      width: auto !important;
      min-width: 0 !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
    }
    button.cec-btn.cec-btn-clean svg{ display:block !important; }

    #td_gereedmelden{ white-space:nowrap !important; }

    @keyframes cec-tech-blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0.25; }
    }

    .cec-tech-bad{
      outline:2px solid #ef4444 !important;
      background:#fff1f2 !important;
    }
    .cec-tech-bad td:first-child{
      font-weight:900 !important;
      color:#b91c1c !important;
      font-size:16px !important;
      animation: cec-tech-blink 1.1s infinite;
    }
    .cec-tech-bad select{
      border:2px solid #ef4444 !important;
      border-radius:8px !important;
      background:#fff !important;
      font-weight:900 !important;
      font-size:14px !important;
    }

    .cec-tech-good{
      outline:2px solid #22c55e !important;
      background:#f0fdf4 !important;
    }
    .cec-tech-good td:first-child{
      font-weight:800 !important;
      color:#166534 !important;
    }
    .cec-tech-good select{
      border:2px solid #22c55e !important;
      border-radius:8px !important;
      background:#fff !important;
      font-weight:700 !important;
    }
  `;

  function injectCss(doc){
    if (!doc || !doc.documentElement) return;
    if (doc.documentElement.dataset.cecCss) return;
    const st = doc.createElement('style');
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
    doc.documentElement.dataset.cecCss = '1';
  }

  function frameInfo(doc){
    try {
      const fe = doc.defaultView?.frameElement;
      return { id: fe?.id || '', name: fe?.name || '', tag: fe?.tagName || '' };
    } catch {
      return { id:'', name:'', tag:'' };
    }
  }

  function isHeaderFrameDoc(doc){
    const fi = frameInfo(doc);
    const s = (fi.id + ' ' + fi.name).toLowerCase();
    return s.includes('header');
  }

  function findRowByFirstCellText(doc, text){
    const rows = qsa('tbody > tr, table > tbody > tr, table > tr', doc);
    const n = norm(text);
    return rows.find(tr => {
      const c0 = tr.cells && tr.cells[0];
      if (!c0) return false;
      const t = norm(c0.textContent);
      return t === n || t.startsWith(n);
    }) || null;
  }

  function findTargetRow(doc, t){
    let tr = null;
    if (t.byId) tr = rowOf(doc.getElementById(t.byId));
    if (!tr && t.byInputId) tr = rowOf(doc.getElementById(t.byInputId));
    if (!tr && t.byThText) tr = findRowByFirstCellText(doc, t.byThText);
    return tr;
  }

  function findFieldsets(doc, spec){
    if (spec.byId){
      const el = doc.getElementById(spec.byId);
      if (el) return [el];
    }
    if (spec.bySelector){
      const el = qs(spec.bySelector, doc);
      if (el) return [el];
    }
    if (spec.byLegendText){
      const all = qsa('fieldset > legend', doc);
      const needle = norm(spec.byLegendText);
      return all.filter(lg => norm(lg.textContent).includes(needle));
    }
    return [];
  }

  function hasAnyHideTargets(doc){
    for (const t of TARGETS_GENERAL)  if (findTargetRow(doc, t)) return true;
    for (const t of TARGETS_PLANNING) if (findTargetRow(doc, t)) return true;
    for (const f of FIELDSETS_CUSTOMER) if (findFieldsets(doc, f).length) return true;
    return false;
  }

  function uiEligible(doc){
    if (!doc || !doc.documentElement) return false;
    if (!doc.body) return false;
    if (isHeaderFrameDoc(doc)) return false;
    return hasAnyHideTargets(doc);
  }

  function applyHideList(doc, list, hide=true){
    list.forEach(t=>{
      const tr = findTargetRow(doc, t);
      if (tr){
        tr.classList.toggle('cec-hidden', !!hide);
        if ((t.byInputId==='errorcode' || t.byThText==='Errorcode')) {
          qsa('button, input[type="button"]', tr).forEach(b=>b.classList.toggle('cec-hidden', !!hide));
        }
      }
    });
  }

  function applyHideFieldsets(doc, list, hide=true){
    list.forEach(spec=>{
      const nodes = findFieldsets(doc, spec);
      nodes.forEach(node=>{
        let target = node;
        if (spec.upToFieldset){
          const fs = node.closest('fieldset');
          if (fs) target = fs;
        }
        if (target) target.classList.toggle('cec-hidden', !!hide);
      });
    });
  }

  function hideMonteurRoute(doc){
    const row = doc.getElementById('tr_arrivaltechnician');
    if (row) row.classList.add('cec-hidden');
  }

  function styleZIRasButton(doc){
    const tr = findRowByFirstCellText(doc, 'Klant ref.');
    if (!tr || !tr.cells || !tr.cells[1]) return;
    const a = tr.cells[1].querySelector('a[onclick*="popcustomerref"]');
    if (!a) return;
    a.classList.add('cec-zir-btn');
  }

  function setLabel(el, text, htmlIfButton){
    if (!el) return;
    const tag = (el.tagName||'').toUpperCase();
    if (tag === 'INPUT') {
      if (el.type && el.type.toLowerCase() === 'button') el.value = text;
    } else if (tag === 'BUTTON') {
      if (htmlIfButton !== undefined) el.innerHTML = htmlIfButton;
      else el.textContent = text;
    }
  }

  function styleModelButtons(doc){
    const tr = findRowByFirstCellText(doc, 'Model');
    if (!tr || !tr.cells || !tr.cells[1]) return;
    const btns = tr.cells[1].querySelectorAll('button, input[type="button"]');

    btns.forEach(btn=>{
      if (btn.dataset.cecStyled) return;
      const onClick = (btn.getAttribute('onclick')||'').toLowerCase();

      if (onClick.includes('googlesearch')) {
        btn.classList.add('cec-btn','cec-btn-clean');
        btn.title = 'Search Google';
        setLabel(btn, 'Google', `
          <span class="cec-btn-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="#EA4335" d="M12 10.2v3.6h5.1c-.2 1.2-1.5 3.6-5.1 3.6-3.1 0-5.7-2.6-5.7-5.7S8.9 6 12 6c1.8 0 3 .8 3.7 1.5l2.5-2.4C16.8 3.8 14.6 3 12 3 6.9 3 2.7 7.2 2.7 12.3S6.9 21.6 12 21.6c6.9 0 9.3-4.8 9.3-7.2 0-.5 0-.9-.1-1.2H12z"/>
            </svg>
          </span>
          <span>Google</span>
        `);
        btn.dataset.cecStyled = '1';
      } else if (onClick.includes('changeorderdatabytechnician')) {
        btn.classList.add('cec-btn','cec-btn-clean');
        btn.title = 'Change';
        setLabel(btn, 'Change');
        btn.dataset.cecStyled = '1';
      }
    });
  }

  function styleProductCodeButtons(doc){
    const tr = findRowByFirstCellText(doc, 'ProductCode');
    if (!tr || !tr.cells || !tr.cells[1]) return;
    const btns = tr.cells[1].querySelectorAll('button, input[type="button"]');

    btns.forEach(btn=>{
      if (btn.dataset.cecStyled) return;
      const onClick = (btn.getAttribute('onclick')||'').toLowerCase();

      if (onClick.includes('poplistprodweek')) {
        btn.classList.add('cec-btn','cec-btn-clean');
        btn.title = 'Change';
        setLabel(btn, 'Change');
        btn.dataset.cecStyled = '1';
      } else if (onClick.includes('validateserial')) {
        btn.classList.add('cec-btn','cec-btn-clean');
        btn.title = 'Save';
        setLabel(btn, 'Save');
        btn.dataset.cecStyled = '1';
      }
    });
  }

  function hideVariantWebsiteRow(doc){
    const tr = findRowByFirstCellText(doc, 'Variant');
    if (!tr || !tr.cells || tr.cells.length < 2) return;
    const v2 = norm(tr.cells[1].textContent);
    if (v2 === 'website') tr.classList.add('cec-hidden');
  }

  function hideDealerRow(doc){
    const btns = qsa('button, input[type="button"]', doc).filter(b=>{
      const oc = (b.getAttribute('onclick') || '').toLowerCase();
      if (!oc.includes('changeorderdatabytechnician')) return false;
      const txt = norm(b.textContent || b.value || '');
      return txt === 'c' || txt === 'change';
    });

    for (const b of btns){
      const tr = rowOf(b);
      if (!tr) continue;
      if (tr.querySelector('#modelcode')) continue;
      const c0 = tr.cells && tr.cells[0] ? norm(tr.cells[0].textContent) : '';
      if (c0 === 'model') continue;
      tr.classList.add('cec-hidden');
    }
  }

  function highlightTechnician(doc){
    const sel = doc.getElementById('lst_technician') || qs('select[name="lst_technician"]', doc);
    if (!sel) return;
    const tr = rowOf(sel);
    if (!tr) return;

    const update = () => {
      const v = String(sel.value || '').trim();
      const optText = sel.selectedOptions && sel.selectedOptions[0] ? norm(sel.selectedOptions[0].textContent) : '';
      const bad = (!v) || (v === '99') || (optText === 'onbekend');
      const good = !!v && !bad;
      tr.classList.toggle('cec-tech-bad', bad);
      tr.classList.toggle('cec-tech-good', good);
    };

    if (!sel.dataset.cecTechHooked){
      sel.addEventListener('change', update, true);
      sel.dataset.cecTechHooked = '1';
    }
    update();
  }

  function applyExtras(doc){
    hideMonteurRoute(doc);
    styleZIRasButton(doc);
    styleModelButtons(doc);
    styleProductCodeButtons(doc);
    hideVariantWebsiteRow(doc);
    hideDealerRow(doc);
    highlightTechnician(doc);
  }

  const UI_IDS = { gen:'cec-btn-gen', plan:'cec-btn-plan', cus:'cec-btn-cus' };

  function unmountUI(doc){
    try { [UI_IDS.gen, UI_IDS.plan, UI_IDS.cus].forEach(id => doc.getElementById(id)?.remove()); } catch {}
  }

  function mountUI(doc){
    if (!uiEligible(doc)) return false;
    injectCss(doc);
    if (doc.getElementById(UI_IDS.gen)) return true;

    const mk = (id, label, posClass, getHide, setHide) => {
      const btn = doc.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.className = 'cec-toggle cec-never-hide ' + posClass;

      const render = () => { btn.textContent = `${label}: ${getHide() ? 'Show' : 'Hide'}`; };

      btn.addEventListener('click', () => {
        setHide(!getHide());
        render();
        enforceAll();
      });

      (doc.body || doc.documentElement).appendChild(btn);
      render();
    };

    mk(UI_IDS.gen,  'Hidden fields',               'cec-pos1', () => state.hideGeneral,  v => state.hideGeneral  = v);
    mk(UI_IDS.plan, 'Planning block',              'cec-pos2', () => state.hidePlanning, v => state.hidePlanning = v);
    mk(UI_IDS.cus,  'Customer (Owner & Delivery)', 'cec-pos3', () => state.hideCustomer, v => state.hideCustomer = v);

    return true;
  }

  function enforce(doc){
    if (!uiEligible(doc)) {
      unmountUI(doc);
      applyExtras(doc);
      return;
    }
    applyHideList(doc, TARGETS_GENERAL, state.hideGeneral);
    applyHideList(doc, TARGETS_PLANNING, state.hidePlanning);
    applyHideFieldsets(doc, FIELDSETS_CUSTOMER, state.hideCustomer);
    applyExtras(doc);
    mountUI(doc);
  }

  const allDocs = new Set();
  const observers = new WeakMap();

  function watchDoc(doc){
    if (!doc || observers.has(doc) || !doc.documentElement) return;

    const rec = { raf:0, pending:false };
    const kick = () => {
      if (rec.pending) return;
      rec.pending = true;
      cancelAnimationFrame(rec.raf);
      rec.raf = requestAnimationFrame(() => {
        rec.pending = false;
        try { enforce(doc); } catch {}
      });
    };

    const obs = new MutationObserver(()=>kick());
    obs.observe(doc.documentElement, { subtree:true, childList:true, attributes:true });
    observers.set(doc, obs);

    try {
      doc.addEventListener('click', (ev) => {
        const t = ev.target;
        const el = t?.closest?.('#tbl, #rw_tabs, td[onclick*="sel("], div.tab');
        if (!el) return;
        setTimeout(() => { try { sweepAllWindows(window); } catch {} }, 50);
        setTimeout(() => { try { sweepAllWindows(window); } catch {} }, 250);
        setTimeout(() => { try { sweepAllWindows(window); } catch {} }, 800);
      }, true);
    } catch {}
  }

  function attachDoc(doc){
    if (!doc || allDocs.has(doc)) return;
    allDocs.add(doc);
    injectCss(doc);
    watchDoc(doc);
    enforce(doc);
  }

  function hookFramesInDoc(doc){
    try {
      qsa('iframe, frame', doc).forEach(fr=>{
        if (fr.__cecHooked) return;
        fr.__cecHooked = true;
        fr.addEventListener('load', () => {
          try {
            const idoc = fr.contentDocument || fr.contentWindow?.document;
            if (idoc) attachDoc(idoc);
          } catch {}
        }, true);
      });
    } catch {}
  }

  function sweepAllWindows(rootWin){
    const stack = [rootWin];
    const seenWins = new Set();

    while (stack.length){
      const w = stack.pop();
      if (!w || seenWins.has(w)) continue;
      seenWins.add(w);

      try {
        const d = w.document;
        if (d) { attachDoc(d); hookFramesInDoc(d); }
      } catch {}

      try {
        if (w.frames && w.frames.length){
          for (let i=0; i<w.frames.length; i++) stack.push(w.frames[i]);
        }
      } catch {}
    }
  }

  function enforceAll(){
    allDocs.forEach(d => { try { enforce(d); } catch {} });
  }

  try {
    sweepAllWindows(window);
    enforceAll();
    setInterval(() => {
      try { sweepAllWindows(window); enforceAll(); } catch {}
    }, 1500);
  } catch {}
})();
