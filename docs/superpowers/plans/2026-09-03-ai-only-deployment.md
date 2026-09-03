# AI-only Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 无数据库启动免登录 AI 后端，同时保持旧模式兼容，并完成已授权的 ECS 部署。

**Architecture:** 在现有 Express 服务内加入显式模式边界，不新增服务框架。默认 full 保持旧行为，ai-only 跳过数据库和 JWT 前置要求，并阻断旧接口。

**Tech Stack:** Node.js、Express、原有 npm 测试、nginx、systemd。

## Task 1: 启动模式与回归测试

Files: `server/api/server.js`, `server/api/test/startup-modes.js`, `server/api/package.json`, `server/api/.env.example`, `docs/aliyun-deploy.md`。

- [ ] 先新增真实子进程启动测试：隔离 cwd/env，执行 `node server.js`；覆盖 ai-only 无 JWT/DB、健康检查、缺 Key、禁用 auth/progress、非法模式、默认和显式 full 的 JWT/数据库要求以及旧账号兼容。
- [ ] 执行 `node test/startup-modes.js`，记录因当前缺少模式功能而产生的失败，不修改生产代码直到确认失败原因。
- [ ] 实现最小逻辑：`const APP_MODE = process.env.APP_MODE || 'full'`；非 `full`/`ai-only` 拒绝启动；`const AI_ONLY = APP_MODE === 'ai-only'`；`const db = AI_ONLY ? null : require('./db')`；JWT 校验和 `await db.init()` 仅在 full 执行；在旧路由前加入 `app.use(['/auth', '/progress'], ...503 sync_disabled...)` 的 ai-only 守卫。
- [ ] 将启动测试加入 npm test；环境示例保留 `APP_MODE=full`；部署文档注明本站设置 ai-only、无需 DB/JWT、保留旧模式数据库要求。
- [ ] 运行 `node test/startup-modes.js`、`npm test`、`npm audit --omit=dev`、`git diff --check`；独立规格审查和质量审查通过后提交明确文件。

## Task 2: 发布与验收（主代理执行）

- [ ] 从已审查提交生成静态/API/测试源码归档及 SHA256，不包含 .env、未跟踪文件或 node_modules。
- [ ] 上传至既有 task-owned staging `/var/tmp/science-lab-deploy-fc9dbae-rk9vjX`，校验归档 SHA256；安装应用独占的 Node 22 LTS，不替换系统 Node。
- [ ] 在服务器用该 Node 重跑完整测试与依赖审计。生成非 root 单实例服务，`APP_MODE=ai-only`、Key 留空、每日限额 20，先验证回环接口。
- [ ] 验证已有 nginx 配置未改变后，切换新的静态 release 和本站配置；`nginx -t` 后 reload。任何失败恢复备份配置并停止新增服务，保留现场。
- [ ] 核验所有静态壳文件内容、版本、JSON/no-cache/404、health 200、AI 缺 Key 503、旧接口 503、非规范 AI 路径 404、服务用户/监听地址/开机启动及其他站点配置不变。
- [ ] 输出部署记录、正式链接、剩余真实 Key/AI 实测步骤。
