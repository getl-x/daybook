package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// healthResponse 是 /healthz 里我们关心的两个字段。
type healthResponse struct {
	Status     string `json:"status"`
	AppVersion string `json:"appVersion"`
}

// CheckHealth 探一次健康检查接口，确认正在跑的服务真的能干活。
//
// 为什么不用镜像里的 wget 做 HEALTHCHECK：wget 只能看 HTTP 200，而我们真正想
// 确认的是"它还是那个应用、而且报告自己 ok"——一个占着 8090 的别的进程也能回
// 200。这里连 JSON 体一起校验，并且给容器编排一个可以直接 `docker compose exec`
// 的同款入口（见 RegisterCommands）。
func CheckHealth(ctx context.Context, client *http.Client, baseURL string) error {
	if client == nil {
		client = http.DefaultClient
	}
	healthURL, err := resolveHealthURL(baseURL)
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		return fmt.Errorf("创建健康检查请求失败：%w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("请求健康检查接口失败：%w", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		// 读一点然后丢掉：保持连接可复用，也不让错误响应把内存吃掉。
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return fmt.Errorf("健康检查接口返回 %s", response.Status)
	}

	// 限制读入量：这不是我们自己的响应，别无条件信任。
	var payload healthResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&payload); err != nil {
		return fmt.Errorf("解析健康检查响应失败：%w", err)
	}
	if payload.Status != "ok" || strings.TrimSpace(payload.AppVersion) == "" {
		return fmt.Errorf("健康检查接口还没就绪")
	}
	return nil
}

// resolveHealthURL 允许传根地址或完整路径；只给了主机时补上默认路径。
func resolveHealthURL(baseURL string) (string, error) {
	value := strings.TrimSpace(baseURL)
	if value == "" {
		return "", fmt.Errorf("需要健康检查地址")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("解析健康检查地址失败：%w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("健康检查地址必须用 http 或 https")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("健康检查地址必须带主机名")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/healthz"
	}
	return parsed.String(), nil
}
