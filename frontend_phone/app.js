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

    // Debug output removed for mobile view – elements not present

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
                // Re-render subtotal row after sorting
                const subtotal = computeGroupSubtotal(items);
                renderSubtotalRow(sectionId, subtotal);
                // Recalculate total for all items
                renderTotal(merged);
        });
    });
}

    // Initial sort and render per section
    // Compute domestic/us splits once
    const domesticItems = merged.filter(s => isDomestic(s.symbol));
    const usItems = merged.filter(s => !isDomestic(s.symbol));

    sortData(domesticItems, sortStateDomestic);
    sortData(usItems, sortStateUs);
    renderTable('domestic-section', domesticItems);
    renderTable('us-section', usItems);
    // Render subtotals for each group before the overall total
    // Subtotals are not shown in mobile view; skip rendering
    renderTotal(merged);

    // Attach click handlers for sortable headers once tables are rendered
    // Use single portfolio section for both domestic and US items
    attachHeaderHandlers('domestic-section', domesticItems, { colIndex: 0, asc: true });
    attachHeaderHandlers('us-section', usItems, { colIndex: 0, asc: true });

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
        // First row for ticker and shares etc.
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

        // Truncate company name to first 8 characters and place on new line in same cell
        const companyNameCell = item.company_name
            ? ` <br><span class="company-name">${item.company_name.slice(0, 8)}</span>`
            : '';
        const pct1d = item.pct_1d != null ? Number(item.pct_1d) : null;
        const pct1m = item.pct_1m != null ? Number(item.pct_1m) : null;
        const pct1y = item.pct_1y != null ? Number(item.pct_1y) : null;

        // Render only baseline values (no percent columns)
        // Helper to format percent change with color class
        const fmtPercent = (val) => {
            if (val == null) return '-';
            const pct = Number(val).toFixed(1);
            const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : '';
            return `<span class="${cls}">${pct}</span>`;
        };

        tr.innerHTML = `<td>${item.symbol}${companyNameCell}</td>` +
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
    // Use consistent formatting: two decimals for USD/JPY, none for JPY totals
    if (cur === 'JPY') {
        return Math.round(display).toLocaleString();
    }
    return display.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Helper to compute subtotal for a group of items
function computeGroupSubtotal(items) {
    let usdTotal = 0;
    let jpyTotal = 0;
    items.forEach(it => {
        if (!it.price || !it.shares) return;
        const isDomesticTicker = isDomestic(it.symbol);
        if (isDomesticTicker) {
            // Domestic prices stored in JPY
            jpyTotal += it.price * it.shares;
            usdTotal += (it.price / usdToJpyRate) * it.shares;
        } else {
            // Foreign prices stored in USD
            usdTotal += it.price * it.shares;
            jpyTotal += Math.round(it.price * usdToJpyRate * it.shares);
        }
    });
    return {usd: usdTotal, jpy: jpyTotal};
}

// Render a subtotal row at the end of a table section
function renderSubtotalRow(sectionId, subtotal) {
    const tbody = document.querySelector(`#${sectionId} tbody`);
    const tr = document.createElement('tr');
    tr.classList.add('subtotal-row');
    const isJPY = currencySelect.value === 'JPY';
    const val  = isJPY
        ? Math.round(subtotal.jpy).toLocaleString()
        : Number(subtotal.usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    tr.innerHTML = `<td colspan="6"><strong>Subtotal</strong></td><td>${val}</td>`;

    tbody.appendChild(tr);
}

// Render the overall total
function renderTotal(items) {
    const totalEl = document.getElementById('total-value');
    let totalInSelectedCurrency = 0;
    items.forEach(it => {
        if (!it.price || !it.shares) return;
        const isDomesticTicker = isDomestic(it.symbol);
        if (currencySelect.value === 'JPY') {
            const valJpy = isDomesticTicker
                ? it.price * it.shares
                : Math.round(it.price * usdToJpyRate * it.shares);
            totalInSelectedCurrency += valJpy;
        } else {
            const valUsd = isDomesticTicker
                ? (it.price / usdToJpyRate) * it.shares
                : it.price * it.shares;
            totalInSelectedCurrency += valUsd;
        }
    });
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
