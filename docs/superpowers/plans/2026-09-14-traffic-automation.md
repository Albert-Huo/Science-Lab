# 访问自动化分类实施计划

> 执行方式：本任务内按 superpowers:executing-plans 顺序实现与自检；上线前按 superpowers:requesting-code-review 进行独立复审。用户已指定最终提交推送部署，无需再次选择集成方式。

**目标：** 在现有私有观察台增加保守、可解释、可复核的自动化分类。

**架构：** 两遍流式读取同一独立访问日志，首遍建立按日观察，第二遍保持原始指标并添加互斥分类。独立任务更新公开爬虫来源清单，报表生成器仍禁止网络。

**技术：** Node.js 原生模块、现有自包含 HTML/CSS/JS、node:test、systemd。

## 1. 判定与官方清单

- [ ] 新增 `server/api/test/traffic-automation.js`，先运行 `node --test server/api/test/traffic-automation.js` 确认新行为缺失。
- [ ] 新增 `tools/traffic-automation.cjs`：`createDetector({now, botRanges})` 提供 `observe(record)`、`classify(record)`；`automationBucket()`、`addAutomation(bucket,record,decision)`、`cleanAutomation(value,requests,entryRequests)` 保证输出定长、互斥和去标识。
- [ ] 新增 `tools/traffic-bot-ranges.cjs`：IPv4/IPv6 CIDR 校验、`loadBotRanges(file,now)` 与有界官方 GET 更新器。新测试覆盖拒绝伪造身份、旧清单失效、坏清单失败保留旧文件。
- [ ] 运行上述测试，确认零失败，再进入集成。

## 2. 集成与历史

- [ ] 修改 `tools/traffic-dashboard.cjs`，保留原有字段，添加分类、原入口分类和规则原因；专用匿名 AI 只加未判定。
- [ ] 在 `server/api/test/traffic-dashboard.js` 补时间边界、计数分区、历史兼容、隐私及发布失败不覆盖测试，先红后绿。
- [ ] 原入口计数与新版本影子输出逐项比较；旧历史没有分类时 `automation=null`，新增历史分类严格白名单校验。

## 3. 页面、CSV 与维护

- [ ] 在 `server/api/test/traffic-dashboard-view.js` 先添加分类/CSV/旧历史未知测试。
- [ ] 修改 `tools/traffic-dashboard-view.cjs`、`tools/traffic-dashboard-client.js`，新增分类面板、规则原因、趋势切换、小时明细及 CSV 列。
- [ ] 新增 `tools/traffic-dashboard-automation.css`，沿用现有深色观察台，手机分级换行、表格局部滚动，不引入外部资源。
- [ ] 更新 `server/api/package.json` 测试入口与 `server/traffic/README.md`；新增官方清单每日 service/timer，维护新文件清单。
- [ ] 运行 `node --test server/api/test/traffic*.js`、`npm test`，核验脚本 CSP 散列及全套回归；独立无头会话检查 1440px 与 390px 布局、分类趋势及 CSV 下载。

## 4. 复审与发布

- [ ] 独立复审 diff，同时检查规则误判与部署回退；修复重要意见后重新测试。
- [ ] 只提交已识别的任务文件，在 main 快进合并并 `git push origin main`，禁止强推。
- [ ] SSH 只输出匿名汇总；验证实际远端路径和服务，再上传精确运行文件与测试到唯一暂存目录。
- [ ] 备份 `/opt/science-lab-traffic`、私有状态及相关任务配置；影子生成比较原始请求/入口/错误计数，核验 Linux 测试和资源占用。
- [ ] 暂停报表定时器并等现有任务结束，成组安装、生成报表，恢复定时器并验证官方清单每日更新。
- [ ] 已认证报告/JSON 200、未认证 401、敏感文件 404、公开首页/健康接口正常；下载字段与页面同源，记录发布证据与备份位置。
