export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders() });
      }
      if (url.pathname === '/api/portfolio') {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT symbol, shares, currency FROM holdings ORDER BY symbol'
          ).all();
          return json(results);
        } else if (request.method === 'POST') {
          const body = await request.json();
          const sym = String(body.symbol || '').trim();
          const shares = Number(body.shares);
          const cur = body.currency ? String(body.currency).trim() : null;
          if (!sym) return json({ error: 'symbol required' }, 400);
          await env.DB.prepare(
            'INSERT OR REPLACE INTO holdings(symbol, shares, currency) VALUES(?,?,?)'
          ).bind(sym, shares, cur).run();
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

async function fetchYahooChart(sym, range = '2y') {
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
          const b365 = pickBaselineAt(resp, 365);
          if (!out[sym]) out[sym] = {};
          if (Number.isFinite(prev1d) && out[sym].prevClose == null) out[sym].prevClose = prev1d;
          if (Number.isFinite(b30) && out[sym].prevClose30d == null) out[sym].prevClose30d = b30;
          if (Number.isFinite(b365) && out[sym].prevClose365d == null) out[sym].prevClose365d = b365;
        }catch(_){ }
      }
    }catch(_){ }
  }
  for (const ch of chunks) {
    const sy = encodeURIComponent(ch.join(','));
    const urls = [
      `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${sy}&range=2y&interval=1d`,
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${sy}&range=2y&interval=1d`,
      `https://query2.finance.yahoo.com/v7/finance/spark?symbols=${sy}&range=2y&interval=1d`,
      `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${sy}&range=2y&interval=1d`
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
          const b365 = pickBaselineAt(r, 365);
          if (Number.isFinite(b30)) out[sym].prevClose30d = b30;
          if (Number.isFinite(b365)) out[sym].prevClose365d = b365;
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
    return !(Number.isFinite(v.prevClose) && (Number.isFinite(v.prevClose30d) || Number.isFinite(v.prevClose365d)));
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
      const b365 = pickBaselineAt(r, 365);
      if (Number.isFinite(prev1d)) out[sym].prevClose = prev1d;
      if (Number.isFinite(b30)) out[sym].prevClose30d = b30;
      if (Number.isFinite(b365)) out[sym].prevClose365d = b365;
    }catch(_){ }
  }
  return out;
}
