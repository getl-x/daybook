package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

const (
	testUsername    = "getl"
	testPassword    = "correct-horse-battery"
	testIncidentID  = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	testIncidentDay = "2026-09-12"
)

// registerTestRoutes 把被测路由挂到测试应用上。
// ApiScenario 不会自动跑 main.go 里的 New()/RegisterHooks，所以得显式来一次。
func registerTestRoutes(t testing.TB, app *tests.TestApp, event *core.ServeEvent) {
	RegisterRoutes(event, RouteConfig{AppVersion: "test", DatabaseVersion: "test"})
}

// run 统一给每个场景补两件事：
//
//  1. BeforeTestFunc 挂路由——漏掉的话所有场景都会 404，
//     而失败信息会误导成"路由写错了"。
//  2. 响应体必须**恰好是一个 JSON 值**的断言。
//
// 第 2 条是回归防线。早先 fail() 写出错误响应后返回了 nil，调用方
// `return fail(...)` 因此没有真的返回，处理函数继续走完成功分支，
// 于是响应体成了 {"error":"unauthorized"}{"timezones":[...]}——
// 未登录请求拿到了整张时区表。而只做子串匹配的断言完全看不出来。
func run(t *testing.T, scenario tests.ApiScenario) {
	scenario.BeforeTestFunc = registerTestRoutes
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		if res == nil || res.Body == nil {
			return
		}
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatalf("读取响应体失败：%v", err)
		}
		// 读走之后放回去，避免影响 ApiScenario 自己的断言。
		res.Body = io.NopCloser(bytes.NewReader(body))

		if len(bytes.TrimSpace(body)) == 0 {
			return
		}

		decoder := json.NewDecoder(bytes.NewReader(body))
		var first any
		if err := decoder.Decode(&first); err != nil {
			t.Fatalf("响应体不是合法 JSON：%v（原始内容：%s）", err, body)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			t.Errorf("响应体里出现了第二段内容（响应被写了不止一次？）：%s", body)
		}
	}
	scenario.Test(t)
}

func newApp(t testing.TB) *tests.TestApp {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}
	return app
}

// appWithUser 建一个"已登录"的应用：建账号、签发访问令牌，并把
// Authorization 写进共享的 headers。ApiScenario 的 Headers 在场景执行前
// 就固定了，而令牌要等应用起来才拿得到，所以走"工厂回填"这条路。
func appWithUser(t testing.TB, headers map[string]string) *tests.TestApp {
	app := newApp(t)

	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", testUsername)
	record.Set("status", "active")
	record.SetPassword(testPassword)
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号失败：%v", err)
	}

	if headers != nil {
		token, err := record.NewAuthToken()
		if err != nil {
			t.Fatalf("签发令牌失败：%v", err)
		}
		headers["Authorization"] = "Bearer " + token
	}
	return app
}

func appWithUserFactory(headers map[string]string) func(t testing.TB) *tests.TestApp {
	return func(t testing.TB) *tests.TestApp { return appWithUser(t, headers) }
}

func plainAppFactory(t testing.TB) *tests.TestApp { return newApp(t) }

/* ------------------------------- 认证 ------------------------------- */

func TestLoginReturnsClientContractShape(t *testing.T) {
	run(t, tests.ApiScenario{
		Name:   "登录返回前端约定的字段",
		Method: http.MethodPost,
		URL:    "/v1/auth/login",
		Body:   strings.NewReader(`{"username":"getl","password":"correct-horse-battery"}`),
		ExpectedStatus: http.StatusOK,
		// 前端 sessionFromLoginBody 就地读这几个键，少一个都会把它打回登录页。
		ExpectedContent: []string{
			`"accessToken"`, `"refreshToken"`, `"expiresIn":900`,
			`"refreshExpiresAt"`, `"username":"getl"`,
		},
		TestAppFactory: func(t testing.TB) *tests.TestApp { return appWithUser(t, nil) },
	})
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	run(t, tests.ApiScenario{
		Name:            "口令错误返回 invalid_credentials",
		Method:          http.MethodPost,
		URL:             "/v1/auth/login",
		Body:            strings.NewReader(`{"username":"getl","password":"nope-nope-nope"}`),
		ExpectedStatus:  http.StatusUnauthorized,
		ExpectedContent: []string{`"error":"invalid_credentials"`},
		TestAppFactory:  func(t testing.TB) *tests.TestApp { return appWithUser(t, nil) },
	})
}

/* ------------------------------ 需要登录 ------------------------------ */

func TestProtectedRoutesRejectAnonymous(t *testing.T) {
	for _, url := range []string{"/v1/diaries/today", "/v1/settings", "/v1/meta/timezones", "/v1/calendar"} {
		run(t, tests.ApiScenario{
			Name:            "未登录访问 " + url,
			Method:          http.MethodGet,
			URL:             url,
			ExpectedStatus:  http.StatusUnauthorized,
			ExpectedContent: []string{`"error":"unauthorized"`},
			TestAppFactory:  plainAppFactory,
		})
	}
}

func TestTodayViewShape(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:           "今日视图返回 meta/today/yesterday/incidents/progress",
		Method:         http.MethodGet,
		URL:            "/v1/diaries/today",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"meta"`, `"diary_date"`, `"yesterday"`, `"today"`, `"exists":false`,
			`"progress"`, `"morningDone":false`, `"eveningDone":false`,
			`"day_events"`, `"day_meals"`, `"day_plan"`, `"evening_summary"`,
			`"timezone":"Asia/Shanghai"`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

// 字段级写入：PATCH 只提交一个字段，返回 version 与该字段的新状态。
func TestDiaryPatchWritesSingleField(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:   "字段级写入",
		Method: http.MethodPatch,
		URL:    "/v1/diaries/2026-09-13",
		Body: strings.NewReader(
			`{"fields":{"day_plan":{"value":"写点计划","base_updated_at":null}}}`,
		),
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"entryDate":"2026-09-13"`, `"version":1`,
			`"value":"写点计划"`, `"overwritten":false`, `"updatedAt"`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

func TestDiaryPatchRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"没有要保存的字段", `{"fields":{}}`},
		{"字段名不在白名单", `{"fields":{"evil_column":{"value":"x"}}}`},
		{"正文超长", `{"fields":{"day_plan":{"value":"` + strings.Repeat("あ", 8001) + `"}}}`},
	}
	for _, testCase := range cases {
		headers := map[string]string{}
		run(t, tests.ApiScenario{
			Name:            testCase.name,
			Method:          http.MethodPatch,
			URL:             "/v1/diaries/2026-09-13",
			Body:            strings.NewReader(testCase.body),
			Headers:         headers,
			ExpectedStatus:  http.StatusBadRequest,
			ExpectedContent: []string{`"error":"`},
			TestAppFactory:  appWithUserFactory(headers),
		})
	}
}

func TestDiaryGetRejectsBadDate(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:            "日期格式不对",
		Method:          http.MethodGet,
		URL:             "/v1/diaries/not-a-date",
		Headers:         headers,
		ExpectedStatus:  http.StatusBadRequest,
		ExpectedContent: []string{`"error":"invalid_field"`},
		TestAppFactory:  appWithUserFactory(headers),
	})
}

// 突发事情的归属日由服务端按 occurred_at + 时区 + 日界算，客户端不参与。
func TestIncidentCreateComputesEntryDate(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:   "创建突发事情",
		Method: http.MethodPost,
		URL:    "/v1/incidents",
		// 2026-09-12T19:30:00Z = 本地（Asia/Shanghai）2026-09-13 03:30，
		// 在 04:00 日界之前 → 归属日应当回退到 2026-09-12。
		Body: strings.NewReader(`{
			"id":"` + testIncidentID + `",
			"content":"忘了带钥匙",
			"occurred_at":"2026-09-12T19:30:00Z",
			"tag":"life"
		}`),
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"created":true`, `"entryDate":"` + testIncidentDay + `"`,
			`"content":"忘了带钥匙"`, `"tag":"life"`,
			`"occurredAt":"2026-09-12T19:30:00.000Z"`,
			`"id":"` + testIncidentID + `"`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

func TestIncidentCreateIsIdempotent(t *testing.T) {
	headers := map[string]string{}
	factory := func(t testing.TB) *tests.TestApp {
		app := appWithUser(t, headers)

		// 预置一条同 id 的记录，模拟"客户端重试了同一次提交"。
		collection, err := app.FindCollectionByNameOrId("incidents")
		if err != nil {
			t.Fatalf("找不到 incidents 集合：%v", err)
		}
		user, err := app.FindFirstRecordByData("users", "username", testUsername)
		if err != nil {
			t.Fatalf("找不到账号：%v", err)
		}
		record := core.NewRecord(collection)
		record.Set("user", user.Id)
		record.Set("client_id", testIncidentID)
		record.Set("entry_date", testIncidentDay)
		record.Set("occurred_at", "2026-09-12T19:30:00Z")
		record.Set("content", "忘了带钥匙")
		record.Set("tag", "life")
		if err := app.Save(record); err != nil {
			t.Fatalf("预置记录失败：%v", err)
		}
		return app
	}

	run(t, tests.ApiScenario{
		Name:   "重复提交同一 id",
		Method: http.MethodPost,
		URL:    "/v1/incidents",
		Body: strings.NewReader(`{
			"id":"` + testIncidentID + `",
			"content":"忘了带钥匙",
			"occurred_at":"2026-09-12T19:30:00Z",
			"tag":"life"
		}`),
		Headers:         headers,
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{`"created":false`},
		TestAppFactory:  factory,
	})
}

func TestIncidentCreateRejectsBadPayload(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"id 不是 UUID", `{"id":"nope","content":"x"}`},
		{"内容为空", `{"id":"` + testIncidentID + `","content":"   "}`},
		{"分类非法", `{"id":"` + testIncidentID + `","content":"x","tag":"sports"}`},
		{"发生时间超出合理范围", `{"id":"` + testIncidentID + `","content":"x","occurred_at":"1999-01-01T00:00:00Z"}`},
	}
	for _, testCase := range cases {
		headers := map[string]string{}
		run(t, tests.ApiScenario{
			Name:            testCase.name,
			Method:          http.MethodPost,
			URL:             "/v1/incidents",
			Body:            strings.NewReader(testCase.body),
			Headers:         headers,
			ExpectedStatus:  http.StatusBadRequest,
			ExpectedContent: []string{`"error":"`},
			TestAppFactory:  appWithUserFactory(headers),
		})
	}
}

// 改不存在的 id 一律按"不存在"处理，不泄露"存在但不属于你"。
func TestIncidentUpdateRejectsUnknownID(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:            "改一条不存在的突发事情",
		Method:          http.MethodPatch,
		URL:             "/v1/incidents/abcdefghijklmno",
		Body:            strings.NewReader(`{"content":"x"}`),
		Headers:         headers,
		ExpectedStatus:  http.StatusNotFound,
		ExpectedContent: []string{`"error":"not_found"`},
		TestAppFactory:  appWithUserFactory(headers),
	})
}

/* ------------------------------- 设置 ------------------------------- */

func TestSettingsDefaults(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:           "没设过时返回默认值",
		Method:         http.MethodGet,
		URL:            "/v1/settings",
		Headers:        headers,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"timezone":"Asia/Shanghai"`, `"day_start_hour":4`,
			`"morning_time":"09:00"`, `"evening_time":"21:00"`,
			`"morning_enabled":true`, `"only_if_incomplete":true`,
			`"quiet_hours"`, `"vapid_public_key":null`,
		},
		TestAppFactory: appWithUserFactory(headers),
	})
}

func TestSettingsPatchValidates(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    int
		content []string
	}{
		{"非法时区", `{"timezone":"Mars/Olympus"}`, http.StatusBadRequest, []string{`"error":"invalid_timezone"`}},
		{"日界越界", `{"day_start_hour":9}`, http.StatusBadRequest, []string{`"error":"invalid_day_start_hour"`}},
		{"时刻格式不对", `{"reminder_morning_time":"9:0"}`, http.StatusBadRequest, []string{`"error":"invalid_time"`}},
		{"静默时段两端相同", `{"quiet_enabled":true,"quiet_start":"22:00","quiet_end":"22:00"}`, http.StatusBadRequest, []string{`"error":"invalid_quiet_hours"`}},
		{"静默时段缺一端", `{"quiet_enabled":true,"quiet_start":"22:00"}`, http.StatusBadRequest, []string{`"error":"invalid_quiet_hours"`}},
		{"合法更新", `{"timezone":"America/New_York","day_start_hour":5}`, http.StatusOK, []string{`"timezone":"America/New_York"`, `"day_start_hour":5`}},
	}
	for _, testCase := range cases {
		headers := map[string]string{}
		run(t, tests.ApiScenario{
			Name:            testCase.name,
			Method:          http.MethodPatch,
			URL:             "/v1/settings",
			Body:            strings.NewReader(testCase.body),
			Headers:         headers,
			ExpectedStatus:  testCase.want,
			ExpectedContent: testCase.content,
			TestAppFactory:  appWithUserFactory(headers),
		})
	}
}

/* ------------------------------ 其他 ------------------------------ */

func TestCalendarRejectsBadMonth(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:            "month 越界",
		Method:          http.MethodGet,
		URL:             "/v1/calendar?month=2026-13",
		Headers:         headers,
		ExpectedStatus:  http.StatusBadRequest,
		ExpectedContent: []string{`"error":"invalid_field"`},
		TestAppFactory:  appWithUserFactory(headers),
	})
}

func TestTimezonesAreServed(t *testing.T) {
	headers := map[string]string{}
	run(t, tests.ApiScenario{
		Name:            "时区列表",
		Method:          http.MethodGet,
		URL:             "/v1/meta/timezones",
		Headers:         headers,
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{`"Asia/Shanghai"`, `"America/New_York"`},
		TestAppFactory:  appWithUserFactory(headers),
	})
}

func TestHealthzIsPublic(t *testing.T) {
	run(t, tests.ApiScenario{
		Name:            "健康检查不需要登录",
		Method:          http.MethodGet,
		URL:             "/healthz",
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{`"status":"ok"`, `"db":"pocketbase"`},
		TestAppFactory:  plainAppFactory,
	})
}
