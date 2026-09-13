// Package api 提供 daybook 的 /v1/* HTTP 契约。
//
// 这一层是**刻意保持与 Node 版逐字一致**的：source/web 里的客户端
// （src/lib/api.ts）按这套契约写的，保持不变意味着前端无需跟着重写。
package api

import (
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// RouteConfig 是注册路由时需要的外部信息。
type RouteConfig struct {
	AppVersion      string
	DatabaseVersion string
}

// RegisterRoutes 在 ServeEvent 上挂载全部路由。
func RegisterRoutes(event *core.ServeEvent, config RouteConfig) {
	// 健康检查：契约来自客户端 api.ts 的 Health 类型
	// （status / db / time），部署探活用。
	event.Router.GET("/healthz", func(request *core.RequestEvent) error {
		return request.JSON(http.StatusOK, map[string]any{
			"status":          "ok",
			"db":              "pocketbase",
			"time":            time.Now().UTC().Format(time.RFC3339Nano),
			"appVersion":      config.AppVersion,
			"databaseVersion": config.DatabaseVersion,
		})
	})
}
