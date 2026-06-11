# Science-Lab 实验馆

抖音式沉浸滑动浏览的科学实验 App。展示 [`Albert-Huo/HTML-`](https://github.com/Albert-Huo/HTML-) 仓库中的交互实验 HTML，适配手机/平板，兼顾桌面网页。

## 交互设计

- 全屏单实验展示，一页一个交互实验（iframe，仅挂载当前 ±1，懒加载）
- 左右屏幕边缘各有一条手势竖条：
  - 竖条上 **上下滑** → 切换上/下一个实验
  - 右缘 **左滑** → 实验目录侧栏（学科/学段筛选、搜索、直达跳转）
  - 左缘 **右滑** → "我的"侧栏（信息 / 历史 / AI 问答）
- 中间区域的手势完全留给实验本身，不与翻页冲突
- 桌面端支持滚轮、方向键翻页
- 自动记住上次浏览位置，浏览历史存于 localStorage

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | App 壳，单文件无依赖 |
| `manifest.json` | 实验清单（由脚本生成，勿手改） |
| `tools/build-manifest.py` | 扫描 `HTML-` 仓库生成清单 |
| `docs/roadmap.md` | 演进计划 |

## 内容源

实验 HTML 不在本仓库。App 默认从线上内容站 `https://html.xingnian.net.cn/` 加载；当 App 部署在该域名下时自动改用相对路径。可用 URL 参数覆盖：

```
index.html?base=/HTML-/        # 本地联调：加载本地 HTML- 仓库工作区
index.html?base=https://html.xingnian.net.cn/
```

## 内容更新流程

`HTML-` 仓库新增/改名实验后：

```
python3 tools/build-manifest.py   # 默认扫描同级目录 ../HTML-
git add manifest.json && git commit -m "chore: 更新实验清单" && git push
```

新增内容目录（学科/学段）时，先在 `tools/build-manifest.py` 的 `DIRS` 中登记。

## 本地开发

```
cd /Users/lx100/projects/HTML-GitHub        # HTML- 与 Science-Lab 的父目录
python3 -m http.server 8788 --bind 127.0.0.1
# 打开 http://127.0.0.1:8788/Science-Lab/index.html?base=/HTML-/
```

移动端视口审阅使用 `HTML-sources-private/tools/review/mobile-review-wrapper.html`（端口 8766），流程同内容仓库惯例。
