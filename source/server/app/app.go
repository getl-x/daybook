package app

import (
	"github.com/getl-x/daybook/source/server/api"
	"github.com/pocketbase/pocketbase"
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
func RegisterHooks(application core.App, config Config) {
	// 迁移必须显式跑。PocketBase **不会**在 serve 时自动应用 core.AppMigrations
	//（`RunAppMigrations` 在整个依赖里只有定义、没有调用方），migratecmd 也只
	// 提供 CLI 子命令。少了这一步服务照样能起来、/healthz 也照样 200，
	// 但一个集合都不会建——是那种"部署完看着正常、一用就全崩"的坑。
	application.OnBootstrap().BindFunc(func(event *core.BootstrapEvent) error {
		if err := event.Next(); err != nil {
			return err
		}
		return event.App.RunAppMigrations()
	})

	application.OnServe().BindFunc(func(event *core.ServeEvent) error {
		api.RegisterRoutes(event, api.RouteConfig{
			AppVersion:      config.AppVersion,
			DatabaseVersion: DatabaseVersion,
		})

		// 托管前端产物；没有产物时（本地开发跑 Vite dev server）自动跳过。
		// 不用 PocketBase 的 apis.Static：它的 SPA 回退会把 /v1/… 里不存在的
		// 路径也回成 index.html，而前端会拿 HTML 去 JSON.parse。
		api.RegisterStatic(event, config.PublicDir)

		return event.Next()
	})
}
