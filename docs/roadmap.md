# Roadmap

## v0.1（当前）骨架

- [x] 抖音式竖向滑动实验流（iframe 懒加载，±1 挂载）
- [x] 边缘手势：竖条上下滑翻页、右缘左滑目录、左缘右滑"我的"
- [x] 目录侧栏：学科/学段 chips、搜索、直达跳转
- [x] "我的"侧栏：信息（探索进度）、历史（localStorage）、AI 问答占位
- [x] manifest.json 与生成脚本，内容与 App 解耦
- [ ] 启用 GitHub Pages 部署

## v0.2 PWA 化（当前）

- [x] manifest.webmanifest + 图标（192/512/maskable/apple-touch），可安装到手机/平板主屏
- [x] Service Worker：App 壳预缓存离线可用，manifest.json 网络优先，跨域实验内容不拦截
- [x] iOS meta（standalone、状态栏、主屏标题）与安全区适配
- [ ] iOS Safari 真机回归（添加到主屏幕后全屏/手势确认）

## v0.3 平板 / 桌面适配（当前）

- [x] 宽屏（≥900px）目录常驻左侧栏，feed/HUD/手势条整体右移，跨断点自动归位
- [x] 桌面端实验 iframe 最大 1280px 居中
- [ ] 平板真机回归（横竖屏切换、手势条宽度微调）

## v0.4 AI 问答（当前）

- [x] DeepSeek 接入（OpenAI 兼容），BYOK：key 存本机 localStorage，⚙ 设置面板可改接口/模型
- [x] Cloudflare Worker 代理代码与部署说明（对外分发/CORS 兜底）
- [x] 当前实验标题/学科/学段注入系统提示
- [x] 流式输出、会话历史（保留最近 12 条）、清空对话
- [ ] 实验正文摘要注入（需要抓取实验 HTML 内容，待做）
- [ ] 部署 Worker 并切换为代理模式

## v0.5 用户体系（当前）

- [x] 账号登录：自托管后端（Node/Express + MySQL），邮箱密码 + JWT + bcrypt
- [x] 浏览历史云端同步：服务端合并（并集去重保留较新时间戳）、防抖自动上推、立即同步/退出登录
- [x] 后端安全：CORS 白名单、登录限流、仅监听 127.0.0.1（nginx 443 反代）
- [x] 后端冒烟测试 12 项（内存 DB）；前端静态校验通过
- [x] 部署文档（docs/aliyun-deploy.md）+ 建表 SQL
- [ ] 服务器端到端登录回归（部署后双设备验证）
- [ ] 学习数据统计视图（按学科/学段维度）

> 备注：v0.5 初版曾用 Supabase（境外，国内访问不稳），已改为自托管在阿里云 ECS。

## 待定想法

- 实验推荐顺序（按学段课程进度而非目录顺序）
- 双指/三指手势作为翻页备选方案
- 内容仓库 CI：push 时自动重新生成 manifest 并提交
- AI 注入实验正文摘要
