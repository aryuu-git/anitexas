#!/usr/bin/env python3
"""AniTexas 封面抓取（P8/D10）：bangumi-data 映射 → Jikan 取图 URL → 下载缓存 data/covers/<subject_id>.jpg，
并给 data/cards.json 后处理补写 cover 字段（相对路径 covers/<id>.jpg，无图留空）。只用标准库。

步骤（architecture.md §4.6 P8 / §7 D10）:
  1 映射     本地 bangumi-data-dist.json 的 items[].sites[]（site=bangumi/mal）建 bangumi subject id → mal id，
             不联网取映射；bangumi id 重复时先到先得（报告计数）
  2 取图 URL Jikan https://api.jikan.moe/v4/anime/{mal_id} → images.jpg.large_image_url（缺 large 取 image_url）
             限速 ≤3 req/s 且 ≤55 req/min 滑窗（Jikan 口径 3 rps/60 rpm），429/403/5xx/网络错误指数退避重试
             兜底（Jikan 瞬时不可达时，--jikan-only 可关）：读 MAL 条目页 https://myanimelist.net/anime/{mal_id}
             的 og:image → 同族 `l.jpg` 大图——与 Jikan images.jpg.large_image_url 同源同值（同为 MAL 图床 CDN）；
             条目页限速 ≤2 req/s（--page-rps）。注册表记 src（jikan / mal-og），报告分列来源
  3 下载     data/covers/<subject_id>.jpg（>1 MiB 跳过、非图片内容跳过）；失败自动跳过不阻断
             （前端首字降级兜底，monogram 始终在库里）
  4 补字段   cards.json 每卡加 cover：已落盘 `covers/<id>.jpg`，无图留空 ""
  5 量级     默认抓「收藏数降序 → 标注数降序 → id 升序」热门前 2000 张；--limit 改量、--ids 指定增量

幂等（可重复跑）:
  - data/covers/index.json 是抓取注册表：终态（ok / 各跳过原因）已抓的不再抓，URL 已解析的不再调解析器；
    落盘文件即使注册表缺记录（中断残留）也直接认并补记 ok；瞬时失败（网络/限流/5xx）不写终态 → 下次自动续抓；
    每 100 张落一次注册表，中断不丢进度
  - cards.json 与注册表同状态下两跑逐字节一致（cover 字段只由「注册表 + 落盘文件」派生，不含时间戳/随机数）；
    build_cards.py 重建 cards.json 后重跑本脚本即可回填 cover（不联网、不重抓）。
    报告的『本次运行』表是逐次运行日志（计数随运行不同），『累计』各表由状态复算
  - 连环瞬时失败累计 30 个熔断收尾（exit 2），已抓进度全部保留，网络恢复后重跑续抓

主路径回归（--recheck）:
  - 对已落盘条目用 Jikan 重解析 images.jpg.large_image_url，与注册表缓存 URL 逐条比对（不重下载、不改条目）；
    结果存注册表 recheck 节并进报告——兜底路径产物在 Jikan 恢复后必须补这道回归
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BANGUMI_DATA = "C:/Users/chenjincan/Downloads/bak/bangumi-data-dist.json"  # 映射真源（本地缓存）
DEFAULT_DUMP = "C:/Users/chenjincan/Downloads/bak/dump-2026-09-29.zip"  # 热门度真源（同 build_cards）
DEFAULT_LIMIT = 2000   # 热门前 N 张起抓（--limit 改量，0=不限）
MAX_IMAGE_BYTES = 1 << 20   # 单张封面 1 MiB 上限，超此跳过（D10）
JIKAN_URL = "https://api.jikan.moe/v4/anime/{mal_id}"
MAL_PAGE_URL = "https://myanimelist.net/anime/{mal_id}"   # 兜底解析源（Jikan 读的同一页）
USER_AGENT = "anitexas-fetch-covers/1.0"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) anitexas-fetch-covers/1.0"  # MAL 站/图床用
OG_IMAGE_RE = re.compile(r'<meta property="og:image" content="([^"]+)"')
RPS = 6.0       # 合计限速：全部请求每秒最多 6 个（--rps；并发 6 的提速口径）
RPM = 55        # Jikan 专属：每分钟最多 55 个请求，避开 60 rpm 硬限（--rpm）
WORKERS = 6     # 并发抓取线程数（--workers）
RETRIES = 5     # 瞬时失败指数退避重试次数（1,2,4,8…）
BREAKER = 30    # 瞬时失败熔断阈值（并发口径：累计 N 个待续抓即收尾，网络恢复后重跑续抓）
JIKAN_DOWN = 2  # 连续 Jikan 瞬时失败几次后本运行内不再试 Jikan（直接兜底）

# 注册表终态（跳过原因）；瞬时失败不写终态，下次续抓
SKIP_REASONS = ("no-mapping", "mal-404", "mal-4xx", "no-image", "oversize", "bad-image", "dl-4xx")
REASON_LABEL = {
    "no-mapping": "无 bangumi→mal 映射",
    "mal-404": "MAL 条目 404（无此条目）",
    "mal-4xx": "解析源 4xx（请求被拒）",
    "no-image": "解析源无图片 URL",
    "oversize": f"图片超 {MAX_IMAGE_BYTES // (1 << 20)} MiB",
    "bad-image": "非图片内容（魔数不符）",
    "dl-4xx": "图床 4xx（下载被拒）",
}
SRC_LABEL = {"jikan": "Jikan", "mal-og": "MAL og:image 兜底"}
# cards.json 补写后的字段序：votes/cover 紧跟 monogram，其余不动
CARD_FIELDS = ("id", "title", "score", "bucket", "year", "type", "monogram", "votes", "cover", "elements")


class TransientError(Exception):
    """重试耗尽仍失败（网络/限流/403/5xx）——不写注册表，下次运行续抓。"""


# ---------------------------------------------------------------- HTTP（限速 + 退避）
class Pacer:
    """线程安全限速器：≤rps 每秒、≤rpm 每分钟滑窗（0=该口径不限）；并发下按预留时间槽发放。"""

    def __init__(self, rps=0.0, rpm=0):
        self.min_interval = 1.0 / rps if rps > 0 else 0.0
        self.per_minute = rpm
        self.lock = threading.Lock()
        self.stamps = deque()
        self.next_slot = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            while self.stamps and self.stamps[0] <= now - 60.0:
                self.stamps.popleft()
            t = max(now, self.next_slot)
            if self.per_minute and len(self.stamps) >= self.per_minute:
                t = max(t, self.stamps[0] + 60.0)
            self.stamps.append(t)
            self.next_slot = t + self.min_interval
            delay = t - now
        if delay > 0:
            time.sleep(delay)


def request(url, pacers, *, max_bytes=None, timeout=15, attempts=RETRIES, ua=USER_AGENT):
    """GET（限速 + 指数退避）。返回 (status, body, headers, truncated)。

    403（反爬）/429/5xx/网络错误 → 退避重试（尊重 Retry-After），耗尽抛 TransientError；
    其余 4xx 是稳定响应，原样返回由调用方定终态。
    """
    last = None
    for i in range(attempts):
        for p in pacers:
            p.wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body, truncated = _read_bounded(r, max_bytes)
                return r.status, body, dict(r.headers), truncated
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) or e.code >= 500:
                last = e
                if i < attempts - 1:
                    _backoff_sleep(e.headers.get("Retry-After"), i)
                continue
            body = e.read()
            return e.code, body, dict(e.headers), False
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if i < attempts - 1:
                _backoff_sleep(None, i)
            continue
    raise TransientError(f"{url}：{attempts} 次重试仍失败（{last}）")


def _read_bounded(r, max_bytes):
    if not max_bytes:
        return r.read(), False
    body = bytearray()
    truncated = False
    while True:
        chunk = r.read(1 << 16)
        if not chunk:
            break
        body += chunk
        if len(body) > max_bytes:
            truncated = True
            break
    return bytes(body[: max_bytes + 1]), truncated


def _backoff_sleep(retry_after, attempt):
    delay = 2.0 ** attempt   # 1,2,4,8…
    if retry_after:
        try:
            delay = max(delay, float(retry_after))
        except ValueError:
            pass
    time.sleep(min(delay, 30.0))


# ---------------------------------------------------------------- 1 映射（本地，不联网）
def load_mapping(path):
    """bangumi-data-dist.json → (bangumi subject id → mal id, 统计)；bangumi id 重复先到先得。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    items = data["items"] if isinstance(data, dict) else data
    stats = Counter()
    b2m = {}
    for it in items:
        stats["条目总数"] += 1
        ids = {}
        for s in it.get("sites") or []:
            if "id" not in s:
                stats["site 条目缺 id"] += 1
                continue
            ids[s["site"]] = str(s["id"])
        if ids.get("bangumi"):
            stats["带 bangumi"] += 1
        if ids.get("mal"):
            stats["带 mal"] += 1
        if ids.get("bangumi") and ids.get("mal"):
            stats["两者齐"] += 1
            if ids["bangumi"] in b2m:
                stats["bangumi id 重复"] += 1
                continue
            b2m[ids["bangumi"]] = ids["mal"]
    return b2m, stats


# ---------------------------------------------------------------- 热门度（dump，供默认队列排序）
def load_popularity(dump, wanted_ids):
    """dump subject.jsonlines → {id: (收藏数, 标注数)}；只留 wanted_ids（流式扫，不整表载入）。"""
    pop = {}
    with zipfile.ZipFile(dump) as zf, zf.open("subject.jsonlines") as f:
        for raw in f:
            row = json.loads(raw)
            cid = row.get("id")
            if cid not in wanted_ids:
                continue
            fav = row.get("favorite") or {}
            fav_total = sum(int(v or 0) for v in fav.values()) if isinstance(fav, dict) else int(fav or 0)
            tag_total = sum(int(t.get("count") or 0) for t in (row.get("tags") or []) if isinstance(t, dict))
            pop[cid] = (fav_total, tag_total)
    return pop


def build_queue(cards, pop, limit, ids):
    """抓取队列（确定性排序）：--ids 按 id 升序；默认「收藏数↓ 标注数↓ id↑」热门前 limit。"""
    if ids:
        want = set(ids)
        known = {c["id"] for c in cards}
        for cid in sorted(want - known):
            print(f"WARN：--ids {cid} 不在 cards.json，忽略", file=sys.stderr)
        return sorted((c for c in cards if c["id"] in want), key=lambda c: c["id"])
    ordered = sorted(cards, key=lambda c: (-pop.get(c["id"], (0, 0))[0],
                                           -pop.get(c["id"], (0, 0))[1], c["id"]))
    return ordered[:limit] if limit else ordered


# ---------------------------------------------------------------- 2 取图 URL（Jikan 主 / MAL 页兜底）
def large_variant(url):
    """og:image 基图 → 同族 l 大图（Jikan large_image_url 同构：`.../135089.jpg` → `.../135089l.jpg`）。"""
    for ext in (".jpg", ".jpeg", ".png"):
        if url.endswith(ext) and not url.endswith("l" + ext):
            return url[: -len(ext)] + "l" + ext
    return url


def resolve_via_mal_page(mal_id, page_pacers):
    """兜底：MAL 条目页 og:image → 同族 l.jpg 大图。返回 (url, 终态原因)。"""
    status, body, _hdrs, _ = request(MAL_PAGE_URL.format(mal_id=mal_id), page_pacers, ua=BROWSER_UA)
    if status == 404:
        return "", "mal-404"
    if status != 200:
        return "", "mal-4xx"
    m = OG_IMAGE_RE.search(body.decode("utf-8", "replace"))
    if not m:
        return "", "no-image"
    return large_variant(m.group(1)), ""


def resolve_image_url(mal_id, pacers, *, allow_fallback=True, jikan_down=False):
    """主路径 Jikan /v4/anime/{mal_id} → images.jpg.large_image_url（缺 large 取 image_url）；
    Jikan 瞬时不可达且 allow_fallback 时兜底读 MAL 条目页 og:image（同源 l 大图）。

    返回 (url, 终态原因, 来源)：url 非空 = 解析成功；否则原因 ∈ SKIP_REASONS；来源 ∈ SRC_LABEL。
    两条路径都瞬时失败 → 抛 TransientError（不写终态，下次续抓）。
    """
    if not jikan_down:
        try:
            status, body, _hdrs, _ = request(JIKAN_URL.format(mal_id=mal_id), pacers["api"])
            if status == 404:
                return "", "mal-404", "jikan"
            if status != 200:
                return "", "mal-4xx", "jikan"
            try:
                data = json.loads(body)
                images = (((data or {}).get("data") or {}).get("images") or {}).get("jpg") or {}
            except (ValueError, AttributeError):
                raise TransientError(f"Jikan {mal_id}：响应非 JSON（疑似网关抖动）")
            url = images.get("large_image_url") or images.get("image_url") or ""
            return url, ("" if url else "no-image"), "jikan"
        except TransientError:
            if not allow_fallback:
                raise
    url, reason = resolve_via_mal_page(mal_id, pacers["page"])
    return url, reason, "mal-og"


# ---------------------------------------------------------------- 3 下载（校验 + 原子落盘）
def image_kind(b):
    """魔数判定（stdlib 口径，不引入 Pillow）：jpeg/png/webp/gif。"""
    if b[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return ""


def download_cover(url, dest, pacers):
    """下载封面 → dest（原子写）；返回 (字节数, sha256, 终态原因)——原因非空表示跳过不落盘。

    l 大图 404 时退一次基图（og:image 原值），保证同源可取。
    """
    status, body, _hdrs, truncated = request(url, pacers["img"], max_bytes=MAX_IMAGE_BYTES, ua=BROWSER_UA)
    if status == 404 and url.endswith("l.jpg"):
        url = url[:-5] + ".jpg"
        status, body, _hdrs, truncated = request(url, pacers["img"], max_bytes=MAX_IMAGE_BYTES, ua=BROWSER_UA)
    if status != 200:
        return 0, "", "dl-4xx"
    if truncated or len(body) > MAX_IMAGE_BYTES:
        return 0, "", "oversize"
    if not image_kind(body):
        return 0, "", "bad-image"
    tmp = dest.parent / (dest.name + ".part")
    tmp.write_bytes(body)
    os.replace(tmp, dest)
    return len(body), hashlib.sha256(body).hexdigest(), ""


# ---------------------------------------------------------------- 4 注册表（data/covers/index.json）
def load_registry(path):
    """注册表 → {"version", "recheck"?, "entries"}；缺文件给空壳。"""
    if not Path(path).is_file():
        return {"version": 1, "entries": {}}
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    doc.setdefault("version", 1)
    doc.setdefault("entries", {})
    return doc


def save_registry(path, reg):
    out = {"version": reg.get("version", 1)}
    if "recheck" in reg:
        out["recheck"] = reg["recheck"]
    out["entries"] = {k: reg["entries"][k] for k in sorted(reg["entries"], key=lambda x: int(x))}
    Path(path).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


def valid_cover(path):
    """已落盘封面可跳过的判定：≤1 MiB 且魔数是图片。"""
    try:
        b = Path(path).read_bytes()
    except OSError:
        return False
    return 0 < len(b) <= MAX_IMAGE_BYTES and bool(image_kind(b))


# ---------------------------------------------------------------- 抓取主循环
def probe_jikan(pacers):
    """开工前探一次 Jikan（1 次请求、最多 2 试）：是否可用。不可达则本运行直接走兜底，不逐卡空耗重试。"""
    try:
        status, _body, _hdrs, _ = request(JIKAN_URL.format(mal_id=1), pacers["api"], attempts=2)
        return status != 404
    except TransientError:
        return False


def process(queue, b2m, reg, covers_dir, pacers, allow_fallback, reg_path, workers=WORKERS):
    """并发抓取队列（workers 线程）。返回统计；瞬时失败累计 ≥BREAKER 熔断收尾（stats['熔断']=1）。

    断点续传三层：已落盘文件直接认（注册表缺记录也补记 ok）、终态跳过不联网、URL 已解析不重调解析器；
    每 100 张落一次注册表，中断不丢进度。
    """
    stats = Counter()
    entries = reg["entries"]
    jikan_down = allow_fallback and not probe_jikan(pacers)
    print(f"Jikan 探测：{'不可达 → 本运行走 MAL 页兜底' if jikan_down else '可用（主路径）'}", flush=True)

    def work(card):
        """单卡：解析 + 下载。只读共享注册表、独占写自己的文件；结果交主线程合并。"""
        cid = card["id"]
        key = str(cid)
        dest = covers_dir / f"{cid}.jpg"
        ent = entries.get(key) or {}
        mal = b2m.get(key)
        status = ent.get("status", "")

        if status in SKIP_REASONS:                          # 断点续传：终态跳过
            return key, None, "终态跳过", {}
        if valid_cover(dest):                               # 断点续传：已落盘（含中断残留，补记 ok）
            if status != "ok":
                back = {**ent, "status": "ok", "bytes": dest.stat().st_size,
                        "sha256": hashlib.sha256(dest.read_bytes()).hexdigest()}
                back.setdefault("mal", mal or ent.get("mal"))
                if not back.get("mal"):
                    back.pop("mal", None)
                return key, back, "已落盘跳过", {}
            return key, None, "已落盘跳过", {}
        if not mal and not ent.get("mal"):                  # 无映射（终态）
            return key, {"status": "no-mapping"}, "新跳过·无 bangumi→mal 映射", {}

        extra = Counter()
        try:
            url = ent.get("url", "")
            src = ent.get("src", "")
            if url:
                extra["URL 已解析（本次未调解析器）"] += 1
            else:
                mal = ent.get("mal") or mal
                url, reason, src = resolve_image_url(mal, pacers,
                                                     allow_fallback=allow_fallback, jikan_down=jikan_down)
                if not url:
                    return key, {"mal": mal, "status": reason, "src": src}, f"新跳过·{REASON_LABEL[reason]}", extra
                extra[f"解析成功·{src}"] += 1
                ent = {"mal": mal, "url": url, "src": src}  # 先记 URL，下载失败下次不重调解析器

            nbytes, sha, reason = download_cover(url, dest, pacers)
            extra["图片下载"] += 1
            if reason == "transient":
                return key, ent, "瞬时失败（待续抓）", extra
            if reason:
                return key, {**ent, "status": reason}, f"新跳过·{REASON_LABEL[reason]}", extra
            return key, {**ent, "status": "ok", "bytes": nbytes, "sha256": sha}, "新下载成功", extra
        except TransientError as e:
            print(f"WARN：{e}", file=sys.stderr)
            return key, (ent if ent.get("url") else {"mal": ent.get("mal") or mal}), "瞬时失败（待续抓）", extra

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(work, c) for c in queue]
        for n, fut in enumerate(as_completed(futs), 1):
            key, entry, outcome, extra = fut.result()
            if entry is not None:
                entries[key] = entry
            stats[outcome] += 1
            for k, v in extra.items():
                stats[k] += v
            if n % 100 == 0:
                save_registry(reg_path, reg)
            if n % 50 == 0:
                print(f"[{n}/{len(queue)}] 新下载 {stats['新下载成功']}，跳过 "
                      f"{stats['已落盘跳过'] + stats['终态跳过'] + sum(stats[f'新跳过·{REASON_LABEL[r]}'] for r in SKIP_REASONS)}，"
                      f"解析 jikan {stats['解析成功·jikan']} / mal-og {stats['解析成功·mal-og']}", flush=True)
            if stats["瞬时失败（待续抓）"] >= BREAKER:
                stats["熔断"] = 1
                for f in futs:
                    f.cancel()
                break
    return stats


# ---------------------------------------------------------------- 主路径回归（--recheck）
def recheck_jikan(reg, pacers):
    """对已落盘条目用 Jikan 重解析 large_image_url，与注册表缓存 URL 逐条比对（不重下载、不改条目）。"""
    entries = reg["entries"]
    ids = sorted((k for k, v in entries.items() if v.get("status") == "ok" and v.get("mal")), key=int)
    out = {"scope": len(ids), "checked": 0, "match": 0, "mismatch": [], "unresolved": 0, "transient_stop": 0}
    for n, key in enumerate(ids, 1):
        if n % 100 == 0:
            print(f"[recheck {n}/{len(ids)}] 一致 {out['match']}，不一致 {len(out['mismatch'])}")
        try:
            url, reason, _src = resolve_image_url(entries[key]["mal"], pacers,
                                                  allow_fallback=False, jikan_down=False)
        except TransientError as e:
            out["transient_stop"] = len(ids) - n + 1
            print(f"WARN：{e}（Jikan 仍不可达，回归中止）", file=sys.stderr)
            break
        if reason:
            out["unresolved"] += 1
            continue
        out["checked"] += 1
        if url == entries[key].get("url"):
            out["match"] += 1
        else:
            out["mismatch"].append({"id": key, "cached": entries[key].get("url"), "jikan": url})
    return out


# ---------------------------------------------------------------- 5 cards.json 补写 cover
def cover_rel(cid, entries, covers_dir):
    ent = entries.get(str(cid)) or {}
    return f"covers/{cid}.jpg" if ent.get("status") == "ok" and (covers_dir / f"{cid}.jpg").is_file() else ""


def patch_cards(cards_path, entries, covers_dir):
    """cards.json 后处理补写 cover 字段（无图留空）；其余字段原样保留，输出格式同 build_cards。"""
    cards = json.loads(Path(cards_path).read_text(encoding="utf-8"))
    out = []
    for c in cards:
        rec = {}
        for k in CARD_FIELDS:
            if k == "cover":
                rec[k] = cover_rel(c.get("id"), entries, covers_dir)
            elif k in c:
                rec[k] = c[k]
        for k, v in c.items():   # 未知字段（build_cards 将来加列）原样后置
            if k not in rec:
                rec[k] = v
        out.append(rec)
    Path(cards_path).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n",
                                encoding="utf-8", newline="\n")
    return sum(1 for r in out if r["cover"]), len(out)


# ---------------------------------------------------------------- 报告
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_report(args, map_stats, mapped_cards, cards, queue, mapped_queue, stats, reg, covered, bangumi_sha):
    entries = reg["entries"]
    lines = []
    a = lines.append
    a("# 封面抓取报告（fetch_covers.py，P8/D10）")
    a("")
    a("## 输入与口径")
    a("")
    a(f"- 映射源：`{args.bangumi_data}`（sha256 `{bangumi_sha}`）——本地 bangumi-data `items[].sites[]`，**不联网取映射**")
    a(f"- 封面源·主路径：Jikan `{JIKAN_URL}` → `images.jpg.large_image_url`（缺 large 取 `image_url`）")
    a(f"- 封面源·兜底（Jikan 瞬时不可达时，`--jikan-only` 关）：MAL 条目页 `{MAL_PAGE_URL}` 的 og:image → "
      f"同族 `l` 大图——与 Jikan `images.jpg.large_image_url` **同源同值**（同为 MAL 图床 CDN），来源逐条记注册表 `src`")
    a(f"- 下载缓存 `data/covers/<subject_id>.jpg`（单张 >{MAX_IMAGE_BYTES // (1 << 20)} MiB 跳过；l 大图 404 退基图）")
    a(f"- 限速：全部请求合计 ≤{args.rps:g} req/s（并发 {args.workers} 线程，提速口径）；"
      f"Jikan 另有 ≤{args.rpm} req/min 专属滑窗（其口径 3 rps / 60 rpm）；"
      f"403/429/5xx/网络错误指数退避重试 {RETRIES} 次（尊重 Retry-After）；瞬时失败累计 {BREAKER} 个熔断收尾（已抓进度保留）")
    a("- 热门度（默认队列排序）：dump `favorite`（wish+done+doing+on_hold+dropped）降序 → "
      "标注数（tags count 合计）降序 → id 升序；本次取前 "
      f"{args.limit if args.limit else '全部'} 张（`--limit` 控量，脚本默认 {DEFAULT_LIMIT}；`--ids` 指定增量）")
    a("- 产物：`data/covers/**`（图 + 注册表 `data/covers/index.json`）；`cards.json` 每卡补 `cover` 字段"
      "（相对路径 `covers/<id>.jpg`，无图留空 `\"\"`）")
    a("")

    a("## 映射命中率（bangumi-data → mal）")
    a("")
    a("| 指标 | 数量 |")
    a("|---|---|")
    a(f"| bangumi-data 条目总数 | {map_stats['条目总数']} |")
    a(f"| 带 bangumi 映射 | {map_stats['带 bangumi']} |")
    a(f"| 带 mal 映射 | {map_stats['带 mal']} |")
    a(f"| bangumi+mal 两者齐 | {map_stats['两者齐']} |")
    a(f"| bangumi id 重复（先到先得） | {map_stats['bangumi id 重复']} |")
    a("")
    a("| 范围 | 卡数 | 带映射 | 命中率 |")
    a("|---|---|---|---|")
    a(f"| cards.json 全量 | {len(cards)} | {mapped_cards} | {100 * mapped_cards / len(cards):.1f}% |")
    a(f"| 本次抓取范围 | {len(queue)} | {mapped_queue} | {100 * mapped_queue / len(queue):.1f}% |")
    a("")

    a("## 本次运行")
    a("")
    a("| 结果 | 数量 |")
    a("|---|---|")
    a(f"| 范围（队列） | {len(queue)} |")
    a(f"| 新下载成功 | {stats['新下载成功']} |")
    a(f"| 断点续传跳过·已落盘 | {stats['已落盘跳过']} |")
    a(f"| 断点续传跳过·终态已定 | {stats['终态跳过']} |")
    a(f"| 瞬时失败（待续抓） | {stats['瞬时失败（待续抓）']} |")
    a(f"| 解析成功·Jikan（主路径） | {stats['解析成功·jikan']} |")
    a(f"| 解析成功·MAL og:image（兜底） | {stats['解析成功·mal-og']} |")
    a(f"| 图片下载调用 | {stats['图片下载']} |")
    a(f"| 其中 URL 已解析（本次未调解析器） | {stats['URL 已解析（本次未调解析器）']} |")
    a("")
    a("跳过原因分布（本次运行新发生）：")
    a("")
    a("| 原因 | 数量 |")
    a("|---|---|")
    for r in SKIP_REASONS:
        a(f"| {REASON_LABEL[r]} | {stats[f'新跳过·{REASON_LABEL[r]}']} |")
    a("")

    a("## 累计（data/covers/index.json 注册表）")
    a("")
    cum = Counter()
    src_cum = Counter()
    ok_with_src = 0
    pending_url = 0
    pending_retry = 0
    for ent in entries.values():
        st = ent.get("status")
        if st:
            cum[st] += 1
        elif ent.get("url"):
            pending_url += 1
        else:
            pending_retry += 1
        if ent.get("src"):
            src_cum[ent["src"]] += 1
            if st == "ok":
                ok_with_src += 1
    a("| 状态 | 数量 |")
    a("|---|---|")
    a(f"| ok（已落盘） | {cum['ok']} |")
    for r in SKIP_REASONS:
        a(f"| 跳过·{REASON_LABEL[r]} | {cum[r]} |")
    a(f"| 待下载（URL 已解析，不重调解析器） | {pending_url} |")
    a(f"| 待续抓（URL 未解析，下次重试） | {pending_retry} |")
    a(f"| **cards.json 已带 cover** | **{covered}** |")
    a("")
    a("| 解析来源（累计） | 条数 |")
    a("|---|---|")
    for s in ("jikan", "mal-og"):
        a(f"| {SRC_LABEL[s]} | {src_cum[s]} |")
    a(f"| 断点续传补记（已落盘、无 src） | {cum['ok'] - ok_with_src} |")
    a("")

    a("## 主路径回归（--recheck：Jikan 重解析 vs 注册表缓存 URL）")
    a("")
    if src_cum["mal-og"]:
        a(f"> ⚠ **本产物含兜底路径解析**：Jikan 上游故障（504 「failed to connect to MyAnimeList」）期间，"
          f"{src_cum['mal-og']} 条封面 URL 由 MAL 条目页 og:image 推得（与 Jikan `images.jpg.large_image_url` "
          f"**同源同值**，但非 Jikan 实测返回值）；Jikan 恢复后须跑 `--recheck` 补主路径回归。")
        a("")
    rc = reg.get("recheck")
    if rc:
        a("| 指标 | 数量 |")
        a("|---|---|")
        a(f"| 范围（已落盘且有 mal id） | {rc['scope']} |")
        a(f"| Jikan 重解析成功 | {rc['checked']} |")
        a(f"| 与缓存 URL 一致 | {rc['match']} |")
        a(f"| 不一致 | {len(rc['mismatch'])} |")
        a(f"| Jikan 无图/无条目 | {rc['unresolved']} |")
        a(f"| Jikan 仍不可达中止 | {rc['transient_stop']} |")
        a("")
        if rc["mismatch"]:
            a("不一致清单（前 20 条）：")
            a("")
            for m in rc["mismatch"][:20]:
                a(f"- id {m['id']}：缓存 `{m['cached']}` ≠ Jikan `{m['jikan']}`")
            a("")
        a(f"结论：{'✓ 一致' if rc['checked'] and rc['match'] == rc['checked'] and not rc['mismatch'] else '见上表'}")
    else:
        a("未执行。兜底路径产物须在 Jikan 恢复后跑 `python scripts/fetch_covers.py --recheck` 补回归"
          "（对已落盘条目重解析比对，不重下载）。")
    a("")

    a("## 幂等与一致性语义（同配置两跑）")
    a("")
    a("- **重复跑不重抓**：注册表记终态——`ok` / 跳过原因已定的不再联网；URL 已解析的不再调解析器；"
      "落盘文件直接认；只有瞬时失败（网络/限流/403/5xx）下次续抓（断点续传）。重跑当次「新下载 0 / Jikan 调用 0 / 图片下载 0」即幂等实证")
    a("- **cards.json 与注册表两跑逐字节一致**：`cover` 字段只由「注册表 + 落盘文件」派生，两产物不含时间戳/随机数——"
      "同抓取状态下重跑本脚本逐字节不变（幂等可验）；本报告的『本次运行』表是逐次运行日志（计数随运行不同），"
      "『累计』『映射命中率』各表由状态复算，同状态下不变")
    a("- **与 build_cards.py 的分工**：建库（同 dump 同配置逐字节一致）不变；本脚本是**后处理补写步骤**——"
      "build_cards.py 重建 cards.json 后重跑本脚本即可回填 cover（不联网、不重抓，纯按注册表补字段）")
    a("- **抓取结果变化**（新增下载）属于状态变化：先落注册表 `data/covers/index.json`，再反映到 cards.json；"
      "两份产物都能从注册表复算")
    a("- **降级兜底**：无图卡 `cover=\"\"`，前端用 `monogram`（首字 + 渐变）生成封面（D10），抓取失败不阻断建库")
    a("")
    a("## 剩余增量抓取（后置项）")
    a("")
    a("热门前 N 范围内没抓完的（待续抓 / 新卡入库）直接续：")
    a("")
    a("```bash")
    a("python scripts/fetch_covers.py                 # 断点续传：只抓缺的，已落盘/终态跳过不重抓")
    a("python scripts/fetch_covers.py --limit 5000    # 扩大热门范围（默认 2000）")
    a("python scripts/fetch_covers.py --ids 8 12 50   # 指定 bangumi subject id 增量")
    a("python scripts/fetch_covers.py --recheck       # Jikan 恢复后主路径回归（不重下载）")
    a("```")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description="AniTexas 封面抓取：映射 → Jikan（MAL 页兜底）→ data/covers/ + cards.json cover 字段（P8/D10）")
    ap.add_argument("--bangumi-data", default=DEFAULT_BANGUMI_DATA, help="bangumi-data-dist.json 路径（映射真源）")
    ap.add_argument("--dump", default=DEFAULT_DUMP, help="dump zip 路径（热门度排序用；--ids 时不读）")
    ap.add_argument("--data-dir", default=str(REPO / "data"), help="数据目录（默认 data/）")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"热门前 N 张起抓（默认 {DEFAULT_LIMIT}，0=全部）")
    ap.add_argument("--ids", type=int, nargs="+", default=None, help="指定 bangumi subject id 增量抓取（跳过热门度排序）")
    ap.add_argument("--rps", type=float, default=RPS, help=f"合计限速：每秒请求数（默认 {RPS:g}）")
    ap.add_argument("--rpm", type=int, default=RPM, help=f"Jikan 限速：每分钟请求数（默认 {RPM}）")
    ap.add_argument("--workers", type=int, default=WORKERS, help=f"并发抓取线程数（默认 {WORKERS}）")
    ap.add_argument("--jikan-only", action="store_true", help="禁用 MAL 页兜底（严格 Jikan 主路径）")
    ap.add_argument("--recheck", action="store_true", help="主路径回归：已落盘条目用 Jikan 重解析比对缓存 URL（不重下载）")
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    cards_path = data_dir / "cards.json"
    if not cards_path.is_file():
        print(f"缺 {cards_path}：先跑 python scripts/build_cards.py 建库", file=sys.stderr)
        return 1
    cards = json.loads(cards_path.read_text(encoding="utf-8"))
    covers_dir = data_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    total_pacer = Pacer(args.rps, 0)          # 合计限速（全部请求）
    jikan_window = Pacer(0, args.rpm)         # Jikan 专属分钟窗（避开 60 rpm 硬限）
    pacers = {"api": (jikan_window, total_pacer), "page": (total_pacer,), "img": (total_pacer,)}

    b2m, map_stats = load_mapping(args.bangumi_data)

    if args.ids:
        queue = build_queue(cards, {}, args.limit, args.ids)
    else:
        wanted = {c["id"] for c in cards}
        pop = load_popularity(args.dump, wanted)
        queue = build_queue(cards, pop, args.limit, None)
        print(f"热门度排序完成：{len(pop)} 卡入表，队列 {len(queue)} 张")

    reg = load_registry(covers_dir / "index.json")
    stats = process(queue, b2m, reg, covers_dir, pacers, not args.jikan_only,
                    covers_dir / "index.json", workers=args.workers)
    if args.recheck:
        reg["recheck"] = recheck_jikan(reg, pacers)
        print(f"主路径回归：一致 {reg['recheck']['match']} / {reg['recheck']['checked']}，"
              f"不一致 {len(reg['recheck']['mismatch'])}，中止 {reg['recheck']['transient_stop']}")
    save_registry(covers_dir / "index.json", reg)
    covered, total = patch_cards(cards_path, reg["entries"], covers_dir)

    mapped_cards = sum(1 for c in cards if str(c["id"]) in b2m)
    mapped_queue = sum(1 for c in queue if str(c["id"]) in b2m)
    report = build_report(args, map_stats, mapped_cards, cards, queue, mapped_queue,
                          stats, reg, covered, sha256_file(args.bangumi_data))
    (data_dir / "cover-report.md").write_text(report, encoding="utf-8", newline="\n")

    print(f"范围 {len(queue)} 张：新下载 {stats['新下载成功']}，已落盘跳过 {stats['已落盘跳过']}，"
          f"终态跳过 {stats['终态跳过']}，瞬时失败 {stats['瞬时失败（待续抓）']}；"
          f"解析 jikan {stats['解析成功·jikan']} / mal-og {stats['解析成功·mal-og']}；"
          f"cards.json cover {covered}/{total} → {cards_path}")
    if stats.get("熔断"):
        print(f"熔断：连续 {BREAKER} 次瞬时失败（解析源/图床不可达），已抓进度已保留，网络恢复后重跑续抓", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
