# 自托管同步后端部署（阿里云 ECS + Node + MySQL）

把 v0.5 的云同步后端部署到你自己的阿里云服务器，替代第三方。后端是一个独立的 Node/Express 服务，监听本机端口，由 nginx 以**子域名 + HTTPS** 反代对外，与现有网站互不影响。

前端在 GitHub Pages（https），浏览器会拦截对明文 http 接口的调用，因此接口**必须走 https**。

代码位置：`server/api/`。

## 0. 准备

- 一个解析到本服务器的子域名，例如 `api.xingnian.net.cn`，并签发 TLS 证书（Let's Encrypt 或阿里云免费证书）。
- 服务器已装 Node ≥ 18 与可用的 MySQL（自建或阿里云 RDS）。
- 安全组/防火墙**只放行 443**（和现有网站需要的端口）；Node 端口（默认 8970）只监听 127.0.0.1，不要对公网开放。

## 1. 建库与表

为本应用单独建库和账号，避免动现有网站的数据：

```sql
CREATE DATABASE sciencelab CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sciencelab'@'%' IDENTIFIED BY '换成强密码';
GRANT ALL PRIVILEGES ON sciencelab.* TO 'sciencelab'@'%';
FLUSH PRIVILEGES;
```

导入表结构：

```bash
mysql -u sciencelab -p sciencelab < server/api/schema.sql
```

## 2. 部署 Node 服务

```bash
# 把仓库的 server/api 传到服务器，例如 /opt/science-lab-api
cd /opt/science-lab-api
npm install --omit=dev

cp .env.example .env
# 编辑 .env：
#   JWT_SECRET 用随机串：node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DB_* 填上面建的库与账号
#   CORS_ORIGINS 填前端实际地址（GitHub Pages / 自有域名）
nano .env

# 用 pm2 常驻
npm install -g pm2
pm2 start server.js --name science-lab-api
pm2 save
pm2 startup   # 按提示执行输出的命令，实现开机自启
```

健康检查：`curl http://127.0.0.1:8970/health` 应返回 `{"ok":true}`。

## 3. nginx 反代（子域名 + HTTPS）

新增一个 server 块，不要改动现有网站的配置：

```nginx
server {
    listen 443 ssl http2;
    server_name api.xingnian.net.cn;            # 换成你的子域名

    ssl_certificate     /etc/nginx/ssl/api.crt;  # 换成你的证书路径
    ssl_certificate_key /etc/nginx/ssl/api.key;

    location / {
        proxy_pass http://127.0.0.1:8970;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
# 可选：80 跳转 443
server {
    listen 80;
    server_name api.xingnian.net.cn;
    return 301 https://$host$request_uri;
}
```

```bash
nginx -t && nginx -s reload
```

验证：`curl https://api.xingnian.net.cn/health` 返回 `{"ok":true}`。

## 4. 在 App 中启用

打开 App →「我的」→ 云同步 → ⚙ → 填入 `https://api.xingnian.net.cn` → 保存 → 注册/登录。之后浏览实验时进度自动同步，换设备登录同一账号即可合并历史。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/auth/register` | `{email,password}` → `{token,email}` |
| POST | `/auth/login` | `{email,password}` → `{token,email}` |
| GET | `/progress` | 需 Bearer token，返回 `{history}` |
| PUT | `/progress` | 需 Bearer token，上传并服务端合并，返回权威 `{history}` |

## 安全要点

- 密码 bcrypt 加盐哈希存储；登录态用 JWT（密钥在 `.env`，勿入库勿入仓库）。
- 注册/登录接口限流（15 分钟 30 次/IP）。
- CORS 仅放行 `CORS_ORIGINS` 白名单。
- Node 仅监听 127.0.0.1，对外只暴露 nginx 443。
- 升级密码策略、加邮箱验证或换魔法链接登录，可后续在 `server/api/server.js` 扩展。
