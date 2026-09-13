// Package testutil 是各包测试共用的脚手架（对应 LastDone 的 source/server/testutil）。
//
// 放在这里的东西有两个特点：多个包都要用，而且只有一份实现才不会漂。
// 尤其是"测试库必须拿到真实集合结构"这件事——它依赖 migrations 包的 init 注册，
// 少一个空导入就会是"集合不存在"那种极难看出原因的失败，所以由本包统一负责。
package testutil

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	// 各测试包因此不必再各自空导入一次。
	_ "github.com/getl-x/daybook/source/server/migrations"
)

// Password 是测试账号统一用的口令。
//
// 各包原来各写一份字面量，一旦有人改一处就会出现"这个包登录不上"的怪故障。
const Password = "correct-horse-battery"

// NewApp 建一个已经跑过迁移的测试应用。
//
// 刻意**不**在这里注册 cleanup：调用方保留自己的 `defer app.Cleanup()`。
// 让清理显式留在测试函数里，读代码时一眼能看出"这个 app 什么时候没了"，
// 也不至于出现"helper 悄悄注册了一次、测试又 defer 一次"的双重清理。
func NewApp(t testing.TB) *tests.TestApp {
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

// NewUser 建一个 status=active、口令为 Password 的账号。
func NewUser(t testing.TB, app core.App, username string) *core.Record {
	t.Helper()
	return NewUserWith(t, app, username, Password, "active")
}

// NewUserWith 是需要指定口令或状态时的入口（例如测"停用账号不能登录"）。
func NewUserWith(
	t testing.TB,
	app core.App,
	username string,
	password string,
	status string,
) *core.Record {
	t.Helper()

	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", username)
	record.Set("status", status)
	record.SetPassword(password)
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号失败：%v", err)
	}
	return record
}
