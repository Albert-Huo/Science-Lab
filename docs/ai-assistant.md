# AI 助手配置、资料与发布

## 请求与资料契约

前端发送 `{stream:true,messages,context:{experimentPath}}`。服务端只接受离线资料包中存在的实验路径，忽略客户端标题/状态和 system 消息，生成唯一系统提示。旧 App 已带 experimentPath，因此仍可工作；旧脚本只截断12条时开头的孤立 assistant 会被丢弃。缺路径返回400，不能当通用代理调用。提示词约束提高一致性，但不是对提示注入的绝对防护，也不是认证；匿名 Cookie 不能阻止清除 Cookie 创建新会话，所以始终叠加 IP 和全站限制。

`server/api/ai-context.json` 随 API 独立发布。包含完整清单、教材文字与每份源 HTML 的 SHA256；资料仅是参考数据，不代表实时状态。各类最多8条、单条350 UTF-16字符、总正文4500字符、context序列化最多6000字符。未知字段为空数组，不凭标题补写。系统提示包含不编造读数、安全指导、分辨理论/观察及资料不足时澄清规则。

在仓库根目录运行：

```bash
python3 tools/build-ai-context.py
python3 tools/build-ai-context.py --check
```

默认读取同级 `../HTML-`；可用 `--content-root` 指定内容仓库。构建器只读取 manifest.json 内的路径，拒绝穿越、符号链接逃逸与缺失文件。解析静态 HTML 和已知的纯字面量实验对象/步骤数组，不执行页面 JavaScript。构建失败不会覆盖原资料包。`--check` 不写入，发现来源过期时退出非零。

当前138个实验都有可提取资料。其中“初中物理实验59”“地球为什么是圆的”“冰块取火”“银河系”文字较少，10项发生长度/条目截断；实验66的一组动态引用步骤无法离线解析，但保留其他静态说明。构建器报告这些限制。步骤片段可能来自不同模式或多处源码，不保证是当前模式的连续顺序，系统提示要求冲突时先澄清。这个自动资料包不等同于人工审定教案；优先由内容维护者在源页面补充稀疏资料，然后重建。未接入学生实时状态，不能回答未描述的具体读数或点击位置。

## 额度与费用

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| AI_RATE_LIMIT_MINUTE_MAX | 10 | 每IP每分钟请求保护 |
| AI_RATE_LIMIT_DAY_MAX | 20 | 每IP每24小时上游调用 |
| AI_SESSION_DAY_MAX | 20 | 每签名匿名会话每24小时 |
| AI_GLOBAL_DAY_MAX | 500 | 全站每24小时调用上限 |
| AI_GLOBAL_CONCURRENT_MAX | 10 | 全站同时进行的请求；满额时返回429，不自动排队 |
| AI_UPSTREAM_TIMEOUT_MS | 120000 | 单次上游总超时 |

日额度窗口从该计数键首次使用开始，并非北京时间零点。有效请求预占调用次数后，即使取消、超时或上游失败也不退款，因为上游可能已计算；格式错误、缺Key、并发/日额度拒绝不会消耗日额度。Node还在校验前保留便宜的进程内分钟限流，畸形请求计入该短时保护；正常调用的分钟额度由Redis跨实例原子计数。Nginx的10r/m和burst=3继续保护入口。

如果学校共享网络需要更高日额度，可将 `AI_RATE_LIMIT_DAY_MAX` 调为200，保留20次会话额度和全站上限。默认继续使用现有20次/IP；500全站额度是保守请求上限，不承诺固定人民币成本。管理员仍需在模型服务商处设置可用的硬预算、关闭不受控自动充值；本次代码不修改模型账户设置。

`X-AI-Quota-Limit/Remaining/Reset/Scope` 用于页面提示；Reset是Unix秒，Retry-After是等待秒。页面优先展示会话额度，如网络/全站剩余更少则展示约束更紧者。并发拒绝恢复时间基于租约最迟过期，实际完成后可能更早可用。Cookie过期、换浏览器或删除Cookie会失去原会话额度身份，但IP与全站保护继续生效。

## 生产 Redis

生产环境配置 `NODE_ENV=production`，必须提供 `AI_REDIS_URL` 和独立随机的至少32字符 `AI_SESSION_SECRET`。缺失配置拒绝启动，连接故障拒绝付费请求并返回503。不要将含密码的Redis URL、签名密钥或模型Key放入Git、前端或命令行历史。通过既有私密环境文件注入；各实例须使用相同Redis、相同签名密钥和相同额度值。更换签名密钥会使旧Cookie失效并改变IP键，安排低峰操作且不能当作重置额度的常规手段。

Redis最低需要支持TIME、EVAL、字符串计数、PEXPIRE与有序集合。使用受访问控制的本机/私网连接，启用持久化（例如AOF）和 `maxmemory-policy noeviction`；内存淘汰会导致额度提前重置。Redis故障/恢复不得执行清库。计数和租约统一使用 `science-lab:ai:{quota}` 前缀，过期自动清理，不存姓名、原始IP或聊天正文。共享IP使用HMAC摘要；这是防滥用临时状态，与不保留请求标识的匿名统计日志分开。

仅开发/测试允许不提供Redis而使用进程内内存；重启会清空开发计数。生产不要通过取消NODE_ENV=production绕过强制要求。Redis持久化故障、数据丢失或人工删除键仍会丢失额度，供应商硬预算承担最终费用保护。

### 现有云服务器的零新增基础设施费用方案

2026-09-10只读核验：现有ECS为2核、约1.84GiB内存，可用约1.43GiB，磁盘剩余29GiB；已安装Redis 6.2.20。本次发布复用现有Redis可执行文件，不购买云Redis、不升级服务器。为保留原6379实例的用途与配置，AI额度使用独立systemd服务 `science-lab-quota-redis.service`，只监听 `127.0.0.1:16379`，独立密码、数据目录 `/var/lib/science-lab-quota-redis`，AOF每秒同步、64MiB数据内存上限及noeviction。服务总内存另设192MiB保护上限；数据上限不等于进程总占用。

签名密钥和Redis密码在服务器生成，保存在私密配置中，不进入Git或发布日志。Redis版本兼容、服务重启后额度保留须在发布验收中确认。用户明确自行控制模型费用；本次不修改供应商账户、充值或预算设置。

## 发布与回退

1. 本地构建资料并检查，运行下方测试。API完整发布 `server.js`、`ai-policy.js`、`ai-quota.js`、`ai-context.json`、现有db.js/schema.sql、package.json/package-lock.json；依赖执行 `npm ci --omit=dev`，Node需18.19+（建议沿用现网22）。不得仅替换server.js。
2. 运维先准备Redis、持久化和私密环境变量，验证连接与配置。保留原API release和配置备份；2026-09-10发布已复用现有Redis程序部署独立额度实例，后续发布应保留其数据和稳定密钥，不重新初始化。
3. 先发布API并检查健康与一条受控AI请求，再发布静态页面。静态清单新增ai-chat.js；index、sw、experiment-scroll版本统一v0.8.11。Nginx保留精确AI路径、真实IP转发、SSE无缓冲以及匿名日志；Cookie和额度响应头不能被缓存或丢弃。详情见aliyun-deploy.md。
4. 新前端依赖服务端生成提示词：如回退API，须先回退静态页面到旧客户端；只回退静态页面且保留新API可兼容。资料和策略模块随API成组回退；不得清空Redis键来“修复”故障。
5. 若曾部署独立旧Worker，管理员需单独停用远端Worker并撤销它的Secret。本地退役文件返回410、不再触发上游；不会自动改变远端部署。

## 验证

```bash
npm test --prefix server/api
python3 tools/build-ai-context.py --check
REDIS_SERVER_BIN=/usr/local/bin/redis-server npm run test:redis --prefix server/api
```

Redis集成测试只启动并终止自己的随机本地端口实例，模拟多客户端/进程、过期与故障，不使用默认6379或清理既有数据库。Redis可执行路径由REDIS_SERVER_BIN指定。所有自动聊天测试模拟DeepSeek，无真实模型费用；实际回答质量仍应以代表性教学问题做受控验收。

前端内置上下文为当前问题+最近5个完整问答，总12000字符，单条4000。本地存储总200条、单条6000，截短和中断记录有标识且不进入后续上下文。生成中可停止，120秒总超时，SSE须正常结束；实时文字最多24000字符防止失控流。BYOK仅DeepSeek显式带max_tokens2048和关闭思考参数，其他兼容接口保留原参数格式；所有BYOK仍有浏览器时间/字符边界，但不受本站Redis额度保护。

实现参考：[Redis Node.js客户端](https://redis.io/docs/latest/develop/clients/nodejs/) 与 [Redis Lua原子执行](https://redis.io/docs/latest/develop/programmability/eval-intro/)。
