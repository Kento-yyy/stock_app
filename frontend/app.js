// Fetch portfolio and quote data, then render tables and total.

// Use the public Workers endpoint directly – no local worker needed.
const apiBase = "https://tight-truth-243e.kento0614nintendo.workers.dev";
const currencySelect = document.getElementById('currency-select');
let usdToJpyRate = 1;

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed ${url}`);
    return res.json();
}

function isDomestic(symbol) {
    if (typeof symbol !== 'string') return false;
    // Japanese tickers often end with .T
    return symbol.endsWith('.T');
}

async function loadData() {
    // Use apiBase for all API requests so the frontend can target a remote
    // worker by adding ?api=<url> query param.  If no param is provided,
    // location.origin (the same origin) will be used.
    let holdings, quotes, usdjpy;
    try {
        [holdings, quotes, usdjpy] = await Promise.all([
            fetchJson(`${apiBase}/api/portfolio`),
            fetchJson(`${apiBase}/api/quotes_new`),
            fetchJson(`${apiBase}/api/usdjpy`)
        ]);
    } catch (e) {
        console.error('API fetch error:', e);
        document.getElementById('total-value').textContent = 'Error loading data';
        return;
    }

    // Debug: log raw responses to console
    console.log('Portfolio response:', holdings);
    console.log('Quotes response:', quotes);
    console.log('USD‑JPY response:', usdjpy);
    // The USJPY endpoint returns an object with a `price` field
    usdToJpyRate = usdjpy.price || 1;

    // Render raw API responses for debugging
    document.getElementById('portfolio-json').textContent = JSON.stringify(holdings, null, 2);
    document.getElementById('quotes-json').textContent = JSON.stringify(quotes, null, 2);
    document.getElementById('usdjpy-json').textContent = JSON.stringify(usdjpy, null, 2);

    // Render simple quotes_new table
    // renderQuotesTable(quotes);  // removed table from UI

    const merged = holdings.map(h => {
        const q = quotes.find(q => q.symbol === h.symbol) || {};
        // Compute percent changes from previous prices
        const pct = (raw) => {
            if (!raw || !q.price) return null;
            // Avoid division by zero
            if (Number(raw) === 0) return null;
            return ((q.price / raw - 1) * 100);
        };
        return {
            ...h,
            price: q.price,
            currency: q.currency,
            price_1d: q.price_1d,
            price_1m: q.price_1m,
            price_1y: q.price_1y,
            pct_1d: pct(q.price_1d),
            pct_1m: pct(q.price_1m),
            pct_1y: pct(q.price_1y),
        };
    });
    // Initial data arrays for sorting later
    // Removed duplicate declaration; use domesticItems defined below.
    // usItems declared later; remove this duplicate.

    // Sorting state per table
    let sortStateDomestic = { colIndex: 0, asc: true };
    let sortStateUs = { colIndex: 0, asc: true };

    function getSortKey(item, state) {
        const isDomesticTicker = isDomestic(item.symbol);
        let valueInSel;
        if (currencySelect.value === 'JPY') {
            valueInSel = isDomesticTicker
                ? item.price * item.shares
                : Math.round(item.price * usdToJpyRate * item.shares);
        } else {
            valueInSel = isDomesticTicker
                ? (item.price / usdToJpyRate) * item.shares
                : item.price * item.shares;
        }

        // The header order: Ticker, Shares, Price, 1D, 1M, 1Y, Value
        const keys = [
            item.symbol,
            item.shares,
            item.price,
            // Percent change columns (computed)
            item.pct_1d != null ? Number(item.pct_1d) : -Infinity,
            item.pct_1m != null ? Number(item.pct_1m) : -Infinity,
            item.pct_1y != null ? Number(item.pct_1y) : -Infinity,
            valueInSel, // total value column
        ];
        return keys[state.colIndex];
    }
    function sortData(items, state) {
        items.sort((a, b) => {
            const ka = getSortKey(a, state);
            const kb = getSortKey(b, state);
            if (ka < kb) return state.asc ? -1 : 1;
            if (ka > kb) return state.asc ? 1 : -1;
            return 0;
        });
    }

    // Attach header click listeners after tables are rendered
    function attachHeaderHandlers(sectionId, items, state) {
        const headers = document.querySelectorAll(`#${sectionId} th`);
        headers.forEach((th, idx) => {
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => {
                if (state.colIndex === idx) state.asc = !state.asc;
                else { state.colIndex = idx; state.asc = true; }
                sortData(items, state);
                renderTable(sectionId, items);
                // Recalculate total for all items
                renderTotal(merged);
            });
        });
    }

    // Initial sort and render per section
    const domesticItems = merged.filter(s => isDomestic(s.symbol));
    const usItems = merged.filter(s => !isDomestic(s.symbol));

    sortData(domesticItems, sortStateDomestic);
    sortData(usItems, sortStateUs);

    renderTable('domestic-section', domesticItems);
    renderTable('us-section', usItems);
    renderTotal(merged);

    // Attach click handlers for sortable headers once tables are rendered
    attachHeaderHandlers('domestic-section', domesticItems, sortStateDomestic);
    attachHeaderHandlers('us-section', usItems, sortStateUs);

    console.log("=== merged holdings ===");
    console.table(merged);
    const domestic = merged.filter(x => isDomestic(x.symbol));
    console.log("Domestic symbols:", domestic.map(x => x.symbol));
    const us = merged.filter(x => !isDomestic(x.symbol));
    console.log("US symbols:", us.map(x => x.symbol));

}

function renderTable(sectionId, items) {
    const tbody = document.querySelector(`#${sectionId} tbody`);
    tbody.innerHTML = '';
    console.log("items:", items)
    for (const item of items) {
        const tr = document.createElement('tr');

        // Compute value in selected currency
        // Calculate the value in the selected currency.
        const isDomesticTicker = isDomestic(item.symbol);
        let displayValue;
        if (currencySelect.value === 'JPY') {
            // JPY selected – domestic already in JPY, foreign convert
            displayValue = isDomesticTicker
                ? item.price * item.shares
                : Math.round(item.price * usdToJpyRate * item.shares);
        } else {
            // USD selected – domestic need to be converted from JPY
            displayValue = isDomesticTicker
                ? (item.price / usdToJpyRate) * item.shares 
                : item.price * item.shares;
        }

        // Company name displayed in gray, smaller font next to ticker
        const companyName = item.company_name ? ` ${item.company_name}` : '';
        // Left align company name next to ticker (default)
        // Raw baseline values
        const pct1d = item.pct_1d != null ? Number(item.pct_1d) : null;
        const pct1m = item.pct_1m != null ? Number(item.pct_1m) : null;
        const pct1y = item.pct_1y != null ? Number(item.pct_1y) : null;

        // Render only baseline values (no percent columns)
        // Helper to format percent change with color class
        const fmtPercent = (val) => {
            if (val == null) return '-';
            const pct = Number(val).toFixed(1);
            const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : '';
            return `<span class="${cls}">${pct}%</span>`;
        };

        tr.innerHTML = `<td>${item.symbol}<span style="font-size:0.8em;color:#888;">${companyName}</span></td>` +
            `<td>${item.shares}</td>` +
            `<td>${
            item.currency === 'JPY'
                ? Math.round(item.price).toLocaleString()
                : Number(item.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            }</td>` +
            `<td>${fmtPercent(pct1d)}</td>` +
            `<td>${fmtPercent(pct1m)}</td>` +
            `<td>${fmtPercent(pct1y)}</td>` +
            `<td>${
                currencySelect.value === 'JPY'
                    ? Number(displayValue.toFixed(0)).toLocaleString(undefined, { minimumFractionDigits: 0 })
                    : Number(displayValue.toFixed(2)).toLocaleString(undefined, { minimumFractionDigits: 2 })
            }</td>`;
        tbody.appendChild(tr);
    }
    console.log(`Rendered ${items.length} rows in ${sectionId}`);
}

// Return formatted price as a number string without currency symbol.
// Return formatted price as a number string without currency symbol.
// Prices are displayed in their native currency; conversion is only used for totals.
function formatPrice(val, cur) {
    if (val == null) return '-';
    const display = Number(val);
    return display.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTotal(items) {
    const totalEl = document.getElementById('total-value');
    let totalInSelectedCurrency = 0;
    for (const it of items) {
        if (!it.price || !it.shares) continue;
        const isDomesticTicker = isDomestic(it.symbol);
        // Calculate value in selected currency
        if (currencySelect.value === 'JPY') {
            const valJpy = isDomesticTicker
                ? it.price * it.shares
                : Math.round(it.price * usdToJpyRate * it.shares);
            totalInSelectedCurrency += valJpy;
        } else {
            // USD selected
            const valUsd = isDomesticTicker
                ? it.price / usdToJpyRate * it.shares
                : it.price * it.shares;
            totalInSelectedCurrency += valUsd;
        }
    }
    let display;
    if (currencySelect.value === 'JPY') {
        display = Math.round(totalInSelectedCurrency).toLocaleString();
    } else {
        display = totalInSelectedCurrency.toFixed(2);
    }
    totalEl.textContent = `${display} ${currencySelect.value}`;
}

currencySelect.addEventListener('change', () => {
    loadData();
});

loadData();
