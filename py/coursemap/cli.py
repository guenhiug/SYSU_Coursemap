"""命令行入口：json (+ config) -> png。"""

import argparse
import json
import sys
from pathlib import Path

from .normalize import normalize_map
from .render import REPO_ROOT, render_png

DATA_DIR = REPO_ROOT / "data"


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _resolve_public(url_path):
    """index.json 里的 '/raw/x.json' -> <repo>/data/raw/x.json。"""
    return DATA_DIR / str(url_path).lstrip("/")


def _build_config(args, file_config):
    config = dict(file_config)
    if args.theme:
        config["theme"] = args.theme
    if args.legend:
        config["legend"] = args.legend
    if args.title:
        config["title"] = args.title
    if args.seed is not None:
        config["paletteSeed"] = args.seed
    return config


def _render_one(raw, config, name, outdir, out_path, scale):
    map_data = normalize_map(raw, config)
    target = Path(out_path) if out_path else Path(outdir) / f"{name}.png"
    render_png(map_data, target, scale=scale)
    return map_data, target


def _cmd_render(args):
    if args.all:
        index = _read_json(DATA_DIR / "maps" / "index.json")
        if not index:
            print("data/maps/index.json 为空，无地图可渲染", file=sys.stderr)
            return 1
        for entry in index:
            raw = _read_json(_resolve_public(entry["data"]))
            config = _read_json(_resolve_public(entry["config"])) if entry.get("config") else {}
            map_data, target = _render_one(
                raw, _build_config(args, config), entry["id"], args.outdir, None, args.scale
            )
            print(f"[{entry['id']}] {map_data['title']} -> {target}")
        return 0

    if not args.input:
        print("需要 <input.json> 或 --all", file=sys.stderr)
        return 2
    input_path = Path(args.input)
    if not input_path.is_file():
        print(f"找不到文件: {input_path}", file=sys.stderr)
        return 1
    file_config = _read_json(args.config) if args.config else {}
    raw = _read_json(input_path)
    map_data, target = _render_one(
        raw, _build_config(args, file_config), input_path.stem, args.outdir, args.out, args.scale
    )
    print(f"{map_data['title']} -> {target}")
    return 0


def _cmd_list(_args):
    for entry in _read_json(DATA_DIR / "maps" / "index.json"):
        print(f"{entry['id']}\t{entry['title']}\t{entry['data']}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m coursemap", description="SYSU 课程地图 -> PNG")
    sub = parser.add_subparsers(dest="command", required=True)

    render = sub.add_parser("render", help="渲染 JSON 为 PNG")
    render.add_argument("input", nargs="?", help="课程 JSON 路径")
    render.add_argument("--config", help="config JSON 路径（可选）")
    render.add_argument("--theme", choices=["template1", "template2"], help="覆盖 config.theme")
    render.add_argument("--legend", choices=["side", "bottom"], help="覆盖 config.legend")
    render.add_argument("--title", help="覆盖 config.title")
    render.add_argument("--seed", type=int, help="覆盖 config.paletteSeed（固定随机配色）")
    render.add_argument("--out", help="输出 PNG 路径（单张时生效）")
    render.add_argument("--outdir", default="out", help="输出目录（默认 out/）")
    render.add_argument("--scale", type=int, default=2, help="像素倍率（默认 2）")
    render.add_argument("--all", action="store_true", help="渲染 data/maps/index.json 里的全部地图")
    render.set_defaults(func=_cmd_render)

    list_cmd = sub.add_parser("list", help="列出 index.json 中的地图")
    list_cmd.set_defaults(func=_cmd_list)
    return parser


def main(argv=None):
    # Windows 控制台默认按本地代码页编码 stdout，中文提示会变乱码
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ValueError as exc:
        print(f"渲染失败: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
