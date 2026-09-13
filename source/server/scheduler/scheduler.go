// Package scheduler 是提醒调度：把一次 tick 的全部数据流串成可独立调用的函数。
//
// 刻意不依赖 cron：RunDue 可以被测试直接调用，注入假 Sender 与假时钟。cron 只是
// 在 app 层把它挂到每分钟（见 app/app.go）。
//
// 三条不变量（与 Node 版一致，顺序本身也是语义）：
//   - 幂等：唯一键 (user, local_date, kind) 保证重复 tick / 重启 / 多进程只打扰一次；
//   - 重试：失败**不**推进排程，下一分钟自然重试，attempts 到 MaxAttempts 才放弃；
//   - 隔离：单个用户出错只计入 Errors，绝不中断整轮——否则那一行会一直到期，
//     把其他人的提醒一起拖死。
package scheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/getl-x/daybook/source/server/applog"
	"github.com/getl-x/daybook/source/server/auth"
	"github.com/getl-x/daybook/source/server/diary"
	"github.com/getl-x/daybook/source/server/notifications"
	"github.com/getl-x/daybook/source/server/push"
	"github.com/getl-x/daybook/source/server/schedule"
	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	// MaxAttempts 是一条投递最多重试几次；到上限才放弃并推进排程。
	MaxAttempts = 3
	// DueBatch 是单次 tick 处理的到期排程上限。
	DueBatch = 200
	// sendTimeout 是单条推送请求的上限。
	//
	// 加这一层是因为 tick 是串行的：一个卡住的推送端点会拖住整轮的所有用户。
	// Node 版靠 fetch 的默认超时，行为等价但没有显式值。
	sendTimeout = 10 * time.Second
)

// Deps 是一次 tick 的全部依赖。
type Deps struct {
	App core.App
	// Sender 为 nil 表示 VAPID 密钥没解析出来：此时只记失败，不发请求。
	Sender push.Sender
	// Now 提供 tick 的"现在"；测试注入固定时钟。
	Now func() time.Time
	// Logf 记一行日志；为 nil 时走 applog（同时进 PocketBase 的 _logs 表与 stderr）。
	Logf func(level string, format string, args ...any)
	// Purge 顺手清理过了宽限期的待删除账号；为 nil 表示这一步不做。
	Purge func(now time.Time) (int, error)
}

// Report 是一次 tick 的结果，用于日志与测试断言。
type Report struct {
	Due                   int
	Sent                  int
	Skipped               int
	Failed                int
	Replayed              int
	Deferred              int
	DisabledSubscriptions int
	// Errors 是处理单条排程时抛错的次数（脏数据、数据库抖动），不影响其他用户。
	Errors int
}

// RunDue 跑完一轮到期提醒。
func RunDue(deps Deps) Report {
	now := deps.Now().UTC()
	report := Report{}

	// 账号删除的宽限期清理搭车在这一轮上，不另开定时任务。
	if deps.Purge != nil {
		purged, err := deps.Purge(now)
		if err != nil {
			report.Errors++
			logf(deps, "error", "清理待删除账号失败：%v", err)
		} else if purged > 0 {
			logf(deps, "info", "已清除宽限期到期的账号：%d 个", purged)
		}
	}

	due, err := store.ListDueSchedules(deps.App, now, DueBatch)
	if err != nil {
		report.Errors++
		logf(deps, "error", "列出到期排程失败：%v", err)
		return report
	}
	report.Due = len(due)

	for _, item := range due {
		// 每个用户单独隔离：某人的脏数据不能中断整轮。
		if err := processSchedule(deps, item, now, &report); err != nil {
			report.Errors++
			logf(deps, "error", "处理排程失败，已跳过（下一分钟再试）：user=%s kind=%s err=%v",
				item.UserID, item.Kind, err)
		}
	}
	return report
}

// RescheduleUser 按该用户当前设置重算两种提醒的下一次触发时刻。
//
// 改时间/改时区/开关提醒之后调用；GET /v1/settings 也会调它做自愈——
// 老账号可能还没有排程行（Node 版注释里的同一理由）。
func RescheduleUser(app core.App, userID string, now time.Time) error {
	record, err := store.Ensure(app, userID)
	if err != nil {
		return err
	}
	settings := store.Read(record)
	location, err := settings.Location()
	if err != nil {
		return err
	}
	for _, kind := range notifications.ReminderKinds {
		at, err := notifications.ComputeNextFire(
			kindEnabled(settings, kind),
			kindClock(settings, kind),
			location,
			settings.DayStartHour,
			now,
		)
		if err != nil {
			return err
		}
		if err := store.SetSchedule(app, userID, kind, at); err != nil {
			return err
		}
	}
	return nil
}

// processSchedule 处理一条到期排程。返回的 error 由调用方计入 Report.Errors。
func processSchedule(deps Deps, item store.DueSchedule, now time.Time, report *Report) error {
	user, err := deps.App.FindRecordById("users", item.UserID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if user == nil || auth.Status(user) != "active" {
		// 停用 / 待删除账号不该继续收到提醒：直接停掉排程，不做推进计算。
		return store.SetSchedule(deps.App, item.UserID, item.Kind, nil)
	}

	settingsRecord, err := store.Ensure(deps.App, item.UserID)
	if err != nil {
		return err
	}
	settings := store.Read(settingsRecord)
	location, err := settings.Location()
	if err != nil {
		return err
	}
	localDate, err := notifications.ReminderLocalDate(item.NextFireAt, location, settings.DayStartHour)
	if err != nil {
		return err
	}
	date := string(localDate)

	// 0) 静默时段：仅在还没有任何投递记录时才评估——已经进入重试的提醒
	//    不该被再次推迟。defer 复用现有排程与幂等键，不新开一套状态。
	existing, err := store.GetDelivery(deps.App, item.UserID, date, item.Kind)
	if err != nil {
		return err
	}
	if existing == nil {
		decision, err := notifications.ApplyQuietHours(
			item.NextFireAt,
			notifications.QuietHours{
				Enabled: settings.QuietEnabled,
				Start:   settings.QuietStart,
				End:     settings.QuietEnd,
			},
			location,
			settings.DayStartHour,
		)
		if err != nil {
			return err
		}
		if decision.Action == notifications.QuietDefer && decision.At != nil {
			if err := store.SetSchedule(deps.App, item.UserID, item.Kind, decision.At); err != nil {
				return err
			}
			report.Deferred++
			logf(deps, "info", "提醒落在静默时段，推迟到窗口结束：user=%s kind=%s at=%s",
				item.UserID, item.Kind, decision.At.UTC().Format(time.RFC3339))
			return nil
		}
		if decision.Action == notifications.QuietSkip {
			if _, err := store.BeginDelivery(deps.App, item.UserID, date, item.Kind); err != nil {
				return err
			}
			if err := store.FinishDelivery(deps.App, item.UserID, date, item.Kind, "skipped", decision.Reason); err != nil {
				return err
			}
			report.Skipped++
			logf(deps, "info", "提醒落在静默时段且推迟过晚，当天跳过：user=%s kind=%s", item.UserID, item.Kind)
			return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
		}
	}

	// 1) 幂等占位：重复 tick、重启、多进程都只会产生一条记录。
	firstTime, err := store.BeginDelivery(deps.App, item.UserID, date, item.Kind)
	if err != nil {
		return err
	}
	if !firstTime {
		current, err := store.GetDelivery(deps.App, item.UserID, date, item.Kind)
		if err != nil {
			return err
		}
		finished := current == nil || current.Status == "sent" || current.Status == "skipped"
		if finished || current.Attempts >= MaxAttempts {
			report.Replayed++
			return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
		}
		logf(deps, "info", "重试上一次失败的提醒：user=%s kind=%s attempts=%d",
			item.UserID, item.Kind, current.Attempts)
	}

	// 2) 仅未完成时提醒：发送前再查一次内容，与今日页用同一套派生规则。
	if settings.NotifyOnlyIfIncomplete {
		progress, err := dayProgress(deps.App, item.UserID, localDate)
		if err != nil {
			return err
		}
		if notifications.ShouldSkipForCompletion(item.Kind, progress.MorningDone, progress.EveningDone) {
			if err := store.FinishDelivery(deps.App, item.UserID, date, item.Kind, "skipped", ""); err != nil {
				return err
			}
			report.Skipped++
			return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
		}
	}

	// 3) 发送给该用户全部启用中的订阅。
	subscriptions, err := store.ListSubscriptions(deps.App, item.UserID, true)
	if err != nil {
		return err
	}
	if deps.Sender == nil || len(subscriptions) == 0 {
		reason := "没有可用的推送订阅"
		if deps.Sender == nil {
			reason = "未配置 VAPID 密钥"
		}
		if err := store.FinishDelivery(deps.App, item.UserID, date, item.Kind, "failed", reason); err != nil {
			return err
		}
		report.Failed++
		logf(deps, "warn", "提醒没有发出：%s user=%s kind=%s", reason, item.UserID, item.Kind)
		// 配置类问题重试没有意义 → 直接推进到下一个周期。
		return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
	}

	payload, err := json.Marshal(notifications.ReminderPayload(item.Kind))
	if err != nil {
		return err
	}

	delivered, failedHere, goneHere := 0, 0, 0
	firstError := ""
	for _, subscription := range subscriptions {
		ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
		result := deps.Sender.Send(ctx, push.Subscription{
			Endpoint: subscription.Endpoint,
			P256dh:   subscription.P256dh,
			Auth:     subscription.Auth,
		}, payload)
		cancel()
		if err := store.RecordPushResult(deps.App, subscription.ID, string(result.Status), now); err != nil {
			return err
		}
		switch result.Status {
		case push.StatusSent:
			delivered++
		case push.StatusGone:
			goneHere++
		default:
			failedHere++
		}
		// 只留第一条失败的原因（形如 "HTTP 410"）。汇总里不带状态码就分不出
		// "订阅真没了"还是"VAPID 密钥轮换"（见设计 §6 D1），而这两者的处置
		// 完全不同：前者让用户在设置页重订，后者要先查密钥。
		if result.Status != push.StatusSent && firstError == "" {
			firstError = result.Error
		}
	}
	report.DisabledSubscriptions += goneHere

	if delivered > 0 {
		if err := store.FinishDelivery(deps.App, item.UserID, date, item.Kind, "sent", ""); err != nil {
			return err
		}
		report.Sent++
		logf(deps, "info", "提醒已发送：user=%s kind=%s delivered=%d gone=%d",
			item.UserID, item.Kind, delivered, goneHere)
		return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
	}

	// 全部失败：通常留在队列里等下一 tick 重试（attempts 到上限自然推进）；
	// 但如果已经没有可用订阅了（都在刚才被判失效），重试没有意义 → 直接推进。
	remaining, err := store.ListSubscriptions(deps.App, item.UserID, true)
	if err != nil {
		return err
	}
	lastError := fmt.Sprintf("%d 个订阅发送失败，%d 个已失效", failedHere, goneHere)
	if firstError != "" {
		lastError += "（" + firstError + "）"
	}
	if err := store.FinishDelivery(deps.App, item.UserID, date, item.Kind, "failed", lastError); err != nil {
		return err
	}
	report.Failed++
	reason := firstError
	if reason == "" {
		reason = "无"
	}
	logf(deps, "warn", "提醒发送失败，稍后重试：user=%s kind=%s failed=%d gone=%d 首个原因=%s",
		item.UserID, item.Kind, failedHere, goneHere, reason)
	if len(remaining) == 0 {
		return advance(deps, item.UserID, item.Kind, date, settings, location, now, report)
	}
	return nil
}

// advance 把排程推到下一个触发时刻（严格大于 now）。
func advance(
	deps Deps,
	userID string,
	kind notifications.ReminderKind,
	handledLocalDate string,
	settings store.Settings,
	location *time.Location,
	now time.Time,
	report *Report,
) error {
	next, err := notifications.ComputeNextFire(
		kindEnabled(settings, kind),
		kindClock(settings, kind),
		location,
		settings.DayStartHour,
		now,
	)
	if err != nil {
		return err
	}
	if err := store.SetSchedule(deps.App, userID, kind, next); err != nil {
		return err
	}
	nextText := "null"
	if next != nil {
		nextText = next.UTC().Format(time.RFC3339)
	}
	// 带上刚处理过的日记日与累计计数：排查"为什么没收到提醒"时这条日志最有用。
	logf(deps, "info", "排程已推进：user=%s kind=%s handledLocalDate=%s nextFireAt=%s sent=%d skipped=%d failed=%d",
		userID, kind, handledLocalDate, nextText, report.Sent, report.Skipped, report.Failed)
	return nil
}

// dayProgress 读该日记日的完成度。
//
// 刻意重建 diary.Entry 再交给 diary.ComputeProgress，而不是在这里判空串：
// "从未写过"与"写过但清空了"的区分规则只该有一处（见 diary 包与今日页）。
func dayProgress(app core.App, userID string, date schedule.ISODate) (diary.Progress, error) {
	record, err := app.FindFirstRecordByFilter(
		"daily_entries",
		"user = {:user} && entry_date = {:date}",
		dbx.Params{"user": userID, "date": string(date)},
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return diary.ComputeProgress(diary.EmptyEntry(date)), nil
		}
		return diary.Progress{}, err
	}

	entry := diary.EmptyEntry(date)
	entry.Exists = true
	for _, field := range diary.TextFields {
		// updated_at 为空 = 从未写过，value 该保持 nil；
		// 只看空串会把"从未写过"和"写过又清空"混为一谈。
		if record.GetDateTime(field.UpdatedAtColumn()).IsZero() {
			continue
		}
		value := record.GetString(string(field))
		entry.Fields[field] = diary.FieldState{Value: &value}
	}
	return diary.ComputeProgress(entry), nil
}

func kindEnabled(settings store.Settings, kind notifications.ReminderKind) bool {
	if kind == notifications.KindMorning {
		return settings.MorningReminderEnabled
	}
	return settings.EveningReminderEnabled
}

func kindClock(settings store.Settings, kind notifications.ReminderKind) string {
	if kind == notifications.KindMorning {
		return settings.MorningReminderTime
	}
	return settings.EveningReminderTime
}

// logf 记一行日志。默认走 applog（同时进 PocketBase 的 _logs 表与 stderr），
// 测试可以注入 Deps.Logf 把日志收进内存。
func logf(deps Deps, level string, format string, args ...any) {
	if deps.Logf != nil {
		deps.Logf(level, format, args...)
		return
	}
	applog.Logf(deps.App, applog.Level(level), format, args...)
}
