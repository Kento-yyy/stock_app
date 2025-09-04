var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-IufCx9/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// proxy/worker.js
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = (url.pathname || "/").replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") {
      return new Response(null, corsHeaders());
    }
    try {
      if (pathname === "/api/portfolio") {
        if (request.method === "GET") return listHoldings(env);
        if (request.method === "POST") return upsertHolding(request, env);
        if (request.method === "DELETE") return deleteHolding(url, env);
        return notAllowed(["GET", "POST", "DELETE"]);
      }
      if (pathname === "/api/quotes_new") {
        if (request.method === "GET") return listQuotesNew(env);
        return notAllowed(["GET"]);
      }
      if (pathname === "/api/quotes_new/refresh-current" || pathname === "/api/quotes_new/refresh-baselines") {
        if (request.method === "POST") return refreshQuotes(request, env, url);
        return notAllowed(["POST"]);
      }
      if (pathname === "/api/quotes/refresh" || pathname === "/api/quotes/refresh-current") {
        if (request.method === "POST") return refreshQuotes(request, env, url);
        return notAllowed(["POST"]);
      }
      if (pathname === "/api/usdjpy") {
        if (request.method === "GET") return getUsdJpy(env);
        return notAllowed(["GET"]);
      }
      if (pathname === "/api/portfolio_with_prices") {
        if (request.method === "GET") return portfolioWithPrices(env);
        return notAllowed(["GET"]);
      }
      if (pathname === "/api/debug/yahoo") {
        const syms = (url.searchParams.get("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!syms.length) return json({ error: "symbols required" }, 400);
        const data = await fetchYahooQuotes(syms);
        return json({ count: Object.keys(data).length, symbols: Object.keys(data) });
      }
      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    } catch (e) {
      const msg = e && e.stack ? String(e.stack) : String(e);
      return json({ ok: false, error: msg }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    try {
      await refreshQuotes(new Request("https://dummy"), env, new URL("https://dummy"));
    } catch (e) {
    }
  }
};
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
  };
}
__name(corsHeaders, "corsHeaders");
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...headers }
  });
}
__name(json, "json");
function notAllowed(methods) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { ...corsHeaders(), "Allow": methods.join(", ") }
  });
}
__name(notAllowed, "notAllowed");
async function listHoldings(env) {
  const rs = await env.DB.prepare(
    "SELECT symbol, shares, currency, company_name FROM holdings ORDER BY symbol"
  ).all();
  return json(rs.results || []);
}
__name(listHoldings, "listHoldings");
async function upsertHolding(request, env) {
  const body = await safeJson(request);
  const symbol = (body.symbol || "").toString().trim().toUpperCase();
  if (!symbol) return json({ ok: false, error: "symbol required" }, 400);
  const shares = Number(body.shares);
  if (!Number.isFinite(shares)) return json({ ok: false, error: "shares must be number" }, 400);
  const currency = (body.currency || "").toString().trim().toUpperCase() || null;
  const company_name = (body.company_name || body.name || "").toString().trim() || null;
  await env.DB.prepare(
    "INSERT INTO holdings (symbol, shares, currency, company_name) VALUES (?, ?, ?, ?)\nON CONFLICT(symbol) DO UPDATE SET shares=excluded.shares, currency=excluded.currency, company_name=excluded.company_name"
  ).bind(symbol, shares, currency, company_name).run();
  return json({ ok: true });
}
__name(upsertHolding, "upsertHolding");
async function deleteHolding(url, env) {
  const symbol = (url.searchParams.get("symbol") || "").toString().trim().toUpperCase();
  if (!symbol) return json({ ok: false, error: "symbol required" }, 400);
  await env.DB.prepare("DELETE FROM holdings WHERE symbol = ?").bind(symbol).run();
  return json({ ok: true });
}
__name(deleteHolding, "deleteHolding");
async function listQuotesNew(env) {
  const rs = await env.DB.prepare(
    "SELECT symbol, price, currency, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at FROM quotes_new ORDER BY symbol"
  ).all();
  return json(rs.results || []);
}
__name(listQuotesNew, "listQuotesNew");
async function getUsdJpy(env) {
  let rs = await env.DB.prepare(
    "SELECT id, price, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at FROM usd_jpy WHERE id = 1"
  ).all();
  let row = rs.results && rs.results[0] || null;
  let needsBackfill = !row || row.price == null || row.price_1d == null || row.price_1m == null || row.price_1y == null;
  if (needsBackfill) {
    try {
      const url = new URL("https://dummy");
      url.searchParams.set("symbols", "USDJPY=X");
      await refreshQuotes(
        new Request("https://dummy", { method: "POST", body: JSON.stringify({ symbols: ["USDJPY=X"] }), headers: { "content-type": "application/json" } }),
        env,
        url
      );
    } catch (_) {
    }
    rs = await env.DB.prepare(
      "SELECT id, price, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at FROM usd_jpy WHERE id = 1"
    ).all();
    row = rs.results && rs.results[0] || null;
  }
  if (!row) row = { id: 1 };
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  let price = toNum(row.price);
  let p1d = toNum(row.price_1d);
  let p1m = toNum(row.price_1m);
  let p1y = toNum(row.price_1y);
  let chartLast = NaN, chartPrev = NaN, chartM1 = NaN, chartY1 = NaN;
  try {
    const ch = await fetchYahooChart("USDJPY=X", "2y", "1d");
    const bl = computeBaselinesFromChart(ch) || {};
    chartLast = toNum(bl.last);
    chartPrev = toNum(bl.prevClose);
    chartM1 = toNum(bl.m1);
    chartY1 = toNum(bl.y1);
  } catch (_) {
  }
  if (!Number.isFinite(price) && Number.isFinite(chartLast)) price = chartLast;
  if (!Number.isFinite(p1d) && Number.isFinite(chartPrev)) p1d = chartPrev;
  if (!Number.isFinite(p1m) && Number.isFinite(chartM1)) p1m = chartM1;
  if (!Number.isFinite(p1y) && Number.isFinite(chartY1)) p1y = chartY1;
  const priceFallback = Number.isFinite(price) ? price : Number.isFinite(chartLast) ? chartLast : null;
  const out = {
    id: 1,
    price: Number.isFinite(price) ? price : null,
    updated_at: row.updated_at || nowIso,
    price_1d: Number.isFinite(p1d) ? p1d : priceFallback,
    updated_1d_at: row.updated_1d_at || nowIso,
    price_1m: Number.isFinite(p1m) ? p1m : priceFallback,
    updated_1m_at: row.updated_1m_at || nowIso,
    price_1y: Number.isFinite(p1y) ? p1y : priceFallback,
    updated_1y_at: row.updated_1y_at || nowIso
  };
  if (!row || row.price == null || row.price_1d == null || row.price_1m == null || row.price_1y == null || out.price_1d != row.price_1d || out.price_1m != row.price_1m || out.price_1y != row.price_1y || out.price != row.price) {
    try {
      await env.DB.prepare(
        "INSERT INTO usd_jpy (id, price, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)\nON CONFLICT(id) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at, price_1d=excluded.price_1d, updated_1d_at=excluded.updated_1d_at, price_1m=excluded.price_1m, updated_1m_at=excluded.updated_1m_at, price_1y=excluded.price_1y, updated_1y_at=excluded.updated_1y_at"
      ).bind(out.price, nowIso, out.price_1d, out.updated_1d_at, out.price_1m, out.updated_1m_at, out.price_1y, out.updated_1y_at).run();
    } catch (_) {
    }
  }
  return json(out);
}
__name(getUsdJpy, "getUsdJpy");
async function refreshQuotes(request, env, url) {
  const body = await safeJson(request);
  let syms = [];
  const bodySyms = (Array.isArray(body.symbols) ? body.symbols : typeof body.symbols === "string" ? String(body.symbols).split(",") : []).map((s) => String(s).trim()).filter(Boolean);
  const querySyms = (url.searchParams.get("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const overrideSyms = bodySyms.length ? bodySyms : querySyms;
  const dry = String(body.dry ?? url.searchParams.get("dry") ?? "") === "1";
  if (overrideSyms.length) {
    syms = overrideSyms.map((s) => s.toUpperCase());
  } else {
    const hr = await env.DB.prepare("SELECT symbol FROM holdings ORDER BY symbol").all();
    const holdSyms = (hr.results || []).map((r) => String(r.symbol).toUpperCase());
    const qr = await env.DB.prepare("SELECT symbol FROM quotes_new ORDER BY symbol").all();
    const existSyms = (qr.results || []).map((r) => String(r.symbol).toUpperCase());
    const set = /* @__PURE__ */ new Set([...holdSyms, ...existSyms]);
    syms = Array.from(set);
  }
  if (!syms.includes("USDJPY=X")) syms.push("USDJPY=X");
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const chunked = chunk(syms, 10);
  let quotes = {};
  const chunks = [];
  for (const ch of chunked) {
    const detail = { symbols: ch, ok: false, count: 0 };
    try {
      const q = await fetchYahooQuotes(ch);
      Object.assign(quotes, q);
      detail.ok = true;
      detail.count = Object.keys(q).length;
    } catch (e) {
      detail.error = String(e && e.stack ? e.stack : e);
    }
    chunks.push(detail);
  }
  const allSymbols = Array.from(new Set(syms.map((s) => String(s).toUpperCase())));
  const baselineMap = await fetchYahooBaselines(allSymbols);
  const existingPriceMap = {};
  try {
    const er = await env.DB.prepare("SELECT symbol, price FROM quotes_new").all();
    for (const row of er.results || []) {
      const k = String(row.symbol || "").toUpperCase();
      const v = toNum(row.price);
      if (k && Number.isFinite(v)) existingPriceMap[k] = v;
    }
  } catch (_) {
  }
  if (dry) {
    const sampleSyms = Object.keys(quotes).slice(0, 3);
    const sample = sampleSyms.map((s) => ({
      symbol: s,
      quote: quotes[s],
      baselines: baselineMap[s] || null
    }));
    return json({ ok: true, dry: true, total: Object.keys(quotes).length, chunks, symbols: syms, sample });
  }
  const stmt = env.DB.prepare(
    "INSERT INTO quotes_new (symbol, price, currency, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\nON CONFLICT(symbol) DO UPDATE SET price=excluded.price, currency=excluded.currency, updated_at=excluded.updated_at, price_1d=excluded.price_1d, updated_1d_at=excluded.updated_1d_at, price_1m=excluded.price_1m, updated_1m_at=excluded.updated_1m_at, price_1y=excluded.price_1y, updated_1y_at=excluded.updated_1y_at"
  );
  for (const sym of allSymbols) {
    const r = quotes[sym];
    let price = toNum(r && (r.regularMarketPrice ?? r.price));
    const ccy = r && r.currency ? String(r.currency).toUpperCase() : guessCurrency(sym);
    const bl = baselineMap[sym] || {};
    let prev = toNum(r && r.regularMarketPreviousClose);
    const blPrev = toNum(bl.prevClose);
    const blM1 = toNum(bl.m1);
    const blY1 = toNum(bl.y1);
    const blLast = toNum(bl.last);
    if (!isFinite(price) && isFinite(blLast)) price = blLast;
    if (!isFinite(price) && Number.isFinite(existingPriceMap[sym])) price = existingPriceMap[sym];
    if (!isFinite(prev) && isFinite(blPrev)) prev = blPrev;
    const priceFallback = Number.isFinite(price) ? price : Number.isFinite(blLast) ? blLast : Number.isFinite(existingPriceMap[sym]) ? existingPriceMap[sym] : null;
    const prevVal = isFinite(prev) ? prev : priceFallback;
    const m1Val = isFinite(blM1) ? blM1 : priceFallback;
    const y1Val = isFinite(blY1) ? blY1 : priceFallback;
    await stmt.bind(
      sym,
      isFinite(price) ? price : null,
      ccy,
      nowIso,
      prevVal,
      prevVal != null ? nowIso : null,
      m1Val,
      m1Val != null ? nowIso : null,
      y1Val,
      y1Val != null ? nowIso : null
    ).run();
  }
  try {
    const fxSym = "USDJPY=X";
    const r = quotes[fxSym];
    let price = toNum(r && (r.regularMarketPrice ?? r.price));
    const bl = baselineMap[fxSym] || {};
    let prev = toNum(r && r.regularMarketPreviousClose);
    const blPrev = toNum(bl.prevClose);
    const blM1 = toNum(bl.m1);
    const blY1 = toNum(bl.y1);
    const blLast = toNum(bl.last);
    if (!isFinite(price) && isFinite(blLast)) price = blLast;
    if (!isFinite(prev) && isFinite(blPrev)) prev = blPrev;
    const priceFallback = Number.isFinite(price) ? price : Number.isFinite(blLast) ? blLast : null;
    const prevVal = isFinite(prev) ? prev : priceFallback;
    const m1Val = isFinite(blM1) ? blM1 : priceFallback;
    const y1Val = isFinite(blY1) ? blY1 : priceFallback;
    await env.DB.prepare(
      "INSERT INTO usd_jpy (id, price, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)\nON CONFLICT(id) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at, price_1d=excluded.price_1d, updated_1d_at=excluded.updated_1d_at, price_1m=excluded.price_1m, updated_1m_at=excluded.updated_1m_at, price_1y=excluded.price_1y, updated_1y_at=excluded.updated_1y_at"
    ).bind(
      Number.isFinite(price) ? price : null,
      nowIso,
      prevVal,
      prevVal != null ? nowIso : null,
      m1Val,
      m1Val != null ? nowIso : null,
      y1Val,
      y1Val != null ? nowIso : null
    ).run();
  } catch (_) {
  }
  return json({ ok: true, updated: Object.keys(quotes).length, chunks });
}
__name(refreshQuotes, "refreshQuotes");
async function portfolioWithPrices(env) {
  const q1 = await env.DB.prepare(
    "SELECT h.symbol, h.shares, h.currency AS holding_currency, h.company_name,\n       q.price, q.currency AS price_currency, q.updated_at,\n       q.price_1d, q.price_1m, q.price_1y\nFROM holdings h LEFT JOIN quotes_new q ON q.symbol = h.symbol\nORDER BY h.symbol"
  ).all();
  const rows = q1.results || [];
  const fxRow = await env.DB.prepare("SELECT price FROM usd_jpy WHERE id = 1").all();
  const fx = toNum(fxRow.results && fxRow.results[0] && fxRow.results[0].price);
  const out = [];
  for (const r of rows) {
    const sym = String(r.symbol).toUpperCase();
    const price = toNum(r.price);
    const ccy = String(r.price_currency || r.holding_currency || "").toUpperCase();
    let jpy = null, jpy_1d = null, jpy_1m = null, jpy_1y = null;
    if (ccy === "JPY" && isFinite(price)) {
      jpy = price;
      jpy_1d = toNum(r.price_1d);
      jpy_1m = toNum(r.price_1m);
      jpy_1y = toNum(r.price_1y);
    } else if (ccy === "USD" && isFinite(price) && isFinite(fx) && fx > 0) {
      jpy = price * fx;
      if (isFinite(r.price_1d)) jpy_1d = r.price_1d * fx;
      if (isFinite(r.price_1m)) jpy_1m = r.price_1m * fx;
      if (isFinite(r.price_1y)) jpy_1y = r.price_1y * fx;
    }
    out.push({
      symbol: sym,
      company_name: r.company_name || null,
      shares: toNum(r.shares),
      currency: String(r.holding_currency || "").toUpperCase() || null,
      price: isFinite(price) ? price : null,
      price_currency: ccy || null,
      jpy: isFinite(jpy) ? jpy : null,
      jpy_1d: isFinite(jpy_1d) ? jpy_1d : null,
      jpy_1m: isFinite(jpy_1m) ? jpy_1m : null,
      jpy_1y: isFinite(jpy_1y) ? jpy_1y : null,
      updated_at: r.updated_at || null
    });
  }
  return json(out);
}
__name(portfolioWithPrices, "portfolioWithPrices");
async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}
__name(safeJson, "safeJson");
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
__name(chunk, "chunk");
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
__name(toNum, "toNum");
function guessCurrency(sym) {
  if (/\.T$/i.test(sym)) return "JPY";
  if (sym === "USDJPY=X") return "JPY";
  return "USD";
}
__name(guessCurrency, "guessCurrency");
async function fetchYahooQuotes(symbols) {
  const url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(","));
  const res = await fetch(url, {
    cf: { cacheTtl: 30, cacheEverything: false },
    headers: {
      "Accept": "application/json",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Referer": "https://finance.yahoo.com/",
      // Pretend to be Mozilla Firefox to reduce risk of blocking
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv=128.0) Gecko/20100101 Firefox/128.0"
    }
  });
  if (!res.ok) throw new Error("Yahoo HTTP " + res.status);
  const j = await res.json();
  const arr = j && j.quoteResponse && j.quoteResponse.result || [];
  const out = {};
  for (const r of arr) {
    if (r && r.symbol) out[String(r.symbol).toUpperCase()] = r;
  }
  return out;
}
__name(fetchYahooQuotes, "fetchYahooQuotes");
async function fetchYahooBaselines(symbols) {
  const out = {};
  for (const s0 of symbols) {
    const s = String(s0).toUpperCase();
    try {
      const ch = await fetchYahooChart(s, "2y", "1d");
      const bl = computeBaselinesFromChart(ch);
      if (bl) out[s] = bl;
    } catch (_) {
    }
  }
  return out;
}
__name(fetchYahooBaselines, "fetchYahooBaselines");
async function fetchYahooChart(symbol, range = "2y", interval = "1d") {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + encodeURIComponent(range) + "&interval=" + encodeURIComponent(interval) + "&includePrePost=false";
  const res = await fetch(url, {
    cf: { cacheTtl: 60, cacheEverything: false },
    headers: {
      "Accept": "application/json",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Referer": "https://finance.yahoo.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv=128.0) Gecko/20100101 Firefox/128.0"
    }
  });
  if (!res.ok) throw new Error("Yahoo chart HTTP " + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("Yahoo chart no result for " + symbol);
  const ts = (r.timestamp || []).map((t) => Number(t) * 1e3);
  const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close || []).map((v) => v == null ? NaN : Number(v));
  return { ts, closes };
}
__name(fetchYahooChart, "fetchYahooChart");
function computeBaselinesFromChart(ch) {
  if (!ch || !Array.isArray(ch.ts) || !Array.isArray(ch.closes) || ch.ts.length !== ch.closes.length) return null;
  const now = Date.now();
  const target1m = now - 30 * 24 * 3600 * 1e3;
  const target1y = now - 365 * 24 * 3600 * 1e3;
  let idxPrev = lastIndexBefore(ch.ts, endOfPrevTradingDay(now));
  let prevClose = valueAtOrEarlier(ch.closes, idxPrev);
  if (!isFinite(prevClose)) {
    const lastIdx2 = lastValidIndex(ch.closes);
    if (lastIdx2 >= 0) prevClose = ch.closes[lastIdx2];
  }
  const idx1m = lastIndexBefore(ch.ts, target1m);
  let m1 = valueAtOrEarlier(ch.closes, idx1m);
  if (!isFinite(m1)) {
    const firstIdx = firstValidIndex(ch.closes);
    const lastIdx2 = lastValidIndex(ch.closes);
    m1 = isFinite(ch.closes[idx1m]) ? ch.closes[idx1m] : firstIdx >= 0 ? ch.closes[firstIdx] : lastIdx2 >= 0 ? ch.closes[lastIdx2] : NaN;
  }
  const idx1y = lastIndexBefore(ch.ts, target1y);
  let y1 = valueAtOrEarlier(ch.closes, idx1y);
  if (!isFinite(y1)) {
    const firstIdx = firstValidIndex(ch.closes);
    const lastIdx2 = lastValidIndex(ch.closes);
    y1 = isFinite(ch.closes[idx1y]) ? ch.closes[idx1y] : firstIdx >= 0 ? ch.closes[firstIdx] : lastIdx2 >= 0 ? ch.closes[lastIdx2] : NaN;
  }
  const out = {};
  const lastIdx = lastValidIndex(ch.closes);
  if (lastIdx >= 0 && Number.isFinite(Number(ch.closes[lastIdx]))) out.last = Number(ch.closes[lastIdx]);
  if (isFinite(prevClose)) out.prevClose = prevClose;
  if (isFinite(m1)) out.m1 = m1;
  if (isFinite(y1)) out.y1 = y1;
  return out;
}
__name(computeBaselinesFromChart, "computeBaselinesFromChart");
function endOfPrevTradingDay(nowMs) {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 1e3;
}
__name(endOfPrevTradingDay, "endOfPrevTradingDay");
function lastIndexBefore(tsArr, targetMs) {
  let lo = 0, hi = tsArr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (tsArr[mid] <= targetMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
__name(lastIndexBefore, "lastIndexBefore");
function valueAtOrEarlier(arr, idx) {
  if (idx < 0) {
    return valueAtOrLater(arr, 0);
  }
  for (let i = idx; i >= 0; i--) {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}
__name(valueAtOrEarlier, "valueAtOrEarlier");
function valueAtOrLater(arr, idx) {
  for (let i = idx; i < arr.length; i++) {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}
__name(valueAtOrLater, "valueAtOrLater");
function lastValidIndex(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(Number(arr[i]))) return i;
  return -1;
}
__name(lastValidIndex, "lastValidIndex");
function firstValidIndex(arr) {
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(Number(arr[i]))) return i;
  return -1;
}
__name(firstValidIndex, "firstValidIndex");

// ../../../../.nvm/versions/node/v22.18.0/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.nvm/versions/node/v22.18.0/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-IufCx9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../.nvm/versions/node/v22.18.0/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-IufCx9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
