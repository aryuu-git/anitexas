#!/usr/bin/env python3
"""黄金十手复算：把 bak/anitexas-verify.py 转正，在管线产物 data/cards.json 上复算 G1–G10。

牌型判定口径与原型 evaluate() 逐语义一致（多重解读取最高、永不判平）；
期望 tier 见 architecture.md §4.1 表（G1 黄金世代 … G10 独奏）。

用法:
  python scripts/verify_hands.py                  # 复算，全绿退出码 0
  python scripts/verify_hands.py --export-fixture  # 导出「要素集快照」JSON 到 stdout，
                                                  # 供 backend/internal/engine/golden_test.go 内联（§4.1 注）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 牌型 10→1（规则书 §4；与 engine 包 Tier 语义一致）
TIER_ORDER = ["独奏", "二重唱", "四手联弹", "三连星", "三部曲物语",
              "年代物语", "合奏", "四大名作", "命运共同体", "黄金世代"]
TIER_NAME = {i + 1: n for i, n in enumerate(TIER_ORDER)}


def evaluate_hand(cs):
    """五张卡算牌型：返回 (tier, {tier: 成组说明})，与原型 evaluate() 同口径。

    cs 为 5 张卡（dict，需含 year:int 与 elements:[{class,value}]）；
    同一要素值的卡成组，撞要素只算一组；多重解读取最高 tier。
    """
    els = [set((e["class"], e["value"]) for e in c["elements"]) for c in cs]
    years = [int(c["year"]) for c in cs]
    found = {}
    groups = {}
    for i, e in enumerate(els):
        for kv in e:
            groups.setdefault(kv, set()).add(i)

    def g(sz):
        return [x for x in groups.values() if len(x) == sz]

    for x in g(5):  # 同要素×5 且五年连着 → 黄金世代
        ys = sorted(years[i] for i in x)
        if ys[-1] - ys[0] == 4 and len(set(ys)) == 5:
            found[10] = "同×5+连年"
    if g(5):
        found.setdefault(9, "同×5")
    if g(4):
        found.setdefault(8, "同×4")
    for a in g(3):  # 三条 + 对子（组间卡不相交）→ 合奏
        for b in g(2):
            if not a & b:
                found.setdefault(7, "3+2")
    if len(set(years)) == 5 and max(years) - min(years) == 4:
        found[6] = "连年×5"
    for a in g(3):  # 同要素×3 且三年连着 → 三部曲物语
        ys = sorted(years[i] for i in a)
        if ys[-1] - ys[0] == 2 and len(set(ys)) == 3:
            found.setdefault(5, "同×3+连年")
    if g(3):
        found.setdefault(4, "同×3")
    g2 = g(2)
    for i in range(len(g2)):  # 两个不相交对子 → 四手联弹
        for j in range(i + 1, len(g2)):
            if not g2[i] & g2[j]:
                found.setdefault(3, "2+2")
    if g2:
        found.setdefault(2, "同×2")
    if not found:
        found[1] = "无"
    return max(found), found


def load_fixture(path):
    """载入黄金十手夹具（卡 id 钉死 dump + 期望 tier）。"""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def verify_pool(cards_by_id, fixture):
    """在卡池产物上复算 G1–G10。返回 (ok, 行列表)。"""
    ok = True
    lines = []
    for hand in fixture["hands"]:
        cs = []
        bad = None
        for key in hand["keys"]:
            meta = fixture["cards"].get(key)
            if meta is None:
                bad = f"夹具缺卡[{key}]"
                break
            card = cards_by_id.get(meta["id"])
            if card is None:
                bad = f"产物缺卡[{key}](id={meta['id']})"
                break
            if int(card["year"]) != int(meta["year"]):
                bad = f"夹具年份不符[{key}] 夹具{meta['year']}≠产物{card['year']}"
                break
            cs.append(card)
        if bad:
            ok = False
            lines.append(f"✗ {hand['case']} {hand['name']}: {bad}")
            continue
        tier, found = evaluate_hand(cs)
        hit = tier == hand["expect"]
        ok &= hit
        detail = ", ".join(f"{TIER_NAME[t]}({t}):{r}" for t, r in sorted(found.items(), reverse=True))
        lines.append(("✓" if hit else "✗")
                     + f" {hand['case']} {hand['name']} 期望[{hand['expect']}] 实算[{tier}] {detail}")
    return ok, lines


def snapshot(cards_by_id, fixture):
    """导出「要素集快照」：供 engine/golden_test.go 表驱动内联（architecture.md §4.1）。"""
    cards = {}
    for key, meta in fixture["cards"].items():
        c = cards_by_id[meta["id"]]
        cards[key] = {"id": c["id"], "title": c["title"], "score": c["score"], "bucket": c["bucket"],
                      "year": c["year"], "elements": c["elements"]}
    return {"cards": cards,
            "hands": [{"case": h["case"], "name": h["name"], "expect": h["expect"], "keys": h["keys"]}
                      for h in fixture["hands"]]}


def main(argv=None):
    ap = argparse.ArgumentParser(description="黄金十手 G1–G10 在卡池产物上复算")
    ap.add_argument("--cards", default=str(REPO / "data" / "cards.json"), help="卡池产物（默认 data/cards.json）")
    ap.add_argument("--fixture", default=str(REPO / "scripts" / "golden_hands.json"), help="黄金十手夹具")
    ap.add_argument("--export-fixture", action="store_true", help="只导出要素集快照 JSON 到 stdout")
    args = ap.parse_args(argv)

    fixture = load_fixture(args.fixture)
    with open(args.cards, encoding="utf-8") as f:
        cards = json.load(f)
    by_id = {c["id"]: c for c in cards}

    if args.export_fixture:
        json.dump(snapshot(by_id, fixture), sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
        return 0

    ok, lines = verify_pool(by_id, fixture)
    for ln in lines:
        print(ln)
    print("ALL OK" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
