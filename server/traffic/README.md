# 私有访问看板维护

入口：[访问观察台](https://lab.xingnian.net.cn/admin/traffic/)。使用独立随机密码，Nginx在HTTPS入口校验；本机凭据文件只允许当前用户读取，服务器仅保留SHA-512 crypt散列。服务器不保存明文密码。改密码时通过已授权SSH连接替换散列文件并更新本机私有凭据，不能从散列恢复原密码。

## 文件与职责

| 位置 | 内容 |
| --- | --- |
| `/opt/science-lab-traffic/` | 统计运行文件及Nginx配置源文件，由root维护 |
| `/var/lib/science-lab-traffic/www/index.html` | 私有历史报告，完整生成后原子替换 |
| `/var/lib/science-lab-traffic/www/quota.json` | 独立分钟额度快照，与HTML使用相同BasicAuth，不含身份或凭据 |
| `/var/lib/science-lab-traffic/history.json` | 400天每日汇总，权限0600，不对外映射 |
| `/var/lib/science-lab-traffic/update.lock` | 更新互斥锁，进程结束后自动释放 |
| `/var/log/nginx/science-lab-ai-access.log` | 不含IP、浏览器、来源和正文的内置AI匿名JSON日志 |
| `/var/log/science-lab/ai-events.log` | Node请求最终结果；不含正文或身份，保留10份每日轮转 |
| `/etc/nginx/conf.d/science-lab-ai-log-format.conf` | `http`上下文中的匿名AI日志格式 |
| `/etc/science-lab-traffic.env` | AI统计实际启用时间；非密钥，root:root、0600 |
| `/etc/nginx/science-lab-traffic.htpasswd` | 密码散列，root:nginx、0640，不对外映射 |
| `/etc/systemd/system/science-lab-traffic.service` | 受限的一次性更新任务，复用现有Node22运行时 |
| `/etc/systemd/system/science-lab-traffic.timer` | 北京时间每个双数整点更新，开机补跑错过的执行 |

准确的10个运行文件是 `traffic-report.cjs`、`traffic-ai-report.cjs`、`traffic-ai-outcomes.cjs`、`traffic-dashboard.cjs`、`traffic-dashboard-view.cjs`、`traffic-dashboard-client.js`、`traffic-dashboard.css`、`traffic-dashboard-ai.css`、`traffic-quota-view.cjs`、`ai-quota-snapshot.cjs`，不要把整个仓库部署到统计目录。`www`上级目录为root:nginx、0750，网页为0644；历史数据为0600。

## 更新与检查

通过现有SSH连接在服务器运行：

```bash
systemctl status science-lab-traffic.timer --no-pager
systemctl show science-lab-traffic.timer -p NextElapseUSecRealtime
systemctl start science-lab-traffic.service
systemctl show science-lab-traffic.service -p Result -p ExecMainStatus
journalctl -u science-lab-traffic.service -n 20 --no-pager
```

定时器每2小时运行一次，页面每分钟检查是否产生更新快照，下载直接从当前页面内嵌的汇总生成，不发起额外计算。手动执行更新仍按最近双数整点截取窗口，不把未结束的小时混入报告。生成失败时保留旧HTML；页面在预计更新时刻后5分钟显示“更新延迟”。仅关闭浏览器不影响服务器定时任务。

更新生成器前备份上述运行文件，先在本地跑统计测试，随后成组安装到 `/opt/science-lab-traffic/`（在任务不运行时操作），手动运行一次服务并验证输出；失败时成组恢复旧文件，原报告保持可用。只改生成器无需reload Nginx。若改定时服务，先用 `systemd-analyze verify` 验证再 `systemctl daemon-reload`；若改Nginx，先备份、`nginx -t`、再reload并等待新worker接管。

服务没有网络访问能力，文件系统默认只读，仅允许写自己的状态目录，并限制128MB内存、90秒执行时长。不要随意修改 `--collection-start`，该时间决定未采集时段和首日归档口径。数据量明显增长后应检查运行时间和内存，而非直接提高限制。

日志权限是发布前置条件：Nginx重新打开日志时会将所有者改为worker用户（当前为nginx），不能只测试初建时root所有的日志。服务清空了额外系统能力，依赖root组的正常读取权限；普通日志和匿名AI日志都使用 `nginx:root`、0640，日志目录应允许root组读取和进入。仅在核实路径、所有者和组后，可分别修复 `/var/log/nginx/science-lab-access.log` 与 `/var/log/nginx/science-lab-ai-access.log`；不放宽其他文件，不授予跨系统文件的读取能力。

同时必须核对轮转创建规则保留root组读取权限：当前服务器 `/etc/logrotate.d/nginx` 已有 `create 0664 nginx root`，新建文件满足读取条件，本次没有修改这一规则。若迁移到新服务器，建议专用规则使用 `create 0640 nginx root`，并验证实际轮转后的读取。不要把初始文件创建为0600：所有者被Nginx改成nginx后会导致统计中断。2026-09-08故障与验证记录见 `docs/review-2026-09-08-traffic-log-permissions.md`。

## 数据与边界

- 统计区间为最近双数整点往前24小时，含开始、不含结束，始终补齐24个小时桶；采集前标为空缺。没有记录无法区分无人访问、缓存离线或服务器中断。
- 访客组合只在内存中去重，不进入持久文件。CSV含24小时汇总及小时明细，或每日历史；逐行访客数不可相加作为跨时段人数。归档按日期覆盖，反复运行不会重复累加。
- AI统计只包含本站内置模式；BYOK由浏览器直连第三方，不在统计范围。专用日志只记录时间、HTTP状态、请求耗时、响应字节、实验哈希、上下文消息数和输入字符数，不保存问题或回答正文、API Key、IP、浏览器、来源或用户身份。
- Node只把已校验实验路径的定长哈希和消息长度交给Nginx，不把 `context` 转发给DeepSeek；Nginx会隐藏这些内部响应头。当前24小时实验排行通过当前 `manifest.json` 映射，未知哈希统一归类，排行不写入400天历史。
- HTTP 2xx只说明流式接口已建立，不能证明浏览器收到 `[DONE]`。平均耗时只计算2xx并包含响应传输；响应字节不是token数。Nginx在代理前返回的429没有实验或上下文元数据，但仍计入AI请求与限流。
- AI覆盖时间独立于原流量采集时间。`/etc/science-lab-traffic.env` 的 `AI_COLLECTION_START` 必须写实际启用的UTC时间；之前为“未采集”，跨越启用时刻为“部分采集”，不能填成零。首次运行会把历史schema 1迁移为schema 2，保留旧流量并将旧AI字段标为未采集。
- 原始日志轮转规则未变。每日汇总最多400天，仅保存已结束的自然日，首日标记部分采集。保留日志中的第一个不完整日不覆盖已归档数据。首次启用无历史时下载按钮暂不可用。
- 不读取旧混合日志；损坏压缩日志、无法解析的记录或损坏历史文件会明确失败并保留旧页面，需查明原因再恢复，不能默默丢弃原始日志或重建空历史。
- 原始日志、历史状态和凭据均不能放入Web目录或Git。统计页面自身访问不写访问日志，公开App缓存也不拦截这两个私有页面路径。
- 页面与下载文件共享同一内嵌快照，使用脚本散列限制可执行脚本，响应设置no-store、noindex、nosniff、no-referrer和禁止嵌入。

## AI 观测升级（待发布配置）

此次代码修改不自动改生产配置。新能力沿用现有云服务器与额度Redis，不增加收费监控服务；也不读取供应商账单。

新增 Node `ai-events.js`，由 `AI_EVENT_LOG_PATH` 启用。记录每个到达 Node 的请求最终结果、耗时与匿名长度计数；每请求最多一条。服务端看到有效 SSE `[DONE]` 才记 `completed`，不保证浏览器送达或客户端业务校验通过。取消、超时、上游错误、缺少模型配置、Redis故障分别统计。首内容耗时从请求开始到首个非空正文片段，排除仅响应头和心跳。预响应头取消的HTTP状态为空，不虚构499。

日志写入为有界、尽力而为：磁盘故障或队列满会发固定无敏感告警而不阻断聊天；因此结果计数是已观察样本，不保证与HTTP请求数相等。生产必须监测 `journalctl -u science-lab-api.service` 中的 `[ai-events]` 告警。日志轮转后的第一个可能残缺日不覆盖旧归档。无法还原的旧结果为未知，绝不把200补记完成。

Nginx 新格式额外记录 `quotaScope` 和 `upstreamStatus`，区分IP分钟／日、会话日、全站日、并发和入口限流。解析器同时支持旧七字段与新九字段；旧日志无原因时保留未知。CSV完整导出400、其他状态及AI、终态各自的采集状态。规则／实验资料与对话字符在v2结果日志拆分；旧输入长度不回算、不冒充token。

原始HTTP 5xx总数不改，另分类 `/api/` 下停用接口的503（排除健康检查和当前AI接口），只适用于当前已确认的AI-only部署。不能把扫描量等同真实用户故障；未来恢复同步接口时必须同步调整分类规则。旧历史没有分类证据时两项为空。

额度快照每分钟运行独立service，读取现有 `/etc/science-lab-api.env`，通过 `SCIENCE_LAB_API_DIR` 复用API的redis依赖。读取TIME、GET、PTTL、ZCOUNT不修改任何键，2秒截止、不重试。仅返回全站计数、滚动到期时间、有效并发及Redis可读状态，不代表模型供应商健康或余额。读取失败写未知状态，发布失败保留旧文件；网页超过3分钟提示过期。HTML两小时任务仍保留 `PrivateNetwork=true`。

上线顺序（需单独授权，先备份代码、配置和私有历史）：

1. 先部署兼容解析器及全部10个统计文件，验证旧日志和历史正常；随后才切换Nginx九字段格式。否则旧解析器会拒绝新记录。准备时暂停统计timer并确认任务已结束，成功后恢复。
2. 核实日志路径无符号链接。建立 `/var/log/science-lab` 为 `science-lab:root`、**2750**（setgid确保新文件保留root组），以非覆盖方式创建 `ai-events.log` 并设 `science-lab:root`、0640。安装 `ai-events.logrotate` 到独立规则，先 `logrotate --debug` 检查，禁止copytruncate。API和统计服务都不需要放宽其他日志权限。
3. 成组发布API（含 `ai-events.js`），安装 `science-lab-api-observability.conf` 为该service的 `observability.conf` drop-in。记录真实启用UTC时刻到 `/etc/science-lab-traffic.env` 的 `AI_EVENT_COLLECTION_START`，保留已有 `AI_COLLECTION_START` 不变。不得回填旧时间。
4. 只有新日志已准备并可读、启用时间已填写后，安装 `science-lab-traffic-observability.conf` drop-in。缺少日志或非法记录会明确失败并保留旧HTML，不会重置历史。
5. 安装额度snapshot service/timer；使用 `systemd-analyze verify` 检查service及drop-in，`systemctl daemon-reload` 后手动启动snapshot service并确认快照字段及权限，再启用分钟timer。它需要主机回环网络，不能套用HTML任务的网络隔离。当前Redis位于127.0.0.1:16379；连接凭据只存在私有环境文件，不输出。
6. 更新受保护Nginx页面allowlist，**只有** `index.html`、目录入口和 `quota.json` 可读；二者都通过相同BasicAuth，其他文件404。`nginx -t` 后reload，验证未认证HTML和JSON均401、敏感路径404、已认证JSON no-store。手动生成报告，检查CSV、手机和额度过期提示；不要用真实模型调用做无谓付费验收。

回退本升级时先停用新的分钟timer与终态drop-in；保留新日志和历史。Nginx一旦已写九字段日志，不能直接退回只接受七字段的旧解析器；应保留兼容解析器或使用升级前静态报告，不能删除新日志来使旧版本启动。额度读取不可用不影响AI配额执行。

## 原看板回退

兼容注意：部分旧内核不支持systemd的BPF IP防火墙，出现该警告时不能把IP过滤视为已生效。采样程序另行只接受 `127.0.0.1` 或 `::1` 的Redis地址，拒绝远程主机；这不是进程级网络防火墙的替代声明。认证握手需要多个内部命令，因此队列保留16个有界槽位，实际采样仍只有一条只读EVAL、2秒超时且不重试。

先停用本任务定时器：`systemctl disable --now science-lab-traffic.timer`。需要移除网页入口时，从已核验的站点配置备份恢复，执行 `nginx -t` 后reload并验证公开首页/API。保留已生成的汇总和凭据文件，避免在回退时丢失数据。

首次上线备份与验证证据见 `docs/superpowers/plans/2026-09-07-rolling-traffic-dashboard.md`。历史数据应自行定期下载到私有存储；服务器上的400天归档不等于异地备份。
