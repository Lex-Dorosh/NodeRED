// ==UserScript==
// @name         Groupwise - Credit Batch Processor
// @namespace    froopt/groupwise
// @version      0.2.0
// @description  Batch process orders from pasted pairs: serviceNo + item_id (Claim save + finalize flow)
// @match        https://groupwise.cerepair.nl/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY = 'gw_credit_batch_v1';
  const BASE = 'https://groupwise.cerepair.nl/webos_net/viewtab.ashx?name=reparatie&item_id=';
  const DEBUG = true;

  const CFG = {
    pollMs: 450,
    maxWaitMs: 30000,
    workPrefix: 'Wordt door Samsung gecrediteerd GRMS - ',
    labourVisit: '229',
    labourNoVisit: '6745',
    exchangeReason: 'G',
    iris: {
      condition: '1',
      section: 'G00',
      defectFirstNonEmpty: true,
      repair: 'Z'
    }
  };

  const log = (...a) => DEBUG && console.log('[GW-BATCH]', ...a);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let inTick = false;

  async function getState() { return (await GM_getValue(KEY, null)); }
  async function setState(s) { await GM_setValue(KEY, s); log('STATE', s); }

  function allDocs() {
    const docs = []; const seen = new Set();
    function add(d){ if (d && !seen.has(d)) { seen.add(d); docs.push(d); } }
    function walk(w){
      try { add(w.document); } catch { return; }
      let frames = [];
      try { frames = [...w.document.querySelectorAll('frame,iframe')]; } catch {}
      for (const f of frames) { try { if (f.contentWindow) walk(f.contentWindow); else add(f.contentDocument); } catch {} }
    }
    walk(window); try { if (window.top !== window) walk(window.top); } catch {}
    return docs;
  }

  function q(sel) {
    for (const d of allDocs()) { const el = d.querySelector(sel); if (el) return el; }
    return null;
  }
  function qAll(sel) {
    const out = [];
    for (const d of allDocs()) out.push(...d.querySelectorAll(sel));
    return out;
  }

  function isVisible(el) {
    if (!el) return false;
    const w = el.ownerDocument?.defaultView;
    const cs = w?.getComputedStyle(el);
    if (!cs) return true;
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  async function waitFor(fn, label, timeout = CFG.maxWaitMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) { log(`waitFor ${label} OK in ${Date.now()-t0}ms`); return v; }
      await sleep(CFG.pollMs);
    }
    log(`waitFor ${label} TIMEOUT`);
    return null;
  }

  function currentItemId() {
    const m = location.href.match(/[?&]item_id=(\d+)/i);
    return m ? m[1] : '';
  }

  function parsePairs(text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    const arr = [];
    for (let i = 0; i < toks.length - 1; i += 2) {
      const serviceNo = toks[i];
      const itemId = toks[i+1];
      if (/^\d{8,}$/.test(serviceNo) && /^\d{6,8}$/.test(itemId)) arr.push({ serviceNo, itemId });
    }
    return arr;
  }

  function upsertOverlay() {
    let hostDoc = document;
    try { if (window.top?.document) hostDoc = window.top.document; } catch {}
    if (hostDoc.getElementById('gwBatchOverlay')) return;

    const wrap = hostDoc.createElement('div');
    wrap.id = 'gwBatchOverlay';
    wrap.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:10px;padding:10px;width:360px;font:12px system-ui';
    wrap.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Credit Batch</div>
      <textarea id="gwBatchInput" placeholder="Paste two columns: serviceNo itemId" style="width:100%;height:90px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:6px"></textarea>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="gwBatchStart" style="flex:1">Start</button>
        <button id="gwBatchStop" style="flex:1">Stop</button>
      </div>
      <div id="gwBatchStatus" style="margin-top:8px;color:#93c5fd">idle</div>
    `;
    hostDoc.body.appendChild(wrap);

    wrap.querySelector('#gwBatchStart').onclick = async () => {
      const txt = wrap.querySelector('#gwBatchInput').value;
      const jobs = parsePairs(txt);
      if (!jobs.length) { setStatus('No valid rows'); return; }
      await setState({ running: true, idx: 0, jobs, step: 'navigate' });
      setStatus(`Loaded ${jobs.length} rows`);
      gotoCurrentJob();
    };

    wrap.querySelector('#gwBatchStop').onclick = async () => {
      await GM_deleteValue(KEY);
      setStatus('stopped');
    };
  }

  function setStatus(msg) {
    let hostDoc = document;
    try { if (window.top?.document) hostDoc = window.top.document; } catch {}
    const el = hostDoc.getElementById('gwBatchStatus');
    if (el) el.textContent = msg;
  }

  function gotoCurrentJob(state) {
    const st = state;
    if (!st || !st.jobs?.length || st.idx >= st.jobs.length) return;
    const itemId = st.jobs[st.idx].itemId;
    const target = BASE + itemId;
    if (!location.href.includes('item_id=' + itemId) || !location.href.includes('name=reparatie')) {
      location.href = target;
    }
  }

  function firstNonEmptyOption(selectEl) {
    return [...selectEl.options].find(o => (o.value || '').trim() !== '') || null;
  }

  async function fillRepairPage(st) {
    const job = st.jobs[st.idx];

    const wd = await waitFor(() => q('#workdescription'), 'workdescription');
    if (!wd) throw new Error('workdescription missing');
    wd.value = CFG.workPrefix + job.serviceNo;
    wd.dispatchEvent(new Event('change', { bubbles: true }));
    wd.dispatchEvent(new Event('blur', { bubbles: true }));

    const rma = await waitFor(() => q('#rma_responsenumber'), 'rma_responsenumber');
    if (!rma) throw new Error('rma_responsenumber missing');
    rma.value = job.serviceNo;
    rma.dispatchEvent(new Event('change', { bubbles: true }));
    rma.dispatchEvent(new Event('blur', { bubbles: true }));

    const ordertype = await waitFor(() => q('#ordertype'), 'ordertype');
    if (!ordertype) throw new Error('ordertype missing');
    ordertype.focus();
    ordertype.value = '5'; // Omruil
    ordertype.dispatchEvent(new Event('change', { bubbles: true }));
    const okOrderType = q('#btn_swapordertype');
    if (okOrderType) {
      const w = okOrderType.ownerDocument?.defaultView || window;
      const origConfirm = w.confirm;
      w.confirm = () => true;
      try { okOrderType.click(); } finally { w.confirm = origConfirm; }
    }

    await sleep(900);

    // parts used -> 0
    const usedInputs = qAll('input[name^="partid_"]');
    for (const inp of usedInputs) {
      if ((inp.value || '').trim() !== '0') {
        inp.value = '0';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(350);
      }
    }

    // technician first option if empty
    const tech = q('#lst_technician');
    if (tech && !tech.value) {
      const first = firstNonEmptyOption(tech);
      if (first) {
        tech.value = first.value;
        tech.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // labour by blog keyword
    const blogTxt = (q('#div_comment')?.innerText || q('#div_comment')?.textContent || '').toLowerCase();
    const hadVisit = blogTxt.includes('bevestiging afspraak op');
    const labourCode = hadVisit ? CFG.labourVisit : CFG.labourNoVisit;

    const labourSel = q('#jobbcode');
    if (labourSel) {
      labourSel.value = labourCode;
      labourSel.dispatchEvent(new Event('change', { bubbles: true }));
      const addBtn = qAll('button').find(b => (b.textContent || '').trim().toLowerCase() === 'add');
      if (addBtn) addBtn.click();
      await sleep(500);
    }

    // IRIS
    const irisBtn = q('#btn_iriscodes');
    if (irisBtn) {
      irisBtn.click();
      await sleep(500);

      const cond = q('#lst_condition');
      if (cond) { cond.value = CFG.iris.condition; cond.dispatchEvent(new Event('change', { bubbles: true })); }

      const sym = q('#lst_symptom');
      if (sym) {
        const first = firstNonEmptyOption(sym);
        if (first) { sym.value = first.value; sym.dispatchEvent(new Event('change', { bubbles: true })); }
      }

      const sec = q('#lst_section');
      if (sec) {
        const target = [...sec.options].find(o => o.value === CFG.iris.section) || firstNonEmptyOption(sec);
        if (target) { sec.value = target.value; sec.dispatchEvent(new Event('change', { bubbles: true })); }
      }

      const def = q('#lst_defect');
      if (def) {
        const first = firstNonEmptyOption(def);
        if (first) { def.value = first.value; def.dispatchEvent(new Event('change', { bubbles: true })); }
      }

      const rep = q('#lst_repair');
      if (rep) {
        const target = [...rep.options].find(o => o.value === CFG.iris.repair) || firstNonEmptyOption(rep);
        if (target) { rep.value = target.value; rep.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }

    await setState({ ...st, step: 'to_claim' });
    clickTabByText('Claim');
  }

  function clickTabByText(txt) {
    const target = String(txt || '').trim().toLowerCase();

    const tabs = qAll('#rw_tabs div.tab');
    const tab = tabs.find(t => String(t.textContent || '').trim().toLowerCase() === target);
    if (tab && tab.parentElement) {
      tab.parentElement.click();
      return true;
    }

    const td = qAll('td[id^="td"]').find(x => (x.textContent || '').toLowerCase().includes(target));
    if (td) { td.click(); return true; }
    return false;
  }

  async function fillClaimPage(st) {
    const reason = await waitFor(() => q('#reason_of_exchange'), 'reason_of_exchange');
    if (!reason) throw new Error('reason_of_exchange missing');
    reason.value = CFG.exchangeReason;
    reason.dispatchEvent(new Event('change', { bubbles: true }));

    const saveBtn = await waitFor(() => q('#opslaan,button#opslaan,input#opslaan'), 'opslaan_claim');
    if (!saveBtn) throw new Error('opslaan missing on claim');
    saveBtn.click();

    await setState({ ...st, step: 'to_repair_after_claim' });
    await sleep(700);
    clickTabByText('Repair');
  }

  async function finalizeRepair(st) {
    const readyBtn = qAll('button').find(b => (b.textContent || '').toLowerCase().includes('gereed'));
    if (readyBtn) {
      readyBtn.click();
      await sleep(900);
    }

    const statusSel = q('#lst_status');
    if (statusSel) {
      const target = [...statusSel.options].find(o => /administratief\s+afgewikkeld/i.test(o.textContent || ''));
      if (target) {
        statusSel.value = target.value;
        statusSel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        log('Administratief afgewikkeld not found yet; skip');
      }
    }

    // Best effort email/SMS automation hooks (popup automation may vary)
    const mailBtn = q('#btn_mail_klant');
    if (mailBtn) mailBtn.click();
    await sleep(900);

    // try same-window popup fallback selectors
    const mailTpl = q('#naam');
    if (mailTpl) {
      const credit = [...mailTpl.options].find(o => /credit akkoord/i.test(o.textContent || ''));
      if (credit) {
        mailTpl.value = credit.value;
        mailTpl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
        const stuurBtn = qAll('button').find(b => (b.textContent || '').trim().toLowerCase() === 'stuur');
        if (stuurBtn) stuurBtn.click();
      }
    }

    const smsBtn = q('#btn_sms');
    if (smsBtn) smsBtn.click();
    await sleep(900);

    const smsTpl = q('#lst_tekst');
    if (smsTpl) {
      const option = [...smsTpl.options].find(o => /melding reactie op email/i.test(o.textContent || ''));
      if (option) {
        smsTpl.value = option.value;
        smsTpl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
        const send = q('#btnsend');
        if (send) send.click();
      }
    }

    const nextIdx = st.idx + 1;
    if (nextIdx >= st.jobs.length) {
      await GM_deleteValue(KEY);
      setStatus('Done: all rows processed');
      return;
    }

    const next = { ...st, idx: nextIdx, step: 'navigate' };
    await setState(next);
    gotoCurrentJob(next);
  }

  async function tick() {
    if (inTick) return;
    inTick = true;

    try {
      const st = await getState();
      if (!st?.running) return;

      const itemId = currentItemId();
      const current = st.jobs?.[st.idx];
      if (!current) return;

      setStatus(`Running ${st.idx + 1}/${st.jobs.length} | step=${st.step} | item=${current.itemId}`);

      if (st.step === 'navigate') {
        gotoCurrentJob(st);
        if (itemId === current.itemId && location.href.includes('name=reparatie')) {
          await setState({ ...st, step: 'repair_fill' });
        }
        return;
      }

      if (itemId !== current.itemId) return;

      const page = (location.href.match(/[?&]name=([^&]+)/i)?.[1] || '').toLowerCase();
      if (st.step === 'repair_fill' && page === 'reparatie') return await fillRepairPage(st);
      if (st.step === 'to_claim' && page === 'claim') return await fillClaimPage(st);
      if (st.step === 'to_repair_after_claim' && page === 'reparatie') {
        await setState({ ...st, step: 'finalize' });
        return;
      }
      if (st.step === 'finalize' && page === 'reparatie') return await finalizeRepair(st);
    } catch (e) {
      const st = await getState();
      log('ERROR', e);
      if (st) await setState({ ...st, step: 'error', error: String(e?.message || e) });
      setStatus('ERROR: ' + (e?.message || e));
    } finally {
      inTick = false;
    }
  }

  function boot() {
    if (window.top !== window) return;
    upsertOverlay();
    setInterval(tick, 700);
    tick();
  }

  boot();
})();
