// Package diary 是日记领域：字段模型、校验、冲突判定与今日视图。
//
// 这是 Node 版 source/server/src/diary.ts 的 Go 移植，设计要点见
// DAYBOOK-DESIGN.zh-CN.md §4：
//   - **当天字段模型**：一条记录描述"这一天自己"，昨日回顾只是填写入口；
//   - **字段级写入**：PATCH 只提交变更字段，冲突按字段判（不是整行 LWW），
//     检测到冲突仍然写入（后写优先），但返回 overwritten=true 让前端提示；
//   - 完成状态是**派生**的（字段非空即完成），不存 completed_at。
package diary

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/getl-x/daybook/source/server/schedule"
)

// TextField 是日记正文字段名，与 PocketBase 集合 daily_entries 的列同名。
type TextField string

const (
	FieldDayEvents      TextField = "day_events"
	FieldDayMeals       TextField = "day_meals"
	FieldDayPlan        TextField = "day_plan"
	FieldEveningSummary TextField = "evening_summary"
)

// TextFields 是全部正文字段（顺序即前端展示顺序）。
var TextFields = []TextField{FieldDayEvents, FieldDayMeals, FieldDayPlan, FieldEveningSummary}

// ReviewFields 是"昨日回顾"要写的字段：早间页面写的是昨天那一行。
var ReviewFields = []TextField{FieldDayEvents, FieldDayMeals}

const (
	// MaxTextLength 单个正文上限（计划 §6.3）。
	MaxTextLength = 8000
	// MaxIncidentLength 单条突发事情上限。
	MaxIncidentLength = 2000
)

// UpdatedAtColumn 返回该字段对应的"最后写入时间"列名。
func (f TextField) UpdatedAtColumn() string { return string(f) + "_updated_at" }

// IsTextField 判断名字是否为合法正文字段。
func IsTextField(name string) bool {
	for _, field := range TextFields {
		if string(field) == name {
			return true
		}
	}
	return false
}

// Error 是领域校验错误，Code 直接映射为 HTTP 响应里的 error 字段。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func newError(code string, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// FieldState 是单个字段的当前值与最后写入时间。
type FieldState struct {
	Value     *string    `json:"value"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

// Entry 是"某一天"的完整视图。
type Entry struct {
	EntryDate schedule.ISODate         `json:"entryDate"`
	Exists    bool                     `json:"exists"`
	Version   int                      `json:"version"`
	Fields    map[TextField]FieldState `json:"fields"`
}

// PatchFieldResult 是字段级写入的结果。
type PatchFieldResult struct {
	FieldState
	Overwritten bool `json:"overwritten"`
}

// PatchResult 是一次 PATCH 的返回。
type PatchResult struct {
	EntryDate schedule.ISODate               `json:"entryDate"`
	Version   int                            `json:"version"`
	Fields    map[TextField]PatchFieldResult `json:"fields"`
}

// EmptyEntry 造一条"尚不存在"的空记录。
func EmptyEntry(entryDate schedule.ISODate) Entry {
	fields := make(map[TextField]FieldState, len(TextFields))
	for _, field := range TextFields {
		fields[field] = FieldState{}
	}
	return Entry{EntryDate: entryDate, Exists: false, Version: 0, Fields: fields}
}

// IsOverwritten 做字段级冲突判定：
//   - 客户端没带 baseUpdatedAt → 视为首次写入，不算冲突；
//   - 服务端还没有值 → 不算冲突；
//   - 服务端的写入时间比客户端的基准更新 → 冲突（仍然写入，但要告诉用户）。
func IsOverwritten(baseUpdatedAt *time.Time, currentUpdatedAt *time.Time) bool {
	if baseUpdatedAt == nil || currentUpdatedAt == nil {
		return false
	}
	return currentUpdatedAt.After(*baseUpdatedAt)
}

// NormalizeFieldValue 校验并归一化要写入的字段值：去尾空白、限长，允许空串（= 清空内容）。
func NormalizeFieldValue(field TextField, raw string) (string, error) {
	value := strings.TrimRight(raw, " \t\r\n")
	if len([]rune(value)) > MaxTextLength {
		return "", newError("too_long", "字段 %s 超长：最多 %d 个字符，收到 %d",
			field, MaxTextLength, len([]rune(value)))
	}
	return value, nil
}

// Progress 是今日页的进度（派生，不落库）。
type Progress struct {
	MorningDone bool `json:"morningDone"`
	EveningDone bool `json:"eveningDone"`
}

// ComputeProgress 计算今日进度：
// 早间 = 今天的 day_plan 已写；晚间 = 今天的 evening_summary 已写。
// 两边的"完成"都只看当天那一行——早间记录里已经没有"昨日回顾"了。
func ComputeProgress(today Entry) Progress {
	hasText := func(field TextField) bool {
		state, ok := today.Fields[field]
		return ok && state.Value != nil && strings.TrimSpace(*state.Value) != ""
	}
	return Progress{
		MorningDone: hasText(FieldDayPlan),
		EveningDone: hasText(FieldEveningSummary),
	}
}

// TodayMeta 是"今天"的服务端权威定义。
type TodayMeta struct {
	DiaryDate    schedule.ISODate `json:"diary_date"`
	Yesterday    schedule.ISODate `json:"yesterday"`
	Timezone     string           `json:"timezone"`
	DayStartHour int              `json:"day_start_hour"`
	ServerTime   string           `json:"server_time"`
	UserID       string           `json:"user_id"`
}

// TodayMetaFor 计算"今天"。
//
// 日记日按用户时区与日界算，**客户端不参与**——避免客户端时区错误导致串天（计划 §4.5）。
func TodayMetaFor(now time.Time, location *time.Location, timezone string, dayStartHour int, userID string) (TodayMeta, error) {
	date, err := schedule.DiaryDate(now, location, dayStartHour)
	if err != nil {
		return TodayMeta{}, err
	}
	return TodayMeta{
		DiaryDate:    date,
		Yesterday:    schedule.MustAddDays(date, -1),
		Timezone:     timezone,
		DayStartHour: dayStartHour,
		ServerTime:   now.UTC().Format(time.RFC3339Nano),
		UserID:       userID,
	}, nil
}

/* ------------------------------ 突发事情 ------------------------------ */

// Tag 是突发事情的分类。
type Tag string

const (
	TagWork    Tag = "work"
	TagLife    Tag = "life"
	TagEmotion Tag = "emotion"
	TagIdea    Tag = "idea"
	TagOther   Tag = "other"
)

// Tags 是全部合法分类（顺序即前端展示顺序）。
var Tags = []Tag{TagWork, TagLife, TagEmotion, TagIdea, TagOther}

// DefaultTag 是留空时的分类。
const DefaultTag = TagOther

// IsTag 判断是否为合法分类。
func IsTag(value string) bool {
	for _, tag := range Tags {
		if string(tag) == value {
			return true
		}
	}
	return false
}

// Incident 是一条突发事情。
type Incident struct {
	// ID 由客户端生成（重复提交天然幂等）。
	ID string `json:"id"`
	// EntryDate 是归属日记日，由服务端按 occurred_at + 时区 + 日界算。
	EntryDate  schedule.ISODate `json:"entryDate"`
	OccurredAt time.Time        `json:"occurredAt"`
	Content    string           `json:"content"`
	Tag        *string          `json:"tag"`
}

// 合理时间范围（2000-01-01 ~ 2100-01-01）。
//
// 为什么要卡：极端的 occurred_at 在算归属日时会让 SQLite/时间库产出畸形日期，
// 变成 500 并在库里留下脏数据。
var (
	minInstant = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	maxInstant = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
)

// IsReasonableInstant 判断发生时间是否落在合理范围内。
func IsReasonableInstant(instant time.Time) bool {
	return !instant.Before(minInstant) && !instant.After(maxInstant)
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// IncidentInput 是归一化后的突发事情写入参数。
type IncidentInput struct {
	ID         string
	OccurredAt time.Time
	Content    string
	Tag        string
}

// NormalizeIncidentInput 校验并归一化一条突发事情：
//   - id 由客户端生成（UUID）→ 重复提交天然幂等；
//   - content 必填、去首尾空白、≤ 2000 字；
//   - occurredAt 默认"现在"；
//   - tag 留空 → DefaultTag。
func NormalizeIncidentInput(id string, content string, occurredAt *time.Time, tag *string, now time.Time) (IncidentInput, error) {
	if !uuidPattern.MatchString(id) {
		return IncidentInput{}, newError("invalid_field", "id 必须是客户端生成的 UUID")
	}

	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return IncidentInput{}, newError("invalid_field", "content 不能为空")
	}
	if len([]rune(trimmed)) > MaxIncidentLength {
		return IncidentInput{}, newError("too_long", "突发事情内容最多 %d 个字符，收到 %d",
			MaxIncidentLength, len([]rune(trimmed)))
	}

	occurred := now
	if occurredAt != nil {
		if !IsReasonableInstant(*occurredAt) {
			return IncidentInput{}, newError("invalid_field", "occurred_at 必须在 2000–2100 年之间")
		}
		occurred = *occurredAt
	}

	resolvedTag := string(DefaultTag)
	if tag != nil && *tag != "" {
		if !IsTag(*tag) {
			return IncidentInput{}, newError("invalid_field", "tag 只能是 work / life / emotion / idea / other")
		}
		resolvedTag = *tag
	}

	return IncidentInput{ID: id, OccurredAt: occurred.UTC(), Content: trimmed, Tag: resolvedTag}, nil
}

// IncidentEntryDate 计算突发事情的归属日：按发生时间 + 用户时区 + 日界算
// （改时间跨日 → 归属日跟着变，计划 §5.4）。
func IncidentEntryDate(occurredAt time.Time, location *time.Location, dayStartHour int) (schedule.ISODate, error) {
	return schedule.DiaryDate(occurredAt, location, dayStartHour)
}

/* -------------------------------- 日历视图 -------------------------------- */

// CalendarDay 是日历上的一天。
type CalendarDay struct {
	Date schedule.ISODate `json:"date"`
	// HasContent 表示那天有没有任何正文（回顾/计划/总结任意一项非空）。
	HasContent    bool `json:"hasContent"`
	IncidentCount int  `json:"incidentCount"`
}

// CalendarView 是一个月的日历。
type CalendarView struct {
	Month string        `json:"month"`
	Days  []CalendarDay `json:"days"`
}
