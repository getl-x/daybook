package notifications

import (
	"fmt"
	"time"

	"github.com/getl-x/daybook/source/server/schedule"
)

// QuietHours 是用户设置的静默时段。
//
// 窗口语义是半开区间 [Start, End)，允许跨午夜：End <= Start 时表示
// 从前一天的 Start 延续到当天的 End。
type QuietHours struct {
	Enabled bool
	Start   string
	End     string
}

// QuietAction 是静默时段的判定结果。
type QuietAction string

const (
	// QuietDeliver 表示不在窗口内，照常投递。
	QuietDeliver QuietAction = "deliver"
	// QuietDefer 表示推迟到窗口结束（At 给出新的投递时刻）。
	QuietDefer QuietAction = "defer"
	// QuietSkip 表示推迟得太晚，当天不再打扰（At 给出本应推迟到的时刻，供日志）。
	QuietSkip QuietAction = "skip"
)

// QuietDecision 是一次判定。
type QuietDecision struct {
	Action QuietAction
	At     *time.Time
	Reason string
}

// MaxDefer 是推迟上限：晚于原定时刻这么久就不发了，
// 避免"当天的提醒一路拖到快第二天"。
const MaxDefer = 12 * time.Hour

// ApplyQuietHours 判断原定投递时刻是否落在静默窗口内并给出处置。
//
// 时区/日界/DST 全部交给 schedule 包，不在这里手写偏移。
func ApplyQuietHours(
	deliverAt time.Time,
	quiet QuietHours,
	location *time.Location,
	dayStartHour int,
) (QuietDecision, error) {
	if !quiet.Enabled {
		return QuietDecision{Action: QuietDeliver}, nil
	}
	if err := schedule.AssertDayStartHour(dayStartHour); err != nil {
		return QuietDecision{}, err
	}

	startHour, startMinute, err := schedule.ParseClock(quiet.Start)
	if err != nil {
		return QuietDecision{}, fmt.Errorf("静默时段起点非法：%w", err)
	}
	endHour, endMinute, err := schedule.ParseClock(quiet.End)
	if err != nil {
		return QuietDecision{}, fmt.Errorf("静默时段终点非法：%w", err)
	}

	startMinutes := startHour*60 + startMinute
	endMinutes := endHour*60 + endMinute

	local := deliverAt.In(location)
	localDate := schedule.FormatISODate(local.Year(), int(local.Month()), local.Day())
	currentMinutes := local.Hour()*60 + local.Minute()

	// 半开区间 [start, end)；跨午夜时切成 [start, 24:00) ∪ [0, end) 两段
	crossesMidnight := endMinutes <= startMinutes
	inWindow := currentMinutes >= startMinutes && currentMinutes < endMinutes
	if crossesMidnight {
		inWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes
	}
	if !inWindow {
		return QuietDecision{Action: QuietDeliver}, nil
	}

	// 窗口结束落在哪一天：跨午夜且当前处于午夜前那一段 → 次日；否则当天
	endDate := localDate
	if crossesMidnight && currentMinutes >= startMinutes {
		endDate, err = schedule.AddDays(localDate, 1)
		if err != nil {
			return QuietDecision{}, err
		}
	}
	at, err := schedule.ResolveLocal(endDate, quiet.End, location)
	if err != nil {
		return QuietDecision{}, err
	}

	// 推迟太晚就不发了：超过上限，或越过该条目所属日记日的下一个日界
	diaryDay, err := schedule.DiaryDate(deliverAt, location, dayStartHour)
	if err != nil {
		return QuietDecision{}, err
	}
	nextDiaryDay, err := schedule.AddDays(diaryDay, 1)
	if err != nil {
		return QuietDecision{}, err
	}
	nextBoundary, err := schedule.ResolveLocal(
		nextDiaryDay,
		fmt.Sprintf("%02d:00", dayStartHour),
		location,
	)
	if err != nil {
		return QuietDecision{}, err
	}

	if at.Sub(deliverAt) > MaxDefer || !at.Before(nextBoundary) {
		return QuietDecision{Action: QuietSkip, At: &at, Reason: "quiet_hours"}, nil
	}
	return QuietDecision{Action: QuietDefer, At: &at}, nil
}
