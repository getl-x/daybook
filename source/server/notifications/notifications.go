// Package notifications 是提醒与推送的领域逻辑：只管纯计算，不碰数据库。
//
// 与 Node 版 src/notifications.ts 一一对应。分层理由：时区/DST/日界这类分支
// 最容易错，放在没有 core.App 的包里才能穷举测试。
package notifications

import (
	"fmt"
	"regexp"
	"time"

	"github.com/getl-x/daybook/source/server/schedule"
)

// ReminderKind 是提醒类型。取值与 PocketBase 集合的 SelectField 白名单一致。
type ReminderKind string

const (
	KindMorning ReminderKind = "morning"
	KindEvening ReminderKind = "evening"
)

// ReminderKinds 是全部提醒类型，顺序固定（早、晚）。
var ReminderKinds = []ReminderKind{KindMorning, KindEvening}

// IsReminderKind 校验来自请求的提醒类型。
func IsReminderKind(value string) bool {
	return value == string(KindMorning) || value == string(KindEvening)
}

// Payload 是推送给 Service Worker 的内容。
//
// 只发引导文案：正文永远不进通知（开发计划 §10）。字段名与
// source/web/public/sw.js 里读的键一致。
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

// ReminderPayload 返回该类型的通知文案。
func ReminderPayload(kind ReminderKind) Payload {
	if kind == KindMorning {
		return Payload{
			Title: "早上好",
			Body:  "想想今天都要做什么，写两句就够了。",
			URL:   "/#/today",
			Tag:   "daybook-morning",
		}
	}
	return Payload{
		Title: "今天过得怎么样？",
		Body:  "写几句总结，给今天画上句号。",
		URL:   "/#/today",
		Tag:   "daybook-evening",
	}
}

// ComputeNextFire 求下一次触发时刻；提醒关闭时返回 nil。
//
// 真正的计算在 schedule.NextFireAt（时区 + 日界 + DST 都在那里处理），
// 这里只负责"关掉就不排程"这一条业务规则。
func ComputeNextFire(
	enabled bool,
	clock string,
	location *time.Location,
	dayStartHour int,
	now time.Time,
) (*time.Time, error) {
	if !enabled {
		return nil, nil
	}
	next, err := schedule.NextFireAt(now, location, clock, dayStartHour)
	if err != nil {
		return nil, err
	}
	return &next, nil
}

// ReminderLocalDate 计算这次提醒归属的日记日。
//
// 早晚两次提醒的触发时刻都落在当天日界之后，归属日相同，
// 所以这里不需要 kind 参数。
func ReminderLocalDate(
	fireAt time.Time,
	location *time.Location,
	dayStartHour int,
) (schedule.ISODate, error) {
	return schedule.DiaryDate(fireAt, location, dayStartHour)
}

// ShouldSkipForCompletion 实现"仅未完成时提醒"：
// 早间看【今天的计划】，晚间看【今天的总结】。
//
// 两个布尔来自 diary.ComputeProgress —— 刻意复用今日页那套派生规则，
// 而不是在这里自己判断字段是否为空，否则两处会各自漂移。
func ShouldSkipForCompletion(kind ReminderKind, morningDone bool, eveningDone bool) bool {
	if kind == KindMorning {
		return morningDone
	}
	return eveningDone
}

var clockPattern = regexp.MustCompile(`^\d{2}:\d{2}$`)

// NormalizeLocalTime 校验 'HH:MM' 并在入库前拦住脏数据。
func NormalizeLocalTime(raw string, field string) (string, error) {
	if !clockPattern.MatchString(raw) {
		return "", fmt.Errorf("%s 必须是 HH:MM 格式，收到 %q", field, raw)
	}
	hour := int(raw[0]-'0')*10 + int(raw[1]-'0')
	minute := int(raw[3]-'0')*10 + int(raw[4]-'0')
	if hour > 23 || minute > 59 {
		return "", fmt.Errorf("%s 不是合法时间：%s", field, raw)
	}
	return raw, nil
}
