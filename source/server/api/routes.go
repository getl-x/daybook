// Package api 提供 daybook 的 /v1/* HTTP 契约。
//
// 这一层是**刻意保持与 Node 版逐字一致**的：source/web 里的客户端
// （src/lib/api.ts）按这套契约写的，保持不变意味着前端无需跟着重写。
package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/getl-x/daybook/source/server/auth"
	"github.com/getl-x/daybook/source/server/diary"
	"github.com/getl-x/daybook/source/server/schedule"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// RouteConfig 是注册路由时需要的外部信息。
type RouteConfig struct {
	AppVersion      string
	DatabaseVersion string
}

// clock 便于测试注入；生产就是 time.Now。
var clock = time.Now

// RegisterRoutes 在 ServeEvent 上挂载全部路由。
func RegisterRoutes(event *core.ServeEvent, config RouteConfig) {
	router := event.Router

	router.GET("/healthz", func(request *core.RequestEvent) error {
		return request.JSON(http.StatusOK, map[string]any{
			"status":          "ok",
			"db":              "pocketbase",
			"time":            isoMillis(clock()),
			"appVersion":      config.AppVersion,
			"databaseVersion": config.DatabaseVersion,
		})
	})

	router.POST("/v1/auth/login", handleLogin)
	router.POST("/v1/auth/refresh", handleRefresh)
	router.POST("/v1/auth/logout", handleLogout)

	router.GET("/v1/meta/timezones", handleTimezones)
	router.GET("/v1/meta/today", handleMetaToday)

	router.GET("/v1/diaries/today", handleDiaryToday)
	router.GET("/v1/diaries/{date}", handleDiaryGet)
	router.PATCH("/v1/diaries/{date}", handleDiaryPatch)

	router.GET("/v1/incidents", handleIncidentList)
	router.POST("/v1/incidents", handleIncidentCreate)
	router.PATCH("/v1/incidents/{id}", handleIncidentUpdate)
	router.DELETE("/v1/incidents/{id}", handleIncidentDelete)

	router.GET("/v1/calendar", handleCalendar)

	router.GET("/v1/settings", handleSettingsGet)
	router.PATCH("/v1/settings", handleSettingsPatch)

	router.DELETE("/v1/account", handleAccountDelete)
}

/* ------------------------------- 认证 ------------------------------- */

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func handleLogin(event *core.RequestEvent) error {
	body := loginRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	limiter := loginLimiter()
	if !limiter.allow(body.Username, clock()) {
		return fail(event, http.StatusTooManyRequests, "too_many_attempts")
	}

	session, err := auth.Login(event.App, body.Username, body.Password, clock())
	switch {
	case errors.Is(err, auth.ErrInvalidCredentials):
		limiter.recordFailure(body.Username, clock())
		return fail(event, http.StatusUnauthorized, "invalid_credentials")
	case errors.Is(err, auth.ErrAccountDisabled):
		return fail(event, http.StatusForbidden, "account_disabled")
	case err != nil:
		return err
	}

	limiter.recordSuccess(body.Username)
	return event.JSON(http.StatusOK, renderSession(session))
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

func handleRefresh(event *core.RequestEvent) error {
	body := refreshRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	session, err := auth.Refresh(event.App, body.RefreshToken, clock())
	if errors.Is(err, auth.ErrAccountDisabled) {
		return fail(event, http.StatusForbidden, "account_disabled")
	}
	if err != nil {
		return fail(event, http.StatusUnauthorized, "unauthorized")
	}
	return event.JSON(http.StatusOK, renderSession(session))
}

func handleLogout(event *core.RequestEvent) error {
	body := refreshRequest{}
	// 请求体解析失败也照样回 200：登出的语义是"本地清干净"，
	// 不该因为一个格式不对的令牌把用户卡在登录态里。
	if err := event.BindBody(&body); err == nil {
		_ = auth.Logout(event.App, body.RefreshToken, clock())
	}
	return event.JSON(http.StatusOK, map[string]bool{"ok": true})
}

/* ------------------------------- 元信息 ------------------------------- */

func handleTimezones(event *core.RequestEvent) error {
	if _, err := requireUser(event); err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string][]string{"timezones": timezones()})
}

func handleMetaToday(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	_, meta, err := loadToday(event.App, user, clock())
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, meta)
}

/* ------------------------------- 日记 ------------------------------- */

type todayViewJSON struct {
	Meta      diary.TodayMeta `json:"meta"`
	Today     entryJSON       `json:"today"`
	Yesterday entryJSON       `json:"yesterday"`
	Incidents []incidentJSON  `json:"incidents"`
	Progress  diary.Progress  `json:"progress"`
}

func handleDiaryToday(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	_, meta, err := loadToday(event.App, user, clock())
	if err != nil {
		return err
	}

	todayRecord, err := findEntry(event.App, user.Id, meta.DiaryDate)
	if err != nil {
		return err
	}
	yesterdayRecord, err := findEntry(event.App, user.Id, meta.Yesterday)
	if err != nil {
		return err
	}
	incidents, err := incidentsForDate(event.App, user.Id, meta.DiaryDate)
	if err != nil {
		return err
	}

	today := entryFromRecord(todayRecord, meta.DiaryDate)
	return event.JSON(http.StatusOK, todayViewJSON{
		Meta:      meta,
		Today:     today,
		Yesterday: entryFromRecord(yesterdayRecord, meta.Yesterday),
		Incidents: incidents,
		Progress:  progressOf(today),
	})
}

func handleDiaryGet(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	date, err := requestDate(event)
	if err != nil {
		return err
	}

	record, err := findEntry(event.App, user.Id, date)
	if err != nil {
		return err
	}
	incidents, err := incidentsForDate(event.App, user.Id, date)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{
		"entry":     entryFromRecord(record, date),
		"incidents": incidents,
	})
}

type fieldPatchJSON struct {
	Value         string  `json:"value"`
	BaseUpdatedAt *string `json:"base_updated_at"`
}

type patchDiaryRequest struct {
	Fields map[string]fieldPatchJSON `json:"fields"`
}

type patchFieldResultJSON struct {
	Value       string `json:"value"`
	UpdatedAt   string `json:"updatedAt"`
	Overwritten bool   `json:"overwritten"`
}

type patchDiaryResponse struct {
	EntryDate string                          `json:"entryDate"`
	Version   int                             `json:"version"`
	Fields    map[string]patchFieldResultJSON `json:"fields"`
}

// handleDiaryPatch 做**字段级**写入：只提交变更的字段，冲突按字段判
// （不是整行 LWW）。检测到冲突仍然写入（后写优先），但返回 overwritten=true。
func handleDiaryPatch(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	date, err := requestDate(event)
	if err != nil {
		return err
	}

	body := patchDiaryRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	if len(body.Fields) == 0 {
		return fail(event, http.StatusBadRequest, "no_fields")
	}

	record, err := findEntry(event.App, user.Id, date)
	if err != nil {
		return err
	}
	if record == nil {
		collection, collectionErr := event.App.FindCollectionByNameOrId("daily_entries")
		if collectionErr != nil {
			return collectionErr
		}
		record = core.NewRecord(collection)
		record.Set("user", user.Id)
		record.Set("entry_date", string(date))
	}

	timestamp := clock()
	results := make(map[string]patchFieldResultJSON, len(body.Fields))

	for name, patch := range body.Fields {
		if !diary.IsTextField(name) {
			return fail(event, http.StatusBadRequest, "invalid_field")
		}
		field := diary.TextField(name)

		value, err := diary.NormalizeFieldValue(field, patch.Value)
		if err != nil {
			var domainError *diary.Error
			if errors.As(err, &domainError) {
				return fail(event, http.StatusBadRequest, domainError.Code)
			}
			return err
		}

		base, err := parseInstant(patch.BaseUpdatedAt)
		if err != nil {
			return fail(event, http.StatusBadRequest, "invalid_base_updated_at")
		}
		overwritten := diary.IsOverwritten(base, zeroIfEmpty(record.GetDateTime(field.UpdatedAtColumn()).Time()))

		record.Set(name, value)
		record.Set(field.UpdatedAtColumn(), timestamp)

		results[name] = patchFieldResultJSON{
			Value:       value,
			UpdatedAt:   isoMillis(timestamp),
			Overwritten: overwritten,
		}
	}

	record.Set("version", record.GetInt("version")+1)
	if err := event.App.Save(record); err != nil {
		return err
	}

	return event.JSON(http.StatusOK, patchDiaryResponse{
		EntryDate: string(date),
		Version:   record.GetInt("version"),
		Fields:    results,
	})
}

/* ------------------------------ 突发事情 ------------------------------ */

type incidentRequest struct {
	ID         string  `json:"id"`
	Content    string  `json:"content"`
	OccurredAt *string `json:"occurred_at"`
	Tag        *string `json:"tag"`
}

func handleIncidentCreate(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	body := incidentRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	occurredAt, err := parseInstant(body.OccurredAt)
	if err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	input, err := diary.NormalizeIncidentInput(body.ID, body.Content, occurredAt, body.Tag, clock())
	if err != nil {
		var domainError *diary.Error
		if errors.As(err, &domainError) {
			return fail(event, http.StatusBadRequest, domainError.Code)
		}
		return err
	}

	// 幂等：id 由客户端生成，重复提交直接返回已存在的那条。
	if existing, found := findIncidentByClientID(event.App, user.Id, input.ID); found {
		return event.JSON(http.StatusOK, map[string]any{
			"incident": incidentFromRecord(existing),
			"created":  false,
		})
	}

	context, _, err := loadToday(event.App, user, clock())
	if err != nil {
		return err
	}
	entryDate, err := diary.IncidentEntryDate(input.OccurredAt, context.Location, context.Settings.DayStartHour)
	if err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	collection, err := event.App.FindCollectionByNameOrId("incidents")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("user", user.Id)
	record.Set("client_id", input.ID)
	record.Set("entry_date", string(entryDate))
	record.Set("occurred_at", input.OccurredAt)
	record.Set("content", input.Content)
	record.Set("tag", input.Tag)
	if err := event.App.Save(record); err != nil {
		return err
	}

	return event.JSON(http.StatusOK, map[string]any{
		"incident": incidentFromRecord(record),
		"created":  true,
	})
}

type incidentPatchRequest struct {
	Content    *string `json:"content"`
	OccurredAt *string `json:"occurred_at"`
	Tag        *string `json:"tag"`
}

func handleIncidentUpdate(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	record, err := ownedIncident(event, user)
	if err != nil {
		return err
	}

	body := incidentPatchRequest{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	occurredAt := record.GetDateTime("occurred_at").Time()
	if body.OccurredAt != nil {
		parsed, parseErr := parseInstant(body.OccurredAt)
		if parseErr != nil || parsed == nil {
			return fail(event, http.StatusBadRequest, "invalid_field")
		}
		occurredAt = *parsed
	}

	tag := record.GetString("tag")
	if body.Tag != nil {
		tag = *body.Tag
	}

	// 复用同一套归一化：内容、时间、分类都要重新校验。
	input, err := diary.NormalizeIncidentInput(
		record.GetString("client_id"),
		pick(body.Content, record.GetString("content")),
		&occurredAt,
		&tag,
		clock(),
	)
	if err != nil {
		var domainError *diary.Error
		if errors.As(err, &domainError) {
			return fail(event, http.StatusBadRequest, domainError.Code)
		}
		return err
	}

	context, _, err := loadToday(event.App, user, clock())
	if err != nil {
		return err
	}
	// 改了发生时间就可能跨日 → 归属日跟着变（计划 §5.4）。
	entryDate, err := diary.IncidentEntryDate(input.OccurredAt, context.Location, context.Settings.DayStartHour)
	if err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	record.Set("entry_date", string(entryDate))
	record.Set("occurred_at", input.OccurredAt)
	record.Set("content", input.Content)
	record.Set("tag", input.Tag)
	if err := event.App.Save(record); err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{"incident": incidentFromRecord(record)})
}

func handleIncidentDelete(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	record, err := ownedIncident(event, user)
	if err != nil {
		return err
	}
	if err := event.App.Delete(record); err != nil {
		return err
	}
	return event.NoContent(http.StatusNoContent)
}

func handleIncidentList(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	date := event.Request.URL.Query().Get("date")
	if date == "" {
		_, meta, metaErr := loadToday(event.App, user, clock())
		if metaErr != nil {
			return metaErr
		}
		date = string(meta.DiaryDate)
	}
	if !isISODate(date) {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	incidents, err := incidentsForDate(event.App, user.Id, schedule.ISODate(date))
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{"incidents": incidents})
}

/* ------------------------------- 日历 ------------------------------- */

type calendarDayJSON struct {
	Date          string `json:"date"`
	HasContent    bool   `json:"hasContent"`
	IncidentCount int    `json:"incidentCount"`
}

func handleCalendar(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	month := event.Request.URL.Query().Get("month")
	start, end, err := schedule.MonthRange(month)
	if err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	entries, err := event.App.FindRecordsByFilter(
		"daily_entries",
		"user = {:user} && entry_date >= {:start} && entry_date < {:end}",
		"entry_date", 0, 0,
		dbx.Params{"user": user.Id, "start": string(start), "end": string(end)},
	)
	if err != nil {
		return err
	}
	incidents, err := event.App.FindRecordsByFilter(
		"incidents",
		"user = {:user} && entry_date >= {:start} && entry_date < {:end}",
		"occurred_at", 0, 0,
		dbx.Params{"user": user.Id, "start": string(start), "end": string(end)},
	)
	if err != nil {
		return err
	}

	// 稀疏输出：只列"有内容或有突发事情"的日子，日历只拿它做标记。
	days := make(map[string]*calendarDayJSON)
	pick := func(date string) *calendarDayJSON {
		if day, ok := days[date]; ok {
			return day
		}
		day := &calendarDayJSON{Date: date}
		days[date] = day
		return day
	}
	for _, entry := range entries {
		if entryHasContent(entry) {
			pick(entry.GetString("entry_date")).HasContent = true
		}
	}
	for _, incident := range incidents {
		pick(incident.GetString("entry_date")).IncidentCount++
	}

	ordered := make([]calendarDayJSON, 0, len(days))
	for cursor := start; cursor < end; cursor = schedule.MustAddDays(cursor, 1) {
		if day, ok := days[string(cursor)]; ok {
			ordered = append(ordered, *day)
		}
	}

	return event.JSON(http.StatusOK, map[string]any{"month": month, "days": ordered})
}

/* ------------------------------- 设置 ------------------------------- */

func handleSettingsGet(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	context, err := loadSettings(event.App, user.Id)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, renderSettings(context.Settings, nil, context.Subscriptions))
}

func handleSettingsPatch(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	body := map[string]any{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}

	context, err := loadSettings(event.App, user.Id)
	if err != nil {
		return err
	}
	record := context.Record

	// 逐项校验后才落库：宁可整个请求失败，也不要写进半套配置。
	if raw, ok := body["timezone"]; ok {
		timezone, isString := raw.(string)
		if !isString {
			return fail(event, http.StatusBadRequest, "invalid_field")
		}
		if _, err := schedule.LoadLocation(timezone); err != nil {
			return fail(event, http.StatusBadRequest, "invalid_timezone")
		}
		record.Set("timezone", timezone)
	}

	if raw, ok := body["day_start_hour"]; ok {
		hour, isNumber := toInt(raw)
		if !isNumber || schedule.AssertDayStartHour(hour) != nil {
			return fail(event, http.StatusBadRequest, "invalid_day_start_hour")
		}
		record.Set("day_start_hour", hour)
	}

	for _, mapping := range []struct{ key, column string }{
		{"reminder_morning_enabled", "morning_reminder_enabled"},
		{"reminder_evening_enabled", "evening_reminder_enabled"},
		{"reminder_only_if_incomplete", "notify_only_if_incomplete"},
		{"quiet_enabled", "quiet_enabled"},
	} {
		if err := applyBool(event, body, mapping.key, record, mapping.column); err != nil {
			return err
		}
	}

	for _, mapping := range []struct{ key, column string }{
		{"reminder_morning_time", "morning_reminder_time"},
		{"reminder_evening_time", "evening_reminder_time"},
		{"quiet_start", "quiet_start"},
		{"quiet_end", "quiet_end"},
	} {
		if err := applyClock(event, body, mapping.key, record, mapping.column); err != nil {
			return err
		}
	}

	// 静默时段开启时两端必须都有且不相同，否则窗口要么是空的、要么覆盖全天。
	if record.GetBool("quiet_enabled") {
		quietStart := record.GetString("quiet_start")
		quietEnd := record.GetString("quiet_end")
		if quietStart == "" || quietEnd == "" || quietStart == quietEnd {
			return fail(event, http.StatusBadRequest, "invalid_quiet_hours")
		}
	}

	if err := event.App.Save(record); err != nil {
		return err
	}

	updated, err := loadSettings(event.App, user.Id)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, renderSettings(updated.Settings, nil, updated.Subscriptions))
}

/* ------------------------------ 账号删除 ------------------------------ */

func handleAccountDelete(event *core.RequestEvent) error {
	user, err := requireUser(event)
	if err != nil {
		return err
	}
	body := struct {
		Password string `json:"password"`
	}{}
	if err := event.BindBody(&body); err != nil {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	if !user.ValidatePassword(body.Password) {
		return fail(event, http.StatusUnauthorized, "invalid_credentials")
	}

	timestamp := clock()
	// 进入 7 天宽限期：立刻吊销全部会话、清掉推送订阅，到期才真正清除数据。
	user.Set("status", "pending_deletion")
	user.Set("deletion_requested_at", timestamp)
	if err := event.App.Save(user); err != nil {
		return err
	}
	if err := auth.RevokeAllForUser(event.App, user.Id, timestamp); err != nil {
		return err
	}
	subscriptions, err := event.App.FindAllRecords("push_subscriptions", dbx.HashExp{"user": user.Id})
	if err != nil {
		return err
	}
	for _, subscription := range subscriptions {
		if err := event.App.Delete(subscription); err != nil {
			return err
		}
	}

	return event.NoContent(http.StatusNoContent)
}

/* ------------------------------- 小工具 ------------------------------- */

func loadToday(app core.App, user *core.Record, instant time.Time) (settingsContext, diary.TodayMeta, error) {
	context, err := loadSettings(app, user.Id)
	if err != nil {
		return settingsContext{}, diary.TodayMeta{}, err
	}
	meta, err := diary.TodayMetaFor(
		instant, context.Location, context.Settings.Timezone, context.Settings.DayStartHour, user.Id,
	)
	if err != nil {
		return settingsContext{}, diary.TodayMeta{}, err
	}
	return context, meta, nil
}

// findEntry 取某一天的日记行；没有就返回 (nil, nil) ——"不存在"是正常状态。
func findEntry(app core.App, userID string, date schedule.ISODate) (*core.Record, error) {
	records, err := app.FindRecordsByFilter(
		"daily_entries",
		"user = {:user} && entry_date = {:date}",
		"", 1, 0,
		dbx.Params{"user": userID, "date": string(date)},
	)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}
	return records[0], nil
}

func findIncidentByClientID(app core.App, userID string, clientID string) (*core.Record, bool) {
	records, err := app.FindRecordsByFilter(
		"incidents",
		"user = {:user} && client_id = {:clientId}",
		"", 1, 0,
		dbx.Params{"user": userID, "clientId": clientID},
	)
	if err != nil || len(records) == 0 {
		return nil, false
	}
	return records[0], true
}

func incidentsForDate(app core.App, userID string, date schedule.ISODate) ([]incidentJSON, error) {
	records, err := app.FindRecordsByFilter(
		"incidents",
		"user = {:user} && entry_date = {:date}",
		"occurred_at", 0, 0,
		dbx.Params{"user": userID, "date": string(date)},
	)
	if err != nil {
		return nil, err
	}
	return incidentsFromRecords(records), nil
}

// ownedIncident 取一条属于当前账号的突发事情。
//
// 归属校验不能只靠集合规则：那些规则管的是 PocketBase 自己的 REST 路由，
// 我们这些自定义 /v1 路由得自己判。别人的 id 一律按"不存在"处理，
// 免得泄露"这个 id 存在但不属于你"。
func ownedIncident(event *core.RequestEvent, user *core.Record) (*core.Record, error) {
	record, err := event.App.FindRecordById("incidents", event.Request.PathValue("id"))
	if err != nil || record.GetString("user") != user.Id {
		return nil, fail(event, http.StatusNotFound, "not_found")
	}
	return record, nil
}

func entryHasContent(record *core.Record) bool {
	for _, field := range diary.TextFields {
		if strings.TrimSpace(record.GetString(string(field))) != "" {
			return true
		}
	}
	return false
}

func progressOf(today entryJSON) diary.Progress {
	hasText := func(name string) bool {
		state, ok := today.Fields[name]
		return ok && state.Value != nil && strings.TrimSpace(*state.Value) != ""
	}
	return diary.Progress{
		MorningDone: hasText(string(diary.FieldDayPlan)),
		EveningDone: hasText(string(diary.FieldEveningSummary)),
	}
}

func requestDate(event *core.RequestEvent) (schedule.ISODate, error) {
	value := event.Request.PathValue("date")
	if !isISODate(value) {
		return "", fail(event, http.StatusBadRequest, "invalid_field")
	}
	return schedule.ISODate(value), nil
}

func parseInstant(raw *string) (*time.Time, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func zeroIfEmpty(instant time.Time) *time.Time {
	if instant.IsZero() {
		return nil
	}
	return &instant
}

func pick(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func toInt(raw any) (int, bool) {
	switch typed := raw.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	default:
		return 0, false
	}
}

func isISODate(value string) bool {
	_, _, _, err := schedule.ParseISODate(value)
	return err == nil
}

func applyBool(event *core.RequestEvent, body map[string]any, key string, record *core.Record, column string) error {
	raw, ok := body[key]
	if !ok {
		return nil
	}
	value, isBool := raw.(bool)
	if !isBool {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	record.Set(column, value)
	return nil
}

func applyClock(
	event *core.RequestEvent,
	body map[string]any,
	key string,
	record *core.Record,
	column string,
) error {
	raw, ok := body[key]
	if !ok {
		return nil
	}
	value, isString := raw.(string)
	if !isString {
		return fail(event, http.StatusBadRequest, "invalid_field")
	}
	// 空串是合法的：表示"没设过"，前端据此回落到默认时刻。
	if value != "" {
		if _, _, err := schedule.ParseClock(value); err != nil {
			return fail(event, http.StatusBadRequest, "invalid_time")
		}
	}
	record.Set(column, value)
	return nil
}
