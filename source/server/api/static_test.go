package api

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// staticTestDir 造一份最小可用的前端产物。
func staticTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name string, content string) {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录失败：%v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("写文件失败：%v", err)
		}
	}
	write("index.html", "<!doctype html><title>DAYBOOK-SPA-MARKER</title>")
	write("assets/index-abc123.js", "console.log('APP-ASSET-MARKER')")
	write("sw.js", "// SERVICE-WORKER-MARKER")
	return dir
}

// runStatic 跑一个"带前端产物"的场景：路由 + 静态托管都挂上。
// afterTest 用于断言响应头（ApiScenario 本身只看状态码与正文）。
func runStatic(
	t *testing.T,
	publicDir string,
	afterTest func(t testing.TB, res *http.Response),
	scenario tests.ApiScenario,
) {
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, event *core.ServeEvent) {
		RegisterRoutes(event, RouteConfig{AppVersion: "test", DatabaseVersion: "test"})
		RegisterStatic(event, publicDir)
	}
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		assertSingleBody(t, app, res)
		if afterTest != nil {
			afterTest(t, res)
		}
	}
	scenario.Test(t)
}

func TestStaticServesIndexAndSpaRoutes(t *testing.T) {
	dir := staticTestDir(t)
	for _, url := range []string{"/", "/calendar", "/day/2026-09-13"} {
		runStatic(t, dir, nil, tests.ApiScenario{
			Name:            "SPA 路由回 index.html：" + url,
			Method:          http.MethodGet,
			URL:             url,
			ExpectedStatus:  http.StatusOK,
			ExpectedContent: []string{"DAYBOOK-SPA-MARKER"},
			TestAppFactory:  plainAppFactory,
		})
	}
}

// 缓存策略：
//   - 带内容哈希的 /assets/* 可以长期不可变缓存；
//   - sw.js 与 index.html 必须 no-cache，否则新版本发不出去。
func TestStaticCachePolicy(t *testing.T) {
	dir := staticTestDir(t)

	cases := []struct {
		url    string
		marker string
		wantCC string
	}{
		{"/assets/index-abc123.js", "APP-ASSET-MARKER", "public, max-age=31536000, immutable"},
		{"/sw.js", "SERVICE-WORKER-MARKER", "no-cache"},
		{"/index.html", "DAYBOOK-SPA-MARKER", "no-cache"},
		{"/calendar", "DAYBOOK-SPA-MARKER", "no-cache"},
	}
	for _, testCase := range cases {
		wanted := testCase.wantCC
		runStatic(t, dir, func(t testing.TB, res *http.Response) {
			if got := res.Header.Get("Cache-Control"); got != wanted {
				t.Errorf("Cache-Control = %q，期望 %q", got, wanted)
			}
		}, tests.ApiScenario{
			Name:            "缓存策略 " + testCase.url,
			Method:          http.MethodGet,
			URL:             testCase.url,
			ExpectedStatus:  http.StatusOK,
			ExpectedContent: []string{testCase.marker},
			TestAppFactory:  plainAppFactory,
		})
	}
}

// 这条是 Node 版踩坑之后加的防护：发版后旧页面引用到已被清掉的
// /assets/xxx.js，如果回 index.html，浏览器会拿到 200 的 HTML 并报
// MIME type 错误 → 白屏，而且极难排查。
func TestMissingAssetReturnsJSON404NotHTML(t *testing.T) {
	dir := staticTestDir(t)
	runStatic(t, dir, nil, tests.ApiScenario{
		Name:               "缺失的静态资源返回 404 而不是 HTML",
		Method:             http.MethodGet,
		URL:                "/assets/index-gone999.js",
		ExpectedStatus:     http.StatusNotFound,
		ExpectedContent:    []string{`"error":"not_found"`},
		NotExpectedContent: []string{"DAYBOOK-SPA-MARKER"},
		TestAppFactory:     plainAppFactory,
	})
}

// 同理，API 路径找不到时也必须回 JSON——前端会直接 JSON.parse 响应体。
//
// 注意只判 /v1 与 /healthz 这两个前缀/精确路径，与 Node 版一致：
// /healthz/nope 这种不存在的路径仍按前端路由处理，回 SPA。
func TestUnknownAPIPathReturnsJSON404(t *testing.T) {
	dir := staticTestDir(t)
	for _, url := range []string{"/v1/nope", "/v1", "/v1/not/a/route"} {
		runStatic(t, dir, nil, tests.ApiScenario{
			Name:               "未知 API 路径回 JSON 404：" + url,
			Method:             http.MethodGet,
			URL:                url,
			ExpectedStatus:     http.StatusNotFound,
			ExpectedContent:    []string{`"error":"not_found"`},
			NotExpectedContent: []string{"DAYBOOK-SPA-MARKER"},
			TestAppFactory:     plainAppFactory,
		})
	}
}

// 精确路由优先于通配：静态托管不能把 /healthz 和 /_/ 吃掉。
func TestStaticDoesNotShadowRealRoutes(t *testing.T) {
	dir := staticTestDir(t)
	runStatic(t, dir, nil, tests.ApiScenario{
		Name:               "/healthz 不被通配路由吃掉",
		Method:             http.MethodGet,
		URL:                "/healthz",
		ExpectedStatus:     http.StatusOK,
		ExpectedContent:    []string{`"status":"ok"`},
		NotExpectedContent: []string{"DAYBOOK-SPA-MARKER"},
		TestAppFactory:     plainAppFactory,
	})
}

// 请求里的 .. 不能跑出产物目录。
//
// 分两种写法看：
//   - 字面 `/../`：Go 的 http.ServeMux 在路由之前就把它规范化成 `/`，
//     并回一个重定向，所以文件读取根本不会发生；
//   - 百分号编码：能穿到我们的处理函数里，由 path.Clean 消掉 `..`
//     （Clean("/../secret.txt") = "/secret.txt"），随后在产物目录里找不到，
//     而 .txt 命中静态资源正则 → 404 JSON。
//
// 两种写法都断言"机密内容绝不出现"。
func TestStaticRejectsPathTraversal(t *testing.T) {
	dir := staticTestDir(t)
	// 产物目录的上一级放一份"机密文件"，确保穿越尝试确实有东西可读。
	secret := filepath.Join(filepath.Dir(dir), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP-SECRET-MARKER"), 0o644); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
	t.Cleanup(func() { _ = os.Remove(secret) })

	cases := []struct {
		name string
		url  string
		want int
	}{
		{"字面 ..", "/../secret.txt", http.StatusTemporaryRedirect},
		{"百分号编码的 ..", "/%2e%2e/secret.txt", http.StatusNotFound},
	}
	for _, testCase := range cases {
		runStatic(t, dir, nil, tests.ApiScenario{
			Name:               "目录穿越：" + testCase.name,
			Method:             http.MethodGet,
			URL:                testCase.url,
			ExpectedStatus:     testCase.want,
			NotExpectedContent: []string{"TOP-SECRET-MARKER"},
			TestAppFactory:     plainAppFactory,
		})
	}
}

func TestRegisterStaticIsSkippedWithoutBuild(t *testing.T) {
	empty := t.TempDir()
	// 没有 index.html 就不该注册通配路由，否则本地开发（Vite dev server）
	// 会把所有未知路径都变成 200 的空壳。
	event := &core.ServeEvent{}
	if RegisterStatic(event, empty) {
		t.Error("产物目录为空时应当返回 false")
	}
}
