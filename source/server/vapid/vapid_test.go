package vapid

import (
	"encoding/json"
	"testing"

	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/pocketbase/tests"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
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

// storedJSON 读回落库的原始 JSON，用来核对字段名与 Node 版一致。
func storedJSON(t *testing.T, app *tests.TestApp) map[string]string {
	t.Helper()
	raw, found, err := store.GetAppSetting(app, SettingKey)
	if err != nil {
		t.Fatalf("读取 app_settings 失败：%v", err)
	}
	if !found {
		t.Fatalf("app_settings 里应有 %s", SettingKey)
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("落库内容不是合法 JSON：%q", raw)
	}
	return parsed
}

func TestResolveKeysGeneratesAndPersists(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()

	first, err := ResolveKeys(app, "")
	if err != nil {
		t.Fatalf("首次解析失败：%v", err)
	}
	if first.PublicKey == "" || first.PrivateKey == "" {
		t.Fatalf("生成的密钥不应为空：%+v", first)
	}

	// 落库形状必须与 Node 版逐字一致，否则同一份 app_settings 无法互换
	parsed := storedJSON(t, app)
	if len(parsed) != 2 {
		t.Fatalf("落库应只有 publicKey/privateKey 两个键，得到 %v", parsed)
	}
	if parsed["publicKey"] != first.PublicKey || parsed["privateKey"] != first.PrivateKey {
		t.Fatalf("落库内容与返回值不一致：%v vs %+v", parsed, first)
	}

	// 第二次必须读回同一对（幂等复用），否则每次重启都会让全部订阅失效
	second, err := ResolveKeys(app, "")
	if err != nil {
		t.Fatalf("二次解析失败：%v", err)
	}
	if second.PublicKey != first.PublicKey || second.PrivateKey != first.PrivateKey {
		t.Fatalf("第二次应复用同一对密钥：%+v vs %+v", second, first)
	}
}

func TestResolveKeysRegeneratesOnInvalidJSON(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()

	if err := store.SetAppSetting(app, SettingKey, "{ not json"); err != nil {
		t.Fatalf("预置脏数据失败：%v", err)
	}

	keys, err := ResolveKeys(app, "")
	if err != nil {
		t.Fatalf("脏数据不该让解析报错：%v", err)
	}
	if keys.PublicKey == "" || keys.PrivateKey == "" {
		t.Fatalf("应重新生成一对密钥：%+v", keys)
	}

	// 覆盖后的内容必须是合法 JSON，且等于返回值
	parsed := storedJSON(t, app)
	if parsed["publicKey"] != keys.PublicKey || parsed["privateKey"] != keys.PrivateKey {
		t.Fatalf("应把重新生成的密钥覆盖写入：%v vs %+v", parsed, keys)
	}
}

func TestResolveKeysRegeneratesWhenStoredKeysIncomplete(t *testing.T) {
	app := newApp(t)
	defer app.Cleanup()

	// 合法 JSON 但密钥为空/缺字段，同样算不可用
	if err := store.SetAppSetting(app, SettingKey, `{"publicKey":"","privateKey":"only-private"}`); err != nil {
		t.Fatalf("预置脏数据失败：%v", err)
	}

	keys, err := ResolveKeys(app, "")
	if err != nil {
		t.Fatalf("不完整的密钥不该让解析报错：%v", err)
	}
	if keys.PublicKey == "" || keys.PrivateKey == "" {
		t.Fatalf("应重新生成一对密钥：%+v", keys)
	}
	if keys.PrivateKey == "only-private" {
		t.Fatal("旧的残缺密钥不该被沿用")
	}
}

func TestSubjectOrDefault(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"空串回落默认值", "", DefaultSubject},
		{"全空白回落默认值", "   ", DefaultSubject},
		{"原样返回", "mailto:ops@example.com", "mailto:ops@example.com"},
		{"去掉两端空白", "  mailto:ops@example.com  ", "mailto:ops@example.com"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := SubjectOrDefault(testCase.input); got != testCase.want {
				t.Fatalf("期望 %q，得到 %q", testCase.want, got)
			}
		})
	}
}
