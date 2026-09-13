package notifications

import (
	"testing"
	"time"
)

func shanghai(t *testing.T) *time.Location { return mustLocation(t, "Asia/Shanghai") }

func TestApplyQuietHoursPassesThroughWhenDisabled(t *testing.T) {
	quiet := QuietHours{Enabled: false, Start: "22:00", End: "07:00"}
	// 上海 2026-09-13 23:00 —— 落在窗口内，但静默关闭
	deliverAt := time.Date(2026, 9, 13, 15, 0, 0, 0, time.UTC)

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietDeliver {
		t.Fatalf("静默关闭应照常投递，得到 %s", got.Action)
	}
}

func TestApplyQuietHoursDeliversOutsideWindow(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "07:00"}
	// 上海 2026-09-13 12:00
	deliverAt := time.Date(2026, 9, 13, 4, 0, 0, 0, time.UTC)

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietDeliver {
		t.Fatalf("窗口外应照常投递，得到 %s", got.Action)
	}
}

// 跨午夜窗口的推迟：窗口 22:00–02:30、日界 06:00，
// 上海 09-13 23:00 推迟到次日 02:30，未越过下一个日界（09-14 06:00）→ 推迟
func TestApplyQuietHoursDefersAcrossMidnightBeforeDayBoundary(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "02:30"}
	deliverAt := time.Date(2026, 9, 13, 15, 0, 0, 0, time.UTC) // 上海 09-13 23:00

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 6)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietDefer {
		t.Fatalf("期望 defer，得到 %s（reason=%s）", got.Action, got.Reason)
	}
	want := time.Date(2026, 9, 13, 18, 30, 0, 0, time.UTC) // 次日上海 02:30
	if got.At == nil || !got.At.Equal(want) {
		t.Fatalf("期望推迟到 %v，得到 %v", want, got.At)
	}
}

// 同一窗口但日界提前到 02:00：推迟到次日 02:30 已越过下一个日界 → 跳过。
// 这条与上一条从两侧钉住"越过下一个日界就跳过"这条规则。
func TestApplyQuietHoursSkipsWhenDeferCrossesNextDayBoundary(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "02:30"}
	deliverAt := time.Date(2026, 9, 13, 15, 0, 0, 0, time.UTC) // 上海 09-13 23:00

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 2)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietSkip {
		t.Fatalf("越过下一日界应跳过，得到 %s（at=%v）", got.Action, got.At)
	}
	if got.Reason != "quiet_hours" {
		t.Errorf("跳过原因应为 quiet_hours，得到 %q", got.Reason)
	}
}

// 跨午夜窗口的午夜后那一段：上海 09-13 01:00 落在 [00:00,02:30)，
// 推迟到当天 02:30，未越过该日记日（09-12）的下一个日界（09-13 06:00）→ 推迟
func TestApplyQuietHoursDefersAfterMidnightToSameDayEnd(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "02:30"}
	deliverAt := time.Date(2026, 9, 12, 17, 0, 0, 0, time.UTC) // 上海 09-13 01:00

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 6)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietDefer {
		t.Fatalf("期望 defer，得到 %s（reason=%s）", got.Action, got.Reason)
	}
	want := time.Date(2026, 9, 12, 18, 30, 0, 0, time.UTC) // 当天上海 02:30
	if got.At == nil || !got.At.Equal(want) {
		t.Fatalf("期望推迟到 %v，得到 %v", want, got.At)
	}
}

// 午夜后那一段同样受日界约束：日界 02:00 时，
// 上海 09-13 01:00 属于日记日 09-12，推迟到 02:30 已越过 09-13 02:00 日界 → 跳过
func TestApplyQuietHoursSkipsAfterMidnightSegmentBeyondBoundary(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "02:30"}
	deliverAt := time.Date(2026, 9, 12, 17, 0, 0, 0, time.UTC) // 上海 09-13 01:00

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 2)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietSkip {
		t.Fatalf("越过下一日界应跳过，得到 %s（at=%v）", got.Action, got.At)
	}
}

// 半开区间 [start, end)：恰好等于 end 不算在窗口内
func TestApplyQuietHoursEndIsExclusive(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "07:00"}
	deliverAt := time.Date(2026, 9, 12, 23, 0, 0, 0, time.UTC) // 上海 09-13 07:00

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietDeliver {
		t.Fatalf("窗口右端是开区间，应照常投递，得到 %s", got.Action)
	}
}

// 推迟超过 12 小时 → 跳过（此例未越过日界，单独验证 12 小时上限）
func TestApplyQuietHoursSkipsWhenDeferTooLong(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "08:00", End: "22:00"}
	deliverAt := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC) // 上海 09:00，推迟到 22:00 = 13 小时

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietSkip {
		t.Fatalf("推迟 13 小时应跳过，得到 %s", got.Action)
	}
	if got.Reason != "quiet_hours" {
		t.Errorf("跳过原因应为 quiet_hours，得到 %q", got.Reason)
	}
}

// 不跨午夜的小窗口：窗口 01:00–05:00、日界 04:00，
// 上海 09-13 01:30 推迟到 05:00，而所属日记日 09-12 的下一个日界是 09-13 04:00 → 跳过
func TestApplyQuietHoursSkipsWhenCrossingNextDayBoundary(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "01:00", End: "05:00"}
	deliverAt := time.Date(2026, 9, 12, 17, 30, 0, 0, time.UTC) // 上海 09-13 01:30

	got, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got.Action != QuietSkip {
		t.Fatalf("越过下一个日界应跳过，得到 %s（at=%v）", got.Action, got.At)
	}
}

func TestApplyQuietHoursRejectsBadClock(t *testing.T) {
	deliverAt := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)
	for _, quiet := range []QuietHours{
		{Enabled: true, Start: "8:00", End: "22:00"},
		{Enabled: true, Start: "08:00", End: "22:60"},
		{Enabled: true, Start: "08:00", End: "25:00"},
	} {
		if _, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 4); err == nil {
			t.Errorf("非法窗口 %+v 应报错", quiet)
		}
	}
}

func TestApplyQuietHoursRejectsBadDayStartHour(t *testing.T) {
	quiet := QuietHours{Enabled: true, Start: "22:00", End: "07:00"}
	deliverAt := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)

	if _, err := ApplyQuietHours(deliverAt, quiet, shanghai(t), 9); err == nil {
		t.Fatal("日界越界应报错（合法范围是 0–6）")
	}
}
