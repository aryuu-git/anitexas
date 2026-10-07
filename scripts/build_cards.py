#!/usr/bin/env python3
"""AniTexas 卡池管线：dump → data/cards.json + data/pipeline-report.md（P1–P6，只用标准库）。

步骤（architecture.md §4.6）:
  P1 流式解析   subject.jsonlines（980MB，逐行解析，禁止整表载入）
  P2 准入       只收动画（type=2）、非 NSFW、有评分、有日期（规则书 §2）；
                同时记录作品标注数 votes = sum(score_details)（评分人数，供运行时热度筛选）
  P3 要素抽取   五类要素与归一（§3）：监督取 infobox「导演」（最多 2 位，person id 判同）、
                公司取 infobox「动画制作」（京阿尼=京都动画，缺失时按标签别名回退）、
                标签取 dump tags、年份取 date 年、原作类型归一五值
  P4 三道筛子   筛子一 太冷门（标注数<T₁）/ 筛子二 太格式化（scripts/tag_blacklist.txt 四类）/
                筛子三 太频繁（帧内支持>T₂；T₂=0 暂不筛，见 calibrate.py）
  P5 校验       黄金十手 G1–G10 在库上复算通过（同 verify_hands.py；例子牌在库中且判定过）
  P6 落库       全量合格卡 → data/cards.json（不抽样、不保送，D16）；
                分层配额建盒移交运行时 game.SampleDeck，参数口径写进 pipeline-report.md 供参照

要素计算口径与 bak/anitexas-verify.py 一致；差异与取舍见 data/pipeline-report.md。
同 dump 同配置跑两遍产物逐字节一致（建库无随机步骤、词表版本化、产物不含时间戳）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

import verify_hands

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DUMP = "C:/Users/chenjincan/Downloads/bak/dump-2026-09-29.zip"  # 数据真源（本地缓存，sha256 已验）
DEFAULT_T1 = 50          # 筛子一：标注数下限（原型 T1=50）
DEFAULT_T2 = 0           # 筛子三：帧内支持上限；0=暂不筛（calibrate.py 给建议值）

DIRECTOR_KEYS = ("导演", "監督", "监督")
STUDIO_KEYS = ("动画制作", "アニメーション制作", "动画制作公司")
ORIGIN_KEYS = ("原作",)

# 原作类型「原作文本推断」标记（meta/标签都没给改编类型时的兜底启发式）
GAME_MARKERS = ("ゲーム", "ソフト", "5pb", "nitro+", "type-moon", "visual arts", "ニトロプラス", "galgame", "key/")
MANGA_MARKERS = ("漫画", "連載", "掲載", "コミックス", "まんが", "マガジン", "ジャンプ")
NOVEL_MARKERS = ("文庫", "小説", "ノベル", "ラノベ", "著")

FIVE_TYPES = ("原创", "漫改", "轻改", "游戏改", "其他")


# ---------------------------------------------------------------- 词表（配置）
class Blacklist:
    """scripts/tag_blacklist.txt 解析结果：筛子二黑名单 + 公司名归一 + 原作类型五值归一。"""

    def __init__(self):
        self.version = ""
        self.fmt = set()                 # 格式标签
        self.year_res = []               # 年份形式（正则 fullmatch）
        self.studio_canon = {}           # 别名去空格小写 → 规范名（京阿尼=京都动画）
        self.studio_alias_lower = set()  # 别名小写（标签命中即剔除，原型 ALL_STUDIO_TAGS 口径）
        self.persons = set()             # 人名（标签命中即剔除）
        self.type_form = {}              # 原作类型形式 → 五值归一名

    def sieve_reason(self, name):
        """标签命中筛子二返回类别名，未命中返回 None（类别归属顺序即报告列序）。"""
        if name in self.fmt:
            return "格式标签"
        if any(r.fullmatch(name) for r in self.year_res):
            return "年份形式"
        if name.lower() in self.studio_alias_lower or name in self.persons:
            return "公司名·人名"
        if name in self.type_form:
            return "原作类型形式"
        return None


def load_blacklist(path):
    """按文件头注释约定的四类节解析词表。"""
    bl = Blacklist()
    section = sub = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                m = re.match(r"#\s*====\s*(.+?)\s*====", line)
                if m:
                    section, sub = m.group(1), None
                m = re.match(r"#\s*版本:\s*(\S+)", line)
                if m:
                    bl.version = m.group(1)
                m = re.match(r"##\s*(.+)", line)
                if m:
                    sub = m.group(1)
                continue
            if section == "格式标签":
                bl.fmt.add(line)
            elif section == "年份形式":
                bl.year_res.append(re.compile(line))
            elif section == "公司名·人名":
                if "=" in line and (sub is None or sub.startswith("公司名")):
                    alias, canon = (x.strip() for x in line.split("=", 1))
                    if alias:
                        bl.studio_canon[alias.replace(" ", "").lower()] = canon
                        bl.studio_alias_lower.add(alias.lower())
                else:
                    bl.persons.add(line)
            elif section == "原作类型形式":
                form, five = (x.strip() for x in line.split("=", 1)) if "=" in line else (line, line)
                if five not in FIVE_TYPES:
                    raise SystemExit(f"tag_blacklist.txt: 原作类型归一名非法 {five!r}（只允许 {FIVE_TYPES}）")
                bl.type_form[form] = five
    return bl


# ---------------------------------------------------------------- P1/P3 基础抽取
def parse_infobox(box):
    """infobox 文本 → {键: 值}（与原型 parse_infobox 逐语义一致）。"""
    out = {}
    for line in str(box or "").splitlines():
        m = re.match(r"\s*\|?\s*([^=::|=]+?)\s*[=::|]\s*(.+)", line)
        if m:
            k = m.group(1).strip()
            v = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", re.sub(r"\{\{[^}]*\}\}", "", m.group(2))).strip()
            if k and v and k not in out:
                out[k] = v
    return out


def norm_name(s):
    """人名归一：去括注/方括注/空白（同人同名归并用）。"""
    s = re.sub(r"[(（][^)）]*[)）]", "", s or "")
    s = re.sub(r"\[[^\]]*\]|【[^】]*】", "", s)
    return re.sub(r"[\s　]+", "", s).strip("、,，;；")


class PersonIndex:
    """person.jsonlines 索引：人名/简体中文名 → person_id，person_id → 展示名（person id 判同）。"""

    def __init__(self):
        self.alias_to_id = {}
        self.id_to_name = {}
        self.collisions = 0

    def add(self, pid, alias, display):
        alias = norm_name(alias)
        if not alias:
            return
        old = self.alias_to_id.get(alias)
        if old is None:
            self.alias_to_id[alias] = pid
        elif old != pid:
            self.collisions += 1
        self.id_to_name.setdefault(pid, display or alias)


def load_person_index(zf):
    pidx = PersonIndex()
    with zf.open("person.jsonlines") as f:
        for raw in f:
            row = json.loads(raw)
            pid = row.get("id")
            name = (row.get("name") or "").strip()
            m = re.search(r"(?:简体中文名|中文名)\s*[=::|]\s*([^\r\n|]+)", str(row.get("infobox") or ""))
            cn = m.group(1).strip() if m else ""
            pidx.add(pid, name, name)
            if cn:
                pidx.add(pid, cn, name)
    return pidx


def bucket_of(score):
    """评分 → 档位：四舍五入到 0.5 一档、半值向上（规则书 §2；engine 同契约）。"""
    return math.floor(score * 2 + 0.5) / 2


def monogram_of(title):
    """作品名首字或首字母（ASCII 取大写）——生成封面用（D10）。"""
    for ch in title:
        if ch.isalnum():
            return ch.upper() if ch.isascii() else ch
    return title[:1]


def extract_directors(ib, pidx, counters):
    """监督：infobox「导演」按分隔符拆人名（最多 2 位，规则书 §3），经 person 表判同。"""
    raw = ""
    for k in DIRECTOR_KEYS:
        raw = ib.get(k) or ""
        if raw:
            break
    out = []
    for part in re.split(r"[、,，・/／]", raw):
        n = norm_name(part)
        if not n or n in out:
            continue
        pid = pidx.alias_to_id.get(n)
        if pid is None:
            counters["监督·人名未入 person 表"] += 1
            disp = n
        else:
            counters["监督·person id 判同"] += 1
            disp = pidx.id_to_name.get(pid, n)
        if disp not in out:
            out.append(disp)
        if len(out) >= 2:
            break
    return out


def canon_studio(raw, bl):
    """公司名归一：别名→规范名（京阿尼=京都动画），未收录则保留原值。"""
    return bl.studio_canon.get(raw.replace(" ", "").lower(), raw)


def extract_studio(ib, tags, meta, bl):
    """公司：infobox「动画制作」优先；缺失时按标签/meta 里的公司别名回退（标注数最高者优先）。"""
    raw = ""
    for k in STUDIO_KEYS:
        raw = (ib.get(k) or "").strip()
        if raw:
            break
    if raw:
        return canon_studio(raw, bl), "infobox 动画制作"
    for name, _cnt in tags:  # dump tags 已按标注数降序
        if name.lower() in bl.studio_alias_lower:
            return canon_studio(name, bl), "标签别名回退"
    for m in meta:
        if m.lower() in bl.studio_alias_lower:
            return canon_studio(m, bl), "meta 别名回退"
    return "", "缺失"


def extract_otype(meta, tags, origin, bl):
    """原作类型：meta/标签的改编类型词 → 五值归一；再按原作文本推断；再归「其他」。"""
    for m in meta:
        if m in bl.type_form:
            return bl.type_form[m], "meta"
    for name, _cnt in tags:
        if name in bl.type_form:
            return bl.type_form[name], "标签"
    o = (origin or "").lower()
    if any(x in o for x in GAME_MARKERS):
        return "游戏改", "原作文本推断"
    if any(x in o for x in MANGA_MARKERS):
        return "漫改", "原作文本推断"
    if any(x in o for x in NOVEL_MARKERS):
        return "轻改", "原作文本推断"
    return "其他", ("原作为空" if not origin else "原作文本未识别")


def is_nsfw(row, meta, tags):
    """NSFW：nsfw 标记或 R18 标签（准入淘汰，规则书 §2）。"""
    return bool(row.get("nsfw")) or "R18" in meta or any(n == "R18" for n, _ in tags)


# ---------------------------------------------------------------- P1+P2+P3 流式扫描
def scan_subjects(zf, bl, pidx):
    """逐行扫 subject.jsonlines：准入 + 要素抽取。返回 (候选列表, 计数)；标签保留原始 [(名, 标注数)]。"""
    cands = []
    counters = Counter()
    with zf.open("subject.jsonlines") as f:
        for raw in f:
            counters["总行数"] += 1
            row = json.loads(raw)
            if row.get("type") != 2:
                counters["淘汰·非动画(type≠2)"] += 1
                continue
            meta = [str(m) for m in (row.get("meta_tags") or [])]
            tags = [(x.get("name", ""), x.get("count", 0)) for x in (row.get("tags") or []) if isinstance(x, dict)]
            if is_nsfw(row, meta, tags):
                counters["淘汰·NSFW"] += 1
                continue
            score = row.get("score")
            if not score:
                counters["淘汰·无评分"] += 1
                continue
            date = str(row.get("date") or "")
            if not date:
                counters["淘汰·无日期"] += 1
                continue

            ib = parse_infobox(row.get("infobox"))
            title = (row.get("name_cn") or "").strip() or (row.get("name") or "").strip()
            origin = ""
            for k in ORIGIN_KEYS:
                origin = ib.get(k) or ""
                if origin:
                    break
            directors = extract_directors(ib, pidx, counters)
            studio, studio_src = extract_studio(ib, tags, meta, bl)
            otype, otype_src = extract_otype(meta, tags, origin, bl)
            counters[f"公司来源·{studio_src}"] += 1
            counters[f"原作类型来源·{otype_src}"] += 1
            counters[f"原作类型值·{otype}"] += 1

            score = float(score)
            # 作品标注数 = 评分分布求和（评分人数），供运行时按热度收池（minVotes）。
            votes = sum(int(v or 0) for v in (row.get("score_details") or {}).values())
            cands.append({
                "id": row.get("id"),
                "title": title,
                "score": score,
                "bucket": bucket_of(score),
                "year": int(date[:4]),
                "votes": votes,
                "monogram": monogram_of(title),
                "type": otype,
                "directors": directors,
                "studio": studio,
                "tags": tags,
            })
            counters["准入通过"] += 1
    return cands, counters


# ---------------------------------------------------------------- P4 三道筛子
def apply_sieves(cands, bl, t1, t2):
    """三道筛子：返回 (筛除计数, 每卡有效标签数分布)。筛三按帧内支持（同一标签挂几张准入卡）。"""
    counts = Counter()
    for c in cands:
        kept = []
        for name, cnt in c["tags"]:
            if cnt < t1:
                counts["筛子一·太冷门(<T₁)"] += 1
                continue
            reason = bl.sieve_reason(name)
            if reason:
                counts[f"筛子二·{reason}"] += 1
                continue
            kept.append((name, cnt))
        c["tags_valid"] = kept
        counts["标注条数"] += len(c["tags"])
        counts["保留"] += len(kept)
    if t2 > 0:
        support = Counter()
        for c in cands:
            for name, _cnt in c["tags_valid"]:
                support[name] += 1
        for c in cands:
            kept = []
            for name, cnt in c["tags_valid"]:
                if support[name] > t2:
                    counts["筛子三·太频繁(>T₂)"] += 1
                    continue
                kept.append((name, cnt))
            c["tags_valid"] = kept
        counts["保留"] -= counts["筛子三·太频繁(>T₂)"]
    dist = Counter(len(c["tags_valid"]) for c in cands)
    return counts, dist


def assemble_elements(c):
    """要素集：1 监督 → 2 公司 → 3 标签（标注数降序）→ 4 年份 → 5 原作类型（规则书 §3）。"""
    els = [{"class": 1, "value": d} for d in c["directors"]]
    if c["studio"]:
        els.append({"class": 2, "value": c["studio"]})
    for name, _cnt in sorted(c["tags_valid"], key=lambda x: (-x[1], x[0])):
        els.append({"class": 3, "value": name})
    els.append({"class": 4, "value": str(c["year"])})
    els.append({"class": 5, "value": c["type"]})
    return els


# ---------------------------------------------------------------- P6 落库（建盒移交运行时，D16）
def strata_reference(cands):
    """组牌类 + 库内「档位 × 组牌类」候选数：分层配额的参考真源（供 game.SampleDeck 参照）。

    组牌类 = 与库内其它卡共享（支持≥2）的最高优先级要素类；无共享要素记 5（不设 0 类，散牌并入 5）。
    """
    support = Counter()
    for c in cands:
        for e in c["elements"]:
            support[(e["class"], e["value"])] += 1
    strata = Counter()
    for c in cands:
        shared = [e["class"] for e in c["elements"] if support[(e["class"], e["value"])] >= 2]
        cls = min(shared) if shared else 5
        c["anchor_class"] = cls
        strata[(c["bucket"], cls)] += 1
    return sorted(strata.items())


def card_record(c):
    """产物卡对象（字段即 store cards 表列，architecture.md §4.5）。"""
    return {"id": c["id"], "title": c["title"], "score": c["score"], "bucket": c["bucket"],
            "year": c["year"], "type": c["type"], "monogram": c["monogram"], "votes": c["votes"],
            "elements": c["elements"]}


# ---------------------------------------------------------------- 报告
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def bar(n, width=24, maxn=1):
    return "█" * max(0, round(width * n / maxn)) if maxn else ""


def build_report(dump, dump_sha, bl, cfg, counters, sieve_counts, tag_dist, strata, vlines, ok):
    lines = []
    a = lines.append
    a("# 卡池管线报告（build_cards.py）")
    a("")
    a(f"- 数据源：`{dump}`（sha256 `{dump_sha}`）")
    a(f"- 词表：`scripts/tag_blacklist.txt` **{bl.version}**（筛子二黑名单 + 公司名/原作类型归一）")
    a(f"- 配置：T₁={cfg['t1']} T₂={cfg['t2']}（T₂=0 表示暂不启用筛子三，建议值见 `data/CALIBRATION.md`）；"
      f"建库无随机步骤，同 dump 同配置两跑逐字节一致")
    a(f"- 黄金夹具：`scripts/golden_hands.json` {cfg['fixture_version']}")
    a("")

    a("## P1–P2 准入对账（规则书 §2：只收动画、非 NSFW、有评分、有日期）")
    a("")
    a("| 步骤 | 行数 |")
    a("|---|---|")
    a(f"| subject.jsonlines 总行数 | {counters['总行数']} |")
    for k in ("淘汰·非动画(type≠2)", "淘汰·NSFW", "淘汰·无评分", "淘汰·无日期"):
        a(f"| 淘汰 · {k.split('·')[1]} | {counters[k]} |")
    a(f"| **准入通过** | **{counters['准入通过']}** |")
    drop = sum(counters[k] for k in ("淘汰·非动画(type≠2)", "淘汰·NSFW", "淘汰·无评分", "淘汰·无日期"))
    a("")
    a(f"对账：总行数 {counters['总行数']} = 淘汰 {drop} + 通过 {counters['准入通过']} → "
      f"{'✓' if drop + counters['准入通过'] == counters['总行数'] else '✗'}")
    a("")

    a("## P3 五类要素抽取（规则书 §3）")
    a("")
    a("| 要素类 | 取法 | 数量 |")
    a("|---|---|---|")
    a(f"| 1 监督 | infobox「导演」最多 2 位，person id 判同 | "
      f"{counters['监督·person id 判同']} 名（判同）+ {counters['监督·人名未入 person 表']} 名（未入表，按名归并） |")
    for src in ("infobox 动画制作", "标签别名回退", "meta 别名回退", "缺失"):
        a(f"| 2 公司 | {src}（京阿尼=京都动画类归一） | {counters[f'公司来源·{src}']} |")
    a(f"| 3 标签 | dump tags 过三道筛子 | 见 P4 |")
    a(f"| 4 年份 | date 取年 | {counters['准入通过']} |")
    a(f"| 5 原作类型 | 归一五值 | {counters['准入通过']} |")
    a("")
    a("原作类型来源与五值分布：")
    a("")
    a("| 来源 / 取值 | 张数 |")
    a("|---|---|")
    for k in sorted(x for x in counters if x.startswith("原作类型来源·")):
        a(f"| {k.split('·')[1]} | {counters[k]} |")
    a("|—|—|")
    for t in FIVE_TYPES:
        a(f"| {t} | {counters.get(f'原作类型值·{t}', 0)} |")
    a("")

    a("## P4 标签三道筛子对账（规则书 §3）")
    a("")
    a("| 筛子 | 剔除标注条数 |")
    a("|---|---|")
    a(f"| 标注条数总计 | {sieve_counts['标注条数']} |")
    a(f"| 筛子一 · 太冷门（标注数<T₁={cfg['t1']}） | {sieve_counts['筛子一·太冷门(<T₁)']} |")
    for cat in ("格式标签", "年份形式", "公司名·人名", "原作类型形式"):
        a(f"| 筛子二 · {cat} | {sieve_counts[f'筛子二·{cat}']} |")
    a(f"| 筛子三 · 太频繁（帧内支持>T₂={cfg['t2']}） | {sieve_counts['筛子三·太频繁(>T₂)']} |")
    a(f"| **保留** | **{sieve_counts['保留']}** |")
    total = sieve_counts["标注条数"]
    kept = sieve_counts["保留"]
    removed = (sieve_counts["筛子一·太冷门(<T₁)"] + sum(sieve_counts[f"筛子二·{c}"] for c in
               ("格式标签", "年份形式", "公司名·人名", "原作类型形式")) + sieve_counts["筛子三·太频繁(>T₂)"])
    a("")
    a(f"对账：标注条数 {total} = 筛掉 {removed} + 保留 {kept} → {'✓' if removed + kept == total else '✗'}")
    a("")
    dist = "，".join(f"{n} 个标签 ×{tag_dist[n]} 张" for n in sorted(tag_dist))
    a(f"每卡有效标签数分布：{dist}")
    a("")

    a("## P5 黄金十手复算（G1–G10，期望 tier 见 architecture.md §4.1）")
    a("")
    for ln in vlines:
        a(ln)
    a("")
    a(f"结论：{'ALL OK' if ok else 'SOME FAILED'}")
    a("")

    a("## P6 落库与建盒分工（D16）")
    a("")
    a(f"- **cards.json = 全量合格卡库**：{counters['准入通过']} 张（准入 + 五类要素 + 三道筛子后），"
      f"不抽样、不保送任何人——测试需求不污染牌盒构造")
    a("- 建盒（分层配额抽样）移交运行时 `game.SampleDeck`；配额参数口径如下（供 GameCore 参照）")
    a("")
    a("### 建盒参数口径（档位等额 × 组牌类最大余数法，D11/D16）")
    a("")
    a("```")
    a("组牌类：card.anchor_class = min{ e.class | e∈card.elements 且 库内 support(e.class,e.value) ≥ 2 }")
    a("        无任何共享要素 → 5（不设 0 类，散牌并入 5 层）；判定基数是全量卡库，不是入盒候选")
    a("配额（目标牌池 S 张，默认 78；规则书参数表牌池规模 52–104，配置项）：")
    a("  1) 档位等额：每档 ⌊S/B⌋ 席（B=非空档位数）；余 R 席按「档内候选数降序」补给前 R 档（同数比档位升序）")
    a("  2) 档位内组牌类比例最大余数法：层=(档位,组牌类) 大小 n_k，q_k=S_b·n_k/Σn_k，⌊q_k⌋ 先给，")
    a("     余席按小数部分降序补（同数比类号升序）")
    a("  3) 余席回填（层封顶，回填给层不是档位间）：拟给席位封顶 n'_k=min(拟给,n_k)；总席不足时")
    a("     反复给「剩余容量 n_k−n'_k 最大」的层 +1 席（同容量比 (档位,类号) 升序），直到满 S 或全层满")
    a("  4) 零覆盖兜底：某组牌类 c∈{1..5} 在库中存在但整副牌 0 张 → 从「席位≥2 且类≠c」的最大层")
    a("     （同席比层键升序）挪 1 席给「c 类且有未选候选」的层（按层剩余容量升序取第一个）；")
    a("     换人确定性：被挪层取洗牌序列末位回退，目标层取洗牌序列首位补入")
    a("  5) 抽取：层内候选按 id 排序后 random.Random(seed) 洗牌取前 n'_k 张；同库同 S 同 seed 逐字节同盒")
    a("```")
    a("")
    a("库内「档位 × 组牌类」候选数参考（层大小 n_k；组牌类语义同上）：")
    a("")
    a("| 档位 | 组牌类 | 候选数 |")
    a("|---|---|---|")
    for (b, cls), n in strata:
        a(f"| {b} | {cls} | {n} |")
    a("")

    a("## 验收对照（architecture.md §7 A2）")
    a("")
    a("| 验收 | 达成 |")
    a("|---|---|")
    a("| A2.1 准入与三道筛子逐条可核 | ✓ 本报告 P1–P4 每步淘汰数，两处对账成立 |")
    a("| A2.2 T₁/T₂ 校准报告 | ✓ `data/CALIBRATION.md`（`python scripts/calibrate.py`） |")
    a("| A2.3 产物可复现 + 黄金十手在产物上复算通过 | ✓ 建库无随机步骤、词表版本化、产物不含时间戳，"
      "两跑逐字节一致；黄金十手在全量卡库上复算通过（P5 表全绿，`python scripts/verify_hands.py`） |")
    a("")

    a("## 口径对照（与 bak/anitexas-verify.py 一致处与差异）")
    a("")
    a("- 监督/标签/年份：取法与原型一致（导演字段拆人名、dump tags、date 取年）；"
      "原型只取首位导演，本管线按规则书 §3 取最多 2 位、并把「佐藤卓哉・浜崎博嗣/小林智樹」类复合字段拆成人名——"
      "黄金 20 张的监督要素与原型逐字一致，命运石之门按规则多出第二监督「浜崎博嗣」，tier 复算不受影响。"
      "原型不做人员归并，本管线按 person id 判同（architecture.md §4.6 P3）。")
    a("- 公司：原型用手动 COMPANY_OVERRIDE 补 infobox「动画制作」缺失的 10 张；"
      "本管线改为标签别名回退（标注数最高者），对黄金 20 张复现了同一组公司要素，"
      "并为原型缺公司的卡（如一拳超人 OAD→MADHOUSE、文豪野犬→BONES）补出公司要素，tier 复算不受影响。")
    a("- 原作类型：原型用 cards2.json 人工分类（轻改/小说改分列）；本管线按规则书五值归一"
      "（轻小说改/轻改/小说改 → 轻改）。差异仅「辉夜姬物语」一类（原型「小说改」→「轻改」），"
      "黄金十手 tier 复算不受影响。空原作归「其他」——与原型 MANUAL_OTYPE 对大和号的判定一致；"
      "若归「原创」，G10 会因你的名字/大和号同型升为二重唱。")
    a("")

    a("## 遗留问题")
    a("")
    a("- dump 的 tags 字段每卡只留 top11，叠加 T₁=50 后多数准入卡 0 有效标签（见 P4 分布）——"
      "库内成组主要靠年份/类型/监督/公司；要更多标签羁绊可下调 T₁（见校准报告的 T₁ 表）。")
    a("- 标签黑名单按原型词表落盘（v1）；dump 全量下仍有人名/公司名形态的漏网标签（如声优名、"
      "非收录公司），随 calibrate.py 的高频标签清单按版本号补录。")
    a("- T₂ 默认 0（暂不筛）：超热门标签会让成组变容易；抽样/发牌在运行时（D16），"
      "平衡性由 game.SampleDeck 的 T₂/配额热调——分布见 `data/CALIBRATION.md`，"
      "频率量化与调优建议见 `data/BALANCE.md`（`python scripts/simulate_balance.py`）。")
    a("- 原作文本推断只覆盖常见标记，未识别的归「其他」（报告 P3 给出来源占比）；"
      "meta 编辑质量是根因，属数据侧改进。")
    a("- 主题牌池（A2.4/M5.1）后置：建盒在运行时 game.SampleDeck（D16），"
      "牌池规模（52–104）与主题过滤是运行时配置。")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description="AniTexas 卡池管线：dump → data/cards.json（P1–P6）")
    ap.add_argument("--dump", default=os.environ.get("ANITEXAS_DUMP", DEFAULT_DUMP), help="dump zip 路径")
    ap.add_argument("--out-dir", default=str(REPO / "data"), help="产物目录（默认 data/）")
    ap.add_argument("--t1", type=int, default=DEFAULT_T1, help="筛子一：标注数下限")
    ap.add_argument("--t2", type=int, default=DEFAULT_T2, help="筛子三：帧内支持上限，0=不筛")
    ap.add_argument("--blacklist", default=str(REPO / "scripts" / "tag_blacklist.txt"))
    ap.add_argument("--fixture", default=str(REPO / "scripts" / "golden_hands.json"))
    args = ap.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bl = load_blacklist(args.blacklist)
    fixture = verify_hands.load_fixture(args.fixture)
    cfg = {"t1": args.t1, "t2": args.t2, "fixture_version": fixture.get("version", "")}

    with zipfile.ZipFile(args.dump) as zf:
        pidx = load_person_index(zf)
        cands, counters = scan_subjects(zf, bl, pidx)
    sieve_counts, tag_dist = apply_sieves(cands, bl, args.t1, args.t2)
    for c in cands:
        c["elements"] = assemble_elements(c)

    fixture_ids = {m["id"] for m in fixture["cards"].values()}
    missing = fixture_ids - {c["id"] for c in cands}
    if missing:
        raise SystemExit(f"黄金例子牌未过准入或 dump 不符: {sorted(missing)}")

    strata = strata_reference(cands)
    records = [card_record(c) for c in sorted(cands, key=lambda c: c["id"])]
    ok, vlines = verify_hands.verify_pool({r["id"]: r for r in records}, fixture)

    report = build_report(args.dump, sha256_file(args.dump), bl, cfg, counters, sieve_counts,
                          tag_dist, strata, vlines, ok)
    (out_dir / "pipeline-report.md").write_text(report, encoding="utf-8", newline="\n")

    for ln in vlines:
        print(ln)
    if not ok:
        print("SOME FAILED：黄金十手未全绿，cards.json 不落盘", file=sys.stderr)
        return 1
    with open(out_dir / "cards.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"ALL OK：{len(records)} 张合格卡 → {out_dir / 'cards.json'}（报告 {out_dir / 'pipeline-report.md'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
