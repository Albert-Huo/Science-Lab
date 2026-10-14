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
    "physics-popular-science": ("物理", "科普演示"),
    "biology-high": ("生物", "高中"),
}

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)

NUMBER_RE = re.compile(r"^(?:初中|高中)物理实验(\d+(?:-\d+)?)")


def load_metadata() -> tuple:
    """Load curated names/topics bound to exact source titles, not broad regexes."""
    metadata_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "experiment-metadata.json")
    with open(metadata_path, encoding="utf-8") as source:
        metadata = json.load(source)
    if metadata.get("version") != 1 or not isinstance(metadata.get("experiments"), dict):
        raise ValueError("展示元数据必须为 version=1 且包含 experiments 对象")
    topics = metadata.get("middleTopics")
    if not isinstance(topics, list) or not topics or any(not isinstance(topic, str) or not topic for topic in topics) or len(set(topics)) != len(topics):
        raise ValueError("知识分类必须为非空、不重复的名称列表")
    experiments = metadata["experiments"]
    for path, item in experiments.items():
        parts = path.split("/")
        if len(parts) != 2 or parts[0] not in DIRS or parts[1] in {"", ".", ".."} or not parts[1].endswith(".html") or "\\" in path:
            raise ValueError("展示元数据存在无效实验路径：" + path)
        if not isinstance(item, dict) or not isinstance(item.get("title"), str) or not item["title"].strip():
            raise ValueError("展示元数据缺少教学名称：" + path)
        sources = item.get("sourceTitles")
        if not isinstance(sources, list) or not sources or any(not isinstance(title, str) or not title.strip() for title in sources):
            raise ValueError("展示元数据缺少已核对来源标题：" + path)
        if "topic" in item and item["topic"] not in topics:
            raise ValueError("未知知识分类：" + path)
        if not isinstance(item.get("keywords", []), list) or any(not isinstance(word, str) for word in item.get("keywords", [])):
            raise ValueError("搜索关键词必须为文本列表：" + path)
        if "description" in item and not isinstance(item["description"], str):
            raise ValueError("教学说明必须为文本：" + path)
    for path, item in experiments.items():
        alias = item.get("catalogAliasOf")
        if alias and (alias not in experiments or alias == path or experiments[alias].get("catalogAliasOf") or alias.split("/")[0] != path.split("/")[0]):
            raise ValueError("目录代表必须存在、同类别且不能形成别名链：" + path)
    return experiments, {topic: index for index, topic in enumerate(topics)}


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
    metadata, topic_orders = load_metadata()

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
            title = extract_title(os.path.join(full, fname), fname[:-5])
            item = {
                "path": rel,
                "title": title,
                "subject": subject,
                "level": level,
            }
            number = NUMBER_RE.match(fname)
            if number:
                item["number"] = number.group(1)
            items.append(item)

    matched = {item["path"]: metadata[item["path"]] for item in items
               if item["path"] in metadata and item["title"] in metadata[item["path"]]["sourceTitles"]}
    for item in items:
        display = matched.get(item["path"])
        if not display:
            continue
        item["title"] = display["title"]
        if "topic" in display:
            item["topic"] = display["topic"]
            item["topicOrder"] = topic_orders[display["topic"]]
        item["keywords"] = display.get("keywords", [])
        if display.get("description"):
            item["description"] = display["description"]
        # Source changes may create a different lesson: never silently fold it into an old one.
        if display.get("catalogAliasOf") in matched:
            item["catalogAliasOf"] = display["catalogAliasOf"]

    out = os.path.join(repo_root, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"已生成 {out}: {len(items)} 个实验")


if __name__ == "__main__":
    main()
