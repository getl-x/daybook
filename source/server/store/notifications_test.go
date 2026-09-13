package store

import (
	"testing"
	"time"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
	"github.com/getl-x/daybook/source/server/notifications"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

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

func TestAppSettingRoundTrip(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()

	if _, found, err := GetAppSetting(app, "missing"); err != nil || found {
		t.Fatalf("不存在的键应返回 found=false，得到 found=%v err=%v", found, err)
	}
	if err := SetAppSetting(app, "k", "v1"); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if err := SetAppSetting(app, "k", "v2"); err != nil {
		t.Fatalf("覆盖写入失败：%v", err)
	}
	got, found, err := GetAppSetting(app, "k")
	if err != nil || !found {
		t.Fatalf("读回失败：found=%v err=%v", found, err)
	}
	if got != "v2" {
		t.Fatalf("期望覆盖后的 v2，得到 %q", got)
	}
}

func TestScheduleLifecycleAndDueListing(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	now := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	if err := SetSchedule(app, user.Id, notifications.KindMorning, &now); err != nil {
		t.Fatalf("写入排程失败：%v", err)
	}
	// 幂等覆盖：同一 (user, kind) 只应有一行
	later := now.Add(time.Minute)
	if err := SetSchedule(app, user.Id, notifications.KindMorning, &later); err != nil {
		t.Fatalf("覆盖排程失败：%v", err)
	}

	due, err := ListDueSchedules(app, now.Add(2*time.Hour), 10)
	if err != nil {
		t.Fatalf("列出到期排程失败：%v", err)
	}
	if len(due) != 1 {
		t.Fatalf("同一 (user, kind) 应只占一行，期望 1 条到期，得到 %d 条", len(due))
	}
	if due[0].Kind != notifications.KindMorning {
		t.Errorf("期望 morning，得到 %s", due[0].Kind)
	}

	// 还没到就不该列为到期
	due, err = ListDueSchedules(app, now, 10)
	if err != nil {
		t.Fatalf("列出失败：%v", err)
	}
	if len(due) != 0 {
		t.Fatalf("未到期不应出现，得到 %d 条", len(due))
	}

	// 置 nil 表示关闭
	if err := SetSchedule(app, user.Id, notifications.KindMorning, nil); err != nil {
		t.Fatalf("关闭排程失败：%v", err)
	}
	due, err = ListDueSchedules(app, now.Add(48*time.Hour), 10)
	if err != nil {
		t.Fatalf("列出失败：%v", err)
	}
	if len(due) != 0 {
		t.Fatalf("关闭后不该有到期，得到 %d 条", len(due))
	}
}

func TestListDueSchedulesHonorsLimitAndOrder(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	alice := newUser(t, app, "alice")
	bob := newUser(t, app, "bob")

	early := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	late := time.Date(2026, 9, 13, 2, 0, 0, 0, time.UTC)
	if err := SetSchedule(app, alice.Id, notifications.KindMorning, &late); err != nil {
		t.Fatal(err)
	}
	if err := SetSchedule(app, bob.Id, notifications.KindMorning, &early); err != nil {
		t.Fatal(err)
	}

	due, err := ListDueSchedules(app, time.Date(2026, 9, 13, 3, 0, 0, 0, time.UTC), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 2 {
		t.Fatalf("期望 2 条到期，得到 %d 条", len(due))
	}
	if !due[0].NextFireAt.Before(due[1].NextFireAt) {
		t.Error("到期排程应按触发时刻升序")
	}

	due, err = ListDueSchedules(app, time.Date(2026, 9, 13, 3, 0, 0, 0, time.UTC), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 {
		t.Fatalf("limit 应为 1，得到 %d 条", len(due))
	}
}

func TestBeginDeliveryIsIdempotent(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	first, err := BeginDelivery(app, user.Id, "2026-09-13", notifications.KindMorning)
	if err != nil {
		t.Fatalf("首次占位失败：%v", err)
	}
	if !first {
		t.Fatal("首次占位应返回 true")
	}
	second, err := BeginDelivery(app, user.Id, "2026-09-13", notifications.KindMorning)
	if err != nil {
		t.Fatalf("重复占位不该报错：%v", err)
	}
	if second {
		t.Fatal("重复占位应返回 false（唯一键已存在）")
	}

	// 日期字段的 set 与 filter 必须落在同一个瞬间，否则读不回来
	state, err := GetDelivery(app, user.Id, "2026-09-13", notifications.KindMorning)
	if err != nil {
		t.Fatalf("读投递记录失败：%v", err)
	}
	if state == nil {
		t.Fatal("刚占位的记录应当能读回——日期过滤条件没对上")
	}
	if state.Status != "pending" || state.Attempts != 0 {
		t.Fatalf("期望 pending/0，得到 %s/%d", state.Status, state.Attempts)
	}

	// 另一种 kind 是另一条记录
	other, err := BeginDelivery(app, user.Id, "2026-09-13", notifications.KindEvening)
	if err != nil {
		t.Fatal(err)
	}
	if !other {
		t.Fatal("不同 kind 应是新记录")
	}
}

func TestFinishDeliveryAccumulatesAttempts(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	if _, err := BeginDelivery(app, user.Id, "2026-09-13", notifications.KindMorning); err != nil {
		t.Fatal(err)
	}
	if err := FinishDelivery(app, user.Id, "2026-09-13", notifications.KindMorning, "failed", "HTTP 503"); err != nil {
		t.Fatalf("收尾失败：%v", err)
	}
	state, err := GetDelivery(app, user.Id, "2026-09-13", notifications.KindMorning)
	if err != nil {
		t.Fatal(err)
	}
	if state.Attempts != 1 || state.Status != "failed" || state.LastError != "HTTP 503" {
		t.Fatalf("期望 failed/1/HTTP 503，得到 %s/%d/%s", state.Status, state.Attempts, state.LastError)
	}
}

func TestListDeliveriesReturnsNewestFirstAndTruncates(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	for _, date := range []string{"2026-09-11", "2026-09-13", "2026-09-12"} {
		if _, err := BeginDelivery(app, user.Id, date, notifications.KindMorning); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := ListDeliveries(app, user.Id, 2)
	if err != nil {
		t.Fatalf("列出投递失败：%v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("limit 应为 2，得到 %d 条", len(rows))
	}
	if rows[0].LocalDate != "2026-09-13" {
		t.Fatalf("应按日期倒序，首条期望 2026-09-13，得到 %s", rows[0].LocalDate)
	}
}

func TestRecordPushResultDisablesAtFailureLimit(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1",
		P256dh:   "p256dh-value",
		Auth:     "auth-value",
		Label:    "iPhone · Safari",
		Platform: "ios-pwa",
	})
	if err != nil {
		t.Fatalf("写入订阅失败：%v", err)
	}

	at := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	for i := 0; i < FailureLimit-1; i++ {
		if err := RecordPushResult(app, id, "failed", at); err != nil {
			t.Fatalf("记录失败：%v", err)
		}
	}
	enabled, err := ListSubscriptions(app, user.Id, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enabled) != 1 {
		t.Fatalf("未达上限不该禁用，得到 %d 条启用订阅", len(enabled))
	}

	if err := RecordPushResult(app, id, "failed", at); err != nil {
		t.Fatalf("记录失败：%v", err)
	}
	enabled, err = ListSubscriptions(app, user.Id, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enabled) != 0 {
		t.Fatalf("达到 %d 次失败应自动禁用", FailureLimit)
	}
}

func TestRecordPushResultSentResetsCounter(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		if err := RecordPushResult(app, id, "failed", at); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecordPushResult(app, id, "sent", at); err != nil {
		t.Fatal(err)
	}
	record, err := app.FindRecordById("push_subscriptions", id)
	if err != nil {
		t.Fatalf("读回订阅失败：%v", err)
	}
	if got := record.GetInt("failure_count"); got != 0 {
		t.Fatalf("成功发送应清零计数，得到 %d", got)
	}
	if record.GetDateTime("last_success_at").IsZero() {
		t.Error("成功发送应记录 last_success_at")
	}
}

func TestGoneDisablesImmediately(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordPushResult(app, id, "gone", time.Now()); err != nil {
		t.Fatal(err)
	}
	enabled, err := ListSubscriptions(app, user.Id, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enabled) != 0 {
		t.Fatal("gone 应立即禁用")
	}
}

func TestUpsertSubscriptionRefreshesInsteadOfDuplicating(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	first, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/same", P256dh: "p1", Auth: "a1",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/same", P256dh: "p2", Auth: "a2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("同一 endpoint 应复用同一行：%s vs %s", first, second)
	}
	all, err := ListSubscriptions(app, user.Id, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("同一 endpoint 不该产生第二行，得到 %d 行", len(all))
	}
	if all[0].P256dh != "p2" {
		t.Errorf("重新上报应刷新密钥，得到 %s", all[0].P256dh)
	}
}

func TestUpsertReenablesDisabledSubscription(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordPushResult(app, id, "gone", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	}); err != nil {
		t.Fatal(err)
	}
	enabled, err := ListSubscriptions(app, user.Id, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enabled) != 1 {
		t.Fatal("重新上报订阅应恢复启用（否则设备再也没法用）")
	}
}

func TestSubscriptionMutationsAreScopedToOwner(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	alice := newUser(t, app, "alice")
	bob := newUser(t, app, "bob")

	id, err := UpsertSubscription(app, alice.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/alice", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := SetSubscriptionEnabled(app, bob.Id, id, false)
	if err != nil {
		t.Fatalf("越权操作不该报错，只该失败：%v", err)
	}
	if ok {
		t.Fatal("Bob 不该能操作 Alice 的订阅")
	}
	ok, err = DeleteSubscription(app, bob.Id, id)
	if err != nil {
		t.Fatalf("越权删除不该报错：%v", err)
	}
	if ok {
		t.Fatal("Bob 不该能删 Alice 的订阅")
	}
	all, err := ListSubscriptions(app, alice.Id, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatal("Alice 的订阅不应被 Bob 影响")
	}

	// 不存在的 id 同样返回 false，且不报错
	ok, err = DeleteSubscription(app, alice.Id, "nonexistentid00")
	if err != nil {
		t.Fatalf("删除不存在的订阅不该报错：%v", err)
	}
	if ok {
		t.Fatal("不存在的订阅应返回 false")
	}
}

func TestSetSubscriptionEnabledToggles(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := SetSubscriptionEnabled(app, user.Id, id, false); err != nil || !ok {
		t.Fatalf("停用失败：ok=%v err=%v", ok, err)
	}
	if enabled, _ := ListSubscriptions(app, user.Id, true); len(enabled) != 0 {
		t.Fatal("停用后不该出现在启用列表里")
	}
	if ok, err := SetSubscriptionEnabled(app, user.Id, id, true); err != nil || !ok {
		t.Fatalf("重新启用失败：ok=%v err=%v", ok, err)
	}
	if enabled, _ := ListSubscriptions(app, user.Id, true); len(enabled) != 1 {
		t.Fatal("重新启用后应回到启用列表")
	}
}

// 订阅的"加入日期"必须真的落库：Node 版是 created_at NOT NULL DEFAULT now()，
// 设置页拿它显示设备时间（SettingsPage.tsx 的 created_at.slice(0, 10)）。
func TestUpsertSubscriptionStampsCreatedAtOnce(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	id, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	})
	if err != nil {
		t.Fatal(err)
	}

	record, err := app.FindRecordById("push_subscriptions", id)
	if err != nil {
		t.Fatal(err)
	}
	first := record.GetDateTime("created_at").Time()
	if first.IsZero() {
		t.Fatal("created_at 不该是零值——设置页会把它显示成 0001-01-01")
	}

	// 重新上报：密钥与 last_seen_at 刷新，但 created_at 保持不变
	if _, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p2", Auth: "a2",
	}); err != nil {
		t.Fatal(err)
	}
	record, err = app.FindRecordById("push_subscriptions", id)
	if err != nil {
		t.Fatal(err)
	}
	if got := record.GetDateTime("created_at").Time(); !got.Equal(first) {
		t.Fatalf("重新上报不该改 created_at：%s -> %s", first, got)
	}
	if record.GetString("p256dh") != "p2" {
		t.Fatal("重新上报应刷新密钥")
	}
}

func TestCountActiveSubscriptions(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()
	user := newUser(t, app, "alice")

	if count, err := CountActiveSubscriptions(app, user.Id); err != nil || count != 0 {
		t.Fatalf("初始应为 0，得到 %d (err=%v)", count, err)
	}
	if _, err := UpsertSubscription(app, user.Id, SubscriptionInput{
		Endpoint: "https://push.example.com/1", P256dh: "p", Auth: "a",
	}); err != nil {
		t.Fatal(err)
	}
	if count, err := CountActiveSubscriptions(app, user.Id); err != nil || count != 1 {
		t.Fatalf("期望 1，得到 %d (err=%v)", count, err)
	}
}
