package app

import (
	"testing"

	// 触发 migrations 包注册（与 main.go 里同一手法）。
	_ "github.com/getl-x/daybook/source/server/migrations"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// 迁移必须真的建出全部集合。Node 版这些表由 SQL 迁移建，
// 换成 PocketBase 后由 Go 迁移建——这个测试是两者的等价性检查点。
func TestInitialMigrationCreatesEveryCollection(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}

	expected := []string{
		"users",
		"user_settings",
		"daily_entries",
		"incidents",
		"push_subscriptions",
		"reminder_schedule",
		"notification_deliveries",
		"app_settings",
	}
	for _, name := range expected {
		if _, err := app.FindCollectionByNameOrId(name); err != nil {
			t.Errorf("集合 %s 不存在：%v", name, err)
		}
	}
}

// "注册关闭，账号只能由管理员侧添加"这条设计取舍，在 PocketBase 上的落点是
// users 集合的 create 规则为空——任何客户端都无法自助建号。
func TestRegistrationIsClosed(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	if users.CreateRule != nil {
		t.Error("users.CreateRule 必须为 nil，否则等于开放了注册")
	}
	if users.DeleteRule != nil {
		t.Error("users.DeleteRule 必须为 nil，删号只走管理员侧")
	}
	if !users.PasswordAuth.Enabled {
		t.Error("密码登录必须开启")
	}
	if len(users.PasswordAuth.IdentityFields) != 1 || users.PasswordAuth.IdentityFields[0] != "username" {
		t.Errorf("登录身份字段应为 [username]，得到 %v", users.PasswordAuth.IdentityFields)
	}

	// 客户端只能读写自己那一行。
	for label, rule := range map[string]*string{
		"list":   users.ListRule,
		"view":   users.ViewRule,
		"update": users.UpdateRule,
	} {
		if rule == nil || *rule != "id = @request.auth.id" {
			t.Errorf("users 的 %s 规则应为 'id = @request.auth.id'，得到 %v", label, rule)
		}
	}
}

// 用户名只允许小写：与 Node 版的 CHECK (username = lower(username)) 对齐，
// 从入口杜绝 "Getl" 与 "getl" 被当成两个账号。
func TestUsernameMustBeLowercase(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	field, ok := users.Fields.GetByName("username").(*core.TextField)
	if !ok {
		t.Fatalf("username 字段类型不对：%T", users.Fields.GetByName("username"))
	}
	if field.Pattern != `^[a-z0-9_-]{3,32}$` {
		t.Errorf("username 的校验正则 = %q，期望只允许小写字母/数字/下划线/连字符", field.Pattern)
	}

	// 只断言 pattern 是不够的：内置 users 集合本来就带一个宽松的 username 字段，
	// 如果迁移没有就地改掉它，正则再对也拦不住。这里真的存一条进去试试。
	makeUser := func(username string) *core.Record {
		record := core.NewRecord(users)
		record.Set("username", username)
		record.Set("password", "correct-horse-battery-staple")
		return record
	}

	if err := app.Save(makeUser("Getl")); err == nil {
		t.Error("大写用户名应当被拒绝，但存进去了")
	}
	if err := app.Save(makeUser("getl")); err != nil {
		t.Errorf("合法的小写用户名不该被拒绝：%v", err)
	}
	// 唯一性由 PocketBase 为身份字段自动维护的索引保证（迁移里刻意不再重复 AddIndex，
	// 否则会因索引定义重复而让整个迁移失败）。
	if err := app.Save(makeUser("getl")); err == nil {
		t.Error("重名账号应当被拒绝，但存进去了")
	}
}

// app_settings 是服务端的私有键值表（放 VAPID 密钥），客户端一律不可访问。
func TestAppSettingsIsServerOnly(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}

	collection, err := app.FindCollectionByNameOrId("app_settings")
	if err != nil {
		t.Fatalf("找不到 app_settings 集合：%v", err)
	}
	for label, rule := range map[string]*string{
		"list":   collection.ListRule,
		"view":   collection.ViewRule,
		"create": collection.CreateRule,
		"update": collection.UpdateRule,
		"delete": collection.DeleteRule,
	} {
		if rule != nil {
			t.Errorf("app_settings 的 %s 规则应为 nil，得到 %q", label, *rule)
		}
	}
}
