#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
CSV(portfolio.csv) の内容を Cloudflare Workers の `/api/portfolio` へ反映します。

機能:
- CSV行を API に対して upsert(INSERT OR REPLACE) します
- `--mode replace` で DB 側にあって CSV に無い銘柄を削除します
- `--dry-run` で送信せずに差分だけ表示できます

使い方:
  python3 scripts/sync_portfolio_csv.py \
      --csv portfolio.csv \
      --api http://127.0.0.1:8787/api/portfolio \
      --mode replace

API 仕様(本リポジトリの proxy/worker.js に準拠):
- GET    /api/portfolio                 → [{symbol, shares, currency}]
- POST   /api/portfolio  JSON: {symbol,shares,currency} → {ok:true}
- DELETE /api/portfolio?symbol=XXXX     → {ok:true}
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


DEFAULT_API = "http://127.0.0.1:8787/api/portfolio"


@dataclass
class Holding:
    symbol: str
    shares: float
    currency: Optional[str] = None


def _http_json(url: str, method: str = "GET", data: Optional[dict] = None, timeout: int = 30) -> dict:
    body_bytes: Optional[bytes] = None
    headers = {"Content-Type": "application/json; charset=utf-8"}
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
        out.append(Holding(symbol=sym, shares=sh, currency=ccy))
    return out


def api_upsert(api: str, h: Holding, dry_run: bool = False) -> None:
    if dry_run:
        print(f"POST {api} {h}")
        return
    _http_json(api, method="POST", data={
        "symbol": h.symbol,
        "shares": h.shares,
        "currency": h.currency,
    })


def api_delete(api: str, symbol: str, dry_run: bool = False) -> None:
    url = f"{api}?symbol={urllib.parse.quote(symbol)}"
    if dry_run:
        print(f"DELETE {url}")
        return
    _http_json(url, method="DELETE")


def read_csv(path: str) -> List[Holding]:
    out: List[Holding] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        # 必須列: symbol, shares, currency
        for row in reader:
            sym = str(row.get("symbol") or "").strip()
            if not sym:
                continue
            try:
                sh = float(row.get("shares") or 0)
            except Exception:
                sh = 0.0
            ccy_raw = row.get("currency")
            ccy = (ccy_raw.strip().upper() if isinstance(ccy_raw, str) else None) or None
            out.append(Holding(symbol=sym, shares=sh, currency=ccy))
    return out


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="portfolio.csv を /api/portfolio に同期")
    p.add_argument("--csv", default="portfolio.csv", help="入力CSVのパス")
    p.add_argument("--api", default=DEFAULT_API, help="APIのURL (/api/portfolio)")
    p.add_argument("--mode", choices=["upsert", "replace"], default="upsert", help="upsert: 追加/更新のみ, replace: CSVに無い銘柄を削除")
    p.add_argument("--dry-run", action="store_true", help="APIを呼ばずに差分のみ表示")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        csv_holdings = read_csv(args.csv)
    except FileNotFoundError:
        print(f"CSVが見つかりません: {args.csv}", file=sys.stderr)
        return 2

    try:
        current = api_get_holdings(args.api)
    except urllib.error.URLError as e:
        print(f"APIへ接続できませんでした: {args.api} ({e})", file=sys.stderr)
        return 3

    # インデックス化
    csv_map: Dict[str, Holding] = {h.symbol: h for h in csv_holdings}
    cur_map: Dict[str, Holding] = {h.symbol: h for h in current}

    # 削除対象（replaceモードのみ）
    to_delete: List[str] = []
    if args.mode == "replace":
        for sym in cur_map.keys():
            if sym not in csv_map:
                to_delete.append(sym)

    # 追加/更新対象
    to_upsert: List[Holding] = list(csv_holdings)

    # 実行
    if to_delete:
        print(f"削除 {len(to_delete)} 件: {', '.join(to_delete)}")
    for sym in to_delete:
        api_delete(args.api, sym, dry_run=args.dry_run)

    print(f"upsert {len(to_upsert)} 件")
    for h in to_upsert:
        api_upsert(args.api, h, dry_run=args.dry_run)

    print("完了")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

