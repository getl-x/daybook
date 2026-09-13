// Package api 的支撑层：客户端的 JSON 形状、错误约定与账号解析。
//
// 所有响应形状都**刻意与 Node 版逐字段对齐**——source/web 里的
// src/lib/api.ts 就是按这些形状写的，对齐意味着前端不用改。
package api

import (
	_ "embed"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/getl-x/daybook/source/server/auth"
	"github.com/getl-x/daybook/source/server/diary"
	"github.com/getl-x/daybook/source/server/schedule"
	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

//go:embed timezones.txt
var timezoneList string

// timezones 返回可选的 IANA 时区列表。
//
// 这份清单是从 Go 工具链的 lib/time/zoneinfo.zip 生成的（见文件头），
// 因为 Go 没有 Intl.supportedValuesOf("timeZone") 那样的枚举 API。
// 已剔除 Etc/、SystemV/、US/ 等历史别名，但仍会包含 Asia/Calcutta 这类
// 同义写法——对"选一个时区"的用途足够了。
func timezones() []string {
	lines := strings.Split(timezoneList, "\n")
	zones := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			zones = append(zones, trimmed)
		}
	}
	return zones
}

// fail 按客户端约定的形状返回错误：{"error": "<code>"}。
// 前端的 toApiError 就是读 body.error 当错误码（invalid_credentials /
// unauthorized / not_found / no_fields …）。
func fail(event *core.RequestEvent, status int, code string) error {
	return event.JSON(status, map[string]string{"error": code})
}

// isoMillis 固定输出毫秒精度的 UTC 时间串。
//
// 不用 time.Time 默认的 RFC3339Nano：它会吐出 7 位小数（…3456639Z），
// 而 JS 的 Date Time String Format 只规定 3 位小数。前端要拿这个值
// 做 Date.parse 比较（字段级冲突判定），所以按规范给足 3 位。
func isoMillis(instant time.Time) string {
	return instant.UTC().Format("2006-01-02T15:04:05.000Z")
}

func isoMillisPtr(instant time.Time) *string {
	if instant.IsZero() {
		return nil
	}
	formatted := isoMillis(instant)
	return &formatted
}

// requireUser 解析 Authorization: Bearer <token> 并返回当前账号。
// 任何失败都返回 401 + {"error":"unauthorized"}——客户端据此触发刷新流程。
func requireUser(event *core.RequestEvent) (*core.Record, error) {
	const prefix = "bearer "
	header := event.Request.Header.Get("authorization")
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return nil, fail(event, http.StatusUnauthorized, "unauthorized")
	}
	record, err := event.App.FindAuthRecordByToken(strings.TrimSpace(header[len(prefix):]), core.TokenTypeAuth)
	if err != nil || !auth.IsUsable(record) {
		return nil, fail(event, http.StatusUnauthorized, "unauthorized")
	}
	return record, nil
}

/* ------------------------------ 会话形状 ------------------------------ */

type sessionUserJSON struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type sessionJSON struct {
	User             sessionUserJSON `json:"user"`
	AccessToken      string          `json:"accessToken"`
	ExpiresIn        int64           `json:"expiresIn"`
	RefreshToken     string          `json:"refreshToken"`
	RefreshExpiresAt string          `json:"refreshExpiresAt"`
}

func renderSession(session auth.Session) sessionJSON {
	return sessionJSON{
		User:             sessionUserJSON{ID: session.UserID, Username: session.Username},
		AccessToken:      session.AccessToken,
		ExpiresIn:        session.ExpiresIn,
		RefreshToken:     session.RefreshToken,
		RefreshExpiresAt: isoMillis(session.RefreshExpiresAt),
	}
}

/* ------------------------------ 日记形状 ------------------------------ */

type fieldStateJSON struct {
	Value     *string `json:"value"`
	UpdatedAt *string `json:"updatedAt"`
}

type entryJSON struct {
	EntryDate string                    `json:"entryDate"`
	Exists    bool                      `json:"exists"`
	Version   int                       `json:"version"`
	Fields    map[string]fieldStateJSON `json:"fields"`
}

type incidentJSON struct {
	ID         string  `json:"id"`
	EntryDate  string  `json:"entryDate"`
	OccurredAt string  `json:"occurredAt"`
	Content    string  `json:"content"`
	Tag        *string `json:"tag"`
}

// entryFromRecord 把库里的行翻译成客户端形状。
//
// "从未写过"与"写过但内容为空"要分得开：前者 value/updatedAt 都是 null，
// 后者 value 是空串。判断依据是 updated_at 列——PocketBase 的文本字段
// 空值统一是 ""，光看值区分不出来。
func entryFromRecord(record *core.Record, entryDate schedule.ISODate) entryJSON {
	entry := entryJSON{
		EntryDate: string(entryDate),
		Exists:    record != nil,
		Fields:    make(map[string]fieldStateJSON, len(diary.TextFields)),
	}
	if record == nil {
		for _, field := range diary.TextFields {
			entry.Fields[string(field)] = fieldStateJSON{}
		}
		return entry
	}

	entry.Version = record.GetInt("version")
	for _, field := range diary.TextFields {
		state := fieldStateJSON{}
		updatedAt := record.GetDateTime(field.UpdatedAtColumn())
		if !updatedAt.IsZero() {
			value := record.GetString(string(field))
			state.Value = &value
			state.UpdatedAt = isoMillisPtr(updatedAt.Time())
		}
		entry.Fields[string(field)] = state
	}
	return entry
}

func incidentFromRecord(record *core.Record) incidentJSON {
	incident := incidentJSON{
		// 对客户端暴露的是它自己生成的 UUID（client_id），不是 PocketBase 的主键：
		// 后者只有 15 位、且是服务端内部实现细节。
		ID:         record.GetString("client_id"),
		EntryDate:  record.GetString("entry_date"),
		OccurredAt: isoMillis(record.GetDateTime("occurred_at").Time()),
		Content:    record.GetString("content"),
	}
	if tag := record.GetString("tag"); tag != "" {
		incident.Tag = &tag
	}
	return incident
}

func incidentsFromRecords(records []*core.Record) []incidentJSON {
	incidents := make([]incidentJSON, 0, len(records))
	for _, record := range records {
		incidents = append(incidents, incidentFromRecord(record))
	}
	return incidents
}

/* ------------------------------ 设置形状 ------------------------------ */

type settingsJSON struct {
	Timezone     string           `json:"timezone"`
	DayStartHour int              `json:"day_start_hour"`
	Reminders    remindersJSON    `json:"reminders"`
	QuietHours   quietHoursJSON   `json:"quiet_hours"`
	Push         pushSettingsJSON `json:"push"`
}

type remindersJSON struct {
	MorningEnabled    bool   `json:"morning_enabled"`
	MorningTime       string `json:"morning_time"`
	EveningEnabled    bool   `json:"evening_enabled"`
	EveningTime       string `json:"evening_time"`
	OnlyIfIncomplete  bool   `json:"only_if_incomplete"`
}

type quietHoursJSON struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

type pushSettingsJSON struct {
	// 服务端没配 VAPID 时为 null（此时"开启每日提醒"不可用）。
	VAPIDPublicKey *string `json:"vapid_public_key"`
	Subscriptions  int     `json:"subscriptions"`
}

func renderSettings(settings store.Settings, vapidPublicKey *string, subscriptions int) settingsJSON {
	return settingsJSON{
		Timezone:     settings.Timezone,
		DayStartHour: settings.DayStartHour,
		Reminders: remindersJSON{
			MorningEnabled:   settings.MorningReminderEnabled,
			MorningTime:      settings.MorningReminderTime,
			EveningEnabled:   settings.EveningReminderEnabled,
			EveningTime:      settings.EveningReminderTime,
			OnlyIfIncomplete: settings.NotifyOnlyIfIncomplete,
		},
		QuietHours: quietHoursJSON{
			Enabled: settings.QuietEnabled,
			Start:   settings.QuietStart,
			End:     settings.QuietEnd,
		},
		Push: pushSettingsJSON{VAPIDPublicKey: vapidPublicKey, Subscriptions: subscriptions},
	}
}

// settingsContext 一次性取齐"渲染设置"需要的东西。
type settingsContext struct {
	Record        *core.Record
	Settings      store.Settings
	Location      *time.Location
	Subscriptions int
}

func loadSettings(app core.App, userID string) (settingsContext, error) {
	record, err := store.Ensure(app, userID)
	if err != nil {
		return settingsContext{}, err
	}
	settings := store.Read(record)
	location, err := schedule.LoadLocation(settings.Timezone)
	if err != nil {
		// 库里的时区不合法（多半是手工改过库）：退回默认值，别让整个应用打不开。
		settings.Timezone = store.DefaultTimezone
		location, err = schedule.LoadLocation(settings.Timezone)
		if err != nil {
			return settingsContext{}, err
		}
	}
	subscriptions, err := app.CountRecords("push_subscriptions", activeSubscriptionFilter(userID))
	if err != nil {
		return settingsContext{}, err
	}
	return settingsContext{Record: record, Settings: settings, Location: location, Subscriptions: int(subscriptions)}, nil
}

// activeSubscriptionFilter 只数"没被停用"的推送订阅。
// 停用沿用 disabled 日期列：为空串表示启用（与 Node 版 disabled_at IS NULL 等价）。
func activeSubscriptionFilter(userID string) dbx.HashExp {
	return dbx.HashExp{"user": userID, "disabled_at": ""}
}

// isNoRows 判断"没找到记录"这类错误（PocketBase 在无结果时返回 sql.ErrNoRows）。
func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
