export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders() });
      }
      if (url.pathname === '/' || url.pathname.startsWith('/quote')) {
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
        }

        return json({ quotes }, 200, { 'Cache-Control': 'public, s-maxage=60, max-age=30' });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error', detail: String(e) }, 500);
    }
  }
};

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
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
      obj.source = 'yahoo';
      out[sym] = obj;
    }
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
