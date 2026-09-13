package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		// 访问令牌有效期 15 分钟，与 Node 版的 ACCESS_TOKEN_TTL_SECONDS 对齐。
		// 短访问令牌 + 可吊销的刷新令牌是这套设计的基本形态：
		// 停用账号后旧的访问令牌最多再活 15 分钟，刷新令牌则立即失效。
		users.AuthToken.Duration = 900

		// 账号状态与删除申请时间（对应 Node 版 users.status / users.deletion_requested_at）。
		// 留空视为 active，兼容迁移前就存在的记录。
		if users.Fields.GetByName("status") == nil {
			users.Fields.Add(&core.SelectField{
				Name:      "status",
				MaxSelect: 1,
				Values:    []string{"active", "disabled", "pending_deletion"},
			})
		}
		if users.Fields.GetByName("deletion_requested_at") == nil {
			users.Fields.Add(&core.DateField{Name: "deletion_requested_at"})
		}
		if err := app.Save(users); err != nil {
			return err
		}

		// refresh_tokens：刷新令牌高熵、只存 SHA-256 哈希，登出/停用时可精确吊销。
		// 纯服务端集合——客户端一律不可访问（规则全为 nil）。
		collection := core.NewBaseCollection("refresh_tokens")
		collection.ListRule = nil
		collection.ViewRule = nil
		collection.CreateRule = nil
		collection.UpdateRule = nil
		collection.DeleteRule = nil
		collection.Fields.Add(
			&core.RelationField{
				Name:          "user",
				Required:      true,
				MaxSelect:     1,
				CascadeDelete: true,
				CollectionId:  users.Id,
			},
			&core.TextField{Name: "token_hash", Required: true},
			&core.DateField{Name: "expires_at", Required: true},
			// 轮换链：新令牌记下它替换掉的那条，便于排查"令牌被重放"
			&core.TextField{Name: "rotated_from"},
			&core.DateField{Name: "revoked_at"},
		)
		collection.AddIndex("idx_refresh_tokens_hash", true, "token_hash", "")
		collection.AddIndex("idx_refresh_tokens_user", false, "user", "")
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("refresh_tokens")
		if err != nil {
			return nil
		}
		return app.Delete(collection)
	})
}
