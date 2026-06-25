# 部署到阿里云（同源方案：页面 + 接口同域）

把 **App 页面和同步接口部署在同一个新子域名**下，例如 `lab.xingnian.net.cn`：

- 页面：`https://lab.xingnian.net.cn/`（静态文件，nginx 直接托管）
- 接口：`https://lab.xingnian.net.cn/api/`（反代到本机 Node 服务）

二者同源，**不需要 CORS**，前端也无需手填接口地址（默认调用本站 `/api`）。主域名留给现有网站，互不影响。实验内容仍从 `html.xingnian.net.cn` 加载。

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

## 2. 部署 Node 同步服务

```bash
# 把仓库 server/api 传到服务器，例如 /opt/science-lab-api
cd /opt/science-lab-api
npm install --omit=dev
cp .env.example .env
# 编辑 .env：
#   JWT_SECRET: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DB_* 填上面建的库与账号
#   同源部署时 CORS 用不到，可只填本子域名（留作保险）
nano .env

npm install -g pm2
pm2 start server.js --name science-lab-api
pm2 save && pm2 startup    # 按提示执行输出命令，开机自启
```

健康检查：`curl http://127.0.0.1:8970/health` → `{"ok":true}`。

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
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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
- 浏览器打开 `https://lab.xingnian.net.cn/` 看到 App

## 5. 启用同步

打开 App →「我的」→ 云同步：因与接口同源，状态应直接是「未登录」，**无需填接口地址**，直接注册/登录即可。换设备登录同一账号即合并历史。

（若以后把接口单独放到别的域名，再在 ⚙ 填那个 https 地址即可。）

## 更新发布

改了前端后，重新拷贝静态文件到站点根即可；`sw.js` 里的版本号每次发布我会递增，用户端会自动更新。后端改动则 `pm2 restart science-lab-api`。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/register` | `{email,password}` → `{token,email}` |
| POST | `/api/auth/login` | `{email,password}` → `{token,email}` |
| GET | `/api/progress` | 需 Bearer token，返回 `{history}` |
| PUT | `/api/progress` | 需 Bearer token，服务端合并，返回 `{history}` |

## 安全要点

- 密码 bcrypt 哈希；登录态 JWT（密钥在 `.env`）。
- 注册/登录限流（15 分钟 30 次/IP）。
- Node 仅监听 127.0.0.1，对外只经 nginx 443。
- 同源部署天然规避跨站；如分域部署再依赖 `CORS_ORIGINS` 白名单。
