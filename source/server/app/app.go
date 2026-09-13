package app

import (
	"time"

	"github.com/getl-x/daybook/source/server/api"
	"github.com/getl-x/daybook/source/server/applog"
	"github.com/getl-x/daybook/source/server/auth"
	"github.com/getl-x/daybook/source/server/push"
	"github.com/getl-x/daybook/source/server/scheduler"
	"github.com/getl-x/daybook/source/server/vapid"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// reminderCronSpec 是每分钟一次。
const reminderCronSpec = "* * * * *"

// reminderCronID 是 cron 任务的固定 id。
//
// PocketBase 的 cron.MustAdd 在 id 重复时会 panic，所以这个任务只能注册一次——
// 也正是密钥解析与 cron 注册都放在 OnBootstrap 而不是 OnServe 的原因：
// OnServe 每个监听器都会触发一次，OnBootstrap 只触发一次。
const reminderCronID = "daybook-reminders"

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
	// 启动时解析一次的推送配置，供 OnServe 与 cron 共用。
	//
	// 放在闭包里而不是包级变量：一个进程只有一个 app，但测试会造很多个，
	// 包级变量会让它们互相污染。
	var vapidPublicKey *string
	var sender push.Sender

	// 迁移必须显式跑。PocketBase **不会**在 serve 时自动应用 core.AppMigrations
	//（`RunAppMigrations` 在整个依赖里只有定义、没有调用方），migratecmd 也只
	// 提供 CLI 子命令。少了这一步服务照样能起来、/healthz 也照样 200，
	// 但一个集合都不会建——是那种"部署完看着正常、一用就全崩"的坑。
	application.OnBootstrap().BindFunc(func(event *core.BootstrapEvent) error {
		if err := event.Next(); err != nil {
			return err
		}
		if err := event.App.RunAppMigrations(); err != nil {
			return err
		}

		// 密钥解析失败**不致命**：服务要照常起来（日记本身不依赖推送），
		// 只是 /v1/settings 与 /v1/notifications/status 的公钥为 null，
		// 前端据此禁用"开启每日提醒"。
		keys, err := vapid.ResolveKeys(event.App, config.VAPIDSubject)
		if err != nil {
			applog.Logf(event.App, applog.LevelError, "解析 VAPID 密钥失败，推送将不可用：%v", err)
			return nil
		}
		vapidPublicKey = &keys.PublicKey
		sender = push.NewSender(push.Options{
			PublicKey:  keys.PublicKey,
			PrivateKey: keys.PrivateKey,
			Subject:    vapid.SubjectOrDefault(config.VAPIDSubject),
			TTL:        push.DefaultTTL,
		})

		// 每分钟一次 tick。注册失败只记日志：提醒调度不该拖垮服务启动。
		if err := event.App.Cron().Add(reminderCronID, reminderCronSpec, func() {
			scheduler.RunDue(scheduler.Deps{
				App:    event.App,
				Sender: sender,
				Now:    time.Now,
				// 账号删除的宽限期清理搭在这一轮上，不另开定时任务。
				Purge: func(now time.Time) (int, error) {
					return auth.PurgeExpiredAccounts(event.App, now)
				},
			})
		}); err != nil {
			applog.Logf(event.App, applog.LevelError, "注册提醒 cron 失败：%v", err)
		}
		return nil
	})

	application.OnServe().BindFunc(func(event *core.ServeEvent) error {
		api.RegisterRoutes(event, api.RouteConfig{
			AppVersion:      config.AppVersion,
			DatabaseVersion: DatabaseVersion,
			VAPIDPublicKey:  vapidPublicKey,
		})

		// 托管前端产物；没有产物时（本地开发跑 Vite dev server）自动跳过。
		// 不用 PocketBase 的 apis.Static：它的 SPA 回退会把 /v1/… 里不存在的
		// 路径也回成 index.html，而前端会拿 HTML 去 JSON.parse。
		api.RegisterStatic(event, config.PublicDir)

		return event.Next()
	})
}
