# Web Push 与提醒调度实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Go + PocketBase 版 daybook 后端补齐 Web Push 与提醒调度，使 `source/web` 现有的订阅流程与提醒功能真正可用。

**Architecture:** 三层移植——`notifications` 放零依赖纯领域逻辑（时区/静默时段/文案），`push`/`vapid` 是对 `webpush-go` 的薄适配，`scheduler` 把数据流串成一次可独立调用的 tick；`store` 承担数据访问，`api` 只做契约翻译。幂等由数据库唯一索引保证，不依赖进程内锁。

**Tech Stack:** Go 1.27、PocketBase v0.40.4、`github.com/SherClockHolmes/webpush-go v1.4.0`、PocketBase 内置 cron、`pocketbase/tests` 的 `TestApp`。

**Spec:** `docs/zh-CN/web-push-design.md`

> **本计划的形态说明**：按 skill 默认要求，计划里应逐字包含每个文件与测试的完整代码。本计划刻意不含——它会在写完之后**在同一会话内立即执行**，把代码写两遍是纯浪费。因此这里只锁定任务边界、文件、接口签名与验收标准；代码直接落到真实文件里，由各任务的测试与验收标准把关。

## Global Constraints

- 对外契约与 Node 版逐字一致；`source/web` 不改一行（`source/web/public/sw.js` 的注释除外）。
- `/healthz` 与既有 `/v1/*` 的响应形状不得变化。
- 状态码分类必须自实现：`webpush-go` 的 `SendNotificationWithContext` 是 `return client.Do(req)`，**不校验状态码**。
- 常量沿用 Node 实测值：`MAX_ATTEMPTS=3`、`DUE_BATCH=200`、`FAILURE_LIMIT=10`、静默推迟上限 `12h`、推送 TTL `12h`、账号宽限期 `7` 天。
- 401/403 归入 `failed`（与 Node 一致），计入 `failure_count`，满 `FAILURE_LIMIT` 自动禁用。
- VAPID 密钥不支持环境变量注入；首次启动生成并存入 `app_settings`。
- 单个用户出错不得中断整轮 tick。
- Go 注释用中文，风格对齐现有包（解释「为什么」）。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `source/server/notifications/notifications.go` | 新建 | 提醒类型、文案、触发时刻、日记日归属、完成度判定 |
| `source/server/notifications/quiethours.go` | 新建 | 静默时段推迟/跳过（纯函数） |
| `source/server/notifications/notifications_test.go`、`quiethours_test.go` | 新建 | 单测（含 DST 两向边界） |
| `source/server/push/push.go` | 新建 | 三态分类 + webpush-go 适配器 |
| `source/server/push/push_test.go` | 新建 | 分类穷举单测 |
| `source/server/store/notifications.go` | 新建 | app_settings / 排程 / 投递 / 订阅数据访问 |
| `source/server/store/notifications_test.go` | 新建 | 幂等、计数、越权隔离单测 |
| `source/server/vapid/vapid.go` | 新建 | 密钥解析 → 生成 → 持久化 |
| `source/server/vapid/vapid_test.go` | 新建 | 复用与脏数据重生成单测 |
| `source/server/scheduler/scheduler.go` | 新建 | 一次 tick + `RescheduleUser` |
| `source/server/scheduler/scheduler_test.go` | 新建 | 假 Sender 集成测试 |
| `source/server/auth/purge.go` | 新建 | 宽限期账号清理 |
| `source/server/api/notifications.go` | 新建 | 5 条通知路由 |
| `source/server/api/routes.go` | 修改 | `RouteConfig` 加 `VAPIDPublicKey`、注册路由、`GET /v1/settings` 自愈排程 |
| `source/server/api/support.go` | 修改 | `renderSettings` 接真实公钥 |
| `source/server/api/notifications_test.go` | 新建 | 契约测试 |
| `source/server/app/app.go` | 修改 | 启动解析密钥、构造 sender、注册 cron |
| `source/web/public/sw.js` | 修改 | 修掉过期注释 |

## 执行顺序上的一个依赖

`vapid` 的测试需要 `store.GetAppSetting` / `store.SetAppSetting`。因此先写这两个函数（它们是 `store` 扩展的一部分），再写 `vapid`；或者把 `store` 整体提前到 `vapid` 之前。两种都行，但不要跳。

---

### Task 1: `notifications` — 类型、文案、触发时刻、日记日归属

**Files:** 新建 `notifications/notifications.go` + `notifications_test.go`

**Produces:** `ReminderKind`（`KindMorning`/`KindEvening`）、`ReminderKinds`、`IsReminderKind`、`Payload`、`ReminderPayload`、`ComputeNextFire(enabled bool, clock string, location *time.Location, dayStartHour int, now time.Time) (*time.Time, error)`、`ReminderLocalDate(fireAt, location, dayStartHour) (schedule.ISODate, error)`、`ShouldSkipForCompletion(kind, morningDone, eveningDone bool) bool`、`NormalizeLocalTime(raw, field string) (string, error)`

**Consumes:** `schedule.NextFireAt` / `schedule.DiaryDate`

**Acceptance:** `go test ./notifications/...` 全绿，且包含两个精确的 DST 断言：

- 春季跳变：`America/New_York`、`now=2026-03-08 13:30Z`（09:30 EDT）、clock `09:00` → `2026-03-09 13:00Z`（次日 09:00 EDT）。
- 秋季重拨：`now=2026-11-01 04:00Z`、clock `01:30` → `2026-11-01 05:30Z`（取较早的一次）。

`ShouldSkipForCompletion` 刻意接收 `morningDone` / `eveningDone` 两个布尔（由 `diary.ComputeProgress` 提供），复用今日页那套派生规则，避免两处漂移。

---

### Task 2: `notifications` — 静默时段

**Files:** 新建 `notifications/quiethours.go` + `quiethours_test.go`

**Produces:** `QuietHours{Enabled,Start,End}`、`QuietAction`（`QuietDeliver`/`QuietDefer`/`QuietSkip`）、`QuietDecision{Action,At,Reason}`、`MaxDefer = 12h`、`ApplyQuietHours(deliverAt time.Time, quiet QuietHours, location *time.Location, dayStartHour int) (QuietDecision, error)`

**Consumes:** `schedule.ParseClock` / `ResolveLocal` / `DiaryDate` / `AddDays` / `FormatISODate` / `AssertDayStartHour`

**Acceptance:** 覆盖且全绿——静默关闭放行、窗口外放行、跨午夜的前段（22:00–07:00 的 23:00 → 次日 07:00）与后段（02:00 → 当天 07:00）、半开区间右端（恰好 07:00 放行）、推迟超 12 小时 → `skip`（`reason=quiet_hours`）、越过下一个日界 → `skip`、非 `HH:MM` → 报错。

---

### Task 3: `push` — 三态分类与发送适配

**Files:** 新建 `push/push.go` + `push_test.go`；`go.mod` 加 `webpush-go v1.4.0`

**Produces:** `Status`（`StatusSent`/`StatusGone`/`StatusFailed`）、`Result{Status,Error}`、`Subscription{Endpoint,P256dh,Auth}`、`Sender` 接口（`Send(ctx, Subscription, []byte) Result`）、`Options{PublicKey,PrivateKey,Subject,TTL}`、`NewSender(Options) Sender`、`ClassifyStatus(int) Result`

**Acceptance:** `ClassifyStatus` 穷举全绿——200/201/202 → `sent`；404/410 → `gone`；401/403/400/413/429/500/503 → `failed`；所有非 `sent` 结果的 `Error` 非空且形式为 `HTTP <code>`；传输层错误 → `failed`（可重试）。

注意 `webpush.GenerateVAPIDKeys()` 返回 `(privateKey, publicKey, err)`，顺序与直觉相反。

---

### Task 4: `store` 扩展 — 数据访问

**Files:** 新建 `store/notifications.go` + `notifications_test.go`

**Produces:** `GetAppSetting(app, key) (string, bool, error)`、`SetAppSetting(app, key, value) error`、`FailureLimit = 10`、`SetSchedule(app, userID, kind, at *time.Time) error`、`ListDueSchedules(app, now, limit) ([]DueSchedule, error)`、`BeginDelivery(app, userID, localDate, kind) (bool, error)`、`GetDelivery(...)`、`FinishDelivery(app, userID, localDate, kind, status, lastError) error`、`ListDeliveries(app, userID, limit)`、`ListSubscriptions(app, userID, onlyEnabled bool)`、`UpsertSubscription(app, userID, SubscriptionInput) (string, error)`、`SetSubscriptionEnabled(app, userID, id, enabled) (bool, error)`、`DeleteSubscription(app, userID, id) (bool, error)`、`RecordPushResult(app, id, outcome, at) error`

**已核对的集合字段**（`migrations/202609130001_initial_schema.go`）：`push_subscriptions`(`endpoint`/`p256dh`/`auth`/`user_agent`/`label`/`platform`/`last_seen_at`/`last_success_at`/`failure_count`/`disabled_at`，唯一索引 `endpoint`)；`reminder_schedule`(`kind`/`next_fire_at`/`locked_at`，唯一索引 `user,kind`)；`notification_deliveries`(`local_date`/`kind`/`status`/`attempts`/`last_error`/`sent_at`，唯一索引 `user,local_date,kind`)；`app_settings`(`key`/`value`，唯一索引 `key`)。

**Acceptance:** 全绿——`GetAppSetting` 不存在的键返回 `found=false`、覆盖写入生效；`SetSchedule` 幂等覆盖（同 `(user,kind)` 只有一行）、未到期不列出、置 `nil` 后不再列出；`BeginDelivery` 首次 `true`、重复 `false` 且不报错；`RecordPushResult` 的 `failed` 第 10 次禁用、`sent` 清零、`gone` 立即禁用；`UpsertSubscription` 同 endpoint 复用同一行（换账号也复用）；`SetSubscriptionEnabled`/`DeleteSubscription` 对非本人返回 `false` 且不影响本人数据。

`BeginDelivery` 用「插入失败后重查」判断幂等，**不**匹配驱动的错误字符串。`reminder_schedule.locked_at` 一律不写（与 Node 一致）。

---

### Task 5: `vapid` — 密钥解析与持久化

**Files:** 新建 `vapid/vapid.go` + `vapid_test.go`

**Produces:** `SettingKey = "vapid_keys"`、`Keys{PublicKey,PrivateKey}`、`ResolveKeys(app core.App, subject string) (*Keys, error)`、`SubjectOrDefault(subject string) string`

**Consumes:** `store.GetAppSetting` / `store.SetAppSetting`、`webpush.GenerateVAPIDKeys`

**Acceptance:** 全绿——首次调用生成并落库（落库内容是 `{"publicKey","privateKey"}` JSON，与 Node 版字段名一致）；第二次调用返回**完全相同**的公钥；`app_settings` 里存的是非法 JSON 时**重新生成而不是报错**，并覆盖为合法 JSON。

---

### Task 6: `scheduler` — 一次 tick 与宽限期清理

**Files:** 新建 `scheduler/scheduler.go`、`auth/purge.go`、`scheduler/scheduler_test.go`

**Produces:** `MaxAttempts = 3`、`DueBatch = 200`、`Deps{App,Sender,Now,Logf,Purge}`、`Report{Due,Sent,Skipped,Failed,Replayed,Deferred,DisabledSubscriptions,Errors}`、`RunDue(Deps) Report`、`RescheduleUser(app core.App, userID string, now time.Time) error`、`auth.PurgeExpiredAccounts(app core.App, now time.Time) (int, error)`、`auth.GraceDays = 7`

**数据流（照搬 Node 的顺序，顺序本身是语义）**：清宽限期账号 → `ListDueSchedules(now, 200)` → 逐条（每条独立错误隔离）→ 用户非 `active` 则排程置 `nil` → 静默时段（**仅当该 `(user, local_date, kind)` 还没有投递记录时**才评估）→ `BeginDelivery` 幂等占位 → 「仅未完成时提醒」→ 发给全部启用订阅并逐条 `RecordPushResult` → 全部失败时**不推进**（除已无可用订阅）→ 推进。

**Acceptance:** 全绿——正常发送并推进（推进后不再到期）；同日记日重复 tick 只发一次且第二次计入 `Replayed`；失败不推进、重试到 `MaxAttempts` 才放弃；`gone` 计入 `DisabledSubscriptions` 并禁用订阅；计划已写时早间记 `Skipped` 且不发送；`pending_deletion` 用户不发送且排程被清空；**脏时区用户不阻止同轮其他用户发出提醒**；`RescheduleUser` 按默认设置写入 2 条排程。

---

### Task 7: `api` — 5 条通知路由与设置接线

**Files:** 新建 `api/notifications.go`、`api/notifications_test.go`；修改 `api/routes.go`、`api/support.go`

**Produces:** `RouteConfig.VAPIDPublicKey *string`；`POST /v1/notifications/subscriptions`、`GET /v1/notifications/subscriptions`、`PATCH /v1/notifications/subscriptions/{id}`、`DELETE /v1/notifications/subscriptions/{id}`、`GET /v1/notifications/status`

**契约（逐字段对齐 `source/web/src/lib/api.ts`）**

- `POST` 入参 `{endpoint, keys:{p256dh,auth}, label, platform}` → `{subscription:{id}}`；缺 `endpoint`/`keys` → 400 `invalid_field`；`platform` 只允许 `web`/`ios-pwa`/`android`。
- `PATCH` 入参 `{enabled}` → `{subscription:{id,label,platform,enabled,created_at,failure_count}}`。
- `DELETE` → `204`。
- `GET /status` → `{vapid_public_key, push_configured, subscriptions[], recent_deliveries[≤10], reminders{morning_time,evening_time}}`。
- 越权或不存在 → **404 `not_found`**（两者同形，不泄露存在性）；未登录 → 401。
- `GET /v1/settings` 必须**自愈排程**（照搬 Node 的 `rescheduleUser`，注释理由：老用户可能还没有排程行），且 `push.vapid_public_key` 返回真实公钥。
- `PATCH /v1/settings` 在改动提醒/时区/日界/静默相关字段后立即重算排程。

**Acceptance:** 全绿——上述契约测试通过；既有 `/v1/settings` 形状不回归（前端 `SettingsView` 字段不变）；公钥通过闭包传入 handler（不给路由注册加全局状态）。

---

### Task 8: `app` — 接线

**Files:** 修改 `app/app.go`

**Produces:** `OnBootstrap` 内解析 VAPID 密钥（失败不致命，让服务照常起来）、构造 `push.Sender`、注册每分钟 cron（job id `daybook-reminders`）；`OnServe` 把公钥填进 `RouteConfig`。

**Acceptance:** `go build ./...`、`go vet ./...`、`go test -count=1 ./...` 全绿。密钥解析放在 `OnBootstrap`（只触发一次）而非 `OnServe`（多监听器会重复触发，`MustAdd` 会因重复 job id panic）。

---

### Task 9: 收尾与端到端验证

**Files:** 修改 `source/web/public/sw.js`（仅注释）、`docs/zh-CN/operations.md`

**Acceptance:**

1. `go build ./... && go vet ./... && go test -count=1 ./...` 全绿。
2. `source/` 下 `npm run typecheck` 与 `npm test` 全绿（前端未改，60 个测试不应回归）。
3. 容器级冒烟：构建镜像 → 起容器 → 建账号并登录 → `GET /v1/settings` 的 `push.vapid_public_key` 非 null → `POST` 一条假订阅拿到 id → `GET /v1/notifications/status` 里能看到它且 `push_configured == true` → **重启容器后公钥完全相同**。

## 自查记录

**Spec 覆盖**：§3 包结构 → Task 1–8 逐包对应；§4 数据流 → Task 6；§5 契约（5 条路由、`recent_deliveries` 10 条、越权 404、VAPID subject 接线、`push_configured`）→ Task 7；§6 D1 → Task 3 的 401/403 用例 + Task 4 的 `RecordPushResult`；D2 → Task 8；D3 → Task 4 不触碰 `locked_at`；§7 常量 → Task 3/4/6；§8 测试策略 → 各 Task 的 Acceptance + Task 9；§9 验收 → Task 9；§11 → Task 9。

**执行中需现场确认的点**（显式核对项，非占位符）：`schedule.ParseClock` 的返回顺序 `(hour, minute)`；`GenerateVAPIDKeys` 的 `(private, public)` 顺序；`diary.TextFields` / `FieldState.Value.*string` 的确切形状；`PocketBase` 的 `FindFirstRecordByFilter` 参数绑定形式。
