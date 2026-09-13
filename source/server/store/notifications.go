package store

import (
	"database/sql"
	"errors"
	"sort"
	"time"

	"github.com/getl-x/daybook/source/server/notifications"
	"github.com/getl-x/daybook/source/server/schedule"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// FailureLimit 是订阅连续失败多少次后自动禁用（与 Node 版 FAILURE_LIMIT 一致）。
const FailureLimit = 10

/* ------------------------------ 日期归一 ------------------------------ */

// 这个仓库里有两类"日期"字段，归一方式不同，混用会导致写不进或过滤不中：
//
//   - reminder_schedule.next_fire_at 是 PocketBase 的 DateField，存
//     "2006-01-02 15:04:05.000Z"（UTC），零值存空串；
//   - notification_deliveries.local_date 是 text（见 migrations 的
//     dateField 助手：Min/Max=10、Pattern=^\d{4}-\d{2}-\d{2}$），存 "2026-09-13"。
//
// 下面两个函数分别对应这两类。

// dateFilterValue 归一 DateField 的过滤条件：过滤时必须用同一化后的字符串，
// 否则传进去的瞬间永远匹配不上库里存的那串。
func dateFilterValue(instant time.Time) string {
	return instant.UTC().Format(types.DefaultDateLayout)
}

// normalizeLocalDate 归一 notification_deliveries.local_date。
//
// 该字段是 text 而不是 DateField，库里存的就是 "2026-09-13"：set 与 filter
// 都必须用这个纯 ISO 串。若按 DateField 的 "2026-09-13 00:00:00.000Z" 去写，
// 既过不了 Pattern 校验，也永远过滤不中。
func normalizeLocalDate(localDate string) (string, error) {
	year, month, day, err := schedule.ParseISODate(localDate)
	if err != nil {
		return "", err
	}
	return string(schedule.FormatISODate(year, month, day)), nil
}

/* ----------------------------- app_settings ----------------------------- */

// GetAppSetting 读一条全局设置；found=false 表示键不存在。
func GetAppSetting(app core.App, key string) (string, bool, error) {
	record, err := app.FindFirstRecordByData("app_settings", "key", key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return record.GetString("value"), true, nil
}

// SetAppSetting 写入或覆盖一条全局设置。
func SetAppSetting(app core.App, key string, value string) error {
	record, err := app.FindFirstRecordByData("app_settings", "key", key)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection, err := app.FindCollectionByNameOrId("app_settings")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Set("key", key)
	}
	record.Set("value", value)
	return app.Save(record)
}

/* --------------------------- reminder_schedule --------------------------- */

// DueSchedule 是一条到期的提醒排程。
type DueSchedule struct {
	UserID     string
	Kind       notifications.ReminderKind
	NextFireAt time.Time
}

// SetSchedule 写入排程；at 为 nil 表示关闭（对应 Node 版写 null）。
//
// 排程按 (user, kind) 唯一：存在就更新，不存在才新建。
func SetSchedule(
	app core.App,
	userID string,
	kind notifications.ReminderKind,
	at *time.Time,
) error {
	record, err := app.FindFirstRecordByFilter(
		"reminder_schedule",
		"user = {:user} && kind = {:kind}",
		dbx.Params{"user": userID, "kind": string(kind)},
	)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection, err := app.FindCollectionByNameOrId("reminder_schedule")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
		record.Set("kind", string(kind))
	}
	if at == nil {
		record.Set("next_fire_at", nil)
	} else {
		record.Set("next_fire_at", at.UTC())
	}
	return app.Save(record)
}

// ListDueSchedules 取到期的排程，按触发时刻升序，最多 limit 条。
func ListDueSchedules(app core.App, now time.Time, limit int) ([]DueSchedule, error) {
	records, err := app.FindRecordsByFilter(
		"reminder_schedule",
		"next_fire_at != '' && next_fire_at <= {:now}",
		"next_fire_at",
		limit,
		0,
		dbx.Params{"now": dateFilterValue(now)},
	)
	if err != nil {
		return nil, err
	}
	due := make([]DueSchedule, 0, len(records))
	for _, record := range records {
		due = append(due, DueSchedule{
			UserID:     record.GetString("user"),
			Kind:       notifications.ReminderKind(record.GetString("kind")),
			NextFireAt: record.GetDateTime("next_fire_at").Time(),
		})
	}
	return due, nil
}

/* ------------------------ notification_deliveries ----------------------- */

// DeliveryState 是一条投递记录。
type DeliveryState struct {
	LocalDate string
	Kind      string
	Status    string
	Attempts  int
	LastError string
}

func findDelivery(
	app core.App,
	userID string,
	localDate string,
	kind notifications.ReminderKind,
) (*core.Record, error) {
	date, err := normalizeLocalDate(localDate)
	if err != nil {
		return nil, err
	}
	return app.FindFirstRecordByFilter(
		"notification_deliveries",
		"user = {:user} && local_date = {:date} && kind = {:kind}",
		dbx.Params{"user": userID, "date": date, "kind": string(kind)},
	)
}

// BeginDelivery 尝试为 (user, localDate, kind) 占位。
//
// 返回 true 表示"这次是我们第一次拿到这条记录"，false 表示已存在。
// 幂等由数据库的 UNIQUE(user, local_date, kind) 保证，不靠进程内状态；
// 冲突时重新查一次而不是匹配驱动的错误字符串，避免依赖报错文案。
func BeginDelivery(
	app core.App,
	userID string,
	localDate string,
	kind notifications.ReminderKind,
) (bool, error) {
	date, err := normalizeLocalDate(localDate)
	if err != nil {
		return false, err
	}
	collection, err := app.FindCollectionByNameOrId("notification_deliveries")
	if err != nil {
		return false, err
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("local_date", date)
	record.Set("kind", string(kind))
	record.Set("status", "pending")
	record.Set("attempts", 0)
	if err := app.Save(record); err == nil {
		return true, nil
	}

	// 插入失败：多半是唯一键冲突（已有记录），也可能真是别的问题。
	// 用一次重查把两者区分开——重查不到就把原始错误交出去。
	if _, findErr := findDelivery(app, userID, localDate, kind); findErr == nil {
		return false, nil
	}
	return false, err
}

// GetDelivery 读一条投递记录；没有返回 nil。
func GetDelivery(
	app core.App,
	userID string,
	localDate string,
	kind notifications.ReminderKind,
) (*DeliveryState, error) {
	record, err := findDelivery(app, userID, localDate, kind)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return deliveryFromRecord(record), nil
}

// FinishDelivery 收尾：写状态、递增尝试次数、记录失败原因。
func FinishDelivery(
	app core.App,
	userID string,
	localDate string,
	kind notifications.ReminderKind,
	status string,
	lastError string,
) error {
	record, err := findDelivery(app, userID, localDate, kind)
	if err != nil {
		return err
	}
	record.Set("status", status)
	record.Set("attempts", record.GetInt("attempts")+1)
	if lastError == "" {
		record.Set("last_error", nil)
	} else {
		record.Set("last_error", lastError)
	}
	if status == "sent" {
		record.Set("sent_at", time.Now().UTC())
	}
	return app.Save(record)
}

// ListDeliveries 取最近的投递记录（新的在前），最多 limit 条。
func ListDeliveries(app core.App, userID string, limit int) ([]DeliveryState, error) {
	records, err := app.FindRecordsByFilter(
		"notification_deliveries",
		"user = {:user}",
		"-local_date,kind",
		0,
		0,
		dbx.Params{"user": userID},
	)
	if err != nil {
		return nil, err
	}
	// local_date 是 text 型 ISO 日期（"2026-09-13"），不需要再截断。
	rows := make([]DeliveryState, 0, len(records))
	for _, record := range records {
		rows = append(rows, *deliveryFromRecord(record))
	}
	// 服务端再排一次序：kind 的字母序（evening < morning）不是业务序，
	// 同一天内固定成 morning 在前。
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].LocalDate != rows[j].LocalDate {
			return rows[i].LocalDate > rows[j].LocalDate
		}
		return rows[i].Kind < rows[j].Kind
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}

func deliveryFromRecord(record *core.Record) *DeliveryState {
	return &DeliveryState{
		LocalDate: record.GetString("local_date"),
		Kind:      record.GetString("kind"),
		Status:    record.GetString("status"),
		Attempts:  record.GetInt("attempts"),
		LastError: record.GetString("last_error"),
	}
}

/* --------------------------- push_subscriptions -------------------------- */

// SubscriptionRecord 是一条推送订阅。
type SubscriptionRecord struct {
	ID           string
	Endpoint     string
	P256dh       string
	Auth         string
	UserAgent    string
	Label        string
	Platform     string
	Disabled     bool
	FailureCount int
	CreatedAt    time.Time
}

// SubscriptionInput 是上报订阅时的入参。
type SubscriptionInput struct {
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
	Label     string
	Platform  string
}

// ListSubscriptions 列出该用户的订阅；onlyEnabled 为 true 时排除已停用的。
func ListSubscriptions(app core.App, userID string, onlyEnabled bool) ([]SubscriptionRecord, error) {
	records, err := app.FindAllRecords("push_subscriptions", dbx.HashExp{"user": userID})
	if err != nil {
		return nil, err
	}
	out := make([]SubscriptionRecord, 0, len(records))
	for _, record := range records {
		subscription := subscriptionFromRecord(record)
		if onlyEnabled && subscription.Disabled {
			continue
		}
		out = append(out, subscription)
	}
	return out, nil
}

func subscriptionFromRecord(record *core.Record) SubscriptionRecord {
	return SubscriptionRecord{
		ID:           record.Id,
		Endpoint:     record.GetString("endpoint"),
		P256dh:       record.GetString("p256dh"),
		Auth:         record.GetString("auth"),
		UserAgent:    record.GetString("user_agent"),
		Label:        record.GetString("label"),
		Platform:     record.GetString("platform"),
		Disabled:     !record.GetDateTime("disabled_at").IsZero(),
		FailureCount: record.GetInt("failure_count"),
		CreatedAt:    record.GetDateTime("created").Time(),
	}
}

// FindSubscription 按 id 找订阅；不存在返回 nil。
func FindSubscription(app core.App, id string) (*core.Record, error) {
	record, err := app.FindRecordById("push_subscriptions", id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return record, nil
}

// UpsertSubscription 上报订阅：同一 endpoint 复用同一行并刷新 last_seen_at。
//
// endpoint 全局唯一（idx_push_subscriptions_endpoint），因为浏览器换账号后
// endpoint 不变——同一台设备重新订阅必须落到原来那行，否则推送会重复。
func UpsertSubscription(app core.App, userID string, input SubscriptionInput) (string, error) {
	record, err := app.FindFirstRecordByData("push_subscriptions", "endpoint", input.Endpoint)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		collection, err := app.FindCollectionByNameOrId("push_subscriptions")
		if err != nil {
			return "", err
		}
		record = core.NewRecord(collection)
		record.Set("endpoint", input.Endpoint)
	}
	record.Set("user", userID)
	record.Set("p256dh", input.P256dh)
	record.Set("auth", input.Auth)
	record.Set("last_seen_at", time.Now().UTC())
	// 重新上报即视为恢复使用：清掉停用状态与失败计数
	record.Set("disabled_at", nil)
	if input.Label != "" {
		record.Set("label", input.Label)
	}
	if input.Platform != "" {
		record.Set("platform", input.Platform)
	}
	if input.UserAgent != "" {
		record.Set("user_agent", input.UserAgent)
	}
	if err := app.Save(record); err != nil {
		return "", err
	}
	return record.Id, nil
}

// SetSubscriptionEnabled 启用/停用订阅。
//
// 返回 false 表示"不存在或不属于本人"——两者刻意不区分，避免泄露存在性。
func SetSubscriptionEnabled(app core.App, userID string, id string, enabled bool) (bool, error) {
	record, err := FindSubscription(app, id)
	if err != nil {
		return false, err
	}
	if record == nil || record.GetString("user") != userID {
		return false, nil
	}
	if enabled {
		record.Set("disabled_at", nil)
	} else {
		record.Set("disabled_at", time.Now().UTC())
	}
	if err := app.Save(record); err != nil {
		return false, err
	}
	return true, nil
}

// DeleteSubscription 删除订阅；返回 false 表示不存在或不属于本人。
func DeleteSubscription(app core.App, userID string, id string) (bool, error) {
	record, err := FindSubscription(app, id)
	if err != nil {
		return false, err
	}
	if record == nil || record.GetString("user") != userID {
		return false, nil
	}
	if err := app.Delete(record); err != nil {
		return false, err
	}
	return true, nil
}

// RecordPushResult 回写发送结果（规则与 Node 版一致）：
//   - sent：清零计数并记 last_success_at；
//   - gone：立即禁用；
//   - failed：计数 +1，达到 FailureLimit 时禁用。
func RecordPushResult(app core.App, id string, outcome string, at time.Time) error {
	record, err := app.FindRecordById("push_subscriptions", id)
	if err != nil {
		return err
	}
	failures := record.GetInt("failure_count")
	disabled := !record.GetDateTime("disabled_at").IsZero()
	switch outcome {
	case "sent":
		record.Set("failure_count", 0)
		record.Set("last_success_at", at.UTC())
	case "gone":
		record.Set("failure_count", failures+1)
		if !disabled {
			record.Set("disabled_at", at.UTC())
		}
	default:
		failures++
		record.Set("failure_count", failures)
		if failures >= FailureLimit && !disabled {
			record.Set("disabled_at", at.UTC())
		}
	}
	return app.Save(record)
}

// CountActiveSubscriptions 统计该用户启用中的订阅数（设置页用）。
func CountActiveSubscriptions(app core.App, userID string) (int, error) {
	enabled, err := ListSubscriptions(app, userID, true)
	if err != nil {
		return 0, err
	}
	return len(enabled), nil
}
