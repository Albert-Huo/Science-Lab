# 部署到阿里云（同源方案：页面 + API 同域）

把 **App 页面和 API 服务部署在同一个新子域名**下，例如 `lab.xingnian.net.cn`：

- 页面：`https://lab.xingnian.net.cn/`（静态文件，nginx 直接托管）
- 接口：`https://lab.xingnian.net.cn/api/`（反代到本机 Node 服务）

二者同源，浏览器不需要跨域调用，内置 AI 默认请求本站 `/api/ai/chat/completions`。当前服务端仍校验请求的 `Origin`，因此 `CORS_ORIGINS` 必须包含 `https://lab.xingnian.net.cn`。主域名留给现有网站，互不影响。实验内容仍从 `html.xingnian.net.cn` 加载。

> GitHub 仓库继续用于存代码/版本管理；对外网页由阿里云提供。国内访问比 GitHub Pages 更快更稳。

## 0. 准备

- 新子域名解析到本服务器，例如 `lab.xingnian.net.cn`，并签发 TLS 证书（Let's Encrypt 或阿里云免费证书）。
- Node ≥ 18；可用的 MySQL（自建或阿里云 RDS）。
- 防火墙只放行 443（与现网所需端口）；Node 端口（默认 8970）仅监听 127.0.0.1。

> “本次没有修改数据库代码或表结构”不等于“生产数据已经验证完好”。升级已有部署时，必须先完成下面的备份和只读基线核验；新建部署可跳过旧数据核验。

## 1. 建库与表

```sql
CREATE DATABASE sciencelab CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sciencelab'@'%' IDENTIFIED BY '换成强密码';
GRANT ALL PRIVILEGES ON sciencelab.* TO 'sciencelab'@'%';
FLUSH PRIVILEGES;
```

```bash
mysql -u sciencelab -p sciencelab < server/api/schema.sql
```

### 升级已有部署：备份与基线核验

以下命令不会修改表数据。备份文件应放在仅管理员可读、且不位于 Git 仓库和 Web 根目录的位置：

```bash
sudo install -d -m 700 /var/backups/science-lab
SCIENCE_LAB_BACKUP_TAG=$(date '+%Y%m%d-%H%M%S')
sudo sh -c "umask 077; mysqldump -u sciencelab -p --single-transaction --routines --triggers sciencelab > /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql"
sudo sh -c "umask 077; sha256sum /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql > /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql.sha256"

mysql -u sciencelab -p -N sciencelab -e \
  "SELECT 'users', COUNT(*) FROM users; SELECT 'progress', COUNT(*) FROM progress; SELECT 'latest_progress', COALESCE(MAX(updated_at), 'none') FROM progress;"
```

记录 `SCIENCE_LAB_BACKUP_TAG` 和三项查询输出。部署后再次执行相同的只读查询；若用户数、进度记录数意外减少，立即停止验证和写操作，保留现场并回滚应用。不要在原因不明时导入备份覆盖现库。

## 2. 部署 Node API 服务

```bash
# 把仓库 server/api 传到服务器，例如 /opt/science-lab-api
cd /opt/science-lab-api
npm ci --omit=dev
cp .env.example .env
# 编辑 .env：
#   JWT_SECRET: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DEEPSEEK_API_KEY: 服务端专用 DeepSeek API Key（不要提交到 Git）
#   AI_RATE_LIMIT_MINUTE_MAX: 单 IP 每分钟上限，默认 10
#   AI_RATE_LIMIT_DAY_MAX: 单 IP 每 24 小时上限，默认 20
#   AI_UPSTREAM_TIMEOUT_MS: DeepSeek 单次请求总超时，默认 120000 毫秒
#   DB_* 填上面建的库与账号
#   CORS_ORIGINS: 至少填写前端完整 Origin，例如 https://lab.xingnian.net.cn
nano .env

npm install -g pm2
pm2 start server.js --name science-lab-api
pm2 save && pm2 startup    # 按提示执行输出命令，开机自启
```

健康检查：`curl http://127.0.0.1:8970/health` → `{"ok":true}`。

`DEEPSEEK_API_KEY` 可以暂时留空：Node 服务仍会正常启动，健康检查及旧版账号/进度接口不受影响，仅 `/ai/*` 返回 `503 ai_unavailable`。

## 3. 部署 App 静态页面

每次把仓库根目录这些文件放到一个新的只读 release 目录，再原子切换 `/var/www/science-lab-current` 符号链接：

```
index.html  catalog-control.js  content-source.js  catalog-control.json  manifest.json  manifest.webmanifest  sw.js  assets/
```

```bash
# 在仓库根目录执行。每次发布都生成一个新目录，不覆盖正在服务的版本。
SCIENCE_LAB_RELEASE_ID=$(date '+%Y%m%d-%H%M%S')
SCIENCE_LAB_RELEASE_DIR="/var/www/science-lab-releases/${SCIENCE_LAB_RELEASE_ID}"
sudo install -d -m 755 "$SCIENCE_LAB_RELEASE_DIR"
sudo install -m 644 index.html catalog-control.js content-source.js catalog-control.json manifest.json manifest.webmanifest sw.js "$SCIENCE_LAB_RELEASE_DIR/"
sudo cp -a assets "$SCIENCE_LAB_RELEASE_DIR/"

# 切换前确认关键文件齐全；任一检查失败都不要切换。
test -f "$SCIENCE_LAB_RELEASE_DIR/index.html" && test -f "$SCIENCE_LAB_RELEASE_DIR/catalog-control.json" && test -f "$SCIENCE_LAB_RELEASE_DIR/sw.js"
sudo ln -sfn "$SCIENCE_LAB_RELEASE_DIR" /var/www/science-lab-next
sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current
```

`/var/www/science-lab-current` 必须保持为指向某个 release 目录的符号链接。`server/`、`docs/`、`tools/` 不用上传，它们不是网页运行所需。

## 4. nginx：一个 server 同时托管页面与接口

```nginx
server {
    listen 443 ssl http2;
    server_name lab.xingnian.net.cn;             # 换成你的子域名

    ssl_certificate     /etc/nginx/ssl/lab.crt;
    ssl_certificate_key /etc/nginx/ssl/lab.key;

    root /var/www/science-lab-current;
    index index.html;

    # 接口反代：/api/ → 本机 Node（末尾斜杠会去掉 /api 前缀）
    location /api/ {
        proxy_pass http://127.0.0.1:8970/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # DeepSeek 使用 SSE；关闭缓冲，避免回答积压后一次性显示
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    # Service Worker 不缓存，保证更新及时；文件缺失必须返回 404
    location = /sw.js {
        try_files $uri =404;
        add_header Cache-Control "no-cache" always;
    }

    # 纯静态站没有前端路由；缺失的 JSON/JS/图标不能回退成 index.html
    location / { try_files $uri $uri/ =404; }
}

server {                                          # 80 跳 443
    listen 80;
    server_name lab.xingnian.net.cn;
    return 301 https://$host$request_uri;
}
```

```bash
nginx -t && nginx -s reload
```

验证：
- `https://lab.xingnian.net.cn/api/health` → `{"ok":true}`
- 配好 Key 后，用以下请求确认 AI SSE 能持续输出：

  ```bash
  curl -N https://lab.xingnian.net.cn/api/ai/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"用一句话解释惯性"}]}'
  ```

- 浏览器打开 `https://lab.xingnian.net.cn/` 看到 App

## 5. 启用内置 AI

确认 `.env` 已设置 `DEEPSEEK_API_KEY`，执行 `pm2 restart science-lab-api --update-env`，再打开 App →「我的」→「AI 问答」直接提问。默认模式不需要在浏览器填写任何配置。

如果暂不配置 Key，前端会收到明确的 503 提示；用户仍可在 AI 设置中开启 BYOK，使用自己的 OpenAI 兼容 endpoint、model 和 Key。

## 更新发布

升级前记录当前静态 release，并保存 Node API；数据库备份仍按前文单独生成：

```bash
SCIENCE_LAB_PREVIOUS_RELEASE=$(readlink -f /var/www/science-lab-current)
test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"
sudo tar -C /opt -czf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz science-lab-api
```

前端更新重复执行第 3 节的 release 创建、校验和链接切换流程；`sw.js` 里的版本号每次发布递增。后端改动执行 `npm ci --omit=dev` 后再 `pm2 restart science-lab-api`。

如新版本页面验证失败，确认 `SCIENCE_LAB_PREVIOUS_RELEASE` 是发布前记录的绝对目录，再原子切回；如 API 验证失败，确认 `SCIENCE_LAB_BACKUP_TAG` 与备份时记录一致，再恢复 API：

```bash
test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"
sudo ln -sfn "$SCIENCE_LAB_PREVIOUS_RELEASE" /var/www/science-lab-next
sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current
sudo tar -C /opt -xzf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz
pm2 restart science-lab-api --update-env
nginx -t && nginx -s reload
```

本次没有数据库迁移，不要为应用回滚而重建或回滚数据库结构。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/ai/chat/completions` | 无鉴权；校验请求后代理 DeepSeek SSE |
| POST | `/api/auth/register` | 旧版兼容：`{email,password}` → `{token,email}` |
| POST | `/api/auth/login` | 旧版兼容：`{email,password}` → `{token,email}` |
| GET | `/api/progress` | 旧版兼容：需 Bearer token，返回 `{history}` |
| PUT | `/api/progress` | 旧版兼容：需 Bearer token，服务端合并，返回 `{history}` |

## 安全要点

- 密码 bcrypt 哈希；登录态 JWT（密钥在 `.env`）。
- 注册/登录限流（15 分钟 30 次/IP）。
- AI 路由叠加每分钟和每 24 小时两级 IP 限流，默认分别为 10 次和 20 次，可用 `AI_RATE_LIMIT_MINUTE_MAX`、`AI_RATE_LIMIT_DAY_MAX` 调整。
- AI 上游请求默认在 120 秒后中止，客户端断开连接时也会中止；可用 `AI_UPSTREAM_TIMEOUT_MS` 调整总超时。
- AI 请求仅接受最多 20 条 `messages`；角色和单条长度受限；模型仅允许 `deepseek-v4-flash`；服务端强制流式响应、关闭思考模式、`max_tokens ≤ 2048`、`temperature ∈ [0,2]`，其他字段不会透传。
- `DEEPSEEK_API_KEY` 只放在服务端 `.env`。错误响应不会回显 Key 或 DeepSeek 原始错误正文；建议同时设置 DeepSeek 账户预算告警并定期轮换 Key。
- Node 仅监听 127.0.0.1，对外只经 nginx 443。
- 同源部署天然规避跨站；如分域部署再依赖 `CORS_ORIGINS` 白名单。
- 当前限流计数保存在单个 Node 进程内。若用 PM2 cluster、多个容器或多台机器，实际总额度会按实例放大，应改用共享 Redis store 或在网关/WAF 再加全局限流。
- CORS 不是滥用防护。上线后应监控 429、502、调用量与供应商费用；遭遇攻击时先在 nginx/WAF 封禁异常来源并下调限额。

## 上线风险解除清单

- **匿名费用风险**：使用服务端专用 Key，并将供应商账户的可用余额或预算控制在可承受范围；监控 429、502 和调用量。CORS 不是访问控制，不能阻止脚本或 `curl` 调用。
- **共享出口 IP**：学校或宿舍用户可能共用一个公网 IP。先保持默认限额；只有确认正常课堂流量出现大量 429 后，才逐步上调分钟上限，同时保留每日费用边界。
- **多实例限流**：未接入 Redis store 或网关全局限流前，只运行一个 PM2 fork 实例，不启用 cluster 或横向副本。
- **真实上游**：配置费用控制后只做一次小额 `curl -N` 验证，确认持续输出和 `[DONE]` 正常结束；失败时先停用 Key，不连续重试。
- **生产数据**：上线前后比较 `users`、`progress` 数量和 `MAX(updated_at)`；仓库文件未变不代表生产数据已经核验。
- **多标签页覆盖**：当前接受极少数同时写入覆盖的边缘风险。若出现真实反馈，再单独设计基于 `storage` 事件和版本戳的合并机制。
- **回归保护**：每次发布前运行 `cd server/api && npm test`，必须同时通过旧接口、AI 边缘行为和前端本地存储测试。
