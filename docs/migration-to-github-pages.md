# 迁移到 GitHub Pages 执行计划

## 目标

将 Science-Lab 前端从阿里云迁移到 GitHub Pages，阿里云只保留 API 服务。

---

## 阶段 1：验证 GitHub Pages 状态

### 1.1 检查 Science-Lab 仓库 GitHub Pages

```bash
# 检查仓库设置
# 访问：https://github.com/Albert-Huo/Science-Lab/settings/pages
# 确认：
# - Source: Deploy from a branch
# - Branch: main
# - Folder: / (root)
```

### 1.2 检查 HTML- 仓库 GitHub Pages

```bash
# 访问：https://github.com/Albert-Huo/HTML-/settings/pages
# 确认配置同上
```

### 1.3 验证 CNAME 文件

**Science-Lab/CNAME**：
```
lab.xingnian.net.cn
```

**HTML-/CNAME**：
```
html.xingnian.net.cn
```

### 1.4 测试 GitHub Pages 访问

```bash
curl -I https://albert-huo.github.io/Science-Lab/
curl -I https://albert-huo.github.io/HTML-/
```

**预期**：返回 200 OK

---

## 阶段 2：准备 API 子域名

### 2.1 添加 DNS 记录

登录阿里云 DNS 控制台，添加记录：

```
类型：A
主机记录：api
记录值：47.97.174.49
TTL：600
```

### 2.2 申请 SSL 证书

```bash
# SSH 到阿里云服务器
ssh root@47.97.174.49

# 申请证书
sudo certbot certonly --nginx -d api.xingnian.net.cn

# 记录证书路径
# /etc/letsencrypt/live/api.xingnian.net.cn/fullchain.pem
# /etc/letsencrypt/live/api.xingnian.net.cn/privkey.pem
```

---

## 阶段 3：修改前端代码（跨域 API）

### 3.1 修改 AI 聊天 API 端点

**文件**：`Science-Lab/ai-chat.js`

**查找**：
```javascript
const endpoint = '/api/ai/chat/completions';
```

**替换为**：
```javascript
const API_BASE = 'https://api.xingnian.net.cn';
const endpoint = `${API_BASE}/api/ai/chat/completions`;
```

### 3.2 修改流量统计 API 端点

**文件**：`Science-Lab/admin/traffic/index.html`（如果存在前端调用）

需要搜索所有 `/api/` 或 `/admin/` 的 fetch 调用，改为：
```javascript
const API_BASE = 'https://api.xingnian.net.cn';
fetch(`${API_BASE}/admin/traffic/data`)
```

### 3.3 修改后端 CORS 配置

**文件**：`Science-Lab/server/api/index.js`

**查找**：
```javascript
const CORS_ORIGINS = process.env.CORS_ORIGINS?.split(',') || [];
```

**修改环境变量**（服务器 `/etc/science-lab-api.env`）：
```bash
CORS_ORIGINS=https://lab.xingnian.net.cn
```

**修改代码**（如果硬编码）：
```javascript
const allowedOrigins = [
  'https://lab.xingnian.net.cn',
  'http://localhost:8788', // 本地开发
];
```

### 3.4 提交代码

```bash
cd /Users/lx100/projects/HTML-GitHub/Science-Lab
git add ai-chat.js server/api/index.js
git commit -m "迁移到 GitHub Pages：API 端点改为 api.xingnian.net.cn

- AI 聊天 API 改为跨域调用
- 后端 CORS 允许 lab.xingnian.net.cn
- 为阶段 5 DNS 切换做准备

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
git push
```

---

## 阶段 4：配置阿里云 nginx

### 4.1 创建 API 子域名配置

**文件**：`/etc/nginx/sites-available/api.xingnian.net.cn`

```nginx
server {
    listen 80;
    server_name api.xingnian.net.cn;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.xingnian.net.cn;

    ssl_certificate /etc/letsencrypt/live/api.xingnian.net.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.xingnian.net.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # CORS 预检请求
    add_header 'Access-Control-Allow-Origin' 'https://lab.xingnian.net.cn' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;

    if ($request_method = 'OPTIONS') {
        return 204;
    }

    # AI 代理（SSE 支持）
    location /api/ai/chat/completions {
        proxy_pass http://127.0.0.1:8970;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # SSE 必需配置
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding on;
    }

    # 流量统计后台
    location /admin/traffic/ {
        proxy_pass http://127.0.0.1:8970;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 健康检查
    location /api/health {
        proxy_pass http://127.0.0.1:8970;
        access_log off;
    }
}
```

### 4.2 启用配置

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/api.xingnian.net.cn \
           /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 nginx
sudo systemctl reload nginx
```

### 4.3 验证 API 访问

```bash
# 健康检查
curl https://api.xingnian.net.cn/api/health

# 应返回 {"status":"ok"}
```

---

## 阶段 5：DNS 切换到 GitHub Pages

### 5.1 修改 DNS 记录

登录阿里云 DNS 控制台：

**修改 `lab.xingnian.net.cn`**：
```
类型：CNAME
主机记录：lab
记录值：albert-huo.github.io
TTL：600
```

**修改 `html.xingnian.net.cn`**：
```
类型：CNAME
主机记录：html
记录值：albert-huo.github.io
TTL：600
```

### 5.2 等待 DNS 生效

```bash
# 检查 DNS 传播
dig lab.xingnian.net.cn +short
dig html.xingnian.net.cn +short

# 应该看到 GitHub Pages 的 IP（例如 185.199.108.153）
```

### 5.3 强制 HTTPS（GitHub Pages 设置）

访问仓库设置页面：
- https://github.com/Albert-Huo/Science-Lab/settings/pages
- https://github.com/Albert-Huo/HTML-/settings/pages

勾选：**Enforce HTTPS**

---

## 阶段 6：验证和监控

### 6.1 功能验证清单

```bash
# 1. 应用壳加载
curl -I https://lab.xingnian.net.cn/

# 2. 实验内容加载
curl -I https://html.xingnian.net.cn/physics-middle/experiment-01.html

# 3. AI 对话（需要浏览器测试）
# 打开 https://lab.xingnian.net.cn/
# 点击"我的" → AI 问答
# 发送一条消息，确认回复正常

# 4. 流量统计后台
# 访问 https://lab.xingnian.net.cn/admin/traffic/
# 输入账号密码，确认数据正常显示

# 5. Service Worker 缓存
# 打开开发者工具 → Application → Cache Storage
# 确认看到 sl-shell-v0.8.24 和 sl-experiments-v1
```

### 6.2 性能测试

```bash
# 对比迁移前后的加载时间
time curl -s https://lab.xingnian.net.cn/ > /dev/null
time curl -s https://html.xingnian.net.cn/physics-middle/experiment-01.html > /dev/null
```

### 6.3 监控一周

**检查项**：
- [ ] 阿里云流量下降到 < 100MB/天
- [ ] GitHub Pages 流量正常
- [ ] AI 对话无报错
- [ ] 流量统计数据持续更新
- [ ] 无用户反馈访问问题

---

## 阶段 7：清理阿里云资源

### 7.1 备份旧静态文件

```bash
ssh root@47.97.174.49

# 创建备份
sudo tar -czf /var/backups/science-lab-static-$(date +%Y%m%d).tar.gz \
    /var/www/science-lab-current

# 验证备份
sudo tar -tzf /var/backups/science-lab-static-*.tar.gz | head
```

### 7.2 删除旧 nginx 配置

```bash
# 禁用旧配置
sudo rm /etc/nginx/sites-enabled/lab.xingnian.net.cn

# 重载 nginx
sudo nginx -t && sudo systemctl reload nginx
```

### 7.3 删除静态文件（可选，建议保留 1 个月）

```bash
# 1 个月后确认无问题再删除
sudo rm -rf /var/www/science-lab-current
sudo rm -rf /var/www/science-lab
```

---

## 回滚方案

### 如果迁移失败，立即回滚：

**1. DNS 回滚**（最快 5 分钟生效）：
```
lab.xingnian.net.cn → A 记录 → 47.97.174.49
html.xingnian.net.cn → A 记录 → 47.97.174.49
```

**2. 代码回滚**：
```bash
cd /Users/lx100/projects/HTML-GitHub/Science-Lab
git revert HEAD
git push
```

**3. nginx 回滚**：
```bash
# 恢复旧配置
sudo ln -s /etc/nginx/sites-available/lab.xingnian.net.cn \
           /etc/nginx/sites-enabled/
sudo systemctl reload nginx
```

---

## 预期收益

### 成本
- **流量费节省**：¥48/年
- **带宽压力**：下降 99%
- **服务器负载**：CPU/内存下降 80%

### 性能
- **全球 CDN**：Fastly 加速
- **国内访问**：速度持平或提升
- **海外访问**：速度提升 3-5 倍

### 维护
- **前端部署**：推送即生效
- **阿里云专注**：只管 API
- **故障隔离**：前后端独立

---

## 时间线

- **阶段 1-2**：30 分钟（验证 + DNS 准备）
- **阶段 3**：1 小时（代码修改 + 测试）
- **阶段 4**：30 分钟（nginx 配置）
- **阶段 5**：30 分钟（DNS 切换 + 等待生效）
- **阶段 6**：1 周（监控验证）
- **阶段 7**：30 分钟（清理）

**总计**：约 3 小时主动操作 + 1 周监控

---

## 执行者

- **Codex**：自动化执行阶段 1-6 的代码改动和验证
- **用户**：手动执行 DNS 修改、nginx 配置（需要阿里云权限）

---

## 下一步

将此计划发送给 Codex，执行阶段 1-3（代码改动部分）。
