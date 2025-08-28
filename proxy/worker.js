export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders() });
      }
      if (url.pathname === '/' || url.pathname === '/quote') {
        const symsParam = url.searchParams.get('symbols') || url.searchParams.get('s');
        if (!symsParam) return json({ error: 'missing symbols' }, 400);
        let symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);
        symbols = [...new Set(symbols.map(s => s.toUpperCase()))];

        const useFallback = url.searchParams.get('fallback') === 'stooq';
        const debug = url.searchParams.get('debug') === '1';

        // 1) Yahoo first
        let quotes = {};
        try {
          quotes = await fetchYahoo(symbols, debug);
        } catch (e) {
          // swallow; may fallback
        }

        // 2) Optional fallback: fill only missing from Stooq
        if (useFallback) {
          const missing = symbols.filter(s => !quotes[s]);
          if (missing.length) {
            try {
              const add = await fetchStooq(missing, debug);
              for (const s of missing) {
                if (add[s] && quotes[s] == null) quotes[s] = add[s];
              }
            } catch (e) {}
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

async function fetchYahoo(symbols, debug = false) {
  if (!symbols.length) return {};
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','));
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)' } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  const arr = (j && j.quoteResponse && j.quoteResponse.result) || [];
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
  return out;
}

function mapToStooqSymbols(symbols) {
  const map = {}; // stooqSym -> original
  for (const sym of symbols) {
    const s = String(sym).toUpperCase();
    if (s === 'USDJPY=X') { map['usdjpy'] = s; continue; }
    if (/\.T$/.test(s)) { map[s.replace(/\.T$/, '').toLowerCase() + '.jp'] = s; continue; }
    map[s.toLowerCase() + '.us'] = s; // default to US
  }
  return map;
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

async function fetchStooq(symbols, debug = false) {
  if (!symbols.length) return {};
  const m = mapToStooqSymbols(symbols);
  const stooqSyms = Object.keys(m);
  const url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(stooqSyms.join(',')) + '&f=sd2t2ohlcv&h&e=csv';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pf-worker/1.0)' } });
  if (!res.ok) throw new Error('Stooq HTTP ' + res.status);
  const txt = await res.text();
  const parsed = parseStooqCSV(txt);
  const out = {};
  for (const stooqSym of Object.keys(parsed)) {
    const orig = m[stooqSym];
    if (orig) {
      out[orig] = { ...parsed[stooqSym], source: 'stooq' };
    }
  }
  return out;
}
