# Science-Lab 实验馆

抖音式沉浸滑动浏览的科学实验 App。展示 [`Albert-Huo/HTML-`](https://github.com/Albert-Huo/HTML-) 仓库中的交互实验 HTML，适配手机/平板，兼顾桌面网页。

## 免登录本地版

实验馆面向学习者免费使用，无需注册或登录。浏览历史和 AI 问答记录只保存在当前设备的浏览器 `localStorage`，不会同步到云端；清除浏览器数据、更换浏览器或更换设备后，这些记录会丢失且无法恢复。

这里的“免登录”仅指当前 `index.html` 前端体验：页面不展示或调用注册、登录、云同步功能。为兼容已有部署，`server/api/` 仍保留旧账号与进度接口，但当前前端不会使用它们。

## 交互设计

- 全屏单实验展示，一页一个交互实验（iframe，仅挂载当前 ±1，懒加载）
- 左右屏幕边缘各有一条手势竖条：
  - 竖条上 **上下滑** → 切换上/下一个实验
  - 右缘 **左滑** → 实验目录侧栏（学科/学段筛选、搜索、直达跳转）
  - 左缘 **右滑** → "我的"侧栏（信息 / 历史 / AI 问答）
- 中间区域的手势完全留给实验本身，不与翻页冲突
- 桌面端支持滚轮、方向键翻页
- 电脑宽屏目录可通过标题旁“收起”隐藏，顶部左侧“展开目录”恢复；收起后实验区使用完整宽度，并在当前浏览器记住选择。手机端继续使用目录抽屉。
- 自动记住上次浏览位置，浏览历史存于 localStorage

## 联系与支持

实验目录底部与“我的 → 信息”均提供“联系反馈”和“支持实验馆”入口。联系卡展示微信号 `xingniankepu`，点击可复制；浏览器禁止自动复制时，会选中微信号并提示手动复制。

赞赏弹层仅在用户点击后打开，展示 `assets/support/wechat-reward.jpg` 原图，支持微信扫码与保存原图。实验仍免费、免登录，支持完全自愿，不提供会员、专属内容或优先服务等回报。弹层提醒未满18周岁勿支付，并提供监护人处理误付款的微信联系入口。联系与赞赏无需新增后端接口。

## 私有访问统计

维护者访问 [私有统计页](https://lab.xingnian.net.cn/admin/traffic/)，输入独立账号密码即可查看。登录信息保存在维护者本机的私有凭据文件，不存入仓库。请将密码保存到密码管理器，共用电脑建议使用隐私窗口。

每个北京时间双数整点（00:00、02:00、04:00……）自动生成最近24小时的快照，页面展示24个小时的趋势，可切换入口请求、访客估算和全部请求，并显示设备、来源分类。页面打开时每分钟检查新版本，也可点“检查更新”；该按钮只读取最新快照，不提前触发统计任务。统计区间含开始、不含结束，截止到最近双数整点；不是实时数据。生成失败会保留旧报告，超过预计更新时刻5分钟后显示延迟提示。

“下载当前数据”导出与屏幕同一快照的CSV，包含24小时汇总、24行小时明细和设备/来源分类，UTF-8带BOM，可用Excel打开。“下载历史CSV”提供最近400天已归档的每日汇总，首个自然日结束前暂不可用。CSV不包含原始IP、浏览器标识、查询参数或完整来源网址，小时和每日访客估算不能相加作为期间去重人数。

2026-09-07 21:41（北京时间）起开始独立采集，之前的时段标为“未采集”，不填充为零。入口请求不是精确浏览量：浏览器缓存、预取、机器人以及共享网络都会带来误差。访客估算不是登录人数；本版不统计地区、停留时间和GitHub Pages中各实验的使用情况。

复用现有服务器、独立日志和Node运行时，无需新增数据库或网页访客追踪脚本，电脑不用一直开机。原始日志沿用每日轮转、保留10份历史文件的现有规则；每日汇总另保留400天。历史汇总不是原始日志备份，超过日志留存期的中断数据无法补算。维护和部署说明见 `server/traffic/README.md`。

### 按需本地快照（保留原工具）

维护者在本机仓库中运行以下命令即可生成新的私有 HTML；需已有 SSH 密钥授权、已核验的服务器主机指纹及本机 Node.js：

```bash
cd /Users/lx100/projects/HTML-GitHub/Science-Lab
SCIENCE_LAB_REPORT_DIR=$(mktemp -d /private/tmp/science-lab-report.XXXXXX)
node tools/traffic-report.cjs \
  --remote root@47.97.174.49 \
  --node /opt/science-lab-runtime/node-v22.23.2-linux-x64/bin/node \
  --output "$SCIENCE_LAB_REPORT_DIR/report.html"
```

这个旧工具汇总当前仍保留的全部独立日志，生成无脚本的本地HTML，和在线24小时看板的范围不同。原始标识不下载，文件权限为 `0600`，已有文件不会被覆盖；请勿提交报告或日志到Git。该本地快照不自动刷新。

空日志不轮转，因此不是严格的十天原始日志留存。旧工具不回填此前混合日志，也不管理在线历史归档。配置及上线记录见 `docs/aliyun-deploy.md` 和 `docs/superpowers/plans/2026-09-07-rolling-traffic-dashboard.md`。

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | App 壳，单文件无依赖 |
| `catalog-control.json` | 目录与单个实验的发布状态开关 |
| `catalog-control.js` | 发布状态解析、统计与浏览位置兼容逻辑 |
| `manifest.json` | 实验清单（由脚本生成，勿手改） |
| `tools/build-manifest.py` | 扫描 `HTML-` 仓库生成清单 |
| `docs/roadmap.md` | 演进计划 |

## 内容源

实验 HTML 不在本仓库。App 默认从线上内容站 `https://html.xingnian.net.cn/` 加载；当 App 部署在该域名下时自动改用相对路径。只有页面运行在 `localhost` 或 `127.0.0.1` 时，才接受根相对的 `base` 参数用于本地联调：

```
index.html?base=/HTML-/        # 本地联调：加载本地 HTML- 仓库工作区
```

生产域名会忽略 `base` 参数，始终使用官方内容站；协议相对地址、外部绝对地址和脚本协议不会进入实验 iframe。

## 内容更新流程

`HTML-` 仓库新增/改名实验后：

```
python3 tools/build-manifest.py   # 默认扫描同级目录 ../HTML-
git add manifest.json && git commit -m "chore: 更新实验清单" && git push
```

新增内容目录（学科/学段）时，先在 `tools/build-manifest.py` 的 `DIRS` 中登记。

初中物理目录按文件名中的数字自然排序（如 `1、2、10、12-1、12-2、49、49-1`），其他目录保留原有排序。目录列表和上下切换共用清单顺序，无需重命名实验文件。

排序回归测试已接入 `npm test --prefix server/api`；测试环境需要 Node.js 和 Python 3，也可单独运行 `node server/api/test/manifest-order.js`。

## 目录发布控制

不要从 `manifest.json` 删除临时下线的内容；在 `catalog-control.json` 中调整状态即可恢复和审查。目录使用实验路径的第一段作为稳定标识，例如 `physics-high/einstein-relativity-level-1-simultaneity.html` 对应目录 ID `physics-high`。

支持三种状态：

| 状态 | App 目录与实验流 | 已有历史记录 |
| --- | --- | --- |
| `published` | 正常显示 | 可以打开 |
| `hidden` | 隐藏 | 保留，并标注“已从目录隐藏” |
| `disabled` | 隐藏 | 保留，并标注“暂不可用” |

当前预览配置把“物理 · 高中”和“生物 · 高中”设为隐藏：

```json
{
  "version": 1,
  "categories": {
    "physics-high": { "state": "hidden" },
    "biology-high": { "state": "hidden" }
  },
  "experiments": {}
}
```

恢复目录时把状态改为 `published`。单个实验可按完整路径写入 `experiments`，且优先级高于目录状态：

```json
{
  "categories": {
    "physics-high": { "state": "hidden" }
  },
  "experiments": {
    "physics-high/example.html": { "state": "published" }
  }
}
```

发布新的控制文件后无需重启 Node 服务；页面会优先从网络读取配置，离线时回退到最后一次缓存。配置缺失、加载失败或状态拼写不合法时，系统默认保持内容为 `published`，避免误关全部实验。

这里的 `disabled` 是 App 侧发布状态，不能阻止用户直接打开独立内容站 `html.xingnian.net.cn` 上的已知实验网址。涉及版权、安全或强制下线时，还必须在内容站 nginx 或应用服务同步拒绝该路径。

## AI 问答

"我的"侧栏 → AI 问答，使用 DeepSeek（OpenAI 兼容协议）。内置助手的系统提示由服务端生成，结合当前实验标题、学科、学段与从内容源码提取的实验资料。它无法看到当前操作和仪器读数，会区分资料、理论预期与用户观察。

默认使用部署在本站 `/api/ai/chat/completions` 的内置 AI 代理，学习者无需填写接口、模型或 API Key。界面统一显示 `DeepSeek`；站点管理员在服务端 `.env` 通过 `DEEPSEEK_MODEL` 配置实际模型 ID，并通过 `DEEPSEEK_API_KEY` 配置密钥，浏览器不会接触服务端 Key。

受密码保护的访问观察台同时展示内置 AI 请求的匿名汇总，包括请求状态、耗时、上下文长度、响应流量和当前 24 小时热门实验。不保存问题或回答正文，也不记录 AI 请求的 IP、浏览器标识或用户身份；BYOK 由浏览器直连第三方，不在统计范围内。

为生成回答，当前实验信息、初中物理实验的模式/关卡及可读取文字读数、最近完整问答和本次问题会经本站代理发送给 DeepSeek；站点不做账号绑定或云端会话保存，但模型服务商仍会按其服务条款处理请求。请勿提交姓名、联系方式等敏感个人信息。防滥用额度使用24小时签名匿名 Cookie，Redis 暂存带过期时间的会话/IP不可逆密钥摘要计数，不保存聊天正文；匿名统计日志也不新增标识。

可停止生成、重新提问，页面显示可用额度与恢复时间。断流或停止后的部分回答明确标记，不进入下一次模型上下文。聊天最多保存200条、单条6000字符；模型上下文保留最近5个完整问答和当前问题，总正文最多12000字符。

需要使用其他 OpenAI 兼容服务时，可在聊天框左下 ⚙ 开启“使用自己的 API Key”，再填写 HTTPS endpoint、model 和 Key（localhost 调试可用 HTTP）。BYOK 配置只保存在当前浏览器；关闭并保存后移除 Key，共用设备请勿填写个人 Key。BYOK 直连不受本站 Redis 限额约束。

实时状态的覆盖范围与限制见 [状态快照说明](docs/ai-live-state.md)。资料包的构建、额度配置、生产 Redis 与发布顺序见 [AI 助手运维说明](docs/ai-assistant.md)。旧 `server/cloudflare-worker.js` 已改为410退役占位，不能用于新代理部署；本地修改不会自动关闭已有远端 Worker。

## 版权与许可

Science-Lab App 壳使用 MIT License，详见 `LICENSE` 和 `NOTICE`。

MIT 许可只覆盖本仓库中的 App 壳、清单、Service Worker、图标、构建脚本和 Worker 示例代码。App 加载的实验 HTML 来自独立的 `Albert-Huo/HTML-` 仓库，不由本仓库的 MIT 许可授权；使用或改编实验内容时，请遵守 `HTML-` 仓库自己的许可和署名要求。

生成的 `server/api/ai-context.json` 含实验内容摘录，沿用来源内容的许可和署名，不因放入本仓库而改为 MIT；每项保留来源路径与SHA256。

API Key、模型服务凭证和已部署 Worker Secret 不属于仓库内容，不能提交到 Git。

## 旧接口兼容

`server/api/` 仍保留旧版 `/auth/register`、`/auth/login` 和 `/progress` 接口及 MySQL 数据结构，以免破坏已有部署和历史数据；当前免登录前端不会调用这些接口。内置 AI 代理也由该 Node 服务提供，部署步骤见 `docs/aliyun-deploy.md`。

仓库审查只能确认本次改造没有修改 `server/api/db.js`、`server/api/schema.sql` 和旧接口行为，不能替代对生产 MySQL 内容的核验。升级已有部署前应先备份数据库，并按部署文档记录升级前后的用户数、进度记录数和最近更新时间。

## 本地开发

```
cd /Users/lx100/projects/HTML-GitHub        # HTML- 与 Science-Lab 的父目录
python3 -m http.server 8788 --bind 127.0.0.1
# 打开 http://127.0.0.1:8788/Science-Lab/index.html?base=/HTML-/
```

移动端视口审阅使用 `HTML-sources-private/tools/review/mobile-review-wrapper.html`（端口 8766），流程同内容仓库惯例。
