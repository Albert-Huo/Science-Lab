# AI 助手优化实施记录

**目标：** 落实用户已批准的实验助手提示词、上下文、额度与聊天体验优化。

**设计：** 前端只提交实验路径与问答历史，Node 从随 API 发布的离线资料包生成系统提示。资料来自内容仓库的可追溯文字；未提供的实时操作状态明确未知。匿名签名 Cookie、IP 和全站请求额度共同保护公共接口，生产使用 Redis 原子共享计数，停机或故障不降级为无限调用。

**技术：** 原生 JavaScript、Express、Python 标准库内容构建器、Redis。沿用现有免登录和本地聊天记录。

用户于本任务明确批准执行，直接完成本地修改与验证；生产部署与供应商账户预算尚不在本次执行范围。代码不自动提交或发布。

后续授权：2026-09-10用户明确要求“提交推送并部署上线”，模型费用由用户自行控制。发布沿用当前main和现有ECS，不购买服务；复用已安装Redis程序启动独立AI额度实例，保留原6379实例。发布顺序为备份、隔离Redis验证、API、静态文件、生产验收，失败按相反依赖顺序回退；供应商设置仍不在执行范围。

- [x] 实验资料：新增 `tools/build-ai-context.py`、`server/api/ai-context.json` 和构建测试；138项来源资料、路径安全、`--check`、原子写入，缺失资料不编造。
- [x] 后端策略：新增 `server/api/ai-policy.js` 及测试；修改 `server/api/server.js`，验证实验路径，移除客户端 system，固定服务端身份/安全规则，按完整问答和总字符预算裁剪。
- [x] 聊天体验：修改 `index.html`、新增 `ai-chat.js`，支持停止、完整 SSE 校验、错误恢复和额度展示；部分回答可见但不进入后续上下文；同步 `sw.js`。
- [x] 费用保护：新增 `server/api/ai-quota.js` 及内存/真实 Redis 测试；签名匿名 Cookie、IP/会话/全站限额、全站并发租约；生产缺 Redis/密钥时拒绝启动，运行故障返回 503。
- [x] 部署契约：更新 `.env.example`、锁文件、README、NOTICE和部署指南；退役 Worker 示例为 410，避免另一条无保护付费代理。
- [x] 集成验收：`npm test --prefix server/api`、构建器 `--check`、`npm run test:redis --prefix server/api`均通过。隔离浏览器验证发送/额度、停止和HTML429恢复；预览/缓存/发布清单同步新增ai-chat.js。后续小修的受影响测试单独复跑通过。

关键验收用例：伪造 system/实验路径不会进入上游；历史裁剪保留完整问答；中途断流/停止不污染历史；两个实例不能突破共享全站额度；失败的额度存储不能触发模型请求；旧账号/进度模式仍通过现有测试。所有 AI 验证使用模拟上游。

默认保守全站额度500次/24h、每会话20次/24h、5并发。用户未回复异步额度问题，故保留原IP20次，不默认放宽到200；已提供可配置路径。请求额度不宣称等于固定货币预算。Redis上线需持久化与noeviction，供应商硬预算由管理员设置。

复核额外修复：畸形model对象触发String转换异常会令Express4进程退出，改为严格类型校验和async错误边界；Redis错误URL的构造异常可能包含凭据，改为固定脱敏异常；历史内存缓存同步200条/6000字符限制；资料包来自不同模式的片段不可被当作当前连续步骤，已明确写入提示词。

验证范围：自动测试与浏览器使用模拟模型响应，没有真实DeepSeek费用或现网配置修改。资料包中4项文字较少、10项截断、1项动态步骤数组不支持，详见ai-assistant.md。生成资料仍需教学内容抽查，模型真实回答质量未通过付费调用验证。浏览器图片在output/playwright/ai-assistant-mobile.png、ai-assistant-desktop.png；不是生产截图。

## 2026-09-10生产发布结果

- [x] 功能提交 `5cc08bdaa653bf99da2eb7dfc63a55501d5e4df4` 已推送 `origin/main`；仅提交34项功能/测试/文档文件，原未跟踪文件保留。
- [x] 本地完整npm测试、Redis集成测试、138项资料来源校验通过。服务器Node 22.23.2与Redis 6.2.20实测原子全站限额、跨进程保留、租约过期、故障返回通过；HTTP策略与17项启动模式测试通过。
- [x] API和静态release均为 `20260910-5cc08bd`，分别位于 `/opt/science-lab-api-releases/` 与 `/var/www/science-lab-releases/`，current链接均已切换。API先、静态后，健康检查及14个公开静态文件字节校验通过，未触发回滚。
- [x] 新增独立 `science-lab-quota-redis.service`，复用 `/usr/bin/redis-server`，仅监听127.0.0.1:16379；有密码、AOF everysec、64MiB/noeviction、192MiB服务总内存上限，开机启动。隔离验收命名空间写入额度后重启实例，下一次请求仍返回全站额度429，证明持久化保留。验收键24小时自动过期，不计入正式额度。
- [x] 原Redis 6379服务和 `/etc/redis.conf` 未修改，Nginx站点配置逐字节未变。API继续非root运行；私密环境文件600 root:root，Redis配置640 root:redis、数据目录700 redis:redis。签名密钥与Redis密码服务器随机生成，未写入Git或输出；DeepSeek Key原值保留。
- [x] 独立无界面浏览器对正式站点进行一次真实DeepSeek请求（温度计读数要求）：HTTP200、界面完整回答、两条完整问答记录且无中断标记、发送按钮恢复、无重试按钮，额度19/20。Secure/HttpOnly/SameSite=Lax签名Cookie验证通过；正式Redis计数1、活动并发0、AOF写入正常。未修改模型账户或预算。
- [x] 390×844手机布局文档宽390、无横向溢出，浏览器控制台0错误/0警告。生产截图 `output/playwright/ai-hardening-production-mobile.png`。浏览器唯一句柄 `task-b41e209c`，验证后精确关闭；未操作其他浏览器。

发布备份：`/var/backups/science-lab/ai-hardening-20260910-5cc08bd`（root-only），含旧API环境、API服务、Nginx配置及旧release指针。旧API/静态均为 `20260910-a9b2f53b`。staging `/var/tmp/science-lab-ai-hardening-20260910-5cc08bd` 保留发布脚本、校验程序及私密候选环境，目录700；不要重复执行初始化/切换脚本。需要回滚时先核实现网仍是本次版本，再先恢复旧静态、随后旧API链接与备份环境，重启API并轮询健康；保留Redis数据和密钥，不清库。

验收工具限制：首次服务器HTTP测试因API扁平部署目录缺少仓库级Worker文件而失败；在独立staging恢复仓库目录结构后复跑通过，无应用修补。浏览器SSE完成后主动取消读取，DevTools再次提取响应正文不可用；未重复付费调用，改用HTTP200、页面完整回答、解析器成功保存的完整问答及Redis计数核验。真实回答仅抽查温度计一个场景，不代表全部138项教学质量已人工审定。
