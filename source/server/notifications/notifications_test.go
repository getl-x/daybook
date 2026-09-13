package notifications

import (
	"testing"
	"time"
)

func mustLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("载入时区 %s 失败：%v", name, err)
	}
	return location
}

func TestComputeNextFireReturnsNilWhenDisabled(t *testing.T) {
	location := mustLocation(t, "Asia/Shanghai")
	now := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)

	got, err := ComputeNextFire(false, "09:00", location, 4, now)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got != nil {
		t.Fatalf("关闭的提醒应返回 nil，得到 %v", got)
	}
}

func TestComputeNextFirePicksTodayWhenStillAhead(t *testing.T) {
	location := mustLocation(t, "Asia/Shanghai")
	// 上海时间 2026-09-13 08:00，09:00 还没到
	now := time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)

	got, err := ComputeNextFire(true, "09:00", location, 4, now)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	want := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC) // 上海 09:00
	if !got.Equal(want) {
		t.Fatalf("期望 %v，得到 %v", want, *got)
	}
}

func TestComputeNextFireRollsToTomorrowWhenAlreadyPassed(t *testing.T) {
	location := mustLocation(t, "Asia/Shanghai")
	// 上海时间 2026-09-13 22:00，当天 09:00 已过
	now := time.Date(2026, 9, 13, 14, 0, 0, 0, time.UTC)

	got, err := ComputeNextFire(true, "09:00", location, 4, now)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	want := time.Date(2026, 9, 14, 1, 0, 0, 0, time.UTC) // 次日上海 09:00
	if !got.Equal(want) {
		t.Fatalf("期望 %v，得到 %v", want, *got)
	}
}

// 春季跳变：America/New_York 在 2026-03-08 02:00 EST → 03:00 EDT。
// 09:00 那一档当天已过（now 是 09:30 EDT），下一次应是次日 09:00 EDT = 13:00Z。
func TestComputeNextFireAcrossSpringForward(t *testing.T) {
	location := mustLocation(t, "America/New_York")
	now := time.Date(2026, 3, 8, 13, 30, 0, 0, time.UTC) // 09:30 EDT

	got, err := ComputeNextFire(true, "09:00", location, 4, now)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	want := time.Date(2026, 3, 9, 13, 0, 0, 0, time.UTC) // 次日 09:00 EDT
	if !got.Equal(want) {
		t.Fatalf("期望 %v，得到 %v", want, *got)
	}
}

// 秋季重拨：America/New_York 在 2026-11-01 02:00 EDT → 01:00 EST。
// 01:30 出现两次，取较早的那一次（05:30Z = 01:30 EDT）。
func TestComputeNextFireAcrossFallBackPrefersEarlier(t *testing.T) {
	location := mustLocation(t, "America/New_York")
	now := time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC) // 00:00 EDT

	got, err := ComputeNextFire(true, "01:30", location, 4, now)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	want := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("期望 %v，得到 %v", want, *got)
	}
}

func TestReminderLocalDateUsesDayStartHour(t *testing.T) {
	location := mustLocation(t, "Asia/Shanghai")
	// 上海 2026-09-13 02:00，早于日界 04:00 → 归属前一天
	fireAt := time.Date(2026, 9, 12, 18, 0, 0, 0, time.UTC)

	got, err := ReminderLocalDate(fireAt, location, 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got != "2026-09-12" {
		t.Fatalf("期望 2026-09-12，得到 %s", got)
	}
}

func TestReminderLocalDateAfterDayStart(t *testing.T) {
	location := mustLocation(t, "Asia/Shanghai")
	// 上海 2026-09-13 09:00，晚于日界 04:00 → 归属当天
	fireAt := time.Date(2026, 9, 13, 1, 0, 0, 0, time.UTC)

	got, err := ReminderLocalDate(fireAt, location, 4)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if got != "2026-09-13" {
		t.Fatalf("期望 2026-09-13，得到 %s", got)
	}
}

func TestShouldSkipForCompletion(t *testing.T) {
	if !ShouldSkipForCompletion(KindMorning, true, false) {
		t.Error("早间：计划已写 → 应跳过")
	}
	if ShouldSkipForCompletion(KindMorning, false, true) {
		t.Error("早间：只看计划，晚间总结不该影响")
	}
	if !ShouldSkipForCompletion(KindEvening, false, true) {
		t.Error("晚间：总结已写 → 应跳过")
	}
	if ShouldSkipForCompletion(KindEvening, true, false) {
		t.Error("晚间：只看总结，今日计划不该影响")
	}
}

func TestReminderPayloadGuidesWithoutLeakingContent(t *testing.T) {
	for _, kind := range ReminderKinds {
		payload := ReminderPayload(kind)
		if payload.Title == "" || payload.Body == "" || payload.URL == "" || payload.Tag == "" {
			t.Fatalf("%s 的文案有字段为空：%+v", kind, payload)
		}
		if payload.URL != "/#/today" {
			t.Errorf("%s 的跳转地址应为 /#/today，得到 %s", kind, payload.URL)
		}
	}
	if ReminderPayload(KindMorning).Tag == ReminderPayload(KindEvening).Tag {
		t.Error("两种提醒的 tag 必须不同，否则通知会互相顶掉")
	}
}

func TestNormalizeLocalTime(t *testing.T) {
	got, err := NormalizeLocalTime("09:00", "morning_reminder_time")
	if err != nil || got != "09:00" {
		t.Fatalf("合法值应原样返回，得到 %q (err=%v)", got, err)
	}
	for _, bad := range []string{"9:00", "24:00", "09:60", "", "0900", "09:0"} {
		if _, err := NormalizeLocalTime(bad, "morning_reminder_time"); err == nil {
			t.Errorf("非法值 %q 应报错", bad)
		}
	}
}

func TestIsReminderKind(t *testing.T) {
	if !IsReminderKind("morning") || !IsReminderKind("evening") {
		t.Error("morning/evening 应被接受")
	}
	if IsReminderKind("noon") || IsReminderKind("") {
		t.Error("其他值应被拒绝")
	}
}
