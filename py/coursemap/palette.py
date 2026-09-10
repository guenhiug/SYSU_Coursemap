"""课程类别 / 选修子模块的样式键与显示名。

移植自 src/data/palette.py 对应的 src/data/palette.js。
styleKey 对应 global.css 中的调色变量（--c-<styleKey>-bg/fg/bd）。
"""

BASIC_TYPES = [
    {"key": "commonElective", "label": "公选课"},
    {"key": "commonRequired", "label": "公必课"},
    {"key": "platform", "label": "平台课"},
    {"key": "core", "label": "专业课"},
    {"key": "practice", "label": "实践课"},
]

ELECTIVE_LABEL = "专选课"
HONOR_LABEL = "荣誉课程"
HONOR_STYLE_KEY = "honor"

# 选修子模块按「首次出现的顺序」分配色槽（mod-slot-0..7），
# 可用 preferred_names 预置顺序（config.moduleOrder），超过 8 个时循环复用。
SLOT_COUNT = 8


def _slot_key(index: int) -> str:
    return f"mod-slot-{index}"


def create_module_style_resolver(preferred_names=()):
    """返回 (模块名 -> styleKey) 解析器，未登记的名字按首次出现顺序分配色槽。"""
    assigned: dict[str, str] = {}
    for index, name in enumerate(preferred_names):
        if name:
            assigned[name] = _slot_key(index % SLOT_COUNT)
    state = {"next": len(preferred_names)}

    def resolve(module_name: str) -> str:
        if module_name not in assigned:
            assigned[module_name] = _slot_key(state["next"] % SLOT_COUNT)
            state["next"] += 1
        return assigned[module_name]

    return resolve


# 分带兜底链：courseSubClassModuleName -> courseTypeName -> courseCategoryName
SUBCLASS_BAND = {
    "公共课": 1,
    "公必课模块": 1,
    "平台课模块": 2,
    "专必课": 2,
    "实习实践课": 3,
}

TYPE_BAND = {
    "公共课": 1,
    "平台课程": 2,
    "专业课": 2,
    "实践课": 3,
    "专业选修课": 4,
}

CATEGORY_BAND = {"公必": 1, "公选": 1, "专必": 2, "专选": 4}


def band_of(row: dict) -> int:
    by_subclass = SUBCLASS_BAND.get(row.get("courseSubClassModuleName"))
    if by_subclass:
        return by_subclass
    by_type = TYPE_BAND.get(row.get("courseTypeName"))
    if by_type:
        return by_type
    return CATEGORY_BAND.get(row.get("courseCategoryName"), 4)


CATEGORY_TYPE = {"公必": "commonRequired", "公选": "commonElective"}


def type_of_band1(row: dict) -> str:
    """带1 内区分公必/公选。"""
    if row.get("courseSubClassModuleName") == "公选课模块":
        return "commonElective"
    return CATEGORY_TYPE.get(row.get("courseCategoryName"), "commonRequired")


def type_of_band2(row: dict) -> str:
    """带2 内区分平台/核心：subclass 优先，其次 courseTypeName。"""
    sub = row.get("courseSubClassModuleName")
    if sub == "平台课模块":
        return "platform"
    if sub == "专必课":
        return "core"
    course_type = row.get("courseTypeName")
    if course_type == "平台课程":
        return "platform"
    if course_type == "专业课":
        return "core"
    return "core"
