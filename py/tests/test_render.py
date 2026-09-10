"""HTML 组装检查：类名结构、CSS 不被转义、用户文本被转义。"""

from coursemap.normalize import normalize_map
from coursemap.render import build_html, load_css
from coursemap.theme import generate_palette

from conftest import read_repo_json


def _build(config_override=None):
    raw = read_repo_json("data/raw/example.json")
    config = read_repo_json("data/maps/example.config.json")
    config.update(config_override or {})
    return build_html(normalize_map(raw, config), css=load_css())


def test_html_structure_and_theme_data_attribute():
    html = _build()
    assert 'data-theme="template2"' in html
    assert 'class="course-map legend-bottom"' in html
    assert 'class="side-cell side-public"' in html
    assert 'class="pill honor"' in html
    assert "--c-page:" in html


def test_css_not_entity_escaped():
    """<style> 是 raw text 元素，实体不会被解码；CSS 必须原样输出。"""
    html = _build()
    assert "[data-theme='template2']" in html
    assert "--arrow-char: '▸'" in html
    assert "&gt;" not in html.split("</style>")[0]


def test_user_text_is_escaped():
    html = _build({"title": '<img src=x onerror=alert(1)>'})
    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "<img src=x" not in html


def test_legend_side_variant_for_template1():
    html = _build({"theme": "template1"})
    assert 'class="course-map legend-side"' in html
    assert 'class="legend legend--side"' in html


def test_palette_vars_are_injected_as_inline_style():
    vars_ = generate_palette("template2", 7)
    html = _build({"paletteSeed": 7})
    assert f"--c-page: {vars_['--c-page']};" in html
