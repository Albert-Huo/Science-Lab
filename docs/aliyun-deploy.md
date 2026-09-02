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

## 2. 部署 Node API 服务

```bash
# 把仓库 server/api 传到服务器，例如 /opt/science-lab-api
cd /opt/science-lab-api
npm install --omit=dev
cp .env.example .env
# 编辑 .env：
#   JWT_SECRET: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DEEPSEEK_API_KEY: 服务端专用 DeepSeek API Key（不要提交到 Git）
#   AI_RATE_LIMIT_MINUTE_MAX: 单 IP 每分钟上限，默认 10
#   AI_RATE_LIMIT_DAY_MAX: 单 IP 每日上限，默认 500
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

把仓库根目录这些文件放到该子域名的站点根（如 `/var/www/science-lab`）：

```
index.html  manifest.json  manifest.webmanifest  sw.js  assets/
```

```bash
mkdir -p /var/www/science-lab
# 从仓库根拷贝（按实际路径）
cp index.html manifest.json manifest.webmanifest sw.js /var/www/science-lab/
cp -r assets /var/www/science-lab/
```

`server/`、`docs/`、`tools/` 不用上传，它们不是网页运行所需。

## 4. nginx：一个 server 同时托管页面与接口

```nginx
server {
    listen 443 ssl http2;
    server_name lab.xingnian.net.cn;             # 换成你的子域名

    ssl_certificate     /etc/nginx/ssl/lab.crt;
    ssl_certificate_key /etc/nginx/ssl/lab.key;

    root /var/www/science-lab;
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

    # Service Worker 不缓存，保证更新及时
    location = /sw.js { add_header Cache-Control "no-cache"; }

    # 静态页面
    location / { try_files $uri $uri/ /index.html; }
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
    -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"用一句话解释惯性"}]}'
  ```

- 浏览器打开 `https://lab.xingnian.net.cn/` 看到 App

## 5. 启用内置 AI

确认 `.env` 已设置 `DEEPSEEK_API_KEY`，执行 `pm2 restart science-lab-api --update-env`，再打开 App →「我的」→「AI 问答」直接提问。默认模式不需要在浏览器填写任何配置。

如果暂不配置 Key，前端会收到明确的 503 提示；用户仍可在 AI 设置中开启 BYOK，使用自己的 OpenAI 兼容 endpoint、model 和 Key。

## 更新发布

改了前端后，重新拷贝静态文件到站点根即可；`sw.js` 里的版本号每次发布我会递增，用户端会自动更新。后端改动则 `pm2 restart science-lab-api`。

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
- AI 路由叠加每分钟和每日两级 IP 限流，默认分别为 10 次和 500 次，可用 `AI_RATE_LIMIT_MINUTE_MAX`、`AI_RATE_LIMIT_DAY_MAX` 调整。
- AI 上游请求默认在 120 秒后中止，客户端断开连接时也会中止；可用 `AI_UPSTREAM_TIMEOUT_MS` 调整总超时。
- AI 请求仅接受最多 20 条 `messages`；角色和单条长度受限；模型仅允许 `deepseek-chat`；服务端强制流式响应、`max_tokens ≤ 2048`、`temperature ∈ [0,2]`，其他字段不会透传。
- `DEEPSEEK_API_KEY` 只放在服务端 `.env`。错误响应不会回显 Key 或 DeepSeek 原始错误正文；建议同时设置 DeepSeek 账户预算告警并定期轮换 Key。
- Node 仅监听 127.0.0.1，对外只经 nginx 443。
- 同源部署天然规避跨站；如分域部署再依赖 `CORS_ORIGINS` 白名单。
- 当前限流计数保存在单个 Node 进程内。若用 PM2 cluster、多个容器或多台机器，实际总额度会按实例放大，应改用共享 Redis store 或在网关/WAF 再加全局限流。
- CORS 不是滥用防护。上线后应监控 429、502、调用量与供应商费用；遭遇攻击时先在 nginx/WAF 封禁异常来源并下调限额。
