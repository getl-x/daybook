package diary

import (
	"errors"
	"testing"
	"time"
)

func ptr(value string) *string { return &value }

func shanghai(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("载入 Asia/Shanghai 失败：%v", err)
	}
	return location
}

// 完成状态是**派生**的：只看当天那一行，不存 completed_at。
func TestComputeProgressIsDerivedFromText(t *testing.T) {
	entry := EmptyEntry("2026-09-13")
	if progress := ComputeProgress(entry); progress.MorningDone || progress.EveningDone {
		t.Errorf("空记录不该有完成项，得到 %+v", progress)
	}

	// 只有空白字符不算完成（trim 后为空）。
	entries := entry.Fields
	entries[FieldDayPlan] = FieldState{Value: ptr("   \n  ")}
	entry.Fields = entries
	if ComputeProgress(entry).MorningDone {
		t.Error("纯空白不该算作「计划已完成」")
	}

	entries[FieldDayPlan] = FieldState{Value: ptr("写点什么")}
	entries[FieldEveningSummary] = FieldState{Value: ptr("今天还行")}
	entry.Fields = entries
	progress := ComputeProgress(entry)
	if !progress.MorningDone || !progress.EveningDone {
		t.Errorf("字段非空应当完成，得到 %+v", progress)
	}
}

// 字段级冲突：服务端比客户端的基准更新才算冲突；缺基准不算。
func TestIsOverwritten(t *testing.T) {
	base := time.Date(2026, 9, 13, 10, 0, 0, 0, time.UTC)
	newer := base.Add(time.Hour)
	older := base.Add(-time.Hour)

	cases := []struct {
		name    string
		base    *time.Time
		current *time.Time
		want    bool
	}{
		{"客户端没带基准 → 不算冲突", nil, &newer, false},
		{"服务端还没值 → 不算冲突", &base, nil, false},
		{"服务端更新 → 冲突", &base, &newer, true},
		{"服务端更旧 → 不冲突", &base, &older, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsOverwritten(testCase.base, testCase.current); got != testCase.want {
				t.Errorf("IsOverwritten = %v，期望 %v", got, testCase.want)
			}
		})
	}
}

func TestNormalizeFieldValueTrimsTrailingOnly(t *testing.T) {
	// 只去尾部空白：行首缩进是用户有意的排版，不能被吃掉。
	got, err := NormalizeFieldValue(FieldDayEvents, "  缩进保留  \n")
	if err != nil {
		t.Fatalf("NormalizeFieldValue 出错：%v", err)
	}
	if got != "  缩进保留" {
		t.Errorf("归一化结果 = %q，期望 %q", got, "  缩进保留")
	}

	// 空串合法（= 清空内容）
	empty, err := NormalizeFieldValue(FieldDayEvents, "")
	if err != nil || empty != "" {
		t.Errorf("空串应当合法，得到 (%q, %v)", empty, err)
	}
}

func TestNormalizeFieldValueRejectsTooLong(t *testing.T) {
	_, err := NormalizeFieldValue(FieldDayEvents, string(make([]rune, MaxTextLength+1)))
	var domainError *Error
	if !errors.As(err, &domainError) || domainError.Code != "too_long" {
		t.Errorf("超长应当返回 too_long，得到 %v", err)
	}
}

func TestNormalizeIncidentInputValidatesEverything(t *testing.T) {
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	validID := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	validTime := time.Date(2026, 9, 13, 11, 0, 0, 0, time.UTC)

	t.Run("合法输入", func(t *testing.T) {
		got, err := NormalizeIncidentInput(validID, "  忘带钥匙  ", &validTime, ptr("life"), now)
		if err != nil {
			t.Fatalf("不该报错：%v", err)
		}
		if got.Content != "忘带钥匙" {
			t.Errorf("content 应当去首尾空白，得到 %q", got.Content)
		}
		if got.Tag != "life" {
			t.Errorf("tag = %q，期望 life", got.Tag)
		}
	})

	t.Run("tag 留空 → 默认 other", func(t *testing.T) {
		got, err := NormalizeIncidentInput(validID, "内容", nil, nil, now)
		if err != nil {
			t.Fatalf("不该报错：%v", err)
		}
		if got.Tag != string(DefaultTag) {
			t.Errorf("tag = %q，期望 %q", got.Tag, DefaultTag)
		}
	})

	rejects := []struct {
		name     string
		id       string
		content  string
		occurred *time.Time
		tag      *string
	}{
		{"id 不是 UUID", "not-a-uuid", "内容", nil, nil},
		{"content 为空", validID, "   ", nil, nil},
		{"content 超长", validID, string(make([]rune, MaxIncidentLength+1)), nil, nil},
		{"occurred_at 太早", validID, "内容", timePtr(time.Date(1999, 12, 31, 0, 0, 0, 0, time.UTC)), nil},
		{"occurred_at 太晚", validID, "内容", timePtr(time.Date(2100, 6, 1, 0, 0, 0, 0, time.UTC)), nil},
		{"tag 非法", validID, "内容", nil, ptr("sports")},
	}
	for _, testCase := range rejects {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NormalizeIncidentInput(
				testCase.id, testCase.content, testCase.occurred, testCase.tag, now,
			); err == nil {
				t.Error("应当报错，但没有")
			}
		})
	}
}

func timePtr(value time.Time) *time.Time { return &value }

// 突发事情的归属日跟着发生时间走：跨过日界就要落到前一天。
func TestIncidentEntryDateFollowsOccurredAt(t *testing.T) {
	location := shanghai(t)

	// 本地 2026-09-13 03:30（日界 04:00 之前）→ 归属 2026-09-12
	before := time.Date(2026, 9, 12, 19, 30, 0, 0, time.UTC)
	date, err := IncidentEntryDate(before, location, 4)
	if err != nil {
		t.Fatalf("IncidentEntryDate 出错：%v", err)
	}
	if date != "2026-09-12" {
		t.Errorf("归属日 = %s，期望 2026-09-12", date)
	}

	// 本地 2026-09-13 04:30 → 归属 2026-09-13
	after := time.Date(2026, 9, 12, 20, 30, 0, 0, time.UTC)
	date, err = IncidentEntryDate(after, location, 4)
	if err != nil {
		t.Fatalf("IncidentEntryDate 出错：%v", err)
	}
	if date != "2026-09-13" {
		t.Errorf("归属日 = %s，期望 2026-09-13", date)
	}
}

func TestTodayMetaForUsesServerSideDayBoundary(t *testing.T) {
	location := shanghai(t)
	// 本地 2026-09-13 02:00：仍在日界前，today 应当是 09-12，yesterday 是 09-11。
	now := time.Date(2026, 9, 12, 18, 0, 0, 0, time.UTC)

	meta, err := TodayMetaFor(now, location, "Asia/Shanghai", 4, "user-1")
	if err != nil {
		t.Fatalf("TodayMetaFor 出错：%v", err)
	}
	if meta.DiaryDate != "2026-09-12" {
		t.Errorf("diary_date = %s，期望 2026-09-12", meta.DiaryDate)
	}
	if meta.Yesterday != "2026-09-11" {
		t.Errorf("yesterday = %s，期望 2026-09-11", meta.Yesterday)
	}
	if meta.UserID != "user-1" || meta.DayStartHour != 4 || meta.Timezone != "Asia/Shanghai" {
		t.Errorf("元信息字段不对：%+v", meta)
	}
}
