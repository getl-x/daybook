# daybook 开发计划（v1.4 · 自托管个人版）

> 文档版本：v1.4 ｜ 2026-09-10 ｜ 就地升级自 v1.3（v1.1 收在 `docs/zh-CN/archive/diary-app-development-plan-v1.1.md`）
> 部署形态：**自有 VPS + Docker 镜像**（3 vCPU / 4 GB RAM / 老 CPU）；应用容器只监听 **8090**，**反向代理由你自己部署（nginx 等）**
> 账号形态：**用户名 + 密码，注册关闭，账号由管理员侧添加**（无邮箱、无邮件子系统）
> 使用范围：自己为主，可能加上少量朋友；不上架任何商店

## 0. 变更记录

### v1.3 → v1.4（本轮）

| # | 变更 | 理由 |
| --- | --- | --- |
| 1 | 镜像里**不放 caddy**，也不需要任何 TLS/反代组件；应用固定监听 **8090**（容器内 + 宿主机 `127.0.0.1:8090`） | 由你在启动服务后自行用 nginx 等反代；应用只管把 HTTP 服务跑起来，职责单一、镜像更小、更好迁移 |
| 2 | APK 签名密钥**由你提供**（你已有 `.jks`）；仓库里只放 `android/keystore.properties.example`，真实密钥与口令放仓库外 | 密钥不进仓库是硬规矩；到用的时候我给你一步步的操作命令 |

### v1.2 → v1.3（上一轮，已生效）

| # | 变更 | 理由 |
| --- | --- | --- |
| 1 | 账号：邮箱 + 密码 → **用户名 + 密码**，账号由管理员侧添加 | 不需要对外注册，也不想引入邮箱 |
| 2 | 部署：宿主原生（systemd）→ **Docker 镜像 + compose**（app + db） | 要的是"打包成镜像、方便迁移"；Node 直跑 TS 让镜像里不需要构建产物 |
| 3 | Android：**APK 回归**，列入第二迭代（Capacitor + 原生本地通知），分发走 **GitHub Releases 侧载** | 不上架就没有商店政策问题；本地通知比 Web Push 可靠 |
| 4 | iOS：**正式做安装引导**（引导页 + 设置页入口，含 standalone 检测） | 你要求补上 |
| 5 | 流程：**先本地验证，再创建 GitHub 仓库并提交** | 你的要求 |

**当前进度**：阶段 0 已交付时间核心（19 用例）与认证核心（20 用例）；阶段 1（骨架 + 迁移 + 登录 + Docker）待开始。

---

## 1. 产品与范围

### 1.1 定位

一款私密、轻量、带固定问题引导的日记应用：**早上回顾昨天并安排今天 → 白天随手记录 → 晚上总结**。用户永远不必面对空白编辑器。

### 1.2 第一迭代范围

- **用户名 + 密码**登录（注册关闭，账号由管理员侧添加，见 §6.2）；
- 今日页：昨日回顾（昨天发生了什么 / 昨天吃了什么）+ 今日计划 + 突发事情 + 晚间总结；
- 字段级自动保存、离线草稿、冲突可见（不静默丢数据）；
- 日历 + 单日详情：查看、补写、编辑任意历史日期；
- 提醒：默认 09:00 / 21:00 可配置，"仅未完成时提醒"默认开启，可选**静默时段**（窗口内推迟到窗口结束，太晚则当天不发）；
- 服务端排程 + Web Push（桌面、Android Chrome、iOS 主屏 PWA 同一条链路）；
- **iOS 安装引导页**（添加到主屏幕 + 授权步骤 + 状态检测）；
- 设置页：提醒时间与开关、静默时段、通知权限状态、时区、日记日起始时间、删除账号；
- 运维：**Docker 镜像 + compose**（只跑应用与数据库，反代自备）、每日备份 + 恢复演练、`/healthz`、极简监控。

### 1.3 明确不做

社交、AI 代写、图片/语音/附件、周报月报、多人协作与家庭账号、完整离线同步冲突合并 UI、多语言、**公开注册**、**上架应用商店**（APK 只走 GitHub Releases 侧载）、多设备管理页、**镜像内置 TLS/反代**。

### 1.4 提醒的可靠性口径

**当天送达，不承诺准点。** 文案与验收标准都不写"09:00 准时通知"——Web Push 的送达时间由浏览器与系统策略决定，Android 在省电策略下可能被延迟或合并。（Android APK 已实现**本机排**的本地提醒，那条路径才接近准点。）

---

## 2. 使用流程与"日记日"

```text
早上（默认 09:00 前后）收到提醒
        ↓
打开“今日” → 完成早间记录
        ├─ 昨天发生了什么  → 写入「昨天」那一天的记录
        ├─ 昨天吃了什么    → 写入「昨天」那一天的记录
        └─ 今天准备做什么  → 写入「今天」这一天的记录

白天任意时间 → 点击“记录此刻” → 新增一条带时间的突发事情

晚上（默认 21:00 前后）收到提醒 → 填写今日总结 → 自动保存

之后 → 通过日历回顾、补写、编辑历史日记
```

**日记日**：本地时间 **04:00** 起算（可调，范围 00:00–06:00）。因此 00:30 打开应用仍属"昨天"的日记日。所有日期计算以**服务端**为准，客户端只用于显示与草稿暂存。

---

## 3. 信息架构

```text
应用
├── 今日      早间记录（昨日回顾 + 今日计划）/ 突发事情 / 晚间总结
├── 日历      月视图 → 单日详情（查看、补写、编辑）
├── 回顾      首版显示“即将推出”
└── 设置      提醒时间与开关 / 通知权限与安装引导 / 时区 / 日记日起始时间 / 账号与同步 / 删除账号
```

移动端底部导航，桌面端左侧导航；断点切换即可，不维护两套布局。

---

## 4. 数据模型（当天字段模型）

### 4.1 核心理念

**一条记录描述"这一天自己"**；"昨日回顾"只是**填写入口**，不是存储位置。日历、单日详情、搜索、统计、补写因此全部退化为"读一行"，不需要任何跨行映射。

### 4.2 每日记录 `daily_entries`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 主键 |
| `user_id` | uuid | 所属用户 |
| `entry_date` | date | 用户当地日记日，**即内容归属日**；唯一约束 `(user_id, entry_date)` |
| `day_events` | text | 这天发生了什么（早间通常写在前一天） |
| `day_meals` | text | 这天吃了什么 |
| `day_plan` | text | 这天准备做什么 |
| `evening_summary` | text | 这天过得怎么样 |
| `day_events_updated_at` 等 4 个 | timestamptz | 各字段最后写入时间（服务端时钟），用于字段级冲突判断 |
| `version` | integer | 行级版本号，每次写入 +1（审计与将来冲突 UI 用） |
| `reviewed_at` / `summarized_at` | timestamptz | 首次非空时间，**仅展示与埋点，不参与业务判断** |
| `created_at` / `updated_at` | timestamptz | 审计字段 |

完成状态一律**派生**，不存 `morning_completed_at`：某天"回顾完成" = `day_events` 或 `day_meals` 非空；"晚间完成" = `evening_summary` 非空。今日页进度 =（昨天的回顾已写 且 今天的 `day_plan` 已写）+（今天的 `evening_summary` 已写）。

### 4.3 突发事情 `incidents`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | **客户端生成**，重复提交天然幂等 |
| `user_id` | uuid | 所属用户 |
| `entry_date` | date | 归属日记日，由服务端按 `occurred_at` + 时区 + 日界计算 |
| `occurred_at` | timestamptz | 发生/记录时间（可手动改） |
| `content` | text | 上限 2000 字符 |
| `tag` | text | 白名单：work / life / emotion / idea / other |

按 `occurred_at` 升序展示，同日多条用 `created_at` 兜底。改动 `occurred_at` 跨日时归属日跟着变，前端保存前提示"该记录将移动到 X 月 X 日"。

### 4.4 写入契约（字段级，避免整行覆盖）

```jsonc
// PATCH /v1/diaries/:date —— 只提交变更的字段
{ "fields": { "day_plan": { "value": "今天要写完方案", "base_updated_at": "2026-09-10T01:02:03Z" } } }

// 200：返回该字段最终值；overwritten=true 表示服务端已有更新内容（后写优先，但对用户可见）
{ "entry_date": "2026-09-10", "version": 7,
  "fields": { "day_plan": { "value": "…", "updated_at": "2026-09-10T01:02:04Z", "overwritten": false } } }
```

规则：`base_updated_at` 与服务端该字段的 `updated_at` 不一致 → 仍写入（后写优先），但标 `overwritten: true`，前端提示"这条在另一台设备上更新过"。不用 409，不用整行 LWW。

### 4.5 业务约定

以"9 月 10 日的今日页"为例：

| 界面位置 | 写入目标 | 字段 |
| --- | --- | --- |
| 昨日回顾 | **9 月 9 日**的记录 | `day_events`、`day_meals` |
| 今日计划 | **9 月 10 日**的记录 | `day_plan` |
| 突发事情 | **9 月 10 日**的记录 | `entry_date = 9/10` |
| 晚间总结 | **9 月 10 日**的记录 | `evening_summary` |

1. 客户端**不传**"昨天"的日期，只传"我在填今天"，D-1 由服务端算（避免客户端时区错误串天）；
2. 补写历史用 `PUT /v1/diaries/:date/review`，`:date` 是**被回顾的那一天**；
3. 改时区后**已存在记录的 `entry_date` 不回算**；后续写入按新时区；
4. 所有查询强制带 `user_id` 条件。

---

## 5. 时间规则（✅ 已实现）

代码：**`source/shared/src/time.ts`**（零依赖，只用内置 `Intl`，前后端同一份）。
测试：**`source/shared/test/time.test.ts`**，19 个用例。

| 函数 | 职责 |
| --- | --- |
| `diaryDate(instant, tz, dayStartHour=4)` | 日界：本地 `dayStartHour` 之前算前一天 |
| `resolveWallTime(y, m, d, h, mi, tz)` / `resolveLocal(isoDate, 'HH:MM', tz)` | 墙上时间 → UTC 瞬间，DST 安全 |
| `nextFireAt(now, tz, 'HH:MM', dayStartHour=4)` | 下一次提醒时刻，**严格大于 now** |
| `addDays` / `wallClock` / `zoneOffsetMinutes` | 日历运算与偏移查询 |

DST 三条规则（都有测试覆盖）：

1. 目标墙上时间**不存在**（春季跳变）→ 顺延一个跳变间隔（纽约 02:30 → 03:30 EDT）；
2. 目标墙上时间**出现两次**（秋季回拨）→ 取**较早**的一次，且当天只发一次（幂等键按日记日）；
3. 任何时候都**不假设**"本地时间一定存在"，算法按 IANA 规则解算，不写死偏移。

---

## 6. 后端与 API

### 6.1 技术选型（个人 + 小机器 + Docker）

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | **Node 24 直接跑 TypeScript**（类型擦除） | 镜像里不需要构建产物：`CMD node server/src/index.ts` 即可；类型检查交给 `tsc --noEmit`（不能用 `enum`/`namespace`/构造器参数属性） |
| Web 框架 | **Fastify** + `@fastify/static` | 比 Nest 轻；静态前端由同一进程托管，镜像自包含、迁移只搬镜像与数据卷 |
| 监听端口 | **8090**（可用 `PORT` 覆盖） | 你自备反代，应用只负责监听本地端口，镜像里不含任何 TLS/反代组件 |
| 数据库 | **PostgreSQL 16**（compose 里的 `db` 服务） | 事务、`FOR UPDATE SKIP LOCKED`、备份成熟 |
| ORM / 迁移 | **Drizzle + node-postgres** | 纯 TS、无 Rust 引擎；迁移是 SQL 文件，启动时自动跑 |
| 口令哈希 | **Node 内置 scrypt**（`node:crypto`） | 零依赖、可离线测试 ✅ 已实现 |
| 校验 | JSON Schema（Fastify 内置） | 少一个依赖，且可用于生成前端类型 |
| 日志 | pino → stdout | Docker 统一收日志（`docker compose logs`） |

### 6.2 认证（用户名 + 密码，管理员侧添加账号）

- **注册关闭**：没有自助注册接口。账号由**管理员侧**创建：
  - 阶段 1：CLI —— `docker compose exec app node server/src/cli/user.ts create --username getl`（密码交互输入，不落 shell 历史）；
  - 可选（后置）：设置页里的"管理"区块，仅管理员账号可见。**默认不做**，需要时再加 `users.role`。
- **用户名规则**：3–32 字符，`^[a-z0-9_-]+$`，统一存小写（数据库 CHECK 约束保证）；不引入邮箱；
- **登录**：`POST /v1/auth/login`（`{ username, password }`）→ access JWT（15 分钟）+ refresh 令牌（30 天）；
- **口令**：`scrypt`（N=32768, r=8, p=1, keylen=64，随机 16 字节盐），存储格式 `scrypt$N$r$p$salt$hash`（base64url）✅ 已实现；
- **令牌**：全部走 **Bearer Token**（与未来的 Capacitor APK 一致）；服务端只存 refresh 令牌的 SHA-256 哈希，轮转 + 复用检测 ✅ 已实现；
- **忘记密码 / 重置**：管理员跑 CLI `… reset-password --username getl`；
- **停用**：`status = disabled` 后所有令牌立即失效（校验时查 `status`）。

### 6.3 接口清单

```text
# 元信息
GET    /healthz                             # 存活探针（含 DB ping）
GET    /v1/meta/today                       # { diary_date, timezone, day_start_hour, server_time }

# 认证
POST   /v1/auth/login                       # { username, password }
POST   /v1/auth/refresh
POST   /v1/auth/logout

# 日记
GET    /v1/diaries/today                    # 聚合：today 行 + yesterday 行 + 今日 incidents + 进度
GET    /v1/diaries/:date                    # 单日详情（该行 + 该日 incidents）
PATCH  /v1/diaries/:date                    # 字段级写入（见 §4.4）
PUT    /v1/diaries/:date/review             # 补写某天的 day_events / day_meals

# 突发事情
POST   /v1/diaries/:date/incidents          # 客户端生成 id → 幂等
PATCH  /v1/incidents/:id
DELETE /v1/incidents/:id
GET    /v1/incidents?date=2026-09-10

# 日历与设置
GET    /v1/calendar?month=2026-09
GET    /v1/settings
PATCH  /v1/settings                         # 时区、日记日起始时间、静默时段
PUT    /v1/settings/reminders               # 提醒时间与开关（触发排程重算）

# 推送订阅
POST   /v1/notifications/subscriptions      # upsert（endpoint 唯一）
POST   /v1/notifications/subscriptions/heartbeat
DELETE /v1/notifications/subscriptions/:id
GET    /v1/notifications/status             # 已订阅设备数、最近发送结果

# 账号
DELETE /v1/account                          # 二次确认后进入 7 天宽限期
```

其他要求：文本上限（正文 8000 / 突发 2000）服务端校验；写入返回 `version` 与各字段 `updated_at`；写接口限流（每用户 60 次/分钟）；401 → 刷新令牌重试一次。

---

## 7. 部署与运维（Docker，自有 VPS）

### 7.1 拓扑

```text
Internet
   ↓ 80/443
【你自己的 nginx / caddy 等反向代理】   ← 不在本项目的镜像与 compose 里
   │   · TLS 证书、子域路由、gzip/缓存，全部由你配置
   ↓ proxy_pass http://127.0.0.1:8090
┌──────────────────── docker compose（本项目）────────────────────┐
│  app（daybook:latest，仅监听 8090）                              │
│     ├── Fastify REST API（/v1/*、/healthz）                      │
│     ├── @fastify/static 托管 web/dist（打进镜像）                 │
│     └── 排程 tick（进程内 setInterval，每 60 秒一次查询）          │
│                     ↓                                            │
│  db（postgres:16-alpine，volume: pgdata，不映射到宿主机端口）      │
└──────────────────────────────────────────────────────────────────┘
```

- **镜像职责单一**：只跑应用（HTTP:8090），不含任何反代/TLS 组件；
- **端口**：容器内 8090；compose 里默认绑到宿主机 `127.0.0.1:8090`（只有本机反代能访问，公网访问不到）。若你的反代跑在另一个容器/网络里，把绑定改成 `0.0.0.0:8090` 或把它加入同一 docker 网络即可；
- **迁移部署** = 搬镜像 + 搬 `pgdata` 卷 + 一份 `.env`。

### 7.2 Dockerfile 与 compose（阶段 1 落地）

```dockerfile
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8090
# 先装依赖，利用层缓存
COPY source/package.json source/package-lock.json ./
COPY source/shared/package.json shared/
COPY source/server/package.json server/
COPY source/web/package.json web/
RUN npm ci --omit=dev
# 源码直跑，无构建步骤；前端产物随镜像进来
COPY source/shared ./shared
COPY source/server ./server
COPY source/web/dist ./web/dist
EXPOSE 8090
CMD ["sh", "-c", "node server/src/db/migrate.ts && node server/src/index.ts"]
```

```yaml
# compose.yml
services:
  db:
    image: postgres:16-alpine
    command: ["postgres", "-c", "shared_buffers=384MB", "-c", "work_mem=8MB", "-c", "max_connections=20"]
    environment:
      POSTGRES_DB: daybook
      POSTGRES_USER: daybook
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U daybook"], interval: 10s, retries: 10 }
    restart: unless-stopped
  app:
    image: daybook:latest            # 或 build: .（本机构建）
    env_file: [.env]
    environment:
      DATABASE_URL: postgres://daybook:${POSTGRES_PASSWORD}@db:5432/daybook
      PORT: "8090"
    ports:
      - "127.0.0.1:8090:8090"        # 只给本机反代用；反代在别的容器时改成 "8090:8090"
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped
volumes: { pgdata: {} }
```

- 宿主上只剩 Docker 本身（不用 systemd 跑 Node）；
- 数据库**不映射端口**，只在 compose 网络内可见；
- 老 CPU 上镜像用 `node:24-alpine`（体积小、启动快）。

### 7.3 资源预算（3C / 4G / 老 CPU）

| 组件 | 常驻内存 | 说明 |
| --- | --- | --- |
| `app` 容器（API + 静态 + 排程） | 90–160 MB | 单 Node 进程，无 worker 集群 |
| `db` 容器（PostgreSQL 16） | 200–300 MB | `shared_buffers=384MB`、`work_mem=8MB`、`max_connections=20` |
| Docker daemon | 100–150 MB | 镜像化的代价 |
| 你的反向代理（已有的 nginx） | — | 不属于本项目，通常本来就在跑 |
| **本项目新增合计** | **≈ 0.4–0.6 GB** | 空闲 CPU ≈ 0；峰值在写入与每分钟一次 tick |

- 不用 Redis（任务表就在 PostgreSQL 里），不用 Prometheus/Grafana，不用 Kubernetes；
- 数据库连接数 5–10 足够。

### 7.4 数据库

- 迁移：`source/server/migrations/*.sql`，容器启动时 `node server/src/db/migrate.ts` 自动执行，幂等；
- 小机器参数写进 compose 的 `db.command`（见上面 compose）；
- 备份与恢复一律通过 `docker compose exec db pg_dump`，不依赖宿主上的 psql。

### 7.5 备份与恢复

- 宿主 cron：`docker compose exec -T db pg_dump -Fc -U daybook daybook > /srv/backup/daybook-$(date +%F).dump`，保留 14 天；
- 每周把最新备份 `rsync` 到本地机器（或 WSL）一份，避免"备份与数据同盘"；
- **恢复演练是验收项**（§13.10）：`pg_restore` 到新卷，能登录、能读写；
- VPS 商提供的整机快照作为第二层保障。

### 7.6 日志与监控（极简）

- 应用日志走 stdout，由 Docker 收；`docker compose logs -f app`；
- 宿主加一条 docker 日志轮转（`max-size: 10m, max-file: 3`）；
- `/healthz` 返回 DB 连通性；外部探活（cron + curl，或 Uptime Kuma）盯 1 分钟一次；
- 关键指标只记日志：排程积压（`next_fire_at < now() - 5min` 的行数）、Web Push 发送失败率、订阅 410 数量。

### 7.7 升级与回滚

```text
docker compose pull && docker compose up -d      # 镜像更新即升级（迁移在启动时跑完）
docker compose down && docker compose up -d      # 回滚：把 compose 里的镜像 tag 改成上一个版本
```

迁移尽量做成向后兼容；破坏性变更单独一次发布并先备份。

---

## 8. 通知（Web Push）

### 8.1 覆盖与口径

| 平台 | 能力 | 承诺 |
| --- | --- | --- |
| 桌面 Chrome / Edge / Firefox | 服务端 Web Push | 当天送达，不承诺准点 |
| Android Chrome（含 PWA 安装） | 服务端 Web Push | 同上；系统省电策略可能延迟或合并 |
| Android APK | **原生本地定时通知**（本机排、非精确闹钟、不用 FCM） | 接近准点，离线也可用 |
| macOS Safari | 服务端 Web Push（需系统支持版本） | 当天送达，不承诺准点 |
| iOS 主屏 PWA | 服务端 Web Push（**必须先"添加到主屏幕"并在 App 内授权**） | 同上 |
| iOS Safari 标签页 | 不支持 | 引导页提示"添加到主屏幕" |

### 8.2 排程与幂等

两张表（DDL 见附录 A）：

1. `reminder_schedule`：每用户每类型一行 `next_fire_at`；用户创建、改提醒时间、改时区、改日界、开关提醒时**增量重算**（不做每分钟全表时区计算）；
2. `notification_deliveries`：`UNIQUE (user_id, local_date, kind)` 幂等键 + `status`（pending/sent/failed/skipped）+ `attempts` + `last_error`，**不存任何正文**。

tick 循环（每分钟）：

```text
取 next_fire_at <= now() 的排程行（FOR UPDATE SKIP LOCKED，限量）
  → 事务内 INSERT notification_deliveries ON CONFLICT DO NOTHING
       插入成功 = 首次发送机会；插入冲突 = 已处理过，跳过（幂等）
  → "仅未完成时提醒"开启且内容已完成 → 记 skipped
  → 否则发送 Web Push：成功 → sent；404/410 → 立即禁用该订阅；其他失败 → failed + 下一轮重试（≤3 次）
  → 无条件重算 next_fire_at = nextFireAt(now, …)   # source/shared/src/time.ts
```

### 8.3 订阅管理

- 前端**每次应用启动**检查 `pushManager.getSubscription()`：存在则上报心跳（幂等 upsert）；不存在**不主动弹权限**；
- **不要依赖 `pushsubscriptionchange`**（WebKit 支持不可靠，待真机确认）——启动时主动校验才是可靠路径；
- VAPID 密钥只放 `.env`；端点视为敏感信息，日志里不出现完整 endpoint。

### 8.4 iOS 安装引导（正式做）

`InstallGuide` 组件（路由 `/install`，设置页与首次开启提醒时都会链到它）：

1. **环境识别**：iOS Safari 标签页 / iOS 已安装（`navigator.standalone === true` 或 `display-mode: standalone`）/ 桌面浏览器 / Android，各自显示对应文案；
2. **步骤**（iOS Safari）：分享按钮 → "添加到主屏幕" → 添加 → **从主屏图标打开** → 点"开启每日提醒"（授权必须由用户手势触发，在标签页里点没用）；
3. **已安装时**：显示"已安装 ✓"，直接给"开启每日提醒"按钮与当前权限状态（`granted` / `denied` / `default`）；`denied` 时给出"设置 → 通知 → daybook → 允许"的手动路径；
4. 不做转化漏斗埋点，只显示状态；文案写明"提醒时间是当天送达，不保证整点"。

---

## 9. 前端要点

### 9.1 结构

```text
source/web/src/
├── pages/      TodayPage / CalendarPage / DiaryDetailPage / SettingsPage / InstallGuidePage
├── components/ MorningJournalCard（YesterdayReviewSection 写 D-1、TodayPlanSection 写 D）
│               IncidentTimeline / QuickIncidentModal / EveningSummaryCard
│               SaveStatus（idle·dirty·saving·saved·offline·error）
│               NotificationPermissionGuide / InstallGuide
└── lib/        api 客户端（Bearer + 刷新重试）、autosave hook、IndexedDB 草稿队列
```

### 9.2 自动保存与离线

- 停止输入 1.5 秒防抖；失焦、`visibilitychange`、`pagehide` 立即触发；
- **只提交变更字段**，带上一次响应里的 `base_updated_at`；
- 保存状态可视化；收到 `overwritten: true` 时提示"另一台设备更新过"，并把本地输入留在草稿里供复制；
- 未同步草稿存 IndexedDB（键：`user_id + entry_date + field`），`online` 事件或定时探测后按修改时间顺序重放；
- 冲突双栏对比 UI 留到第二迭代。

### 9.3 PWA

Manifest（`display: standalone`）+ Service Worker（应用壳与最近日记缓存）；`/v1/*` 不缓存；通知点击深链到对应栏目（`#morning` / `#evening`）。

### 9.4 Android APK（Capacitor 壳）

**已实现**（2026-09-11）：

- **Capacitor 8.5.1** 包壳，复用同一套前端；工程在 `source/web/android/`（appId `com.getlx.daybook`，minSdk 24 / compileSdk 36 / targetSdk 36，`androidScheme: https` → 必须 HTTPS 后端）；
- **APK 内置前端资源**：前端产物打包进 APK，离线也能打开应用壳；因此前端每次改动要重发一版 APK（个人使用可以接受）；
- **后端地址默认不写死**：原生壳首次启动让用户填服务器地址（存 localStorage，见 `source/web/src/lib/server.ts`）；可选地用 `VITE_DAYBOOK_SERVER_URL`（由仓库变量 `DAYBOOK_SERVER_URL` 注入）预设默认值。WebView 的源是 `https://localhost`，所以必须用绝对地址；
- **服务端 CORS**：默认放行 `https://localhost` 与 `capacitor://localhost`，可用环境变量 `CORS_ORIGINS`（逗号分隔）覆盖；不开 credentials，令牌仍走 `Authorization` 头；
- **CI 出包**：`.github/workflows/android-release.yml` 打 `v*` 标签 → 构建前端 + `cap sync` + gradle 打包 → 把 `daybook-<版本>-android-<release|debug>.apk` 与 `.sha256` 附到 GitHub Release；
- **签名**：用你现有的 `.jks`（密钥文件放**仓库外**，仓库里只放 `source/web/android/keystore.properties.example`）；配了 secrets 出正式包，**没配就自动退化成 debug 签名包**（能装能测，但密钥是公开的调试密钥，不能当正式版升级）。命令见 `android-release.yml` 与运维手册；
- **本地定时提醒（非 FCM 的本地排程）**：APK 用 `@capacitor/local-notifications` 在本机排未来 90 天的**非精确**本地通知（`isExactNotification: false` → 不申请精确闹钟权限、不用 Google 服务 / FCM），登录后与回到前台时按用户时区 / 日界重新登记（排程逻辑与后端 Web Push 共用 `@daybook/shared` 的时区算法，见 `source/web/src/lib/notifications/`）；浏览器里的 PWA 不受影响，仍走服务端 Web Push；

**仍留第二迭代**：

- **应用图标**：仍是 Capacitor 默认图标；
- **iOS**：未做。

> 本地出包（需 JDK 21 + Android SDK）：`cd source/web && npm run android:sync && cd android && ./gradlew assembleDebug`。

---

## 10. 安全与隐私

- **反代与 TLS 由你负责**（本项目镜像不提供）：只在反代层暴露 80/443，应用侧只监听 `127.0.0.1:8090`；
- `JWT_SECRET`、`POSTGRES_PASSWORD`、VAPID 私钥只放 `.env`（600，且 **`.env` 不进镜像、不进仓库**）；
- 口令 **scrypt**（N=32768）；登录失败限流（同一用户名 5 次/15 分钟 + 全局限流）；
- 服务端只存 refresh 令牌的 SHA-256 哈希；access 令牌 15 分钟过期；
- 日志不出现日记正文、令牌、完整 push endpoint；
- 数据库不映射公网端口，只有 `app` 容器通过 compose 网络访问；
- 宿主：SSH 仅密钥登录、`ufw` 只放 22/80/443（**不要**放 8090）、`unattended-upgrades` 自动安全更新；
- 删除账号：设置页二次确认 → 7 天宽限期后清除日记、突发记录、订阅与令牌；
- 备份文件含全部日记，权限 600，不放在 Web 可访问目录。

---

## 11. 测试（Windows 本地 + WSL，先本地验证再建仓库）

**基线**：Node 内置 runner + TS 类型擦除，零依赖。

```bash
# 本地（Windows / Node 24）：shared 纯逻辑 + server 认证与令牌
node --test "source/shared/test/*.test.ts" "source/server/test/*.test.ts"

# WSL：WSL 自带的 Node 22 是不含 TS 支持的构建（ERR_NO_TYPESCRIPT），两条路都验证过：
#   a) 直接调 Windows 的 Node 24（已实测 39 用例全绿）
cd <仓库根目录> && "/mnt/c/Program Files/nodejs/node.exe" --test "source/shared/test/*.test.ts" "source/server/test/*.test.ts"
#   b) 或把 WSL 的 Node 升到 24（nvm install 24 / NodeSource）后直接 node --test
```

**环境事实（已实测，供阶段 1 用）**：WSL Ubuntu 里 **npm 是通的**（`npm view fastify version` → 5.12.3），因此依赖可以在 WSL 安装并真跑起服务端；`node_modules` 会因此变成 Linux 版本，Windows 侧要跑服务端需重装（我们的依赖全为纯 JS，切换代价很低）。

分层：

| 层 | 覆盖 | 工具 |
| --- | --- | --- |
| 纯逻辑 ✅ | 日界、时区、DST、提醒推进 | `node --test`（`source/shared/test`） |
| 认证与令牌 ✅ | scrypt 哈希/校验、JWT 签名与校验、refresh 令牌哈希 | `node --test`（`source/server/test`，零依赖） |
| 服务端 | 排程幂等、时区重算、字段级冲突、账号隔离、订阅 410 清理、迁移可跑 | `node --test` + 测试库（在 compose 的 db 上建 `daybook_test` 跑迁移） |
| 接口 | 登录、今日聚合、PATCH 契约、日历 | Fastify `inject()`，不启真实端口 |
| 前端 | 自动保存状态机、草稿重放 | Playwright（可选，第二迭代） |
| 部署 | `docker compose up` 冷启动、备份恢复演练、容器重启数据不丢 | 手动清单 |

必须覆盖的边界用例（已有测试）：23:59 / 00:00 / 03:59 / 04:00、跨时区同一瞬间、DST 跳变与回拨、半小时时区（+05:30）、提醒严格大于 now、连续两次提醒间隔一天；令牌过期、签名篡改、`alg=none`、哈希串格式异常、截断哈希。

---

## 12. 里程碑

| 阶段 | 周期 | 交付物 | 状态 |
| --- | --- | --- | --- |
| 0. 技术验证 | — | 时间核心 ✅（19 用例）；认证核心 ✅（20 用例）；Web Push 端到端 spike（需你在真实浏览器 / iPhone 上跑，见 §8.4、§15） | 进行中 |
| 1. 仓库骨架与地基 | 1 周 | monorepo（`shared` / `server` / `web`）、Drizzle 迁移、登录接口 + CLI 建号、`/healthz`、**Dockerfile + compose（8090，反代自备）**、本地验证清单 | 进行中 |
| 2. 日记核心 | 2 周 | 今日页三块、字段级自动保存与冲突提示、突发记录、日历与单日详情（补写/编辑）、iOS 安装引导页 | 待开始 |
| 3. 通知 | 1 周 | `reminder_schedule` + tick、Web Push 发送与失效清理、设置页提醒配置、启动时订阅校验 | 待开始 |
| 4. 测试与上线 | 1 周 | 浏览器/真机矩阵、备份恢复演练、隐私说明、监控探活、首个正式镜像 | 待开始 |

**第一迭代合计约 5～6 周**（1 人，按投入时间浮动）。

**第二迭代（约 2 周）**：Android APK（Capacitor + 本地通知 + GitHub Releases，用你的 jks 签名，约 1～1.5 周）、导出（Markdown/JSON）、冲突合并 UI、回顾统计、管理页（可选）。

**流程约定**：GitHub 仓库与 CI **推迟到本地验证通过之后再建**；在那之前，验证 = `npm test` + `docker compose up -d` + `/healthz`。

---

## 13. 第一迭代验收标准

1. 用户名 + 密码登录可用；未登录看不到任何数据；A 账号无法读写 B 账号的任何记录（两个账号互测）。
2. 今日页包含五类内容：昨天发生了什么、昨天吃了什么、今天准备做什么、突发事情、今日总结。
3. 昨日回顾与今日计划有明确标题/日期/分隔线，**且数据分别落在 D-1 与 D 两条记录上**（API 断言）。
4. 突发事情可随时新增多条、按时间排序，可在任意历史日期补写。
5. 文本自动保存：刷新、关闭标签、断网重连后不丢已同步内容；重复请求不产生重复记录。
6. 日历可查看、补写、编辑过去的日记；补写不会覆盖其他日期。
7. 默认 09:00 / 21:00 提醒可配置；"仅未完成时提醒"可开关；改时区、改提醒时间、关闭提醒后不重复、不误发（以 `reminder_schedule` 与 `notification_deliveries` 断言）。
8. 桌面 Chrome/Edge 与 Android Chrome 能收到 Web Push；iOS 主屏 PWA 在安装 + 授权后能收到（记录实测结果）。
9. 通知点击进入正确栏目，且通知横幅不含日记正文。
10. 备份恢复演练通过：从 `pg_dump` 备份恢复到新实例后能登录、能读写。
11. 容器重启后自动拉起，`next_fire_at` 重算正确、无重复提醒；`pgdata` 卷里的数据不丢。
12. **本项目空闲常驻内存 < 700 MB**（app + db + Docker daemon 合计；不含你自己的反代）。
13. `docker compose up -d` 一条命令在干净机器上起完整栈：自动跑迁移、`/healthz` 返回 200、`127.0.0.1:8090` 可访问；`.env` 缺失时明确报错而不是静默启动。
14. **镜像里没有任何 TLS/反代组件**，8090 之外的端口不监听；用 `nginx` 反代到 `127.0.0.1:8090` 后可从公网正常使用（含 HTTPS、通知授权）。
15. iOS 安装引导页可用：iPhone Safari 下给出正确步骤，已安装时显示"已安装"并可开启提醒。
16. 账号由管理员添加：CLI 能建号、重置密码、停用账号；停用后该用户的令牌立即失效。

---

## 14. 待决项与默认值

| # | 问题 | 默认值 |
| --- | --- | --- |
| 1 | 账号与注册 | **用户名 + 密码**，注册关闭；账号由管理员 CLI 添加（管理页面后置，需要再加 `users.role`） |
| 2 | 提醒频率 | **仅未完成时发**（可关闭该限制） |
| 3 | 晚间总结 | 单一自由文本（固定子问题留到第二迭代评估） |
| 4 | "昨天吃了什么" | 单一自由文本（不拆三餐） |
| 5 | 深色模式 / 语言 | 跟随系统 / 中文 |
| 6 | 域名与 TLS | 应用只监听 **8090**；TLS 与反代**由你自己部署**（nginx 等），建议子域 `daybook.<domain>` 反代到 `127.0.0.1:8090` |
| 7 | APK 签名 | 用你已有的 `.jks`；密钥与口令放仓库外，仓库只放 `keystore.properties.example` |
| 8 | APK 加载方式 | **内置前端资源**（可离线打开）；若日后嫌重发版麻烦，改远程加载只需一行配置 |
| 9 | 导出 | 第二迭代；删除账号在第一迭代就有 |

---

## 15. 参考与待验证

- **待真机验证（你来做，1 小时以内）**：① 桌面 Chrome 与 Android Chrome 各收到一条真实推送；② iPhone：Safari 添加到主屏幕 → 从主屏打开 → 授权 → 收到推送 → **隔天再确认订阅是否仍有效**（决定要不要每次启动重订阅）；③ iOS 上 `pushsubscriptionchange` 是否触发。
- 官方文档：Apple/WebKit 的 Web Push 与主屏幕 Web App 说明；Chrome for Developers 的通知说明；`web-push` / VAPID 规范；Capacitor Local Notifications；Android 的 jks/apksigner 签名说明；PostgreSQL 小内存调参。

---

## 附录 A：DDL 草案

```sql
-- 用户：注册关闭，账号由管理员侧 CLI 添加
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  username      text NOT NULL UNIQUE
                CHECK (username = lower(username) AND username ~ '^[a-z0-9_-]{3,32}$'),
  password_hash text NOT NULL,                   -- scrypt$N$r$p$salt$hash
  status        text NOT NULL DEFAULT 'active',  -- active | disabled | pending_deletion
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE user_settings (
  user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone                  text NOT NULL DEFAULT 'Asia/Shanghai',   -- IANA
  day_start_hour            smallint NOT NULL DEFAULT 4 CHECK (day_start_hour BETWEEN 0 AND 6),
  morning_reminder_enabled  boolean NOT NULL DEFAULT true,
  morning_reminder_time     time NOT NULL DEFAULT '09:00',
  evening_reminder_enabled  boolean NOT NULL DEFAULT true,
  evening_reminder_time     time NOT NULL DEFAULT '21:00',
  notify_only_if_incomplete boolean NOT NULL DEFAULT true,
  theme                     text NOT NULL DEFAULT 'system',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_entries (
  id                         uuid PRIMARY KEY,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date                 date NOT NULL,
  day_events                 text,
  day_meals                  text,
  day_plan                   text,
  evening_summary            text,
  day_events_updated_at      timestamptz,
  day_meals_updated_at       timestamptz,
  day_plan_updated_at        timestamptz,
  evening_summary_updated_at timestamptz,
  version                    integer NOT NULL DEFAULT 1,
  reviewed_at                timestamptz,
  summarized_at              timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date)
);

CREATE TABLE incidents (
  id          uuid PRIMARY KEY,                 -- 客户端生成
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date  date NOT NULL,                    -- 服务端按 occurred_at + 时区 + 日界计算
  occurred_at timestamptz NOT NULL,
  content     text NOT NULL CHECK (char_length(content) <= 2000),
  tag         text CHECK (tag IN ('work','life','emotion','idea','other')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_user_date_idx ON incidents (user_id, entry_date, occurred_at);

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

CREATE TABLE reminder_schedule (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('morning','evening')),
  next_fire_at timestamptz,                     -- NULL = 关闭
  locked_at    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX reminder_schedule_due_idx ON reminder_schedule (next_fire_at) WHERE next_fire_at IS NOT NULL;

CREATE TABLE notification_deliveries (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,                     -- 日记日
  kind       text NOT NULL CHECK (kind IN ('morning','evening')),
  status     text NOT NULL,                     -- pending | sent | failed | skipped
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date, kind)             -- 幂等键
);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,             -- SHA-256(token)
  expires_at   timestamptz NOT NULL,
  rotated_from uuid,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

## 附录 B：仓库结构

```text
daybook/
├── DAYBOOK-DESIGN.zh-CN.md   本设计文档
├── README.md
├── Dockerfile / compose.yml  容器构建与编排
├── deploy/                   daybook.env.example、backup.sh
├── docs/zh-CN/               development / deployment / operations
└── source/                   全部应用源码（npm workspaces）
    ├── package.json          workspaces: shared / server / web
    ├── shared/               前后端共用纯逻辑（time.ts）
    ├── server/               后端：Fastify + PostgreSQL
    ├── web/                  前端：React + Vite + Tailwind（PWA）
    └── scripts/              make-icons.mjs 等构建/资源脚本
```

## 附录 C：常用命令

```bash
# 本地测试（Windows / Node 24，或 WSL 里用 Node 24）
node --test "source/shared/test/*.test.ts" "source/server/test/*.test.ts"
npm test                                     # 同上（走 package.json 脚本）

# 服务器（Docker；反代由你自备，应用只监听 8090）
docker compose up -d && docker compose logs -f app
curl -s http://127.0.0.1:8090/healthz
docker compose exec app node server/src/cli/user.ts create --username getl
docker compose exec -T db pg_dump -Fc -U daybook daybook > /srv/backup/daybook-$(date +%F).dump
docker compose pull && docker compose up -d        # 升级（迁移自动执行）

# 你的 nginx（示例）
# location / { proxy_pass http://127.0.0.1:8090; proxy_set_header Host $host; }

# APK（第二迭代，用你的 jks）
npm run android:release                            # 构建 web + cap sync + assembleRelease
```

---

## 17. 实现记录与差异（2026-09-10）

### 17.1 与本文档的差异（以代码为准）

| 计划里的写法 | 实际实现 | 原因 |
| --- | --- | --- |
| `PUT /v1/settings/reminders` | `PATCH /v1/settings`（同一套字段，改完立即重算排程） | 设置项少，一个接口够用；字段级 patch 语义一致 |
| `POST /v1/diaries/:date/incidents` | `POST /v1/incidents`（归属日由 occurred_at 推导） | 归属日是算出来的，不该由调用方指定；改时间会跳日 |
| `PUT /v1/diaries/:date/review` | 复用 `PATCH /v1/diaries/:date`（写 D-1 那一行） | 「昨日回顾」是入口不是存储位置，无需单独接口 |
| systemd 原生部署 | Docker（应用 + PostgreSQL 两容器），容器内固定 8090 | 选定方案：自有 VPS + Docker 自托管 |
| 备份 / 导出 | 第二迭代；删除账号已在第一迭代完成 | 见 §14 第 9 条 |

### 17.2 一次完整的安全/正确性审查（2026-09-10）与修复

审查范围：整棵源码树（仓库当时还没有 git 历史，无法用 diff）。发现并已修复：

1. **时区只做正则校验（严重）**：`Asia/Beijing` 这类“格式对但不存在”的时区能写进库，之后每次算日记日都会抛 RangeError → 该账号所有接口 500；更糟的是调度器在用户循环里抛异常会中断整个 tick，让**所有**用户的提醒停摆。→ 改为真校验（`isValidTimeZone`），并让调度器对每个用户单独 try/catch（`report.errors` 计数）。
2. **access token 不校验会话撤销**：登出/轮转后 15 分钟窗口内旧令牌仍可用。→ 每次请求用一句 JOIN 查询校验“账号 active + 该会话未吊销”。
3. **refresh 轮转非原子**：并发重放同一个 refresh token 会各拿到一套新令牌。→ 改为条件更新（CAS），抢不到的拒绝并记日志。
4. **5xx 泄露内部信息**：数据库错误原文会回给客户端。→ 5xx 统一只回 `{error:"internal_error"}`，详情只进日志。
5. **日期/极值时间校验缺口**：`2026-02-31`、`0001-01-01`、`+275760-09-13` 会以 500 的形式炸在数据库或日期计算那层。→ 日期做真实日历日校验，`occurred_at` 限定 2000–2100 年。
6. **`/v1/meta/timezones` 漏认证** → 需要登录。
7. **反代下限流错位**：未开 `trustProxy`，`request.ip` 恒为反代地址，30 次失败会锁死所有人。→ 开 `trustProxy`；登录成功只重置该用户名的计数，IP 桶保留。
8. **登录限流 Map 无界增长** → 超过 5000 条时清理过期项。
9. **SPA 回退吞掉资源 404**：部署后旧页面引用已删除的 `/assets/xxx.js` 会拿到 200 的 HTML → 白屏且难排查。→ 静态资源（含 `/assets/`）缺失一律 404。
10. **镜像以 root 运行** → `USER node`。
11. **账号删除（验收标准第 10 条）**：新增 `DELETE /v1/account`（口令确认 → 立刻吊销全部会话、清推送订阅、停提醒排程、状态转 `pending_deletion`）+ 迁移 `0001_account_deletion.sql` + 每分钟 tick 自动清理过 7 天宽限期的账号 + CLI `purge` / `purge-expired` + 设置页入口。
12. **前端离线草稿可能盖掉更新的服务器内容** → 重放前比对时间（含 2 分钟时钟偏差容忍），明显过期的草稿丢弃并告知用户。
13. **请求在途时 pagehide 会丢字** → 先把草稿落盘，再排队补一次 flush。

### 17.2.1 一个真实的坑：历史迁移的注释也不能改

按本文档 §16 的仓库约定重组目录时（代码全部收进 `source/`），顺手把注释里指向旧文档名的路径也改了——结果改到了**已经应用过的迁移文件**（`0000_init.sql` 与 `0001_account_deletion.sql` 的注释行）。migrator 会比对已应用迁移的 sha256，改一个字符都算“历史迁移被改动”，服务直接拒绝启动（日志：“迁移 … 在应用之后被改动过”），容器于是重启循环。

所以这两个文件的注释**有意保持着旧文档名 `docs/development-plan.md`**（本文件现在叫 `DAYBOOK-DESIGN.zh-CN.md`）：历史迁移一旦跑过就不该再碰，要补充说明就写进新迁移或文档。给“已应用过的迁移”做任何编辑（哪怕只改注释）之前，先回想这条规则。

### 17.3 验证与未验证

已验证：

- `npm test` 189/189 通过（2026-09-11 这一轮新增 9 条 CORS 用例）；`typecheck`（server 与 web）无错；`build -w @daybook/web` 通过。
- 跨源（CORS）实测：带 `Origin: https://localhost` 时响应含 `access-control-allow-origin: https://localhost`，其它源不含；预检 `OPTIONS /v1/diaries/:date` 返回 204。
- 容器冒烟：镜像构建通过、两容器 healthy、`/healthz` 200、缺失 `/assets/*` 返回 404、SPA 路径 200、`/v1/meta/timezones` 401、容器内 `uid=1000(node)`；启动日志可见“迁移完成：应用 1 个，跳过 1 个（0001_account_deletion.sql）”与“前端产物已挂载”。
- 账号删除端到端（容器内真实 HTTP）：登录 200 → 口令错 401 → 口令对 204 → 同令牌再用 401 → 库中 `status=pending_deletion`。
- 提醒调度端到端（容器内真实 Postgres + web-push）：强制一条到期排程后，失败重试 attempts 1→2→3、排程不前进，第 4 个 tick 才推进到次日 08:30；全程 `notification_deliveries` 只有 1 行（幂等键生效）。

仍未验证（需要真机或真实推送服务）：真机收到推送；iOS 主屏 PWA 订阅隔天是否仍有效；`pushsubscriptionchange` 是否触发；真实 410/404 的 gone 分类。

