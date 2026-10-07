#!/usr/bin/env python3
"""平衡校准器：卡库 + 装盒参数 + N 手模拟 → 牌型频率直方 / 目标差距 / 配额调优建议。

流程：SampleDeck 抽盒（分层配额口径见 data/pipeline-report.md「P6 建盒参数口径」，D16）
→ 每手发 7 张 → 七选五取最大牌型（判定与 verify_hands.evaluate_hand 同源）→ 统计 tier 1–10 频率。
诊断视图：剥离浅羁绊（类 4 年份 / 类 5 原作类型）后的频率 + 手内热源值，定位过热主因。
产出 data/BALANCE.md；同 seed 可复现（报告不含时间戳）。

用法:
  python scripts/simulate_balance.py                     # 默认 1 万手
  python scripts/simulate_balance.py --hands 1000 --pool-size 78 --seed 20260929
"""
from __future__ import annotations

import argparse
import itertools
import json
import random
import sys
from collections import Counter
from pathlib import Path

import verify_hands

REPO = Path(__file__).resolve().parent.parent
CLASS_NAMES = {1: "监督", 2: "公司", 3: "标签", 4: "年份", 5: "原作类型"}


# ---------------------------------------------------------------- 装盒（SampleDeck 口径的 Python 移植）
def prepare(library):
    """建盒前置：库内 support + 组牌类 + 层（档位 × 组牌类）候选表。

    组牌类 = 与库内其它卡共享（支持≥2）的最高优先级要素类；无共享要素记 5（不设 0 类）。
    """
    support = Counter()
    for c in library:
        for e in c["elements"]:
            support[(e["class"], e["value"])] += 1
    strata = {}
    for c in library:
        shared = [e["class"] for e in c["elements"] if support[(e["class"], e["value"])] >= 2]
        cls = min(shared) if shared else 5
        strata.setdefault((c["bucket"], cls), []).append(c)
    for k in strata:
        strata[k].sort(key=lambda c: c["id"])
    return {"strata": strata, "classes": {k[1] for k in strata}}


def plan_quota(prepared, pool_size):
    """配额 1–3 步（与 pipeline-report.md P6 伪代码一致）：档位等额 → 类比例最大余数 → 余席回填。

    配额只依赖库与 S（与 seed 无关），故整场模拟只算一次。
    """
    strata = prepared["strata"]
    buckets = sorted({k[0] for k in strata})
    by_bucket_n = Counter()
    for (b, _cls), lst in strata.items():
        by_bucket_n[b] += len(lst)
    base, extra = divmod(pool_size, len(buckets))
    bucket_quota = {b: base for b in buckets}
    for b in sorted(buckets, key=lambda b: (-by_bucket_n[b], b))[:extra]:
        bucket_quota[b] += 1

    want = {}
    for b in buckets:
        keys = [k for k in sorted(strata) if k[0] == b]
        total = sum(len(strata[k]) for k in keys)
        qb = bucket_quota[b]
        frac = []
        for k in keys:
            q = qb * len(strata[k]) / total
            want[k] = int(q)
            frac.append((q - int(q), k))
        for _, k in sorted(frac, key=lambda x: (-x[0], x[1]))[:qb - sum(want[k] for k in keys)]:
            want[k] += 1

    alloc = {k: min(want.get(k, 0), len(strata[k])) for k in strata}
    leftover = pool_size - sum(alloc.values())
    while leftover > 0:
        free = [k for k in sorted(strata) if alloc[k] < len(strata[k])]
        if not free:
            raise SystemExit(f"卡库不足以装盒 {pool_size} 张")
        k = min(free, key=lambda k: (-(len(strata[k]) - alloc[k]), k))
        alloc[k] += 1
        leftover -= 1
    return alloc


def sample_deck(prepared, plan, seed):
    """配额 4–5 步：层内固定 seed 洗牌取前 n'_k + 组牌类零覆盖兜底。返回一副牌盒。"""
    strata = prepared["strata"]
    alloc = dict(plan)
    rng = random.Random(seed)
    picked, spare = {}, {}
    for k in sorted(strata):
        lst = list(strata[k])
        rng.shuffle(lst)
        picked[k], spare[k] = lst[:alloc[k]], lst[alloc[k]:]

    have = {k[1] for k in picked if picked[k]}
    for cls in sorted(prepared["classes"] - have):
        donors = [k for k in sorted(picked) if alloc[k] >= 2 and k[1] != cls]
        targets = [k for k in sorted(strata) if k[1] == cls and spare[k]]
        if not donors or not targets:
            continue
        d = min(donors, key=lambda k: (-alloc[k], k))
        t = min(targets, key=lambda k: (len(strata[k]) - alloc[k], k))
        spare[t].append(picked[d].pop())
        picked[t].append(spare[t].pop(0))
        alloc[d] -= 1
        alloc[t] += 1

    deck = sorted((c for k in picked for c in picked[k]), key=lambda c: c["id"])
    assert len(deck) == sum(plan.values()), "牌盒大小与配额不符"
    return deck


# ---------------------------------------------------------------- 发牌与判定（与 verify_hands 同源）
def best_tier(cards):
    """七选五取最大牌型（规则书 §5；判定逻辑 = verify_hands.evaluate_hand）。"""
    best = 0
    for combo in itertools.combinations(cards, 5):
        tier, _found = verify_hands.evaluate_hand(list(combo))
        if tier > best:
            best = tier
    return best


def hand_stats(seven):
    """一手的三层信息：全类最优 tier、剥离浅羁绊（仅类 1–3）的最优 tier、手内热源值。"""
    deep = [{"year": c["year"], "elements": [e for e in c["elements"] if e["class"] in (1, 2, 3)]}
            for c in seven]
    sup = Counter((e["class"], e["value"]) for c in seven for e in c["elements"])
    return best_tier(seven), best_tier(deep), sup


# ---------------------------------------------------------------- 目标与建议
def load_targets(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for t in range(1, 11):
        item = cfg["targets"].get(str(t))
        if item is None:
            raise SystemExit(f"balance_targets.json 缺 tier {t}")
        if item["name"] != verify_hands.TIER_NAME[t]:
            raise SystemExit(f"balance_targets.json tier {t} 名称 {item['name']!r} "
                             f"与 verify_hands.TIER_NAME {verify_hands.TIER_NAME[t]!r} 不符")
        if not (0 <= item["min"] <= item["max"] <= 1):
            raise SystemExit(f"balance_targets.json tier {t} 区间非法")
    return cfg


def suggest(over, under, deep_rates, deck_type, lib_type, cfg):
    """把偏差翻译成旋钮的调优建议：先归因（深羁绊 vs 浅羁绊），再给具体值。"""
    out = []
    hot = sorted(t for t in over if t in (2, 7, 8, 9, 10))
    sparse = 1 in over
    deep_duo = deep_rates.get(1, 0)
    deep_cold = deep_duo > cfg["targets"]["1"]["max"]     # 剥离浅羁绊后独奏仍超上限 = 深羁绊过稀
    shallow_driven = hot and deep_cold                     # 全类过热 + 深类过冷 → 热源在浅羁绊
    if hot and shallow_driven:
        other_share = deck_type.get("其他", 0)
        other_lib = lib_type.get("其他", 0)
        out.append(
            f"成组过易的主因是**浅羁绊**（{'、'.join(verify_hands.TIER_NAME[t] for t in hot)} 超上限；"
            f"剥离类 4/5 后独奏率 {deep_duo:.1%}，同样超上限——全类过热与深类过冷是同一枚硬币）"
            f"——根因与旋钮："
            f"① 原作类型「其他」是兜底桶（库占 {other_lib:.0%}、盒内 {other_share:.0%}），"
            f"五值里它不是真属性却人人相撞——数据侧拆细「其他」/补 meta 才能根治；"
            f"可先做「其他不产类型要素」敏感性实验（注意规则书 §3 每卡 1 种类型、G7 三连星即类型×3，属规则定夺）；"
            f"② 配额侧：档位等额把冷门低分档（旧作、原作缺失多为「其他」）抬成同席，"
            f"盒内类型配比失真——档位抽样改等额/比例各半的混合可缓解；"
            f"③ T₁/T₂ 与共享值入盒上限只压得到类 1–3（标签/公司/监督），压不动类型/年份")
    elif hot:
        out.append(f"成组过易（{'、'.join(verify_hands.TIER_NAME[t] for t in hot)} 超上限，深羁绊也是来源）："
                   f"① 启用 T₂ 压超频繁标签（起始阈值见 data/CALIBRATION.md 的 5% 行）；"
                   f"② SampleDeck 给共享要素值设入盒上限（建议类 1–3 每值 ≤3 张）；"
                   f"③ 配额向组牌类 4/5 倾斜")
    if deep_cold:
        out.append(f"深羁绊过稀（剥离浅羁绊后独奏率 {deep_duo:.1%}，超区间上限 "
                   f"{cfg['targets']['1']['max']:.0%}）：① 下调 T₁=20"
                   f"（可成组标签值 +38%，见 data/CALIBRATION.md 的 T₁ 表）；"
                   f"② 配额向组牌类 1/2/3 加权（监督/公司/标签共享优先入盒）；"
                   f"③ 放宽共享值入盒上限（类 1–3 每值 ≤5）")
    elif sparse:
        out.append("独奏超上限但深羁绊不稀：手牌太小/牌盒太大导致相撞不足——调小 pool_size 或增大手牌；"
                   "同时复查档位等额是否过度打散同年份卡")
    yearish = sorted(t for t in set(over) | set(under) if t in (5, 6))
    if yearish:
        out.append(f"年份线牌型偏离（{'、'.join(verify_hands.TIER_NAME[t] for t in yearish)}）："
                   f"档位等额已保年份自然分布；连年稀缺时给相邻年份层加配额（组牌类 4 倾斜）")
    if not out:
        out.append("全部牌型在目标区间内；如需继续收紧，可做敏感性实验：共享值入盒上限 {2,3,5} × T₁ {20,50} "
                   "各跑一轮，看频率对旋钮的弹性再定默认值")
    return out


# ---------------------------------------------------------------- 报告
def bar(n, width=24, maxn=1):
    return "█" * max(0, round(width * n / maxn)) if maxn else ""


def build_report(cfg, args, library_n, tiers, deep, drivers, deck_type, lib_type, deck_sum,
                 over, under, advice):
    lines = []
    a = lines.append
    a("# 牌型平衡模拟报告（simulate_balance.py）")
    a("")
    a(f"- 卡库：`{args.cards}`（{library_n} 张全量合格卡）")
    a(f"- 装盒参数：pool_size={args.pool_size} seed={args.seed} hands={args.hands}"
      f"（目标区间 `scripts/balance_targets.json` {cfg['version']}）")
    a("- 口径：每手 = SampleDeck 抽盒（分层配额见 data/pipeline-report.md P6）→ 发 7 张 → "
      "七选五取最大牌型（判定与 verify_hands.evaluate_hand 同源）")
    a(f"- 可复现：第 i 手牌盒 = SampleDeck(pool_size={args.pool_size}, seed={args.seed}+i)，"
      f"发牌 = random.Random({args.seed} + 1_000_003 + i)；同 seed 同参数报告逐字节一致")
    a("")

    a("## 牌型频率直方（全类；tier 高→低）")
    a("")
    a("| tier | 牌型 | 命中 | 频率 | 目标区间 | 判定 | 差距 |")
    a("|---|---|---|---|---|---|---|")
    for t in range(10, 0, -1):
        tgt = cfg["targets"][str(t)]
        rate = tiers.get(t, 0) / args.hands
        gap = ""
        if rate > tgt["max"]:
            gap = f"+{rate - tgt['max']:.3%} 超上限"
        elif rate < tgt["min"]:
            gap = f"-{tgt['min'] - rate:.3%} 低于下限"
        a(f"| {t} | {tgt['name']} | {tiers.get(t, 0)} | {rate:.3%} | "
          f"{tgt['min']:.1%}–{tgt['max']:.1%} | {'✓' if not gap else '✗'} | {gap} |")
    a("")
    a("```")
    for t in range(10, 0, -1):
        a(f"{t:>2} {verify_hands.TIER_NAME[t]:<6} {bar(tiers.get(t, 0), 24, max(tiers.values()))} "
          f"{tiers.get(t, 0) / args.hands:.3%}")
    a("```")
    a("")
    hit = sum(tiers.get(t, 0) for t in range(2, 11))
    a(f"有组率（tier≥2）：{hit / args.hands:.3%}；高牌型率（tier≥7）："
      f"{sum(tiers.get(t, 0) for t in range(7, 11)) / args.hands:.3%}")
    a("")

    a("## 诊断：剥离浅羁绊（类 4 年份 / 类 5 原作类型）后的频率")
    a("")
    a("只认监督/公司/标签（类 1–3）成组时的分布——与上表同目标区间对照，用于归因："
      "全类过热而本表过冷，说明热源在浅羁绊（年份/原作类型），深羁绊反而是稀缺品。")
    a("")
    a("| tier | 牌型 | 命中 | 频率 | 目标区间 |")
    a("|---|---|---|---|---|")
    for t in range(10, 0, -1):
        tgt = cfg["targets"][str(t)]
        a(f"| {t} | {tgt['name']} | {deep.get(t, 0)} | {deep.get(t, 0) / args.hands:.3%} | "
          f"{tgt['min']:.1%}–{tgt['max']:.1%} |")
    a("")

    a("## 诊断：手内热源（7 张里同值 ≥4 的要素，出现手数 top15）")
    a("")
    a("| 要素类 | 值 | 含 ≥4 同值的手数 |")
    a("|---|---|---|")
    for (cl, v), n in drivers.most_common(15):
        a(f"| {cl} {CLASS_NAMES.get(cl, '?')} | {v} | {n} |")
    a("")

    a("## 盒构成")
    a("")
    a("- 类型配比（盒内均值 vs 库占比）：")
    a("")
    a("| 原作类型 | 盒内占比 | 库占比 | 偏移 |")
    a("|---|---|---|---|")
    for t in sorted(lib_type, key=lambda x: -lib_type[x]):
        ds = deck_type.get(t, 0)
        ls = lib_type[t]
        a(f"| {t} | {ds:.1%} | {ls:.1%} | {ds - ls:+.1%} |")
    a("")
    a(f"- 共享要素值（类 1–3，盒内支持≥2）：{deck_sum['shared'] / args.hands:.1f} 个/盒（均值）")
    a(f"- 盒内最大同值张数（均值）：{deck_sum['maxsup'] / args.hands:.1f}")
    a("")

    a("## 与目标区间的差距")
    a("")
    if over or under:
        for t in sorted(over, reverse=True):
            a(f"- 超上限：{verify_hands.TIER_NAME[t]}（tier {t}）+{over[t]:.3%}")
        for t in sorted(under, reverse=True):
            a(f"- 低于下限：{verify_hands.TIER_NAME[t]}（tier {t}）-{under[t]:.3%}")
    else:
        a("- 全部牌型落在目标区间内")
    a("")

    a("## 配额参数调优建议")
    a("")
    for i, s in enumerate(advice, 1):
        a(f"{i}. {s}")
    a("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description="牌型平衡模拟：SampleDeck → 七选五 → 频率直方/目标差距/调优建议")
    ap.add_argument("--cards", default=str(REPO / "data" / "cards.json"))
    ap.add_argument("--targets", default=str(REPO / "scripts" / "balance_targets.json"))
    ap.add_argument("--out", default=str(REPO / "data" / "BALANCE.md"))
    ap.add_argument("--hands", type=int, default=None, help="模拟手数（默认取 targets 的 defaults.hands=10000）")
    ap.add_argument("--pool-size", type=int, default=None, help="牌盒张数（默认 78；规则书 52–104）")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args(argv)

    cfg = load_targets(args.targets)
    d = cfg.get("defaults", {})
    args.hands = args.hands or d.get("hands", 10000)
    args.pool_size = args.pool_size or d.get("pool_size", 78)
    args.seed = d.get("seed", 20260929) if args.seed is None else args.seed

    with open(args.cards, encoding="utf-8") as f:
        library = json.load(f)
    lib_type = Counter(c["type"] for c in library)
    lib_type = {t: n / len(library) for t, n in lib_type.items()}
    prepared = prepare(library)
    plan = plan_quota(prepared, args.pool_size)

    tiers, deep, drivers = Counter(), Counter(), Counter()
    deck_sum = Counter()
    deck_type = Counter()
    for i in range(args.hands):
        deck = sample_deck(prepared, plan, args.seed + i)
        seven = random.Random(args.seed + 1_000_003 + i).sample(deck, 7)
        t_all, t_deep, sup = hand_stats(seven)
        tiers[t_all] += 1
        deep[t_deep] += 1
        for (cl, v), n in sup.items():
            if n >= 4:
                drivers[(cl, v)] += 1
        for c in deck:
            deck_type[c["type"]] += 1 / args.hands / args.pool_size
        deck_sum["shared"] += sum(1 for n in sup.values() if n >= 2)
        deck_sum["maxsup"] += max(sup.values()) if sup else 0

    deep_rates = {t: deep.get(t, 0) / args.hands for t in range(1, 11)}
    over, under = {}, {}
    for t in range(1, 11):
        rate = tiers.get(t, 0) / args.hands
        tgt = cfg["targets"][str(t)]
        if rate > tgt["max"]:
            over[t] = rate - tgt["max"]
        elif rate < tgt["min"]:
            under[t] = tgt["min"] - rate

    advice = suggest(over, under, deep_rates, deck_type, lib_type, cfg)
    report = build_report(cfg, args, len(library), tiers, deep, drivers, deck_type, lib_type,
                          deck_sum, over, under, advice)
    Path(args.out).write_text(report, encoding="utf-8", newline="\n")
    print(f"BALANCE.md → {args.out}（{args.hands} 手，pool={args.pool_size}，seed={args.seed}）")
    for t in range(10, 0, -1):
        print(f"  tier {t:>2} {verify_hands.TIER_NAME[t]:<6} {tiers.get(t, 0) / args.hands:.3%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
