"""接口导出 JSON + 可选 config -> 渲染用的 MapData。

移植自 src/lib/normalize.js，算法与输出结构保持一致。

输入：接口导出 JSON（{code,data:{rows}} / {rows} / 数组均可）+ 可选 config
输出 MapData：
{
  title, startYear, theme, paletteVars,
  semesters: [{ key, label }],
  bands: [3 x { strips: [{segments:[{item,start,end}]}], lifts: [{item,col,row}],
                blanks: [{col,row}], stacks: [每学期一个数组] }],
    带1 公共课（含公必/公选）/ 带2 专业课（平台+核心+实践合并）/ 带3 专选课
  legend: { basics, modules, hasHonor, position },
}

config 结构（全部可省略）：
{
  title: '海报标题（支持 {year} 占位 = 数据最早年份）',
  honor: ['XXXX101', ...],                     # 荣誉课程代码（覆盖底色）
  relocate: [{ code, semesters?, band? }],     # 覆盖学期归位（按学期序号）与所在带（合并前 1-4）
  extraCourses: [{ semesters:'all'|[1..N], band, key, name, code?, type, placeholder? }],
  emptySlots:  [{ semester, band, style? }],   # 空占位盒（band 取合并前编号 1-4）
  order:       { '学期-带': [key, ...] },       # 显式排序（带取合并前编号 1-4）
  theme:       'template1' | 'template2',
  legend:      'side' | 'bottom',
  moduleOrder: ['模块名', ...],
  paletteSeed: 12345,
}
"""

import re
import secrets

from .palette import (
    BASIC_TYPES,
    HONOR_STYLE_KEY,
    band_of,
    create_module_style_resolver,
    type_of_band1,
    type_of_band2,
)
from .theme import generate_palette

PLACEHOLDER_KEY = "__PLACEHOLDER_PUBLIC_ELECTIVE__"
ART_KEY = "__ART_AESTHETIC__"

THEME_ALIAS = {"default": "template1", "integrated": "template2"}

_SEMESTER_RE = re.compile(r"^(\d{4})-(\d+)$")


def extract_rows(raw):
    """兼容 data.rows / rows / 纯数组三种导出形态。"""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        if isinstance(raw.get("rows"), list):
            return raw["rows"]
        data = raw.get("data")
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return data["rows"]
    raise ValueError("无法识别的数据格式：期望 data.rows / rows / 数组")


def parse_semester_key(key):
    """'2026-1' -> {'year': 2026, 'num': 1}；不匹配返回 None。"""
    m = _SEMESTER_RE.match(str(key).strip())
    if not m:
        return None
    return {"year": int(m.group(1)), "num": int(m.group(2))}


def expand_annotation(annotation):
    """'2026-1~2029-2' -> 区间内所有学期 key（含端点）；单值 -> [自身]。"""
    parts = [s.strip() for s in str(annotation if annotation is not None else "").split("~")]
    start = parse_semester_key(parts[0])
    if not start:
        return []
    if len(parts) == 1:
        return [parts[0]]
    end = parse_semester_key(parts[1]) or start
    keys = []
    for year in range(start["year"], end["year"] + 1):
        for num in (1, 2):
            if year == start["year"] and num < start["num"]:
                continue
            if year == end["year"] and num > end["num"]:
                continue
            keys.append(f"{year}-{num}")
    return keys


def semester_ordinals(keys):
    """学期 key 集合 -> {key: 1-based 序号}，按 (年, 学期号) 升序。"""

    def sort_key(key):
        parsed = parse_semester_key(key)
        return (parsed["year"], parsed["num"])

    sorted_keys = sorted(keys, key=sort_key)
    return {key: i + 1 for i, key in enumerate(sorted_keys)}


def _base_item(row, band, resolve_module_style):
    code = row.get("courseNumber") or ""
    name = row.get("courseName") or ""
    if band == 1:
        style_key = type_of_band1(row)
    elif band == 2:
        style_key = type_of_band2(row)
    elif band == 3:
        style_key = "practice"
    else:
        style_key = resolve_module_style(row.get("courseSubClassModuleName") or "")
    return {"key": code or name, "name": name, "code": code, "kind": "course", "styleKey": style_key}


def _apply_order(pool, order_list):
    if not order_list:
        return pool
    rank = {key: i for i, key in enumerate(order_list)}
    return sorted(pool, key=lambda it: rank.get(it["key"], float("inf")))


def _span(strip):
    starts = [seg["start"] for seg in strip["segments"]]
    ends = [seg["end"] for seg in strip["segments"]]
    return min(starts), max(ends)


def _pack_strips(strips):
    """贪心装箱：占位条最前，然后 start 升序 / end 降序，行内互不重叠。"""
    def sort_key(strip):
        has_placeholder = any(seg["item"]["key"] == PLACEHOLDER_KEY for seg in strip["segments"])
        start, end = _span(strip)
        return (0 if has_placeholder else 1, start, -end)

    sorted_strips = sorted(strips, key=sort_key)
    row_ends = []
    for strip in sorted_strips:
        start, end = _span(strip)
        row = next((i for i, e in enumerate(row_ends) if e < start), -1)
        if row == -1:
            row_ends.append(end)
            row = len(row_ends) - 1
        else:
            row_ends[row] = end
        strip["row"] = row
    return sorted_strips


def normalize_map(raw, config=None):
    config = config or {}
    rows = extract_rows(raw)
    resolve_module_style = create_module_style_resolver(config.get("moduleOrder") or [])
    honor_codes = set(config.get("honor") or [])
    reloc_by_code = {r["code"]: r for r in (config.get("relocate") or [])}

    # 1. 展开全部学期列
    all_keys = set()
    expanded = [{"row": row, "keys": expand_annotation(row.get("initiationSemesterAnnotation"))} for row in rows]
    for entry in expanded:
        all_keys.update(entry["keys"])
    ordinal = semester_ordinals(all_keys)
    sem_count = len(ordinal)

    semesters = [
        {"key": key, "label": f"第{ordinal[key]}学期"}
        for key in sorted(ordinal, key=lambda k: ordinal[k])
    ]

    bands = [{"strips": [], "stacks": [[] for _ in range(sem_count)]} for _ in range(4)]

    def pool(ord_, band):
        return bands[band - 1]["stacks"][ord_ - 1]

    # 2. 课程按行展开入池（relocate 覆盖学期注记与所在带；底色始终按课程自身类别）
    for entry in expanded:
        row = entry["row"]
        reloc = reloc_by_code.get(row.get("courseNumber"))
        natural_band = band_of(row)
        if reloc and reloc.get("semesters") is not None:
            ords = reloc["semesters"]
        else:
            ords = [o for o in (ordinal.get(k) for k in entry["keys"]) if o]
        if not ords:
            continue
        place_band = reloc.get("band") if reloc and reloc.get("band") is not None else natural_band
        for ord_ in ords:
            item = _base_item(row, natural_band, resolve_module_style)
            if item["code"] in honor_codes:
                item["styleKey"] = HONOR_STYLE_KEY
            pool(ord_, place_band).append(item)

    # 3. 默认注入：艺术与审美课（第 1-4 学期，公共课带）
    for i in range(min(4, sem_count)):
        pool(i + 1, 1).append({
            "key": ART_KEY,
            "name": "艺术与审美课",
            "code": "",
            "kind": "course",
            "styleKey": "commonRequired",
        })

    # 4. config 补充项
    for extra in config.get("extraCourses") or []:
        targets = list(range(1, sem_count + 1)) if extra.get("semesters") == "all" else extra.get("semesters")
        for ord_ in targets:
            pool(ord_, extra["band"]).append({
                "key": extra.get("key") or extra.get("code") or extra.get("name"),
                "name": extra.get("name"),
                "code": extra.get("code") or "",
                "kind": "placeholder" if extra.get("placeholder") else "course",
                "styleKey": extra.get("type") or "commonRequired",
            })
    for slot in config.get("emptySlots") or []:
        pool(slot["semester"], slot["band"]).append({
            "key": f"__empty_{slot['semester']}_{slot['band']}",
            "name": "",
            "code": "",
            "kind": "empty",
            "styleKey": slot.get("style") or "commonRequired",
        })

    # 5. 公选课占位条：每学期带1顶部
    for i in range(sem_count):
        bands[0]["stacks"][i].insert(0, {
            "key": PLACEHOLDER_KEY,
            "name": "公选课",
            "code": "",
            "kind": "placeholder",
            "styleKey": "commonElective",
        })

    # 6. order 排序：order['学期-带'] 显式序（带取合并前编号），其余按 JSON 行序
    order = config.get("order") or {}
    for bi, band in enumerate(bands):
        band["stacks"] = [
            _apply_order(stack, order.get(f"{si + 1}-{bi + 1}"))
            for si, stack in enumerate(band["stacks"])
        ]

    # 7. 横贯条带抽取：同一带同一 key 出现于 >=2 学期 -> 跨列长条，其余留在堆叠
    for band in bands:
        occ = {}
        for i in range(sem_count):
            for item in band["stacks"][i]:
                if item["kind"] == "empty":
                    continue
                if item["key"] not in occ:
                    occ[item["key"]] = {"item": item, "sems": set()}
                occ[item["key"]]["sems"].add(i + 1)
        spanning = []
        for entry in occ.values():
            sems = entry["sems"]
            if len(sems) < 2:
                continue
            spanning.append({"segments": [{
                "item": entry["item"],
                "start": min(sems),
                "end": max(sems),
            }]})
            for i in range(sem_count):
                band["stacks"][i] = [it for it in band["stacks"][i] if it["key"] != entry["item"]["key"]]
        band["strips"] = _pack_strips(spanning)

    # 8. 三大模块：专业课（带2）与实践课（带3）合并，条带重新装箱
    merged = {
        "strips": _pack_strips([*bands[1]["strips"], *bands[2]["strips"]]),
        "stacks": [a + b for a, b in zip(bands[1]["stacks"], bands[2]["stacks"])],
    }
    out_bands = [bands[0], merged, bands[3]]

    # 8.5 条带行空位回填：未被覆盖的学期格子，从该列堆叠顶部按序上提普通课程；
    # 仍无课程可填的格子补一个虚线空位盒（blank），保证条带区网格完整
    for band in out_bands:
        strip_rows = len(band["strips"])
        band["lifts"] = []
        band["blanks"] = []
        if not strip_rows:
            continue
        covered = [[False] * strip_rows for _ in range(sem_count)]
        for strip in band["strips"]:
            for seg in strip["segments"]:
                for c in range(seg["start"], seg["end"] + 1):
                    covered[c - 1][strip["row"]] = True
        lifted = set()
        lifts = []
        for c, stack in enumerate(band["stacks"]):
            empty_rows = [r for r in range(strip_rows) if not covered[c][r]]
            if not empty_rows:
                continue
            need = len(empty_rows)
            rest = []
            for it in stack:
                if need > 0 and it["kind"] == "course":
                    row = empty_rows[len(empty_rows) - need]
                    lifts.append({"item": it, "col": c, "row": row})
                    lifted.add(f"{c}:{row}")
                    need -= 1
                else:
                    rest.append(it)
            band["stacks"][c] = rest
        for c in range(sem_count):
            for r in range(strip_rows):
                if not covered[c][r] and f"{c}:{r}" not in lifted:
                    band["blanks"].append({"col": c, "row": r})
        band["lifts"] = lifts

    # 9. 图例：按实际用到的类别推导
    used_styles = set()
    has_honor = False
    for band in out_bands:
        for strip in band["strips"]:
            for seg in strip["segments"]:
                used_styles.add(seg["item"]["styleKey"])
                if seg["item"]["styleKey"] == HONOR_STYLE_KEY:
                    has_honor = True
        for stack in band["stacks"]:
            for item in stack:
                if item["kind"] == "empty":
                    continue
                used_styles.add(item["styleKey"])
                if item["styleKey"] == HONOR_STYLE_KEY:
                    has_honor = True
        for lift in band["lifts"]:
            used_styles.add(lift["item"]["styleKey"])
            if lift["item"]["styleKey"] == HONOR_STYLE_KEY:
                has_honor = True

    module_name_by_style = {}
    for entry in expanded:
        row = entry["row"]
        if band_of(row) == 4 and row.get("courseSubClassModuleName"):
            style = resolve_module_style(row["courseSubClassModuleName"])
            if style not in module_name_by_style:
                module_name_by_style[style] = row["courseSubClassModuleName"]
    module_order = []
    for style in used_styles:
        if style.startswith("mod-slot") and not any(m["styleKey"] == style for m in module_order):
            module_order.append({"name": module_name_by_style.get(style, style), "styleKey": style})
    module_order.sort(key=lambda m: int(m["styleKey"][9:]))

    # 10. 主题与随机配色（seed 缺省每次加载随机）；标题 {year} = 数据最早年份
    theme = THEME_ALIAS.get(config.get("theme"), config.get("theme")) or "template1"
    seed = (int(config["paletteSeed"]) & 0xFFFFFFFF) if config.get("paletteSeed") is not None else secrets.randbits(32)

    start_year = None
    for key in all_keys:
        parsed = parse_semester_key(key)
        year = parsed["year"] if parsed else None
        if year is not None and (start_year is None or year < start_year):
            start_year = year
    title = str(config.get("title") or "课程地图").replace("{year}", str(start_year if start_year is not None else ""))

    return {
        "title": title,
        "startYear": start_year,
        "theme": theme,
        "paletteVars": generate_palette(theme, seed),
        "semesters": semesters,
        "bands": out_bands,
        "legend": {
            "basics": [t for t in BASIC_TYPES if t["key"] in used_styles],
            "modules": module_order,
            "hasHonor": has_honor,
            "position": config.get("legend") or ("bottom" if theme == "template2" else "side"),
        },
    }
