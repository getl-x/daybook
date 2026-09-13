// Package applog 把面向运维的日志同时写到两个地方。
//
// 为什么需要它：PocketBase 生产模式下业务日志**只进数据库**——
// core/base.go 里唯一往终端打印的 printLog 只在 app.IsDev() 为真时调用，
// 非 dev 的日志全部落到 auxiliary.db 的 _logs 表（/_/ 面板可查）。
// 而容器部署下排障的第一个动作是 `docker compose logs app`，那里只有启动
// 横幅。Node 版是直接打 stdout 的，所以这里补一次：每条日志写两遍，
// 一遍交给 PocketBase（进表、可在面板按等级/关键字筛），一遍交给 stderr
// （docker compose logs 直接能看、能 grep、能进日志采集）。
//
// 代价是 dev 模式下同一行会出现两次（PocketBase 自己也会打印）。这是刻意的：
// 宁可多一行，也不要生产上什么都看不到。
package applog

import (
	"fmt"
	"log"

	"github.com/pocketbase/pocketbase/core"
)

// Level 是日志等级；取值为 "info" / "warn" / "error"。
type Level string

const (
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Logf 按 level 记一条日志。
//
// 传的是格式化参数而不是 slog 的键值对：调用点全是面向运维的一句话
// （"排程已推进：user=… nextFireAt=…"），拼好再写更好读，也省得两处各写一遍。
func Logf(app core.App, level Level, format string, args ...any) {
	message := fmt.Sprintf(format, args...)

	// 1) 给 PocketBase：进 _logs 表，/_/ 面板可查、可按等级筛
	switch level {
	case LevelError:
		app.Logger().Error(message)
	case LevelWarn:
		app.Logger().Warn(message)
	default:
		app.Logger().Info(message)
	}

	// 2) 给 stderr：容器部署下 `docker compose logs app` 直接看得到
	log.Printf("[%s] %s", upper(level), message)
}

func upper(level Level) string {
	switch level {
	case LevelError:
		return "ERROR"
	case LevelWarn:
		return "WARN"
	default:
		return "INFO"
	}
}
