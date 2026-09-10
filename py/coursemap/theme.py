"""随机系列配色生成器。

移植自 src/data/theme.js。每个模板固定一个基调色系，每次加载只在基调 ±12° 色相内
微随机；深浅差由「实底/淡底/淡底两档」结构保证，背景一律低彩度。
以 CSS 自定义属性字典返回，供渲染时注入根元素覆盖静态回退色。

位运算要点：JS 的 32 位有符号/无符号语义必须精确复刻，否则种子相同配色也会偏。
"""

import math

SLOT_COUNT = 8

# 基调色相：模板2 = 蓝金系，模板1 = 玫红系
ANCHORS = {"template2": 230, "template1": 345}


def _to_int32(x: int) -> int:
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def _to_uint32(x: int) -> int:
    return x & 0xFFFFFFFF


def _ushr(x: int, n: int) -> int:
    """JS 无符号右移 `x >>> n`。"""
    return (x & 0xFFFFFFFF) >> n


def _imul(a: int, b: int) -> int:
    """JS Math.imul：32 位截断的有符号乘法。"""
    return _to_int32(_to_uint32(a) * _to_uint32(b))


def hash_string(s: str) -> int:
    """FNV-1a 变体，与 JS 版逐位一致。"""
    h = 2166136261
    for ch in s:
        h = _imul(h ^ ord(ch), 16777619)
    return _to_uint32(h)


def mulberry32(seed: int):
    """JS 版 mulberry32 的位精确移植。"""
    state = {"a": _to_uint32(int(seed))}

    def rng() -> float:
        a = _to_int32(state["a"] + 0x6D2B79F5)
        t = _imul(a ^ _ushr(a, 15), 1 | a)
        t = _to_int32(t + _imul(t ^ _ushr(t, 7), 61 | t)) ^ t
        state["a"] = a
        return _to_uint32(t ^ _ushr(t, 14)) / 4294967296.0

    return rng


def _hue(h: float) -> float:
    return ((h % 360) + 360) % 360


def _round_half_up(x: float) -> int:
    """JS Math.round：.5 向正无穷（Python 内建 round 是银行家舍入，会偏）。"""
    return math.floor(x + 0.5)


def _hsl(h: float, s, l) -> str:
    return f"hsl({_round_half_up(_hue(h))} {s}% {l}%)"


def generate_palette_vars(theme: str, rng) -> dict[str, str]:
    v: dict[str, str] = {}
    anchor = ANCHORS.get(theme, ANCHORS["template1"])
    h0 = anchor + (rng() * 2 - 1) * 12

    if theme == "template2":
        # 蓝金系：蓝紫主体 + 固定金色强调
        h_a = 44
        h_e = h0 + 18
        v["--c-common-elective-bg"] = _hsl(h_e, 33, 52)
        v["--c-common-elective-fg"] = "#ffffff"
        v["--c-common-required-bg"] = _hsl(h_e, 38, 94)
        v["--c-common-required-fg"] = _hsl(h_e, 40, 30)
        v["--c-common-required-bd"] = _hsl(h_e, 30, 82)
        v["--c-platform-bg"] = _hsl(h0 - 15, 35, 52)
        v["--c-platform-fg"] = "#ffffff"
        v["--c-core-bg"] = _hsl(h0, 40, 28)
        v["--c-core-fg"] = "#ffffff"
        v["--c-practice-bg"] = _hsl(36, 50, 42)
        v["--c-practice-fg"] = "#ffffff"
        for i in range(SLOT_COUNT):
            hi = h0 + 60 + (i * 360) / SLOT_COUNT
            l = 93 if i % 2 == 0 else 89
            v[f"--c-mod-slot-{i}-bg"] = _hsl(hi, 40, l)
            v[f"--c-mod-slot-{i}-fg"] = _hsl(hi, 45, 30)
            v[f"--c-mod-slot-{i}-bd"] = _hsl(hi, 35, 78)
        v["--c-honor-bg"] = _hsl(h_a, 70, 67)
        v["--c-honor-fg"] = _hsl(h_a, 65, 25)
        v["--c-panel"] = _hsl(h0, 10, 95)
        v["--c-header"] = "#ffffff"
        v["--c-header-fg"] = _hsl(h0, 40, 28)
        v["--c-header-accent"] = f"3px solid {_hsl(h_a, 62, 45)}"
        v["--c-arrow"] = _hsl(h_a, 62, 45)
        v["--c-title"] = _hsl(h0, 40, 28)
        v["--c-page"] = _hsl(h_a, 25, 98)
        v["--c-legend-border"] = _hsl(h0, 12, 88)
        # 侧栏：淡底 + 左粗条
        v["--side-bg"] = "transparent"
        v["--side-public-accent"] = f"5px solid {_hsl(h_e, 33, 52)}"
        v["--side-public-fg"] = _hsl(h_e, 40, 30)
        v["--side-platform-accent"] = f"5px solid {_hsl(h0 - 15, 35, 52)}"
        v["--side-platform-fg"] = _hsl(h0 - 15, 40, 30)
        v["--side-practice-accent"] = f"5px solid {_hsl(36, 50, 42)}"
        v["--side-practice-fg"] = _hsl(36, 50, 26)
        v["--side-elective-accent"] = f"5px solid {_hsl(140, 30, 42)}"
        v["--side-elective-fg"] = _hsl(140, 35, 30)
    else:
        # 玫红系：实底选修 + 淡底必修 + 平台/核心暖橙 + 补色实践 + 淡底色槽
        h_b = h0 + 35
        h_p = h0 + 165
        v["--c-common-elective-bg"] = _hsl(h0, 42, 46)
        v["--c-common-elective-fg"] = "#ffffff"
        v["--c-common-required-bg"] = _hsl(h0, 38, 92)
        v["--c-common-required-fg"] = _hsl(h0, 45, 30)
        v["--c-common-required-bd"] = _hsl(h0, 30, 78)
        v["--c-platform-bg"] = _hsl(h_b, 48, 46)
        v["--c-platform-fg"] = "#ffffff"
        v["--c-core-bg"] = _hsl(h_b, 52, 28)
        v["--c-core-fg"] = "#ffffff"
        v["--c-practice-bg"] = _hsl(h_p, 60, 30)
        v["--c-practice-fg"] = "#ffffff"
        for i in range(SLOT_COUNT):
            hi = h0 + 18 + (i * 360) / SLOT_COUNT
            if i % 4 == 2:
                # 少量实底色槽（补色方向），制造深浅差
                bg = _hsl(h_p + i * 12, 55, 38)
                v[f"--c-mod-slot-{i}-bg"] = bg
                v[f"--c-mod-slot-{i}-fg"] = "#ffffff"
                v[f"--c-mod-slot-{i}-bd"] = bg
            else:
                l = 92 if i % 2 == 0 else 87
                v[f"--c-mod-slot-{i}-bg"] = _hsl(hi, 45, l)
                v[f"--c-mod-slot-{i}-fg"] = _hsl(hi, 45, 30)
                v[f"--c-mod-slot-{i}-bd"] = _hsl(hi, 35, 76 if l == 92 else 70)
        v["--c-honor-bg"] = _hsl(200, 45, 84)
        v["--c-honor-fg"] = _hsl(200, 50, 26)
        v["--c-panel"] = _hsl(h0 + 180, 7, 94)
        v["--c-header"] = _hsl(h_b, 52, 28)
        v["--c-header-fg"] = "#ffffff"
        v["--c-header-accent"] = "none"
        v["--c-arrow"] = _hsl(h0, 45, 50)
        v["--c-title"] = _hsl(h_b, 50, 24)
        v["--c-page"] = _hsl(h0 + 180, 10, 98)
        v["--c-legend-border"] = _hsl(h0, 12, 88)
        # 侧栏：白底描边盒
        v["--side-bg"] = "#ffffff"
        v["--side-public-accent"] = "none"
        v["--side-public-fg"] = _hsl(h0, 45, 30)
        v["--side-platform-accent"] = "none"
        v["--side-platform-fg"] = _hsl(h_b, 45, 34)
        v["--side-practice-accent"] = "none"
        v["--side-practice-fg"] = _hsl(h_p, 60, 30)
        v["--side-elective-accent"] = "none"
        v["--side-elective-fg"] = _hsl(h0 + 220, 40, 42)

    # 侧栏描边线（线色随机，线型由主题 CSS 决定）
    is_t2 = theme == "template2"
    v["--side-public-line"] = "none" if is_t2 else f"1.5px solid {v['--c-common-elective-bg']}"
    v["--side-platform-line"] = "none" if is_t2 else f"1.5px solid {v['--c-platform-bg']}"
    v["--side-practice-line"] = "none" if is_t2 else f"1.5px solid {v['--c-practice-bg']}"
    v["--side-elective-line"] = "none" if is_t2 else f"1.5px solid {_hsl(h0 + 220, 40, 50)}"

    return v


def generate_palette(theme: str, seed: int) -> dict[str, str]:
    return generate_palette_vars(theme, mulberry32(seed))
