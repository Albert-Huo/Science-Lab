# Science-Lab 迁移到 GitHub Pages - 技术交接文档

## 给技术朋友的话

这是一个将网站静态文件从阿里云迁移到 GitHub Pages 的项目，代码部分（阶段 1-3）已完成并推送，需要你帮忙完成服务器配置部分（阶段 4-5）。

**预计工作时间**：30-40 分钟  
**技术要求**：熟悉 Linux、nginx、DNS 配置  
**风险等级**：低（有完整回滚方案）

---

## 当前状态

### ✅ 已完成（代码部分）
- GitHub Pages 验证通过
- CNAME 文件已创建
- 前端 API 端点已改为跨域调用 `https://api.xingnian.net.cn`
- 后端 CORS 配置已准备好
- 代码已推送到 GitHub（提交 `f0e0fa1`）

### 🔧 需要你完成（服务器配置）
- 添加 DNS A 记录：`api.xingnian.net.cn`
- 申请 SSL 证书
- 配置 nginx（新建 API 子域名配置）
- 修改服务器环境变量（CORS 配置）
- 修改 DNS CNAME 记录切换到 GitHub Pages

---

## 阶段 4：配置阿里云 nginx

### 4.1 添加 DNS A 记录

登录阿里云控制台 → 云解析 DNS → 解析设置：

```
类型：A
主机记录：api
记录值：47.97.174.49
TTL：600（10分钟）
```

**验证**：
```bash
nslookup api.xingnian.net.cn
# 应该看到解析到 47.97.174.49
```

### 4.2 申请 SSL 证书

SSH 登录服务器：
```bash
ssh root@47.97.174.49
```

申请 Let's Encrypt 证书：
```bash
sudo certbot certonly --nginx -d api.xingnian.net.cn
```

**证书路径**（记下来，后面配置 nginx 要用）：
```
/etc/letsencrypt/live/api.xingnian.net.cn/fullchain.pem
/etc/letsencrypt/live/api.xingnian.net.cn/privkey.pem
```

### 4.3 创建 nginx 配置文件

创建新配置：
```bash
sudo nano /etc/nginx/sites-available/api.xingnian.net.cn
```

**完整配置内容**（复制粘贴）：

```nginx
# HTTP 自动跳转 HTTPS
server {
    listen 80;
    server_name api.xingnian.net.cn;
    return 301 https://$server_name$request_uri;
}

# HTTPS 配置
server {
    listen 443 ssl http2;
    server_name api.xingnian.net.cn;

    # SSL 证书（certbot 生成的路径）
    ssl_certificate /etc/letsencrypt/live/api.xingnian.net.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.xingnian.net.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # CORS 头（允许跨域）
    add_header 'Access-Control-Allow-Origin' 'https://lab.xingnian.net.cn' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;

    # OPTIONS 预检请求
    if ($request_method = 'OPTIONS') {
        return 204;
    }

    # AI 聊天代理（支持 Server-Sent Events 流式响应）
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

### 4.4 启用配置

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/api.xingnian.net.cn \
           /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 nginx
sudo systemctl reload nginx
```

**验证 API 可访问**：
```bash
curl https://api.xingnian.net.cn/api/health
# 应返回：{"status":"ok"}
```

### 4.5 修改服务器环境变量

编辑后端 API 的环境配置：
```bash
sudo nano /etc/science-lab-api.env
```

**添加或修改这一行**：
```bash
CORS_ORIGINS=https://lab.xingnian.net.cn
```

**重启后端服务**：
```bash
sudo systemctl restart science-lab-api

# 检查服务状态
sudo systemctl status science-lab-api
```

---

## 阶段 5：DNS 切换到 GitHub Pages

### 5.1 修改 DNS 记录

登录阿里云控制台 → 云解析 DNS → 解析设置：

**修改 `lab.xingnian.net.cn`**：
```
类型：CNAME
主机记录：lab
记录值：albert-huo.github.io
TTL：600（10分钟）
```

**修改 `html.xingnian.net.cn`**：
```
类型：CNAME
主机记录：html
记录值：albert-huo.github.io
TTL：600（10分钟）
```

### 5.2 等待 DNS 生效

**验证 DNS 传播**（5-30 分钟）：
```bash
dig lab.xingnian.net.cn +short
dig html.xingnian.net.cn +short

# 应该看到 GitHub Pages 的 IP（例如 185.199.108.153）
```

### 5.3 启用 GitHub Pages HTTPS

访问这两个链接：
- https://github.com/Albert-Huo/Science-Lab/settings/pages
- https://github.com/Albert-Huo/HTML-/settings/pages

在 **Custom domain** 下勾选：
- ✅ **Enforce HTTPS**

---

## 阶段 6：验证功能

### 6.1 功能测试清单

```bash
# 1. 应用壳加载
curl -I https://lab.xingnian.net.cn/
# 应返回 200 OK

# 2. 实验内容加载
curl -I https://html.xingnian.net.cn/physics-middle/初中物理实验01.html
# 应返回 200 OK

# 3. AI API 健康检查
curl https://api.xingnian.net.cn/api/health
# 应返回 {"status":"ok"}
```

### 6.2 浏览器测试

打开 https://lab.xingnian.net.cn/：

1. ✅ 页面正常加载
2. ✅ 实验内容可以浏览
3. ✅ 点击"我的" → "AI 问答"，发送一条消息，确认 AI 回复正常
4. ✅ 访问 https://lab.xingnian.net.cn/admin/traffic/，输入账号密码，确认流量统计后台正常

### 6.3 检查开发者工具

打开浏览器开发者工具（F12）→ Network 标签：

- ✅ 静态文件（HTML/CSS/JS）来自 `lab.xingnian.net.cn`（GitHub Pages）
- ✅ 实验内容来自 `html.xingnian.net.cn`（GitHub Pages）
- ✅ AI API 请求到 `api.xingnian.net.cn`（阿里云）
- ✅ 无 CORS 错误

---

## 回滚方案（如果迁移失败）

### 快速回滚（5 分钟）

登录阿里云 DNS 控制台，修改回原来的 A 记录：

```
lab.xingnian.net.cn → A 记录 → 47.97.174.49
html.xingnian.net.cn → A 记录 → 47.97.174.49
```

等待 DNS 生效（5-30 分钟），网站会恢复到原来的阿里云托管状态。

### 代码回滚（如果需要）

```bash
cd /Users/lx100/projects/HTML-GitHub/Science-Lab
git revert f0e0fa1
git push
```

---

## 常见问题

### Q1: DNS 修改后网站无法访问怎么办？

**A**: 等待 DNS 生效（通常 5-30 分钟）。期间部分用户可能看到旧站点，部分看到新站点，这是正常的。如果超过 1 小时还不正常，执行回滚方案。

### Q2: AI 对话报错 "CORS 错误"？

**A**: 检查两个地方：
1. nginx 配置中的 CORS 头是否正确
2. `/etc/science-lab-api.env` 中的 `CORS_ORIGINS` 是否设置为 `https://lab.xingnian.net.cn`

修改后重启服务：`sudo systemctl restart science-lab-api`

### Q3: 流量统计后台无法访问？

**A**: 检查 nginx 配置中的 `/admin/traffic/` location 是否配置正确，并且服务是否正常运行：`sudo systemctl status science-lab-api`

### Q4: SSL 证书申请失败？

**A**: 确保：
1. DNS A 记录 `api.xingnian.net.cn` 已生效并指向服务器
2. 服务器 80 端口可访问（Let's Encrypt 验证需要）
3. 检查 certbot 错误日志：`sudo tail -f /var/log/letsencrypt/letsencrypt.log`

---

## 迁移后的架构

```
用户浏览器
  ↓
lab.xingnian.net.cn (GitHub Pages)
  ├── 应用壳：index.html, sw.js, assets/*
  └── 实验内容：加载自 html.xingnian.net.cn (GitHub Pages)

需要 AI 或统计时：
  ↓
api.xingnian.net.cn (阿里云 nginx)
  ├── /api/ai/chat/completions → Node.js (127.0.0.1:8970)
  └── /admin/traffic/ → Node.js (127.0.0.1:8970)
```

---

## 技术支持

如果遇到问题，可以：

1. 查看完整迁移计划：`docs/migration-to-github-pages.md`
2. 检查 nginx 错误日志：`sudo tail -f /var/log/nginx/error.log`
3. 检查后端服务日志：`sudo journalctl -u science-lab-api -f`
4. 回滚到原架构（见上方回滚方案）

---

**预计收益**：

- 🚀 加载速度提升 3-5 倍（GitHub Pages 全球 CDN）
- 📈 抗流量爆发（不再受 1-2Mbps 带宽限制）
- 🌍 海外访问友好（全球 CDN 节点）
- 💻 服务器负载下降 80%（只跑 API，不处理静态文件）

---

**开始时间**：___________  
**完成时间**：___________  
**操作人**：___________
