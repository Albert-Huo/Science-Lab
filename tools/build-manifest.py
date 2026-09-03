#!/usr/bin/env python3
"""扫描公开内容仓库 HTML-，生成 Science-Lab 的实验清单 manifest.json。

用法:
    python3 tools/build-manifest.py [HTML-仓库路径]

默认 HTML- 仓库路径为本仓库同级目录 ../HTML-。
输出写入本仓库根目录 manifest.json。
"""
import os
import re
import json
import sys

# 目录 -> (学科, 学段)。新增内容目录时在此登记。
DIRS = {
    "physics-middle": ("物理", "初中"),
    "physics-high": ("物理", "高中"),
    "physics-demos": ("物理", "科普演示"),
    "biology-high": ("生物", "高中"),
}

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)


def natural_sort_key(filename: str) -> tuple:
    # 去掉扩展名，确保主实验 49 排在子实验 49-1 前。
    stem = os.path.splitext(filename)[0]
    parts = tuple(int(part) if part.isdecimal() else part for part in re.split(r"(\d+)", stem))
    return parts, filename


def extract_title(path: str, fallback: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            head = f.read(4000)
        m = TITLE_RE.search(head)
        if m:
            return re.sub(r"\s+", " ", m.group(1)).strip()
    except OSError:
        pass
    return fallback


def main() -> None:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    content_repo = sys.argv[1] if len(sys.argv) > 1 else os.path.join(repo_root, "..", "HTML-")
    content_repo = os.path.abspath(content_repo)
    if not os.path.isdir(content_repo):
        sys.exit(f"内容仓库不存在: {content_repo}")

    items = []
    for d, (subject, level) in DIRS.items():
        full = os.path.join(content_repo, d)
        if not os.path.isdir(full):
            print(f"跳过缺失目录: {d}")
            continue
        sort_key = natural_sort_key if d == "physics-middle" else None
        for fname in sorted(os.listdir(full), key=sort_key):
            if not fname.endswith(".html"):
                continue
            rel = f"{d}/{fname}"
            items.append({
                "path": rel,
                "title": extract_title(os.path.join(full, fname), fname[:-5]),
                "subject": subject,
                "level": level,
            })

    out = os.path.join(repo_root, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"已生成 {out}: {len(items)} 个实验")


if __name__ == "__main__":
    main()
