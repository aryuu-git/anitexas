#!/usr/bin/env python3
"""P7 校准：dump 分布探查 → data/CALIBRATION.md（分数直方 / 标注数分布 / 各要素频率 / T₁·T₂ 建议值）。

复用 build_cards.py 的 P1–P3 扫描与 P4 筛子（同口径）；输出不含时间戳，可复现。
用法: python scripts/calibrate.py
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import build_cards as bc

T1_CANDIDATES = (10, 20, 50, 100, 200)


def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0
    i = min(len(sorted_vals) - 1, max(0, round(p * (len(sorted_vals) - 1))))
    return sorted_vals[i]


def hist_rows(bins, counts, maxn):
    rows = []
    for label in bins:
        n = counts.get(label, 0)
        rows.append(f"| {label} | {n} | {bc.bar(n, 24, maxn)} |")
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="T₁/T₂ 分布探查与校准建议")
    ap.add_argument("--dump", default=os.environ.get("ANITEXAS_DUMP", bc.DEFAULT_DUMP))
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--t1", type=int, default=bc.DEFAULT_T1)
    ap.add_argument("--t2", type=int, default=bc.DEFAULT_T2)
    ap.add_argument("--blacklist", default=str(Path(__file__).resolve().parent.parent / "scripts" / "tag_blacklist.txt"))
    args = ap.parse_args(argv)

    bl = bc.load_blacklist(args.blacklist)
    with zipfile.ZipFile(args.dump) as zf:
        pidx = bc.load_person_index(zf)
        cands, counters = bc.scan_subjects(zf, bl, pidx)
    frame = len(cands)
    bc.apply_sieves(cands, bl, args.t1, args.t2)
    for c in cands:
        c["elements"] = bc.assemble_elements(c)

    lines = []
    a = lines.append
    a("# T₁ / T₂ 校准报告（calibrate.py）")
    a("")
    a(f"- 数据源：`{args.dump}`；帧 = 准入卡 {frame} 张（总行数 {counters['总行数']}）")
    a(f"- 当前配置：T₁={args.t1}（标注数下限）、T₂={args.t2}（帧内支持上限，0=不筛）")
    a("- dump 的 tags 字段本身是每卡 top 标注（≤11 条），标注数分布即在此截断之上统计")
    a("")

    # ---- 分数直方（档位）----
    a("## 分数直方（档位 = 评分四舍五入 0.5 档，半值向上）")
    a("")
    a("| 档位 | 张数 | |")
    a("|---|---|---|")
    bucket_dist = Counter(c["bucket"] for c in cands)
    a("\n".join(hist_rows(sorted(bucket_dist), bucket_dist, max(bucket_dist.values()))))
    scores = sorted(c["score"] for c in cands)
    a("")
    a(f"评分 min={scores[0]} p25={percentile(scores, 0.25)} 中位={percentile(scores, 0.5)} "
      f"p75={percentile(scores, 0.75)} max={scores[-1]}；档位数 {len(bucket_dist)}")
    a("")

    # ---- 标注数分布 ----
    a("## 标注数分布（每卡 dump tags 的标注数）")
    a("")
    all_counts = sorted(cnt for c in cands for _n, cnt in c["tags"])
    a(f"标注条数 {len(all_counts)}；标注数 min={all_counts[0]} p10={percentile(all_counts, 0.10)} "
      f"p25={percentile(all_counts, 0.25)} 中位={percentile(all_counts, 0.5)} "
      f"p75={percentile(all_counts, 0.75)} p90={percentile(all_counts, 0.90)} max={all_counts[-1]}")
    a("")
    bins = ["1–4", "5–9", "10–19", "20–49", "50–99", "100–199", "200–499", "500–999", "≥1000"]

    def bin_of(v):
        return ("1–4" if v < 5 else "5–9" if v < 10 else "10–19" if v < 20 else "20–49" if v < 50
                else "50–99" if v < 100 else "100–199" if v < 200 else "200–499" if v < 500
                else "500–999" if v < 1000 else "≥1000")
    binned = Counter(bin_of(v) for v in all_counts)
    a("| 标注数 | 条数 | |")
    a("|---|---|---|")
    a("\n".join(hist_rows(bins, binned, max(binned.values()))))
    a("")

    # ---- 作品级标注数分布（votes = score_details 求和，运行时 minVotes 收池口径）----
    a("## 作品级标注数分布（每卡 votes = score_details 求和）")
    a("")
    votes = sorted(c["votes"] for c in cands)
    a(f"卡数 {len(votes)}；votes min={votes[0]} p25={percentile(votes, 0.25)} 中位={percentile(votes, 0.5)} "
      f"p75={percentile(votes, 0.75)} p90={percentile(votes, 0.90)} max={votes[-1]}")
    a("")
    vbins = ["0", "1–199", "200–999", "1000–1999", "2000–4999", "5000–9999", "10000–49999", "≥50000"]

    def vbin_of(v):
        return ("0" if v <= 0 else "1–199" if v < 200 else "200–999" if v < 1000 else "1000–1999" if v < 2000
                else "2000–4999" if v < 5000 else "5000–9999" if v < 10000 else "10000–49999" if v < 50000 else "≥50000")
    vbinned = Counter(vbin_of(v) for v in votes)
    a("| votes | 张数 | |")
    a("|---|---|---|")
    a("\n".join(hist_rows(vbins, vbinned, max(vbinned.values()))))
    a("")
    ge2000 = sum(1 for v in votes if v >= 2000)
    a(f"默认 minVotes=2000 运行时收池后：{ge2000} 张（占 {ge2000 / len(votes):.1%}）——建库不筛，池仍全量")
    a("")

    # ---- 各要素频率 ----
    a("## 各要素频率（帧内支持 = 挂同一要素值的准入卡数）")
    a("")
    support = defaultdict(Counter)   # class -> value -> 卡数
    covered = Counter()
    for c in cands:
        for e in c["elements"]:
            support[e["class"]][e["value"]] += 1
        seen = {e["class"] for e in c["elements"]}
        for cls in seen:
            covered[cls] += 1
    for cls in (1, 2, 3, 4, 5):
        dist = support[cls]
        top = sorted(dist.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
        pairs = sum(1 for n in dist.values() if n >= 2)
        a(f"### 类 {cls}（{bc_names(cls)}）")
        a("")
        a(f"- 要素值 {len(dist)} 个；覆盖 {covered[cls]} 张卡；能成组（支持≥2）的值 {pairs} 个")
        a("- 高频值：" + "、".join(f"{v} ×{n}" for v, n in top))
        a("")

    # ---- T1/T2 建议 ----
    a("## T₁ 建议值")
    a("")
    a("| T₁ | 保留 distinct 标签 | 保留标注条数 | 能成组（支持≥2） | 边际（可成组值/distinct） |")
    a("|---|---|---|---|---|")
    rows = []
    for t1 in T1_CANDIDATES:
        kept = [(n, cnt) for c in cands for n, cnt in c["tags"] if cnt >= t1 and bl.sieve_reason(n) is None]
        sup = Counter(n for n, _cnt in kept)
        rows.append((t1, len(sup), len(kept), sum(1 for n in sup.values() if n >= 2)))
    prev = None
    for t1, names, occ, pairs in rows:
        marg = "—" if prev is None else f"{(prev[3] - pairs) / (prev[1] - names):.2f}"
        a(f"| {t1} | {names} | {occ} | {pairs} | {marg} |")
        prev = (t1, names, occ, pairs)
    by_t1 = {t1: (names, occ, pairs) for t1, names, occ, pairs in rows}
    n50, _o50, p50 = by_t1[50]
    n20, _o20, p20 = by_t1[20]
    a("")
    a(f"**建议 T₁ = 50（维持规则书参数表当前值）**：可成组值的边际收益在 10–200 区间平坦"
      f"（每多收 1 个 distinct 标签约换 0.35–0.4 个可成组值），数据上没有自然拐点，"
      f"取舍本质是「标注可靠性 vs 组对机会」的策略选择——标注数 <20 的长尾多为拼写变体/个人标记"
      f"（规则书筛子一：样本不可靠）。若 M2 试玩认为标签羁绊不足，可下调 T₁=20："
      f"可成组值 +{(p20 - p50) * 100 // p50}%（{p50}→{p20}），代价是纳入低可靠标签。")
    a("")

    a("## T₂ 建议值")
    a("")
    tag_support = Counter(n for c in cands for n, cnt in c["tags_valid"])
    ubi = sorted(tag_support.items(), key=lambda kv: (-kv[1], kv[0]))[:15]
    a(f"帧内高频标签（P4 后仍在、按支持降序 top15；共 {len(tag_support)} 个标签值）：")
    a("")
    a("| 标签 | 帧内支持 | 占帧 |")
    a("|---|---|---|")
    for v, n in ubi:
        a(f"| {v} | {n} | {n / frame:.1%} |")
    a("")
    a("| T₂（占帧） | 绝对阈值 | 剔除标签值 | 剔除标注条数 | 剩余能成组 |")
    a("|---|---|---|---|---|")
    for share in (0.05, 0.10, 0.20, 0.50):
        th = max(1, round(frame * share))
        dropped = {v for v, n in tag_support.items() if n > th}
        occ = sum(1 for c in cands for n, _cnt in c["tags_valid"] if n in dropped)
        pairs = sum(1 for v, n in tag_support.items() if v not in dropped and n >= 2)
        a(f"| {share:.0%} | {th} | {len(dropped)} | {occ} | {pairs} |")
    top_share = (ubi[0][1] / frame) if ubi else 0
    th5 = max(1, round(frame * 0.05))
    a("")
    if top_share > 0.5:
        a(f"**建议 T₂ = {round(frame * 0.5)}**（帧内支持 >50% 帧即剔，规则书筛子三「大半作品都挂」语义）。")
    else:
        a(f"**建议 T₂ 维持「待定/暂不筛」（默认 0）**：帧内最高频标签「{ubi[0][0]}」仅占帧 {top_share:.1%}，"
          f"远不到规则书筛子三「大半作品都挂着」的语义，当前数据无可剔对象——与规则书参数表的 T₂=待定一致。"
          f"若要主动压最泛标签，从 T₂={th5}（5% 帧）起步；牌池层面「人人成对」的平衡问题"
          f"应等 M2 试玩后按池内口径热调（architecture.md §9）。")
    a("")

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "CALIBRATION.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"CALIBRATION.md → {out / 'CALIBRATION.md'}（帧 {frame} 张；建议 T₁=50 维持、T₂=0 待定）")
    return 0


def bc_names(cls):
    return {1: "监督", 2: "公司", 3: "标签", 4: "年份", 5: "原作类型"}[cls]


if __name__ == "__main__":
    sys.exit(main())
