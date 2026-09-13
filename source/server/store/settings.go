// Package store 是"每用户一行"的数据访问（目前是 user_settings）。
//
// 默认值与 Node 版 server/src/users.ts 建号时插入的那一行保持一致，
// 这样老数据与新账号在两套实现下的行为一样。
package store

import (
	"database/sql"
	"errors"
	"time"

	"github.com/getl-x/daybook/source/server/schedule"
	"github.com/pocketbase/pocketbase/core"
)

const (
	DefaultTimezone     = "Asia/Shanghai"
	DefaultDayStartHour = 4
	DefaultMorningTime  = "09:00"
	DefaultEveningTime  = "21:00"
	DefaultTheme        = "system"
)

// Settings 是 user_settings 行的强类型视图。
type Settings struct {
	Timezone               string
	DayStartHour           int
	MorningReminderEnabled bool
	MorningReminderTime    string
	EveningReminderEnabled bool
	EveningReminderTime    string
	NotifyOnlyIfIncomplete bool
	Theme                  string
	QuietEnabled           bool
	QuietStart             string
	QuietEnd               string
}

// Ensure 取回该用户的设置行；没有就按默认值建一行。
//
// 对应 Node 版建号时"顺手插一行 user_settings"的做法，这里改成读时兜底——
// 手工在 /_/ 控制台建的账号不会漏掉设置行。
func Ensure(app core.App, userID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByData("user_settings", "user", userID)
	if err == nil {
		return record, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	collection, err := app.FindCollectionByNameOrId("user_settings")
	if err != nil {
		return nil, err
	}
	record = core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("timezone", DefaultTimezone)
	record.Set("day_start_hour", DefaultDayStartHour)
	record.Set("morning_reminder_enabled", true)
	record.Set("morning_reminder_time", DefaultMorningTime)
	record.Set("evening_reminder_enabled", true)
	record.Set("evening_reminder_time", DefaultEveningTime)
	record.Set("notify_only_if_incomplete", true)
	record.Set("theme", DefaultTheme)
	record.Set("quiet_enabled", false)
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

// Read 把记录读成强类型设置，空值按默认值兜底。
func Read(record *core.Record) Settings {
	settings := Settings{
		Timezone:               record.GetString("timezone"),
		DayStartHour:           record.GetInt("day_start_hour"),
		MorningReminderEnabled: record.GetBool("morning_reminder_enabled"),
		MorningReminderTime:    record.GetString("morning_reminder_time"),
		EveningReminderEnabled: record.GetBool("evening_reminder_enabled"),
		EveningReminderTime:    record.GetString("evening_reminder_time"),
		NotifyOnlyIfIncomplete: record.GetBool("notify_only_if_incomplete"),
		Theme:                  record.GetString("theme"),
		QuietEnabled:           record.GetBool("quiet_enabled"),
		QuietStart:             record.GetString("quiet_start"),
		QuietEnd:               record.GetString("quiet_end"),
	}
	if settings.Timezone == "" {
		settings.Timezone = DefaultTimezone
	}
	if settings.DayStartHour < schedule.MinDayStartHour || settings.DayStartHour > schedule.MaxDayStartHour {
		settings.DayStartHour = DefaultDayStartHour
	}
	if settings.MorningReminderTime == "" {
		settings.MorningReminderTime = DefaultMorningTime
	}
	if settings.EveningReminderTime == "" {
		settings.EveningReminderTime = DefaultEveningTime
	}
	if settings.Theme == "" {
		settings.Theme = DefaultTheme
	}
	return settings
}

// Location 载入设置对应的时区。
func (s Settings) Location() (*time.Location, error) {
	return schedule.LoadLocation(s.Timezone)
}
