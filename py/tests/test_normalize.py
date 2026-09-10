import pytest

from coursemap.normalize import (
    expand_annotation,
    extract_rows,
    normalize_map,
    parse_semester_key,
)

from conftest import read_repo_json


def test_parity_with_js_original(js_expected):
    """Python normalize_map 与 JS 原版输出逐字段一致。"""
    raw = read_repo_json("data/raw/example.json")
    config = read_repo_json("data/maps/example.config.json")
    assert normalize_map(raw, config) == js_expected["normalize"]


def test_parity_palette_vars(js_expected):
    """配色生成器位精确对齐（含 mulberry32 与 Math.round 语义）。"""
    from coursemap.theme import generate_palette

    for case in js_expected["palettes"]:
        assert generate_palette(case["theme"], case["seed"]) == case["vars"], case


def test_expand_annotation_range_and_single():
    assert expand_annotation("2026-1") == ["2026-1"]
    assert expand_annotation("2026-1~2026-2") == ["2026-1", "2026-2"]
    assert expand_annotation("2026-2~2027-1") == ["2026-2", "2027-1"]
    assert expand_annotation("") == []
    assert expand_annotation(None) == []


def test_parse_semester_key():
    assert parse_semester_key("2026-1") == {"year": 2026, "num": 1}
    assert parse_semester_key("bad") is None


@pytest.mark.parametrize(
    "raw",
    [
        [{"courseName": "A"}],
        {"rows": [{"courseName": "A"}]},
        {"data": {"rows": [{"courseName": "A"}]}},
    ],
)
def test_extract_rows_forms(raw):
    assert extract_rows(raw) == [{"courseName": "A"}]


def test_extract_rows_rejects_unknown():
    with pytest.raises(ValueError, match="无法识别的数据格式"):
        extract_rows({"data": {}})
