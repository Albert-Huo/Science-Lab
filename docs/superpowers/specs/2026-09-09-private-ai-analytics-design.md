# 私有 AI 交互统计设计

用户已批准：仅统计本站内置 AI，不统计 BYOK；只保存匿名汇总元数据，不上传或保存问题、回答等聊天正文。

## 目标与边界

在现有受密码保护的 `/admin/traffic/` 访问观察台中增加 AI 交互统计，继续复用每两小时生成一次自包含快照、每日归档 400 天和 CSV 下载的现有链路。

统计范围只包括 `POST /api/ai/chat/completions`：

- 记录请求量、HTTP 2xx、400、429、5xx、耗时、响应字节数、上下文消息数、输入字符数和实验分类。
- 不记录问题、回答、请求体、API Key、IP、User-Agent、Referer、账号、设备身份或可跨请求关联的标识。
- BYOK 由浏览器直连第三方，服务端不可见且明确标为不在统计范围内；不增加客户端遥测补报。
- “HTTP 2xx”只表示流式接口成功建立，不能保证浏览器最终收到 `[DONE]`，页面不得将其表述为完整回答成功率。

## 方案选择

采用专用匿名 AI 日志，而不是扩展现有含 IP 的 combined 日志，也不增加浏览器遥测接口。

Nginx 的 AI 精确 location 使用独立 JSON 日志格式。该 location 不继承普通访问日志，避免同一条 AI 请求直接携带 IP、浏览器和来源信息。统计生成器同时读取普通访问日志与 AI 日志：AI 行仍计入“全部请求”和 4xx/5xx 汇总，但不会参与入口访客、设备、来源或自动化请求识别。

专用日志每行只包含：

```json
{
  "time": "2026-09-09T12:00:00+08:00",
  "status": "200",
  "duration": "3.428",
  "bytes": "1532",
  "experiment": "64位十六进制哈希或空字符串",
  "messages": "5",
  "inputChars": "820"
}
```

`duration` 使用 Nginx `$request_time`，反映服务端从收到请求到完成发送的总时长，包含客户端连接影响，不冒充纯模型推理耗时。`bytes` 使用 `$body_bytes_sent`，作为响应流量而非 token 数。

## 匿名元数据流

客户端仅在内置模式的请求体中增加 `context.experimentPath`，值来自已加载的 `manifest.json`；BYOK 请求体保持原样。

Node 在消息通过现有校验后：

1. 对实验路径截断和定长哈希，只通过内部响应头交给 Nginx；不把路径或 `context` 转发给 DeepSeek。
2. 从已规整、实际转发的 `messages` 计算消息数和字符总数。
3. 响应头只含固定长度哈希和非负整数；Nginx 记录后通过 `proxy_hide_header` 不向公网客户端暴露。

任意未知实验路径在日志中也只会留下定长哈希。统计生成器读取当前 `manifest.json`，仅将可匹配哈希映射为实验标题；其余统一归入“未知实验”，不把原始值带入历史文件或网页。

Nginx 自身在代理前返回的 429 没有上游元数据，仍计入 AI 请求和限流，但实验、消息数及字符数视为未知。

## 聚合模型与兼容性

现有 24 小时总计、24 个小时桶和每日历史增加嵌套 `ai` 指标：

- `requests`
- `httpSuccesses`
- `invalidRequests`
- `rateLimited`
- `serverErrors`
- `otherStatuses`
- `durationMsTotal` 与 `durationSamples`
- `responseBytes`
- `messageCountTotal` 与 `messageSamples`
- `inputCharsTotal` 与 `inputSamples`
- 当前窗口内按已知实验哈希聚合的 2xx 请求数

平均耗时、平均消息数、平均输入字符数和平均响应流量均由总和与样本数计算，不保存单次分布。实验排行只在当前原始日志可覆盖的滚动窗口中展示，不写入 400 天历史，避免长期保留细粒度学习兴趣数据。

数据快照 schema 从 2 升到 3，历史 schema 从 1 升到 2。首次运行可读取 schema 1 历史并迁移：既有流量字段原样保留，AI 字段标为 `unavailable`，不能补成零。新增 `--ai-collection-start` 参数；覆盖起点所在小时和自然日标为 `partial`，此前标为 `unavailable`，之后标为 `recorded`。

AI 日志缺失、格式损坏、数值越界或历史文件损坏时，生成任务失败并保留上一份完整页面，延续现有 fail-closed 行为。

## 看板与下载

访问观察台增加“AI 交互（仅内置模式）”区域：

- 24 小时 AI 请求、HTTP 2xx 比例、429 限流、5xx、HTTP 2xx 平均耗时。
- 小时趋势增加“AI 请求”和“AI 2xx”选项，未采集时段继续使用斜纹和破折号。
- 展示状态分布、平均上下文消息数、平均输入字符数、平均响应流量和当前窗口热门实验。
- 方法说明明确 BYOK 排除、2xx/SSE 局限、耗时与字节口径，以及不保存聊天正文。
- 当前与历史 CSV 增加 AI 聚合列；AI 未采集时输出空单元格，不写成零。

页面继续保持自包含、CSP 脚本哈希、无外部资源、no-store、noindex 和 Basic Auth。统计页自身访问仍不写日志。

## 部署、验证与回退

本地先按 TDD 覆盖 AI JSON 解析、匿名字段约束、双日志合并、时间覆盖、schema 迁移、CSV、CSP、客户端请求体以及服务端响应头。新增 AI 样式独立放入 `traffic-dashboard-ai.css` 并继续内联到单文件页面，避免重写现有单行压缩 CSS。完整测试通过后才进入提交、推送和部署，且部署前再次取得用户确认。

生产部署需先只读核对 Nginx `http` include、站点 location、logrotate 和 systemd 实际配置。随后按顺序：

1. 备份 API、统计运行文件、Nginx、logrotate、systemd unit 和当前报告。
2. 安装 API 与统计文件，配置匿名 AI `log_format`、专用日志和轮转权限。
3. 执行 `nginx -t` 与 `systemd-analyze verify`，再 reload/restart。
4. 将实际启用时间写入 `--ai-collection-start`，手动生成一次报告。
5. 验证公开首页、API 健康、真实 SSE、私有页面、日志匿名性和统计更新。

任一步失败即恢复对应备份、reload/restart 并验证旧版页面/API；历史文件和现有报告不删除。回退后专用日志可以保留在非 Web 目录供人工审计，不作为恢复前置条件。
