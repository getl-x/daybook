package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// push_subscriptions 少了"这条订阅是什么时候上报的"这一列。
//
// Node 版的建表 SQL 里有 `created_at timestamptz NOT NULL DEFAULT now()`，
// 而 PocketBase 的 base 集合只自带 id（没有 created/updated 这对 autodate 字段）。
// 于是 /v1/notifications/subscriptions 返回的 created_at 一直是零值，设置页会
// 把它显示成 0001-01-01（SettingsPage.tsx 里是 created_at.slice(0, 10)）。
//
// 用普通 DateField 而不是 AutodateField，与本表其它时间列
// （last_seen_at / last_success_at / disabled_at）保持一致：AutodateField 会在
// 每次 update 时一并刷新，而"创建时间"必须只写一次。
func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("push_subscriptions")
		if err != nil {
			return err
		}
		if collection.Fields.GetByName("created_at") == nil {
			collection.Fields.Add(&core.DateField{Name: "created_at"})
		}
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("push_subscriptions")
		if err != nil {
			return nil
		}
		collection.Fields.RemoveByName("created_at")
		return app.Save(collection)
	})
}
