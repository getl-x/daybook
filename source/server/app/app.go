package app

import (
	"os"

	"github.com/getl-x/daybook/source/server/api"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// New 组装 PocketBase 应用（对应 Node 版的 createPgDb + buildApp 两步）。
func New(config Config) *pocketbase.PocketBase {
	application := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir: config.DataDir,
	})
	RegisterHooks(application, config)
	return application
}

// RegisterHooks 挂上全部启动钩子。
//
// 集合结构由 migrations 包负责（import 即触发注册），这里只管运行时行为：
// 路由、静态托管，以及后续的提醒调度。
func RegisterHooks(application core.App, config Config) {
	application.OnServe().BindFunc(func(event *core.ServeEvent) error {
		api.RegisterRoutes(event, api.RouteConfig{
			AppVersion:      config.AppVersion,
			DatabaseVersion: DatabaseVersion,
		})

		// 托管前端产物。放在 API 之后注册：Echo 先匹配已注册的精确路由，
		// 通配路由只兜底，因此不会把 /v1/… 或 /_/ 吃掉。
		if _, err := os.Stat(config.PublicDir); err == nil {
			event.Router.GET("/{path...}", apis.Static(os.DirFS(config.PublicDir), true))
		}

		return event.Next()
	})
}
