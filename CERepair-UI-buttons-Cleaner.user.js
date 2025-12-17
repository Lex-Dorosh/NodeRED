// ==UserScript==
// @name         CERepair-UI-buttons-Cleaner
// @namespace    https://groupwise.cerepair.nl/
// @version      2.95.2
// @description  Cleans side buttons panel: hide/keep rules + config UI (+/−) + per-button colors, stable across frames.
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/CERepair-UI-buttons-Cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/CERepair-UI-buttons-Cleaner.user.js
// ==/UserScript==

(function () {
  "use strict";

  const STYLE_ID = "uic-style";
  const TOGGLE_ID = "uic-show-hidden-toggle";
  const CONFIG_ID = "uic-config-toggle";
  const CONFIG_PANEL_ID = "uic-config-panel";
  const HIDDEN_CLASS = "uic-hidden";
  const TOGGLE_ATTR = "data-uic-can-toggle";
  const KEY_ATTR = "data-uic-key";
  const CTL_ATTR = "data-uic-ctl";
  const ITEM_ATTR = "data-uic-item";
  const SIDE_ID = "side_buttons";

  const INTERN_SPAN_ID = "span_intern";
  const CUSTOMER_SPAN_ID = "span_klant";
  const OWNER_SPAN_ID = "span_eigenaar";
  const BEREKEN_VALUE = /^bereken$/i;

  const PREF_KEY = "uic_btn_cleaner_prefs_v1";

  const HIDE_IDS = new Set(["Button1", "btn_servicearticle", "btn_scanner"]);
  const EXCLUDE_IDS = new Set(["btn_mail_gereed"]); // Gereedmelding: excluded from UI/config + always hidden

  const HIDE_TEXT = [
    /^print\s*blog$/i,
    /^@\s*leverancier$/i,
    /^wb\s*klant$/i,
    /^bon\s*z\.?k\.?\s*\(@\)$/i,
    /^contantbon\(@\)$/i,
    /^contantbon\(pr\)$/i,
    /^ontvangstb\.\(pr\.\)$/i,
    /^ontvangstb\.\(@\)$/i,
    /^wms\s*rep\s*artikel$/i,
    /^track\s*&\s*trace$/i,
    /^scanner$/i,
    /^naleveringbon$/i,
    /^betaald\?$/i
  ];

  const KEEP_TEXT = [/^iriscodes$/i, /^kopieer$/i];

  const safeGetLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSetLS = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };

  const loadPrefs = () => {
    try {
      const raw = safeGetLS(PREF_KEY);
      const obj = JSON.parse(raw || "{}");
      return {
        forceHide: (obj && obj.forceHide && typeof obj.forceHide === "object") ? obj.forceHide : {},
        forceKeep: (obj && obj.forceKeep && typeof obj.forceKeep === "object") ? obj.forceKeep : {},
        colors: (obj && obj.colors && typeof obj.colors === "object") ? obj.colors : {}
      };
    } catch {
      return { forceHide: {}, forceKeep: {}, colors: {} };
    }
  };

  const savePrefs = (prefs) => safeSetLS(PREF_KEY, JSON.stringify({
    forceHide: prefs.forceHide || {},
    forceKeep: prefs.forceKeep || {},
    colors: prefs.colors || {}
  }));

  const resetOverrides = () => savePrefs({ forceHide: {}, forceKeep: {}, colors: {} });

  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const isBtn = (el) => el && el.tagName === "INPUT" && el.classList.contains("button");
  const matchAny = (txt, arr) => arr.some(re => re.test(norm(txt || "")));

  function onclickSig(btn) {
    const oc = String(btn.getAttribute("onclick") || "").trim();
    const m = oc.match(/^\s*([a-zA-Z_$][\w$]*)\s*\(/);
    if (m) return m[1];
    return norm(oc.replace(/\d+/g, "#").slice(0, 80));
  }

  function buttonKey(btn) {
    const id = String(btn.id || "").trim();
    if (id) return `id:${id}`;
    const label = norm(btn.value || btn.textContent || "");
    const name = norm(btn.name || "");
    const fn = onclickSig(btn);
    const title = norm(btn.title || "");
    return `sig:${label}|${fn}|${name}|${title}`.slice(0, 220);
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function injectCss(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const css = `
      .${HIDDEN_CLASS}{display:none !important;}

      #${TOGGLE_ID}, #${CONFIG_ID}{
        display:none;margin:4px 6px 6px 6px;padding:6px 10px;border:1px solid #ced4da;border-radius:10px;
        background:#f8f9fa;color:#212529;cursor:pointer;font-size:12px;position:relative;z-index:2147483646;
      }
      #${CONFIG_ID}{
        width:32px;height:32px;padding:0;display:none;align-items:center;justify-content:center;font-size:16px;font-weight:900;
        background:#fff7ed;border-color:#fed7aa;
      }

      #${CONFIG_PANEL_ID}{
        display:none;margin:4px 6px 6px 6px;padding:6px 8px;border:1px dashed #cbd5e1;border-radius:12px;background:#ffffff;
      }
      #${CONFIG_PANEL_ID} .uic-cfgbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      #${CONFIG_PANEL_ID} .uic-cfg-title{font-weight:800;color:#0f172a;font-size:12px;margin-right:4px;}
      #${CONFIG_PANEL_ID} .uic-iconbtn{
        display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:10px;
        border:1px solid #d0d5dd;background:#f8fafc;cursor:pointer;user-select:none;font-size:14px;padding:0;
      }
      #${CONFIG_PANEL_ID} .uic-iconbtn:hover{filter:brightness(0.98);}
      #${CONFIG_PANEL_ID} .uic-file{display:none;}
      #${CONFIG_PANEL_ID} .uic-legend{font-size:11px;color:#475569;margin-left:6px;white-space:nowrap;}

      .uic-config-mode br{display:none !important;}
      .uic-config-mode input.button{display:inline-block !important;}

      .uic-item{
        display:inline-flex;align-items:center;gap:4px;margin:0 6px 6px 0;padding:2px 4px;border-radius:10px;border:1px solid transparent;vertical-align:middle;
      }
      .uic-item input.button{margin:0 !important;vertical-align:middle !important;}
      .uic-item.uic-item-hide{border-color:#fecaca;background:#fff1f2;}
      .uic-item.uic-item-keep{border-color:#bbf7d0;background:#f0fdf4;}

      .uic-ctl{display:inline-flex;align-items:center;gap:3px;margin-left:2px;}
      .uic-ctl button{
        width:20px;height:20px;line-height:18px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:900;font-size:12px;padding:0;
      }
      .uic-ctl .uic-plus{border-color:#bbf7d0;background:#f0fdf4;}
      .uic-ctl .uic-minus{border-color:#fecaca;background:#fff1f2;}
      .uic-ctl .uic-colorbtn{border-color:#bfdbfe;background:#eff6ff;}
      .uic-ctl .uic-colorreset{border-color:#e5e7eb;background:#f8fafc;}

      .uic-panel{border:1px solid #e5e7eb;border-radius:12px;padding:10px;background:#ffffff;margin:8px 0 10px 6px;}
      .uic-panel h4{margin:0 0 8px 0;font-size:14px;font-weight:800;color:#111827;}

      .uic-co-grid{display:grid;grid-template-columns:1fr;gap:8px;}
      .uic-co-box{border:1px solid #e5e7eb;border-radius:12px;padding:8px;background:#ffffff;}
      .uic-co-customer{border-left:4px solid #60a5fa;background:#eff6ff;}
      .uic-co-owner{border-left:4px solid #a78bfa;background:#faf5ff;}
      .uic-co-title{font-weight:900;color:#0f172a;font-size:12px;margin:0 0 6px 0;}
      .uic-co-btns{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
      .uic-co-btns .button{
        border:1px solid #d0d5dd !important;border-radius:8px !important;background:#f3f4f6 !important;color:#111827 !important;
        padding:4px 6px !important;height:24px !important;
      }
    `;
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function isEmptyInlineEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (!["B", "P", "SPAN", "I", "EM", "STRONG"].includes(tag)) return false;
    if (el.querySelector("input,button,select,textarea,div,table,fieldset")) return false;
    return !String(el.textContent || "").trim();
  }

  function isIgnorableNode(n) {
    if (!n) return true;
    if (n.nodeType === 8) return true;
    if (n.nodeType === 3) return !n.nodeValue.trim();
    if (n.nodeType === 1) return isEmptyInlineEl(n);
    return false;
  }

  function removeBrAround(node) {
    if (!node || !node.parentNode) return;

    let n = node.nextSibling;
    while (n && isIgnorableNode(n)) { const r = n; n = n.nextSibling; try { r.remove(); } catch {} }
    while (n && n.nodeType === 1 && n.tagName === "BR") { const r = n; n = n.nextSibling; try { r.remove(); } catch {} }

    n = node.previousSibling;
    while (n && isIgnorableNode(n)) { const r = n; n = n.previousSibling; try { r.remove(); } catch {} }
    while (n && n.nodeType === 1 && n.tagName === "BR") { const r = n; n = n.previousSibling; try { r.remove(); } catch {} }
  }

  function isHiddenBySite(btn) {
    if (!btn) return false;
    try {
      const win = btn.ownerDocument && btn.ownerDocument.defaultView;
      const cs = win ? win.getComputedStyle(btn) : null;
      return !!(cs && cs.display === "none");
    } catch {
      return String(btn.style && btn.style.display || "") === "none";
    }
  }

  function compactSideLayout(side, inConfigMode) {
    if (!side) return;

    try {
      side.querySelectorAll("b,p,span,i,em,strong").forEach(el => {
        if (isEmptyInlineEl(el)) el.remove();
      });
    } catch {}

    const nodes = Array.from(side.childNodes);
    let brRun = 0;

    for (const n of nodes) {
      if (!n || !n.parentNode) continue;

      if (n.nodeType === 1 && n.tagName === "BR") {
        brRun++;
        if (brRun > 1) { try { n.remove(); } catch {} }
        continue;
      }

      if (isIgnorableNode(n)) {
        if (n.nodeType === 1) { try { n.remove(); } catch {} }
        continue;
      }

      brRun = 0;
    }

    while (side.firstChild && isIgnorableNode(side.firstChild)) { try { side.firstChild.remove(); } catch { break; } }
    while (side.lastChild && isIgnorableNode(side.lastChild)) { try { side.lastChild.remove(); } catch { break; } }
    while (side.firstChild && side.firstChild.nodeType === 1 && side.firstChild.tagName === "BR") { try { side.firstChild.remove(); } catch { break; } }
    while (side.lastChild && side.lastChild.nodeType === 1 && side.lastChild.tagName === "BR") { try { side.lastChild.remove(); } catch { break; } }

    if (!inConfigMode) {
      Array.from(side.querySelectorAll("input.button")).forEach(btn => {
        if (isHiddenBySite(btn)) removeBrAround(btn);
      });
    }

    const nodes2 = Array.from(side.childNodes);
    let brRun2 = 0;
    for (const n of nodes2) {
      if (!n || !n.parentNode) continue;

      if (n.nodeType === 1 && n.tagName === "BR") {
        brRun2++;
        if (brRun2 > 1) { try { n.remove(); } catch {} }
        continue;
      }

      if (isIgnorableNode(n)) {
        if (n.nodeType === 1) { try { n.remove(); } catch {} }
        continue;
      }

      brRun2 = 0;
    }
  }

  function defaultShouldHide(btn) {
    if (!isBtn(btn)) return false;
    if (btn.id && EXCLUDE_IDS.has(btn.id)) return true;
    if (btn.id && HIDE_IDS.has(btn.id)) return true;
    const val = btn.value || btn.textContent || "";
    return matchAny(val, HIDE_TEXT);
  }

  function defaultShouldKeep(btn) {
    const val = btn.value || btn.textContent || "";
    return matchAny(val, KEEP_TEXT);
  }

  function decideHide(btn, prefs) {
    if (btn.id && EXCLUDE_IDS.has(btn.id)) return true;
    const key = btn.getAttribute(KEY_ATTR) || buttonKey(btn);
    if (prefs.forceKeep && prefs.forceKeep[key]) return false;
    if (prefs.forceHide && prefs.forceHide[key]) return true;
    if (defaultShouldKeep(btn)) return false;
    return defaultShouldHide(btn);
  }

  function hexToRgb(hex) {
    const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  function pickTextColor(bg) {
    const rgb = hexToRgb(bg);
    if (!rgb) return "#ffffff";
    const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    return yiq >= 160 ? "#111827" : "#ffffff";
  }

  function applyBtnColor(btn, color) {
    if (!btn) return;
    if (!color) {
      btn.style.removeProperty("background-color");
      btn.style.removeProperty("border-color");
      btn.style.removeProperty("color");
      return;
    }
    const txt = pickTextColor(color);
    btn.style.setProperty("background-color", color, "important");
    btn.style.setProperty("border-color", color, "important");
    btn.style.setProperty("color", txt, "important");
  }

  function groupCustomerOwner(doc, side) {
    if (doc.getElementById("uic-cust-owner-panel")) return;

    const cust = doc.getElementById(CUSTOMER_SPAN_ID);
    const own = doc.getElementById(OWNER_SPAN_ID);
    if (!cust && !own) return;

    const panel = doc.createElement("div");
    panel.id = "uic-cust-owner-panel";
    panel.className = "uic-panel";

    const h = doc.createElement("h4");
    h.textContent = "Customer & Owner";
    panel.appendChild(h);

    const grid = doc.createElement("div");
    grid.className = "uic-co-grid";
    panel.appendChild(grid);

    const makeBox = (title, klass) => {
      const box = doc.createElement("div");
      box.className = "uic-co-box " + klass;

      const t = doc.createElement("div");
      t.className = "uic-co-title";
      t.textContent = title;
      box.appendChild(t);

      const btns = doc.createElement("div");
      btns.className = "uic-co-btns";
      box.appendChild(btns);

      return { box, btns };
    };

    const addFromSpan = (span, title, klass) => {
      if (!span) return;
      const { box, btns } = makeBox(title, klass);

      Array.from(span.querySelectorAll("input.button")).forEach(btn => {
        if (!isBtn(btn)) return;
        if (btn.id && EXCLUDE_IDS.has(btn.id)) return;
        btns.appendChild(btn);
      });

      span.style.display = "none";
      grid.appendChild(box);
    };

    addFromSpan(cust, "Customer", "uic-co-customer");
    addFromSpan(own, "Owner", "uic-co-owner");

    const berekenBtn = Array.from(side.querySelectorAll("input.button")).find(b => BEREKEN_VALUE.test(b.value || ""));
    let ref = null;

    if (berekenBtn) {
      if (berekenBtn.parentNode === side) ref = berekenBtn;
      else {
        const wrap = berekenBtn.closest && berekenBtn.closest("span.uic-item");
        if (wrap && wrap.parentNode === side) ref = wrap;
      }
    }

    try {
      if (ref && ref.parentNode === side) side.insertBefore(panel, ref);
      else side.appendChild(panel);
    } catch {
      try { side.appendChild(panel); } catch {}
    }
  }

  const SIDE_STATE = new WeakMap();
  function getSideState(side) {
    let st = SIDE_STATE.get(side);
    if (!st) {
      st = { open: false, config: false, prevOpen: false, applying: false, needApply: false };
      SIDE_STATE.set(side, st);
    }
    return st;
  }

  function requestApply(doc, side) {
    const st = getSideState(side);
    if (st.applying) { st.needApply = true; return; }
    applyToSide(doc, side);
  }

  function createToggle(doc, side) {
    let btn = doc.getElementById(TOGGLE_ID);
    if (!btn) {
      btn = doc.createElement("button");
      btn.id = TOGGLE_ID;
      btn.type = "button";
      side.insertBefore(btn, side.firstChild);
    }
    if (!btn.__uic_bound) {
      btn.__uic_bound = true;
      btn.title = "Temporarily show hidden buttons";
      btn.addEventListener("click", (ev) => {
        const st = getSideState(side);
        st.open = !st.open;
        requestApply(doc, side);
        ev.stopPropagation();
        ev.preventDefault();
      }, true);
    }
    return btn;
  }

  function ensureConfigPanel(doc, side) {
    let panel = doc.getElementById(CONFIG_PANEL_ID);
    if (!panel) {
      panel = doc.createElement("div");
      panel.id = CONFIG_PANEL_ID;
      panel.innerHTML = `
        <div class="uic-cfgbar">
          <span class="uic-cfg-title">Config</span>
          <button type="button" class="uic-iconbtn" id="uic-cfg-export" title="Export settings">⭳</button>
          <label class="uic-iconbtn" title="Import settings">⭱<input type="file" class="uic-file" id="uic-cfg-import" accept="application/json"></label>
          <button type="button" class="uic-iconbtn" id="uic-cfg-reset" title="Reset overrides (back to defaults)">↺</button>
          <span class="uic-legend" title="Legend">+ keep • − hide • 🎨 color</span>
        </div>
      `;
      side.insertBefore(panel, side.firstChild);
    }

    const expBtn = panel.querySelector("#uic-cfg-export");
    const resetBtn = panel.querySelector("#uic-cfg-reset");
    const fileIn = panel.querySelector("#uic-cfg-import");

    if (expBtn && !expBtn.__uic_bound) {
      expBtn.__uic_bound = true;
      expBtn.addEventListener("click", () => {
        downloadJSON("cerepair-ui-buttons-cleaner-settings.json", {
          kind: "CERepair-UI-buttons-Cleaner",
          version: "2.95.2",
          exportedAt: new Date().toISOString(),
          prefs: loadPrefs()
        });
      });
    }

    if (resetBtn && !resetBtn.__uic_bound) {
      resetBtn.__uic_bound = true;
      resetBtn.addEventListener("click", () => {
        resetOverrides();
        requestApply(doc, side);
        alert("Overrides reset. Default rules are active again.");
      });
    }

    if (fileIn && !fileIn.__uic_bound) {
      fileIn.__uic_bound = true;
      fileIn.addEventListener("change", (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;

        const reader = new FileReader();
        reader.onload = () => {
          try {
            const incoming = JSON.parse(String(reader.result || "{}"));
            const p = incoming && incoming.prefs ? incoming.prefs : incoming;
            if (!p || typeof p !== "object") throw new Error("Invalid JSON");

            const forceHide = (p.forceHide && typeof p.forceHide === "object") ? p.forceHide : {};
            const forceKeep = (p.forceKeep && typeof p.forceKeep === "object") ? p.forceKeep : {};
            const colors = (p.colors && typeof p.colors === "object") ? p.colors : {};

            savePrefs({ forceHide, forceKeep, colors });
            requestApply(doc, side);
            alert("Import done.");
          } catch (e) {
            alert("Import failed: " + (e && e.message ? e.message : String(e)));
          } finally {
            ev.target.value = "";
          }
        };
        reader.readAsText(f);
      });
    }

    return panel;
  }

  function createConfigButton(doc, side) {
    let btn = doc.getElementById(CONFIG_ID);
    if (!btn) {
      btn = doc.createElement("button");
      btn.id = CONFIG_ID;
      btn.type = "button";
      side.insertBefore(btn, side.firstChild);
    }
    if (!btn.__uic_bound) {
      btn.__uic_bound = true;
      btn.title = "Configure hidden/kept buttons";
      btn.addEventListener("click", (ev) => {
        const st = getSideState(side);
        st.config = !st.config;
        if (st.config) {
          st.prevOpen = st.open;
          st.open = true;
        } else {
          st.open = st.prevOpen;
        }
        requestApply(doc, side);
        ev.stopPropagation();
        ev.preventDefault();
      }, true);
    }
    return btn;
  }

  function removeConfigUI(side) {
    side.querySelectorAll(`[${CTL_ATTR}="1"]`).forEach(n => n.remove());
    side.querySelectorAll(`span.uic-item[${ITEM_ATTR}="1"]`).forEach(w => {
      const btn = w.querySelector("input.button");
      if (btn) w.parentNode.insertBefore(btn, w);
      w.remove();
    });
    side.classList.remove("uic-config-mode");
  }

  function renderConfigControls(doc, side, prefs) {
    const panel = ensureConfigPanel(doc, side);
    panel.style.display = "block";

    side.classList.add("uic-config-mode");
    removeConfigUI(side);
    side.classList.add("uic-config-mode");

    Array.from(side.querySelectorAll("input.button")).forEach(btn => {
      if (!isBtn(btn)) return;
      if (btn.id && EXCLUDE_IDS.has(btn.id)) return;

      const hasId = !!String(btn.id || "").trim();
      const hasVal = !!String(btn.value || "").trim();
      const hasOnclick = !!String(btn.getAttribute("onclick") || "").trim();
      if (!hasId && !hasVal && !hasOnclick) return;

      const key = btn.getAttribute(KEY_ATTR) || buttonKey(btn);
      btn.setAttribute(KEY_ATTR, key);

      const willHide = decideHide(btn, prefs);

      const wrap = doc.createElement("span");
      wrap.className = "uic-item " + (willHide ? "uic-item-hide" : "uic-item-keep");
      wrap.setAttribute(ITEM_ATTR, "1");

      btn.parentNode.insertBefore(wrap, btn);
      wrap.appendChild(btn);

      const ctl = doc.createElement("span");
      ctl.className = "uic-ctl";
      ctl.setAttribute(CTL_ATTR, "1");

      const plusBtn = doc.createElement("button");
      plusBtn.type = "button";
      plusBtn.className = "uic-plus";
      plusBtn.textContent = "+";
      plusBtn.title = "Keep (always show)";

      const minusBtn = doc.createElement("button");
      minusBtn.type = "button";
      minusBtn.className = "uic-minus";
      minusBtn.textContent = "−";
      minusBtn.title = "Hide (always hide)";

      const colorBtn = doc.createElement("button");
      colorBtn.type = "button";
      colorBtn.className = "uic-colorbtn";
      colorBtn.textContent = "🎨";
      colorBtn.title = "Pick button color";

      const resetBtn = doc.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "uic-colorreset";
      resetBtn.textContent = "✕";
      resetBtn.title = "Reset color";

      const colorIn = doc.createElement("input");
      colorIn.type = "color";
      colorIn.className = "uic-file";

      const curColor = prefs.colors && prefs.colors[key] ? String(prefs.colors[key]) : "";
      if (curColor) {
        colorIn.value = curColor;
        resetBtn.style.display = "";
      } else {
        resetBtn.style.display = "none";
      }

      function applyNow() {
        const p = loadPrefs();
        const c = (p.colors && p.colors[key]) ? String(p.colors[key]) : "";
        applyBtnColor(btn, c || null);
        resetBtn.style.display = c ? "" : "none";
      }

      minusBtn.addEventListener("click", (ev) => {
        const p = loadPrefs();
        p.forceHide[key] = 1;
        if (p.forceKeep[key]) delete p.forceKeep[key];
        if (!savePrefs(p)) alert("Cannot save settings (storage blocked).");
        setTimeout(() => requestApply(doc, side), 0);
        ev.stopPropagation(); ev.preventDefault();
      }, true);

      plusBtn.addEventListener("click", (ev) => {
        const p = loadPrefs();
        p.forceKeep[key] = 1;
        if (p.forceHide[key]) delete p.forceHide[key];
        if (!savePrefs(p)) alert("Cannot save settings (storage blocked).");
        setTimeout(() => requestApply(doc, side), 0);
        ev.stopPropagation(); ev.preventDefault();
      }, true);

      colorBtn.addEventListener("click", (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        colorIn.click();
      }, true);

      colorIn.addEventListener("input", (ev) => {
        const val = String(ev.target.value || "").trim();
        const p = loadPrefs();
        p.colors = p.colors || {};
        p.colors[key] = val;
        savePrefs(p);
        applyNow();
      }, true);

      resetBtn.addEventListener("click", (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        const p = loadPrefs();
        if (p.colors && p.colors[key]) delete p.colors[key];
        savePrefs(p);
        applyNow();
      }, true);

      ctl.appendChild(plusBtn);
      ctl.appendChild(minusBtn);
      ctl.appendChild(colorBtn);
      ctl.appendChild(resetBtn);
      ctl.appendChild(colorIn);

      wrap.appendChild(ctl);

      applyNow();
    });
  }

  function applyToSide(doc, side) {
    const st = getSideState(side);
    if (st.applying) { st.needApply = true; return; }
    st.applying = true;

    try {
      injectCss(doc);

      const intern = doc.getElementById(INTERN_SPAN_ID);
      if (intern) intern.remove();

      const prefs = loadPrefs();
      let hideableCount = 0;

      Array.from(side.querySelectorAll("input.button")).forEach(btn => {
        if (!isBtn(btn)) return;

        if (btn.id && EXCLUDE_IDS.has(btn.id)) {
          btn.classList.add(HIDDEN_CLASS);
          return;
        }

        if (!btn.hasAttribute(KEY_ATTR)) btn.setAttribute(KEY_ATTR, buttonKey(btn));
        const key = btn.getAttribute(KEY_ATTR);

        const hide = decideHide(btn, prefs);

        const c = prefs.colors && prefs.colors[key] ? String(prefs.colors[key]) : "";
        applyBtnColor(btn, c || null);

        if (hide) {
          hideableCount++;
          btn.setAttribute(TOGGLE_ATTR, "1");
          if (!st.open && !st.config) btn.classList.add(HIDDEN_CLASS);
          else btn.classList.remove(HIDDEN_CLASS);

          if (!st.open && !st.config) removeBrAround(btn);
        } else {
          btn.classList.remove(HIDDEN_CLASS);
          btn.removeAttribute(TOGGLE_ATTR);
        }
      });

      groupCustomerOwner(doc, side);

      const tgl = createToggle(doc, side);
      const cfg = createConfigButton(doc, side);
      const cfgPanel = ensureConfigPanel(doc, side);

      cfg.textContent = st.config ? "✓" : "⚙";
      cfg.style.display = "inline-flex";

      tgl.textContent = st.open ? "Hide hidden" : "Show hidden";
      tgl.style.display = hideableCount > 0 ? "inline-block" : "none";

      if (st.config) {
        side.querySelectorAll(`[${TOGGLE_ATTR}="1"]`).forEach(n => n.classList.remove(HIDDEN_CLASS));
        renderConfigControls(doc, side, prefs);
        cfgPanel.style.display = "block";
        side.classList.add("uic-config-on");
      } else {
        cfgPanel.style.display = "none";
        removeConfigUI(side);
        side.classList.remove("uic-config-on");

        side.querySelectorAll(`[${TOGGLE_ATTR}="1"]`).forEach(n => {
          if (st.open) n.classList.remove(HIDDEN_CLASS);
          else n.classList.add(HIDDEN_CLASS);
        });
      }

      compactSideLayout(side, st.config);
    } catch {
    } finally {
      st.applying = false;
      if (st.needApply) {
        st.needApply = false;
        setTimeout(() => applyToSide(doc, side), 0);
      }
    }
  }

  function waitForSide(doc) {
    const ready = () => doc.getElementById(SIDE_ID);
    const now = ready();
    if (now) { requestApply(doc, now); return; }

    const mo = new MutationObserver(() => {
      const el = ready();
      if (el) {
        mo.disconnect();
        requestApply(doc, el);
      }
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
  }

  const seenDocs = new WeakSet();

  function attachToDoc(doc) {
    if (!doc || seenDocs.has(doc)) return;
    seenDocs.add(doc);

    try {
      waitForSide(doc);

      const mo = new MutationObserver((muts) => {
        muts.forEach(m => {
          m.addedNodes && Array.from(m.addedNodes).forEach(n => {
            if (n && (n.tagName === "IFRAME" || n.tagName === "FRAME")) hookFrame(n);
          });
        });
      });
      mo.observe(doc.documentElement, { childList: true, subtree: true });

      Array.from(doc.querySelectorAll("iframe,frame")).forEach(fr => hookFrame(fr));
    } catch {
    }
  }

  function hookFrame(fr) {
    if (!fr || fr.__uic_hooked) return;
    const hook = () => {
      try {
        const idoc = fr.contentDocument || fr.contentWindow?.document;
        if (idoc) attachToDoc(idoc);
      } catch {}
    };
    fr.addEventListener("load", hook, { once: false });
    hook();
    fr.__uic_hooked = true;
  }

  function sweepAllWindows(rootWin) {
    const stack = [rootWin];
    const seenWins = new Set();
    while (stack.length) {
      const w = stack.pop();
      if (!w || seenWins.has(w)) continue;
      seenWins.add(w);
      try { const d = w.document; if (d) attachToDoc(d); } catch {}
      try {
        if (w.frames && w.frames.length) {
          for (let i = 0; i < w.frames.length; i++) stack.push(w.frames[i]);
        }
      } catch {}
    }
  }

  attachToDoc(document);

  let count = 0;
  const iv = setInterval(() => {
    sweepAllWindows(window);
    count++;
    if (count > 60) {
      clearInterval(iv);
      setInterval(() => sweepAllWindows(window), 3000);
    }
  }, 500);
})();
