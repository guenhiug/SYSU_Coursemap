import json
import pathlib
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def read_repo_json(rel_path):
    return json.loads((ROOT / rel_path).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def js_expected():
    """用 JS 原版跑出的基准数据；Node 不可用时跳过对拍测试。"""
    try:
        proc = subprocess.run(
            ["node", "py/tools/dump_expected.mjs"],
            cwd=ROOT,
            capture_output=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        pytest.skip(f"node 不可用，跳过 JS 对拍: {exc}")
    return json.loads(proc.stdout.decode("utf-8"))
