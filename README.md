# Science-Lab 实验馆

抖音式沉浸滑动浏览的科学实验 App。展示 [`Albert-Huo/HTML-`](https://github.com/Albert-Huo/HTML-) 仓库中的交互实验 HTML，适配手机/平板，兼顾桌面网页。

## 免登录本地版

实验馆面向学习者免费使用，无需注册或登录。浏览历史和 AI 问答记录只保存在当前设备的浏览器 `localStorage`，不会同步到云端；清除浏览器数据、更换浏览器或更换设备后，这些记录会丢失且无法恢复。

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

## AI 问答

"我的"侧栏 → AI 问答，使用 DeepSeek（OpenAI 兼容协议），系统提示自动注入当前实验的标题/学科/学段。

默认使用部署在本站 `/api/ai/chat/completions` 的内置 AI 代理，学习者无需填写接口、模型或 API Key。站点管理员在服务端 `.env` 配置 `DEEPSEEK_API_KEY`，浏览器不会接触该 Key。

为生成回答，当前实验信息、最近对话和本次问题会经本站代理发送给 DeepSeek；站点不做账号绑定或云端会话保存，但模型服务商仍会按其服务条款处理请求。请勿提交姓名、联系方式等敏感个人信息。

需要使用其他 OpenAI 兼容服务时，可在聊天框左下 ⚙ 开启“使用自己的 API Key”，再填写 endpoint、model 和 Key。BYOK 配置只保存在当前浏览器；共用设备请勿填写个人 Key。

## 版权与许可

Science-Lab App 壳使用 MIT License，详见 `LICENSE` 和 `NOTICE`。

MIT 许可只覆盖本仓库中的 App 壳、清单、Service Worker、图标、构建脚本和 Worker 示例代码。App 加载的实验 HTML 来自独立的 `Albert-Huo/HTML-` 仓库，不由本仓库的 MIT 许可授权；使用或改编实验内容时，请遵守 `HTML-` 仓库自己的许可和署名要求。

API Key、模型服务凭证和已部署 Worker Secret 不属于仓库内容，不能提交到 Git。

## 旧接口兼容

`server/api/` 仍保留旧版 `/auth/register`、`/auth/login` 和 `/progress` 接口及 MySQL 数据结构，以免破坏已有部署和历史数据；当前免登录前端不会调用这些接口。内置 AI 代理也由该 Node 服务提供，部署步骤见 `docs/aliyun-deploy.md`。

## 本地开发

```
cd /Users/lx100/projects/HTML-GitHub        # HTML- 与 Science-Lab 的父目录
python3 -m http.server 8788 --bind 127.0.0.1
# 打开 http://127.0.0.1:8788/Science-Lab/index.html?base=/HTML-/
```

移动端视口审阅使用 `HTML-sources-private/tools/review/mobile-review-wrapper.html`（端口 8766），流程同内容仓库惯例。
