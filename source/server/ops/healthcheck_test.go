package ops

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckHealthAcceptsReadyServerAndAppendsDefaultPath(t *testing.T) {
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seenPath = request.URL.Path
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok","db":"pocketbase","appVersion":"dev"}`))
	}))
	defer server.Close()

	// 只给主机地址：应当自动补上 /healthz
	if err := CheckHealth(context.Background(), server.Client(), server.URL); err != nil {
		t.Fatalf("健康的服务不该报错：%v", err)
	}
	if seenPath != "/healthz" {
		t.Fatalf("应自动补 /healthz，实际请求了 %s", seenPath)
	}

	// 给了完整路径就按给的走
	if err := CheckHealth(context.Background(), server.Client(), server.URL+"/healthz"); err != nil {
		t.Fatalf("完整地址不该报错：%v", err)
	}
}

func TestCheckHealthRejectsUnreadyResponses(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"非 200", http.StatusInternalServerError, `{"status":"ok","appVersion":"dev"}`},
		{"不是 JSON", http.StatusOK, `<html>早上好</html>`},
		{"status 不是 ok", http.StatusOK, `{"status":"degraded","appVersion":"dev"}`},
		{"appVersion 为空", http.StatusOK, `{"status":"ok","appVersion":"   "}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer server.Close()

			if err := CheckHealth(context.Background(), server.Client(), server.URL); err == nil {
				t.Fatal("这种情况应当报错")
			}
		})
	}
}

func TestCheckHealthFailsWhenNothingIsListening(t *testing.T) {
	// 端口没人听：应当报错而不是挂住（client 的超时由调用方给，
	// 这里直接给一个连不上的地址）
	if err := CheckHealth(context.Background(), &http.Client{}, "http://127.0.0.1:1"); err == nil {
		t.Fatal("连不上应当报错")
	}
}

func TestResolveHealthURL(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"只给主机补默认路径", "http://127.0.0.1:8090", "http://127.0.0.1:8090/healthz"},
		{"只有根斜杠也补默认路径", "http://127.0.0.1:8090/", "http://127.0.0.1:8090/healthz"},
		{"给了路径就保留", "https://diary.example.com/healthz", "https://diary.example.com/healthz"},
		{"去掉首尾空白", "  http://127.0.0.1:8090/healthz  ", "http://127.0.0.1:8090/healthz"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := resolveHealthURL(testCase.input)
			if err != nil {
				t.Fatalf("不该报错：%v", err)
			}
			if got != testCase.want {
				t.Fatalf("期望 %s，得到 %s", testCase.want, got)
			}
		})
	}

	for _, input := range []string{"", "   ", "ftp://host/x", "127.0.0.1:8090", "http:///healthz"} {
		t.Run("拒绝 "+input, func(t *testing.T) {
			if _, err := resolveHealthURL(input); err == nil {
				t.Fatalf("%q 应当被拒绝", input)
			}
		})
	}
}
