# 引导式日记应用：产品与开发实施计划（v1.1 修订版）

> 文档版本：v1.1（修订版，替代 v1.0）
> 修订日期：2026-09-10
> 产品形态（终态）：网页端、Android APK、iOS 主屏幕 PWA
> **首版交付形态（本版确定）：响应式网页端 + PWA 安装 + 服务端 Web Push。Android APK 与 iOS 完整引导移入第二迭代。**

## 0. 本次修订说明（v1.0 → v1.1）

修订基于三条已确认的决定和一次技术评审，逐节的对照表见 **附录 C**。

三条决定：

1. **数据模型改为"当天字段"模型**：字段只描述"这一天自己"，"昨日回顾"是填写入口、不是存储位置。消除 v1.0 中 `yesterday_*` 字段"到底存在哪一行"的歧义。
2. **首版范围收窄为网页端**：网页端（含 PWA 安装）+ 服务端 Web Push 为第一迭代；Android APK、iOS 完整安装/授权引导、导出、统计为第二迭代。
3. 据此重排里程碑、测试矩阵与验收标准。

评审发现、必须修正的问题：

| # | v1.0 的问题 | v1.1 的处理 |
| --- | --- | --- |
| 1 | 部署组合不自洽：Vercel serverless 无法跑 BullMQ worker，Vercel Cron 频率受限，Prisma 在 serverless 需额外连接池 | §6 改为"单个常驻 Node 服务（API + worker）"，排程默认用 Postgres 任务表，Redis/BullMQ 作为可替换项 |
| 2 | `yesterday_events / yesterday_meals` 存在哪一行写法冲突（§3.1 vs §4.2） | §4 / §5 改为当天字段模型，`entry_date` 即内容归属日；日历、补写、统计全部退化为"读一行" |
| 3 | 缺少"日记日"边界定义，凌晨填写会串天 | §5 新增日界规则（默认本地 04:00 起算），前后端共用同一算法 |
| 4 | 把"09:00 准时提醒"写进验收标准（Web Push 无法保证） | §7 / §13 改为"当天送达、不承诺准点"，并给出降级表述 |
| 5 | 整行 LWW 冲突策略会静默丢弃另一端的修改 | §9 改为字段级写入 + 字段级 LWW + `overwritten` 提示 |
| 6 | Capacitor 打包与"一套前端零成本复用"的预期不符（前端改动需重发 APK；远程加载有审核风险） | 移入第二迭代，并在 §6.4 写清取舍与前置决策 |
| 7 | 未登录试用 + 本地存储会产生前端 merge 逻辑 | §8.1 改为"匿名账号起步 + 登录后服务端升级"，不做纯本地试用 |
| 8 | 缺少排程/时区/DST/幂等的可验证设计 | §7.3、附录 B 给出 `reminder_schedule` + `notification_deliveries` 设计与算法伪代码 |

> 平台能力（iOS Web Push、Android 精确闹钟、Capacitor 本地通知重启恢复、商店政策）必须按 §16 的方式，用**官方文档 + 真机 spike** 落锤；本版凡涉及平台细节处均标注了待验证项。

---

## 1. 项目目标与范围

### 1.1 产品目标

开发一款私密、轻量、带固定问题引导的日记应用。用户不必面对空白编辑器，而是通过早间回顾、今日计划、突发记录和晚间总结，完成每天的记录与复盘。

### 1.2 迭代划分

| 迭代 | 交付形式 | 主要内容 |
| --- | --- | --- |
| **第一迭代（首版，本版重点）** | 响应式 Web + PWA 安装（桌面 Chrome/Edge/Safari、Android Chrome、iOS Safari 可安装但提醒不作门槛）；服务端 Web Push | 账号（匿名 + 邮箱）、今日页、突发记录、自动保存、日历与历史编辑、提醒设置、服务端排程与 Web Push、隐私与删除账号 |
| 第二迭代 | Android APK（Capacitor）、iOS 主屏 PWA 完整引导 | Android 本地通知与打包分发、iOS 安装/授权转化引导、导出（Markdown/JSON）、回顾统计 |

### 1.3 各终端目标

| 终端 | 第一迭代 | 第二迭代 |
| --- | --- | --- |
| 网页端 | 电脑与手机浏览器均可使用，所有数据与功能的统一入口；Chrome/Edge/Android Chrome 可收 Web Push | 持续为主入口 |
| iOS | 可通过 Safari"添加到主屏幕"安装；若用户完成安装与授权，**同一套 Web Push 即可送达**（记录实测结果，不作硬门槛） | 专门的安装/授权引导流程与转化验证 |
| Android | 使用网页端；可安装为 PWA | 可安装 APK，具备原生本地定时通知、设备重启恢复 |

### 1.4 核心需求（第一迭代）

1. 每天早上 **09:00** 提醒用户填写早间日记（默认开启"仅未完成时提醒"）。
2. 早间日记包含：昨天发生了什么、昨天吃了什么、今天准备做什么。
3. 用户可在白天随时新增多条"突发事情"记录。
4. "昨天回顾"与"今日计划"位于同一早间板块，但必须有清晰的视觉和数据分隔。
5. 每天晚上 **21:00** 提醒用户总结当天。
6. 用户可浏览、补写和编辑历史日记。
7. 数据在**同一账号的多台设备、浏览器之间同步**（第一迭代为网页端之间；APK 与 iOS PWA 在第二迭代接入同一后端）。

> 提醒的可靠性口径：**当天送达，不承诺准点**。详见 §7.1。

### 1.5 首版暂不包含

- 社区、关注、公开日记等社交功能；
- AI 自动代写日记；
- 图片、语音、附件；
- 周报/月报自动生成；
- 多人协作、家庭账号；
- 完整离线同步冲突处理（第一迭代只做"草稿暂存 + 字段级后写优先"，见 §9）；
- Android APK 与 Android 本地通知（第二迭代）；
- 导出（第二迭代）；账号删除在第一迭代提供最小可用入口（§10）。

---

## 2. 用户使用流程

```text
早上（默认 09:00 前后）收到提醒
        ↓
打开“今日日记” → 完成早间记录
        ├─ 昨天发生了什么        → 写入「昨天」那一天的记录
        ├─ 昨天吃了什么          → 写入「昨天」那一天的记录
        └─ 今天准备做什么        → 写入「今天」这一天的记录

白天任意时间
        ↓
点击“记录此刻” → 新增一条带时间的突发事情

晚上（默认 21:00 前后）收到提醒
        ↓
打开“今日日记” → 填写今日总结 → 自动保存

之后
        ↓
通过日历或列表回顾、检索、编辑历史日记
```

### 2.1 "今天""昨天"的定义（新增）

- "今天"指**日记日**，不是自然日：本地时间 **04:00** 起算新的日记日（可在设置中调整，见 §5.1）。
- 因此 00:30 打开应用，仍然是"昨天"的日记日；此时填写的"今天准备做什么"写入该日记日，而"昨天回顾"写入它的前一天。
- 所有涉及日期的计算由**服务端**以用户保存的 IANA 时区为权威（§5.3），客户端只用于显示与本地草稿暂存。

---

## 3. 信息架构与页面规划

底部导航（移动端）或左侧导航（桌面端），保留四个一级入口：

```text
应用
├── 今日
│   ├── 早间记录（昨日回顾 + 今日计划）
│   ├── 突发事情
│   └── 晚间总结
├── 日历
│   └── 单日详情与编辑（含补写）
├── 回顾（首版显示“即将推出”）
└── 设置
    ├── 提醒时间与通知权限
    ├── 时区
    ├── 账号与同步
    └── 隐私与数据导出
```

### 3.1 今日页

今日页是产品最重要的页面。日期使用用户所在时区，例如"2026 年 9 月 10 日，星期四"（若当前处于日界前，显示仍为 9 月 9 日的日记日并给出提示），并显示当日完成情况。

```text
2026 年 9 月 10 日 · 星期四                    [日历]
今日记录进度：早间已完成 · 2 条突发记录 · 晚间待完成

┌──────────────────────────────────────┐
│ 早间记录                              │
│                                      │
│ ── 昨日回顾（9 月 9 日）───────────── │
│ 昨天发生了什么？                       │
│ [多行输入框]                           │
│                                      │
│ 昨天吃了什么？                         │
│ [多行输入框]                           │
│                                      │
│ ── 今日计划（9 月 10 日）──────────── │
│ 今天准备做什么？                       │
│ [多行输入框]                           │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ 突发事情                    [+ 记录此刻] │
│ 14:32  开会时想到一个新的功能方向。     │
│ 18:10  临时完成了一个紧急任务。         │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ 晚间总结                              │
│ 今天过得怎么样？                       │
│ [多行输入框]                           │
└──────────────────────────────────────┘
```

关键设计规则：

- **昨日回顾**和**今日计划**必须分别放在不同的小节，使用不同标题、日期和分隔线，不能只靠题目顺序区分。
- 数据归属（本版澄清）：两个小节虽然显示在同一张卡片里，但**写入不同的两天记录**——昨日回顾写入"昨天"那一天的 `day_events` / `day_meals`；今日计划写入"今天"那一天的 `day_plan`。API 与数据库层面二者完全分离（§4、§8.3）。
- 突发事情按发生/记录时间排序，每条独立保存与编辑。
- 输入框采用自动保存；失焦、停止输入约 1.5 秒、页面隐藏/离开时均触发保存。
- 未填写的栏目显示引导问题；已填写栏目显示简短摘要和"编辑"入口。

### 3.2 快速记录页/弹层

点击"+ 记录此刻"后，打开轻量弹层，避免打断用户。

字段：

- 内容：必填，多行文本（上限 2000 字符）；
- 时间：默认当前时间，可手动修改（若修改后跨到另一个日记日，保存前提示"该记录将显示在 X 月 X 日"，见 §5.4）；
- 标签：可选，首版提供"工作、生活、情绪、灵感、其他"（服务端按白名单校验）；
- 记录 ID 由客户端生成 UUID（重复提交天然幂等，见 §8.4）；
- 保存后立即回到今日页并插入时间线。

### 3.3 历史日记页

第一迭代同时提供日历与列表：

- 日历中有记录的日期以圆点标记（第一迭代不做完成度配色，避免为跨行派生写复杂查询）；
- 点击某天进入单日详情；
- 单日详情展示该天**自己**的 `day_events` / `day_meals` / `day_plan` / `evening_summary` 与当天突发记录，支持补写和编辑；
- 列表显示日期、当天摘要、突发记录数量；
- 后续增加关键词搜索、按标签筛选和按月份导出（第二迭代）。

### 3.4 设置页

第一迭代包含：

- 通知总开关；
- 早间提醒时间，默认 09:00；晚间提醒时间，默认 21:00；
- 仅在未完成时提醒开关（默认开启）；
- 当前时区显示与修改（修改后立即重算排程）；
- 浏览器通知权限状态与重新授权指引（含 iOS 用户"添加到主屏幕"说明文案，完整引导流程在第二迭代）；
- 登录、退出、同步状态显示；
- 日记日起始时间（默认 04:00，高级设置，默认折叠）；
- 删除账号入口（二次确认，§10）。

第二迭代补充：应用锁、导出、深浅色偏好细化。

---

## 4. 日记内容模型（当天字段模型）

### 4.1 核心理念

**一条记录描述"这一天自己"。** "昨日回顾"是**填写入口**，"昨天"是**存储位置**。

这样做的直接收益：

- 日历、单日详情、搜索、统计、补写全部退化为"读一行"，不需要任何跨行映射；
- 补写任意历史日期天然成立（就是写那一行）；
- 不会再出现"昨天的内容被误存成今天发生的事情"这类错误（v1.0 §4.2 想防的错，由模型本身消除）。

### 4.2 每日记录字段

每天一条主记录，`entry_date` 按用户的 IANA 时区与日界规则确定（§5），唯一约束为 `user_id + entry_date`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 主键 |
| `user_id` | UUID | 所属用户 |
| `entry_date` | Date | 用户当地日记日；**即内容的归属日** |
| `day_events` | Text | 这天发生了什么（早间填写时通常写在前一天） |
| `day_meals` | Text | 这天吃了什么（同上） |
| `day_plan` | Text | 这天准备做什么 |
| `evening_summary` | Text | 这天过得怎么样（晚间总结） |
| `day_events_updated_at` 等 4 个 | Timestamp | 各字段的最后写入时间（服务端时钟），用于字段级冲突判断 |
| `version` | Integer | 行级版本号，每次写入 +1；用于审计与未来的冲突 UI 预留 |
| `reviewed_at` | Timestamp | 该天的 `day_events` / `day_meals` 首次非空的时间，可为空（用于进度展示与埋点，不参与业务判断） |
| `summarized_at` | Timestamp | 该天 `evening_summary` 首次非空的时间，可为空 |
| `created_at` / `updated_at` | Timestamp | 审计字段 |

**关于 v1.0 的 `morning_completed_at` / `evening_completed_at`**：取消。

- 完成状态改为**派生**：某天的"回顾完成"= `day_events` 或 `day_meals` 非空；"晚间完成"= `evening_summary` 非空。
- 保留 `reviewed_at` / `summarized_at` 只是为了展示"几点写的"与埋点统计，**不参与任何业务判断**，因此不会出现"时间戳与字段内容不一致"的脏数据。
- 今日页进度条涉及两天：早间部分 = 昨天的回顾字段已写 **且** 今天的 `day_plan` 已写；晚间部分 = 今天的 `evening_summary` 已写。

### 4.3 突发事情字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 主键，**由客户端生成**，重复提交天然幂等 |
| `user_id` | UUID | 所属用户 |
| `entry_date` | Date | 归属的日记日，由服务端按 `occurred_at` + 时区 + 日界计算 |
| `occurred_at` | Timestamp | 发生或记录时间 |
| `content` | Text | 内容，上限 2000 字符 |
| `tag` | Text | 可选，白名单：工作/生活/情绪/灵感/其他 |
| `created_at` / `updated_at` | Timestamp | 审计字段 |

- 查询"今天的突发事情"直接按 `(user_id, entry_date)` 查，不用按时间戳范围推算，天然避免时区/日界边界错误。
- 排序按 `occurred_at` 升序；同日多条按 `created_at` 兜底。

### 4.4 业务约定（取代 v1.0 §4.2）

以"9 月 10 日的今日页"为例：

| 界面位置 | 写入目标 | 字段 |
| --- | --- | --- |
| 昨日回顾 | **9 月 9 日**的记录 | `day_events`、`day_meals` |
| 今日计划 | **9 月 10 日**的记录 | `day_plan` |
| 突发事情 | **9 月 10 日**的记录 | `entry_date = 9/10` |
| 晚间总结 | **9 月 10 日**的记录 | `evening_summary` |

约定：

1. 客户端**不传**"昨天"的日期，只传"我正在填写今天"；由服务端按用户时区与日界计算 D-1，避免客户端时区错误造成串天。
2. 补写历史（第 3 天才想起来补 9 月 9 日的回顾）用独立接口 `PUT /v1/diaries/:date/review`，`:date` 是**被回顾的那一天**，不受"今天"影响。
3. 用户修改时区后，**已存在记录的 `entry_date` 不回算**（日期是标签，不是派生值）；后续新写入按新时区计算。
4. 服务端所有查询强制带 `user_id` 条件（§10）。

---

## 5. 时间、时区与日记日规则（新增章节）

### 5.1 日记日起点

- 日记日从**本地时间 04:00** 起算（默认值，设置页可调，范围 00:00–06:00）。
- 含义：本地 04:00 之前的一切写入，归属**前一天**的日记日。
- 目的：凌晨补写、跨午夜书写不会串天，也让 §12.3 / §12.4 的边界用例有明确预期。

### 5.2 单一实现

`diaryDate(instantUtc, timezone, dayStartHour)` 是**唯一**的日记日计算实现：

- 后端实现一次，单元测试覆盖边界与 DST；
- 前端用同一算法（同一份 TS 包或等价实现）仅用于**显示**与草稿暂存；
- 接口 `GET /v1/meta/today` 返回服务端权威的 `{ diary_date, timezone, day_start_hour, server_time }`，前端以它为准校正本地显示（弱网/跨时区旅行场景）。

### 5.3 时区变更与 DST

- 用户时区保存在 `user_settings.timezone`（IANA 值，如 `Asia/Shanghai`）；首次打开时读取系统时区写入。
- 时区或日界变更 → 服务端**立即重算**该用户的 `reminder_schedule.next_fire_at`（§7.3），并记录变更日志。
- DST：
  - 目标本地时刻**不存在**（跳变）→ 取当天第一个有效瞬间；
  - 目标本地时刻**重复**（回拨）→ 取**第一次**出现的瞬间，且当天只发送一次（幂等键按日记日，天然去重）。
  - 默认提醒时间 09:00 / 21:00 与日界 04:00 在常见时区不会落入跳变区间，但算法必须按上述规则实现，不能假设"本地时间一定存在"。

### 5.4 突发事情的跨日改动

用户手动把 `occurred_at` 改到另一个日记日时：

- 服务端按新 `occurred_at` 重算 `entry_date`（归属随发生时间走）；
- 前端在保存前提示"该记录将移动到 X 月 X 日"，避免"记录突然从今天消失"的困惑。

---

## 6. 推荐技术方案

### 6.1 总体架构（第一迭代）

```text
React + Vite 前端（响应式 Web + PWA）
        ↓ HTTPS API（Bearer Token）
单个常驻 Node 服务（NestJS 或 Fastify）
        ├── REST API（认证、日记、设置、订阅管理）
        ├── Scheduler Worker（每分钟 tick，扫描到期提醒）
        └── Web Push 发送（web-push / VAPID）
        ↓
PostgreSQL（业务数据 + 提醒排程表 + 送达记录）
```

第二迭代在同一后端之上增加：

```text
        ├── Capacitor Android APK（复用同一前端 + 原生本地通知）
        └── FCM（可选兜底）
```

### 6.2 选型

| 层级 | 推荐技术 | 原因 / 备注 |
| --- | --- | --- |
| Web / PWA 前端 | React + TypeScript + **Vite** | 纯 SPA 即可，不需要 SSR；静态托管成本最低 |
| UI | Tailwind CSS + 少量自建组件（或 shadcn/ui 风格） | 快速统一手机/桌面界面 |
| PWA | Web App Manifest + Service Worker（`vite-plugin-pwa` / Workbox） | 安装、应用壳缓存、Web Push |
| 数据层（前端） | TanStack Query + 自研 autosave hook + IndexedDB 草稿队列 | 自动保存与离线草稿（§9） |
| 后端 | NestJS（或 Fastify）+ TypeScript | 模块化 API + 内置定时任务；与前端同语言 |
| 数据库 | PostgreSQL | 账号、多设备同步、查询与统计 |
| ORM | Prisma 或 Drizzle（**二选一，早定**） | migration 从第一天走正规流程 |
| 排程 | **Postgres 任务表 + 每分钟 tick worker**（默认） | 用户量小，省掉 Redis 运维；接口与队列语义对齐，必要时平滑换 BullMQ |
| 队列（可选，第一迭代默认不引入） | BullMQ + Redis | 仅当任务量或并发增长后替换 |
| 网页推送 | Web Push + VAPID（`web-push` 库） | 覆盖 Chrome/Edge/Firefox/Android Chrome 与 iOS 主屏 PWA |
| 部署 | 单个常驻服务（Fly.io / Railway / Render / 一台 VPS）；Postgres 用 Neon / Supabase；前端静态托管（Cloudflare Pages / Vercel） | **不要**把 API 与 worker 放在 serverless 上（见 §6.3） |
| 邮件 | Resend / SES / Postmark | 邮箱验证码登录必需（§8.1） |
| CI | GitHub Actions：lint + typecheck + test + migration 校验 + preview 部署 | |

### 6.3 为什么不用 Vercel serverless + BullMQ（v1.0 的组合）

- **BullMQ worker 需要常驻进程与长连接**，serverless 函数不满足；Vercel 上必须另开一个常驻 worker 服务，等于绕回常驻服务，还多了一层跨网络调用。
- **Vercel Cron 的频率受套餐限制**，而"按用户时区每分钟判断谁该收提醒"需要高频触发。
- **Prisma 在 serverless 上需要额外连接池**（PgBouncer / Accelerate / driver adapters），否则并发一上来就耗尽连接。
- 结论：第一迭代用**一个常驻 Node 服务**同时跑 API 与 tick worker（同镜像两个进程：`web` / `worker`，或单进程内并发）；前端静态部署到 CDN。等规模需要时再拆分。

### 6.4 Android APK（第二迭代的前置取舍，先记录）

- Capacitor 将 web assets 打进 APK：**前端每次改动都要重新发版**。要接受"Android 版本落后于网页版本"，或使用 OTA 更新（受商店政策限制）。
- 若让 APK 直接加载远程 URL（`server.url`）以规避发版，会撞上商店"最低功能 / 纯 WebView 包装"的审核口径——**因此分发渠道必须在第二迭代动工前决定**：
  - 侧载（官网下载 APK）：无审核问题，可远程加载；
  - Google Play：不使用远程加载，接受发版节奏。
- Capacitor WebView 的 origin 是 `https://localhost` / `capacitor://localhost`，cookie + SameSite 容易出错 → 本版统一使用 **Bearer Token**（不走 cookie session），并存入 Keychain / Keystore（不用明文 Preferences）。这样第二迭代接入时几乎无额外成本。

### 6.5 为什么不建议只做纯 PWA（第二迭代的动机）

纯 PWA 可以完成网页端和 iOS 主屏幕应用，但 Android 上固定提醒的可靠性、设备重启恢复、原生通知控制不如 APK。因此第二迭代用 Capacitor 把同一套前端打包为 APK，在不维护两套 UI 的前提下获得原生本地通知能力。

---

## 7. 通知与提醒设计

### 7.1 送达口径（重要）

| 平台 | 第一迭代能力 | 承诺 |
| --- | --- | --- |
| 桌面 Chrome / Edge / Firefox | 服务端 Web Push | 当天送达；实际时间取决于浏览器与系统策略，**不承诺准点** |
| Android Chrome（网页或 PWA） | 服务端 Web Push | 同上；系统可能延迟、合并或在省电策略下压制 |
| macOS Safari | 服务端 Web Push（需系统支持版本） | 同上 |
| iOS Safari 标签页 | 不支持 | 设置页引导"添加到主屏幕" |
| iOS 主屏 PWA | 服务端 Web Push（需安装 + 用户手势授权） | 同上；第一迭代记录实测结果，**不作验收门槛**（第二迭代做完整引导与转化验证） |

产品文案与验收标准一律使用"每天提醒"，**不要写"09:00 准时通知"**。

### 7.2 提醒文案与跳转

| 触发时间 | 默认文案 | 点击后的目标 |
| --- | --- | --- |
| 每日 09:00 | 早上好，花 3 分钟回顾昨天，安排今天吧。 | 今日页，定位到"早间记录" |
| 每日 21:00 | 今天过得怎么样？写几句总结，给今天画上句号。 | 今日页，定位到"晚间总结" |

- 通知横幅**不含日记正文**（§10）。
- 默认只在对应内容尚未完成时发送；用户关闭"仅未完成时提醒"后，每天按时发送鼓励型提醒。

### 7.3 服务端排程设计

两张表（DDL 见附录 A）：

1. `reminder_schedule`：每个用户每个类型一行，保存 `next_fire_at`。用户创建、改提醒时间、改时区、改日界、开关提醒时**增量重算**，避免每分钟全表做时区计算。
2. `notification_deliveries`：发送记录，幂等唯一键 `(user_id, local_date, kind)`，字段含 `status`、`attempts`、`last_error`、`sent_at`。**不保存任何日记正文。**

worker 循环（每分钟）：

```text
取出 next_fire_at <= now() 的排程行（FOR UPDATE SKIP LOCKED，限制批量）
  → 事务内 INSERT notification_deliveries ON CONFLICT DO NOTHING
      · 插入成功  → 这是首次发送机会
      · 插入失败  → 已发送过，跳过（幂等）
  → 若"仅未完成时提醒"开启且对应内容已完成 → 记为 skipped，不发送
  → 否则发送 Web Push：
      · 成功 → status=sent，更新订阅的 last_success_at
      · 404/410 → 立即禁用该订阅（disabled_at）
      · 其他失败 → status=failed, attempts+1，下一轮重试（最多 3 次，间隔递增）
  → 无条件重算该行 next_fire_at = 下一个提醒时刻（按 §5.3 的 DST 规则）
```

其他约定：

1. 账号创建或首次打开时读取系统时区并保存为 IANA 值。
2. 用户修改提醒时间、关闭提醒、登出、撤销通知权限时，立即取消/失效对应订阅与排程行（`next_fire_at = null` 或删除）。
3. 发送前再次检查完成状态，避免无意义打扰。
4. 前端**每次应用启动**检查 `registration.pushManager.getSubscription()`：存在则上报心跳（幂等 upsert），并同步 `subscription.endpoint`；不存在则**不主动弹权限**（遵循 §7.4）。此举用于对抗订阅静默失效——**不要依赖 `pushsubscriptionchange` 事件**（WebKit 的支持不可靠，待真机确认）。
5. 埋点与告警：排程积压（`next_fire_at < now() - 5min` 的行数）、发送失败率、订阅失效数。

### 7.4 通知权限引导

不要用户第一次打开页面就弹系统权限请求：

1. 用户完成至少一项早间/晚间记录后，说明提醒的实际价值；
2. 用户点击"开启每日提醒"（这是用户手势，iOS 上必须）；
3. iOS 用户先看到"添加到主屏幕"步骤说明；
4. 再发起系统权限请求；
5. 授权失败时，设置页显示当前状态和清晰的手动开启说明。

### 7.5 第二迭代补充（Android 本地通知）

- Capacitor Local Notifications 登记每日提醒；`allowWhileIdle`。
- Android 12+ 精确闹钟需引导用户授予相应权限（`SCHEDULE_EXACT_ALARM` 可请求；`USE_EXACT_ALARM` 仅限闹钟/日历类应用并受商店政策限制）——**不授权时就只能是"大致时间"**，Doze 下可能偏移较久，文案不能承诺准点。
- 设备重启、应用升级、用户"强行停止"后的行为必须真机验证（v1.0 §5.2 第 5 条的"重新登记"策略保留）。
- 若走 Google Play，先确认 §6.4 的分发渠道结论。

---

## 8. 后端模块与 API 规划

### 8.1 认证与账号

| 阶段 | 方式 | 说明 |
| --- | --- | --- |
| 首次打开 | **匿名账号** | 服务端创建 `users.is_anonymous = true` 的用户并下发令牌；用户可立即使用，数据归属明确 |
| 升级 | 邮箱验证码 | `POST /v1/auth/email/start` 发 6 位码（TTL 10 分钟；单邮箱 5 次/小时、单 IP 20 次/小时限流）→ `POST /v1/auth/email/verify`：邮箱已存在则登录并与匿名账号合并（服务端做数据迁移），否则升级当前匿名账号 |
| 令牌 | 短期 access（15 分钟）+ 长期 refresh（30 天，轮转 + 复用检测） | **Bearer Token**，为第二迭代 Capacitor 铺路；Web 端存内存 + refresh 存 httpOnly cookie 或安全存储 |
| 未来 | Google / Apple 登录 | Apple 登录需要付费开发者账号；不发 iOS 原生 App 时不强制 |

**不做纯本地试用**：v1.0 §6.3 的"未登录本地临时存储"会引入前端数据合并逻辑，改为匿名账号后由服务端承担升级迁移，逻辑更少、丢失风险更低。

### 8.2 服务模块

| 模块 | 职责 |
| --- | --- |
| Auth | 匿名注册、邮箱验证码、令牌轮转、注销、匿名账号升级与数据迁移 |
| User Settings | 时区、日界、提醒时间、通知开关、偏好 |
| Diary | 每日记录的读取与字段级写入、今日（双行）聚合、补写 |
| Incident | 突发事情增删改查、按日记日查询与排序 |
| Calendar | 按月获取有记录的日期与摘要 |
| Notification Subscription | Web Push 订阅 upsert、心跳、失效清理 |
| Scheduler | 排程计算、tick、重试、幂等、告警指标 |
| Account | 删除账号（连带数据清除，宽限期） |
| Export（第二迭代） | 导出 Markdown / JSON |

### 8.3 关键 API

```text
# 元信息（服务端权威时间）
GET    /v1/meta/today                       # { diary_date, timezone, day_start_hour, server_time }

# 日记
GET    /v1/diaries/today                    # 聚合：today 行 + yesterday 行 + 今日 incidents + 进度
GET    /v1/diaries/:date                    # 单日详情（该行 + 该日 incidents）
PATCH  /v1/diaries/:date                    # 字段级写入（仅提交变更字段）
PUT    /v1/diaries/:date/review             # 补写某天的 day_events / day_meals（:date = 被回顾的那天）

# 突发事情
POST   /v1/diaries/:date/incidents          # 客户端生成 id，幂等
PATCH  /v1/incidents/:id
DELETE /v1/incidents/:id
GET    /v1/incidents?date=2026-09-10

# 日历与设置
GET    /v1/calendar?month=2026-09
GET    /v1/settings
PATCH  /v1/settings                         # 时区、日界、主题
PUT    /v1/settings/reminders               # 提醒时间与开关（触发排程重算）

# 推送订阅
POST   /v1/notifications/subscriptions      # upsert（endpoint 唯一）
POST   /v1/notifications/subscriptions/heartbeat
DELETE /v1/notifications/subscriptions/:id
GET    /v1/notifications/status             # 已订阅设备数、最近发送结果

# 账号
POST   /v1/auth/anonymous
POST   /v1/auth/email/start
POST   /v1/auth/email/verify
POST   /v1/auth/refresh
POST   /v1/auth/logout
DELETE /v1/account                          # 二次确认后进入宽限期
```

`PATCH /v1/diaries/:date` 契约（字段级冲突的关键）：

```jsonc
// 请求：只提交变更的字段；base_updated_at 用于冲突判断（可为 null = 首次写入）
{ "fields": { "day_plan": { "value": "今天要写完方案", "base_updated_at": "2026-09-10T01:02:03Z" } } }

// 响应：返回该字段的最终值；overwritten=true 表示服务端已有更新的内容（字段级后写优先，但要对用户可见）
{ "entry_date": "2026-09-10",
  "version": 7,
  "fields": { "day_plan": { "value": "…", "updated_at": "2026-09-10T01:02:04Z", "overwritten": false } } }
```

接口设计要求：

- `PATCH` 只提交变更字段 → 天然避免整行覆盖；
- 只提交字段级差异 + 字段级 LWW + `overwritten` 提示 → 不做静默丢数据（§9）；
- 写入接口返回 `version` 与各字段 `updated_at`，供客户端下一次提交作为 `base_updated_at`；
- 文本长度限制与服务端校验（正文 8000 字符、突发内容 2000 字符）；
- 客户端生成 UUID（突发记录）以天然幂等；
- 自动保存必须防抖（§9.1），不要逐字符请求；
- 网络失败时客户端暂存未提交内容，恢复后重试，并明显告知同步状态。
- 全局限流：按用户 + IP（如 60 次/分钟写接口），并记录 429 指标。

### 8.4 错误与同步语义

- 401 → 刷新令牌后重试一次；仍失败则进入"未登录"态并向用户提示（本地草稿保留）。
- 409 不使用（改用字段级 `overwritten` 提示）；`version` 仅用于审计与埋点。
- 离线写入队列按"本地修改时间"顺序上传；同一字段的多次修改合并为最后一次。

---

## 9. 前端实现要点

### 9.1 组件划分

```text
pages/
├── TodayPage
├── CalendarPage
├── DiaryDetailPage
└── SettingsPage

components/
├── MorningJournalCard
│   ├── YesterdayReviewSection   # 写入 D-1 行
│   └── TodayPlanSection         # 写入 D 行
├── IncidentTimeline
├── QuickIncidentModal
├── EveningSummaryCard
├── SaveStatus                   # idle / dirty / saving / saved / offline / error
└── NotificationPermissionGuide
```

### 9.2 自动保存与离线体验

- 输入停止 1～2 秒（默认 1.5s）触发防抖保存；失焦、`visibilitychange`、`pagehide` 立即触发。
- **只提交变更字段**，携带上次响应中的 `base_updated_at`。
- 保存中显示"正在保存"，成功后显示"已保存 + 时间"，失败显示"未同步，稍后重试"。
- 使用 IndexedDB 暂存未同步草稿（按 `user_id + entry_date + field` 键）；网络恢复（`online` 事件 + 定时探测）后按修改时间顺序上传。
- 收到 `overwritten: true` 时提示"这条内容在另一台设备上更新过，已采用最新版本"，并提供"查看我刚输入的内容"入口（保留在本地草稿中供复制）。
- 冲突合并 UI（双栏对比）留到第二迭代。
- PWA 缓存应用壳与最近浏览的日记，确保弱网下仍能打开基础界面。
- 注意：PWA 与未来的 Capacitor WebView 是**两套不同 origin 的存储**，本地草稿不跨端——跨端一致完全依赖服务端同步。

### 9.3 无障碍与隐私体验

- 输入框、按钮、通知设置均要有清晰标签；
- 支持键盘操作和合适的焦点顺序；
- 手机端字号与点击区域不能过小；
- 默认不展示日记正文在通知横幅中，防止锁屏泄露隐私；
- 应用锁作为第二迭代能力。

---

## 10. 数据安全、隐私与合规

日记属于高度私密数据，第一迭代即应满足：

- 全站 HTTPS；
- 令牌、推送订阅信息加密/安全存储；服务端只存 refresh token 的哈希；
- 数据库最小权限访问；生产环境定期备份 + **恢复演练**（列入里程碑）；
- 服务端日志不得打印日记正文、访问令牌或完整推送订阅（endpoint 视为敏感信息，仅记录其哈希或末 8 位）；
- 全局限流与异常登录检测；
- 明确隐私政策：收集什么、为何收集、保留多久、如何导出或删除；
- **删除账号**：第一迭代提供入口（二次确认 + 邮箱验证），支持 7 天宽限期后清除全部日记、突发记录、订阅与令牌；未升级的匿名账号 60 天不活跃自动清理（隐私政策中写明）；
- 若接入统计工具，默认只收集匿名产品事件，不采集正文内容；
- 若未来需要端到端加密，必须在产品设计阶段决定密钥恢复策略，会影响搜索、AI 总结与多端同步，建议作为独立项目评估。

---

## 11. 开发里程碑（已按"网页端优先"重排）

按 2～4 人小团队估算；1～2 人请按 1.5～2 倍系数估算。

| 阶段 | 预计周期 | 交付物 | 关键风险控制 |
| --- | --- | --- | --- |
| 0. 需求确认 + 技术验证 spike | 1 周 | §14 七个决策定稿、低保真原型、**两项 spike 结论回填本文档** | spike ① Web Push 端到端（桌面 Chrome + Android Chrome + 尽量找到一台 iPhone 走一遍"添加到主屏幕 → 授权 → 收到推送 → 隔天是否仍有效"）；spike ② 排程 + 日界 + 时区/DST 的单测原型 |
| 1. 工程骨架与地基 | 1 周 | 前端/后端脚手架、CI、dev/staging 环境、数据模型 migration、认证（匿名 + 邮箱验证码） | 先有 API 骨架与数据模型，再做界面，避免一轮返工 |
| 2. 日记核心功能 | 2 周 | 今日页三块、字段级自动保存与冲突提示、突发记录、日历（含单日详情、补写、编辑历史） | 日历编辑历史是验收标准之一，不能砍 |
| 3. 通知系统 | 1 周 | 排程表 + tick worker、Web Push 发送与失效清理、设置页提醒配置、权限引导、`/v1/meta/today` 校正 | 幂等、时区重算、DST 用例必须有测试 |
| 4. 测试与发布准备 | 1 周 | 浏览器/真机矩阵测试报告、隐私政策、备份恢复演练、监控与埋点、灰度发布包 | 监控：排程积压、发送失败率、自动保存失败率 |

**第一迭代合计 6～7 周**（相对 v1.0 的 8～11 周，省下的主要是 Android 打包与 iOS 引导的联调成本）。

第二迭代（约 3～4 周）：Android APK（Capacitor + 本地通知 + 分发）、iOS 安装/授权完整引导与转化验证、导出（Markdown/JSON）、回顾统计、冲突合并 UI、应用锁。

---

## 12. 测试计划

### 12.1 功能测试

- 新建当天日记、刷新页面后内容仍存在；
- 昨日回顾与今日计划在视觉与**数据字段**上均独立（断言写入的是 D-1 与 D 两条记录）；
- 可添加、编辑、删除多条突发事情，时间线排序正确；
- 可以补写过去日期（含任意久远日期），不会覆盖其他日期；
- 突发事情改时间跨日时，归属日随之变化并给出提示；
- 自动保存、断网重连、重复请求都不会丢失或重复记录；
- 只改一个字段时，另一字段的并发修改不被覆盖（字段级 LWW 用例）；
- 日历标记与详情数据一致；
- 修改提醒时间、关闭提醒、重新开启提醒均正确生效（断言 `reminder_schedule`）；
- 匿名账号升级为邮箱账号后数据完整。

### 12.2 通知测试矩阵（第一迭代）

| 场景 | 桌面 Chrome/Edge | Android Chrome（含 PWA） | iOS 主屏 PWA |
| --- | --- | --- | --- |
| 首次授权通知 | 测试 | 测试 | 测试安装到主屏幕后的授权流程（记录结果） |
| 09:00 / 21:00 提醒 | 测试服务端推送 | 测试服务端推送 | 测试 Web Push 送达（不作门槛） |
| 点击通知深链 | 测试 | 测试 | 测试 |
| 修改提醒时间 | 测试排程重算 | 测试 | 测试服务端排程更新 |
| 时区 / 日界切换 | 测试重算 | 测试 | 测试 |
| 撤销权限 / 订阅失效 | 测试失败后自动禁用订阅 | 测试 | 测试重新订阅（每次启动检查） |
| 无网络 | 推送无法保证 | 推送无法保证 | 推送无法保证 |

Android 本地通知与设备重启、应用被杀、"强行停止"场景整体推迟到第二迭代。

### 12.3 服务端测试（新增，必须有单测）

- `diaryDate` 边界：23:59 / 00:00 / 03:59 / 04:00（按各自时区）；
- DST 跳变与回拨（用 `America/New_York`、`Europe/London`、`Australia/Lord_Howe` 之类的时区做用例）；
- `next_fire_at` 重算：改时间、改时区、关闭再开启、跨日；
- 幂等：同一 `(user_id, local_date, kind)` 重复触发只发送一次；
- 订阅失效：404/410 → `disabled_at` 置位；其他错误重试 3 次后失败；
- 账号数据隔离：A 用户无法读写 B 用户的任何记录；
- 匿名账号升级：数据迁移后归属正确、无重复。

### 12.4 真机与浏览器覆盖

- 浏览器：Chrome、Edge、Safari（桌面）、Android Chrome、iOS Safari（含主屏 PWA）；
- 网络：Wi-Fi、蜂窝网络、弱网、断网恢复；
- 边界时间：23:59、00:00、03:59、04:00、夏令时切换地区、跨时区旅行（改设备时区）；
- 第二迭代再补 Android 真机矩阵（Android 13+、一个较低版本、主流国产 ROM）。

---

## 13. 第一迭代验收标准

1. 同一账号在桌面浏览器与手机浏览器登录后能看到一致的日记数据。
2. 今日页包含"昨天发生了什么、昨天吃了什么、今天准备做什么、突发事情、今日总结"五类内容。
3. 昨日回顾和今日计划在同一早间卡片里，有明确标题、日期与视觉分隔；**且数据分别落在 D-1 与 D 两条记录上**（可用 API 断言）。
4. 突发事情可以随时新增多条，并按时间展示；可在任意历史日期补写。
5. 文本自动保存，刷新、关闭标签、断网重连后不丢失已成功同步的内容；重复请求不产生重复记录。
6. 用户可通过日历查看、补写、编辑过去的日记。
7. 默认 09:00 与 21:00 提醒可配置；"仅在未完成时提醒"可开关；改时区、改提醒时间、关闭提醒、撤销授权后，不会产生重复提醒或继续错误提醒（以 `reminder_schedule` 与 `notification_deliveries` 断言）。
8. 桌面 Chrome/Edge 与 Android Chrome 能收到服务端 Web Push；iOS 主屏 PWA 在用户完成安装与授权后可收到推送（**记录实测结果即可，不作硬门槛**）。
9. 通知点击后进入正确栏目，且通知横幅不含日记正文。
10. 删除账号入口可用，宽限期后数据被完整清除。
11. 匿名账号升级为邮箱账号后，历史数据完整且归属正确。
12. 备份恢复演练通过（能从备份恢复出一份可登录、可读写的实例）。

> 相对 v1.0 的变化：Android 本地通知（原第 7 条）与 iOS 完整引导（原第 8 条）移出第一迭代；新增字段级冲突（第 5、7 条）、账号删除（第 10 条）、匿名升级（第 11 条）、备份恢复（第 12 条）。

---

## 14. 产品决策（v1.1 默认值，如需修改请在此处标注）

| # | 问题 | **本版默认值** |
| --- | --- | --- |
| 1 | 是否必须支持未登录使用？ | **匿名账号起步**（服务端创建匿名用户），不做纯本地试用；用户可在任意时刻升级为邮箱账号 |
| 2 | 早间提醒每天都发，还是仅未完成时发？ | **默认仅未完成时发**，用户可关闭该限制 |
| 3 | 晚间总结是否要固定子问题？ | **第一迭代单一自由文本框**；固定子问题（完成了什么/有什么感受）列入第二迭代评估 |
| 4 | "昨天吃了什么"是否拆分三餐？ | **单一自由文本**（拆分即字段拆分，会带来迁移成本，等真实使用反馈） |
| 5 | 多语言、深色模式、离线优先？ | **中文单语**；深色模式跟随系统；离线仅做"应用壳缓存 + 草稿暂存"，不做离线优先全量同步 |
| 6 | Android APK 分发渠道？ | **第二迭代动工前决定**（侧载 / Google Play 会影响能否远程加载前端，见 §6.4） |
| 7 | 导出与账号删除是否首版门槛？ | **删除账号进第一迭代**（隐私合规必需）；**导出进第二迭代** |

---

## 15. 结论

第一迭代推荐组合：**React + Vite PWA + 单个常驻 TypeScript 服务（API + tick worker）+ PostgreSQL + 服务端 Web Push**。它以最短路径覆盖"早上回顾与规划—白天随手记录—晚上总结"的闭环，并把不确定性最大的两块（Android APK 打包分发、iOS 安装与授权引导）明确推到第二迭代。

数据层采用**当天字段模型 + 日记日（04:00 起算）+ 字段级后写优先**：日历、补写、统计全部退化为"读一行"，从模型上消除"昨天的内容被存成今天发生的"这类错误，也为未来统计某一天的计划、总结与饮食留下了干净的语义。

成功标准依旧是：用户每天都能顺畅完成记录闭环，并相信自己的私密数据会被可靠保存——而不是功能数量。

---

## 16. 参考与待验证清单

### 16.1 平台能力参考

- Apple Developer / WebKit：Web Push 与主屏幕 Web App 的说明（iOS PWA 通知方案）；
- Chrome for Developers：网页通知触发能力与兼容性背景；
- Android Developer：`SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` 与 Doze 行为；
- Capacitor 官方文档：Local Notifications 插件（重启恢复、`allowWhileIdle`）；
- Google Play 政策：最低功能 / WebView 包装类应用；
- Web Push / VAPID 规范与 `web-push` 库文档。

### 16.2 必须在阶段 0 用真机落锤的清单

1. iOS 主屏 PWA：授权流程、隔天/重启后订阅是否仍有效、是否需要每次启动重订阅、推送延迟量级；
2. iOS 上 `pushsubscriptionchange` 是否触发（决定 §7.3 第 4 条的实现）；
3. 桌面/Android Chrome 的推送延迟与失败率基线；
4. 目标 iOS / Android / 浏览器版本的最低支持边界（写进隐私政策与帮助页）。

第二迭代再验证：Capacitor 本地通知在国产 ROM 重启后的恢复、精确闹钟授权流程与文案、Google Play 对远程加载的审核口径。

---

## 附录 A：数据库表结构（DDL 草案）

```sql
-- 用户
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  is_anonymous     boolean NOT NULL DEFAULT true,
  email            text UNIQUE,              -- 匿名用户为 NULL
  email_verified_at timestamptz,
  merged_into      uuid REFERENCES users(id), -- 匿名账号被合并后的指向
  status           text NOT NULL DEFAULT 'active', -- active | pending_deletion | deleted
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 用户设置
CREATE TABLE user_settings (
  user_id                    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone                   text NOT NULL DEFAULT 'Asia/Shanghai', -- IANA
  day_start_hour             smallint NOT NULL DEFAULT 4 CHECK (day_start_hour BETWEEN 0 AND 6),
  morning_reminder_enabled   boolean NOT NULL DEFAULT true,
  morning_reminder_time      time NOT NULL DEFAULT '09:00',
  evening_reminder_enabled   boolean NOT NULL DEFAULT true,
  evening_reminder_time      time NOT NULL DEFAULT '21:00',
  notify_only_if_incomplete  boolean NOT NULL DEFAULT true,
  theme                      text NOT NULL DEFAULT 'system',
  locale                     text NOT NULL DEFAULT 'zh-CN',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- 每日记录（当天字段模型）
CREATE TABLE daily_entries (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date                date NOT NULL,
  day_events                text,
  day_meals                 text,
  day_plan                  text,
  evening_summary           text,
  day_events_updated_at     timestamptz,
  day_meals_updated_at      timestamptz,
  day_plan_updated_at       timestamptz,
  evening_summary_updated_at timestamptz,
  version                   integer NOT NULL DEFAULT 1,
  reviewed_at               timestamptz,   -- 仅展示/埋点，不参与业务判断
  summarized_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date)
);

-- 突发事情
CREATE TABLE incidents (
  id          uuid PRIMARY KEY,              -- 客户端生成
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date  date NOT NULL,                 -- 归属日记日（由服务端按 occurred_at 计算）
  occurred_at timestamptz NOT NULL,
  content     text NOT NULL CHECK (char_length(content) <= 2000),
  tag         text CHECK (tag IN ('work','life','emotion','idea','other')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_user_date_idx ON incidents (user_id, entry_date, occurred_at);

-- Web Push 订阅
CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  last_success_at timestamptz,
  failure_count   integer NOT NULL DEFAULT 0,
  disabled_at     timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE disabled_at IS NULL;

-- 提醒排程（每用户每类型一行）
CREATE TABLE reminder_schedule (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('morning','evening')),
  next_fire_at timestamptz,                  -- NULL = 关闭
  locked_at    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX reminder_schedule_due_idx ON reminder_schedule (next_fire_at) WHERE next_fire_at IS NOT NULL;

-- 发送记录（幂等 + 审计，不存正文）
CREATE TABLE notification_deliveries (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date   date NOT NULL,                -- 日记日
  kind         text NOT NULL CHECK (kind IN ('morning','evening')),
  status       text NOT NULL,                -- pending | sent | failed | skipped
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date, kind)
);

-- 刷新令牌
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  rotated_from uuid,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

## 附录 B：核心算法伪代码

```text
# 1) 日记日：本地时间凌晨 dayStartHour 之前算前一天
fn diaryDate(instantUtc, timezone, dayStartHour) -> Date:
    local = instantUtc.toTimezone(timezone)
    return (local.hour < dayStartHour) ? local.date - 1 day : local.date

# 2) 下一次提醒时刻（DST 安全）
fn nextFireAt(nowUtc, timezone, localTime /* '09:00' */, dayStartHour) -> Instant:
    d = diaryDate(nowUtc, timezone, dayStartHour)
    candidate = resolveLocalInZone(d, localTime, timezone)
        # 若该本地时刻不存在（DST 跳变）→ 取当天第一个有效瞬间
        # 若该本地时刻重复（DST 回拨）→ 取第一次出现的瞬间
    while candidate <= nowUtc:
        d = d + 1 day
        candidate = resolveLocalInZone(d, localTime, timezone)
    return candidate

# 3) 今日页聚合（一次请求返回两行 + 今日突发）
fn getToday(userId, nowUtc):
    s = settings(userId)
    today = diaryDate(nowUtc, s.timezone, s.day_start_hour)
    yesterday = today - 1 day
    return {
      meta: { diary_date: today, timezone, day_start_hour, server_time: nowUtc },
      today:     daily_entry(userId, today)     ?? empty,
      yesterday: daily_entry(userId, yesterday) ?? empty,
      incidents: incidents(userId, today),
      progress: {
        morning_done: has(yesterday.day_events or yesterday.day_meals) and has(today.day_plan),
        evening_done: has(today.evening_summary)
      }
    }

# 4) 字段级写入（PATCH /v1/diaries/:date）
fn patchEntry(userId, date, fields, nowUtc):
    for (name, {value, base_updated_at}) in fields:
        assert name in ['day_events','day_meals','day_plan','evening_summary']
        assert length(value) <= 8000
        current_updated = row[name + '_updated_at']   # 加行锁
        if base_updated_at != null and current_updated != null and current_updated > base_updated_at:
            overwritten = true        # 服务端已有更新内容：仍按后写优先，但要对用户可见
        write row[name] = value; row[name + '_updated_at'] = nowUtc
        if name in ('day_events','day_meals') and row.reviewed_at is null and value != '': row.reviewed_at = nowUtc
        if name == 'evening_summary' and row.summarized_at is null and value != '': row.summarized_at = nowUtc
    row.version += 1
    return { entry_date, version, fields: {...} }
```

## 附录 C：v1.0 → v1.1 逐节对照

| v1.0 章节 | v1.1 对应 | 主要变化 |
| --- | --- | --- |
| §1 目标与范围 | §1 | 三端拆为两个迭代；首版 = 网页端 + 服务端 Web Push；新增"当天送达、不承诺准点"的可靠性口径 |
| §2 用户流程 | §2 | 明确"日记日"概念与凌晨填写归属 |
| §3 信息架构 | §3 | 设置页按第一迭代能力收窄（新增日界设置）；日历标记简化为圆点 |
| §4 数据模型 | **§4 + §5 + 附录 A/B** | **改为当天字段模型**；取消完成时间戳改为派生；新增字段级 `updated_at`、`version`、日界规则、时区变更与 DST 规则、突发记录归属日 |
| §5 通知与提醒 | §7 | 第一迭代只做服务端 Web Push；新增送达口径、`reminder_schedule` + `notification_deliveries`、订阅心跳与失效清理、每次启动重订阅；Android 本地通知移入第二迭代（§7.5） |
| §6 推荐技术方案 | §6 | 移除 serverless + BullMQ 冲突（改为单常驻服务 + Postgres 任务表）；Vite 取代 Next.js；Bearer Token；补 APK 取舍（§6.4） |
| §7 后端模块与 API | §8 | 新增 `/v1/meta/today`、`GET /v1/diaries/today` 双行聚合契约、字段级 `PATCH`、`/review` 补写接口、认证体系与匿名升级、限流 |
| §8 前端要点 | §9 | 新增字段级提交与 `overwritten` 提示、SaveStatus 状态机、PWA 与 WebView 存储隔离说明 |
| §9 安全隐私 | §10 | 新增限流、endpoint 脱敏、备份恢复演练、账号删除流程与宽限期 |
| §10 里程碑 | §11 | 重排为 6～7 周（网页优先）+ 第二迭代 3～4 周；阶段 0 增加两项 spike |
| §11 测试计划 | §12 | 通知矩阵去掉 Android 列；新增服务端排程/日界/DST/幂等/隔离/匿名升级单测 |
| §13 验收标准 | §13 | 重写为 12 条第一迭代标准；iOS 推送与 Android 本地通知不作硬门槛；新增冲突、删除账号、匿名升级、备份恢复 |
| §14 产品决策 | §14 | 七个问题全部给出默认值 |
| §15 结论 | §15 | 更新为网页优先的组合与模型收益 |
| §16 平台能力参考 | §16 | 拆为"参考"与"阶段 0 必须真机落锤的清单" |
| （无） | §0 | 新增修订说明与问题对照表 |
