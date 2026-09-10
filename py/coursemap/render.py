"""MapData -> HTML -> PNG。

DOM 结构与 src/components/*.vue 保持一致，CSS 直接取自 src/styles/global.css
与各 .vue 的 <style scoped> 块，避免出现第二份会漂移的样式副本。
截图用 Playwright chromium，deviceScaleFactor=2（对齐原 html-to-image 的 pixelRatio）。
"""

import math
import re
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from .palette import ELECTIVE_LABEL, HONOR_LABEL

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"

_STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S)
_VUE_STYLE_SOURCES = [
    "App.vue",
    "components/CourseMap.vue",
    "components/BandArea.vue",
    "components/CourseCard.vue",
    "components/LegendPanel.vue",
]

SIDE_CELLS = [
    {"key": "public", "label": "公共课"},
    {"key": "platform", "label": "专业课"},
    {"key": "elective", "label": "专选课"},
]


def load_css(repo_root=REPO_ROOT):
    """global.css + 各组件 scoped 样式拼接；scoped 属性缺失不影响类选择器。"""
    parts = [(repo_root / "src/styles/global.css").read_text(encoding="utf-8")]
    for rel in _VUE_STYLE_SOURCES:
        text = (repo_root / "src" / rel).read_text(encoding="utf-8")
        parts.extend(m.group(1) for m in _STYLE_RE.finditer(text))
    return "\n".join(parts)


def card_text(item):
    """与原 CourseCard 一致：有课程代码时 `名称 代码`，否则只有名称。"""
    if item["code"]:
        return f"{item['name']} {item['code']}"
    return item["name"]


def build_html(map_data, css=None):
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals["card_text"] = card_text
    sem_count = len(map_data["semesters"])
    style_vars = " ".join(f"{k}: {v};" for k, v in map_data["paletteVars"].items())
    return env.get_template("poster.html.j2").render(
        css=css if css is not None else load_css(),
        title=map_data["title"],
        theme=map_data["theme"],
        style_vars=style_vars,
        semesters=map_data["semesters"],
        sem_count=sem_count,
        cols=f"96px repeat({sem_count}, 172px)",
        bands=map_data["bands"],
        side_cells=SIDE_CELLS,
        legend=map_data["legend"],
        legend_variant=map_data["legend"]["position"],
        is_bottom_legend=map_data["legend"]["position"] == "bottom",
        elective_label=ELECTIVE_LABEL,
        honor_label=HONOR_LABEL,
    )


def render_png(map_data, out_path, scale=2, css=None, selector=".sheet"):
    """渲染并截图 selector 元素所在区域（含页面底色）。"""
    from playwright.sync_api import sync_playwright

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    html = build_html(map_data, css=css)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale, viewport={"width": 2400, "height": 1600})
        try:
            page.set_content(html, wait_until="load")
            page.evaluate("() => document.fonts.ready")
            box = page.locator(selector).bounding_box()
            if not box:
                raise RuntimeError(f"页面上找不到元素 {selector}")
            # 视口收到「内容 + 内边距 + 余量」，既不触发 .viewport 的横向滚动，
            # 也不留下大片空白；余量必须大于 .viewport 的 32px/18px/40px 内边距
            page.set_viewport_size({
                "width": max(math.ceil(box["width"]) + 96, 200),
                "height": max(math.ceil(box["height"]) + 140, 200),
            })
            page.wait_for_timeout(50)
            box = page.locator(selector).bounding_box()
            page.screenshot(path=str(out_path), clip={
                "x": box["x"],
                "y": box["y"],
                "width": math.ceil(box["width"]),
                "height": math.ceil(box["height"]),
            })
        finally:
            browser.close()
    return out_path
