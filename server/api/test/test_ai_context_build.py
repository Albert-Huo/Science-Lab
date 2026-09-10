"""Offline builder tests: python3 server/api/test/test_ai_context_build.py."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

BUILDER = Path(__file__).resolve().parents[3] / "tools/build-ai-context.py"
SPEC = importlib.util.spec_from_file_location("ai_context_build", BUILDER)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ContextBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = self.root / "content"
        (self.content / "physics-middle").mkdir(parents=True)
        self.relative = "physics-middle/实验.html"
        self.source = self.content / self.relative
        self.source.write_text('<section class="explanation"><p>实验结论：这里是来自源文件的真实说明文字。</p></section>', encoding="utf-8")
        self.manifest = self.root / "manifest.json"
        self.output = self.root / "ai-context.json"
        self.set_manifest(self.relative)

    def set_manifest(self, path):
        self.manifest.write_text(json.dumps([{"path": path, "title": "实验", "subject": "物理", "level": "初中"}], ensure_ascii=False), encoding="utf-8")

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(BUILDER), "--content-root", str(self.content), "--manifest", str(self.manifest), "--output", str(self.output), *args], capture_output=True, text=True, check=False)

    def test_paths_and_missing_source_fail_closed(self):
        for path in ("../secret.html", "/etc/secret.html", "physics-middle/../secret.html", "physics-middle\\secret.html", "physics-middle//实验.html", "physics-middle/实验.txt", "physics-middle/missing.html"):
            with self.subTest(path=path):
                self.set_manifest(path)
                with self.assertRaises(ValueError):
                    builder.build(self.manifest, self.content)
        outside = self.root / "outside.html"
        outside.write_text("outside", encoding="utf-8")
        link = self.content / "physics-middle/link.html"
        link.symlink_to(outside)
        self.set_manifest("physics-middle/link.html")
        with self.assertRaises(ValueError):
            builder.build(self.manifest, self.content)
        self.assertFalse(self.output.exists())

    def test_script_style_controls_excluded_and_entities_decoded(self):
        context, _ = builder.extract('''<head><title>DO_NOT_INCLUDE_TITLE</title><style>DO_NOT_INCLUDE_STYLE</style></head>
          <script>window.secret = "DO_NOT_INCLUDE_SCRIPT";</script>
          <section class="explanation"><h2>实验目的</h2><p>测量 &lt; 20℃ 的液体 &amp; 比较<b>两次</b>结果。</p></section>
          <div class="explanation"><p>安全提示：热水不可直接接触皮肤，应使用防护器具。</p></div>
          <div class="result-panel"><p>DO_NOT_INCLUDE_RUNTIME_STATE</p></div>
          <div class="codex-generated-explanation"><p>DO_NOT_INCLUDE_BOILERPLATE</p></div>
          <button>DO_NOT_INCLUDE_BUTTON</button>''')
        combined = json.dumps(context, ensure_ascii=False)
        self.assertNotIn("DO_NOT_INCLUDE", combined)
        self.assertEqual(context["objective"], ["测量 < 20℃ 的液体 & 比较两次结果。"])
        self.assertTrue(context["safety"])
        self.assertEqual(context["apparatus"], [])

    def test_literal_steps_do_not_execute_callbacks_or_interpolation(self):
        context, _ = builder.extract('''<script>
          // const steps = [{text: 'DO_NOT_INCLUDE_COMMENT'}];
          const ignored = "const steps = [{text: 'DO_NOT_INCLUDE_STRING'}]";
          const steps = [
            {text: '先把<b>温度计</b>放进水中并观察示数。', hint: '提示：等待读数稳定以后再记录结果。', check: () => { throw 'DO_NOT_INCLUDE_CALLBACK'; }},
            {text: `DO_NOT_INCLUDE_${window.secret}`},
            {text: 'DO_NOT_INCLUDE_EXPRESSION' + secret},
            {text: '再比较第二次读数与第一次读数的差异。'}
          ];
          const state = { text: 'DO_NOT_INCLUDE_STATE' };
        </script>''')
        self.assertNotIn("DO_NOT_INCLUDE", json.dumps(context))
        self.assertEqual(len(context["steps"]), 2)
        self.assertIn("温度计", context["steps"][0])
        self.assertEqual(len(context["notes"]), 1)

    def test_selected_lab_does_not_mix_other_experiments(self):
        context, _ = builder.extract('''<script>
          const LAB_ID = 14;
          const LABS = {
            14: { apparatusHint: '器材：量筒、清水、酒精和混合量筒。', bullets: ['混合后总体积通常小于两者体积之和。'], tasks: [{text:'先将清水倒入量筒，再加入酒精并观察。'}]},
            15: { apparatusHint:'DO_NOT_INCLUDE_OTHER_LESSON', bullets:['DO_NOT_INCLUDE_OTHER_LESSON'] }
          };
          const LAB = LABS[LAB_ID];
        </script>''')
        self.assertNotIn("DO_NOT_INCLUDE", json.dumps(context))
        self.assertTrue(context["apparatus"])
        self.assertTrue(context["steps"])
        self.assertIn("混合后", context["notes"][0])

    def test_spec_and_nested_task_array_are_static_material(self):
        context, _ = builder.extract('''<script>
          const SPEC = {apparatus:'玻璃板、蜡烛、白纸、刻度尺和光屏', conclusion:'平面镜所成的像是虚像，像和物体大小相等。', scenarios:[{action:'拖动蜡烛再移动替身使其与像重合。', note:'改变物距后像距随之改变而像大小不变。', value:12345}]};
          const tasks = [['观察塞子颤动并弹出','留意塞子先颤动，再被推出、撞板并落地。']];
        </script>''')
        self.assertTrue(context["observations"])
        self.assertTrue(context["conclusions"])
        self.assertEqual(len(context["steps"]), 2)
        self.assertNotIn("12345", json.dumps(context))

    def test_utf16_and_serialized_context_bounds(self):
        paragraphs = []
        for category, label in (("objective", "实验目的"), ("apparatus", "实验器材"), ("steps", "实验步骤"), ("observations", "实验现象"), ("conclusions", "实验结论"), ("safety", "安全提示"), ("notes", "其他说明")):
            for index in range(12):
                paragraphs.append(f"<p>{label}：{index}" + ('🌡️\\测量' * 150) + "</p>")
        context, report = builder.extract('<section class="explanation">' + "".join(paragraphs) + "</section>")
        self.assertTrue(report["truncated"])
        self.assertLessEqual(report["textChars"], 4500)
        self.assertLessEqual(builder.js_length(json.dumps(context, ensure_ascii=False, separators=(",", ":"))), 6000)
        for category in builder.CATEGORIES:
            self.assertLessEqual(len(context[category]), 8)
            self.assertTrue(all(builder.js_length(value) <= 350 for value in context[category]))

    def test_manifest_provenance_determinism_and_check_no_writes(self):
        (self.content / "physics-middle/unlisted.html").write_text("DO_NOT_INCLUDE_UNLISTED", encoding="utf-8")
        first, _ = builder.build(self.manifest, self.content)
        second, _ = builder.build(self.manifest, self.content)
        self.assertEqual(builder.render(first), builder.render(second))
        self.assertEqual(first["version"], 1)
        self.assertEqual(len(first["experiments"]), 1)
        experiment = first["experiments"][0]
        self.assertEqual(experiment["sourceHash"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(set(experiment["context"]), set(builder.CATEGORIES))
        self.assertNotEqual(self.run_cli("--check").returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.run_cli().returncode, 0)
        before = self.output.read_bytes()
        before_time = self.output.stat().st_mtime_ns
        self.assertEqual(self.run_cli("--check").returncode, 0)
        self.assertEqual(self.output.stat().st_mtime_ns, before_time)
        self.source.write_text("changed source", encoding="utf-8")
        self.assertNotEqual(self.run_cli("--check").returncode, 0)
        self.assertEqual(self.output.read_bytes(), before)


    def test_atomic_replace_failure_preserves_bundle_and_cleans_temp(self):
        self.output.write_text("previous bundle", encoding="utf-8")
        before_time = self.output.stat().st_mtime_ns
        with mock.patch.object(builder.os, "replace", side_effect=OSError("replacement failed")):
            with self.assertRaisesRegex(OSError, "replacement failed"):
                builder.write_atomic(self.output, "new complete bundle")
        self.assertEqual(self.output.read_text(encoding="utf-8"), "previous bundle")
        self.assertEqual(self.output.stat().st_mtime_ns, before_time)
        self.assertEqual(list(self.root.glob(".ai-context.json.*.tmp")), [])

    def test_atomic_write_failure_preserves_bundle_and_cleans_temp(self):
        self.output.write_text("previous bundle", encoding="utf-8")
        temporary = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                               prefix=".ai-context.json.", suffix=".tmp", delete=False)
        with mock.patch.object(builder.tempfile, "NamedTemporaryFile", return_value=temporary):
            with mock.patch.object(temporary, "write", side_effect=OSError("write failed")):
                with self.assertRaisesRegex(OSError, "write failed"):
                    builder.write_atomic(self.output, "new complete bundle")
        self.assertEqual(self.output.read_text(encoding="utf-8"), "previous bundle")
        self.assertEqual(list(self.root.glob(".ai-context.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
