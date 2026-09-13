package auth

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
)

var purgeNow = time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)

func newPurgeApp(t *testing.T) *tests.TestApp {
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

func newPurgeUser(t *testing.T, app *tests.TestApp, username string, status string, requestedAt *time.Time) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", username)
	record.Set("status", status)
	record.SetPassword("correct-horse-battery")
	if requestedAt != nil {
		record.Set("deletion_requested_at", requestedAt.UTC())
	}
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号失败：%v", err)
	}
	return record
}

func userExists(t *testing.T, app *tests.TestApp, id string) bool {
	t.Helper()
	if _, err := app.FindRecordById("users", id); err != nil {
		return false
	}
	return true
}

func TestPurgeExpiredAccountsOnlyRemovesPastGrace(t *testing.T) {
	app := newPurgeApp(t)
	defer app.Cleanup()

	overdue := purgeNow.Add(-(GraceDays + 1) * 24 * time.Hour)
	within := purgeNow.Add(-(GraceDays - 1) * 24 * time.Hour)

	expired := newPurgeUser(t, app, "expired", "pending_deletion", &overdue)
	fresh := newPurgeUser(t, app, "fresh", "pending_deletion", &within)
	// 没有申请时间：脏数据，按"未过期"处理，不能删（Node 版 SQL 的 IS NOT NULL）
	noTimestamp := newPurgeUser(t, app, "no-timestamp", "pending_deletion", nil)
	// 状态不是 pending_deletion：申请时间再旧也不删
	active := newPurgeUser(t, app, "active", "active", &overdue)

	purged, err := PurgeExpiredAccounts(app, purgeNow)
	if err != nil {
		t.Fatalf("清理失败：%v", err)
	}
	if purged != 1 {
		t.Fatalf("应只删 1 个账号，得到 %d", purged)
	}
	if userExists(t, app, expired.Id) {
		t.Fatal("过了宽限期的待删除账号应被删除")
	}
	for _, record := range []*core.Record{fresh, noTimestamp, active} {
		if !userExists(t, app, record.Id) {
			t.Fatalf("账号 %s 不该被删除", record.GetString("username"))
		}
	}
}

func TestPurgeExpiredAccountsIsIdempotent(t *testing.T) {
	app := newPurgeApp(t)
	defer app.Cleanup()

	overdue := purgeNow.Add(-(GraceDays + 2) * 24 * time.Hour)
	newPurgeUser(t, app, "expired", "pending_deletion", &overdue)

	first, err := PurgeExpiredAccounts(app, purgeNow)
	if err != nil {
		t.Fatalf("首次清理失败：%v", err)
	}
	if first != 1 {
		t.Fatalf("首次应删 1 个，得到 %d", first)
	}
	second, err := PurgeExpiredAccounts(app, purgeNow)
	if err != nil {
		t.Fatalf("二次清理失败：%v", err)
	}
	if second != 0 {
		t.Fatalf("二次不该再删任何账号，得到 %d", second)
	}
}
