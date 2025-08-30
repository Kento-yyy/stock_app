#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Backfill company names into the portfolio DB via /api/portfolio.

- Fetches current holdings from the Worker API
- Resolves company names from Yahoo Finance public quote API
- POSTs updates with {symbol, shares, currency, company_name}

Usage:
  python3 scripts/backfill_company_names.py \
      --api https://<your-worker>.workers.dev/api/portfolio \
      [--force] [--dry-run]

Notes:
- Run this after deploying the updated worker (supports company_name).
- No external packages required (uses urllib).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

try:
    import yfinance as yf  # type: ignore
except Exception:
    yf = None


DEFAULT_API = "http://127.0.0.1:8787/api/portfolio"


@dataclass
class Holding:
    symbol: str
    shares: float
    currency: Optional[str] = None
    company_name: Optional[str] = None


def _http_json(url: str, method: str = "GET", data: Optional[dict] = None, timeout: int = 30) -> dict:
    body_bytes: Optional[bytes] = None
    headers = {"Content-Type": "application/json; charset=utf-8", "User-Agent": "pf-tools/1.0"}
    if data is not None:
        body_bytes = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body_bytes, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def api_get_holdings(api: str) -> List[Holding]:
    data = _http_json(api, method="GET")
    out: List[Holding] = []
    for r in data or []:
        sym = str(r.get("symbol") or "").strip()
        if not sym:
            continue
        try:
            sh = float(r.get("shares") or 0)
        except Exception:
            sh = 0.0
        ccy = (r.get("currency") or "").strip().upper() or None
        name = (r.get("company_name") or r.get("name") or "").strip() or None
        out.append(Holding(symbol=sym, shares=sh, currency=ccy, company_name=name))
    return out


def api_upsert(api: str, h: Holding, dry_run: bool = False) -> None:
    payload = {
        "symbol": h.symbol,
        "shares": h.shares,
        "currency": h.currency,
        "company_name": h.company_name,
    }
    if dry_run:
        print("DRY POST", api, json.dumps(payload, ensure_ascii=False))
        return
    _http_json(api, method="POST", data=payload)


def yahoo_names(symbols: List[str]) -> Dict[str, str]:
    """Return map: SYMBOL -> name using Yahoo v7 quote API.

    Picks first available among: shortName, longName, displayName.
    """
    out: Dict[str, str] = {}
    if not symbols:
        return out
    # chunk to avoid URL too long
    chunk = 50
    uah = {
        "User-Agent": "Mozilla/5.0 (compatible; pf-tools/1.0)",
        "Accept": "application/json",
    }
    for i in range(0, len(symbols), chunk):
        batch = symbols[i : i + chunk]
        url = (
            "https://query1.finance.yahoo.com/v7/finance/quote?symbols="
            + urllib.parse.quote(",".join(batch))
        )
        req = urllib.request.Request(url, headers=uah)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                j = json.loads(resp.read().decode("utf-8"))
        except Exception:
            # try secondary host, tolerate failures
            try:
                url2 = (
                    "https://query2.finance.yahoo.com/v7/finance/quote?symbols="
                    + urllib.parse.quote(",".join(batch))
                )
                req2 = urllib.request.Request(url2, headers=uah)
                with urllib.request.urlopen(req2, timeout=20) as resp:
                    j = json.loads(resp.read().decode("utf-8"))
            except Exception:
                j = {"quoteResponse": {"result": []}}
        arr = (j or {}).get("quoteResponse", {}).get("result", []) or []
        for r in arr:
            try:
                sym = str(r.get("symbol") or "").upper()
                cand = (
                    r.get("shortName")
                    or r.get("longName")
                    or r.get("displayName")
                    or None
                )
                if sym and isinstance(cand, str) and cand.strip():
                    out[sym] = cand.strip()
            except Exception:
                continue
        # be gentle
        time.sleep(0.2)
    return out


def yfinance_names(symbols: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if yf is None:
        return out
    for s in symbols:
        try:
            t = yf.Ticker(s)
            name = None
            # fast_info first
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
                try:
                    info = t.info or {}
                except Exception:
                    info = {}
                name = info.get("shortName") or info.get("longName") or info.get("name")
            if isinstance(name, str) and name.strip():
                out[s.upper()] = name.strip()
        except Exception:
            continue
        time.sleep(0.05)
    return out


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill company_name using Yahoo and update /api/portfolio")
    p.add_argument("--api", default=DEFAULT_API, help="API URL for /api/portfolio")
    p.add_argument("--force", action="store_true", help="Update all symbols even if name exists")
    p.add_argument("--dry-run", action="store_true", help="Preview without POSTing")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        holdings = api_get_holdings(args.api)
    except urllib.error.URLError as e:
        print(f"APIへ接続できませんでした: {args.api} ({e})", file=sys.stderr)
        return 2
    if not holdings:
        print("DBに銘柄がありません")
        return 0
    # target symbols
    targets: List[Holding] = []
    for h in holdings:
        if args.force or not (h.company_name and h.company_name.strip()):
            targets.append(h)
    if not targets:
        print("更新対象なし（全て社名あり）")
        return 0
    symbols = [h.symbol for h in targets]
    print(f"Yahooから社名取得: {len(symbols)}件")
    # First try Yahoo v7 (batch)
    name_map = yahoo_names(symbols)
    # Fill missing via yfinance if available
    missing = [s for s in symbols if s.upper() not in name_map]
    if missing:
        ymap = yfinance_names(missing)
        name_map.update(ymap)
    updated = 0
    for h in targets:
        nm = name_map.get(h.symbol.upper())
        if not nm:
            print(f"  未取得: {h.symbol}")
            continue
        h.company_name = nm
        try:
            api_upsert(args.api, h, dry_run=args.dry_run)
            print(f"  更新: {h.symbol} -> {nm}")
            updated += 1
        except urllib.error.HTTPError as e:
            print(f"  失敗: {h.symbol} HTTP {e.code}", file=sys.stderr)
        except Exception as e:
            print(f"  失敗: {h.symbol} {e}", file=sys.stderr)
    print(f"完了: {updated} 件更新")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
