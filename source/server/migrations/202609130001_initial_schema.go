// Package migrations 用 Go 代码定义 PocketBase 的集合结构，
// 取代 Node 版 source/server/migrations/*.sql（Postgres）。
//
// 对应关系（SQL → PocketBase 集合）：
//
//	users + user_settings         → users(auth) + user_settings
//	daily_entries                 → daily_entries
//	incidents                     → incidents
//	push_subscriptions            → push_subscriptions
//	reminder_schedule             → reminder_schedule
//	notification_deliveries       → notification_deliveries
//	app_settings（VAPID 密钥）     → app_settings
//
// 唯一键（UNIQUE(user_id, entry_date) 等）在 PocketBase 里以唯一索引表达；
// 外键 ON DELETE CASCADE 由 RelationField.CascadeDelete 表达。
package migrations

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// 回滚顺序：先删依赖 users 的集合，users 自身由 PocketBase 内置、不删。
var collectionNames = []string{
	"notification_deliveries",
	"reminder_schedule",
	"push_subscriptions",
	"incidents",
	"daily_entries",
	"user_settings",
	"app_settings",
}

func init() {
	m.Register(func(app core.App) error {
		users, err := ensureUsersCollection(app)
		if err != nil {
			return err
		}

		save := func(collection *core.Collection) error {
			if err := app.Save(collection); err != nil {
				return fmt.Errorf("保存集合 %s 失败：%w", collection.Name, err)
			}
			return nil
		}

		for _, collection := range []*core.Collection{
			newUserSettingsCollection(users),
			newDailyEntriesCollection(users),
			newIncidentsCollection(users),
			newPushSubscriptionsCollection(users),
			newReminderScheduleCollection(users),
			newNotificationDeliveriesCollection(users),
			newAppSettingsCollection(),
		} {
			if err := save(collection); err != nil {
				return err
			}
		}
		return nil
	}, func(app core.App) error {
		for index := len(collectionNames) - 1; index >= 0; index-- {
			collection, err := app.FindCollectionByNameOrId(collectionNames[index])
			if err != nil {
				continue
			}
			if err := app.Delete(collection); err != nil {
				return err
			}
		}
		return nil
	})
}

// ensureUsersCollection 配置内置的 auth 集合，语义等价于 Node 版的 users 表：
// 用户名 + 密码、注册关闭、只能改自己。
func ensureUsersCollection(app core.App) (*core.Collection, error) {
	users, err := app.FindCollectionByNameOrId("users")
	if errors.Is(err, sql.ErrNoRows) {
		users = core.NewAuthCollection("users")
	} else if err != nil {
		return nil, err
	}

	users.ListRule = types.Pointer("id = @request.auth.id")
	users.ViewRule = types.Pointer("id = @request.auth.id")
	users.UpdateRule = types.Pointer("id = @request.auth.id")
	// 注册关闭：没有任何客户端可以自行建号，只能由管理员在 /_/ 控制台添加。
	// 这是"注册关闭，账号由管理员侧添加"这条设计取舍的落点。
	users.DeleteRule = nil
	users.CreateRule = nil
	users.PasswordAuth.Enabled = true

	// 注意：内置的 users 集合**已经自带** username 字段（pattern `^[\w][\w\.\-]*$`、
	// min 3 / max 150）。原先照抄 LastDone 的 `if 不存在才添加` 会整段落空——
	// 实测 "Getl" 能直接存进去，小写约束形同虚设。所以这里必须就地改，
	// 而不是"没有才加"。
	username, ok := users.Fields.GetByName("username").(*core.TextField)
	if !ok {
		username = &core.TextField{Name: "username"}
		users.Fields.Add(username)
	}
	// 与 Node 版的 CHECK (username = lower(username) AND username ~ '^[a-z0-9_-]{3,32}$') 对齐：
	// 只允许小写，从入口就杜绝 "Getl" 与 "getl" 被当成两个账号。
	username.Required = true
	username.Min = 3
	username.Max = 32
	username.Pattern = `^[a-z0-9_-]{3,32}$`
	username.Presentable = true

	if email, ok := users.Fields.GetByName("email").(*core.EmailField); ok {
		email.Required = false
	}

	// username 要当身份字段，就必须先带上 UNIQUE 约束——校验器不会替我们补。
	// 而 PocketBase 对**已经在身份字段里**的字段会自动维护唯一索引，那时候
	// 再显式加一条就会撞上 "The index definition already exists"。
	// 两种内置 users 集合（新建安装 vs. 测试夹具）正好各占一种，所以按
	// 身份字段现状判断，别无条件加。
	if !containsField(users.PasswordAuth.IdentityFields, "username") {
		users.AddIndex("idx_users_username", true, "username", "")
	}
	users.PasswordAuth.IdentityFields = []string{"username"}

	if err := app.Save(users); err != nil {
		return nil, err
	}
	return users, nil
}

// newOwnedCollection 建一个"属于某个用户"的集合：
// 规则保证只能读写自己的数据，删号时级联清理。
func newOwnedCollection(name string, users *core.Collection) *core.Collection {
	collection := core.NewBaseCollection(name)
	collection.ListRule = types.Pointer("user = @request.auth.id")
	collection.ViewRule = types.Pointer("user = @request.auth.id")
	collection.CreateRule = types.Pointer("@request.body.user = @request.auth.id")
	collection.UpdateRule = types.Pointer(
		"user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)",
	)
	collection.DeleteRule = types.Pointer("user = @request.auth.id")
	collection.Fields.Add(&core.RelationField{
		Name:          "user",
		Required:      true,
		MaxSelect:     1,
		CascadeDelete: true,
		CollectionId:  users.Id,
	})
	collection.AddIndex("idx_"+name+"_user", false, "user", "")
	return collection
}

// dateField 是 'YYYY-MM-DD' 形式的日记日字段。
func dateField(name string, required bool) *core.TextField {
	return &core.TextField{
		Name:     name,
		Required: required,
		Min:      10,
		Max:      10,
		Pattern:  `^\d{4}-\d{2}-\d{2}$`,
	}
}

// clockField 是 'HH:MM' 形式的本地时刻字段。
func clockField(name string) *core.TextField {
	return &core.TextField{
		Name:    name,
		Min:     5,
		Max:     5,
		Pattern: `^([01]\d|2[0-3]):[0-5]\d$`,
	}
}

func newUserSettingsCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("user_settings", users)
	collection.Fields.Add(
		&core.TextField{Name: "timezone", Required: true, Max: 64},
		&core.NumberField{Name: "day_start_hour", Required: true},
		&core.BoolField{Name: "morning_reminder_enabled"},
		clockField("morning_reminder_time"),
		&core.BoolField{Name: "evening_reminder_enabled"},
		clockField("evening_reminder_time"),
		&core.BoolField{Name: "notify_only_if_incomplete"},
		&core.SelectField{
			Name:      "theme",
			MaxSelect: 1,
			Values:    []string{"system", "light", "dark"},
		},
		&core.BoolField{Name: "quiet_enabled"},
		clockField("quiet_start"),
		clockField("quiet_end"),
	)
	return collection
}

// containsField 判断名字是否已在列表里（用于"要不要补唯一索引"的判断）。
func containsField(names []string, target string) bool {
	for _, name := range names {
		if name == target {
			return true
		}
	}
	return false
}

func newDailyEntriesCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("daily_entries", users)
	collection.Fields.Add(
		dateField("entry_date", true),
		&core.TextField{Name: "day_events", Max: 8000},
		&core.TextField{Name: "day_meals", Max: 8000},
		&core.TextField{Name: "day_plan", Max: 8000},
		&core.TextField{Name: "evening_summary", Max: 8000},
		// 字段级写入的基准时间：PATCH 只提交变更字段，冲突按字段判（不是整行 LWW）。
		&core.DateField{Name: "day_events_updated_at"},
		&core.DateField{Name: "day_meals_updated_at"},
		&core.DateField{Name: "day_plan_updated_at"},
		&core.DateField{Name: "evening_summary_updated_at"},
		&core.NumberField{Name: "version"},
		&core.DateField{Name: "reviewed_at"},
		&core.DateField{Name: "summarized_at"},
	)
	collection.AddIndex("idx_daily_entries_user_date", true, "user, entry_date", "")
	return collection
}

func newIncidentsCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("incidents", users)
	collection.Fields.Add(
		dateField("entry_date", true),
		&core.DateField{Name: "occurred_at", Required: true},
		&core.TextField{Name: "content", Required: true, Max: 2000},
		&core.SelectField{
			Name:      "tag",
			MaxSelect: 1,
			Values:    []string{"work", "life", "emotion", "idea", "other"},
		},
	)
	collection.AddIndex("idx_incidents_user_date", false, "user, entry_date, occurred_at", "")
	return collection
}

func newPushSubscriptionsCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("push_subscriptions", users)
	collection.Fields.Add(
		&core.TextField{Name: "endpoint", Required: true},
		&core.TextField{Name: "p256dh", Required: true},
		&core.TextField{Name: "auth", Required: true},
		&core.TextField{Name: "user_agent"},
		&core.TextField{Name: "label", Max: 64},
		&core.SelectField{
			Name:      "platform",
			MaxSelect: 1,
			Values:    []string{"web", "ios-pwa", "android"},
		},
		&core.DateField{Name: "last_seen_at"},
		&core.DateField{Name: "last_success_at"},
		&core.NumberField{Name: "failure_count"},
		&core.DateField{Name: "disabled_at"},
	)
	collection.AddIndex("idx_push_subscriptions_endpoint", true, "endpoint", "")
	return collection
}

func newReminderScheduleCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("reminder_schedule", users)
	collection.Fields.Add(
		&core.SelectField{
			Name:      "kind",
			Required:  true,
			MaxSelect: 1,
			Values:    []string{"morning", "evening"},
		},
		&core.DateField{Name: "next_fire_at"},
		&core.DateField{Name: "locked_at"},
	)
	// 对应 SQL 的 PRIMARY KEY (user_id, kind)
	collection.AddIndex("idx_reminder_schedule_user_kind", true, "user, kind", "")
	collection.AddIndex("idx_reminder_schedule_due", false, "next_fire_at", "")
	return collection
}

func newNotificationDeliveriesCollection(users *core.Collection) *core.Collection {
	collection := newOwnedCollection("notification_deliveries", users)
	collection.Fields.Add(
		dateField("local_date", true),
		&core.SelectField{
			Name:      "kind",
			Required:  true,
			MaxSelect: 1,
			Values:    []string{"morning", "evening"},
		},
		&core.SelectField{
			Name:      "status",
			Required:  true,
			MaxSelect: 1,
			Values:    []string{"pending", "sent", "failed", "skipped"},
		},
		&core.NumberField{Name: "attempts"},
		&core.TextField{Name: "last_error"},
		&core.DateField{Name: "sent_at"},
	)
	// 幂等键：同一用户同一天同一类型只发一次
	collection.AddIndex("idx_notification_deliveries_key", true, "user, local_date, kind", "")
	return collection
}

// app_settings 是全局键值表，不归属任何用户：目前放服务端自动生成的 VAPID 密钥。
func newAppSettingsCollection() *core.Collection {
	collection := core.NewBaseCollection("app_settings")
	// 只有服务端（管理员上下文）能读写，客户端一律拒绝。
	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	collection.Fields.Add(
		&core.TextField{Name: "key", Required: true},
		&core.TextField{Name: "value", Required: true},
	)
	collection.AddIndex("idx_app_settings_key", true, "key", "")
	return collection
}
