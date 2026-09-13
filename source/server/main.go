// daybook 服务入口（Go + PocketBase 重写版）。
//
// 与 Node 版的关系：对外 HTTP 契约（/v1/…、/healthz）保持不变，因此
// source/web 里的客户端代码不需要跟着改。变化的是实现：
//   - Postgres  → PocketBase 内置 SQLite（单文件，部署时不再需要数据库容器）
//   - 自研认证  → PocketBase auth collection（注册规则显式关闭）
//   - 账号管理  → PocketBase 管理员控制台 /_/（替代原先只能用的 CLI）
//
// 设计取舍见 DAYBOOK-DESIGN.zh-CN.md；本文件的注释记录与 Node 版的对应关系。
package main

import (
	"log"

	daybookapp "github.com/getl-x/daybook/source/server/app"
	_ "github.com/getl-x/daybook/source/server/migrations"
	"github.com/getl-x/daybook/source/server/ops"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	// 把 IANA 时区库编进二进制：容器镜像里没有 /usr/share/zoneinfo，
	// 而"日记日"的计算完全依赖它（见 schedule 包）。缺了这段会在计算时报
	// "unknown time zone"，是那种只在生产容器里才炸的问题。
	_ "time/tzdata"
)

func main() {
	config := daybookapp.DefaultConfig()
	application := daybookapp.New(config)

	// 迁移文件在 migrations 包里以 Go 代码形式注册（import 触发 init）。
	migratecmd.MustRegister(application, application.RootCmd, migratecmd.Config{})

	// 运维子命令：healthcheck（容器健康检查直接调它，不必依赖镜像里有 wget）
	// 与 backup（`docker compose exec app daybook backup`）。
	ops.RegisterCommands(application, application.RootCmd)

	if err := application.Start(); err != nil {
		log.Fatal(err)
	}
}
