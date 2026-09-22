# 私有访问看板维护

入口：[访问观察台](https://lab.xingnian.net.cn/admin/traffic/)。使用独立随机密码，Nginx在HTTPS入口校验；本机凭据文件只允许当前用户读取，服务器仅保留SHA-512 crypt散列。服务器不保存明文密码。改密码时通过已授权SSH连接替换散列文件并更新本机私有凭据，不能从散列恢复原密码。

## 文件与职责

| 位置 | 内容 |
| --- | --- |
| `/opt/science-lab-traffic/` | 统计运行文件及Nginx配置源文件，由root维护 |
| `/var/lib/science-lab-traffic/www/index.html` | 私有历史报告，完整生成后原子替换 |
| `/var/lib/science-lab-traffic/www/quota.json` | 独立分钟额度快照，与HTML使用相同BasicAuth，不含身份或凭据 |
| `/var/lib/science-lab-traffic/www/analytics.json` | 无身份产品统计快照，与HTML使用相同BasicAuth，不含访客标识或原始事件 |
| `/var/lib/science-lab-traffic/history.json` | 400天每日汇总，权限0600，不对外映射 |
| `/var/lib/science-lab-traffic/update.lock` | 更新互斥锁，进程结束后自动释放 |
| `/var/log/nginx/science-lab-ai-access.log` | 不含IP、浏览器、来源和正文的内置AI匿名JSON日志 |
| `/var/log/science-lab/ai-events.log` | Node请求最终结果；不含正文或身份，保留10份每日轮转 |
| `/etc/nginx/conf.d/science-lab-ai-log-format.conf` | `http`上下文中的匿名AI日志格式 |
| `/etc/science-lab-traffic.env` | AI统计实际启用时间；非密钥，root:root、0600 |
| `/etc/nginx/science-lab-traffic.htpasswd` | 密码散列，root:nginx、0640，不对外映射 |
| `/etc/systemd/system/science-lab-traffic.service` | 受限的一次性更新任务，复用现有Node22运行时 |
| `/etc/systemd/system/science-lab-traffic.timer` | 北京时间每个双数整点更新，开机补跑错过的执行 |
| `/etc/science-lab-analytics.env` | 产品统计回环Redis连接、同源地址和真实启用时刻，root:root、0600 |
| `/etc/science-lab-analytics-redis.conf` | 独立Redis配置及密码，root:redis、0640 |
| `/var/lib/science-lab-analytics-redis/` | 独立AOF数据目录，redis:redis、0700 |

准确的18个运行文件是 `traffic-report.cjs`、`traffic-ai-report.cjs`、`traffic-ai-outcomes.cjs`、`traffic-dashboard.cjs`、`traffic-dashboard-view.cjs`、`traffic-dashboard-client.js`、`traffic-dashboard.css`、`traffic-dashboard-ai.css`、`traffic-dashboard-product.css`、`traffic-quota-view.cjs`、`ai-quota-snapshot.cjs`、`product-analytics-snapshot.cjs`、`product-analytics-view.cjs`、`traffic-automation.cjs`、`traffic-bot-ranges.cjs`、`traffic-dashboard-automation.css`、`traffic-risk-view.cjs`、`traffic-dashboard-risk.css`，不要把整个仓库部署到统计目录。`www`上级目录为root:nginx、0750，网页为0644；历史数据为0600。

运行与风险主视图依据现有24小时日志给出排查提示，每2小时更新，不是实时健康检查。规则详见页面“什么情况下需要关注”；爬虫占比不单独报警，预期停用503不算故障，过期、部分采集、零请求显示未知。技术分类默认折叠，原始CSV口径不变；额度提示来自独立分钟快照，不代表模型服务健康。

## 无身份产品统计运行时

安全日志与产品统计严格分离，是两套目的、存储和权限边界不同的链路。浏览器只发送固定白名单事件；Nginx的专用入口日志不含IP、UA、Referer、Cookie、URI、query或请求正文；Node直接向独立Redis的小时／每日Hash累加，不保存原始事件。普通安全日志仍用于防攻击与排障，但不得用于回算产品UV、会话或访问路径。后台因此固定显示“UV未采集”“会话未采集”和“实验完成事件未接入”。

独立Redis使用 `127.0.0.1:16380`，与默认6379及AI额度16379均不复用。该端口已在2026-09-21只读检查为未占用；每次生产启用前仍必须即时复核监听进程，若已占用应停止部署并查明，不能擅自换端口后继续。私有配置至少包含：

```conf
bind 127.0.0.1 ::1
protected-mode yes
port 16380
dir /var/lib/science-lab-analytics-redis
appendonly yes
appendfsync everysec
save ""
maxmemory 32mb
maxmemory-policy noeviction
requirepass <独立随机密码>
```

`/etc/science-lab-analytics-redis.conf` 必须为root:redis、0640；数据目录为redis:redis、0700。`noeviction` 是刻意选择：达到32mb上限时统计写入明确失败，公开网站与AI继续可用，不能静默逐出旧计数造成数字失真。AOF应纳入服务器私有备份，但不是用户行为原始记录。

`/etc/science-lab-analytics.env` 必须为root:root、0600，不得提交Git或输出到终端／日志：

```ini
ANALYTICS_REDIS_URL=redis://:<同一独立随机密码>@127.0.0.1:16380/0
ANALYTICS_ORIGIN=https://lab.xingnian.net.cn
ANALYTICS_COLLECTION_START=<首次成功开放入口前的真实UTC毫秒时间，如2026-09-21T08:21:26.000Z>
ANALYTICS_RATE_LIMIT_PER_MINUTE=600
```

安装 `science-lab-analytics-redis.service`、API的 `analytics.conf` drop-in、产品快照service/timer后，先执行 `systemd-analyze verify`，再daemon-reload。API仅 `Wants` 独立Redis：统计存储故障不得阻止API启动。快照每5分钟只读回环Redis并原子替换 `analytics.json`；读取失败保留上一份有效快照。部分旧内核不能执行systemd的IP过滤时，应用仍会拒绝非回环Redis URL，但必须记录该降级，不能宣称进程级网络隔离已生效。

`ANALYTICS_COLLECTION_START` 必须直接使用 JavaScript `new Date().toISOString()` 的规范结果，包含三位毫秒和结尾 `Z`；秒级字符串会被快照服务判为 `invalid_config`，避免不同解析器对时间边界作出不同解释。

Nginx的 `nginx-product-analytics.conf` 必须安装到 `http {}` 上下文；`nginx-locations.conf` 只放入HTTPS `server`。专用location关闭普通请求头透传、清空身份相关头并覆盖server级access log。日志 `/var/log/nginx/science-lab-product-analytics.log` 应为nginx:root、0640并沿用受控轮转；其字段只有时间、状态、耗时、请求长度和上游状态，不作为产品指标来源。上线前后均执行 `nginx -t`。

推荐启用顺序：创建并核验私有配置和数据目录 → 启动独立Redis并用不回显密码的方式执行 `PING` → 安装API drop-in并重启API → 手动运行快照 → 安装Nginx http配置与精确location并reload → 发送一个固定测试事件 → 验证Redis仅有 `science-lab:analytics:v1:*` 聚合键、私有快照可读且普通安全日志未记录该POST → 启用五分钟timer。不要使用真实AI调用验收本功能。

回滚时先禁用产品快照timer，再恢复Nginx备份并经 `nginx -t` reload，使浏览器事件变为尽力失败；随后移除API drop-in并重启API，最后停用独立Redis。保留AOF和最后一份私有快照供审计，不删除现有安全日志，不触碰AI额度Redis。若只发生统计故障，优先保留入口并排障；公开站点本身无需回滚。

## 更新与检查

通过现有SSH连接在服务器运行：

```bash
systemctl status science-lab-traffic.timer science-lab-product-analytics-snapshot.timer --no-pager
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

## 自动访问分类 v1

仅优化统计，不改变 Nginx 防护、AI 配额或访问权限。没有新增浏览器追踪或收费服务。原入口、访客去重、设备来源和 HTTP 计数保留；网页分别称“浏览器特征入口”“入口组合估算”，不宣称真人。

全部请求互斥分成已验证爬虫、高置信自动特征、疑似自动访问、未命中规则。原入口另按同一判定拆分，“未标记入口”为原入口中未命中规则的子集，不是实际用户数。AI 专用匿名日志不具备身份信息，统一加入未命中并单列数量。`automated` 旧 UA 指标保留用于 CSV 历史兼容，不等于来源已验证。

生成器两遍流式读取独立日志。首遍按北京时间同日 IP+UA 建立行为观察，第二遍将判定关联到同一组合的请求（包括其首页和资源）。只使用截至统计窗口结束的证据，不把之后的扫描反向应用。原因计数可重叠，不能相加，也不是路径条数。共享出口同 UA 可能混合用户；短刷新、单个404、凌晨、无Referer及静态资源突发不单独参与规则。成组探测为高置信；页面突发、规律导航及来源未验证的爬虫声明仅疑似。高置信不等于恶意，更不等于入侵成功。

总扫描最多100万行，包含两遍读取、空行、窗口外记录、AI及终态来源。观察最多8000个具备页面或探测证据的按日组合；只请求静态资源的组合不建立观察档案，UA工具或爬虫声明仍按当前请求直接分类。全局分钟桶最多16000、时间样本128000、保留字符串200万字符单元。每组敏感路径保留3个，页面规律采样保留按字典序前4个页面的最早64次请求；采样不足时不推断身份。原始行最多16KiB、组合标识2048、路径4096字符，保留字段复制为独立字符串，避免短切片滞留完整查询串。UA仅按有限产品token的完整边界匹配，避免设备名中的词片段误判。首遍结束后释放观察数据，只保留固定判定。超长输入、观察预算、分组上限、坏日志、坏历史、分类分区不一致均明确失败，保留旧页面。现有128MB/90秒限制不变。

新增 `science-lab-bot-ranges.service/timer` 每天北京时间05:40起、随机延迟5分钟更新两家官方公开IP清单：

- Google：[common-crawlers.json](https://developers.google.com/static/crawling/ipranges/common-crawlers.json)，连接失败时仅回退到同一 Google 官方开发者中国域名 `developers.google.cn` 下的相同路径。
- Bing：[bingbot.json](https://www.bing.com/toolbox/bingbot.json)。

仅 GET 固定 HTTPS 地址，拒绝重定向，单次下载4.5秒、整体10秒截止、每响应最多512KB，校验CIDR后原子写入 `/var/lib/science-lab-traffic/bot-ranges.json`（root:root、0600；不对外映射）。独立网络任务不读取日志、环境凭据或客户端地址，不向第三方发送用户数据。报表任务继续 `PrivateNetwork=true`，通过 `--bot-ranges-file` 只读本地清单。

来源独立更新：失败保留对应供应商原清单与原时间，其他供应商可继续更新。部分失败时任务报告失败以便排查，但已成功来源会正常保存；超过7天停止使用该来源验证。页面分别展示Google/Bing有效状态与时间。必须“对应爬虫UA声明 + 对应官方IP段”双匹配，不能仅凭Googlebot名称或Google云IP验证。其他爬虫仍未验证；正规来源也可保留探测行为标记。

历史仍为schema2、页面仍为schema3，新增白名单 `automation.version=1` 字段。旧记录无分类证据时为null，CSV分类列为空而非零；保留日志内的完整日可按v1回算，首个可能截断日仍不覆盖原历史。任一HTTP来源完全无观测时保留已归档的整份HTTP/分类分区（旧AI otherStatuses无法精确拆出4xx，不拼造），独立终态完整观测仍可更新；无观测不新建零归档，AI启用前无需AI日志证据。分类版本变化时应分开比较。网页、CSV、400天历史均不包含原始IP、UA、查询参数、完整路径、完整来源或会话标识；服务器私有官方清单包含的是爬虫供应商公开IP段，不是访问者地址。

部署前运行 `node --test server/api/test/traffic*.js` 与 `npm --prefix server/api test`。暂停统计timer、等任务结束、备份精确代码与私有状态，先在影子目录用真实日志比较原始指标，再成组发布13个运行文件。已有AI终态部署应更新其 `observability.conf` 以包含清单参数，不丢失现有启用时间。安装两个新增systemd文件，`systemd-analyze verify` 后daemon-reload，手动运行官方清单任务与报表任务，成功后启用每日timer及恢复两小时timer。不会重启公开API或reload Nginx。

```bash
systemctl start science-lab-bot-ranges.service
systemctl show science-lab-bot-ranges.service -p Result -p ExecMainStatus
journalctl -u science-lab-bot-ranges.service -n 10 --no-pager
systemctl start science-lab-traffic.service
```

回退时暂停两小时timer并停用新增每日timer，确认报表任务不运行；成组恢复旧统计代码和旧service/drop-in，再恢复备份HTML和私有历史（前提是暂停后尚无新归档；否则先备份当前状态并保留新增归档，避免丢失数据）。旧生成器会忽略新增字段，不要求删除原日志或官方清单。daemon-reload并恢复原timer。私有文件不能复制到公开Web根目录。

## AI 观测升级与配置

2026-09-10已按用户授权发布，见[发布验收记录](../../docs/plans/2026-09-10-traffic-production-deployment.md)。新能力沿用现有云服务器与额度Redis，不增加收费监控服务；也不读取供应商账单。

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
