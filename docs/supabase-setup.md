# 云同步配置（Supabase）

v0.5 用 Supabase 实现可选的账号登录与浏览进度跨设备同步。采用 BYOK 模式：你建自己的 Supabase 项目，把项目 URL 和**公开 anon key** 填进 App 的「我的 → 云同步 → ⚙」。anon key 是 Supabase 设计为可暴露在前端的密钥，真正的数据安全由行级安全策略（RLS）保证——每个用户只能读写自己的那一行。

未配置时 App 行为完全不变，所有数据只存本设备。

## 一、建项目

1. 打开 https://supabase.com → 新建项目（免费层即可），记下区域，等待初始化完成。
2. 项目 → Settings → API，复制两项：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon public** key（很长的 `eyJ…`）

## 二、建表与安全策略

项目 → SQL Editor → New query，粘贴并运行：

```sql
-- 进度表：每个用户一行
create table if not exists public.progress (
  user_id    uuid primary key references auth.users on delete cascade,
  history    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 开启行级安全
alter table public.progress enable row level security;

-- 仅本人可读写自己的行
create policy "progress_select_own" on public.progress
  for select using (auth.uid() = user_id);
create policy "progress_insert_own" on public.progress
  for insert with check (auth.uid() = user_id);
create policy "progress_update_own" on public.progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## 三、开启邮箱登录（魔法链接）

1. 项目 → Authentication → Providers → **Email**，确认已启用。
2. 为简化使用，可关闭 "Confirm email" 改用 Magic Link（默认邮件即含登录链接）。
3. 项目 → Authentication → URL Configuration：
   - **Site URL** 填你的 App 地址，如 `https://albert-huo.github.io/Science-Lab/`
   - 本地调试再在 **Redirect URLs** 添加 `http://127.0.0.1:8788/Science-Lab/index.html`

   登录链接会跳回这些地址，必须先登记，否则点链接会报 redirect 错误。

## 四、在 App 中启用

1. 打开 App →「我的」→ 云同步 → ⚙ → 粘贴 Project URL 与 anon key → 保存。
2. 输入邮箱 → 发送登录链接 → 到邮箱点击链接（用**同一浏览器**打开）。
3. 回到 App 即自动登录并完成首次合并同步。之后浏览实验时进度会防抖自动上传。

## 同步内容与策略

- 同步的是**浏览历史**（每个实验最近一次访问时间，最多 100 条）；统计卡片的"已浏览/进度"由历史推导，因此跨设备一致。
- "回到上次位置"是按设备本地记忆，不参与云端同步（各设备独立更合理）。
- 合并策略：登录时云端与本地历史按实验路径取并集、每条保留较新的时间戳，写回本地后再上传，避免任一端记录丢失。
- AI 的 API Key **不会**同步，仅存本设备。

## 邮件发送量

Supabase 免费层内置邮件有发送配额，适合个人/小范围。若要给较多用户使用，在 Authentication → Settings 配置自有 SMTP。
