package scheduler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/getl-x/daybook/source/server/diary"
	"github.com/getl-x/daybook/source/server/notifications"
	"github.com/getl-x/daybook/source/server/push"
	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
)

// D1（web-push-design §6）：401/403 是永久失败，第一次收到就禁用，
// 不再靠 failure_count 熬到 10 次。这里从真实状态码出发走完整条链，
// 避免"分类改成 gone 了、调度器却还按可重试处理"这种两头不一致。
func TestRunDueDisablesOnUnauthorizedImmediately(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/rotated-keys")

	// 走真实分类函数，而不是手写 StatusGone
	sender := &fakeSender{status: push.ClassifyStatus(http.StatusUnauthorized).Status}
	report := RunDue(deps(app, sender))

	if report.DisabledSubscriptions != 1 {
		t.Fatalf("401 应在这一轮就禁用订阅，得到 %+v", report)
	}
	if report.Failed != 1 || report.Sent != 0 {
		t.Fatalf("期望 failed=1/sent=0，得到 %+v", report)
	}
	// 已无可用订阅 → 直接推进，不再重试
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("禁用后应推进，得到 %d 条仍到期", got)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("永久的 401 不该重试，只应尝试 1 次，得到 %d 次", len(sender.sent))
	}
}

// tickAt 是固定的 tick 时刻：2026-09-13 01:00Z = 09:00 Asia/Shanghai。
// 默认设置是 Asia/Shanghai + 日界 04:00 + 早间 09:00，所以这一刻正好是早间提醒。
var tickAt = time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)

// today 是 tickAt 所属的日记日。
const today = "2026-09-13"

func newApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}
	return app
}

func newUser(t *testing.T, app *tests.TestApp, username string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", username)
	record.Set("status", "active")
	record.SetPassword("correct-horse-battery")
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号失败：%v", err)
	}
	return record
}

func deps(app *tests.TestApp, sender push.Sender) Deps {
	return Deps{App: app, Sender: sender, Now: func() time.Time { return tickAt }}
}

/* ------------------------------ 假发送器 ------------------------------ */

type sentPush struct {
	endpoint string
	payload  []byte
}

type fakeSender struct {
	status  push.Status
	results map[string]push.Result
	sent    []sentPush
}

func (s *fakeSender) Send(_ context.Context, subscription push.Subscription, payload []byte) push.Result {
	s.sent = append(s.sent, sentPush{endpoint: subscription.Endpoint, payload: payload})
	if s.results != nil {
		if result, ok := s.results[subscription.Endpoint]; ok {
			return result
		}
	}
	status := s.status
	if status == "" {
		status = push.StatusSent
	}
	return push.Result{Status: status}
}

/* ------------------------------ 造数据 ------------------------------ */

func mustSchedule(t *testing.T, app *tests.TestApp, userID string, kind notifications.ReminderKind, at *time.Time) {
	t.Helper()
	if err := store.SetSchedule(app, userID, kind, at); err != nil {
		t.Fatalf("写入排程失败：%v", err)
	}
}

// dueMorning 把早间排程设成"已经到期"。
func dueMorning(t *testing.T, app *tests.TestApp, userID string) {
	t.Helper()
	at := tickAt.Add(-time.Minute)
	mustSchedule(t, app, userID, notifications.KindMorning, &at)
}

func mustSubscribe(t *testing.T, app *tests.TestApp, userID string, endpoint string) string {
	t.Helper()
	id, err := store.UpsertSubscription(app, userID, store.SubscriptionInput{
		Endpoint: endpoint,
		P256dh:   "p256dh-value",
		Auth:     "auth-value",
		Platform: "web",
	})
	if err != nil {
		t.Fatalf("写入订阅失败：%v", err)
	}
	return id
}

func setTimezone(t *testing.T, app *tests.TestApp, userID string, timezone string) {
	t.Helper()
	record, err := store.Ensure(app, userID)
	if err != nil {
		t.Fatalf("取设置行失败：%v", err)
	}
	record.Set("timezone", timezone)
	if err := app.Save(record); err != nil {
		t.Fatalf("写入时区失败：%v", err)
	}
}

func setStatus(t *testing.T, app *tests.TestApp, user *core.Record, status string) {
	t.Helper()
	user.Set("status", status)
	if err := app.Save(user); err != nil {
		t.Fatalf("写入账号状态失败：%v", err)
	}
}

// mustWritePlan 写今天的【计划】——用来触发"仅未完成时提醒"。
func mustWritePlan(t *testing.T, app *tests.TestApp, userID string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("daily_entries")
	if err != nil {
		t.Fatalf("找不到 daily_entries 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("entry_date", today)
	record.Set(string(diary.FieldDayPlan), "今天把提醒跑通")
	// updated_at 非空 = "写过"，与"从未写过"区分开（见 diary 包）
	record.Set(diary.FieldDayPlan.UpdatedAtColumn(), tickAt.Add(-time.Hour))
	if err := app.Save(record); err != nil {
		t.Fatalf("写入计划失败：%v", err)
	}
}

func dueCount(t *testing.T, app *tests.TestApp) int {
	t.Helper()
	due, err := store.ListDueSchedules(app, tickAt, DueBatch)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	return len(due)
}

/* ------------------------------ 用例 ------------------------------ */

func TestRunDueSendsAndAdvances(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/alice")

	sender := &fakeSender{}
	report := RunDue(deps(app, sender))

	if report.Due != 1 || report.Sent != 1 || report.Errors != 0 {
		t.Fatalf("期望 due=1/sent=1/errors=0，得到 %+v", report)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("应只发一次，得到 %d 次", len(sender.sent))
	}

	// 文案逐字段核对（sw.js 读的就是这几个键）
	var payload struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		URL   string `json:"url"`
		Tag   string `json:"tag"`
	}
	if err := json.Unmarshal(sender.sent[0].payload, &payload); err != nil {
		t.Fatalf("推送内容不是合法 JSON：%v", err)
	}
	want := notifications.ReminderPayload(notifications.KindMorning)
	if payload.Title != want.Title || payload.URL != want.URL || payload.Tag != want.Tag {
		t.Fatalf("推送内容与领域层不一致：%+v vs %+v", payload, want)
	}

	// 投递记录应落成 sent
	state, err := store.GetDelivery(app, user.Id, today, notifications.KindMorning)
	if err != nil {
		t.Fatalf("读投递记录失败：%v", err)
	}
	if state == nil || state.Status != "sent" {
		t.Fatalf("期望 status=sent，得到 %+v", state)
	}

	// 推进后不再到期：次日 09:00 Asia/Shanghai = 2026-09-14 01:00Z
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("推进后不该还有到期排程，得到 %d 条", got)
	}
	due, err := store.ListDueSchedules(app, tickAt.Add(24*time.Hour), DueBatch)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	if len(due) != 1 {
		t.Fatalf("期望次日到期 1 条，得到 %d 条", len(due))
	}
	wantNext := time.Date(2026, 9, 14, 1, 0, 0, 0, time.UTC)
	if !due[0].NextFireAt.Equal(wantNext) {
		t.Fatalf("下一次触发期望 %s，得到 %s", wantNext, due[0].NextFireAt)
	}
}

func TestRunDueReplaysFinishedDeliveryWithoutResending(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/alice")

	// 模拟"上一轮已发送成功、但推进排程之前进程退出"：排程仍到期，
	// 当天的投递已经落成 sent。
	if _, err := store.BeginDelivery(app, user.Id, today, notifications.KindMorning); err != nil {
		t.Fatalf("占位失败：%v", err)
	}
	if err := store.FinishDelivery(app, user.Id, today, notifications.KindMorning, "sent", ""); err != nil {
		t.Fatalf("收尾失败：%v", err)
	}

	sender := &fakeSender{}
	report := RunDue(deps(app, sender))

	if report.Replayed != 1 || report.Sent != 0 {
		t.Fatalf("期望 replayed=1/sent=0，得到 %+v", report)
	}
	if len(sender.sent) != 0 {
		t.Fatal("当天已发送过的提醒不该再发一次")
	}
	// 仍然要推进，否则这一行会永远到期、每分钟空转
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("replayed 之后也应推进，得到 %d 条仍到期", got)
	}
}

func TestRunDueRetriesUntilMaxAttempts(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/alice")

	sender := &fakeSender{status: push.StatusFailed}

	// 前 MaxAttempts 轮：每轮记一次 failed，且**不推进**（下一分钟自然重试）
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		report := RunDue(deps(app, sender))
		if report.Failed != 1 {
			t.Fatalf("第 %d 轮应记 1 次 failed，得到 %+v", attempt, report)
		}
		state, err := store.GetDelivery(app, user.Id, today, notifications.KindMorning)
		if err != nil {
			t.Fatalf("读投递记录失败：%v", err)
		}
		if state.Attempts != attempt {
			t.Fatalf("第 %d 轮 attempts 期望 %d，得到 %d", attempt, attempt, state.Attempts)
		}
		if got := dueCount(t, app); got != 1 {
			t.Fatalf("第 %d 轮失败后不该推进，仍应到期", attempt)
		}
	}

	// 到上限之后：放弃并推进，不再重发
	report := RunDue(deps(app, sender))
	if report.Replayed != 1 || report.Failed != 0 {
		t.Fatalf("到上限后应记 replayed，得到 %+v", report)
	}
	if len(sender.sent) != MaxAttempts {
		t.Fatalf("总共应只尝试 %d 次，得到 %d 次", MaxAttempts, len(sender.sent))
	}
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("放弃后应推进，得到 %d 条仍到期", got)
	}
}

func TestRunDueDisablesGoneSubscriptionAndAdvances(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/dead")

	sender := &fakeSender{status: push.StatusGone}
	report := RunDue(deps(app, sender))

	if report.DisabledSubscriptions != 1 {
		t.Fatalf("gone 应计入 disabledSubscriptions，得到 %+v", report)
	}
	if report.Failed != 1 || report.Sent != 0 {
		t.Fatalf("期望 failed=1/sent=0，得到 %+v", report)
	}

	// 订阅已被禁用
	enabled, err := store.ListSubscriptions(app, user.Id, true)
	if err != nil {
		t.Fatalf("列出订阅失败：%v", err)
	}
	if len(enabled) != 0 {
		t.Fatalf("失效订阅应被禁用，仍有 %d 条启用", len(enabled))
	}
	// 已无可用订阅 → 重试没有意义，直接推进
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("无可用订阅后应推进，得到 %d 条仍到期", got)
	}
}

func TestRunDueSkipsWhenPlanAlreadyWritten(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/alice")
	mustWritePlan(t, app, user.Id)

	sender := &fakeSender{}
	report := RunDue(deps(app, sender))

	if report.Skipped != 1 || report.Sent != 0 {
		t.Fatalf("计划已写时应记 skipped，得到 %+v", report)
	}
	if len(sender.sent) != 0 {
		t.Fatal("已完成的提醒不该发送")
	}
	state, err := store.GetDelivery(app, user.Id, today, notifications.KindMorning)
	if err != nil {
		t.Fatalf("读投递记录失败：%v", err)
	}
	if state == nil || state.Status != "skipped" {
		t.Fatalf("期望 status=skipped，得到 %+v", state)
	}
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("skip 之后应推进，得到 %d 条仍到期", got)
	}
}

func TestRunDueStopsRemindersForNonActiveUser(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")
	dueMorning(t, app, user.Id)
	mustSubscribe(t, app, user.Id, "https://push.example/alice")
	setStatus(t, app, user, "pending_deletion")

	sender := &fakeSender{}
	report := RunDue(deps(app, sender))

	if report.Due != 1 || report.Sent != 0 || report.Errors != 0 {
		t.Fatalf("期望 due=1/sent=0/errors=0，得到 %+v", report)
	}
	if len(sender.sent) != 0 {
		t.Fatal("待删除账号不该再收到提醒")
	}
	// 排程应被清空：既不再到期，也不是推迟
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("排程应被清空，得到 %d 条仍到期", got)
	}
	later, err := store.ListDueSchedules(app, tickAt.Add(365*24*time.Hour), DueBatch)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	if len(later) != 0 {
		t.Fatalf("排程应被清空（而不是推进），得到 %d 条", len(later))
	}
}

func TestRunDueIsolatesBrokenTimezone(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()

	// 脏数据用户：时区名不存在，settings.Location() 会报错
	broken := newUser(t, app, "broken")
	setTimezone(t, app, broken.Id, "Not/AZone")
	dueMorning(t, app, broken.Id)
	mustSubscribe(t, app, broken.Id, "https://push.example/broken")

	// 正常用户
	healthy := newUser(t, app, "healthy")
	dueMorning(t, app, healthy.Id)
	mustSubscribe(t, app, healthy.Id, "https://push.example/healthy")

	sender := &fakeSender{}
	report := RunDue(deps(app, sender))

	if report.Errors != 1 {
		t.Fatalf("脏时区应只记 1 次 error，得到 %+v", report)
	}
	if report.Sent != 1 {
		t.Fatalf("同一轮里正常用户仍应发出提醒，得到 %+v", report)
	}
	if len(sender.sent) != 1 || sender.sent[0].endpoint != "https://push.example/healthy" {
		t.Fatalf("应只发给正常用户，得到 %+v", sender.sent)
	}
}

func TestRescheduleUserWritesBothKinds(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	if err := RescheduleUser(app, user.Id, tickAt); err != nil {
		t.Fatalf("重算排程失败：%v", err)
	}

	// 默认早间 09:00、晚间 21:00（Asia/Shanghai）→ 一天内两条都会到期
	due, err := store.ListDueSchedules(app, tickAt.Add(24*time.Hour), DueBatch)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	if len(due) != 2 {
		t.Fatalf("应写入 2 条排程，得到 %d 条", len(due))
	}
	// 都还没到 tick 时刻
	if got := dueCount(t, app); got != 0 {
		t.Fatalf("重算出来的排程都在未来，不该到期，得到 %d 条", got)
	}

	// 幂等：再算一次仍是 2 条，不重复插行
	if err := RescheduleUser(app, user.Id, tickAt); err != nil {
		t.Fatalf("二次重算失败：%v", err)
	}
	due, err = store.ListDueSchedules(app, tickAt.Add(24*time.Hour), DueBatch)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	if len(due) != 2 {
		t.Fatalf("重算应幂等，得到 %d 条", len(due))
	}
}
