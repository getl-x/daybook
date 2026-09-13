package auth

import (
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// GraceDays 是账号申请删除后的宽限期（与 Node 版一致）。
const GraceDays = 7

// PurgeExpiredAccounts 删除宽限期已过的"待删除"账号，返回删除的条数。
//
// 搭在每分钟的提醒 tick 上跑（见 web-push-design §4）：清理这件事不值得单开
// 一个定时任务，而且它和提醒共用同一套"这个账号还该被服务吗"的语义。
//
// 只删 status 恰好是 pending_deletion、deletion_requested_at 非空、且已早于
// now - GraceDays*24h 的记录。deletion_requested_at 为空的不删——那是脏数据，
// 按"已过期"处理会误删（对应 Node 版 SQL 里的 `IS NOT NULL`）。
func PurgeExpiredAccounts(app core.App, now time.Time) (int, error) {
	// deletion_requested_at 是 PocketBase 的 DateField，过滤值必须用同一化后的
	// 字符串格式，否则传进去的瞬间永远匹配不上库里存的那串。
	cutoff := now.UTC().Add(-GraceDays * 24 * time.Hour).Format(types.DefaultDateLayout)

	records, err := app.FindRecordsByFilter(
		"users",
		"status = {:status} && deletion_requested_at != '' && deletion_requested_at <= {:cutoff}",
		"",
		0,
		0,
		dbx.Params{"status": "pending_deletion", "cutoff": cutoff},
	)
	if err != nil {
		return 0, err
	}

	purged := 0
	for _, record := range records {
		if err := app.Delete(record); err != nil {
			// 一条删不掉不该带走已经删掉的计数：把成功的部分如实报出去。
			return purged, fmt.Errorf("删除账号 %s 失败：%w", record.Id, err)
		}
		purged++
	}
	return purged, nil
}
