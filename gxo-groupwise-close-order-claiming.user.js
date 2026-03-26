// ==UserScript==
// @name GXO Groupwise - Close order (Claiming) v1.0
// @namespace https://groupwise.cerepair.nl/
// @version 1.0.4
// @description Close order (claiming): original flow preserved, workdescription write disabled.
// @author you
// @match https://groupwise.cerepair.nl/*
// @run-at document-end
// @grant none
//
// Optional (recommended for GitHub auto-updates):
// @homepageURL  https://github.com/Lex-Dorosh/NodeRED
// @supportURL   https://github.com/Lex-Dorosh/NodeRED/issues
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/gxo-groupwise-close-order-claiming.user.js
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/gxo-groupwise-close-order-claiming.user.js
// ==/UserScript==

(function () {
 'use strict';

 const DEBUG = false;

 const STATE_KEY = 'gxo_close_order_claim_v1_0';
 const TTL_MS = 20 * 60 * 1000;

 const POLL_MS = 450;
 const MAX_POLLS_PER_STEP = 60;

 const OK_PHRASES = [
 'is er inderdaad geen reparatie verricht',
 'update geslaagd'
 ];

 const STEP = {
 IDLE: 'idle',
 WD_SAVE: 'wdSave',
 CHECK_TECH: 'checkTech',
 SET_ADMIN: 'setAdmin',
 SET_AFG: 'setAfgewikkeld',
 WAIT_AFG: 'waitAfgewikkeld',
 DONE: 'done',
 HALTED: 'halted'
 };

 function log(...a) { if (DEBUG) console.log('[CloseOrder:Claim]', ...a); }

 function sGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
 function sSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } }
 function sRemove(k) { try { sessionStorage.removeItem(k); } catch {} }

 function readState() {
 const raw = sGet(STATE_KEY);
 if (!raw) return null;
 try { return JSON.parse(raw); } catch { return null; }
 }
 function writeState(st) { sSet(STATE_KEY, JSON.stringify(st || {})); }

 function resetState() {
 sRemove(STATE_KEY);
 log('State reset.');
 }

 function isRepairPage() {
 return location.pathname.includes('edit.ashx') && location.search.includes('name=reparatie');
 }

 function getOrderIdFromUrl() {
 try {
 const u = new URL(location.href);
 const id = u.searchParams.get('item_id');
 return (id && /^\d+$/.test(id)) ? id : null;
 } catch { return null; }
 }

 function ensureFreshState() {
 const st = readState();
 if (!st) return;

 const now = Date.now();
 const age = now - (Number(st.ts) || 0);
 if (age > TTL_MS) {
 resetState();
 return;
 }

 const cur = getOrderIdFromUrl();
 if (st.orderId && cur && st.orderId !== cur) {
 resetState();
 }
 }

 function setStep(step, poll = 0) {
 const st = readState() || {};
 st.orderId = getOrderIdFromUrl() || st.orderId || null;
 st.step = step;
 st.poll = poll;
 st.ts = Date.now();
 writeState(st);
 log('Step ->', step);
 }

 function halt(reason) {
 const st = readState() || {};
 st.step = STEP.HALTED;
 st.haltedReason = reason || 'Unknown';
 st.ts = Date.now();
 writeState(st);
 alert('Close order helper stopped: ' + st.haltedReason + '\nUse ↺ or Ctrl+Alt+R to reset.');
 }

 function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

 function triggerChange(el) {
 if (!el) return;
 try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
 try { if (typeof el.onchange === 'function') el.onchange(); } catch {}
 }

 function click(el, label) {
 if (!el) return false;
 log('Click:', label || (el.id || el.value || el.textContent || 'button'));
 try { el.click(); return true; } catch { return false; }
 }

 function opslaanBtn() { return document.getElementById('opslaan'); }
 function statusSel() { return document.getElementById('lst_status'); }
 function commentsEl() { return document.getElementById('comments'); }

 function currentStatusText() {
 const sel = statusSel();
 if (!sel || !sel.selectedOptions || !sel.selectedOptions[0]) return '';
 return (sel.selectedOptions[0].textContent || '').trim();
 }

 function isStatusIncludes(inc, excList = []) {
 const t = norm(currentStatusText());
 const i = norm(inc);
 if (!t.includes(i)) return false;
 for (const ex of excList) if (t.includes(norm(ex))) return false;
 return true;
 }

 function findStatusOption(includesText, excludes = []) {
 const sel = statusSel();
 if (!sel) return null;

 const inc = norm(includesText);
 const exs = (excludes || []).map(norm);
 const opts = Array.from(sel.options || []);

 return opts.find(o => {
 const t = norm(o.textContent);
 if (!t.includes(inc)) return false;
 for (const ex of exs) if (ex && t.includes(ex)) return false;
 return true;
 }) || null;
 }

 function setStatusByOption(opt) {
 const sel = statusSel();
 if (!sel || !opt) return false;

 if (String(sel.value) === String(opt.value)) {
 return true;
 }

 sel.value = String(opt.value);
 triggerChange(sel);
 return true;
 }

 function installJsAutoOkOnce() {
 if (window.__closeorder_jsok_claim_v10) return;
 window.__closeorder_jsok_claim_v10 = true;

 if (window.alert) {
 window.alert = function () {
 return;
 };
 }
 if (window.confirm) {
 window.confirm = function () {
 return true;
 };
 }
 }

 function hasAnyOkPhrase() {
 const bodyText = norm(document.body && document.body.innerText ? document.body.innerText : '');
 return OK_PHRASES.some(p => bodyText.includes(norm(p)));
 }

 function clickVisibleOkButtonOnce() {
 if (!hasAnyOkPhrase()) return false;

 const candidates = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
 .filter(el => {
 const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
 return r && r.width > 0 && r.height > 0;
 })
 .filter(el => {
 const t = norm(el.textContent);
 const v = norm(el.value);
 const s = (t + ' ' + v).trim();
 return s === 'ok' || s === 'oke' || s === 'ja' || s === 'yes';
 });

 if (!candidates.length) return false;
 try { candidates[0].click(); return true; } catch { return false; }
 }

 function injectUI() {
 const ta = commentsEl();
 if (!ta) return;
 if (document.querySelector('.closeorder-claim-after-remarks')) return;

 const wrap = document.createElement('div');
 wrap.className = 'closeorder-claim-after-remarks';
 wrap.style.display = 'inline-flex';
 wrap.style.alignItems = 'flex-start';
 wrap.style.gap = '6px';
 wrap.style.marginLeft = '8px';
 wrap.style.verticalAlign = 'top';

 function styleBtn(btn) {
 btn.type = 'button';
 btn.className = 'button';
 btn.style.whiteSpace = 'nowrap';
 btn.style.fontSize = '9px';
 btn.style.padding = '2px 6px';
 btn.style.minHeight = '18px';
 }

 const btnClose = document.createElement('button');
 btnClose.textContent = 'Close order';
 styleBtn(btnClose);
 btnClose.title = 'Claiming flow: requires "Technisch afgewikkeld" -> Administratief afgewikkeld -> Afgewikkeld.';
 btnClose.addEventListener('click', () => startFlow());

 const btnReset = document.createElement('button');
 btnReset.textContent = '↺';
 styleBtn(btnReset);
 btnReset.style.width = '26px';
 btnReset.title = 'Reset (Ctrl+Alt+R)';
 btnReset.addEventListener('click', () => {
 resetState();
 alert('Close order helper reset.');
 });

 wrap.appendChild(btnClose);
 wrap.appendChild(btnReset);
 ta.insertAdjacentElement('afterend', wrap);
 }

 function startFlow() {
 const orderId = getOrderIdFromUrl();
 if (!orderId) {
 alert('Close order helper: cannot find item_id in the URL.');
 return;
 }
 writeState({
 orderId,
 step: STEP.WD_SAVE,
 poll: 0,
 ts: Date.now(),
 wdWritten: true,
 wdSaved: true
 });
 installJsAutoOkOnce();
 setTimeout(runOnce, 200);
 }

 function runOnce() {
 if (!isRepairPage()) return;

 ensureFreshState();
 const st = readState();
 if (!st) return;

 if (st.step === STEP.IDLE || st.step === STEP.DONE || st.step === STEP.HALTED) return;

 installJsAutoOkOnce();
 clickVisibleOkButtonOnce();

 const poll = Number(st.poll || 0);
 if (poll > MAX_POLLS_PER_STEP) {
 halt('Timeout step=' + st.step + ' status=' + (currentStatusText() || '(unknown)'));
 return;
 }

 function repoll(nextStepSame = true) {
 const st2 = readState() || st;
 st2.poll = nextStepSame ? (poll + 1) : 0;
 st2.ts = Date.now();
 writeState(st2);
 setTimeout(runOnce, POLL_MS);
 }

 switch (st.step) {
 case STEP.WD_SAVE: {
 setStep(STEP.CHECK_TECH, 0);
 return repoll(false);
 }

 case STEP.CHECK_TECH: {
 if (!isStatusIncludes('technisch afgewikkeld')) {
 halt('Claiming: status must be "Technisch afgewikkeld". Current: ' + (currentStatusText() || '(unknown)'));
 return;
 }
 setStep(STEP.SET_ADMIN, 0);
 return repoll(false);
 }

 case STEP.SET_ADMIN: {
 const sel = statusSel();
 if (!sel) return repoll(true);

 const opt = findStatusOption('administratief afgewikkeld', []);
 if (!opt) return repoll(true);

 setStatusByOption(opt);
 setStep(STEP.SET_AFG, 0);
 return;
 }

 case STEP.SET_AFG: {
 const sel = statusSel();
 if (!sel) return repoll(true);

 const opt = findStatusOption('afgewikkeld', ['administratief']);
 if (!opt) return repoll(true);

 setStatusByOption(opt);
 setStep(STEP.WAIT_AFG, 0);
 return;
 }

 case STEP.WAIT_AFG: {
 if (!isStatusIncludes('afgewikkeld', ['administratief'])) return repoll(true);

 setStep(STEP.DONE, 0);
 alert('Close order helper: order closed (Afgewikkeld).');
 return;
 }

 default:
 halt('Unknown step: ' + st.step);
 return;
 }
 }

 function installResetHotkey() {
 const handler = (e) => {
 const key = (e.key || '').toLowerCase();
 if (e.ctrlKey && e.altKey && key === 'r') {
 e.preventDefault();
 resetState();
 try { alert('Close order helper reset.'); } catch {}
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

 window.addEventListener('load', () => {
 if (!isRepairPage()) {
 return;
 }

 ensureFreshState();
 installResetHotkey();
 injectUI();

 const st = readState();
 if (st && st.step && st.step !== STEP.IDLE && st.step !== STEP.DONE && st.step !== STEP.HALTED) {
 installJsAutoOkOnce();
 setTimeout(runOnce, 250);
 }
 });
})();
