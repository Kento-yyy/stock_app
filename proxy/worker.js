/*! konnnichiwa — deployment test marker (preserve in some bundlers) */
const BUILD_INFO = {
  marker: 'konnnichiwa',
  time: new Date().toISOString()
};
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders() });
      }
      if (url.pathname === '/__version') {
        return json({ ...BUILD_INFO });
      }
      // Quotes API: persist latest prices into D1
      if (url.pathname === '/api/quotes') {
        if (request.method === 'GET') {
          try {
            const { results } = await env.DB.prepare(
              'SELECT symbol, price, currency, jpy, usd, updated_at, ' +
              'price_1d, jpy_1d, usd_1d, updated_1d_at, ' +
              'price_1m, jpy_1m, usd_1m, updated_1m_at, ' +
              'price_3m, jpy_3m, usd_3m, updated_3m_at, ' +
              'price_6m, jpy_6m, usd_6m, updated_6m_at, ' +
              'price_1y, jpy_1y, usd_1y, updated_1y_at, ' +
              'price_3y, jpy_3y, usd_3y, updated_3y_at ' +
              'FROM quotes ORDER BY symbol'
            ).all();
            return json(results);
          } catch (e) {
            // maybe table not exists yet
            return json([]);
          }
        }
        return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,OPTIONS' });
      }
      if (url.pathname === '/api/portfolio_with_prices') {
        if (request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,OPTIONS' });
        }
        // ensure holdings has company_name column for join output
        try {
          await ensureHoldingsSchema(env);
        } catch (e) {}
        // ensure quotes table exists and migrated (1d/1m/3m/6m/1y/3y)
        try { await ensureQuotesSchema(env); } catch (e) {}
        try {
          const { results } = await env.DB.prepare(
            `SELECT h.symbol,
                    h.shares,
                    h.currency AS currency,
                    h.company_name AS company_name,
                    q.price,
                    q.jpy,
                    q.usd,
                    q.currency AS price_currency,
                    q.updated_at,
                    q.price_1d, q.jpy_1d, q.usd_1d, q.updated_1d_at,
                    q.price_1m, q.jpy_1m, q.usd_1m, q.updated_1m_at,
                    q.price_3m, q.jpy_3m, q.usd_3m, q.updated_3m_at,
                    q.price_6m, q.jpy_6m, q.usd_6m, q.updated_6m_at,
                    q.price_1y, q.jpy_1y, q.usd_1y, q.updated_1y_at,
                    q.price_3y, q.jpy_3y, q.usd_3y, q.updated_3y_at
               FROM holdings h
               LEFT JOIN quotes q ON q.symbol = h.symbol
               ORDER BY h.symbol`
          ).all();
          return json(results);
        } catch (e) {
          return json({ error: 'server error', detail: String(e) }, 500);
        }
      }
      if (url.pathname === '/api/quotes/refresh') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,POST,OPTIONS' });
        }
        // New behavior: run current and baselines refresh sequentially (compat)
        const a = await refreshCurrent(env, request); // updates price/jpy
        const b = await refreshBaselines(env, request); // updates 1m/3m/6m/1y/3y
        return json({ ok: true, updated_current: a.updated, updated_baselines: b.updated });
      }
      if (url.pathname === '/api/quotes/refresh-current') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,POST,OPTIONS' });
        }
        const r = await refreshCurrent(env, request);
        return json({ ok: true, updated: r.updated });
      }
      if (url.pathname === '/api/quotes/refresh-baselines') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,POST,OPTIONS' });
        }
        const r = await refreshBaselines(env, request);
        return json({ ok: true, updated: r.updated });
      }
      // Admin: reorder DB columns by recreating tables in canonical order
      if (url.pathname === '/admin/reorder-columns') {
        if (request.method !== 'POST' && request.method !== 'GET') {
          return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,POST,OPTIONS' });
        }
        try{
          await reorderHoldings(env);
        }catch(e){ /* ignore */ }
        try{
          await reorderQuotes(env);
        }catch(e){ /* ignore */ }
        return json({ ok: true });
      }
      if (url.pathname === '/api/portfolio') {
        if (request.method === 'GET') {
          try { await ensureHoldingsSchema(env); } catch(e){}
          const { results } = await env.DB.prepare(
            'SELECT symbol, shares, currency, company_name FROM holdings ORDER BY symbol'
          ).all();
          return json(results);
        } else if (request.method === 'POST') {
          const body = await request.json();
          const sym = String(body.symbol || '').trim();
          const shares = Number(body.shares);
          const cur = body.currency ? String(body.currency).trim() : null;
          const name = body.company_name ? String(body.company_name).trim() : (body.name ? String(body.name).trim() : null);
          if (!sym) return json({ error: 'symbol required' }, 400);
          try { await ensureHoldingsSchema(env); } catch(e){}
          await env.DB.prepare(
            'INSERT INTO holdings(symbol, shares, currency, company_name) VALUES(?,?,?,?) '
            + 'ON CONFLICT(symbol) DO UPDATE SET shares=excluded.shares, currency=excluded.currency, company_name=COALESCE(excluded.company_name, company_name)'
          ).bind(sym, shares, cur, name).run();
          return json({ ok: true });
        } else if (request.method === 'DELETE') {
          const sym = url.searchParams.get('symbol');
          if (!sym) return json({ error: 'symbol required' }, 400);
          await env.DB.prepare('DELETE FROM holdings WHERE symbol = ?')
            .bind(sym)
            .run();
          return json({ ok: true });
        }
        return json({ error: 'method not allowed' }, 405, { 'Allow': 'GET,POST,DELETE,OPTIONS' });
      } else if (url.pathname === '/' || url.pathname.startsWith('/quote')) {
        const symsParam = url.searchParams.get('symbols')
          || url.searchParams.get('s')
          || url.searchParams.get('symbol')
          || url.searchParams.get('q');
        let symbols = [];
        if (symsParam) {
          symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);
        } else if (/^\/quote\//.test(url.pathname)) {
          const tail = url.pathname.replace(/^\/quote\//, '');
          symbols = decodeURIComponent(tail).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (!symbols.length) return json({ error: 'missing symbols' }, 400);
        
        symbols = [...new Set(symbols.map(s => s.toUpperCase()))];

        const preferStooq = url.searchParams.get('prefer') === 'stooq' || url.searchParams.get('source') === 'stooq';
        const useFallback = url.searchParams.get('fallback') === 'stooq';

        let quotes = {};
        if (preferStooq) {
          // Stooq first
          try {
            quotes = await fetchStooq(symbols);
          } catch (e) {}
          // Fill missing from Yahoo (only for non-.T symbols to avoid JP mis-currency)
          const missing = symbols.filter(s => !quotes[s]);
          const missingNonJpx = missing.filter(s => !/\.T$/i.test(s));
          if (missingNonJpx.length) {
            try {
              const add = await fetchYahoo(missingNonJpx);
              for (const s of missingNonJpx) { if (add[s] && quotes[s] == null) quotes[s] = add[s]; }
            } catch (e) {}
          }
          // Still missing? allow Yahoo fill even for .T to avoid empty quotes
          const missingAll = symbols.filter(s => !quotes[s]);
          if (missingAll.length) {
            try {
              const addAll = await fetchYahoo(missingAll);
              for (const s of missingAll) { if (addAll[s] && quotes[s] == null) quotes[s] = addAll[s]; }
            } catch (e) {}
          }
          // Always ensure USDJPY=X is present by Yahoo if Stooq didn't provide it
          if (!quotes['USDJPY=X'] && symbols.includes('USDJPY=X')) {
            try {
              const y = await fetchYahoo(['USDJPY=X']);
              if (y['USDJPY=X']) quotes['USDJPY=X'] = y['USDJPY=X'];
            } catch (e) {}
          }
          // Merge prevClose (and currency if missing) from Yahoo for all symbols to enable DoD
          try {
            const yall = await fetchYahoo(symbols);
            for (const s of Object.keys(yall)) {
              quotes[s] = quotes[s] || {};
              if (Number.isFinite(yall[s].prevClose)) quotes[s].prevClose = yall[s].prevClose;
              if (!quotes[s].currency && yall[s].currency) quotes[s].currency = yall[s].currency;
            }
          } catch (e) {}
          // Add 1d / 30d / 365d closes from Yahoo charts
          try {
            const bases = await fetchYahooBaselines(symbols);
            for (const s of Object.keys(bases)) {
              quotes[s] = quotes[s] || {};
              if (Number.isFinite(bases[s].prevClose)) quotes[s].prevClose = bases[s].prevClose;
              if (Number.isFinite(bases[s].prevClose30d)) quotes[s].prevClose30d = bases[s].prevClose30d;
              if (Number.isFinite(bases[s].prevClose365d)) quotes[s].prevClose365d = bases[s].prevClose365d;
            }
          } catch (e) {}
          // If still empty, fallback to Yahoo for all symbols (last resort)
          if (Object.keys(quotes).length === 0) {
            try {
              quotes = await fetchYahoo(symbols);
            } catch (e) {}
          }
        } else {
          // Yahoo first
          try {
            quotes = await fetchYahoo(symbols);
          } catch (e) {
            // swallow; may fallback
          }
          // Optional fallback: fill only missing from Stooq
          if (useFallback) {
            const missing = symbols.filter(s => !quotes[s]);
            if (missing.length) {
              try {
                const add = await fetchStooq(missing);
                for (const s of missing) {
                  if (add[s] && quotes[s] == null) quotes[s] = add[s];
                }
              } catch (e) {}
            }
          }
          // Add 1d / 30d / 365d closes from Yahoo charts after Yahoo-first
          try {
            const bases = await fetchYahooBaselines(symbols);
            for (const s of Object.keys(bases)) {
              quotes[s] = quotes[s] || {};
              if (Number.isFinite(bases[s].prevClose)) quotes[s].prevClose = bases[s].prevClose;
              if (Number.isFinite(bases[s].prevClose30d)) quotes[s].prevClose30d = bases[s].prevClose30d;
              if (Number.isFinite(bases[s].prevClose365d)) quotes[s].prevClose365d = bases[s].prevClose365d;
            }
          } catch (e) {}
        }

        // 3) Normalize USDJPY (invert if necessary), ensure .T as JPY currency
        if (quotes['USDJPY=X'] && isFinite(quotes['USDJPY=X'].regularMarketPrice)) {
          const r = quotes['USDJPY=X'].regularMarketPrice;
          if (r > 0 && r < 1) quotes['USDJPY=X'].regularMarketPrice = 1 / r;
          quotes['USDJPY=X'].currency = 'JPY';
          quotes['USDJPY=X'].source = quotes['USDJPY=X'].source || 'yahoo';
        }
        for (const s of Object.keys(quotes)) {
          if (/\.T$/i.test(s)) {
            quotes[s].currency = 'JPY';
          }
        }

        // Compute normalized JPY price using USDJPY when needed
        let usdJpy = quotes['USDJPY=X'] && Number(quotes['USDJPY=X'].regularMarketPrice);
        if (Number.isFinite(usdJpy) && usdJpy > 0 && usdJpy < 1) usdJpy = 1 / usdJpy;
        for (const s of Object.keys(quotes)) {
          const q = quotes[s];
          const p = Number(q && q.regularMarketPrice);
          if (!Number.isFinite(p)) continue;
          const cur = String(q.currency || '').toUpperCase();
          if (cur === 'JPY' || /\.T$/i.test(s)) {
            q.jpy = p;
          } else if (cur === 'USD' && Number.isFinite(usdJpy)) {
            q.jpy = p * usdJpy;
          }
          // Baseline JPY (approx using current FX for USD assets)
          if (Number.isFinite(q.prevClose)) {
            q.prevJpy = (cur === 'JPY' || /\.T$/i.test(s)) ? q.prevClose : (Number.isFinite(usdJpy) ? q.prevClose * usdJpy : undefined);
          }
          if (Number.isFinite(q.prevClose30d)) {
            q.prevJpy30d = (cur === 'JPY' || /\.T$/i.test(s)) ? q.prevClose30d : (Number.isFinite(usdJpy) ? q.prevClose30d * usdJpy : undefined);
          }
          if (Number.isFinite(q.prevClose365d)) {
            q.prevJpy365d = (cur === 'JPY' || /\.T$/i.test(s)) ? q.prevClose365d : (Number.isFinite(usdJpy) ? q.prevClose365d * usdJpy : undefined);
          }

          // Compute DoD/MoM/YoY percent changes in JPY domain if possible
          const j = Number(q.jpy);
          const pj1 = Number(q.prevJpy);
          const pj30 = Number(q.prevJpy30d);
          const pj365 = Number(q.prevJpy365d);
          if (Number.isFinite(j) && Number.isFinite(pj1) && pj1 > 0) q.jpyDoD = (j - pj1) / pj1;
          if (Number.isFinite(j) && Number.isFinite(pj30) && pj30 > 0) q.jpyMoM = (j - pj30) / pj30;
          if (Number.isFinite(j) && Number.isFinite(pj365) && pj365 > 0) q.jpyYoY = (j - pj365) / pj365;

          // Compute DoD/MoM/YoY percent changes in USD domain
          const isUSD = (cur === 'USD');
          const pu = Number(q.regularMarketPrice);
          const pu1 = Number(q.prevClose);
          const pu30 = Number(q.prevClose30d);
          const pu365 = Number(q.prevClose365d);
          if (isUSD) {
            if (Number.isFinite(pu) && Number.isFinite(pu1) && pu1 > 0) q.usdDoD = (pu - pu1) / pu1;
            if (Number.isFinite(pu) && Number.isFinite(pu30) && pu30 > 0) q.usdMoM = (pu - pu30) / pu30;
            if (Number.isFinite(pu) && Number.isFinite(pu365) && pu365 > 0) q.usdYoY = (pu - pu365) / pu365;
          } else {
            // When not USD, ratios are identical across currencies if FX is applied consistently.
            if (Number.isFinite(q.jpyDoD)) q.usdDoD = q.jpyDoD;
            if (Number.isFinite(q.jpyMoM)) q.usdMoM = q.jpyMoM;
            if (Number.isFinite(q.jpyYoY)) q.usdYoY = q.jpyYoY;
          }
        }

        return json({ quotes }, 200, { 'Cache-Control': 'public, s-maxage=60, max-age=30' });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error', detail: String(e) }, 500);
    }
    return json({ error: 'not found' }, 404);
  }
};

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json; charset=utf-8',
    ...extra
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders(extraHeaders) });
}

async function ensureHoldingsSchema(env){
  // Create if not exists (non-destructive) and add company_name if missing
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS holdings (symbol TEXT PRIMARY KEY, company_name TEXT, shares REAL NOT NULL, currency TEXT)')
      .run();
  } catch(_){ }
  try {
    await env.DB.prepare('ALTER TABLE holdings ADD COLUMN company_name TEXT').run();
  } catch(_){ /* ignore if exists */ }
}

async function reorderHoldings(env){
  // Rename old table; create new with canonical order; copy; drop old
  try { await env.DB.prepare('ALTER TABLE holdings RENAME TO holdings_old').run(); } catch(_){ /* maybe not exists */ }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS holdings (symbol TEXT PRIMARY KEY, company_name TEXT, shares REAL NOT NULL, currency TEXT)').run();
  try {
    await env.DB.prepare('INSERT INTO holdings(symbol, company_name, shares, currency) SELECT symbol, company_name, shares, currency FROM holdings_old').run();
  } catch(_){ }
  try { await env.DB.prepare('DROP TABLE holdings_old').run(); } catch(_){ }
}

async function reorderQuotes(env){
  await ensureQuotesSchema(env);
  try { await env.DB.prepare('ALTER TABLE quotes RENAME TO quotes_old').run(); } catch(_){ /* not exists */ }
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS quotes ('+
    'symbol TEXT PRIMARY KEY, '+
    'price REAL, currency TEXT, jpy REAL, usd REAL, updated_at TEXT, '+
    'price_1d REAL, jpy_1d REAL, usd_1d REAL, updated_1d_at TEXT, '+
    'price_1m REAL, jpy_1m REAL, usd_1m REAL, updated_1m_at TEXT, '+
    'price_3m REAL, jpy_3m REAL, usd_3m REAL, updated_3m_at TEXT, '+
    'price_6m REAL, jpy_6m REAL, usd_6m REAL, updated_6m_at TEXT, '+
    'price_1y REAL, jpy_1y REAL, usd_1y REAL, updated_1y_at TEXT, '+
    'price_3y REAL, jpy_3y REAL, usd_3y REAL, updated_3y_at TEXT)'
  ).run();
  try {
    await env.DB.prepare(
      'INSERT INTO quotes('+
        'symbol, price, currency, jpy, usd, updated_at, '+
        'price_1d, jpy_1d, usd_1d, updated_1d_at, '+
        'price_1m, jpy_1m, usd_1m, updated_1m_at, '+
        'price_3m, jpy_3m, usd_3m, updated_3m_at, '+
        'price_6m, jpy_6m, usd_6m, updated_6m_at, '+
        'price_1y, jpy_1y, usd_1y, updated_1y_at, '+
        'price_3y, jpy_3y, usd_3y, updated_3y_at'+
      ') SELECT '+
        'symbol, price, currency, jpy, NULL as usd, updated_at, '+
        'price_1d, jpy_1d, NULL as usd_1d, updated_1d_at, '+
        'price_1m, jpy_1m, NULL as usd_1m, updated_1m_at, '+
        'price_3m, jpy_3m, NULL as usd_3m, updated_3m_at, '+
        'price_6m, jpy_6m, NULL as usd_6m, updated_6m_at, '+
        'price_1y, jpy_1y, NULL as usd_1y, updated_1y_at, '+
        'price_3y, jpy_3y, NULL as usd_3y, updated_3y_at FROM quotes_old'
    ).run();
  } catch(_){ }
  try { await env.DB.prepare('DROP TABLE quotes_old').run(); } catch(_){ }
}

async function fetchYahoo(symbols) {
  if (!symbols.length) return {};
  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)', 'Accept': 'application/json' };
  const urls = [
    'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(',')),
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','))
  ];
  let arr = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: ua });
      if (!res.ok) continue;
      const j = await res.json();
      arr = (j && j.quoteResponse && j.quoteResponse.result) || [];
      if (arr.length) break;
    } catch (e) { /* try next */ }
  }
  const out = {};
  for (const r of arr) {
    if (r && r.symbol && Number.isFinite(r.regularMarketPrice)) {
      const sym = String(r.symbol).toUpperCase();
      const obj = { regularMarketPrice: r.regularMarketPrice };
      if (r.currency) obj.currency = String(r.currency).toUpperCase();
      if (Number.isFinite(r.regularMarketPreviousClose)) obj.prevClose = r.regularMarketPreviousClose;
      obj.source = 'yahoo';
      out[sym] = obj;
    }
  }
  // Ensure prevClose is populated per-symbol via chart when missing
  const missingPrev = symbols.filter(s => {
    const sym = String(s).toUpperCase();
    return out[sym] && !Number.isFinite(out[sym].prevClose);
  });
  for (const s of missingPrev) {
    try {
      const r = await fetchYahooChart(String(s).toUpperCase());
      if (r && r.indicators && r.indicators.quote && r.indicators.quote[0]){
        const closes = r.indicators.quote[0].close || [];
        const finite = closes.filter(x=>Number.isFinite(x));
        if (finite.length >= 2) {
          // previous close = the second latest finite close
          out[String(s).toUpperCase()].prevClose = finite[finite.length-2];
        }
      }
    } catch (e) {}
  }
  // Fallback per-symbol via v8 chart API if batch returned nothing
  if (!Object.keys(out).length) {
    for (const s of symbols) {
      const sym = String(s).toUpperCase();
      const chartUrls = [
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`
      ];
      for (const cu of chartUrls) {
        try {
          const res = await fetch(cu, { headers: ua });
          if (!res.ok) continue;
          const j = await res.json();
          const r = j && j.chart && j.chart.result && j.chart.result[0];
          if (!r || !r.meta) continue;
          let price = r.meta.regularMarketPrice;
          if (!Number.isFinite(price)) {
            // try last close when meta missing
            const ind = r.indicators && r.indicators.quote && r.indicators.quote[0];
            if (ind && Array.isArray(ind.close)) {
              const closes = ind.close.filter((x)=>Number.isFinite(x));
              if (closes.length) price = closes[closes.length-1];
            }
          }
          if (Number.isFinite(price)) {
            const obj = { regularMarketPrice: price, source: 'yahoo' };
            if (r.meta.currency) obj.currency = String(r.meta.currency).toUpperCase();
            out[sym] = obj;
            break;
          }
        } catch (e) { /* try next */ }
      }
    }
  }
  return out;
}

function stooqVariantsForSymbol(sym) {
  const s = String(sym).toUpperCase();
  // USDJPY special
  if (s === 'USDJPY=X') return ['usdjpy', 'USDJPY'];
  // JP stocks like 8306.T → try multiple forms
  if (/\.T$/.test(s)) {
    const base = s.replace(/\.T$/, '');
    return [
      base.toLowerCase() + '.jp',
      base + '.JP',
      base // sometimes Stooq returns bare code
    ];
  }
  // Default to US
  return [s.toLowerCase() + '.us', s + '.US', s];
}

function buildStooqMap(symbols) {
  const list = [];
  const map = {}; // stooqSym(lower) -> original
  for (const sym of symbols) {
    const variants = stooqVariantsForSymbol(sym);
    for (const v of variants) {
      const key = String(v).toLowerCase();
      if (!map[key]) {
        map[key] = String(sym).toUpperCase();
        list.push(v);
      }
    }
  }
  return { list, map };
}

function parseStooqCSV(text) {
  const out = {};
  if (!text) return out;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1) return out;
  lines.shift();
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split(',');
    const sym = cols[0];
    const close = parseFloat(cols[6]);
    if (sym && Number.isFinite(close)) {
      out[sym.toLowerCase()] = { regularMarketPrice: close };
    }
  }
  return out;
}

async function fetchStooq(symbols) {
  if (!symbols.length) return {};
  const { list: stooqSyms, map: m } = buildStooqMap(symbols);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)', 'Accept': 'text/csv,*/*;q=0.1' };
  const chunkSize = 30; // avoid too-long URLs
  const toChunks = (arr, n) => arr.reduce((acc,_,i)=> (i%n? acc: acc.concat([arr.slice(i,i+n)])), []);
  const chunks = toChunks(stooqSyms, chunkSize);

  async function fetchFromHost(host) {
    const parsedAll = {};
    for (const ch of chunks) {
      const urlHttps = `https://${host}/q/l/?s=` + encodeURIComponent(ch.join(',')) + '&f=sd2t2ohlcv&h&e=csv';
      const urlHttp  = `http://${host}/q/l/?s=`  + encodeURIComponent(ch.join(',')) + '&f=sd2t2ohlcv&h&e=csv';
      let ok = false;
      for (const u of [urlHttps, urlHttp]) {
        try {
          const res = await fetch(u, { headers, redirect: 'follow' });
          if (!res.ok) continue;
          const txt = await res.text();
          const p = parseStooqCSV(txt);
          if (Object.keys(p).length) {
            Object.assign(parsedAll, p);
            ok = true;
            break;
          }
        } catch (e) { /* try next url */ }
      }
      // continue even if both failed (next chunk)
    }
    return parsedAll;
  }

  // Try stooq.com, then stooq.pl
  let parsedAll = await fetchFromHost('stooq.com');
  if (!Object.keys(parsedAll).length) {
    try { parsedAll = await fetchFromHost('stooq.pl'); } catch (e) {}
  }

  const out = {};
  for (const stooqSym of Object.keys(parsedAll)) {
    const orig = m[stooqSym];
    if (orig) {
      out[orig] = { ...parsedAll[stooqSym], source: 'stooq' };
    }
  }
  return out;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchYahooChart(sym, range = '5y') {
  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)', 'Accept': 'application/json' };
  const enc = encodeURIComponent(sym);
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${enc}?range=${encodeURIComponent(range)}&interval=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?range=${encodeURIComponent(range)}&interval=1d`
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: ua });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (r && r.timestamp && r.indicators && r.indicators.quote && r.indicators.quote[0]) return r;
    } catch (e) {}
  }
  return null;
}

function pickBaselineAt(r, daysAgo) {
  try {
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const closes = q.close || [];
    const now = Math.floor(Date.now()/1000);
    const cutoff = now - Math.floor(daysAgo*86400);
    let bestIdx = -1;
    for (let i=0;i<ts.length;i++){
      const t = ts[i];
      const c = closes[i];
      if (!Number.isFinite(c)) continue;
      if (t <= cutoff) bestIdx = i; else break;
    }
    if (bestIdx >= 0) return closes[bestIdx];
    for (let i=0;i<closes.length;i++){ if (Number.isFinite(closes[i])) return closes[i]; }
  } catch(e) {}
  return undefined;
}

// Batch baselines via Yahoo Spark API (multiple symbols per request)
async function fetchYahooSparkBaselines(symbols) {
  const out = {};
  if (!symbols.length) return out;
  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)', 'Accept': 'application/json' };
  const chunkSize = 40; // keep URL length reasonable
  const toChunks = (arr, n) => arr.reduce((acc,_,i)=> (i%n? acc: acc.concat([arr.slice(i,i+n)])), []);
  const chunks = toChunks(symbols, chunkSize);
  function parseAndAcc(j) {
    try{
      const list = (j && j.spark && Array.isArray(j.spark.result)) ? j.spark.result
                 : (Array.isArray(j && j.result) ? j.result : []);
      for (const item of list) {
        try{
          const sym = String(item.symbol || item.ticker || item.id || (item.meta && item.meta.symbol) || '').toUpperCase();
          const resp = (item.response && item.response[0]) || item;
          const ts = resp && resp.timestamp;
          const q = (resp && resp.indicators && resp.indicators.quote && resp.indicators.quote[0]) || {};
          const closes = (q && q.close) || [];
          if (!Array.isArray(ts) || !Array.isArray(closes) || !closes.length) continue;
          // prev1d: second last finite close
          let prev1d;
          for (let k = closes.length - 1, cnt=0; k >= 0; k--) {
            const c = closes[k]; if (!Number.isFinite(c)) continue; cnt++; if (cnt === 2){ prev1d = c; break; }
          }
          const b30 = pickBaselineAt(resp, 30);
          const b90 = pickBaselineAt(resp, 90);
          const b180 = pickBaselineAt(resp, 180);
          const b365 = pickBaselineAt(resp, 365);
          const b1095 = pickBaselineAt(resp, 1095);
          if (!out[sym]) out[sym] = {};
          if (Number.isFinite(prev1d) && out[sym].prevClose == null) out[sym].prevClose = prev1d;
          if (Number.isFinite(b30) && out[sym].prevClose30d == null) out[sym].prevClose30d = b30;
          if (Number.isFinite(b90) && out[sym].prevClose90d == null) out[sym].prevClose90d = b90;
          if (Number.isFinite(b180) && out[sym].prevClose180d == null) out[sym].prevClose180d = b180;
          if (Number.isFinite(b365) && out[sym].prevClose365d == null) out[sym].prevClose365d = b365;
          if (Number.isFinite(b1095) && out[sym].prevClose1095d == null) out[sym].prevClose1095d = b1095;
        }catch(_){ }
      }
    }catch(_){ }
  }
  for (const ch of chunks) {
    const sy = encodeURIComponent(ch.join(','));
    const urls = [
      `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${sy}&range=5y&interval=1d`,
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${sy}&range=5y&interval=1d`,
      `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${sy}&range=5y&interval=1d`,
      `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${sy}&range=5y&interval=1d`
    ];
    let ok = false;
    for (const u of urls) {
      try{
        const res = await fetch(u, { headers: ua });
        if (!res.ok) continue;
        const j = await res.json();
        parseAndAcc(j);
        ok = true;
        break;
      }catch(_){ }
    }
    if (!ok) {
      // Fallback to per-symbol chart for this chunk (kept minimal)
      for (const s of ch) {
        try{
          const r = await fetchYahooChart(s);
          if (!r) continue;
          const sym = String(s).toUpperCase();
          if (!out[sym]) out[sym] = {};
          // prev1d
          try{
            const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
            const closes = (q && q.close) || [];
            let prev1d;
            for (let k = closes.length - 1, cnt=0; k >= 0; k--) { const c = closes[k]; if (!Number.isFinite(c)) continue; cnt++; if (cnt===2){ prev1d = c; break; } }
            if (Number.isFinite(prev1d)) out[sym].prevClose = prev1d;
          }catch(_){ }
          const b30 = pickBaselineAt(r, 30);
          const b90 = pickBaselineAt(r, 90);
          const b180 = pickBaselineAt(r, 180);
          const b365 = pickBaselineAt(r, 365);
          const b1095 = pickBaselineAt(r, 1095);
          if (Number.isFinite(b30)) out[sym].prevClose30d = b30;
          if (Number.isFinite(b90)) out[sym].prevClose90d = b90;
          if (Number.isFinite(b180)) out[sym].prevClose180d = b180;
          if (Number.isFinite(b365)) out[sym].prevClose365d = b365;
          if (Number.isFinite(b1095)) out[sym].prevClose1095d = b1095;
        }catch(_){ }
      }
    }
  }
  return out;
}

async function fetchYahooBaselines(symbols) {
  // Try Spark first (few subrequests for many symbols)
  const out = await fetchYahooSparkBaselines(symbols);
  // Fallback per-symbol for any still-missing baselines, but cap to avoid subrequest limit (50)
  const missing = symbols.filter(s => {
    const v = out[String(s).toUpperCase()] || {};
    return !(Number.isFinite(v.prevClose) && (
      Number.isFinite(v.prevClose30d) || Number.isFinite(v.prevClose90d) || Number.isFinite(v.prevClose180d) || Number.isFinite(v.prevClose365d) || Number.isFinite(v.prevClose1095d)
    ));
  });
  const limit = Math.min(50, symbols.length); // safe cap respecting Cloudflare subrequest limits
  for (let i = 0; i < Math.min(limit, missing.length); i++){
    const s = missing[i];
    try{
      const r = await fetchYahooChart(s);
      if (!r) continue;
      const sym = String(s).toUpperCase();
      if (!out[sym]) out[sym] = {};
      let prev1d;
      try{
        const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
        const closes = (q && q.close) || [];
        for (let k = closes.length - 1, cnt=0; k >= 0; k--) { const c = closes[k]; if (!Number.isFinite(c)) continue; cnt++; if (cnt===2){ prev1d = c; break; } }
      }catch(_){ }
      const b30 = pickBaselineAt(r, 30);
      const b90 = pickBaselineAt(r, 90);
      const b180 = pickBaselineAt(r, 180);
      const b365 = pickBaselineAt(r, 365);
      const b1095 = pickBaselineAt(r, 1095);
      if (Number.isFinite(prev1d)) out[sym].prevClose = prev1d;
      if (Number.isFinite(b30)) out[sym].prevClose30d = b30;
      if (Number.isFinite(b90)) out[sym].prevClose90d = b90;
      if (Number.isFinite(b180)) out[sym].prevClose180d = b180;
      if (Number.isFinite(b365)) out[sym].prevClose365d = b365;
      if (Number.isFinite(b1095)) out[sym].prevClose1095d = b1095;
    }catch(_){ }
  }
  return out;
}

// ----------------- Refresh helpers (split current / baselines) -----------------
async function ensureQuotesSchema(env){
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS quotes (symbol TEXT PRIMARY KEY, price REAL, currency TEXT, jpy REAL, usd REAL, updated_at TEXT, ' +
    'price_1d REAL, jpy_1d REAL, usd_1d REAL, updated_1d_at TEXT, ' +
    'price_1m REAL, jpy_1m REAL, usd_1m REAL, updated_1m_at TEXT, ' +
    'price_3m REAL, jpy_3m REAL, usd_3m REAL, updated_3m_at TEXT, ' +
    'price_6m REAL, jpy_6m REAL, usd_6m REAL, updated_6m_at TEXT, ' +
    'price_1y REAL, jpy_1y REAL, usd_1y REAL, updated_1y_at TEXT, ' +
    'price_3y REAL, jpy_3y REAL, usd_3y REAL, updated_3y_at TEXT)'
  ).run();
  const addCols = [
    "ALTER TABLE quotes ADD COLUMN usd REAL",
    "ALTER TABLE quotes ADD COLUMN price_1d REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_1d REAL",
    "ALTER TABLE quotes ADD COLUMN usd_1d REAL",
    "ALTER TABLE quotes ADD COLUMN updated_1d_at TEXT",
    "ALTER TABLE quotes ADD COLUMN price_1m REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_1m REAL",
    "ALTER TABLE quotes ADD COLUMN usd_1m REAL",
    "ALTER TABLE quotes ADD COLUMN updated_1m_at TEXT",
    "ALTER TABLE quotes ADD COLUMN price_3m REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_3m REAL",
    "ALTER TABLE quotes ADD COLUMN usd_3m REAL",
    "ALTER TABLE quotes ADD COLUMN updated_3m_at TEXT",
    "ALTER TABLE quotes ADD COLUMN price_6m REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_6m REAL",
    "ALTER TABLE quotes ADD COLUMN usd_6m REAL",
    "ALTER TABLE quotes ADD COLUMN updated_6m_at TEXT",
    "ALTER TABLE quotes ADD COLUMN price_1y REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_1y REAL",
    "ALTER TABLE quotes ADD COLUMN usd_1y REAL",
    "ALTER TABLE quotes ADD COLUMN updated_1y_at TEXT",
    "ALTER TABLE quotes ADD COLUMN price_3y REAL",
    "ALTER TABLE quotes ADD COLUMN jpy_3y REAL",
    "ALTER TABLE quotes ADD COLUMN usd_3y REAL",
    "ALTER TABLE quotes ADD COLUMN updated_3y_at TEXT",
  ];
  for (const sql of addCols) { try{ await env.DB.prepare(sql).run(); }catch(_){ } }
}

async function loadSymbols(env, request){
  const url = new URL(request.url);
  const symsParam = url.searchParams.get('symbols') || url.searchParams.get('s') || url.searchParams.get('symbol');
  if (symsParam){
    const arr = symsParam.split(',').map(s => s.trim()).filter(Boolean);
    return Array.from(new Set(arr.map(s => s.toUpperCase())));
  }
  const { results: holdings } = await env.DB.prepare('SELECT symbol FROM holdings ORDER BY symbol').all();
  return Array.from(new Set((holdings || []).map(r => String(r.symbol || '').toUpperCase()).filter(Boolean)));
}

async function refreshCurrent(env, request){
  let symbols = await loadSymbols(env, request);
  if (!symbols.length) return { updated: 0 };
  if (!symbols.includes('USDJPY=X')) symbols.push('USDJPY=X');
  // Fetch current quotes
  let quotes = {};
  try { quotes = await fetchYahoo(symbols); } catch (_) {}
  const missing = symbols.filter(s => !quotes[s]);
  if (missing.length) {
    try{
      const add = await fetchStooq(missing);
      for (const s of missing){ if (add[s] && quotes[s] == null) quotes[s] = add[s]; }
    }catch(_){ }
  }
  // Ensure prevClose (1d baseline) exists using Yahoo baselines when missing
  try{
    const needPrev = symbols.filter(s => s !== 'USDJPY=X' && quotes[s] && !Number.isFinite(quotes[s].prevClose));
    if (needPrev.length){
      const bases = await fetchYahooBaselines(needPrev);
      for (const s of Object.keys(bases || {})){
        const b = bases[s] || {};
        if (!quotes[s]) quotes[s] = {};
        if (Number.isFinite(b.prevClose)) quotes[s].prevClose = b.prevClose;
      }
    }
  }catch(_){ }
  // Normalize currencies and FX
  if (quotes['USDJPY=X'] && isFinite(quotes['USDJPY=X'].regularMarketPrice)){
    const r = quotes['USDJPY=X'].regularMarketPrice; if (r > 0 && r < 1) quotes['USDJPY=X'].regularMarketPrice = 1 / r;
    quotes['USDJPY=X'].currency = 'JPY';
  }
  for (const s of Object.keys(quotes)) { if (/\.T$/i.test(s)) quotes[s].currency = 'JPY'; }
  let usdJpy = quotes['USDJPY=X'] && Number(quotes['USDJPY=X'].regularMarketPrice);
  if (Number.isFinite(usdJpy) && usdJpy > 0 && usdJpy < 1) usdJpy = 1 / usdJpy;
  await ensureQuotesSchema(env);
  const now = new Date().toISOString();
  let updated = 0;
  for (const s of symbols){
    if (s === 'USDJPY=X') continue;
    const q = quotes[s]; if (!q) continue;
    const p = Number(q.regularMarketPrice); if (!Number.isFinite(p)) continue;
    const cur = String(q.currency || '').toUpperCase() || null;
    let jpy = null; if (cur === 'JPY' || /\.T$/i.test(s)) jpy = p; else if (cur === 'USD' && Number.isFinite(usdJpy)) jpy = p * usdJpy;
    let usd = null; if (cur === 'USD') usd = p; else if ((cur === 'JPY' || /\.T$/i.test(s)) && Number.isFinite(usdJpy)) usd = p / usdJpy;
    // 1D baselines from prevClose if available
    let p1d = null, j1d = null;
    const prev = Number(q.prevClose);
    if (Number.isFinite(prev)) {
      p1d = prev;
      if (cur === 'JPY' || /\.T$/i.test(s)) j1d = prev; else if (cur === 'USD' && Number.isFinite(usdJpy)) j1d = prev * usdJpy;
    }
    let u1d = null;
    if (Number.isFinite(prev)) {
      if (cur === 'USD') u1d = prev; else if ((cur === 'JPY' || /\.T$/i.test(s)) && Number.isFinite(usdJpy)) u1d = prev / usdJpy;
    }
    await env.DB.prepare(
      'INSERT INTO quotes(symbol, price, currency, jpy, usd, updated_at, price_1d, jpy_1d, usd_1d, updated_1d_at) VALUES(?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(symbol) DO UPDATE SET ' +
      'price=excluded.price, currency=excluded.currency, jpy=excluded.jpy, usd=excluded.usd, updated_at=excluded.updated_at, ' +
      'price_1d=COALESCE(excluded.price_1d, price_1d), jpy_1d=COALESCE(excluded.jpy_1d, jpy_1d), usd_1d=COALESCE(excluded.usd_1d, usd_1d), ' +
      'updated_1d_at=CASE WHEN excluded.price_1d IS NOT NULL THEN excluded.updated_1d_at ELSE updated_1d_at END'
    ).bind(s, p, cur, jpy, usd, now,
           Number.isFinite(p1d)? p1d : null,
           Number.isFinite(j1d)? j1d : null,
           Number.isFinite(u1d)? u1d : null,
           Number.isFinite(p1d)? now : null).run();
    updated++;
  }
  return { updated };
}

async function refreshBaselines(env, request){
  const symbolsAll = (await loadSymbols(env, request)).filter(s => s !== 'USDJPY=X');
  if (!symbolsAll.length) return { updated: 0 };
  // Only refresh when needed based on per-period updated_*_at date (UTC day)
  await ensureQuotesSchema(env);
  let existing = {};
  try {
    const { results } = await env.DB.prepare('SELECT symbol, updated_1m_at, updated_3m_at, updated_6m_at, updated_1y_at, updated_3y_at FROM quotes').all();
    for (const r of results || []) { existing[String(r.symbol).toUpperCase()] = r; }
  } catch(_){}
  const today = new Date().toISOString().slice(0,10);
  const url = new URL(request.url);
  const force = (url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true');
  function needUpdate(sym, col){ const row = existing[sym]; const v = row && row[col]; return !v || String(v).slice(0,10) !== today; }
  const symbols = force ? symbolsAll : symbolsAll.filter(s => {
    const U = s.toUpperCase();
    return needUpdate(U,'updated_1m_at') || needUpdate(U,'updated_3m_at') || needUpdate(U,'updated_6m_at') || needUpdate(U,'updated_1y_at') || needUpdate(U,'updated_3y_at');
  });
  if (!symbols.length) return { updated: 0 };
  // Get currencies + usdjpy
  let quotes = {};
  try { quotes = await fetchYahoo([...symbols, 'USDJPY=X']); } catch(_){ }
  if (quotes['USDJPY=X'] && isFinite(quotes['USDJPY=X'].regularMarketPrice)){
    const r = quotes['USDJPY=X'].regularMarketPrice; if (r > 0 && r < 1) quotes['USDJPY=X'].regularMarketPrice = 1 / r;
    quotes['USDJPY=X'].currency = 'JPY';
  }
  for (const s of Object.keys(quotes)) { if (/\.T$/i.test(s)) quotes[s].currency = 'JPY'; }
  let usdJpy = quotes['USDJPY=X'] && Number(quotes['USDJPY=X'].regularMarketPrice);
  if (Number.isFinite(usdJpy) && usdJpy > 0 && usdJpy < 1) usdJpy = 1 / usdJpy;
  // Baselines
  let bases = {};
  try { bases = await fetchYahooBaselines(symbols); } catch(_){ }
  await ensureQuotesSchema(env);
  const now = new Date().toISOString();
  let updated = 0;
  for (const s of symbols){
    const b = bases && bases[s] || {};
    const cur = String((quotes[s] && quotes[s].currency) || ( /\.T$/i.test(s) ? 'JPY' : 'USD')).toUpperCase();
    const v1m = Number(b.prevClose30d);
    const v3m = Number(b.prevClose90d);
    const v6m = Number(b.prevClose180d);
    const v1y = Number(b.prevClose365d);
    const v3y = Number(b.prevClose1095d);
    const j1m = Number.isFinite(v1m) ? ((cur==='JPY'||/\.T$/i.test(s))? v1m : (Number.isFinite(usdJpy)? v1m*usdJpy : null)) : null;
    const j3m = Number.isFinite(v3m) ? ((cur==='JPY'||/\.T$/i.test(s))? v3m : (Number.isFinite(usdJpy)? v3m*usdJpy : null)) : null;
    const j6m = Number.isFinite(v6m) ? ((cur==='JPY'||/\.T$/i.test(s))? v6m : (Number.isFinite(usdJpy)? v6m*usdJpy : null)) : null;
    const j1y = Number.isFinite(v1y) ? ((cur==='JPY'||/\.T$/i.test(s))? v1y : (Number.isFinite(usdJpy)? v1y*usdJpy : null)) : null;
    const j3y = Number.isFinite(v3y) ? ((cur==='JPY'||/\.T$/i.test(s))? v3y : (Number.isFinite(usdJpy)? v3y*usdJpy : null)) : null;
    const u1m = Number.isFinite(v1m) ? ((cur==='USD' && !/\.T$/i.test(s))? v1m : (Number.isFinite(usdJpy)? v1m/usdJpy : null)) : null;
    const u3m = Number.isFinite(v3m) ? ((cur==='USD' && !/\.T$/i.test(s))? v3m : (Number.isFinite(usdJpy)? v3m/usdJpy : null)) : null;
    const u6m = Number.isFinite(v6m) ? ((cur==='USD' && !/\.T$/i.test(s))? v6m : (Number.isFinite(usdJpy)? v6m/usdJpy : null)) : null;
    const u1y = Number.isFinite(v1y) ? ((cur==='USD' && !/\.T$/i.test(s))? v1y : (Number.isFinite(usdJpy)? v1y/usdJpy : null)) : null;
    const u3y = Number.isFinite(v3y) ? ((cur==='USD' && !/\.T$/i.test(s))? v3y : (Number.isFinite(usdJpy)? v3y/usdJpy : null)) : null;
    // If nothing to update, skip counting
    if (!Number.isFinite(v1m) && !Number.isFinite(v3m) && !Number.isFinite(v6m) && !Number.isFinite(v1y) && !Number.isFinite(v3y)) continue;
    await env.DB.prepare(
      'INSERT INTO quotes('+
        'symbol, price_1m, jpy_1m, usd_1m, updated_1m_at, '+
        'price_3m, jpy_3m, usd_3m, updated_3m_at, '+
        'price_6m, jpy_6m, usd_6m, updated_6m_at, '+
        'price_1y, jpy_1y, usd_1y, updated_1y_at, '+
        'price_3y, jpy_3y, usd_3y, updated_3y_at'+
      ') VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '+
      'ON CONFLICT(symbol) DO UPDATE SET '+
      'price_1m=COALESCE(excluded.price_1m, price_1m), jpy_1m=COALESCE(excluded.jpy_1m, jpy_1m), usd_1m=COALESCE(excluded.usd_1m, usd_1m), updated_1m_at=CASE WHEN excluded.price_1m IS NOT NULL THEN excluded.updated_1m_at ELSE updated_1m_at END, '+
      'price_3m=COALESCE(excluded.price_3m, price_3m), jpy_3m=COALESCE(excluded.jpy_3m, jpy_3m), usd_3m=COALESCE(excluded.usd_3m, usd_3m), updated_3m_at=CASE WHEN excluded.price_3m IS NOT NULL THEN excluded.updated_3m_at ELSE updated_3m_at END, '+
      'price_6m=COALESCE(excluded.price_6m, price_6m), jpy_6m=COALESCE(excluded.jpy_6m, jpy_6m), usd_6m=COALESCE(excluded.usd_6m, usd_6m), updated_6m_at=CASE WHEN excluded.price_6m IS NOT NULL THEN excluded.updated_6m_at ELSE updated_6m_at END, '+
      'price_1y=COALESCE(excluded.price_1y, price_1y), jpy_1y=COALESCE(excluded.jpy_1y, jpy_1y), usd_1y=COALESCE(excluded.usd_1y, usd_1y), updated_1y_at=CASE WHEN excluded.price_1y IS NOT NULL THEN excluded.updated_1y_at ELSE updated_1y_at END, '+
      'price_3y=COALESCE(excluded.price_3y, price_3y), jpy_3y=COALESCE(excluded.jpy_3y, jpy_3y), usd_3y=COALESCE(excluded.usd_3y, usd_3y), updated_3y_at=CASE WHEN excluded.price_3y IS NOT NULL THEN excluded.updated_3y_at ELSE updated_3y_at END'
    ).bind(
      s,
      Number.isFinite(v1m)? v1m : null, j1m, u1m, Number.isFinite(v1m)? now : null,
      Number.isFinite(v3m)? v3m : null, j3m, u3m, Number.isFinite(v3m)? now : null,
      Number.isFinite(v6m)? v6m : null, j6m, u6m, Number.isFinite(v6m)? now : null,
      Number.isFinite(v1y)? v1y : null, j1y, u1y, Number.isFinite(v1y)? now : null,
      Number.isFinite(v3y)? v3y : null, j3y, u3y, Number.isFinite(v3y)? now : null
    ).run();
    updated++;
  }
  return { updated };
}
