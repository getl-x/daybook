package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// incidents 需要一列存客户端生成的 UUID。
//
// 为什么不能用主键：PocketBase 的记录 id 是 15 位的 `[a-z0-9]`，装不下
// 36 字符的 UUID。而 Node 版的幂等语义依赖"id 由客户端生成、重复提交天然幂等"
// （见 diary.ts 的 normalizeIncidentInput），所以必须另开一列。
func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("incidents")
		if err != nil {
			return err
		}
		if collection.Fields.GetByName("client_id") == nil {
			collection.Fields.Add(&core.TextField{Name: "client_id", Required: true, Max: 64})
		}
		// 幂等键：同一用户下 client_id 唯一。
		collection.AddIndex("idx_incidents_client_id", true, "user, client_id", "")
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("incidents")
		if err != nil {
			return nil
		}
		collection.RemoveIndex("idx_incidents_client_id")
		return app.Save(collection)
	})
}
