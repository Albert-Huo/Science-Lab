# 无数据库 AI 运行模式

用户已批准：增加“仅 AI”模式，保留原账号模式兼容性，补充真实启动测试后继续阿里云部署；真实 DeepSeek Key 暂留空。

## 边界与选择

当前 `server.js` 的生产入口会调用 `db.init()`，因此既有内存接口测试不能证明无数据库可启动。采用显式 `APP_MODE=ai-only`，而不是在生产使用内存数据库或额外安装本次不需要的 MySQL。

- `APP_MODE` 未设置或为空时为 `full`，保留原数据库、JWT、账号和同步行为。
- `APP_MODE=ai-only` 不加载数据库、不初始化数据库、不要求 JWT_SECRET；健康检查和 AI 接口保留，AI 限流、校验、SSE 和密钥行为不变。
- 仅 AI 模式下 `/auth` 和 `/progress` 路径及其子路径明确返回 `503 {"error":"sync_disabled"}`，不能进入数据库代码。
- 未知的非空模式必须以非零状态退出；禁止静默降级。
- 不修改 `db.js`、表结构、实验、前端或依赖锁文件。

## 验证

新增子进程测试执行真正的 `node server.js`，不只导入 Express app。隔离环境和工作目录，不继承本机 Key 或 .env。覆盖无数据库/无 JWT 启动、旧接口禁用、缺 Key 503、默认/显式 full 的 JWT 和数据库要求、无效模式拒绝，以及 full 内存模式的旧接口兼容。所有自建子进程和监听端口有有界等待和精确清理。

## 部署

本次只部署 lab.xingnian.net.cn。服务器原先仅静态站，没有 API 或应用数据库；保留旧页面、nginx 配置、证书及 ACME webroot。后端采用独立受支持 Node LTS 和非 root 单实例 systemd 服务，端口只监听 127.0.0.1。仅公开 health 和 AI 精确路径，旧 /api/ 路由维持原 503。先验证后切换，有备份可恢复。不设置真实 Key，不调用付费 AI，不改变 html.xingnian.net.cn。
