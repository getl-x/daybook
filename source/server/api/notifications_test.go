package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/getl-x/daybook/source/server/notifications"
	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

const (
	// 固定的公钥，只用来验证"值有没有被透出去"，不是可用密钥。
	testVAPIDPublicKey = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"
	// PocketBase 的记录 id 固定 15 位；这里写死是为了让场景的 URL 能提前确定。
	testSubscriptionID   = "sub000000000001"
	testOtherUserSubID   = "sub000000000002"
	testOtherUsername    = "someone-else"
	testSubscriptionPath = "/v1/notifications/subscriptions/" + testSubscriptionID
)

/* ------------------------------ 脚手架 ------------------------------ */

// registerTestRoutesWithVAPID 带上固定公钥注册路由：
// vapid_public_key / push_configured 都以它为准。
func registerTestRoutesWithVAPID(t testing.TB, app *tests.TestApp, event *core.ServeEvent) {
	publicKey := testVAPIDPublicKey
	RegisterRoutes(event, RouteConfig{
		AppVersion:      "test",
		DatabaseVersion: "test",
		VAPIDPublicKey:  &publicKey,
	})
}

func runWithVAPID(t *testing.T, scenario tests.ApiScenario) {
	runWith(t, registerTestRoutesWithVAPID, scenario)
}

func createUser(t testing.TB, app *tests.TestApp, username string) *core.Record {
	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", username)
	record.Set("status", "active")
	record.SetPassword(testPassword)
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号失败：%v", err)
	}
	return record
}

func authorize(t testing.TB, record *core.Record, headers map[string]string) {
	if headers == nil {
		return
	}
	token, err := record.NewAuthToken()
	if err != nil {
		t.Fatalf("签发令牌失败：%v", err)
	}
	headers["Authorization"] = "Bearer " + token
}

// seedSubscription 直接落一条订阅。id 写死，好让场景的 URL 提前拼出来。
func seedSubscription(t testing.TB, app *tests.TestApp, id string, userID string, endpoint string, disabled bool) {
	collection, err := app.FindCollectionByNameOrId("push_subscriptions")
	if err != nil {
		t.Fatalf("找不到 push_subscriptions 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Id = id
	record.Set("user", userID)
	record.Set("endpoint", endpoint)
	record.Set("p256dh", "test-p256dh")
	record.Set("auth", "test-auth")
	record.Set("label", "iPhone · Safari")
	record.Set("platform", "ios-pwa")
	// created_at 必须真的写进去：这条字段曾经在 PocketBase 侧整个漏掉，
	// 设置页因此显示成 0001-01-01（见 migrations/202609130004）。写死一个值
	// 让断言能精确比对，而不是只匹配 `"created_at":"` 这样的前缀。
	record.Set("created_at", time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC))
	if disabled {
		record.Set("disabled_at", time.Now().UTC())
	}
	if err := app.Save(record); err != nil {
		t.Fatalf("插入订阅失败：%v", err)
	}
}

func seedDelivery(t testing.TB, app *tests.TestApp, userID string, localDate string, kind notifications.ReminderKind, status string, lastError string) {
	if _, err := store.BeginDelivery(app, userID, localDate, kind); err != nil {
		t.Fatalf("占位失败：%v", err)
	}
	if err := store.FinishDelivery(app, userID, localDate, kind, status, lastError); err != nil {
		t.Fatalf("收尾失败：%v", err)
	}
}

// appForPush 建好"已登录的账号 + 它自己的订阅"。
func appForPush(headers map[string]string) func(t testing.TB) *tests.TestApp {
	return func(t testing.TB) *tests.TestApp {
		app := newApp(t)
		owner := createUser(t, app, testUsername)
		seedSubscription(t, app, testSubscriptionID, owner.Id, "https://push.example/one", false)
		authorize(t, owner, headers)
		return app
	}
}

// appForPushWithStranger 额外放一个别人的账号与订阅，用来验证越权返回 404。
func appForPushWithStranger(headers map[string]string) func(t testing.TB) *tests.TestApp {
	return func(t testing.TB) *tests.TestApp {
		app := newApp(t)
		owner := createUser(t, app, testUsername)
		seedSubscription(t, app, testSubscriptionID, owner.Id, "https://push.example/one", false)
		stranger := createUser(t, app, testOtherUsername)
		seedSubscription(t, app, testOtherUserSubID, stranger.Id, "https://push.example/two", false)
		authorize(t, owner, headers)
		return app
	}
}

/* ------------------------------ 上报订阅 ------------------------------ */

func TestSubscriptionCreateReturnsClientContractShape(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:   "上报订阅返回 subscription.id",
		Method: http.MethodPost,
		URL:    "/v1/notifications/subscriptions",
		Body: strings.NewReader(
			`{"endpoint":"https://push.example/new","keys":{"p256dh":"p","auth":"a"},` +
				`"label":"Windows · Chrome","platform":"web"}`),
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		// 前端 push.ts 只读 body.subscription.id 这一个键
		ExpectedContent: []string{`"subscription":{"id":"`},
		TestAppFactory:  appWithUserFactory(headers),
	})
}

func TestSubscriptionCreateValidates(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"缺 endpoint", `{"keys":{"p256dh":"p","auth":"a"}}`},
		{"缺 keys", `{"endpoint":"https://push.example/x"}`},
		{"keys 里缺 auth", `{"endpoint":"https://push.example/x","keys":{"p256dh":"p"}}`},
		{"platform 不在白名单", `{"endpoint":"https://push.example/x","keys":{"p256dh":"p","auth":"a"},"platform":"desktop"}`},
	}
	for _, testCase := range cases {
		headers := map[string]string{}
		runWithVAPID(t, tests.ApiScenario{
			Name:            testCase.name,
			Method:          http.MethodPost,
			URL:             "/v1/notifications/subscriptions",
			Body:            strings.NewReader(testCase.body),
			Headers:         headers,
			ExpectedStatus:  http.StatusBadRequest,
			ExpectedContent: []string{`"error":"invalid_field"`},
			TestAppFactory:  appWithUserFactory(headers),
		})
	}
}

func TestSubscriptionRoutesRequireAuth(t *testing.T) {
	cases := []struct {
		name   string
		method string
		url    string
		body   string
	}{
		{"上报订阅未登录", http.MethodPost, "/v1/notifications/subscriptions",
			`{"endpoint":"https://push.example/x","keys":{"p256dh":"p","auth":"a"}}`},
		{"订阅列表未登录", http.MethodGet, "/v1/notifications/subscriptions", ""},
		{"开关未登录", http.MethodPatch, testSubscriptionPath, `{"enabled":false}`},
		{"删除未登录", http.MethodDelete, testSubscriptionPath, ""},
		{"状态未登录", http.MethodGet, "/v1/notifications/status", ""},
	}
	for _, testCase := range cases {
		scenario := tests.ApiScenario{
			Name:            testCase.name,
			Method:          testCase.method,
			URL:             testCase.url,
			ExpectedStatus:  http.StatusUnauthorized,
			ExpectedContent: []string{`"error":"unauthorized"`},
			TestAppFactory:  plainAppFactory,
		}
		if testCase.body != "" {
			scenario.Body = strings.NewReader(testCase.body)
		}
		runWithVAPID(t, scenario)
	}
}

/* ------------------------------ 订阅列表 ------------------------------ */

func TestSubscriptionListReturnsDeviceShape(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:           "订阅列表返回 SubscriptionDevice 的全部字段",
		Method:         http.MethodGet,
		URL:            "/v1/notifications/subscriptions",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		// 逐字段对齐 api.ts 的 SubscriptionDevice
		ExpectedContent: []string{
			`"subscriptions":[{"id":"` + testSubscriptionID + `"`,
			`"label":"iPhone · Safari"`, `"platform":"ios-pwa"`,
			`"enabled":true`, `"created_at":"2026-09-13T01:00:00.000Z"`, `"failure_count":0`,
		},
		TestAppFactory: appForPush(headers),
	})
}

/* --------------------------- 单台设备开关 --------------------------- */

func TestSubscriptionPatchReturnsUpdatedDevice(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:           "开关返回更新后的订阅",
		Method:         http.MethodPatch,
		URL:            testSubscriptionPath,
		Body:           strings.NewReader(`{"enabled":false}`),
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"subscription":{"id":"` + testSubscriptionID + `"`,
			`"enabled":false`, `"failure_count":0`,
		},
		TestAppFactory: appForPush(headers),
	})
}

func TestSubscriptionPatchRequiresEnabledFlag(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:            "缺 enabled 返回 invalid_field",
		Method:          http.MethodPatch,
		URL:             testSubscriptionPath,
		Body:            strings.NewReader(`{}`),
		Headers:         headers,
		ExpectedStatus:  http.StatusBadRequest,
		ExpectedContent: []string{`"error":"invalid_field"`},
		TestAppFactory:  appForPush(headers),
	})
}

func TestSubscriptionPatchRejectsOtherUserWith404(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:   "改他人订阅返回 404（与不存在同形，不泄露存在性）",
		Method: http.MethodPatch,
		URL:    "/v1/notifications/subscriptions/" + testOtherUserSubID,
		Body:   strings.NewReader(`{"enabled":false}`),
		// 这里刻意用 404 而不是 403：403 会告诉攻击者"这条订阅是存在的"
		Headers:         headers,
		ExpectedStatus:  http.StatusNotFound,
		ExpectedContent: []string{`"error":"not_found"`},
		TestAppFactory:  appForPushWithStranger(headers),
	})
}

/* ------------------------------ 删除订阅 ------------------------------ */

func TestSubscriptionDeleteReturns204(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:           "删除自己的订阅返回 204",
		Method:         http.MethodDelete,
		URL:            testSubscriptionPath,
		Headers:        headers,
		ExpectedStatus: http.StatusNoContent,
		TestAppFactory: appForPush(headers),
	})
}

func TestSubscriptionDeleteRejectsOtherUserWith404(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:            "删他人订阅返回 404",
		Method:          http.MethodDelete,
		URL:             "/v1/notifications/subscriptions/" + testOtherUserSubID,
		Headers:         headers,
		ExpectedStatus:  http.StatusNotFound,
		ExpectedContent: []string{`"error":"not_found"`},
		TestAppFactory:  appForPushWithStranger(headers),
	})
}

/* ------------------------------ 推送状态 ------------------------------ */

func TestNotificationStatusReturnsClientContractShape(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:           "状态页返回 api.ts 的 NotificationStatus",
		Method:         http.MethodGet,
		URL:            "/v1/notifications/status",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"vapid_public_key":"` + testVAPIDPublicKey + `"`,
			`"push_configured":true`,
			`"subscriptions":[{"id":"` + testSubscriptionID + `"`,
			`"recent_deliveries":[{"local_date":"2026-09-13","kind":"morning","status":"sent","attempts":1,"last_error":null}`,
			`"reminders":{"morning_time":"09:00","evening_time":"21:00"}`,
		},
		TestAppFactory: func(t testing.TB) *tests.TestApp {
			app := newApp(t)
			owner := createUser(t, app, testUsername)
			seedSubscription(t, app, testSubscriptionID, owner.Id, "https://push.example/one", false)
			seedDelivery(t, app, owner.Id, "2026-09-13", notifications.KindMorning, "sent", "")
			authorize(t, owner, headers)
			return app
		},
	})
}

func TestNotificationStatusWithoutVAPIDKey(t *testing.T) {
	headers := map[string]string{}
	// 用不带公钥的注册方式：模拟"密钥没解析出来"，前端据此禁用开关
	run(t, tests.ApiScenario{
		Name:           "没有公钥时 push_configured 为 false",
		Method:         http.MethodGet,
		URL:            "/v1/notifications/status",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"vapid_public_key":null`, `"push_configured":false`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

/* --------------------------- 设置页的公钥 --------------------------- */

func TestSettingsExposeRealVAPIDPublicKey(t *testing.T) {
	headers := map[string]string{}
	runWithVAPID(t, tests.ApiScenario{
		Name:           "设置页返回真实公钥（之前恒为 null）",
		Method:         http.MethodGet,
		URL:            "/v1/settings",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"vapid_public_key":"` + testVAPIDPublicKey + `"`,
			`"subscriptions":0`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

func TestSettingsGetHealsReminderSchedule(t *testing.T) {
	headers := map[string]string{}
	scenario := tests.ApiScenario{
		Name:            "打开设置页会补上缺的排程行",
		Method:          http.MethodGet,
		URL:             "/v1/settings",
		Headers:         headers,
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{`"timezone":"Asia/Shanghai"`},
		TestAppFactory:  appWithUserFactory(headers),
	}
	scenario.BeforeTestFunc = registerTestRoutesWithVAPID
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		assertSingleBody(t, app, res)
		// 自愈应补上早晚各一条排程（默认 09:00 / 21:00）。
		schedules, err := app.FindAllRecords("reminder_schedule")
		if err != nil {
			t.Fatalf("读取排程失败：%v", err)
		}
		if len(schedules) != 2 {
			t.Fatalf("自愈应写入早晚两条排程，得到 %d 条", len(schedules))
		}
	}
	scenario.Test(t)
}
