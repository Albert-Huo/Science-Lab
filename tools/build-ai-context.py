#!/usr/bin/env python3
"""Build bounded, source-backed AI lesson context; never execute content scripts.

Run from Science-Lab: python3 tools/build-ai-context.py [--check]
Optional --content-root, --manifest and --output support isolated fixtures.
Only manifest-listed HTML files are read. Unknown categories remain empty.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile

CATEGORIES = ("objective", "apparatus", "steps", "observations", "conclusions", "safety", "notes")
MAX_ITEMS, MAX_ITEM_CHARS, MAX_TEXT_CHARS = 8, 350, 4500
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP = {"script", "style", "head", "svg", "canvas", "template", "noscript", "button", "select", "input", "textarea", "code", "pre"}
BLOCK = {"p", "li", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6"}
EDUCATIONAL = re.compile(r"explanation|explain|principle|instruction|knowledge|key-point|task-text|taskText|task-hint|taskHint|objective|apparatus|theory|lesson|description|^info$", re.I)
RUNTIME = re.compile(r"modal|toast|toolbar|record|result|live-data|data-grid|status|readout|codex-generated-explanation", re.I)
LABELS = (
    ("safety", r"安全|注意事项|安全提示|操作禁忌"),
    ("objective", r"实验目的|学习目标|实验目标|任务目标"),
    ("apparatus", r"实验器材|实验材料|实验装置|所需器材|器材与材料"),
    ("steps", r"实验步骤|操作步骤|操作方法|实验方法|实验说明|操作说明"),
    ("observations", r"实验现象|观察现象|观察要点|预期现象"),
    ("conclusions", r"实验结论|原理与结论|结论"),
)


class Node:
    def __init__(self, tag="root", attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def marker(self):
        return self.attrs.get("class", "") + " " + self.attrs.get("id", "")

    def text(self):
        return "".join(child if isinstance(child, str) else (" " if child.tag == "br" else child.text())
                       for child in self.children if isinstance(child, str) or child.tag not in SKIP)


class LessonParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()
        self.nodes = []

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        self.nodes.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def normalized(text):
    return re.sub(r"\s+", " ", text).strip()


def js_length(text):
    return len(text.encode("utf-16-le")) // 2


def bounded_text(text, limit):
    if js_length(text) <= limit:
        return text
    return text.encode("utf-16-le")[:max(0, limit - 1) * 2].decode("utf-16-le", errors="ignore").rstrip() + "…"


def plain_fragment(text):
    parser = LessonParser()
    parser.feed(text)
    return normalized(parser.root.text())


def category_for(text):
    # Labels classify source text; we do not infer conclusions from prose.
    prefix = text[:35]
    for category, pattern in LABELS:
        if re.search(pattern, prefix):
            return category
    return None


def ancestors(node):
    while node.parent:
        yield node
        node = node.parent


def static_candidates(parser):
    candidates = []
    for node in parser.nodes:
        if node.tag not in BLOCK:
            continue
        lineage = list(ancestors(node))
        if any(item.tag in SKIP or RUNTIME.search(item.marker()) for item in lineage):
            continue
        # Extract the smallest blocks, retaining inline markup as plain text.
        if any(isinstance(child, Node) and child.tag in BLOCK for child in node.children):
            continue
        text = normalized(node.text())
        if len(text) < 12 or node.tag.startswith("h") or re.search(r"(?:完成|通关|解锁|实验结束).*后(?:再)?显示|尚未|暂无|待记录", text):
            continue
        educational = any(EDUCATIONAL.search(item.marker()) for item in lineage)
        if not educational and node.tag not in {"p", "li"}:
            continue
        category = category_for(text)
        if category is None:
            # A heading applies only inside its own parent section.
            for section in lineage[1:]:
                headings = [child for child in section.children if isinstance(child, Node) and re.fullmatch(r"h[1-6]", child.tag)]
                if headings:
                    category = category_for(normalized(headings[0].text()))
                    break
        if category is None:
            if any(re.search(r"task[-_]?hint", item.marker(), re.I) for item in lineage):
                category = "notes"
            elif any(re.search(r"task[-_]?text", item.marker(), re.I) for item in lineage):
                category = "steps"
        candidates.append((0 if educational else 1, category or "notes", text))
    return sorted(candidates, key=lambda row: row[0])


# A lexical reader for literal lesson strings only. No eval, JS engine, imports,
# template interpolation, or runtime expressions are used by this builder.
TOKEN = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/|(?P<string>'(?:\\[\s\S]|[^'\\])*'|\"(?:\\[\s\S]|[^\"\\])*\"|`(?:\\[\s\S]|[^`\\])*`)|(?P<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?P<word>[A-Za-z_$][\w$]*)|(?P<punct>[^\s])")
STEP_NAMES = {"steps", "tasks", "taskSteps", "guideSteps", "STEPS", "TASKS"}


def decode_literal(raw):
    if raw[0] == "`" and "${" in raw:
        return None
    inner = raw[1:-1]
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}

    def replace(match):
        value = match.group(1)
        if value.startswith(("u", "x")):
            try:
                return chr(int(value[1:], 16))
            except ValueError:
                return ""
        return escapes.get(value, "" if value == "\n" else value)

    return re.sub(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])", replace, inner)


def literal_value(tokens, index, depth=0):
    """Read JSON-like JS data, rejecting functions, references and expressions."""
    if depth > 40 or index >= len(tokens):
        raise ValueError("Incomplete or deeply nested literal")
    kind, token = tokens[index]
    if kind == "string":
        value = decode_literal(token)
        if value is None:
            raise ValueError("Interpolated template is not static data")
        return value, index + 1
    if kind == "number":
        return float(token) if any(mark in token for mark in ".eE") else int(token), index + 1
    if token in {"true", "false", "null"}:
        return {"true": True, "false": False, "null": None}[token], index + 1
    if token not in {"[", "{"}:
        raise ValueError("Nonliteral JS value")
    result = [] if token == "[" else {}
    close = "]" if token == "[" else "}"
    index += 1
    while index < len(tokens) and tokens[index][1] != close:
        if isinstance(result, dict):
            key_kind, key = tokens[index]
            if key_kind not in {"string", "word", "number"} or index + 1 >= len(tokens) or tokens[index + 1][1] != ":":
                raise ValueError("Nonliteral object key")
            key = decode_literal(key) if key_kind == "string" else key
            value, index = literal_value(tokens, index + 2, depth + 1)
            if key in result:
                raise ValueError("Duplicate object key")
            result[key] = value
        else:
            value, index = literal_value(tokens, index, depth + 1)
            result.append(value)
        if index >= len(tokens) or tokens[index][1] not in {",", close}:
            raise ValueError("Nonliteral expression")
        if tokens[index][1] == ",":
            index += 1
    if index >= len(tokens):
        raise ValueError("Unclosed literal")
    return result, index + 1


def selected_lab(tokens):
    # These legacy pages share many lessons in one source. Require the exact
    # static selector used by the page; never collect all LABS indiscriminately.
    words = [token[1] for token in tokens]
    selection = ["const", "LAB", "=", "LABS", "[", "LAB_ID", "]", ";"]
    if not any(words[i:i + len(selection)] == selection for i in range(len(words))):
        return []
    lab_id = None
    for i in range(len(tokens) - 4):
        if words[i:i + 3] == ["const", "LAB_ID", "="] and tokens[i + 3][0] == "number" and words[i + 4] == ";":
            lab_id = words[i + 3]
    if lab_id is None:
        return []
    for i in range(len(tokens) - 3):
        if words[i:i + 4] == ["const", "LABS", "=", "{"]:
            labs, _ = literal_value(tokens, i + 3)
            lab = labs.get(lab_id)
            if not isinstance(lab, dict):
                raise ValueError("Selected LAB_ID is absent")
            return object_material(lab)
    return []


def task_material(tasks):
    values = []
    if not isinstance(tasks, list):
        return values
    for task in tasks:
        if isinstance(task, dict):
            for key, category in (("text", "steps"), ("hint", "notes")):
                if isinstance(task.get(key), str):
                    values.append((category, plain_fragment(task[key])))
        elif isinstance(task, list):
            for index, value in enumerate(task):
                if isinstance(value, str):
                    values.append(("steps" if index == 0 else "notes", plain_fragment(value)))
        elif isinstance(task, str):
            values.append(("steps", plain_fragment(task)))
    return values


def object_material(lab):
    values = []
    for key, category in (("apparatusHint", "apparatus"), ("apparatus", "apparatus"), ("keyPoint", "notes"), ("conclusion", "conclusions")):
        if isinstance(lab.get(key), str):
            values.append((category, plain_fragment(lab[key])))
    for bullet in lab.get("bullets", []):
        if isinstance(bullet, str):
            text = plain_fragment(bullet)
            values.append((category_for(text) or "notes", text))
    values.extend(task_material(lab.get("tasks", [])))
    for scenario in lab.get("scenarios", []):
        if isinstance(scenario, dict):
            for key, category in (("action", "steps"), ("note", "observations")):
                if isinstance(scenario.get(key), str):
                    values.append((category, plain_fragment(scenario[key])))
    return values


def lesson_arrays(parser):
    values, unsupported = [], 0
    for node in parser.nodes:
        if node.tag != "script" or "src" in node.attrs:
            continue
        source = "".join(child for child in node.children if isinstance(child, str))
        tokens = [(match.lastgroup, match.group()) for match in TOKEN.finditer(source) if match.lastgroup]
        try:
            values.extend(selected_lab(tokens))
        except ValueError:
            unsupported += 1
        for start in range(len(tokens) - 3):
            if tokens[start][1] == "const" and tokens[start + 1][1] in {"LAB", "SPEC"} and [token[1] for token in tokens[start + 2:start + 4]] == ["=", "{"]:
                try:
                    lab, _ = literal_value(tokens, start + 3)
                    values.extend(object_material(lab))
                except ValueError:
                    unsupported += 1
        for start in range(len(tokens) - 3):
            if tokens[start][1] not in {"const", "let", "var", ","} or tokens[start + 1][1] not in STEP_NAMES or [token[1] for token in tokens[start + 2:start + 4]] != ["=", "["]:
                continue
            try:
                tasks, _ = literal_value(tokens, start + 3)
                values.extend(task_material(tasks))
                continue
            except ValueError:
                # Tasks with check callbacks still allow direct text/hint
                # literals; only those two properties at task-object depth
                # are read below, and expressions are omitted.
                pass
            stack, index, found = ["["], start + 4, 0
            while index < len(tokens) and stack:
                kind, token = tokens[index]
                if stack == ["[", "{"] and kind in {"word", "string"}:
                    key = decode_literal(token) if kind == "string" else token
                    tail = tokens[index + 1:index + 4]
                    if key in {"text", "hint"} and len(tail) == 3 and tail[0][1] == ":" and tail[1][0] == "string" and tail[2][1] in {",", "}"}:
                        value = decode_literal(tail[1][1])
                        if value:
                            values.append(("steps" if key == "text" else "notes", plain_fragment(value)))
                            found += 1
                elif stack == ["["] and kind == "string" and tokens[index - 1][1] in {"[", ","} and index + 1 < len(tokens) and tokens[index + 1][1] in {",", "]"}:
                    value = decode_literal(token)
                    if value:
                        values.append(("steps", plain_fragment(value)))
                        found += 1
                if kind == "punct":
                    if token in "[{(":
                        stack.append(token)
                    elif token in "]})":
                        if not stack or stack[-1] != {"]": "[", "}": "{", ")": "("}[token]:
                            break
                        stack.pop()
                index += 1
            if not found:
                unsupported += 1
    return values, unsupported


def extract(html):
    parser = LessonParser()
    parser.feed(html)
    parser.close()
    context = {category: [] for category in CATEGORIES}
    static = static_candidates(parser)
    steps, unsupported = lesson_arrays(parser)
    # Keep explicit categories before fallback prose, then round-robin to keep
    # a large category from consuming the entire experiment budget.
    buckets = {category: [] for category in CATEGORIES}
    for category, value in steps:
        buckets[category].append(value)
    for _, category, value in static:
        buckets[category].append(value)
    seen, total, truncated = set(), 0, False
    for index in range(max((len(items) for items in buckets.values()), default=0)):
        for category in CATEGORIES:
            if index >= len(buckets[category]):
                continue
            value = buckets[category][index]
            if value in seen or len(value) < 8:
                continue
            seen.add(value)
            if len(context[category]) >= MAX_ITEMS or total >= MAX_TEXT_CHARS:
                truncated = True
                continue
            limit = min(MAX_ITEM_CHARS, MAX_TEXT_CHARS - total)
            if js_length(value) > limit:
                value = bounded_text(value, limit)
                truncated = True
            if len(value) < 8:
                continue
            context[category].append(value)
            if js_length(json.dumps(context, ensure_ascii=False, separators=(",", ":"))) > 6000:
                context[category].pop()
                truncated = True
                continue
            total += js_length(value)
    return context, {"textChars": total, "truncated": truncated, "unsupportedArrays": unsupported}


def safe_source(root, relative):
    if not isinstance(relative, str) or "\\" in relative or "\0" in relative:
        raise ValueError("Invalid experiment path")
    path = PurePosixPath(relative)
    if not re.fullmatch(r"[a-z-]+/[^/\\]+\.html", relative) or path.is_absolute() or any(part in {".", "..", ""} for part in relative.split("/")):
        raise ValueError(f"Unsafe experiment path: {relative}")
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError(f"Missing or outside content root: {relative}")
    return target


def build(manifest_path, content_root):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("Manifest must be a nonempty array")
    experiments, reports, seen = [], [], set()
    root = content_root.resolve()
    for item in manifest:
        if not isinstance(item, dict) or not all(isinstance(item.get(key), str) and item[key] for key in ("path", "title", "subject", "level")):
            raise ValueError("Invalid manifest entry")
        if item["path"] in seen:
            raise ValueError(f"Duplicate experiment path: {item['path']}")
        seen.add(item["path"])
        source = safe_source(root, item["path"]).read_bytes()
        context, report = extract(source.decode("utf-8"))
        experiments.append({**{key: item[key] for key in ("path", "title", "subject", "level")},
                            "sourceHash": hashlib.sha256(source).hexdigest(), "context": context})
        reports.append({"path": item["path"], **report})
    return {"version": 1, "experiments": experiments}, reports


def render(artifact):
    return json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"


def write_atomic(output, content):
    """Keep the previous bundle intact until a complete sibling file is ready."""
    output.parent.mkdir(parents=True, exist_ok=True)
    mode = output.stat().st_mode & 0o777 if output.exists() else 0o644
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=f".{output.name}.", suffix=".tmp", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main():
    root = Path(__file__).resolve().parent.parent
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--content-root", type=Path, default=root.parent / "HTML-")
    cli.add_argument("--manifest", type=Path, default=root / "manifest.json")
    cli.add_argument("--output", type=Path, default=root / "server/api/ai-context.json")
    cli.add_argument("--check", action="store_true", help="Fail if the artifact is missing or stale; do not write")
    args = cli.parse_args()
    try:
        artifact, reports = build(args.manifest, args.content_root)
        expected = render(artifact)
        if args.check:
            if not args.output.is_file() or args.output.read_text(encoding="utf-8") != expected:
                raise ValueError("AI context is missing or stale; run python3 tools/build-ai-context.py")
        else:
            write_atomic(args.output, expected)
        summary = {"experiments": len(reports), "empty": [row["path"] for row in reports if row["textChars"] == 0],
                   "sparse": [row["path"] for row in reports if 0 < row["textChars"] < 120],
                   "truncated": [row["path"] for row in reports if row["truncated"]],
                   "unsupportedLessonArrays": [row["path"] for row in reports if row["unsupportedArrays"]]}
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        print(f"AI context {'verified' if args.check else 'built'}: {args.output}")
    except (OSError, ValueError, UnicodeError) as error:
        print(f"AI context build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
