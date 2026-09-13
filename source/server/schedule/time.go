// Package schedule 计算"日记日"与提醒触发时刻。
//
// 这是 Node 版 source/shared/src/time.ts 的 Go 移植，规则见
// DAYBOOK-DESIGN.zh-CN.md §5。三条铁律原样保留：
//  1. "日记日"从本地时间 dayStartHour（默认 04:00）起算，04:00 之前的写入归属前一天；
//  2. 时区一律用 IANA 名称（如 Asia/Shanghai），不使用固定偏移；
//  3. DST 安全——目标墙上时间不存在（春季跳变）时顺延一个跳变间隔；
//     存在两次（秋季回拨）时取较早的那一次。
//
// 第 3 条在 Node 版里是围绕 Intl 手写的探测逻辑；移植到 Go 时**不能直接依赖
// time.Date**——实测它在"不存在的墙上时间"上取的是跳变**之后**的偏移
// （America/New_York 2026-03-08 02:30 会解成 01:30 EST，比目标还早一小时），
// 与设计规则正好相反。因此这里照搬 Node 版的算法：向前后各探 12 小时取偏移，
// 再按"墙上时间是否自洽"挑候选。time_test.go 对春季跳变与秋季回拨各有断言。
package schedule

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// ISODate 形如 2026-09-13 的本地日期（不带时区）。
type ISODate string

const (
	// MinDayStartHour / MaxDayStartHour 与数据库里的 CHECK (day_start_hour BETWEEN 0 AND 6) 对齐。
	MinDayStartHour = 0
	MaxDayStartHour = 6
	// DefaultDayStartHour 是日界默认值（凌晨 4 点前算前一天）。
	DefaultDayStartHour = 4
)

var (
	datePattern  = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	monthPattern = regexp.MustCompile(`^(\d{4})-(\d{2})$`)
	clockPattern = regexp.MustCompile(`^(\d{2}):(\d{2})$`)
)

// FormatISODate 拼出 'YYYY-MM-DD'。
func FormatISODate(year, month, day int) ISODate {
	return ISODate(fmt.Sprintf("%04d-%02d-%02d", year, month, day))
}

// ParseISODate 解析 'YYYY-MM-DD'。
func ParseISODate(raw string) (year int, month int, day int, err error) {
	match := datePattern.FindStringSubmatch(raw)
	if match == nil {
		return 0, 0, 0, fmt.Errorf("不是合法的 ISODate：%s", raw)
	}
	year, _ = strconv.Atoi(match[1])
	month, _ = strconv.Atoi(match[2])
	day, _ = strconv.Atoi(match[3])
	return year, month, day, nil
}

// AddDays 做纯日历加减（在 UTC 里算，不受 DST 影响）。
func AddDays(date ISODate, days int) (ISODate, error) {
	year, month, day, err := ParseISODate(string(date))
	if err != nil {
		return "", err
	}
	shifted := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).AddDate(0, 0, days)
	return FormatISODate(shifted.Year(), int(shifted.Month()), shifted.Day()), nil
}

// MustAddDays 供内部已知合法的场景使用。
func MustAddDays(date ISODate, days int) ISODate {
	shifted, err := AddDays(date, days)
	if err != nil {
		panic(err)
	}
	return shifted
}

// AssertDayStartHour 校验日界取值。
func AssertDayStartHour(dayStartHour int) error {
	if dayStartHour < MinDayStartHour || dayStartHour > MaxDayStartHour {
		return fmt.Errorf("dayStartHour 必须是 %d–%d 的整数，收到 %d",
			MinDayStartHour, MaxDayStartHour, dayStartHour)
	}
	return nil
}

// LoadLocation 载入 IANA 时区；名字非法时给出明确错误。
func LoadLocation(name string) (*time.Location, error) {
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("不是合法的 IANA 时区：%s", name)
	}
	return location, nil
}

// ParseClock 解析 'HH:MM'，返回小时与分钟。
func ParseClock(raw string) (hour int, minute int, err error) {
	match := clockPattern.FindStringSubmatch(raw)
	if match == nil {
		return 0, 0, fmt.Errorf("不是合法的 LocalTime：%s", raw)
	}
	hour, _ = strconv.Atoi(match[1])
	minute, _ = strconv.Atoi(match[2])
	if hour > 23 || minute > 59 {
		return 0, 0, fmt.Errorf("越界的 LocalTime：%s", raw)
	}
	return hour, minute, nil
}

// DiaryDate 计算某个瞬间归属的"日记日"。
//
// 例（Asia/Shanghai，dayStartHour=4）：
//
//	本地 2026-09-10 03:59 → 2026-09-09
//	本地 2026-09-10 04:00 → 2026-09-10
func DiaryDate(instant time.Time, location *time.Location, dayStartHour int) (ISODate, error) {
	if err := AssertDayStartHour(dayStartHour); err != nil {
		return "", err
	}
	local := instant.In(location)
	calendarDate := FormatISODate(local.Year(), int(local.Month()), local.Day())
	if local.Hour() < dayStartHour {
		return AddDays(calendarDate, -1)
	}
	return calendarDate, nil
}

// dstProbe 是判断某个墙上时间是否存在/是否歧义时向前后各探的时长。
const dstProbe = 12 * time.Hour

// zoneOffsetMinutes 返回该时区在某个瞬间相对 UTC 的偏移（分钟，东八区为 +480）。
func zoneOffsetMinutes(instant time.Time, location *time.Location) int {
	_, offsetSeconds := instant.In(location).Zone()
	return offsetSeconds / 60
}

// ResolveLocal 把"某时区里的墙上时间"解析成绝对瞬间，DST 安全（见包注释第 3 条）。
func ResolveLocal(date ISODate, clock string, location *time.Location) (time.Time, error) {
	year, month, day, err := ParseISODate(string(date))
	if err != nil {
		return time.Time{}, err
	}
	hour, minute, err := ParseClock(clock)
	if err != nil {
		return time.Time{}, err
	}

	// 把目标墙上时间当作 UTC 读进来，作为"朴素"参照点。
	naiveUTC := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)
	offsetBefore := zoneOffsetMinutes(naiveUTC.Add(-dstProbe), location)
	offsetAfter := zoneOffsetMinutes(naiveUTC.Add(dstProbe), location)

	// 平常日子：偏移前后一致，唯一解。
	if offsetBefore == offsetAfter {
		return naiveUTC.Add(-time.Duration(offsetBefore) * time.Minute), nil
	}

	candidates := [2]time.Time{
		naiveUTC.Add(-time.Duration(offsetBefore) * time.Minute),
		naiveUTC.Add(-time.Duration(offsetAfter) * time.Minute),
	}

	// 秋季回拨：两个候选的墙上时间都等于目标值 → 取较早的那一次
	//（配合按"日记日"去重的幂等键，当天只发一次）。
	var earliest time.Time
	found := false
	for _, candidate := range candidates {
		local := candidate.In(location)
		if local.Year() != year || int(local.Month()) != month || local.Day() != day ||
			local.Hour() != hour || local.Minute() != minute {
			continue
		}
		if !found || candidate.Before(earliest) {
			earliest, found = candidate, true
		}
	}
	if found {
		return earliest, nil
	}

	// 春季跳变：目标墙上时间不存在。按跳变**前**的偏移解释 candidates[0]，
	// 结果即"顺延一个跳变间隔"之后（America/New_York 的 02:30 → 03:30 EDT）。
	return candidates[0], nil
}

// NextFireAt 求下一次提醒触发时刻（严格大于 now）。
//
// 以"当前日记日"为起点逐日推进，因此凌晨 03:00（仍属前一天日记日）
// 查 09:00 提醒，得到的是当天自然日的 09:00；now 恰好等于触发时刻时
// 顺延到次日，避免重复触发。
func NextFireAt(now time.Time, location *time.Location, clock string, dayStartHour int) (time.Time, error) {
	if _, _, err := ParseClock(clock); err != nil {
		return time.Time{}, err
	}
	date, err := DiaryDate(now, location, dayStartHour)
	if err != nil {
		return time.Time{}, err
	}
	for attempt := 0; attempt < 4; attempt++ {
		candidate, err := ResolveLocal(date, clock, location)
		if err != nil {
			return time.Time{}, err
		}
		if candidate.After(now) {
			return candidate, nil
		}
		date, err = AddDays(date, 1)
		if err != nil {
			return time.Time{}, err
		}
	}
	return time.Time{}, fmt.Errorf("无法计算下一次提醒时刻（超出 4 天仍未找到候选，请检查入参）")
}

// MonthRange 把 '2026-09' 展开成左闭右开的 [start, end)。
func MonthRange(month string) (start ISODate, end ISODate, err error) {
	match := monthPattern.FindStringSubmatch(month)
	if match == nil {
		return "", "", fmt.Errorf("month 必须是 YYYY-MM 格式，收到：%s", month)
	}
	year, _ := strconv.Atoi(match[1])
	monthNumber, _ := strconv.Atoi(match[2])
	if monthNumber < 1 || monthNumber > 12 || year < 1900 || year > 2200 {
		return "", "", fmt.Errorf("month 越界：%s", month)
	}
	nextYear, nextMonth := year, monthNumber+1
	if monthNumber == 12 {
		nextYear, nextMonth = year+1, 1
	}
	return FormatISODate(year, monthNumber, 1), FormatISODate(nextYear, nextMonth, 1), nil
}
