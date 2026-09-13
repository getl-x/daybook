// 通知与推送的 HTTP 契约（5 条路由 + /v1/notifications/status）。
//
// 逐字段对齐 source/web/src/lib/api.ts 与 push.ts：前端不改一行是这次重写的
// 前提，所以字段名、可空性、错误码都以客户端读的为准。
package api

import (
	"net/http"

	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/pocketbase/core"
)

const (
	// subscriptionLabelMax 与客户端 SUBSCRIPTION_LABEL_MAX 同名同值：
	// 设备名是客户端按 UA 拼出来的，超长就截断（schema 的 Max 是 64，
	// 对外契约按 40 说）。
	subscriptionLabelMax = 40
	// recentDeliveryLimit 与 Node 版 listReminderDeliveries(userId, 10) 一致。
	recentDeliveryLimit = 10
)

/* ------------------------------ 上报订阅 ------------------------------ */

type subscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	Label    string `json:"label"`
	Platform string `json:"platform"`
}

func handleSubscriptionCreate(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	body := subscriptionRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	if body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	// platform 是可选字段；一旦给了就必须在白名单里，否则前端会拿到一个
	// 永远不被发送的订阅（schema 的 SelectField 会静默丢弃非法值）。
	if body.Platform != "" && !isPlatform(body.Platform) {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	id, err := store.UpsertSubscription(event.App, user.Id, store.SubscriptionInput{
		Endpoint: body.Endpoint,
		P256dh:   body.Keys.P256dh,
		Auth:     body.Keys.Auth,
		Label:    truncateRunes(body.Label, subscriptionLabelMax),
		Platform: body.Platform,
	})
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{
		"subscription": map[string]any{"id": id},
	})
}

/* ------------------------------ 订阅列表 ------------------------------ */

func handleSubscriptionList(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	subscriptions, err := store.ListSubscriptions(event.App, user.Id, false)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{
		"subscriptions": renderSubscriptions(subscriptions),
	})
}

/* --------------------------- 单台设备开关 --------------------------- */

func handleSubscriptionPatch(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	body := map[string]any{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	raw, ok := body["enabled"]
	if !ok {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	enabled, isBool := raw.(bool)
	if !isBool {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	id := event.Request.PathValue("id")
	updated, err := store.SetSubscriptionEnabled(event.App, user.Id, id, enabled)
	if err != nil {
		return err
	}
	if !updated {
		//「不存在」与「不属于本人」刻意同形：不泄露这条订阅是否存在。
		return fail(event, http.StatusNotFound, "not_found")
	}

	subscription, err := subscriptionByID(event.App, user.Id, id)
	if err != nil {
		return err
	}
	if subscription == nil {
		return fail(event, http.StatusNotFound, "not_found")
	}
	return event.JSON(http.StatusOK, map[string]any{
		"subscription": renderSubscription(*subscription),
	})
}

/* ------------------------------ 删除订阅 ------------------------------ */

func handleSubscriptionDelete(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	deleted, err := store.DeleteSubscription(event.App, user.Id, event.Request.PathValue("id"))
	if err != nil {
		return err
	}
	if !deleted {
		return fail(event, http.StatusNotFound, "not_found")
	}
	return event.NoContent(http.StatusNoContent)
}

/* ------------------------------ 推送状态 ------------------------------ */

type subscriptionJSON struct {
	ID           string  `json:"id"`
	Label        *string `json:"label"`
	Platform     *string `json:"platform"`
	Enabled      bool    `json:"enabled"`
	CreatedAt    string  `json:"created_at"`
	FailureCount int     `json:"failure_count"`
}

type deliveryJSON struct {
	LocalDate string  `json:"local_date"`
	Kind      string  `json:"kind"`
	Status    string  `json:"status"`
	Attempts  int     `json:"attempts"`
	LastError *string `json:"last_error"`
}

type statusRemindersJSON struct {
	MorningTime string `json:"morning_time"`
	EveningTime string `json:"evening_time"`
}

type notificationStatusJSON struct {
	VAPIDPublicKey   *string             `json:"vapid_public_key"`
	PushConfigured   bool                `json:"push_configured"`
	Subscriptions    []subscriptionJSON  `json:"subscriptions"`
	RecentDeliveries []deliveryJSON      `json:"recent_deliveries"`
	Reminders        statusRemindersJSON `json:"reminders"`
}

// handleNotificationStatus 组装设置页的推送状态。
//
// vapidPublicKey 经闭包从 RouteConfig 传进来（见 RegisterRoutes）：
// 公钥在启动时解析一次，不给路由注册引入包级可变状态。
func handleNotificationStatus(event *core.RequestEvent, vapidPublicKey *string) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	context, err := loadSettings(event.App, user.Id)
	if err != nil {
		return err
	}
	subscriptions, err := store.ListSubscriptions(event.App, user.Id, false)
	if err != nil {
		return err
	}
	deliveries, err := store.ListDeliveries(event.App, user.Id, recentDeliveryLimit)
	if err != nil {
		return err
	}

	recent := make([]deliveryJSON, 0, len(deliveries))
	for _, delivery := range deliveries {
		recent = append(recent, deliveryJSON{
			LocalDate: delivery.LocalDate,
			Kind:      delivery.Kind,
			Status:    delivery.Status,
			Attempts:  delivery.Attempts,
			LastError: nilIfEmpty(delivery.LastError),
		})
	}

	return event.JSON(http.StatusOK, notificationStatusJSON{
		VAPIDPublicKey: vapidPublicKey,
		// push_configured 与公钥同源：没有公钥就等于推送没配好，
		// 前端据此禁用"开启每日提醒"。
		PushConfigured:   vapidPublicKey != nil,
		Subscriptions:    renderSubscriptions(subscriptions),
		RecentDeliveries: recent,
		Reminders: statusRemindersJSON{
			MorningTime: context.Settings.MorningReminderTime,
			EveningTime: context.Settings.EveningReminderTime,
		},
	})
}

/* ------------------------------- 小工具 ------------------------------- */

func renderSubscriptions(subscriptions []store.SubscriptionRecord) []subscriptionJSON {
	items := make([]subscriptionJSON, 0, len(subscriptions))
	for _, subscription := range subscriptions {
		items = append(items, renderSubscription(subscription))
	}
	return items
}

func renderSubscription(subscription store.SubscriptionRecord) subscriptionJSON {
	return subscriptionJSON{
		ID:    subscription.ID,
		Label: nilIfEmpty(subscription.Label),
		// 空平台对外是 null，不是空串（api.ts 里是 string | null）
		Platform:     nilIfEmpty(subscription.Platform),
		Enabled:      !subscription.Disabled,
		CreatedAt:    isoMillis(subscription.CreatedAt),
		FailureCount: subscription.FailureCount,
	}
}

// subscriptionByID 从该用户的订阅里取出指定 id 的那条；没有返回 nil。
//
// 走列表而不是再往 store 加一个查询函数：订阅数是个位数，而共用一份字段映射
// 能避免两处渲染形状漂移。
func subscriptionByID(app core.App, userID string, id string) (*store.SubscriptionRecord, error) {
	subscriptions, err := store.ListSubscriptions(app, userID, false)
	if err != nil {
		return nil, err
	}
	for index := range subscriptions {
		if subscriptions[index].ID == id {
			return &subscriptions[index], nil
		}
	}
	return nil, nil
}

func nilIfEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// isPlatform 校验 platform 白名单，与 schema 的 SelectField 取值一致。
func isPlatform(value string) bool {
	switch value {
	case "web", "ios-pwa", "android":
		return true
	default:
		return false
	}
}
