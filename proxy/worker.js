// Cloudflare Worker to manage portfolio and quotes_new in D1
// - Endpoints:
//   - GET    /api/portfolio
//   - POST   /api/portfolio  JSON {symbol, shares, currency, company_name?}
//   - DELETE /api/portfolio?symbol=XXXX
//   - GET    /api/quotes_new
//   - POST   /api/quotes/refresh         // fetch Yahoo for portfolio symbols + USDJPY=X
//   - GET    /api/portfolio_with_prices  // join holdings + quotes_new, include JPY values

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, corsHeaders());
    }

    try {
      if (pathname === '/api/portfolio') {
        if (request.method === 'GET') return listHoldings(env);
        if (request.method === 'POST') return upsertHolding(request, env);
        if (request.method === 'DELETE') return deleteHolding(url, env);
        return notAllowed(['GET', 'POST', 'DELETE']);
      }
      if (pathname === '/api/quotes_new') {
        if (request.method === 'GET') return listQuotesNew(env);
        return notAllowed(['GET']);
      }
      if (pathname === '/api/quotes_new/refresh-current' || pathname === '/api/quotes_new/refresh-baselines') {
        if (request.method === 'POST') return refreshQuotes(request, env, url);
        return notAllowed(['POST']);
      }
      if (pathname === '/api/quotes/refresh' || pathname === '/api/quotes/refresh-current') {
        if (request.method === 'POST') return refreshQuotes(request, env, url);
        return notAllowed(['POST']);
      }
      if (pathname === '/api/usdjpy') {
        if (request.method === 'GET') return getUsdJpy(env);
        return notAllowed(['GET']);
      }
      if (pathname === '/api/portfolio_with_prices') {
        if (request.method === 'GET') return portfolioWithPrices(env);
        return notAllowed(['GET']);
      }
      if (pathname === '/api/debug/yahoo') {
        const syms = (url.searchParams.get('symbols') || '').split(',').map(s=>s.trim()).filter(Boolean);
        if (!syms.length) return json({error:'symbols required'}, 400);
        const data = await fetchYahooQuotes(syms);
        return json({ count: Object.keys(data).length, symbols: Object.keys(data) });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders() });
    } catch (e) {
      const msg = e && e.stack ? String(e.stack) : String(e);
      return json({ ok: false, error: msg }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    // Periodic refresh to keep quotes/baselines warm
    try {
      await refreshQuotes(new Request('https://dummy'), env, new URL('https://dummy'));
    } catch (e) {
      // ignore; next run will retry
    }
  }
};

// CORS helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...headers },
  });
}

function notAllowed(methods) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { ...corsHeaders(), 'Allow': methods.join(', ') },
  });
}

async function listHoldings(env) {
  const rs = await env.DB.prepare(
    'SELECT symbol, shares, currency, company_name FROM holdings ORDER BY symbol'
  ).all();
  return json(rs.results || []);
}

async function upsertHolding(request, env) {
  const body = await safeJson(request);
  const symbol = (body.symbol || '').toString().trim().toUpperCase();
  if (!symbol) return json({ ok: false, error: 'symbol required' }, 400);
  const shares = Number(body.shares);
  if (!Number.isFinite(shares)) return json({ ok: false, error: 'shares must be number' }, 400);
  const currency = (body.currency || '').toString().trim().toUpperCase() || null;
  const company_name = (body.company_name || body.name || '').toString().trim() || null;

  await env.DB.prepare(
    'INSERT INTO holdings (symbol, shares, currency, company_name) VALUES (?, ?, ?, ?)\n' +
    'ON CONFLICT(symbol) DO UPDATE SET shares=excluded.shares, currency=excluded.currency, company_name=excluded.company_name'
  ).bind(symbol, shares, currency, company_name).run();

  return json({ ok: true });
}

async function deleteHolding(url, env) {
  const symbol = (url.searchParams.get('symbol') || '').toString().trim().toUpperCase();
  if (!symbol) return json({ ok: false, error: 'symbol required' }, 400);
  await env.DB.prepare('DELETE FROM holdings WHERE symbol = ?').bind(symbol).run();
  return json({ ok: true });
}

async function listQuotesNew(env) {
  const rs = await env.DB.prepare(
    'SELECT symbol, price, currency, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at FROM quotes_new ORDER BY symbol'
  ).all();
  return json(rs.results || []);
}

async function getUsdJpy(env) {
  const rs = await env.DB.prepare(
    'SELECT symbol, price, currency, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at FROM quotes_new WHERE symbol = ?'
  ).bind('USDJPY=X').all();
  const row = (rs.results && rs.results[0]) || null;
  return json(row || {});
}

async function refreshQuotes(request, env, url) {
  // Allow debug override: symbols from body or query, and dry-run via ?dry=1
  const body = await safeJson(request);
  let syms = [];
  const bodySyms = (Array.isArray(body.symbols) ? body.symbols : (typeof body.symbols === 'string' ? String(body.symbols).split(',') : [])).map(s=>String(s).trim()).filter(Boolean);
  const querySyms = (url.searchParams.get('symbols') || '').split(',').map(s=>s.trim()).filter(Boolean);
  const overrideSyms = bodySyms.length ? bodySyms : querySyms;
  const dry = (String(body.dry ?? url.searchParams.get('dry') ?? '') === '1');

  if (overrideSyms.length) {
    syms = overrideSyms.map(s=>s.toUpperCase());
  } else {
    // load holdings
    const hr = await env.DB.prepare('SELECT symbol FROM holdings ORDER BY symbol').all();
    const holdSyms = (hr.results || []).map(r => String(r.symbol).toUpperCase());
    // include existing quotes_new symbols for backfill of null baselines
    const qr = await env.DB.prepare('SELECT symbol FROM quotes_new ORDER BY symbol').all();
    const existSyms = (qr.results || []).map(r => String(r.symbol).toUpperCase());
    const set = new Set([...holdSyms, ...existSyms]);
    syms = Array.from(set);
  }

  // include USDJPY=X for FX conversion
  if (!syms.includes('USDJPY=X')) syms.push('USDJPY=X');
  const nowIso = new Date().toISOString();

  // Fetch quotes in chunks (Yahoo only)
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

  // Fetch baselines (prevClose, 1m, 1y) from Yahoo chart API
  // Compute baselines for all requested symbols (not just those returned by /quote)
  const allSymbols = Array.from(new Set(syms.map(s => String(s).toUpperCase())));
  const baselineMap = await fetchYahooBaselines(allSymbols);

  // Load existing prices to use as a last-resort fallback for baselines
  const existingPriceMap = {};
  try {
    const er = await env.DB.prepare('SELECT symbol, price FROM quotes_new').all();
    for (const row of (er.results || [])) {
      const k = String(row.symbol || '').toUpperCase();
      const v = toNum(row.price);
      if (k && Number.isFinite(v)) existingPriceMap[k] = v;
    }
  } catch (_) { /* ignore */ }

  // If dry-run, just return what would be inserted
  if (dry) {
    const sampleSyms = Object.keys(quotes).slice(0, 3);
    const sample = sampleSyms.map(s => ({
      symbol: s,
      quote: quotes[s],
      baselines: baselineMap[s] || null,
    }));
    return json({ ok: true, dry: true, total: Object.keys(quotes).length, chunks, symbols: syms, sample });
  }

  // Upsert into quotes_new (price + currency + baselines). Ensure baselines fallback to price when missing.
  const stmt = env.DB.prepare(
    'INSERT INTO quotes_new (symbol, price, currency, updated_at, price_1d, updated_1d_at, price_1m, updated_1m_at, price_1y, updated_1y_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n' +
    'ON CONFLICT(symbol) DO UPDATE SET ' +
      'price=excluded.price, currency=excluded.currency, updated_at=excluded.updated_at, ' +
      'price_1d=excluded.price_1d, updated_1d_at=excluded.updated_1d_at, ' +
      'price_1m=excluded.price_1m, updated_1m_at=excluded.updated_1m_at, ' +
      'price_1y=excluded.price_1y, updated_1y_at=excluded.updated_1y_at'
  );
  for (const sym of allSymbols) {
    const r = quotes[sym];
    let price = toNum(r && (r.regularMarketPrice ?? r.price));
    const ccy = ((r && r.currency) ? String(r.currency).toUpperCase() : guessCurrency(sym));
    const bl = baselineMap[sym] || {};
    let prev = toNum(r && (r.regularMarketPreviousClose));
    const blPrev = toNum(bl.prevClose);
    const blM1 = toNum(bl.m1);
    const blY1 = toNum(bl.y1);
    const blLast = toNum(bl.last);
    if (!isFinite(price) && isFinite(blLast)) price = blLast;
    if (!isFinite(price) && Number.isFinite(existingPriceMap[sym])) price = existingPriceMap[sym];
    if (!isFinite(prev) && isFinite(blPrev)) prev = blPrev;
    // Fallbacks: fill baselines with current price (or last close) if missing
    const priceFallback = Number.isFinite(price) ? price : (Number.isFinite(blLast) ? blLast : (Number.isFinite(existingPriceMap[sym]) ? existingPriceMap[sym] : null));
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

  return json({ ok: true, updated: Object.keys(quotes).length, chunks });
}

async function portfolioWithPrices(env) {
  // Get holdings and matched quotes
  const q1 = await env.DB.prepare(
    'SELECT h.symbol, h.shares, h.currency AS holding_currency, h.company_name,\n' +
    '       q.price, q.currency AS price_currency, q.updated_at,\n' +
    '       q.price_1d, q.price_1m, q.price_1y\n' +
    'FROM holdings h LEFT JOIN quotes_new q ON q.symbol = h.symbol\n' +
    'ORDER BY h.symbol'
  ).all();
  const rows = q1.results || [];

  // Load FX from quotes_new (USDJPY=X)
  const fxRow = await env.DB.prepare('SELECT price FROM quotes_new WHERE symbol = ?').bind('USDJPY=X').all();
  const fx = toNum((fxRow.results && fxRow.results[0] && fxRow.results[0].price));

  const out = [];
  for (const r of rows) {
    const sym = String(r.symbol).toUpperCase();
    const price = toNum(r.price);
    const ccy = String(r.price_currency || r.holding_currency || '').toUpperCase();
    let jpy = null, jpy_1d = null, jpy_1m = null, jpy_1y = null;
    if (ccy === 'JPY' && isFinite(price)) {
      jpy = price;
      jpy_1d = toNum(r.price_1d);
      jpy_1m = toNum(r.price_1m);
      jpy_1y = toNum(r.price_1y);
    } else if (ccy === 'USD' && isFinite(price) && isFinite(fx) && fx > 0) {
      jpy = price * fx;
      if (isFinite(r.price_1d)) jpy_1d = r.price_1d * fx;
      if (isFinite(r.price_1m)) jpy_1m = r.price_1m * fx;
      if (isFinite(r.price_1y)) jpy_1y = r.price_1y * fx;
    }

    out.push({
      symbol: sym,
      company_name: r.company_name || null,
      shares: toNum(r.shares),
      currency: String(r.holding_currency || '').toUpperCase() || null,
      price: isFinite(price) ? price : null,
      price_currency: ccy || null,
      jpy: isFinite(jpy) ? jpy : null,
      jpy_1d: isFinite(jpy_1d) ? jpy_1d : null,
      jpy_1m: isFinite(jpy_1m) ? jpy_1m : null,
      jpy_1y: isFinite(jpy_1y) ? jpy_1y : null,
      updated_at: r.updated_at || null,
    });
  }
  return json(out);
}

async function safeJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function guessCurrency(sym) {
  if (/\.T$/i.test(sym)) return 'JPY';
  if (sym === 'USDJPY=X') return 'JPY';
  return 'USD';
}

async function fetchYahooQuotes(symbols) {
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','));
  const res = await fetch(url, {
    cf: { cacheTtl: 30, cacheEverything: false },
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': 'https://finance.yahoo.com/',
      // Pretend to be Mozilla Firefox to reduce risk of blocking
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv=128.0) Gecko/20100101 Firefox/128.0'
    }
  });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  const arr = (j && j.quoteResponse && j.quoteResponse.result) || [];
  const out = {};
  for (const r of arr) {
    if (r && r.symbol) out[String(r.symbol).toUpperCase()] = r;
  }
  return out;
}

// Fetch baselines via Yahoo chart API for given symbols
// Returns map: SYMBOL -> { prevClose, m1, y1 }
async function fetchYahooBaselines(symbols){
  const out = {};
  for (const s0 of symbols){
    const s = String(s0).toUpperCase();
    try{
      const ch = await fetchYahooChart(s, '2y', '1d');
      const bl = computeBaselinesFromChart(ch);
      if (bl) out[s] = bl;
    }catch(_){ /* ignore per-symbol failure */ }
  }
  return out;
}

async function fetchYahooChart(symbol, range='2y', interval='1d'){
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
              '?range=' + encodeURIComponent(range) + '&interval=' + encodeURIComponent(interval) + '&includePrePost=false';
  const res = await fetch(url, {
    cf: { cacheTtl: 60, cacheEverything: false },
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': 'https://finance.yahoo.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv=128.0) Gecko/20100101 Firefox/128.0'
    }
  });
  if (!res.ok) throw new Error('Yahoo chart HTTP ' + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('Yahoo chart no result for ' + symbol);
  const ts = (r.timestamp || []).map(t => Number(t) * 1000);
  const closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || []).map(v => (v==null ? NaN : Number(v)));
  return { ts, closes };
}

function computeBaselinesFromChart(ch){
  if (!ch || !Array.isArray(ch.ts) || !Array.isArray(ch.closes) || ch.ts.length !== ch.closes.length) return null;
  const now = Date.now();
  const target1m = now - 30*24*3600*1000;
  const target1y = now - 365*24*3600*1000;

  // prevClose: choose last valid close before today (UTC), else last valid
  let idxPrev = lastIndexBefore(ch.ts, endOfPrevTradingDay(now));
  let prevClose = valueAtOrEarlier(ch.closes, idxPrev);
  if (!isFinite(prevClose)) {
    const lastIdx = lastValidIndex(ch.closes);
    if (lastIdx >= 0) prevClose = ch.closes[lastIdx];
  }

  // 1M baseline
  const idx1m = lastIndexBefore(ch.ts, target1m);
  let m1 = valueAtOrEarlier(ch.closes, idx1m);
  if (!isFinite(m1)) {
    // fallback to earliest or last valid
    const firstIdx = firstValidIndex(ch.closes);
    const lastIdx = lastValidIndex(ch.closes);
    m1 = isFinite(ch.closes[idx1m]) ? ch.closes[idx1m] : (firstIdx >= 0 ? ch.closes[firstIdx] : (lastIdx >= 0 ? ch.closes[lastIdx] : NaN));
  }

  // 1Y baseline
  const idx1y = lastIndexBefore(ch.ts, target1y);
  let y1 = valueAtOrEarlier(ch.closes, idx1y);
  if (!isFinite(y1)) {
    const firstIdx = firstValidIndex(ch.closes);
    const lastIdx = lastValidIndex(ch.closes);
    y1 = isFinite(ch.closes[idx1y]) ? ch.closes[idx1y] : (firstIdx >= 0 ? ch.closes[firstIdx] : (lastIdx >= 0 ? ch.closes[lastIdx] : NaN));
  }

  const out = {};
  // latest close for price fallback
  const lastIdx = lastValidIndex(ch.closes);
  if (lastIdx >= 0 && Number.isFinite(Number(ch.closes[lastIdx]))) out.last = Number(ch.closes[lastIdx]);
  if (isFinite(prevClose)) out.prevClose = prevClose;
  if (isFinite(m1)) out.m1 = m1;
  if (isFinite(y1)) out.y1 = y1;
  return out;
}

function endOfPrevTradingDay(nowMs){
  // Approx: previous day 23:59:59 local UTC timestamp. Chart uses exchange tz but we use UTC-day heuristic.
  const d = new Date(nowMs);
  d.setUTCHours(0,0,0,0);
  return d.getTime() - 1000; // just before start of today UTC
}

function lastIndexBefore(tsArr, targetMs){
  let lo = 0, hi = tsArr.length - 1, ans = -1;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    if (tsArr[mid] <= targetMs){ ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

function valueAtOrEarlier(arr, idx){
  if (idx < 0) {
    // fallback to first valid value
    return valueAtOrLater(arr, 0);
  }
  for (let i = idx; i >= 0; i--){
    const v = Number(arr[i]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

function valueAtOrLater(arr, idx){
  for (let i = idx; i < arr.length; i++){
    const v = Number(arr[i]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

function lastValidIndex(arr){
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(Number(arr[i]))) return i;
  return -1;
}

function firstValidIndex(arr){
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(Number(arr[i]))) return i;
  return -1;
}

// Note: Stooq fallback removed. Yahoo only.
