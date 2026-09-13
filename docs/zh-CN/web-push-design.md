# Web Push 与提醒调度设计（Go + PocketBase 版）

> 状态：已评审通过，待实现 ｜ 2026-09-13
> 适用范围：`source/server`（Go + PocketBase 重写版）新增推送与提醒调度子系统
> 硬约束：`/v1/*` 与 `/healthz` 的对外契约与 Node 版保持一致；前端 `source/web` 不改

## 1. 背景

Go 重写（第 1、2、3 阶段）已落地 `/v1` 全部契约、认证层、静态托管与部署产物，但**提醒与推送只迁移了 schema，没有迁移实现**。当前状态：

- 数据库集合齐了：`push_subscriptions`、`reminder_schedule`、`notification_deliveries`、`app_settings`（见 `source/server/migrations/202609130001_initial_schema.go`），唯一键与级联删除都已定义。
- `/v1/settings` 的 `push.vapid_public_key` **永远是 `null`**——`source/server/api/routes.go:576` 与 `:654` 两处都是硬编码 `renderSettings(..., nil, ...)`。
- 5 条通知路由完全缺失。
- 全仓库 `grep cron|scheduler|ticker` 零命中：没有任何调度。
- `go.mod` 无任何 webpush 依赖。
- `source/server/app/config.go` 的 `Config.VAPIDSubject` 从环境变量读入后**从未被使用**（死配置）。

后果：前端 `source/web/src/lib/push.ts` 能申请权限，但拿不到 `applicationServerKey`，订阅流程起不来；即便订阅成功也没有任何东西会发送提醒。

目标：把 Node 版被生产验证过的这套行为完整移植到 Go，并修掉其中一处已知缺陷。

## 2. 范围

**做**：VAPID 密钥解析与持久化、推送发送、每分钟调度 tick、静默时段、5 条缺失路由、`/v1/settings` 的公钥接线、上述行为的测试。

**不做（YAGNI）**：

- 不用环境变量注入 VAPID 密钥（已决策：Go 版首次启动自行生成并入库；Node 版的 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 不生效）。
- 不做推送管理后台（PocketBase 的 `/_/` 已够用）。
- 不做投递历史分页（`/v1/notifications/status` 只回最近若干条，与 Node 版一致）。
- 不做多进程抢占（见 §6 D3）。
- 不改前端（契约不变是前提，不是目标）。

## 3. 包结构与职责

按「纯逻辑 / 端口 / 适配器」分层，包命名对齐仓库现有风格（`api` / `app` / `auth` / `diary` / `schedule` / `store`）。

| 包 | 类型 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `schedule` | 复用 | `NextFireAt`（`schedule/time.go:190`，语义与 Node 版 `nextFireAt` 一致）、`DiaryDate`、`ResolveLocal`、`AddDays` | 无 |
| `notifications` | 新增 | **纯领域逻辑，零 DB 依赖**：`ReminderKind`、`ComputeNextFire`、`ReminderLocalDate`、`ShouldSkipForCompletion`、`ReminderPayload`、`NormalizeLocalTime`、`ApplyQuietHours` | `schedule` |
| `vapid` | 新增 | `ResolveKeys(store)`：库里 `app_settings` 的 `vapid_keys`（JSON）→ 没有或非法则生成并写回 | `webpush-go` |
| `push` | 新增 | `Sender` 接口 + `webpush-go` 适配器 + `ClassifyResult`（纯函数，三态分类） | `webpush-go` |
| `scheduler` | 新增 | `RunDue(deps)`：一次 tick 的全部逻辑，测试可直接调用，不依赖 cron | `notifications`、`push`、`store` |
| `store` | 扩展 | 排程读写、幂等占位/收尾、订阅 CRUD、发送结果回写 | PocketBase |
| `api` | 扩展 | `notifications.go`：5 条路由；修 `renderSettings` 的硬编码 `nil` | `store`、`vapid` |
| `app` | 扩展 | 启动时解析 VAPID 密钥、构造 sender、注册 cron | 全部 |

分层理由：`notifications` 不含 `core.App` 与 SQL，因此时区/DST/跨午夜/推迟上限这些最易错的分支可以做纯函数级穷举测试；`scheduler` 用假 `Sender` + PocketBase test app 做集成测试。

## 4. 数据流

每分钟一次 tick：

```
app.Cron() 每分钟 → scheduler.RunDue
  ├─ 清理宽限期到期的 pending_deletion 账号（搭车，不另开定时任务）
  └─ ListDueSchedules(now, 200)          ← 走 idx_reminder_schedule_due
       每个用户单独 try/catch（一个账号的脏数据不能拖死整轮）
       ├─ user.status != "active"        → 排程置 null，停止打扰
       ├─ 静默时段（仅当该 (user, local_date, kind) 还没有投递记录时才评估，
       │   已经在重试中的提醒不被重复推迟）
       │     defer → 把 next_fire_at 推到窗口结束（复用同一幂等键，不新开状态）
       │     skip  → 写一条 skipped 并推进排程，当天不再打扰
       ├─ BeginDelivery 幂等占位           ← UNIQUE(user, local_date, kind) 已在库里
       ├─ 「仅未完成时提醒」发送前复查内容（与今日页同一套派生规则）
       ├─ 发给该用户全部 enabled 订阅 → 逐条 RecordPushResult
       └─ Advance：用 NextFireAt 重算（严格大于 now）
```

## 5. 对外契约

逐字段对齐 `source/web/src/lib/api.ts`。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `POST /v1/notifications/subscriptions` | `{endpoint, keys:{p256dh,auth}, label, platform}` | `{subscription:{id}}` |
| `GET /v1/notifications/subscriptions` | — | `{subscriptions:[…]}` |
| `PATCH /v1/notifications/subscriptions/:id` | `{enabled}` | `{subscription:{id,label,platform,enabled,created_at,failure_count}}` |
| `DELETE /v1/notifications/subscriptions/:id` | — | `204` |
| `GET /v1/notifications/status` | — | `{vapid_public_key, push_configured, subscriptions[], recent_deliveries[{local_date,kind,status,attempts,last_error}], reminders{morning_time,evening_time}}` |

`/v1/settings` 的 `push` 段：`{vapid_public_key: string|null, subscriptions: number}`——`vapid_public_key` 必须返回真实公钥（当前恒为 `null`）。

字段细节（均取自 Node 版实现，不自行发明）：

- `recent_deliveries` 取**最近 10 条**（Node 版 `listReminderDeliveries(userId, 10)`）。
- `push_configured` = 是否成功解析出 VAPID 密钥。Go 版不使用环境变量注入密钥，正常启动后**恒为 `true`**；`vapid_public_key` 与它同源。
- `platform` 允许值：`web` / `ios-pwa` / `android`（与 schema 的 `SelectField` 白名单一致）；`label` 超长截断到 40 字符（客户端 `SUBSCRIPTION_LABEL_MAX` 同名常量）。
- `GET /v1/notifications/subscriptions` 返回 `{subscriptions:[…]}`（Node 版同形）。

**越权**：`PATCH` / `DELETE` 他人订阅一律返回 **404**——「不存在」与「不属于本人」刻意不区分，避免泄露该订阅是否存在（Node 版注释即为「不属于当前用户或不存在 → 404」）。

**VAPID subject**：把当前未被使用的 `Config.VAPIDSubject` 接进密钥解析（它作为 VAPID JWT 的 `sub`）。默认值沿用 Go 侧现有的 `https://daybook.local`，**刻意不改成** Node 的 `mailto:noreply@localhost`：`https:` 形式合法，且该默认值已写在 `deploy/daybook.env.example` 里文档化。要完全对齐 Node 版再说。

## 6. 关键取舍（与 Node 版的刻意差异）

- **D1 — 401/403 的处理（已决策：立即禁用）**：Node 版把 401/403 归入 `failed`（设计初稿称「Node 会永久空转重试」是误读——`db/notification-store.ts` 的 `failed` 分支同样会在 10 次后自动禁用）。Go 版**刻意不跟**：401/403 与 404/410 同归 `gone`，收到就立刻写 `disabled_at`。理由是这类失败**永远不会自愈**（VAPID 密钥跟这条订阅不是同一对，典型成因是数据卷被重建），继续重试只会每天刷失败日志；代价是一次异常 403（如 CDN 抖动）会踢掉一条本来还能用的订阅——而这是用户重新订阅就能修好的，比「每天静默失败、日志越刷越吵」便宜。
- **D2 — 调度载体**：Node 用进程内 `setInterval`；Go 版用 PocketBase 自带的 `app.Cron()`，跟着 app 生命周期起停。另加一把进程内互斥锁防 tick 重叠；**一致性仍由 `UNIQUE(user, local_date, kind)` 保证，不依赖锁**。
- **D3 — `reminder_schedule.locked_at` 不使用**：Node 版从未写这个字段（已核对源码），它是 schema 预留。Go 版同样不写，靠唯一索引保证幂等。该字段将保持为空。

## 7. 韧性规则与常量

沿用 Node 版被生产验证过的数值，不自行发明：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `MAX_ATTEMPTS` | 3 | 投递失败不推进排程，下一分钟自然重试；到上限才放弃并推进 |
| `DUE_BATCH` | 200 | 单次 tick 处理的到期排程上限 |
| `FAILURE_LIMIT` | 10 | 订阅连续失败到此次数即自动禁用 |
| `MAX_DEFER_MS` | 12h | 静默时段推迟上限，超过则不发送（记 `skipped`） |
| 推送 TTL | 12h | 与 Node 版相同，够覆盖「当天送达」 |

其他规则：

- 配置类问题（未解析出 VAPID 密钥、该用户没有可用订阅）→ 记 `failed` 并**直接推进**排程，重试没有意义。
- 静默时段的推迟不得越过该条目所属日记日的下一个日界。
- 连续失败但仍有可用订阅 → 不推进，下一 tick 再试。

## 8. 测试策略

**纯函数**（`notifications`、`push`）

- `ApplyQuietHours`：窗口不跨午夜、跨午夜、恰好等于端点（半开区间 `[start, end)`）、12 小时推迟上限、越过下一个日界、非 `HH:MM` 入参报错、`enabled=false` 直接放行。
- `NextFireAt` / `ComputeNextFire`：**DST 春季跳变**（不存在的本地时刻）与**秋季重叠**、日界 04:00 前后的归属、今天已过则明天、关闭提醒返回 `null`。
- `ShouldSkipForCompletion`：早间看「今天的计划」、晚间看「今天的总结」；空白串不算已填。
- `ClassifyResult`：200/201/202 → `sent`；404/410 → `gone`；401/403 → 永久失败；传输层错误（DNS/TLS/超时/密钥解码）→ 可重试；5xx → 可重试。

**集成**（假 `Sender` + PocketBase test app）

- 幂等：同一 `(user, local_date, kind)` 重复 tick 只产生一次发送。
- 重试：失败不推进，`attempts` 到 3 才放弃。
- 禁用：`failure_count` 到 10 自动禁用；`gone` 立即禁用。
- 静默时段：`defer` 把 `next_fire_at` 推到窗口结束；`skip` 当天不再打扰。
- `status != active` 的用户排程置 `null`。
- 韧性地隔离：某用户脏数据（如手工改坏的时区）抛错不影响同轮其他用户。

**契约**（复用现有 `run` / `assertSingleBody` 的 ApiScenario）

- 5 条路由的成功路径与字段逐一比对 `api.ts`。
- 未登录 → 401；`PATCH` / `DELETE` 他人订阅 → **404**（与「不存在」同形，不泄露存在性）。
- `/v1/settings` 的 `vapid_public_key` 非 `null`。

**容器级**（WSL Docker，已有可用工具链）

- 构建镜像 → 起容器 → 登录 → `GET /v1/settings` 拿到非空 `vapid_public_key` → `POST` 一条假订阅 → `GET /v1/notifications/status` 能看到它。

## 9. 验收标准

1. `go build ./...`、`go vet ./...`、`go test -count=1 ./...` 全绿。
2. `npm run typecheck` 与 `npm test`（`source/`）保持全绿——前端未改，不应回归。
3. 上述 5 条路由的契约测试通过，字段与 `api.ts` 一致。
4. `/v1/settings` 与 `/v1/notifications/status` 返回非空 `vapid_public_key` 且 `push_configured == true`；重启容器后公钥**不变**（证明密钥已持久化而非每次重生成）。
5. 容器级冒烟：登录 → 取设置 → 注册假订阅 → 状态接口可见。

## 10. 风险

| 风险 | 缓解 |
| --- | --- |
| DST 边界算错导致提醒偏差一小时 | `schedule.NextFireAt` 复用已有实现（Node 行为对齐）并补 DST 专项测试 |
| `webpush-go` 不校验状态码，分类写错会把永久失败当临时失败 | 分类是纯函数，穷举状态码单测；D1 专门覆盖 401/403 |
| cron 与 HTTP 请求并发读写同一条记录 | tick 内互斥 + 数据库唯一索引兜底 |
| 首次启动生成密钥的时机与静态托管/cron 注册顺序耦合 | 密钥解析放在启动钩子内、cron 注册之前；用「重启后公钥不变」验收（§9.4） |
| 集合字段名与 Node 版有细微差别导致查询写错 | 已核对（`202609130001_initial_schema.go`）：`push_subscriptions` 有 `failure_count`/`disabled_at`/`last_seen_at`/`last_success_at`；`reminder_schedule` 有 `kind`/`next_fire_at`，唯一键 `idx_reminder_schedule_user_kind(user, kind)`；`notification_deliveries` 有 `local_date`/`attempts`/`last_error`，唯一键 `idx_notification_deliveries_key(user, local_date, kind)`。写每条查询前仍逐字段确认一次 |

## 11. 顺带修正

`source/web/public/sw.js:7` 的注释仍写着「触发 Web Push 的部分在阶段 3 接」，但 `push` / `notificationclick` 处理早已实现在第 52 行起。本次一并改掉（纯注释，不改行为）。
