#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Backfill holdings.company_name in Cloudflare D1 directly via `wrangler d1 execute`.

Steps:
- Query D1 for symbols missing company_name
- Fetch names from Yahoo v7 quote API (shortName/longName/displayName)
- UPDATE holdings SET company_name=... WHERE symbol=...

Usage:
  python3 scripts/d1_backfill_company_names.py \\
      --db stock-db \\
      --proxy-dir proxy \\
      [--force] [--dry-run]

Requires:
- Cloudflare Wrangler logged-in context for remote access
- Network access to Yahoo API
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Optional

try:
    import yfinance as yf  # type: ignore
except Exception:
    yf = None


def run_wrangler_json(args: List[str], cwd: Optional[str] = None) -> list:
    """Run wrangler command and return parsed JSON array.

    Tries system `wrangler` first, falls back to `npx -y wrangler`.
    """
    base_cmds = [["wrangler"], ["npx", "-y", "wrangler"]]
    last_err: Optional[Exception] = None
    for base in base_cmds:
        cmd = base + args
        try:
            p = subprocess.run(
                cmd,
                cwd=cwd,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            out = p.stdout.strip()
            return json.loads(out) if out else []
        except Exception as e:
            last_err = e
            continue
    if last_err:
        raise last_err
    return []


def d1_query_symbols(db: str, proxy_dir: str, include_existing: bool = False) -> List[str]:
    """Return symbols to update (missing names by default)."""
    sql = (
        "SELECT symbol FROM holdings WHERE company_name IS NULL OR TRIM(company_name) = '' ORDER BY symbol"
        if not include_existing
        else "SELECT symbol FROM holdings ORDER BY symbol"
    )
    res = run_wrangler_json(
        [
            "d1",
            "execute",
            db,
            "--remote",
            "--command",
            sql,
            "--json",
        ],
        cwd=proxy_dir,
    )
    rows = (res[0] or {}).get("results", []) if isinstance(res, list) and res else []
    symbols: List[str] = []
    for r in rows:
        sym = str(r.get("symbol") or "").strip()
        if sym:
            symbols.append(sym)
    return symbols


def yahoo_names(symbols: List[str]) -> Dict[str, str]:
    """Return map SYMBOL->name using Yahoo v7 quote API, in batches."""
    out: Dict[str, str] = {}
    if not symbols:
        return out
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; d1-backfill/1.0)",
        "Accept": "application/json",
    }
    chunk = 50
    for i in range(0, len(symbols), chunk):
        batch = symbols[i : i + chunk]
        url = (
            "https://query1.finance.yahoo.com/v7/finance/quote?symbols="
            + urllib.parse.quote(",".join(batch))
        )
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                j = json.loads(resp.read().decode("utf-8"))
        except Exception:
            try:
                url2 = (
                    "https://query2.finance.yahoo.com/v7/finance/quote?symbols="
                    + urllib.parse.quote(",".join(batch))
                )
                req2 = urllib.request.Request(url2, headers=headers)
                with urllib.request.urlopen(req2, timeout=20) as resp:
                    j = json.loads(resp.read().decode("utf-8"))
            except Exception:
                j = {"quoteResponse": {"result": []}}
        arr = (j or {}).get("quoteResponse", {}).get("result", []) or []
        for r in arr:
            try:
                sym = str(r.get("symbol") or "").upper()
                cand = r.get("shortName") or r.get("longName") or r.get("displayName")
                if sym and isinstance(cand, str) and cand.strip():
                    out[sym] = cand.strip()
            except Exception:
                continue
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


def sql_escape_single_quotes(s: str) -> str:
    return s.replace("'", "''")


def d1_update_name(db: str, proxy_dir: str, symbol: str, name: str, dry_run: bool = False) -> None:
    name_sql = sql_escape_single_quotes(name)
    sym_sql = sql_escape_single_quotes(symbol)
    sql = f"UPDATE holdings SET company_name = '{name_sql}' WHERE symbol = '{sym_sql}'"
    if dry_run:
        print("DRY SQL:", sql)
        return
    _ = run_wrangler_json(
        [
            "d1",
            "execute",
            db,
            "--remote",
            "--command",
            sql,
            "--json",
        ],
        cwd=proxy_dir,
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill holdings.company_name in D1 via wrangler")
    p.add_argument("--db", default="stock-db", help="D1 database name or binding (from wrangler.toml)")
    p.add_argument("--proxy-dir", default="proxy", help="Directory containing wrangler.toml")
    p.add_argument("--force", action="store_true", help="Update all symbols (not only missing)")
    p.add_argument("--dry-run", action="store_true", help="Preview without writing")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        symbols = d1_query_symbols(args.db, args.proxy_dir, include_existing=args.force)
    except Exception as e:
        print(f"Failed to query D1: {e}", file=sys.stderr)
        return 2
    if not symbols:
        print("No target symbols (company_name already present)")
        return 0
    print(f"Resolve names from Yahoo: {len(symbols)} symbols")
    name_map = yahoo_names(symbols)
    missing = [s for s in symbols if s.upper() not in name_map]
    if missing:
        ymap = yfinance_names(missing)
        name_map.update(ymap)
    if not name_map:
        print("No names resolved (Yahoo/yfinance)", file=sys.stderr)
        return 3
    updated = 0
    for sym in symbols:
        nm = name_map.get(sym.upper())
        if not nm:
            print(f"  missing: {sym}")
            continue
        try:
            d1_update_name(args.db, args.proxy_dir, sym, nm, dry_run=args.dry_run)
            print(f"  updated: {sym} -> {nm}")
            updated += 1
        except Exception as e:
            print(f"  failed: {sym} {e}", file=sys.stderr)
    print(f"Done: {updated} updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
