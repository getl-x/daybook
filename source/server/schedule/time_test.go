package schedule

import (
	"testing"
	"time"
)

func shanghai(t *testing.T) *time.Location {
	t.Helper()
	location, err := LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("载入 Asia/Shanghai 失败：%v", err)
	}
	return location
}

func utc(t *testing.T, raw string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("解析时间 %s 失败：%v", raw, err)
	}
	return parsed
}

// 铁律 1：日界之前算前一天。这是整个应用最核心的一条规则——
// 凌晨写日记必须落回前一天，否则"今日页"会在半夜突然翻篇。
func TestDiaryDateRespectsDayStartHour(t *testing.T) {
	location := shanghai(t)

	cases := []struct {
		name    string
		instant string
		want    ISODate
	}{
		{"本地 03:59 算前一天", "2026-09-09T19:59:00Z", "2026-09-09"},
		{"本地 04:00 算当天", "2026-09-09T20:00:00Z", "2026-09-10"},
		{"本地 12:00 算当天", "2026-09-10T04:00:00Z", "2026-09-10"},
		{"本地 23:59 算当天", "2026-09-10T15:59:00Z", "2026-09-10"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := DiaryDate(utc(t, testCase.instant), location, DefaultDayStartHour)
			if err != nil {
				t.Fatalf("DiaryDate 出错：%v", err)
			}
			if got != testCase.want {
				t.Errorf("DiaryDate(%s) = %s，期望 %s", testCase.instant, got, testCase.want)
			}
		})
	}
}

func TestDiaryDateRejectsBadDayStartHour(t *testing.T) {
	location := shanghai(t)
	for _, hour := range []int{-1, 7} {
		if _, err := DiaryDate(time.Now(), location, hour); err == nil {
			t.Errorf("dayStartHour=%d 应当报错，但没有", hour)
		}
	}
}

// 铁律 3a：春季跳变——目标墙上时间不存在时顺延一个跳变间隔。
// America/New_York 2026-03-08 02:30 不存在（02:00 直接跳到 03:00 EDT），
// 期望落在 03:30 EDT = 07:30 UTC。
func TestResolveLocalSpringForward(t *testing.T) {
	location, err := LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("载入 America/New_York 失败：%v", err)
	}

	got, err := ResolveLocal("2026-03-08", "02:30", location)
	if err != nil {
		t.Fatalf("ResolveLocal 出错：%v", err)
	}

	want := utc(t, "2026-03-08T07:30:00Z")
	if !got.Equal(want) {
		t.Errorf("春季跳变解析 = %s，期望 %s（即本地 03:30 EDT）", got.UTC(), want)
	}
	if local := got.In(location); local.Hour() != 3 || local.Minute() != 30 {
		t.Errorf("本地墙上时间 = %s，期望 03:30", local.Format("15:04"))
	}
}

// 铁律 3b：秋季回拨——该墙上时间出现两次时取**较早**的那一次。
// America/New_York 2026-11-01 01:30 出现两次：01:30 EDT(05:30Z) 与 01:30 EST(06:30Z)，
// 期望取 05:30 UTC。
func TestResolveLocalFallBackPicksEarlier(t *testing.T) {
	location, err := LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("载入 America/New_York 失败：%v", err)
	}

	got, err := ResolveLocal("2026-11-01", "01:30", location)
	if err != nil {
		t.Fatalf("ResolveLocal 出错：%v", err)
	}

	want := utc(t, "2026-11-01T05:30:00Z")
	if !got.Equal(want) {
		t.Errorf("秋季回拨解析 = %s，期望较早的一次 %s", got.UTC(), want)
	}
}

// 非跳变日必须是唯一解，别把上面的特例逻辑误伤到平常日子。
func TestResolveLocalUnambiguousDay(t *testing.T) {
	location := shanghai(t)
	got, err := ResolveLocal("2026-09-13", "09:00", location)
	if err != nil {
		t.Fatalf("ResolveLocal 出错：%v", err)
	}
	if want := utc(t, "2026-09-13T01:00:00Z"); !got.Equal(want) {
		t.Errorf("ResolveLocal = %s，期望 %s", got.UTC(), want)
	}
}

func TestNextFireAtAlwaysStrictlyFuture(t *testing.T) {
	location := shanghai(t)

	// 凌晨 03:00 仍属前一天的日记日，但 09:00 提醒应落在**当天自然日的 09:00**。
	got, err := NextFireAt(utc(t, "2026-09-12T19:00:00Z"), location, "09:00", DefaultDayStartHour)
	if err != nil {
		t.Fatalf("NextFireAt 出错：%v", err)
	}
	if want := utc(t, "2026-09-13T01:00:00Z"); !got.Equal(want) {
		t.Errorf("凌晨查询 09:00 提醒 = %s，期望当天 09:00 = %s", got.UTC(), want)
	}

	// now 恰好等于触发时刻 → 顺延到次日，避免原地重复触发。
	exact := utc(t, "2026-09-13T01:00:00Z")
	next, err := NextFireAt(exact, location, "09:00", DefaultDayStartHour)
	if err != nil {
		t.Fatalf("NextFireAt 出错：%v", err)
	}
	if !next.After(exact) {
		t.Errorf("now 等于触发时刻时应顺延到未来，得到 %s", next.UTC())
	}
	if want := utc(t, "2026-09-14T01:00:00Z"); !next.Equal(want) {
		t.Errorf("顺延结果 = %s，期望 %s", next.UTC(), want)
	}
}

func TestAddDaysCrossesMonthAndYear(t *testing.T) {
	cases := []struct {
		from ISODate
		days int
		want ISODate
	}{
		{"2026-09-01", -1, "2026-08-31"},
		{"2026-12-31", 1, "2027-01-01"},
		{"2024-02-28", 1, "2024-02-29"}, // 闰年
		{"2026-02-28", 1, "2026-03-01"},
	}
	for _, testCase := range cases {
		got, err := AddDays(testCase.from, testCase.days)
		if err != nil {
			t.Fatalf("AddDays(%s, %d) 出错：%v", testCase.from, testCase.days, err)
		}
		if got != testCase.want {
			t.Errorf("AddDays(%s, %d) = %s，期望 %s", testCase.from, testCase.days, got, testCase.want)
		}
	}
}

func TestMonthRangeIsHalfOpen(t *testing.T) {
	start, end, err := MonthRange("2026-09")
	if err != nil {
		t.Fatalf("MonthRange 出错：%v", err)
	}
	if start != "2026-09-01" || end != "2026-10-01" {
		t.Errorf("MonthRange(2026-09) = [%s, %s)，期望 [2026-09-01, 2026-10-01)", start, end)
	}

	// 跨年
	start, end, err = MonthRange("2026-12")
	if err != nil {
		t.Fatalf("MonthRange 出错：%v", err)
	}
	if start != "2026-12-01" || end != "2027-01-01" {
		t.Errorf("MonthRange(2026-12) = [%s, %s)，期望 [2026-12-01, 2027-01-01)", start, end)
	}

	if _, _, err := MonthRange("2026-13"); err == nil {
		t.Error("month=2026-13 应当报错，但没有")
	}
}

func TestParseClockRejectsOutOfRange(t *testing.T) {
	for _, raw := range []string{"24:00", "09:60", "9:00", ""} {
		if _, _, err := ParseClock(raw); err == nil {
			t.Errorf("ParseClock(%q) 应当报错，但没有", raw)
		}
	}
}

func TestLoadLocationRejectsUnknownZone(t *testing.T) {
	if _, err := LoadLocation("Mars/Olympus"); err == nil {
		t.Error("未知时区应当报错，但没有")
	}
}
