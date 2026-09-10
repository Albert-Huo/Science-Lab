# 统计观测升级发布验收 — 2026-09-10

用户在本地验收后明确授权提交、推送并部署。所有时间为北京时间，另列采集UTC时间；未调用付费模型、未改变额度或密钥，未引入收费服务。

## 版本与部署

- 功能提交：`6524a50`；认证Redis兼容补丁：`6ca8a7e`，均已推送 `origin/main`。
- API：`/opt/science-lab-api-current` → `/opt/science-lab-api-releases/20260910-6524a50`。
- 统计：`/opt/science-lab-traffic/`，10个运行文件已更新，额度采样包含 `6ca8a7e` 修正。
- 公开静态页面保持 `/var/www/science-lab-releases/20260910-5cc08bd`，未重新发布实验页面。
- 17个API/统计运行文件与仓库逐字节SHA-256核对一致。公开首页响应与服务器当前静态文件SHA-256一致。
- 备份：`/var/backups/science-lab/traffic-20260910-6524a50`，root私有，含原统计代码、历史、报告、Nginx配置、API/统计unit及API drop-in。
- 暂存及验收脚本：`/var/tmp/science-lab-traffic-20260910-6524a50`，root私有，保留便于回退核查。

先暂停统计timer、备份并生成影子报告，再安装兼容解析器。确认真实额度快照可用且有效并发为0后切换API；最后启用新Nginx格式、结果日志、分钟timer并恢复原统计timer。

## 配置与权限

- 原 `AI_COLLECTION_START=2026-09-10T01:03:25Z` 未改。
- 新 `AI_EVENT_COLLECTION_START=2026-09-10T03:29:33Z`，即11:29:33开始终态采集。
- API `observability.conf` 启用 `/var/log/science-lab/ai-events.log`；目录 `science-lab:root 2750`，日志 `science-lab:root 0640`。
- 专用logrotate每日轮转、保留10份，不使用copytruncate。已实际轮转一次，新文件及归档均0640；再次发送无效请求后，新文件成功追加，解析器同时读取新旧文件。
- `science-lab-ai-quota-snapshot.timer` 每分钟运行，复用现有带密码Redis 6.2.20；HTML统计继续每两小时生成且保持网络隔离。
- `quota.json` 为0644，位于原受BasicAuth保护的www下。只有目录入口、index.html、quota.json放行，其余文件404。

## 部署中发现并修复的问题

第一次切换前快照检查失败，API保持旧版本，统计timer恢复。定位到 `commandsQueueMaxLength:1` 无法容纳认证握手内部命令；此前无密码Redis测试未覆盖该条件。

新增带密码真实Redis回归测试，先复现失败，再改为16个有界队列槽。实际业务仍仅一条只读EVAL、2秒截止、不重试。修正后本地与服务器隔离Redis测试均通过，真实生产快照可读。

服务器systemd239/内核不支持BPF IP防火墙，`IPAddressDeny`/`IPAddressAllow`不能视为实际生效。代码新增只接受127.0.0.1或::1的Redis地址约束，并保留最小文件权限。该约束不是完整进程级网络防火墙；未改全局防火墙或内核。

## 验收证据

- 完整 `npm test --prefix server/api` 通过，新增观测套件25/25；`npm run test:redis --prefix server/api` 通过。
- 服务器Linux针对性测试22/22；带认证Redis 6采样测试10/10，证明计数、并发集合与过期时间未改变。
- `systemd-analyze verify` 和 `nginx -t` 通过（上述BPF支持警告已明确记录）。API运行中，两个timer运行中，统计及分钟采样服务最近执行均success/0；已观察到分钟任务按时再次执行。
- 未认证HTML与quota.json均401；history.json、.env均404；已认证HTML与quota.json均200且no-store。
- 公开首页及 `/api/health` 均200。
- HTTPS验收发送4条故意缺失实验参数的无效AI请求，均400，在调用模型及扣共享额度之前拒绝；对应4条 `invalid_request` 终态，轮转后新文件含1条。测试请求会进入匿名AI计数，需避免将少量样本误读为真实故障率。
- Nginx新九字段日志与旧日志均解析成功。发布时影子及正式报告仍为10:00截止窗口：854总请求、70入口、45访客估算、2条AI请求。原49条5xx均分类为预期停用接口503，其他服务端5xx为0。
- 3天既有历史所有原字段逐项保持不变。CSV为58列，26行（表头、24小时汇总、24个小时），各行列数一致。
- 11:30采样：已用2/500、剩余498、有效并发0/5。统计窗口仍截止10:00，因此新终态显示未采集是正确表现；12:00期开始包含11:29之后的结果。

## 回退边界

API旧release及所有备份保留。若需回退，先停止新分钟timer、恢复API链接和对应drop-in，并验证健康。不得删除历史或原始日志。已经产生九字段Nginx日志，不能直接启用只接受七字段的旧生成器；保留新兼容解析器或使用备份静态报告，细节见 `server/traffic/README.md`。
