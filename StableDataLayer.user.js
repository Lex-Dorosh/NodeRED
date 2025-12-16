// ==UserScript==
// @name         CE Repair: Stable Data Layer v9.7
// @namespace    http://tampermonkey.net/
// @version      9.7
// @description  Orders vs comments separated, ignore empty responses, persistent offline/online banners in English
// @match        https://nodered.ceonline.eu:1880/cerepair-dashboard/index.html?report=Vision%20-%20Screening
// @match        https://nodered.ceonline.eu:1880/cerepair-dashboard/index.html?report=Audio%20-%20Screening
// @match        https://nodered.ceonline.eu:1880/cerepair-dashboard/index.html?report=Werkvoorbereiding
// @match        https://nodered.ceonline.eu:1880/cerepair-dashboard/index.html?report=Vision%20Assistentie
// @match        https://nodered.ceonline.eu:1880/cerepair-dashboard/index.html?report=Audio%20Assistentie
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/Stable%20Data%20Layer%20v9.7.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/Stable%20Data%20Layer%20v9.7.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DATA_PREFIX = '/ce-rest/data/';
  const TIMEOUT_MS = 10000;
  const CACHE_TTL_MS = 30 * 60 * 1000;

  const originalFetch = window.fetch;
  const originalJson = Response.prototype.json;

  let offlineBanner = null;
  let wasOffline = false;

  function cacheKeys(url) {
    const key = 'ce_cache_' + url;
    return {
      dataKey: key,
      tsKey: key + '_ts',
      goodKey: 'ce_good_' + url,
      goodTsKey: 'ce_good_' + url + '_ts',
    };
  }

  function safeShapeOrders(json) {
    const safe = {
      menu: {
        Screening: [],
        Planning: [],
        Assistentie: [],
        TAT: [],
        Orders: [],
        Parts: [],
        Wachtkamer: []
      },
      result: [],
      status: "offline-fallback",
      filters: {}
    };
    if (json && typeof json === 'object') {
      if (json.menu) safe.menu = json.menu;
      if (Array.isArray(json.result)) safe.result = json.result;
      if (json.filters) safe.filters = json.filters;
      if (json.status) safe.status = json.status;
    }
    return safe;
  }

  function safeShapeComments(json) {
    return Array.isArray(json) ? json : [];
  }

  function showOfflineBanner(timestamp) {
    if (offlineBanner) return;
    offlineBanner = document.createElement("div");
    offlineBanner.textContent = `⚠ You are offline, using cached snapshot (${timestamp})`;
    Object.assign(offlineBanner.style, {
      position: "fixed",
      top: "40px",
      left: 0,
      width: "100%",
      background: "#ffcc00",
      color: "#000",
      padding: "6px",
      fontWeight: "bold",
      zIndex: 9999,
      textAlign: "center",
    });
    document.body.appendChild(offlineBanner);
  }

  function removeOfflineBanner() {
    if (offlineBanner) {
      offlineBanner.remove();
      offlineBanner = null;
    }
  }

  function showOnlineBanner() {
    const banner = document.createElement("div");
    banner.textContent = "✅ You are back online, data refreshed";
    Object.assign(banner.style, {
      position: "fixed",
      top: "40px",
      left: 0,
      width: "100%",
      background: "#90ee90",
      color: "#000",
      padding: "6px",
      fontWeight: "bold",
      zIndex: 9999,
      textAlign: "center",
    });
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }

  function isComments(url) {
    return String(url).includes("/comments/");
  }

  window.fetch = async function (url, options = {}) {
    if (!String(url).includes(DATA_PREFIX)) {
      return originalFetch(url, options);
    }

    const { dataKey, tsKey, goodKey, goodTsKey } = cacheKeys(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      console.log(`[Cache] Fetching: ${url}`);
      const res = await originalFetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      const clone = res.clone();
      const text = await clone.text();

      try {
        const parsed = JSON.parse(text);
        if (isComments(url)) {
          localStorage.setItem(dataKey, text);
          console.log(`[Cache] Response saved for comments: ${url} → ${parsed.length} comments`);
          Object.defineProperty(res, '__ce_text', { value: text });
          Object.defineProperty(res, '__ce_url', { value: String(url) });
          return res;
        } else {
          const orders = Array.isArray(parsed.result) ? parsed.result.length : 0;
          if (orders > 0) {
            localStorage.setItem(dataKey, text);
            localStorage.setItem(tsKey, Date.now().toString());
            localStorage.setItem(goodKey, text);
            localStorage.setItem(goodTsKey, Date.now().toString());
            console.log(`[Cache] Response saved for: ${url} → ${orders} orders`);
            Object.defineProperty(res, '__ce_text', { value: text });
            Object.defineProperty(res, '__ce_url', { value: String(url) });
            if (wasOffline) {
              removeOfflineBanner();
              showOnlineBanner();
              wasOffline = false;
            }
            return res;
          } else {
            console.warn(`[Cache] Ignoring empty response for: ${url}, using snapshot instead`);
            const good = localStorage.getItem(goodKey);
            const safe = good ? JSON.parse(good) : safeShapeOrders({});
            const res2 = new Response(JSON.stringify(safe), { status: 200, headers: { 'Content-Type': 'application/json' } });
            Object.defineProperty(res2, '__ce_text', { value: JSON.stringify(safe) });
            Object.defineProperty(res2, '__ce_url', { value: String(url) });
            return res2;
          }
        }
      } catch {
        console.warn(`[Cache] Response not saved (invalid JSON) for: ${url}`);
      }

      Object.defineProperty(res, '__ce_text', { value: text });
      Object.defineProperty(res, '__ce_url', { value: String(url) });

      if (wasOffline) {
        removeOfflineBanner();
        showOnlineBanner();
        wasOffline = false;
      }

      return res;
    } catch (e) {
      clearTimeout(timeout);
      console.warn(`[Cache] Error for: ${url}`);

      let json;
      const cached = localStorage.getItem(dataKey);
      const cachedTime = parseInt(localStorage.getItem(tsKey), 10);
      const good = localStorage.getItem(goodKey);

      if (cached && Number.isFinite(cachedTime) && (Date.now() - cachedTime < CACHE_TTL_MS)) {
        try {
          json = JSON.parse(cached);
          console.warn(`[Cache] Using cached data for: ${url}`);
        } catch {
          json = {};
        }
      } else if (good) {
        try {
          json = JSON.parse(good);
          console.warn(`[Cache] Using last good snapshot for: ${url}`);
        } catch {
          json = {};
        }
      } else {
        console.error(`[Cache] No cache available for: ${url}, using safe fallback`);
        json = {};
      }

      if (!wasOffline) {
        const ts = localStorage.getItem(goodTsKey);
        const tsText = ts ? new Date(parseInt(ts, 10)).toLocaleString() : "no data";
        showOfflineBanner(tsText);
        wasOffline = true;
      }

      let safe;
      if (isComments(url)) {
        safe = safeShapeComments(json);
        console.log(`[Cache] Fallback comments: ${safe.length} comments`);
      } else {
        safe = safeShapeOrders(json);
        console.log(`[Cache] Fallback orders: ${safe.result.length} orders`);
      }

      const res = new Response(JSON.stringify(safe), { status: 200, headers: { 'Content-Type': 'application/json' } });
      Object.defineProperty(res, '__ce_text', { value: JSON.stringify(safe) });
      Object.defineProperty(res, '__ce_url', { value: String(url) });
      return res;
    }
  };

  Response.prototype.json = async function () {
    if (this.__ce_text !== undefined) {
      try {
        const parsed = JSON.parse(this.__ce_text);
        if (isComments(this.__ce_url)) {
          const safe = safeShapeComments(parsed);
          console.log(`[Cache] Response.json() → ${safe.length} comments`);
          return safe;
        } else {
          const safe = safeShapeOrders(parsed);
          console.log(`[Cache] Response.json() → ${safe.result.length} orders`);
          return safe;
        }
      } catch {
        console.error(`[Cache] Response.json() parse error, using safe fallback`);
        return isComments(this.__ce_url) ? [] : safeShapeOrders({});
      }
    }
    return originalJson.call(this);
  };
})();
