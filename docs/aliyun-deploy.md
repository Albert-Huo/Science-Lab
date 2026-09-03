# 部署到阿里云（同源方案：页面 + API 同域）

把 **App 页面和 API 服务部署在同一个新子域名**下，例如 `lab.xingnian.net.cn`：

- 页面：`https://lab.xingnian.net.cn/`（静态文件，nginx 直接托管）
- 接口：`https://lab.xingnian.net.cn/api/`（反代到本机 Node 服务）

二者同源，浏览器不需要跨域调用，内置 AI 默认请求本站 `/api/ai/chat/completions`。当前服务端仍校验请求的 `Origin`，因此 `CORS_ORIGINS` 必须包含 `https://lab.xingnian.net.cn`。主域名留给现有网站，互不影响。实验内容仍从 `html.xingnian.net.cn` 加载。

本站免登录部署设置 `APP_MODE=ai-only`：无需 MySQL 或 `JWT_SECRET`，保留健康检查及 AI 校验、限流与 SSE；`/auth`、`/progress` 及其子路径的所有方法返回 `503 {"error":"sync_disabled"}`（HEAD 不返回响应体）。不加载数据库，也不会写入旧账号或进度。

环境示例保留 `APP_MODE=full` 以兼容已有部署。未设置或为空也默认 `full`，必须有有效 JWT 密钥和可连接的数据库；数据库失败时拒绝启动，不会静默降级。其他非空模式值同样拒绝启动。`DB_DRIVER=memory` 只用于本地测试，不持久化，不能用于生产替代数据库。

### 本站现网运行方式（2026-09-03）

`lab.xingnian.net.cn` 已采用 `ai-only`，由 **systemd** 管理非 root、单实例服务 `science-lab-api.service`，不是下面通用示例中的 PM2。Node 22 独立安装在 `/opt/science-lab-runtime/`，没有替换系统 Node。

- 后端当前目录：`/opt/science-lab-api-current`；仅监听 `127.0.0.1:8970`。
- 环境配置：`/etc/science-lab-api.env`，仅 root 可读写（600），初次发布的真实 DeepSeek Key 留空。
- 修改环境配置后使用 `sudo systemctl restart science-lab-api`；查看状态用 `systemctl is-active science-lab-api`。
- nginx 仅转发精确的 `/api/health` 和 `/api/ai/chat/completions`；旧 `/api/` 接口继续维持部署前的 `503 sync_api_not_configured`。
- 静态页面使用 `/var/www/science-lab-current` 发布链接；原 `/var/www/science-lab` 保留供证书续期及回滚使用。

启用真实 AI 时，通过服务器私密环境配置提供 Key，不要写入前端、Git 或聊天记录；重启后再做一次有费用上限的真实请求验收。不要在本站额外启动第二个 PM2/API 实例，否则进程内的每日限额不能统一计数。

> GitHub 仓库继续用于存代码/版本管理；对外网页由阿里云提供。国内访问比 GitHub Pages 更快更稳。

## 0. 准备

- 新子域名解析到本服务器，例如 `lab.xingnian.net.cn`，并签发 TLS 证书（Let's Encrypt 或阿里云免费证书）。
- 代码要求 Node ≥ 18；生产选择仍受维护的 Node LTS（本站使用 Node 22），不要将最低兼容版本当作生产推荐版本。仅 `full` 模式需要可用的 MySQL（自建或阿里云 RDS）。
- 防火墙只放行 443（与现网所需端口）；Node 端口（默认 8970）仅监听 127.0.0.1。

> “本次没有修改数据库代码或表结构”不等于“生产数据已经验证完好”。升级已有部署时，必须先完成下面的备份和只读基线核验；新建部署可跳过旧数据核验。

## 1. 建库与表（仅 full）

新建 `ai-only` 部署可跳过建库。若已有账号数据库，即使本次切换为 `ai-only`，仍须保留旧库并执行下面的备份与只读基线核验，不要删除旧数据。

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
#   APP_MODE: 本站设置 ai-only；保留旧账号/同步服务时设置 full
#   JWT_SECRET: ai-only 可留空；仅 full 需要长随机密钥
#     生成示例：node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DEEPSEEK_API_KEY: 服务端专用 DeepSeek API Key（不要提交到 Git）
#   AI_RATE_LIMIT_MINUTE_MAX: 单 IP 每分钟上限，默认 10
#   AI_RATE_LIMIT_DAY_MAX: 单 IP 每 24 小时上限，默认 20
#   AI_UPSTREAM_TIMEOUT_MS: DeepSeek 单次请求总超时，默认 120000 毫秒
#   DB_*: ai-only 无需配置；仅 full 填上面建的库与账号
#   CORS_ORIGINS: 至少填写前端完整 Origin，例如 https://lab.xingnian.net.cn
nano .env

npm install -g pm2
pm2 start server.js --name science-lab-api
pm2 save && pm2 startup    # 按提示执行输出命令，开机自启
```

健康检查：`curl http://127.0.0.1:8970/health` → `{"ok":true}`。

`DEEPSEEK_API_KEY` 可以暂时留空：在所选模式的启动条件满足后，Node 服务仍会正常启动，健康检查不受影响，合法 AI 请求返回 `503 ai_unavailable`。`ai-only` 的旧接口始终禁用；`full` 的旧版账号/进度接口不受缺 Key 影响。

发布前运行 `cd server/api && npm test`，其中启动模式测试会用隔离环境执行真实的 `node server.js`，确认无数据库的 `ai-only` 能启动、旧接口被禁用，并验证默认/`full` 模式仍要求 JWT 和数据库。测试不会继承本机 Key 或 `.env`，不会调用真实 AI。

## 3. 部署 App 静态页面

每次把仓库根目录这些文件放到一个新的只读 release 目录，再原子切换 `/var/www/science-lab-current` 符号链接：

```
index.html  catalog-control.js  content-source.js  catalog-control.json  manifest.json  manifest.webmanifest  sw.js  assets/
```

```bash
# 在仓库根目录执行。每次发布都生成一个新目录，不覆盖正在服务的版本。
set -euo pipefail

SCIENCE_LAB_RELEASE_ID=$(date '+%Y%m%d-%H%M%S')
SCIENCE_LAB_RELEASE_DIR="/var/www/science-lab-releases/${SCIENCE_LAB_RELEASE_ID}"
sudo install -d -m 755 "$SCIENCE_LAB_RELEASE_DIR"
sudo install -m 644 index.html catalog-control.js content-source.js catalog-control.json manifest.json manifest.webmanifest sw.js "$SCIENCE_LAB_RELEASE_DIR/"
sudo cp -a assets "$SCIENCE_LAB_RELEASE_DIR/"
sudo chown -R root:root "$SCIENCE_LAB_RELEASE_DIR"
sudo find "$SCIENCE_LAB_RELEASE_DIR" -type d -exec chmod 755 {} +
sudo find "$SCIENCE_LAB_RELEASE_DIR" -type f -exec chmod 644 {} +

# 根 URL 与 index.html 是同一份内容，因此 App 壳有以下十个物理文件。
SCIENCE_LAB_SHELL_FILES=(
  "index.html"
  "catalog-control.js"
  "content-source.js"
  "catalog-control.json"
  "manifest.json"
  "manifest.webmanifest"
  "assets/icons/icon-192.png"
  "assets/icons/icon-512.png"
  "assets/icons/icon-maskable-512.png"
  "assets/icons/apple-touch-icon.png"
)

# 切换前确认全部 App 壳文件和 Service Worker 齐全，并实际解析两个 JSON；任一检查失败都不要切换。
for SCIENCE_LAB_SHELL_FILE in "${SCIENCE_LAB_SHELL_FILES[@]}"; do
  test -f "$SCIENCE_LAB_RELEASE_DIR/$SCIENCE_LAB_SHELL_FILE"
  test -r "$SCIENCE_LAB_RELEASE_DIR/$SCIENCE_LAB_SHELL_FILE"
done
test -f "$SCIENCE_LAB_RELEASE_DIR/sw.js"
test -r "$SCIENCE_LAB_RELEASE_DIR/sw.js"

SCIENCE_LAB_UNREADABLE_FILE=$(find "$SCIENCE_LAB_RELEASE_DIR" -type f ! -readable -print -quit)
test -z "$SCIENCE_LAB_UNREADABLE_FILE"

for SCIENCE_LAB_JSON_FILE in "catalog-control.json" "manifest.json"; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
    "$SCIENCE_LAB_RELEASE_DIR/$SCIENCE_LAB_JSON_FILE"
done

# 已有部署先持久保存当前 release。readlink -f 解析后的绝对路径必须位于 release 根目录下；
# 初次部署没有 science-lab-current 符号链接时会跳过此段。
if [ -L /var/www/science-lab-current ]; then
  SCIENCE_LAB_PREVIOUS_RELEASE=$(readlink -f /var/www/science-lab-current)
  case "$SCIENCE_LAB_PREVIOUS_RELEASE" in
    /var/www/science-lab-releases/*) ;;
    *) echo "拒绝保存 release 根目录之外的回滚目标" >&2; exit 1 ;;
  esac
  test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"
  sudo ln -sfn "$SCIENCE_LAB_PREVIOUS_RELEASE" /var/www/science-lab-previous-next
  sudo chown -h root:root /var/www/science-lab-previous-next
  sudo mv -Tf /var/www/science-lab-previous-next /var/www/science-lab-previous
fi

sudo ln -sfn "$SCIENCE_LAB_RELEASE_DIR" /var/www/science-lab-next
sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current

# 切换后验证首页与十个物理 App 壳 URL。
SCIENCE_LAB_PUBLIC_URL="https://lab.xingnian.net.cn"
SCIENCE_LAB_HTTP_STATUS=$(curl --silent --show-error \
  --output /dev/null --write-out '%{http_code}' "$SCIENCE_LAB_PUBLIC_URL/")
test "$SCIENCE_LAB_HTTP_STATUS" = "200"
for SCIENCE_LAB_SHELL_FILE in "${SCIENCE_LAB_SHELL_FILES[@]}"; do
  SCIENCE_LAB_HTTP_STATUS=$(curl --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    "$SCIENCE_LAB_PUBLIC_URL/$SCIENCE_LAB_SHELL_FILE")
  test "$SCIENCE_LAB_HTTP_STATUS" = "200"
done

# 两个 JSON 必须返回 JSON/no-cache；故意不存在的 JSON 必须保持 404。
SCIENCE_LAB_HEADER_FILE=$(mktemp)
trap 'rm -f "$SCIENCE_LAB_HEADER_FILE"' EXIT
for SCIENCE_LAB_JSON_FILE in "catalog-control.json" "manifest.json"; do
  SCIENCE_LAB_HTTP_STATUS=$(curl --silent --show-error \
    --dump-header "$SCIENCE_LAB_HEADER_FILE" --output /dev/null \
    --write-out '%{http_code}' "$SCIENCE_LAB_PUBLIC_URL/$SCIENCE_LAB_JSON_FILE")
  test "$SCIENCE_LAB_HTTP_STATUS" = "200"
  grep -Eiq '^Content-Type:[[:space:]]*application/json([;[:space:]]|$)' "$SCIENCE_LAB_HEADER_FILE"
  grep -Eiq '^Cache-Control:[[:space:]]*no-cache([,[:space:]]|$)' "$SCIENCE_LAB_HEADER_FILE"
done
SCIENCE_LAB_MISSING_JSON_STATUS=$(curl --silent --show-error \
  --output /dev/null --write-out '%{http_code}' \
  "$SCIENCE_LAB_PUBLIC_URL/__science-lab-missing.json")
test "$SCIENCE_LAB_MISSING_JSON_STATUS" = "404"
rm -f "$SCIENCE_LAB_HEADER_FILE"
trap - EXIT
```

`/var/www/science-lab-current` 必须保持为指向某个 release 目录的符号链接。`server/`、`docs/`、`tools/` 不用上传，它们不是网页运行所需。

## 4. nginx：一个 server 同时托管页面与接口

下面的 `limit_req_zone` 必须放在 nginx 的 `http {}` 上下文中、所有 `server {}` 之外；不要把它放进站点的 `server` 块。它只提供匿名接口的短时突发保护，不是认证机制，也不是全局费用上限。Node 端仍须保留默认每 IP 每分钟 10 次、每 24 小时 20 次的两级限流。

```nginx
# 放在 nginx.conf 的 http {} 上下文中，且位于所有 server {} 之外
limit_req_zone $binary_remote_addr zone=science_lab_ai:10m rate=10r/m;

server {
    listen 443 ssl http2;
    server_name lab.xingnian.net.cn;             # 换成你的子域名

    ssl_certificate     /etc/nginx/ssl/lab.crt;
    ssl_certificate_key /etc/nginx/ssl/lab.key;

    root /var/www/science-lab-current;
    index index.html;

    # 匿名 AI 接口的精确突发保护；请求转发到 Node 的 /ai/chat/completions。
    location = /api/ai/chat/completions {
        limit_req zone=science_lab_ai burst=3 nodelay;
        limit_req_status 429;

        proxy_pass http://127.0.0.1:8970/ai/chat/completions;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # DeepSeek 使用 SSE；关闭缓冲和缓存，允许长响应。
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    # nginx 精确匹配优先，因此上面的规范路径正常代理；大小写或尾斜杠变体在此拒绝。
    location ~* ^/api/ai/chat/completions/?$ { return 404; }

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

    # 发布控制和 Web App 清单必须是实际 JSON 文件，且每次请求都重新验证。
    location = /catalog-control.json {
        try_files $uri =404;
        default_type application/json;
        add_header Cache-Control "no-cache" always;
    }

    location = /manifest.json {
        try_files $uri =404;
        default_type application/json;
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
sudo nginx -t && sudo systemctl reload nginx
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

写入真实 Key 前，先准备一个仅供本服务使用的低余额账户，把可用余额控制在可承受范围，并关闭不受控的自动充值；不要把 nginx 限流当作认证或全局费用上限。然后确认 `.env` 已设置 `DEEPSEEK_API_KEY`，执行 `pm2 restart science-lab-api --update-env`，再打开 App →「我的」→「AI 问答」直接提问。默认模式不需要在浏览器填写任何配置。

如果暂不配置 Key，前端会收到明确的 503 提示；用户仍可在 AI 设置中开启 BYOK，使用自己的 OpenAI 兼容 endpoint、model 和 Key。

## 更新发布

第 3 节的发布命令会在切换前把当前静态 release 原子保存为 root 所有的 `/var/www/science-lab-previous` 符号链接，不依赖当前终端中的变量。Node API 备份和数据库备份仍按前文单独生成：

```bash
sudo tar -C /opt -czf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz science-lab-api
```

前端更新重复执行第 3 节的 release 创建、校验和链接切换流程；`sw.js` 里的版本号每次发布递增。后端改动执行 `npm ci --omit=dev` 后再 `pm2 restart science-lab-api`。

按故障范围只执行对应回滚，不要因为单一组件失败而同时回滚另一个组件。

### 仅回滚静态页面

如新版本页面验证失败，从持久的 previous 链接重新读取回滚目录，确认链接由 root 所有、解析后的绝对路径位于 release 根目录内，再原子切回：

```bash
set -euo pipefail

test -L /var/www/science-lab-previous
test "$(stat -c '%U:%G' /var/www/science-lab-previous)" = "root:root"
SCIENCE_LAB_PREVIOUS_RELEASE=$(readlink -f /var/www/science-lab-previous)
case "$SCIENCE_LAB_PREVIOUS_RELEASE" in
  /var/www/science-lab-releases/*) ;;
  *) echo "拒绝回滚到 release 根目录之外" >&2; exit 1 ;;
esac
test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"
sudo ln -sfn "$SCIENCE_LAB_PREVIOUS_RELEASE" /var/www/science-lab-next
sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current
```

静态文件由 nginx 直接读取新链接，无需重启 Node API 或恢复 API 备份。切换后重新验证首页、`manifest.json`、`catalog-control.json` 和 `sw.js`。

### 仅回滚 Node API

如 API 验证失败，确认 `SCIENCE_LAB_BACKUP_TAG` 与备份时记录一致，再恢复 API：

```bash
test -f "/var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz"
sudo tar -C /opt -xzf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz
pm2 restart science-lab-api --update-env
```

恢复后重新验证 `/api/health` 和 AI SSE；无需切换静态 release 或重载 nginx。

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

表中的旧版账号/进度接口仅在 `full` 模式可用；`ai-only` 模式统一返回 `503 sync_disabled`，包括子路径和 OPTIONS 预检。

## 安全要点

- `full` 模式：密码 bcrypt 哈希；登录态 JWT（密钥在 `.env`）。
- `full` 模式：注册/登录限流（15 分钟 30 次/IP）；`ai-only` 不开放账号与同步接口。
- AI 路由叠加每分钟和每 24 小时两级 IP 限流，默认分别为 10 次和 20 次，可用 `AI_RATE_LIMIT_MINUTE_MAX`、`AI_RATE_LIMIT_DAY_MAX` 调整。
- AI 上游请求默认在 120 秒后中止，客户端断开连接时也会中止；可用 `AI_UPSTREAM_TIMEOUT_MS` 调整总超时。
- AI 请求仅接受最多 20 条 `messages`；角色和单条长度受限；模型仅允许 `deepseek-v4-flash`；服务端强制流式响应、关闭思考模式、`max_tokens ≤ 2048`、`temperature ∈ [0,2]`，其他字段不会透传。
- `DEEPSEEK_API_KEY` 只放在服务端 `.env`。错误响应不会回显 Key 或 DeepSeek 原始错误正文；使用独立低余额账户、关闭不受控自动充值，并定期轮换 Key。
- Node 仅监听 127.0.0.1，对外只经 nginx 443。
- 同源部署天然规避跨站；如分域部署再依赖 `CORS_ORIGINS` 白名单。
- 当前限流计数保存在单个 Node 进程内。若用 PM2 cluster、多个容器或多台机器，实际总额度会按实例放大，应改用共享 Redis store 或在网关/WAF 再加全局限流。
- CORS 不是滥用防护。上线后应监控 429、502、调用量与供应商费用；遭遇攻击时先在 nginx/WAF 封禁异常来源并下调限额。

## 上线风险解除清单

- **匿名费用风险**：使用服务端专用 Key 和专用低余额账户，关闭不受控自动充值；监控 429、502、调用量与余额。CORS 不是访问控制，不能阻止脚本或 `curl` 调用。
- **共享出口 IP**：学校或宿舍用户可能共用一个公网 IP。先保持默认限额；只有确认正常课堂流量出现大量 429 后，才逐步上调分钟上限，同时保留 Node 的每 IP 每 24 小时请求上限。它不是全局费用边界，分布式 IP 或多实例会放大总调用量。
- **多实例限流**：未接入 Redis store 或网关全局限流前，只运行一个 PM2 fork 实例，不启用 cluster 或横向副本。
- **真实上游**：配置费用控制后只做一次小额 `curl -N` 验证，确认持续输出和 `[DONE]` 正常结束；失败时先停用 Key，不连续重试。
- **生产数据**：上线前后比较 `users`、`progress` 数量和 `MAX(updated_at)`；仓库文件未变不代表生产数据已经核验。
- **多标签页覆盖**：当前接受极少数同时写入覆盖的边缘风险。若出现真实反馈，再单独设计基于 `storage` 事件和版本戳的合并机制。
- **回归保护**：每次发布前运行 `cd server/api && npm test`，必须同时通过旧接口、AI 边缘行为和前端本地存储测试。
