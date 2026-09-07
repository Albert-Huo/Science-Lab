# 实验馆独立日志与私有报告

**用户确认：** 采用上一轮已说明的最简方案：独立 Nginx 访问日志，按需生成私有报告；不加数据库、不改网页、不加追踪脚本。沿用当前仓库与已授权发布流程，不做无关修改。

**设计与边界：** 两个 `server_name lab.xingnian.net.cn` 后各新增 `access_log /var/log/nginx/science-lab-access.log main;`，复用已验证的 main 格式及 `/var/log/nginx/*log` 每日轮转策略。原始日志仍只在服务器；本地生成无外部资源的静态 HTML，只展示汇总，不发布到 Web 根目录。地区、停留时间和 GitHub Pages 实验热度不在本次范围。

**统计口径：** 只处理独立日志（当前文件和日期轮转文件，兼容 gzip），不读取旧混合日志。以北京时间按日汇总；入口请求仅计算浏览器特征、非明显自动化、GET `/` 或 `/index.html` 且状态为 200/304 的请求。访客估算按 IP 与浏览器标识组合去重，只在内存中使用标识；不能称为真实人数。HTTP 重定向、HEAD、资源/API、扫描和验收请求均不计入入口指标。缓存预取可能多计、离线访问可能漏计，报告明确提示。

**文件：** 新建 `tools/traffic-report.cjs`、`server/api/test/traffic-report.js`、本记录；更新 `server/api/package.json` 接入测试、`README.md` 增加使用说明、`docs/aliyun-deploy.md` 保留独立日志配置和验证说明。线上仅修改 `/etc/nginx/conf.d/science-lab.conf` 两行，不更改 App/API 文件、主配置和日志保留策略。

- [x] 检查现有配置、日志格式、轮转规则及服务基线。
- [x] 先写测试：入口过滤、日期分组、机器人与验收排除、标识不泄露、普通/gzip 日志、混合日志不读取、异常数据提示和报告空态。
- [x] 运行 `node server/api/test/traffic-report.js` 确认新功能尚未实现，再实现并跑通；运行 `npm test --prefix server/api`。
- [x] 保存配置备份；仅替换已核对摘要的站点配置。执行 `nginx -t` 后 graceful reload，失败恢复原配置。
- [x] 用唯一验收标记验证 HTTP/HTTPS 请求进入独立日志且不再写入共享日志；这些请求由报告排除。验证轮转匹配、网站静态内容/API 健康及后台 PID 不变。
- [x] 从服务器内存汇总生成第一份本地私有 HTML，检查桌面/手机布局和零外部请求；不伪造历史数据，空态如实显示。
- [x] 记录配置摘要、备份位置、开始时间与验证结果；确认待提交范围仅为工具、测试与文档，保留用户原有未追踪文件。提交推送结果以 Git 历史与远端分支回执为准。

## 基线

- 站点配置 SHA-256：`ffcb24c7c61b1c27334a284119ca8a968c47f060e3dac39feb89c407632a3683`。
- Nginx 主配置 SHA-256：`38a3f0202e1d912bd4f1265a95d4fea78b8a016e2f931a6e55a325a075de8e94`。
- 轮转配置 SHA-256：`fff361d947d8edbde67523fd547d55cee97472ab27542b190aa006edbc4680b6`。
- Nginx master PID 2737，API PID 468357；静态 release 为 `/var/www/science-lab-releases/20260907-662dbe1f369d`。
- 旧混合访问日志截至本次前一轮检查覆盖 2026-08-28 至 2026-09-07，约 0.92 MB，不能迁移为实验馆历史访客数据。

## 上线与问题验证记录

- 首次配置调整于 21:34 触发校验回退，原配置摘要恢复一致。原因是 `systemctl reload` 只发送 HUP，立即发出的验收请求仍由旧 worker 处理；检查日志与服务记录，没有发现配置加载错误。重试增加带标记的就绪探测，第二次探测确认新日志接收请求后才执行正式验收。
- 2026-09-07 21:41:02 +08:00 独立日志启用验证通过。新站点配置 SHA-256：`64fb7fb76edc7983295c5f6ca6aa156b2e9f4f2954e5ab0ade0aa19e696230b8`。备份：`/var/tmp/science-lab-log-20260907-m2odxl-r2/science-lab.conf.before`；备份摘要与基线相同。
- `nginx -t`、HTTP 301、HTTPS 首页内容逐字节比对、API 健康检查通过。正式验收的三个标记仅在独立日志出现，未写入共享日志。`logrotate --debug` 确认覆盖新日志，未强制轮转。主配置与轮转配置摘要、静态 release、Nginx master PID 和 API PID 均未变化。
- 工具最初的 `require.main === module` 判断不适用于远程 `node -`，导致标准输入执行时没有输出。补充真实子进程 stdin 回归测试并确认失败，再兼容 `[stdin]` 模块入口；10 项统计专项测试全部通过，远程生成报告也已成功。
- 第一份真实报告只有验收请求，入口请求与访客估算均为 0，解析失败为 0；没有把模拟数据或旧混合日志填入报告。报告保存在本机私有位置，不提交、不发布。
- 完整 `npm test --prefix server/api` 通过，`git diff --check` 通过。初次完整测试受到沙箱禁止本机监听端口的限制，在允许回环端口后重跑全部测试通过，未连接生产数据库。
- 独立无界面浏览器 `task-a647d9` 在内存中加载本地报告，1280 px 和 390 px 视口均无页面横向溢出，未发起任何网络请求，无脚本或页面错误；手机趋势表可在表格区域横向滚动。电脑、手机截图已检查，仅保存在本地 `output/playwright/private-traffic-report/`。
- 本次无需重新部署静态站或 API，App 仍为 v0.8.7。无新定时任务，无数据库变更，无第三方统计服务。
