#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
ポートフォリオの評価額を計算し、標準出力とHTMLに出力します。

構成:
 - ポートフォリオは Cloudflare D1 データベースに格納し、API 経由で取得します。
 - 設定JSON: 価格取得の設定（デフォルトは yfinance）

使用例:
  python3 portfolio_notify.py --config config.json --portfolio-url https://example.workers.dev/api/portfolio --save-html report.html

備考:
 - 価格取得は yfinance（APIキー不要）または Alpha Vantage（APIキー必要）を選択可能。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

try:
    import requests  # type: ignore
except Exception:
    requests = None  # lazy check later to allow help/usage without requests

try:
    import yfinance as yf  # type: ignore
except Exception:
    yf = None  # optional when using yfinance


# ---------------------------- Data Models -----------------------------

@dataclass
class Holding:
    symbol: str
    shares: float
    currency: Optional[str] = None  # "USD" or "JPY" 推奨


@dataclass
class Row:
    symbol: str
    shares: float
    currency: str
    usd_price: float
    usd_value: float
    jpy_price: float
    jpy_value: float
    # 以下はオプション（デフォルト値あり）
    per: float = float("nan")
    usd_mom: float = float("nan")  # 前月比(USD価格ベース)
    usd_dod: float = float("nan")  # 前日比(USD価格ベース)
    jpy_mom: float = float("nan")  # 前月比(JPY価格ベース)
    jpy_dod: float = float("nan")  # 前日比(JPY価格ベース)
    usd_yoy: float = float("nan")  # 前年比(USD価格ベース)
    jpy_yoy: float = float("nan")  # 前年比(JPY価格ベース)
    company_name: Optional[str] = None


@dataclass
class AlphaVantageConfig:
    api_key: str


@dataclass
class AppConfig:
    price_provider: AlphaVantageConfig
    price_provider_type: str = "yfinance"  # "yfinance" or "alpha_vantage"
    currency: Optional[str] = "JPY"  # 目的通貨 (例: "JPY"). 指定時は換算
    quote_currency: str = "USD"     # 株価のクォート通貨（既定: USD）


# ---------------------------- Utilities ------------------------------

class RateLimiter:
    """Allow up to `limit` events per `per_seconds` sliding window.

    Alpha Vantage free tier: 5 req / 60s. Default: limit=5, per_seconds=60.
    """

    def __init__(self, limit: int = 5, per_seconds: int = 60) -> None:
        self.limit = limit
        self.per_seconds = per_seconds
        self._times: List[float] = []

    def acquire(self) -> None:
        now = time.time()
        # drop timestamps older than window
        self._times = [t for t in self._times if now - t < self.per_seconds]
        if len(self._times) >= self.limit:
            sleep_for = self.per_seconds - (now - self._times[0]) + 0.05
            if sleep_for > 0:
                time.sleep(sleep_for)
            # after sleeping, clean again
            now = time.time()
            self._times = [t for t in self._times if now - t < self.per_seconds]
        self._times.append(time.time())


def _load_dotenv(path: str = ".env") -> None:
    """Lightweight .env loader without external deps.

    - Parses KEY=VALUE lines, ignoring blanks/comments.
    - Respects existing os.environ (does not overwrite).
    - Supports simple single or double quotes around VALUE.
    """
    try:
        if not os.path.exists(path):
            return
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                if "=" not in s:
                    continue
                key, val = s.split("=", 1)
                key = key.strip()
                val = val.strip()
                if (val.startswith("\"") and val.endswith("\"")) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception:
        # .env 読み込み失敗は致命ではないので無視
        pass


def load_portfolio_api(url: str, default_currency: str = "USD") -> List[Holding]:
    if requests is None:
        raise RuntimeError("'requests' パッケージが必要です。pip install requests で導入してください。")
    res = requests.get(url, timeout=30)
    res.raise_for_status()
    data = res.json() if res.content else []
    holdings: List[Holding] = []
    for row in data:
        symbol = str(row.get("symbol") or "").strip()
        if not symbol:
            continue
        try:
            shares = float(row.get("shares") or 0)
        except Exception:
            shares = 0.0
        currency = (row.get("currency") or default_currency).strip().upper()
        holdings.append(Holding(symbol=symbol, shares=shares, currency=currency))
    return holdings


def load_config(path: str) -> AppConfig:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)

    provider_raw = raw.get("price_provider") or {}

    # 環境変数で上書きできるようにする（秘密情報向け）
    api_key = os.getenv("PN_ALPHA_VANTAGE_KEY", provider_raw.get("api_key"))
    provider_type = (provider_raw.get("type") or "yfinance").lower()
    if provider_type == "alpha_vantage":
        if not api_key:
            raise ValueError("Alpha Vantage の APIキーが設定されていません (price_provider.api_key または 環境変数 PN_ALPHA_VANTAGE_KEY)")
        if isinstance(api_key, str) and api_key.strip().upper().startswith("YOUR_"):
            raise ValueError("Alpha Vantage の APIキーがプレースホルダーです。実際のキーを設定してください。環境変数 PN_ALPHA_VANTAGE_KEY でも上書き可能です。")

    provider_cfg = AlphaVantageConfig(api_key=api_key or "")
    return AppConfig(
        price_provider=provider_cfg,
        price_provider_type=provider_type,
        currency=raw.get("currency"),
        quote_currency=(raw.get("quote_currency") or "USD").upper(),
    )


# ------------------------- Price Providers ---------------------------

class PriceProvider:
    def get_price(self, symbol: str) -> float:
        raise NotImplementedError


class AlphaVantageProvider(PriceProvider):
    def __init__(self, api_key: str, rate_limiter: Optional[RateLimiter] = None) -> None:
        if requests is None:
            raise RuntimeError("'requests' パッケージが必要です。pip install requests で導入してください。")
        self.api_key = api_key
        self.session = requests.Session()
        self.rate_limiter = rate_limiter or RateLimiter(limit=5, per_seconds=60)

    def get_price(self, symbol: str) -> float:
        # Try GLOBAL_QUOTE first
        self.rate_limiter.acquire()
        url = "https://www.alphavantage.co/query"
        params = {
            "function": "GLOBAL_QUOTE",
            "symbol": symbol,
            "apikey": self.api_key,
        }
        r = self.session.get(url, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        # Common Alpha Vantage error indicators
        if isinstance(data, dict):
            if data.get("Note"):
                raise RuntimeError(f"Alpha Vantage レート制限/待機が必要: {data.get('Note')}")
            if data.get("Error Message"):
                raise RuntimeError(f"Alpha Vantage エラー: {data.get('Error Message')}")
            if data.get("Information"):
                raise RuntimeError(f"Alpha Vantage 情報: {data.get('Information')}")
        quote = data.get("Global Quote") or {}
        price_str = quote.get("05. price") or quote.get("05. Price")
        if price_str:
            try:
                return float(price_str)
            except ValueError:
                pass  # fallback below

        # Fallback: use latest DAILY close
        price = self._get_latest_daily_close(symbol)
        if price is None:
            raise RuntimeError(f"価格フィールドが見つかりません: {symbol} -> {quote}")
        return price

    def _get_latest_daily_close(self, symbol: str) -> Optional[float]:
        self.rate_limiter.acquire()
        url = "https://www.alphavantage.co/query"
        params = {
            "function": "TIME_SERIES_DAILY",
            "symbol": symbol,
            "apikey": self.api_key,
            # compact/full は不要（最新日だけ見ればよい）
        }
        r = self.session.get(url, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict):
            if data.get("Note"):
                raise RuntimeError(f"Alpha Vantage レート制限/待機が必要: {data.get('Note')}")
            if data.get("Error Message"):
                raise RuntimeError(f"Alpha Vantage エラー: {data.get('Error Message')}")
            if data.get("Information"):
                raise RuntimeError(f"Alpha Vantage 情報: {data.get('Information')}")
        key = "Time Series (Daily)"
        ts = data.get(key)
        if not isinstance(ts, dict) or not ts:
            return None
        # 最新日付を取得
        try:
            latest_date = max(ts.keys())
        except Exception:
            return None
        bar = ts.get(latest_date) or {}
        close_str = bar.get("4. close") or bar.get("4. Close")
        if not close_str:
            return None
        try:
            return float(close_str)
        except ValueError:
            return None

    def get_fx_rate(self, from_currency: str, to_currency: str) -> float:
        """Get realtime FX rate via Alpha Vantage CURRENCY_EXCHANGE_RATE."""
        self.rate_limiter.acquire()
        url = "https://www.alphavantage.co/query"
        params = {
            "function": "CURRENCY_EXCHANGE_RATE",
            "from_currency": from_currency.upper(),
            "to_currency": to_currency.upper(),
            "apikey": self.api_key,
        }
        r = self.session.get(url, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict):
            if data.get("Note"):
                raise RuntimeError(f"Alpha Vantage レート制限/待機が必要: {data.get('Note')}")
            if data.get("Error Message"):
                raise RuntimeError(f"Alpha Vantage エラー: {data.get('Error Message')}")
            if data.get("Information"):
                raise RuntimeError(f"Alpha Vantage 情報: {data.get('Information')}")
        key = "Realtime Currency Exchange Rate"
        if key not in data:
            raise RuntimeError(f"為替レート取得に失敗: {from_currency}->{to_currency} -> {data}")
        fx = data[key]
        rate_str = fx.get("5. Exchange Rate") or fx.get("Exchange Rate")
        if not rate_str:
            raise RuntimeError(f"為替レートのフィールドが見つかりません: {fx}")
        try:
            return float(rate_str)
        except ValueError as e:
            raise RuntimeError(f"為替レートの数値変換に失敗: {rate_str}") from e


class YFinanceProvider(PriceProvider):
    def __init__(self) -> None:
        if yf is None:
            raise RuntimeError("'yfinance' パッケージが必要です。pip install yfinance で導入してください。")

    def _last_price(self, ticker: str) -> Optional[float]:
        t = yf.Ticker(ticker)
        # fast_info first
        try:
            fi = t.fast_info
            if fi:
                # fi may be Mapping-like
                try:
                    p = fi.get("last_price") or fi.get("lastPrice") or fi.get("last") or fi.get("regular_market_price")
                except AttributeError:
                    p = (
                        getattr(fi, "last_price", None)
                        or getattr(fi, "lastPrice", None)
                        or getattr(fi, "last", None)
                        or getattr(fi, "regular_market_price", None)
                    )
                if p is not None:
                    return float(p)
        except Exception:
            pass
        # history fallback
        try:
            hist = t.history(period="1d")
            if hist is not None and len(hist) > 0:
                close = hist["Close"].dropna()
                if len(close) > 0:
                    return float(close.iloc[-1])
        except Exception:
            pass
        # info fallback
        try:
            info = t.info or {}
            p = info.get("currentPrice") or info.get("regularMarketPrice")
            if p is not None:
                return float(p)
        except Exception:
            pass
        return None

    def get_price(self, symbol: str) -> float:
        p = self._last_price(symbol)
        if p is None:
            raise RuntimeError(f"yfinanceで価格を取得できません: {symbol}")
        return p

    def get_fx_rate(self, from_currency: str, to_currency: str) -> float:
        pair = f"{from_currency.upper()}{to_currency.upper()}=X"
        p = self._last_price(pair)
        if p is None:
            raise RuntimeError(f"yfinanceで為替レートを取得できません: {pair}")
        return p

    def previous_day_close(self, ticker: str) -> Optional[float]:
        t = yf.Ticker(ticker)
        # Try fast_info
        try:
            fi = t.fast_info
            if fi:
                try:
                    p = fi.get("previous_close") or fi.get("previousClose")
                except AttributeError:
                    p = getattr(fi, "previous_close", None) or getattr(fi, "previousClose", None)
                if p is not None:
                    return float(p)
        except Exception:
            pass
        # Fallback to history
        try:
            hist = t.history(period="5d")
            if hist is not None and len(hist) >= 2:
                close = hist["Close"].dropna()
                if len(close) >= 2:
                    return float(close.iloc[-2])
        except Exception:
            pass
        return None

    def previous_month_close(self, ticker: str) -> Optional[float]:
        try:
            ser = self.get_monthly_series(ticker, months=2)
            if len(ser) >= 2:
                return float(ser[-2][1])
        except Exception:
            pass
        return None

    def previous_year_close(self, ticker: str) -> Optional[float]:
        try:
            ser = self.get_monthly_series(ticker, months=13)
            if len(ser) >= 13:
                return float(ser[-13][1])
        except Exception:
            pass
        return None

    def get_name(self, ticker: str) -> Optional[str]:
        try:
            t = yf.Ticker(ticker)
            # Try fast_info first
            name = None
            try:
                fi = t.fast_info
                if fi:
                    try:
                        name = fi.get("shortName") or fi.get("longName")
                    except AttributeError:
                        name = getattr(fi, "shortName", None) or getattr(fi, "longName", None)
            except Exception:
                name = None
            if not name:
                info = None
                try:
                    info = t.info or {}
                except Exception:
                    info = {}
                name = (info.get("shortName") or info.get("longName") or info.get("name") or None)
            if name:
                return str(name)
        except Exception:
            return None
        return None

    def get_per(self, ticker: str) -> Optional[float]:
        t = yf.Ticker(ticker)
        # Try fast_info trailing PE
        try:
            fi = t.fast_info
            if fi:
                try:
                    v = fi.get("trailing_pe") or fi.get("trailingPE")
                except AttributeError:
                    v = getattr(fi, "trailing_pe", None) or getattr(fi, "trailingPE", None)
                if v is not None:
                    return float(v)
        except Exception:
            pass
        # Fallback to info
        try:
            info = t.info or {}
            v = info.get("trailingPE") or info.get("forwardPE")
            if v is not None:
                return float(v)
        except Exception:
            pass
        return None

    def get_monthly_series(self, symbol: str, months: int = 12) -> List[Tuple[str, float]]:
        t = yf.Ticker(symbol)
        # 月数に応じて十分な期間を取得（YoY計算などで13ヶ月以上必要な場合に対応）
        def _period_for(m: int) -> str:
            if m <= 12:
                return "1y"
            if m <= 24:
                return "2y"
            if m <= 60:
                return "5y"
            if m <= 120:
                return "10y"
            return "max"
        period = _period_for(max(12, months))
        hist = t.history(period=period, interval="1mo")
        result: List[Tuple[str, float]] = []
        try:
            if hist is not None and len(hist) > 0:
                close = hist["Close"].dropna()
                for idx, val in close.items():
                    try:
                        # idx is pandas Timestamp
                        label = idx.strftime("%Y-%m")
                    except Exception:
                        label = str(idx)
                    try:
                        result.append((label, float(val)))
                    except Exception:
                        continue
        except Exception:
            pass
        # Keep only last `months` items（必要数だけに丸める）
        if months and len(result) > months:
            result = result[-months:]
        return result


def fetch_prices(provider: PriceProvider, holdings: Iterable[Holding]) -> Dict[str, float]:
    prices: Dict[str, float] = {}
    for h in holdings:
        if h.symbol in prices:
            continue
        prices[h.symbol] = provider.get_price(h.symbol)
    return prices


# ---------------------------- Reporting ------------------------------

def format_report(
    rows: List[Row],
    usd_jpy: Optional[float],
) -> Tuple[str, Tuple[float, float]]:
    lines: List[str] = []
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    header = f"ポートフォリオ評価額 ({now})  (USD/JPY 表示)"
    lines.append(header)
    lines.append("")
    total_usd = 0.0
    total_jpy = 0.0
    # Markdown table header
    lines.append("| SYMBOL | SHARES | USD_PRICE | USD_VALUE | JPY_PRICE | JPY_VALUE |")
    lines.append("|:------ | -----:| ---------:| ---------:| ---------:| ---------:|")

    for r in rows:
        usd_value = r.usd_value
        jpy_value = r.jpy_value
        total_usd += usd_value
        total_jpy += jpy_value
        # formatting
        shares_disp = f"{int(round(r.shares)):,}"
        usd_price_disp = "" if r.usd_price != r.usd_price else f"{r.usd_price:,.2f}"
        usd_value_disp = "" if r.usd_value != r.usd_value else f"{r.usd_value:,.2f}"
        jpy_price_disp = "" if r.jpy_price != r.jpy_price else f"{r.jpy_price:,.0f}"
        jpy_value_disp = "" if r.jpy_value != r.jpy_value else f"{r.jpy_value:,.0f}"
        lines.append(
            f"| {r.symbol} | {shares_disp} | {usd_price_disp} | {usd_value_disp} | {jpy_price_disp} | {jpy_value_disp} |"
        )

    # Totals row and FX info
    lines.append(
        f"| TOTAL |  |  | {total_usd:,.2f} |  | {total_jpy:,.0f} |"
    )
    if usd_jpy is not None:
        lines.append("")
        lines.append(f"為替: USD→JPY = {usd_jpy:,.4f}")
    return "\n".join(lines), (total_usd, total_jpy)


def format_report_html(
    rows: List[Row],
    usd_jpy: Optional[float],
    monthly_dataset: Optional[Dict] = None,
    monthly_csv_text: Optional[str] = None,
) -> str:
    # 初期為替レート（直近値）を設定
    last_fx = usd_jpy
    if monthly_dataset and isinstance(monthly_dataset, dict):
        try:
            fx_list = monthly_dataset.get("fx") or []
            if fx_list:
                last_fx = fx_list[-1]
        except Exception:
            pass
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    title = f"ポートフォリオ評価額 ({now})  (USD/JPY 表示)"
    # Inline CSS for compatibility
    styles = """
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif; }
      table { border-collapse: collapse; width: 100%; max-width: 100%; table-layout: fixed; }
      th, td { border: 1px solid #ddd; padding: 8px 10px; white-space: nowrap; }
      th { background: #f5f5f5; text-align: right; user-select: none; }
      th:first-child, td:first-child { text-align: left; }
      td { text-align: right; }
      tfoot td { font-weight: bold; background: #fafafa; }
      .muted { color: #666; font-size: 12px; }
      .sortable { cursor: pointer; }
      .sort-indicator { margin-left: 6px; color: #888; font-size: 11px; }
      .toolbar { display:flex; align-items:center; flex-wrap: wrap; gap:10px; margin: 8px 0 14px; }
      .toolbar input[type=range]{ width: 280px; }
      .toolbar select { padding: 4px 6px; }
      .toolbar .label { font-weight: 600; }
      .chg { color:#666; font-size:12px; margin-left:4px; white-space:nowrap; }
      .chg .up { color:#0a0; }
      .chg .down { color:#c00; }
      .up { color:#0a0; }
      .down { color:#c00; }
      .table-wrap { overflow-x: auto; }
      .co { color:#444; font-size:12px; margin-left:6px; }
    </style>
    """
    # 共通列幅（SYMBOL, SHARES, PER, USD_PRICE, USD_YoY, USD_MoM, USD_DoD, USD_VALUE, JPY_PRICE, JPY_YoY, JPY_MoM, JPY_DoD, JPY_VALUE）
    col_widths = [22, 6, 6, 8, 5, 5, 5, 10, 8, 5, 5, 5, 10]
    colgroup_html = "<colgroup>" + "".join([f"<col style='width:{w}%'/>" for w in col_widths]) + "</colgroup>"

    script = """
    <script>
    (function(){
      function fmtUSD(n){ return (isNaN(n) ? '' : n.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2})); }
      function fmtJPY(n){ return (isNaN(n) ? '' : Math.round(n).toLocaleString()); }
      function getCellValue(cell, type){
        var dv = cell.getAttribute('data-value');
        if (type === 'num'){
          var v = (dv !== null ? dv : (cell.textContent || '').replace(/,/g,''));
          var n = parseFloat(v);
          return isNaN(n) ? NaN : n;
        } else {
          return (dv !== null ? dv : (cell.textContent || '')).trim().toUpperCase();
        }
      }
      function sortTableEl(table, colIndex, asc){
        if(!table) return;
        var tbody = table.tBodies[0];
        if(!tbody) return;
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
        if(!rows.length) return;
        var ths = table.tHead && table.tHead.rows.length ? table.tHead.rows[0].cells : null;
        var type = (ths && ths[colIndex] && ths[colIndex].getAttribute('data-sort')) || (colIndex === 0 ? 'str' : 'num');
        rows.sort(function(a,b){
          var av = getCellValue(a.cells[colIndex], type);
          var bv = getCellValue(b.cells[colIndex], type);
          if (type === 'num'){
            var aNaN = !(isFinite(av));
            var bNaN = !(isFinite(bv));
            if (aNaN && bNaN) return 0;
            if (aNaN) return 1; // NaN to bottom
            if (bNaN) return -1;
            return asc ? (av - bv) : (bv - av);
          } else {
            return asc ? (String(av).localeCompare(String(bv))) : (String(bv).localeCompare(String(av)));
          }
        });
        rows.forEach(function(r){ tbody.appendChild(r); });
        // update indicators
        var ths2 = table.tHead.rows[0].cells;
        for (var i=0;i<ths2.length;i++){
          var span = ths2[i].querySelector('.sort-indicator');
          if(span) span.textContent = '';
          else { var sp = document.createElement('span'); sp.className = 'sort-indicator'; ths2[i].appendChild(sp); }
        }
        var active = ths2[colIndex].querySelector('.sort-indicator');
        if(active) active.textContent = asc ? '▲' : '▼';
      }
      function sortTable(tableId, colIndex, asc){
        var table = document.getElementById(tableId);
        if(!table) return;
        sortTableEl(table, colIndex, asc);
      }
      window.attachSortHandlers = function(){
        var tables = document.querySelectorAll('table.pf-table');
        if(!tables || !tables.length) return;
        tables.forEach(function(table){
          var thead = table.tHead;
          if (!thead || !thead.rows.length) return;
          var ths = thead.rows[0].cells;
          for (var i=0;i<ths.length;i++){
            var th = ths[i];
            th.classList.add('sortable');
            // 明示的に型を指定（0列目は文字列、それ以外は数値）
            th.setAttribute('data-sort', i === 0 ? 'str' : 'num');
          }
          thead.addEventListener('click', function(ev){
            var th = ev.target && ev.target.closest ? ev.target.closest('th') : null;
            if (!th || !thead.contains(th)) return;
            var idx = Array.prototype.indexOf.call(ths, th);
            if (idx == null || idx < 0) return;
            var asc = th.getAttribute('data-asc') !== 'true';
            Array.prototype.forEach.call(ths, function(h){ h.removeAttribute('data-asc'); var s=h.querySelector('.sort-indicator'); if(s) s.textContent=''; });
            th.setAttribute('data-asc', asc ? 'true' : 'false');
            sortTableEl(table, idx, asc);
          });
        });
      };
      function parseCSV(text){ return null; }
      function initMonthly(){}
      document.addEventListener('DOMContentLoaded', function(){
        if (window.attachSortHandlers) window.attachSortHandlers();
        // Initial sort: JPY_VALUE (col 5) descending for both tables when monthly view is not used
        try{
          var tables = document.querySelectorAll('table.pf-table');
          tables.forEach(function(t){
            var hasBody = t && t.tBodies && t.tBodies.length && t.tBodies[0] && t.tBodies[0].rows && t.tBodies[0].rows.length;
            if (hasBody && t.querySelectorAll('tbody.month-body').length === 0){
              // Clear existing indicators on initial, set desc on JPY_VALUE
              var ths = t.tHead && t.tHead.rows.length ? t.tHead.rows[0].cells : null;
              if (ths && ths.length > 12){
                for (var i=0;i<ths.length;i++){ var s = ths[i].querySelector('.sort-indicator'); if(s) s.textContent=''; ths[i].removeAttribute('data-asc'); }
                ths[12].setAttribute('data-asc','false');
              }
              sortTableEl(t, 12, false); // JPY_VALUE desc with new indices (PER added)
            }
          });
        } catch(e){}
        initMonthly();
      });
    })();
    </script>
    """
    rows_html_jpy: List[str] = []
    rows_html_usd: List[str] = []
    month_bodies_html: List[str] = []
    total_usd_overall = 0.0
    total_jpy_overall = 0.0
    total_usd_jpy_tbl = 0.0
    total_jpy_jpy_tbl = 0.0
    total_usd_usd_tbl = 0.0
    total_jpy_usd_tbl = 0.0
    if monthly_dataset and isinstance(monthly_dataset, dict):
        months_labels = monthly_dataset.get("months", []) or []
        ds_rows = monthly_dataset.get("rows", []) or []
        for i, m in enumerate(months_labels):
            body_lines: List[str] = [f"<tbody class='month-body{' active' if i == len(months_labels)-1 else ''}' data-month='{m}'>"]
            m_usd = 0.0
            m_jpy = 0.0
            for r in ds_rows:
                symbol = r.get("symbol")
                shares = r.get("shares")
                try:
                    usd_price = r.get("usd_price", [])[i]
                    usd_value = r.get("usd_value", [])[i]
                    jpy_price = r.get("jpy_price", [])[i]
                    jpy_value = r.get("jpy_value", [])[i]
                except Exception:
                    usd_price = usd_value = jpy_price = jpy_value = float("nan")
                shares_disp = f"{int(round(shares)):,}" if shares is not None else ""
                up = float(usd_price) if usd_price is not None else float("nan")
                uv = float(usd_value) if usd_value is not None else float("nan")
                jp = float(jpy_price) if jpy_price is not None else float("nan")
                jv = float(jpy_value) if jpy_value is not None else float("nan")
                if uv == uv:
                    m_usd += uv
                if jv == jv:
                    m_jpy += jv
                body_lines.append(
                    f"<tr data-symbol='{symbol}'>"
                    f"<td style='text-align:left'>{symbol}</td>"
                    f"<td>{shares_disp}</td>"
                    f"<td data-value='{'' if up!=up else f'{up:.6f}'}'>{'' if up!=up else f'{up:,.2f}'}</td>"
                    f"<td data-value='{'' if uv!=uv else f'{uv:.6f}'}'>{'' if uv!=uv else f'{uv:,.2f}'}</td>"
                    f"<td data-value='{'' if jp!=jp else f'{jp:.6f}'}'>{'' if jp!=jp else f'{jp:,.0f}'}</td>"
                    f"<td data-value='{'' if jv!=jv else f'{jv:.6f}'}'>{'' if jv!=jv else f'{jv:,.0f}'}</td>"
                    f"</tr>"
                )
            body_lines.append("</tbody>")
            month_bodies_html.append("\n".join(body_lines))
            if i == len(months_labels)-1:
                total_usd = m_usd
                total_jpy = m_jpy
    else:
        for r in rows:
            total_usd_overall += r.usd_value
            total_jpy_overall += r.jpy_value
            shares_disp = f"{int(round(r.shares)):,}"
            per_disp = "" if (r.per != r.per) else f"{r.per:.1f}"
            def _fmt_pct(p: float) -> str:
                try:
                    if p != p:
                        return ""
                    sign = "+" if p > 0 else ("" if p == 0 else "-")
                    val = abs(p) * 100.0
                    return f"{sign}{val:.1f}%"
                except Exception:
                    return ""
            usd_price_disp = "" if r.usd_price != r.usd_price else f"{r.usd_price:,.2f}"
            usd_value_disp = "" if r.usd_value != r.usd_value else f"{r.usd_value:,.2f}"
            jpy_price_disp = "" if r.jpy_price != r.jpy_price else f"{r.jpy_price:,.0f}"
            jpy_value_disp = "" if r.jpy_value != r.jpy_value else f"{r.jpy_value:,.0f}"
            usd_yoy_s = _fmt_pct(r.usd_yoy)
            usd_mom_s = _fmt_pct(r.usd_mom)
            usd_dod_s = _fmt_pct(r.usd_dod)
            jpy_yoy_s = _fmt_pct(r.jpy_yoy)
            jpy_mom_s = _fmt_pct(r.jpy_mom)
            jpy_dod_s = _fmt_pct(r.jpy_dod)
            def _pct_td(label_val: str, numeric_val: float) -> str:
                if not label_val:
                    return "<td data-value=''></td>"
                cls = 'up' if numeric_val > 0 else ('down' if numeric_val < 0 else '')
                return f"<td data-value='{numeric_val:.6f}'><span class='chg'><span class='{cls}'>{label_val}</span></span></td>"
                name_html = '' if not r.company_name else f" <span class='co'>{r.company_name}</span>"
                row_html = (
                  f"<tr data-symbol='{r.symbol}'>"
                  f"<td style='text-align:left' data-value='{r.symbol}'>{r.symbol}{name_html}</td>"
                  f"<td data-value='{'' if r.shares!=r.shares else f'{float(r.shares):.6f}'}'>{shares_disp}</td>"
                  f"<td data-value='{'' if r.per!=r.per else f'{r.per:.6f}'}'>{per_disp}</td>"
                  f"<td data-value='{'' if r.usd_price!=r.usd_price else f'{r.usd_price:.6f}'}'>{usd_price_disp}</td>"
                  f"{_pct_td(usd_yoy_s, r.usd_yoy)}"
                f"{_pct_td(usd_mom_s, r.usd_mom)}"
                f"{_pct_td(usd_dod_s, r.usd_dod)}"
                f"<td data-value='{'' if r.usd_value!=r.usd_value else f'{r.usd_value:.6f}'}'>{usd_value_disp}</td>"
                f"<td data-value='{'' if r.jpy_price!=r.jpy_price else f'{r.jpy_price:.6f}'}'>{jpy_price_disp}</td>"
                f"{_pct_td(jpy_yoy_s, r.jpy_yoy)}"
                f"{_pct_td(jpy_mom_s, r.jpy_mom)}"
                f"{_pct_td(jpy_dod_s, r.jpy_dod)}"
                f"<td data-value='{'' if r.jpy_value!=r.jpy_value else f'{r.jpy_value:.6f}'}'>{jpy_value_disp}</td>"
                f"</tr>"
            )
            if (r.currency or '').upper() == 'JPY':
                rows_html_jpy.append(row_html)
                total_usd_jpy_tbl += r.usd_value
                total_jpy_jpy_tbl += r.jpy_value
            else:
                rows_html_usd.append(row_html)
                total_usd_usd_tbl += r.usd_value
                total_jpy_usd_tbl += r.jpy_value

    # Footer rows must have same number of columns as header (13). Put totals at USD_VALUE(7) and JPY_VALUE(12)
    def _footer_row(label: str, usd_total: float, jpy_total: float) -> str:
        tds = ["" for _ in range(13)]
        tds[0] = f"<td style='text-align:left'>{label}</td>"
        for i in range(1,13):
            tds[i] = "<td></td>"
        tds[7] = f"<td>{usd_total:,.2f}</td>"
        tds[12] = f"<td>{jpy_total:,.0f}</td>"
        return "<tr>" + "".join(tds) + "</tr>"
    total_row_jpy = _footer_row("TOTAL", total_usd_jpy_tbl, total_jpy_jpy_tbl)
    total_row_usd = _footer_row("TOTAL", total_usd_usd_tbl, total_jpy_usd_tbl)
    overall_total_row = _footer_row("OVERALL TOTAL", total_usd_overall, total_jpy_overall)
    fx_html = f"<p id='fx-rate' class='muted'>為替: USD→JPY = {last_fx:,.4f}</p>" if (last_fx is not None) else "<p id='fx-rate' class='muted'></p>"

    data_blocks: List[str] = []
    if monthly_dataset is not None:
        import html as _html
        import json as _json
        data_blocks.append(f"<script id='pf-data' type='application/json'>{_html.escape(_json.dumps(monthly_dataset))}</script>")
    if monthly_csv_text is not None:
        import html as _html
        data_blocks.append(f"<script id='pf-csv' type='text/plain'>{_html.escape(monthly_csv_text)}</script>")

    html = f"""
    <html>
      <head>
        <meta charset='utf-8' />
        {styles}
        {script}
      </head>
      <body>
        <h2>{title}</h2>
        {('''<div class="toolbar">
            <button id="prevBtn">◀</button>
            <button id="nextBtn">▶</button>
            <select id="monthSelect"></select>
            <span class="label">月: <span id="monthLabel">-</span></span>
          </div>''') if (monthly_dataset is not None or monthly_csv_text is not None) else ''}
        {''.join(data_blocks)}
        <h3>国内株</h3>
        <div class='table-wrap'>
        <table id='pf-table-jpy' class='pf-table'>
          {colgroup_html}
          <thead>
            <tr>
              <th style='text-align:left'>SYMBOL<span class='sort-indicator'></span></th>
              <th>SHARES<span class='sort-indicator'></span></th>
              <th>PER<span class='sort-indicator'></span></th>
              <th>USD_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>USD_VALUE<span class='sort-indicator'></span></th>
              <th>JPY_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>JPY_VALUE<span class='sort-indicator'></span></th>
            </tr>
          </thead>
          {(''.join(month_bodies_html)) if month_bodies_html else ('<tbody>' + ''.join(rows_html_jpy) + '</tbody>')}
          <tfoot>
            {total_row_jpy}
          </tfoot>
        </table>
        </div>
        <h3>米国株</h3>
        <div class='table-wrap'>
        <table id='pf-table-usd' class='pf-table'>
          {colgroup_html}
          <thead>
            <tr>
              <th style='text-align:left'>SYMBOL<span class='sort-indicator'></span></th>
              <th>SHARES<span class='sort-indicator'></span></th>
              <th>PER<span class='sort-indicator'></span></th>
              <th>USD_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>USD_VALUE<span class='sort-indicator'></span></th>
              <th>JPY_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>JPY_VALUE<span class='sort-indicator'></span></th>
            </tr>
          </thead>
          <tbody>
            {''.join(rows_html_usd)}
          </tbody>
          <tfoot>
            {total_row_usd}
          </tfoot>
        </table>
        </div>
        <h3>全体合計</h3>
        <div class='table-wrap'>
        <table id='pf-total' class='pf-table pf-total'>
          {colgroup_html}
          <thead>
            <tr>
              <th style='text-align:left'>TYPE<span class='sort-indicator'></span></th>
              <th>SHARES<span class='sort-indicator'></span></th>
              <th>PER<span class='sort-indicator'></span></th>
              <th>USD_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>USD_VALUE<span class='sort-indicator'></span></th>
              <th>JPY_PRICE<span class='sort-indicator'></span></th>
              <th>YoY<span class='sort-indicator'></span></th>
              <th>MoM<span class='sort-indicator'></span></th>
              <th>DoD<span class='sort-indicator'></span></th>
              <th>JPY_VALUE<span class='sort-indicator'></span></th>
            </tr>
          </thead>
          <tfoot>
            {overall_total_row}
          </tfoot>
        </table>
        </div>
        {fx_html}
      </body>
    </html>
    """
    return html


def build_rows(
    holdings: List[Holding], prices: Dict[str, float], usd_jpy: Optional[float], provider: Optional[PriceProvider] = None
) -> Tuple[List[Row], float, float]:
    rows: List[Row] = []
    total_usd = 0.0
    total_jpy = 0.0
    # For change calculations when using yfinance
    fx_prev_day: Optional[float] = None
    fx_prev_month: Optional[float] = None
    fx_prev_year: Optional[float] = None
    use_yf = isinstance(provider, YFinanceProvider)
    if use_yf:
        try:
            fx_prev_day = provider.previous_day_close("USDJPY=X")  # type: ignore[attr-defined]
        except Exception:
            fx_prev_day = None
        try:
            # last month's close
            fx_prev_month = provider.previous_month_close("USDJPY=X")  # type: ignore[attr-defined]
        except Exception:
            fx_prev_month = None
        try:
            fx_prev_year = provider.previous_year_close("USDJPY=X")  # type: ignore[attr-defined]
        except Exception:
            fx_prev_year = None

    def pct(cur: Optional[float], prev: Optional[float]) -> float:
        try:
            if cur is None or prev in (None, 0) or (isinstance(prev, float) and prev != prev) or (isinstance(cur, float) and cur != cur):
                return float("nan")
            return (float(cur) - float(prev)) / float(prev)
        except Exception:
            return float("nan")

    name_cache: Dict[str, Optional[str]] = {}
    for h in holdings:
        price = prices.get(h.symbol, float("nan"))
        ccy = (h.currency or "USD").upper()
        if ccy not in ("USD", "JPY"):
            raise ValueError(f"未対応の通貨です: {h.symbol} currency={ccy} (USD/JPYのみ対応)")
        if ccy == "USD":
            usd_price = price
            jpy_price = price * (usd_jpy or float("nan"))
        else:
            jpy_price = price
            usd_price = float("nan") if (usd_jpy is None or usd_jpy == 0) else price / usd_jpy
        usd_value = h.shares * usd_price
        jpy_value = h.shares * jpy_price

        usd_mom = usd_dod = jpy_mom = jpy_dod = float("nan")
        usd_yoy = jpy_yoy = float("nan")
        if use_yf:
            try:
                if ccy == "USD":
                    prev_d_usd = provider.previous_day_close(h.symbol)  # type: ignore[attr-defined]
                    prev_m_usd = provider.previous_month_close(h.symbol)  # type: ignore[attr-defined]
                    prev_y_usd = provider.previous_year_close(h.symbol)  # type: ignore[attr-defined]
                    prev_d_jpy = (None if (prev_d_usd is None or fx_prev_day in (None, 0)) else float(prev_d_usd) * float(fx_prev_day))
                    prev_m_jpy = (None if (prev_m_usd is None or fx_prev_month in (None, 0)) else float(prev_m_usd) * float(fx_prev_month))
                    prev_y_jpy = (None if (prev_y_usd is None or fx_prev_year in (None, 0)) else float(prev_y_usd) * float(fx_prev_year))
                else:  # JPY native
                    prev_d_jpy = provider.previous_day_close(h.symbol)  # type: ignore[attr-defined]
                    prev_m_jpy = provider.previous_month_close(h.symbol)  # type: ignore[attr-defined]
                    prev_y_jpy = provider.previous_year_close(h.symbol)  # type: ignore[attr-defined]
                    prev_d_usd = (None if (prev_d_jpy is None or fx_prev_day in (None, 0)) else float(prev_d_jpy) / float(fx_prev_day))
                    prev_m_usd = (None if (prev_m_jpy is None or fx_prev_month in (None, 0)) else float(prev_m_jpy) / float(fx_prev_month))
                    prev_y_usd = (None if (prev_y_jpy is None or fx_prev_year in (None, 0)) else float(prev_y_jpy) / float(fx_prev_year))
                usd_mom = pct(usd_price, prev_m_usd)
                usd_dod = pct(usd_price, prev_d_usd)
                jpy_mom = pct(jpy_price, prev_m_jpy)
                jpy_dod = pct(jpy_price, prev_d_jpy)
                usd_yoy = pct(usd_price, prev_y_usd)
                jpy_yoy = pct(jpy_price, prev_y_jpy)
            except Exception:
                pass
        comp_name: Optional[str] = None
        if use_yf:
            if h.symbol in name_cache:
                comp_name = name_cache[h.symbol]
            else:
                try:
                    comp_name = provider.get_name(h.symbol)  # type: ignore[attr-defined]
                except Exception:
                    comp_name = None
                name_cache[h.symbol] = comp_name
        total_usd += usd_value
        total_jpy += jpy_value
        # PER
        per_val = float("nan")
        if use_yf:
            try:
                pv = provider.get_per(h.symbol)  # type: ignore[attr-defined]
                if pv is not None:
                    per_val = float(pv)
            except Exception:
                pass

        rows.append(
            Row(
                symbol=h.symbol,
                shares=h.shares,
                currency=ccy,
                per=per_val,
                usd_price=usd_price,
                usd_value=usd_value,
                jpy_price=jpy_price,
                jpy_value=jpy_value,
                usd_mom=usd_mom,
                usd_dod=usd_dod,
                jpy_mom=jpy_mom,
                jpy_dod=jpy_dod,
                usd_yoy=usd_yoy,
                jpy_yoy=jpy_yoy,
                company_name=comp_name,
            )
        )
    return rows, total_usd, total_jpy


def build_monthly_dataset(
    provider: PriceProvider, holdings: List[Holding], months: int = 12
) -> Optional[Dict]:
    # Only available for yfinance provider
    if not isinstance(provider, YFinanceProvider):
        return None
    # FX monthly series USDJPY
    fx_pairs = provider.get_monthly_series("USDJPY=X", months=months)
    months_labels = [m for (m, _) in fx_pairs]
    fx_map = {m: v for (m, v) in fx_pairs}

    # helper to align values to months_labels with NaN for missing
    def align(series: List[Tuple[str, float]]) -> List[float]:
        m = {k: v for (k, v) in series}
        out: List[float] = []
        for lbl in months_labels:
            out.append(float("nan") if lbl not in m else float(m[lbl]))
        return out

    rows: List[Dict] = []
    for h in holdings:
        ser = provider.get_monthly_series(h.symbol, months=months)
        prices_aligned = align(ser)
        ccy = (h.currency or "USD").upper()
        usd_prices: List[float] = []
        jpy_prices: List[float] = []
        for i, px in enumerate(prices_aligned):
            fx = fx_map.get(months_labels[i])
            if ccy == "USD":
                usd_p = px
                jpy_p = (px * fx) if (fx is not None and not (px != px)) else float("nan")
            else:
                jpy_p = px
                usd_p = (px / fx) if (fx not in (None, 0) and not (px != px)) else float("nan")
            usd_prices.append(usd_p)
            jpy_prices.append(jpy_p)
        usd_values = [ (p * h.shares) if not (p != p) else float("nan") for p in usd_prices ]
        jpy_values = [ (p * h.shares) if not (p != p) else float("nan") for p in jpy_prices ]
        rows.append({
            "symbol": h.symbol,
            "shares": int(round(h.shares)),
            "currency": ccy,
            "usd_price": usd_prices,
            "usd_value": usd_values,
            "jpy_price": jpy_prices,
            "jpy_value": jpy_values,
        })

    dataset = {
        "months": months_labels,
        "rows": rows,
        "fx": [fx_map.get(m) for m in months_labels],
    }
    return dataset


def dataset_to_csv(dataset: Dict) -> str:
    # header: month,symbol,shares,currency,usd_price,usd_value,jpy_price,jpy_value,fx_rate
    months: List[str] = dataset.get("months", [])
    rows = dataset.get("rows", [])
    fx_list: List[Optional[float]] = dataset.get("fx", [])
    out_lines: List[str] = []
    out_lines.append(
        "month,symbol,shares,currency,usd_price,usd_value,jpy_price,jpy_value,fx_rate"
    )
    for i, m in enumerate(months):
        fx = fx_list[i] if i < len(fx_list) else None
        for r in rows:
            symbol = r.get("symbol")
            shares = r.get("shares")
            currency = r.get("currency")
            up_list = r.get("usd_price", [])
            uv_list = r.get("usd_value", [])
            jp_list = r.get("jpy_price", [])
            jv_list = r.get("jpy_value", [])
            def _get(lst, idx):
                try:
                    v = lst[idx]
                    return "" if v != v else f"{float(v):.6f}"
                except Exception:
                    return ""
            up = _get(up_list, i)
            uv = _get(uv_list, i)
            jp = _get(jp_list, i)
            jv = _get(jv_list, i)
            fxv = ("" if fx is None or (isinstance(fx, float) and fx != fx) else f"{float(fx):.6f}")
            out_lines.append(
                f"{m},{symbol},{shares},{currency},{up},{uv},{jp},{jv},{fxv}"
            )
    return "\n".join(out_lines) + "\n"


# ------------------------------ CLI ---------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ポートフォリオ評価レポート生成ツール")
    p.add_argument("--config", default="config.json", help="設定ファイル(JSON)。デフォルト: config.json")
    p.add_argument(
        "--portfolio-url",
        default="http://127.0.0.1:8787/api/portfolio",
        help="ポートフォリオ取得APIのURL",
    )
    # 以前のオプションは廃止しました
    p.add_argument(
        "--sort-by",
        choices=["usd", "jpy", "none"],
        default="jpy",
        help="並び替え基準: usd(USD_VALUE), jpy(JPY_VALUE), none(並び替えなし)",
    )
    p.add_argument(
        "--sort-order",
        choices=["desc", "asc"],
        default="desc",
        help="並び順: desc(降順) / asc(昇順)",
    )
    p.add_argument("--save-html", help="生成したHTMLレポートをファイルに保存")
    p.add_argument("--dataset-csv", help="月次データセットをCSVで保存するパス")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    # Load .env early so env vars can override secrets before reading config
    _load_dotenv()
    try:
        cfg = load_config(args.config)
        holdings = load_portfolio_api(
            args.portfolio_url, default_currency=cfg.quote_currency
        )
        if not holdings:
            print("ポートフォリオが空です", file=sys.stderr)
            return 2

        if cfg.price_provider_type == "yfinance":
            provider = YFinanceProvider()
        else:
            provider = AlphaVantageProvider(api_key=cfg.price_provider.api_key)
        prices = fetch_prices(provider, holdings)

        # USD/JPYレート（必要に応じて取得）
        need_fx = any((h.currency or "USD").upper() == "USD" for h in holdings) and any(
            (h.currency or "USD").upper() == "JPY" for h in holdings
        )
        # 換算列を常に出すため、どちらか一方しかなくてもレートを取る
        need_fx = True
        usd_jpy_rate = provider.get_fx_rate("USD", "JPY") if need_fx else None

        rows, total_usd, total_jpy = build_rows(holdings, prices, usd_jpy_rate, provider=provider)
        # sort
        if args.sort_by != "none":
            reverse = args.sort_order == "desc"
            keyfunc = (lambda r: (r.usd_value if args.sort_by == "usd" else r.jpy_value))
            # NaN safety: treat NaN as very small when sorting
            def key_with_nan(r: Row) -> float:
                v = keyfunc(r)
                try:
                    return float(v)
                except Exception:
                    return float("-inf")
            rows.sort(key=lambda r: (key_with_nan(r)), reverse=reverse)

        report, _ = format_report(rows, usd_jpy=usd_jpy_rate)
        # 月次データの生成と埋め込みは行わず、シンプルな現在価格表示に戻す
        html_report = format_report_html(rows, usd_jpy_rate, monthly_dataset=None, monthly_csv_text=None)

        if args.save_html:
            try:
                with open(args.save_html, "w", encoding="utf-8") as f:
                    f.write(html_report)
            except Exception as e:
                print(f"HTML保存に失敗: {e}", file=sys.stderr)
        print(report)
        return 0
    except KeyboardInterrupt:
        print("中断されました", file=sys.stderr)
        return 130
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
