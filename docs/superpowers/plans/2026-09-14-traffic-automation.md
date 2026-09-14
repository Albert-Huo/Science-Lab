# 访问自动化分类实施计划

> 执行方式：本任务内按 superpowers:executing-plans 顺序实现与自检；上线前按 superpowers:requesting-code-review 进行独立复审。用户已指定最终提交推送部署，无需再次选择集成方式。

**目标：** 在现有私有观察台增加保守、可解释、可复核的自动化分类。

**架构：** 两遍流式读取同一独立访问日志，首遍建立按日观察，第二遍保持原始指标并添加互斥分类。独立任务更新公开爬虫来源清单，报表生成器仍禁止网络。

**技术：** Node.js 原生模块、现有自包含 HTML/CSS/JS、node:test、systemd。

## 1. 判定与官方清单

- [x] 新增 `server/api/test/traffic-automation.js`，先运行 `node --test server/api/test/traffic-automation.js` 确认新行为缺失。
- [x] 新增 `tools/traffic-automation.cjs`：`createDetector({botRanges})` 提供 `observe(record)`、`seal()`、`classify(record)`；`automationBucket()`、`addAutomation(bucket,record,decision)`、`cleanAutomation(value,requests,entryRequests)` 保证输出定长、互斥和去标识。
- [x] 新增 `tools/traffic-bot-ranges.cjs`：IPv4/IPv6 CIDR 校验、`loadBotRanges(file,now)` 与有界官方 GET 更新器。新测试覆盖拒绝伪造身份、旧清单失效、坏清单失败保留旧文件。
- [x] 运行上述测试，确认零失败，再进入集成。

## 2. 集成与历史

- [x] 修改 `tools/traffic-dashboard.cjs`，保留原有字段，添加分类、原入口分类和规则原因；专用匿名 AI 只加未判定。
- [x] 在 `server/api/test/traffic-dashboard.js` 补时间边界、计数分区、历史兼容、隐私及发布失败不覆盖测试，先红后绿。
- [x] 原入口计数与新版本影子输出逐项比较；旧历史没有分类时 `automation=null`，新增历史分类严格白名单校验。

## 3. 页面、CSV 与维护

- [x] 在 `server/api/test/traffic-dashboard-view.js` 先添加分类/CSV/旧历史未知测试。
- [x] 修改 `tools/traffic-dashboard-view.cjs`、`tools/traffic-dashboard-client.js`，新增分类面板、规则原因、趋势切换、小时明细及 CSV 列。
- [x] 新增 `tools/traffic-dashboard-automation.css`，沿用现有深色观察台，手机分级换行、表格局部滚动，不引入外部资源。
- [x] 更新 `server/api/package.json` 测试入口与 `server/traffic/README.md`；新增官方清单每日 service/timer，维护新文件清单。
- [x] 运行 `node --test server/api/test/traffic*.js`、`npm test`，核验脚本 CSP 散列及全套回归；独立无头会话检查 1440px 与 390px 布局、分类趋势及 CSV 下载。

## 4. 复审与发布

- [x] 独立复审 diff，同时检查规则误判与部署回退；修复重要意见后重新测试。
- [x] 只提交已识别的任务文件，在 main 快进合并并 `git push origin main`，禁止强推。
- [x] SSH 只输出匿名汇总；验证实际远端路径和服务，再上传精确运行文件与测试到唯一暂存目录。
- [x] 备份 `/opt/science-lab-traffic`、私有状态及相关任务配置；影子生成比较原始请求/入口/错误计数，核验 Linux 测试和资源占用。
- [x] 暂停报表定时器并等现有任务结束，成组安装、生成报表，恢复定时器并验证官方清单每日更新。
- [x] 已认证报告/JSON 200、未认证 401、敏感文件 404、公开首页/健康接口正常；下载字段与页面同源，记录发布证据与备份位置。

## 上线前验证证据

- 流量测试63/63通过，独立复审无剩余重要阻塞项，`git diff --check`通过。
- Linux隔离暂存目录完整`npm test`退出0；复用已有Node22及Python3.9，不安装服务或改生产环境。可选独立redis-server集成测试因环境不可用跳过1项，其余观测42项通过；生产额度任务未改。
- 真实日志旧/新生成器所有totals与24小时字段（除新增automation）逐项deepEqual。窗口总1223、入口115、组合71；分类6/635/127/455，未标记入口113。影子生成0.75秒、max RSS91972KB。
- 1440×1000桌面及390×844手机截图检查完成，手机页面scrollWidth=390、明细表局部滚动；图表切换、规则展开及实际下载CSV（26行、77列）通过。任务独立无头会话已关闭。
- 红绿修复复审发现的全局观察预算、查询字符串底层滞留、日级历史擦除和UA词片段误判。旧流式事件测试读取刚打开/未换行完成日志的竞态已补确定性测试，只调整测试轮询，不改API行为。

2026-09-14 11:02北京时间上线代码`5d6a581`；生产两家官方清单有效，四类计数为6/635/131/451（最后补入明确AI爬虫声明的有限token）。备份与完整线上验收见[发布记录](../../review-2026-09-14-traffic-automation-deployment.md)。
