// Package ops 是给容器运维用的东西：备份与健康检查。
//
// 为什么放进 Go 而不是 deploy/ 下的 shell 脚本：要备份的正是 PocketBase 的数据
// 目录（SQLite 单文件 + WAL + 上传件），只有它自己的 CreateBackup 能拿到一致快照；
// 外部脚本得先停容器、再猜哪些文件要拷，还得靠宿主配 crontab。做成进程内的东西
// 之后，`docker compose exec app daybook backup` 一条命令就能备，容器自己的
// healthcheck 也能直接调（对应 LastDone 的 source/server/ops）。
package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const (
	// versionMarkerName 记下"上一次成功启动的版本"，用来判断这次算不算升级。
	versionMarkerName = ".daybook-version"
	// dailyKeep 是日备份的保留份数（一天最多一份，够回看一周）。
	dailyKeep = 7
	// preUpgradeKeep 是升级前备份的保留份数：只在真正升级时才产生。
	preUpgradeKeep = 3
)

// backupLock 串行化备份：每日 cron 与升级前备份可能撞在一起，而两者都在写
// 同一个数据目录。
var backupLock sync.Mutex

// BackupManager 负责本地备份的创建与保留策略。
type BackupManager struct {
	DataDir string
	// Now 便于测试注入时钟；nil 时用 time.Now。
	Now func() time.Time
	// Create 由调用方接 PocketBase 的 app.CreateBackup。
	Create func(ctx context.Context, name string) error
}

// EnsureDaily 保证当前 UTC 日期最多有一份日备份，并保留最近 dailyKeep 份。
//
// 按 UTC 日期而不是本地日期命名：容器里 TZ 可能被改，用本地日期会让"同一天
// 起了两次"判断失准。
func (manager BackupManager) EnsureDaily(ctx context.Context) error {
	backupLock.Lock()
	defer backupLock.Unlock()

	if err := manager.validate(); err != nil {
		return err
	}
	name := "daily_daybook_" + manager.now().UTC().Format("20060102") + ".zip"
	path := filepath.Join(manager.DataDir, core.LocalBackupsDirName, name)
	if _, err := os.Stat(path); err == nil {
		// 今天已经有一份了：只跑保留策略，不重复占盘。
		return manager.prune("daily_daybook_*.zip", dailyKeep)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("检查当日备份失败：%w", err)
	}

	if err := manager.Create(ctx, name); err != nil {
		return fmt.Errorf("创建当日备份失败：%w", err)
	}
	return manager.prune("daily_daybook_*.zip", dailyKeep)
}

// BeforeUpgrade 在"库已存在且版本号变了"时先做一份升级前备份。
//
// 库不存在（全新安装）或还没有版本标记（第一次跑这把代码）都不算升级：
// 那时候没有"旧数据"可保。返回 true 表示确实备了一份。
func (manager BackupManager) BeforeUpgrade(
	ctx context.Context,
	version string,
	databaseExists bool,
) (bool, error) {
	backupLock.Lock()
	defer backupLock.Unlock()

	if err := manager.validate(); err != nil {
		return false, err
	}
	version = strings.TrimSpace(version)
	if version == "" {
		return false, fmt.Errorf("必须提供应用版本号")
	}
	if !databaseExists {
		return false, nil
	}

	previous, err := manager.readVersion()
	if err != nil {
		return false, err
	}
	if previous == version {
		return false, nil
	}

	name := "preupgrade_daybook_" + manager.now().UTC().Format("20060102T150405.000000000Z") + ".zip"
	if err := manager.Create(ctx, name); err != nil {
		return false, fmt.Errorf("创建升级前备份失败：%w", err)
	}
	if err := manager.prune("preupgrade_daybook_*.zip", preUpgradeKeep); err != nil {
		return false, err
	}
	return true, nil
}

// CreateManual 建一份带时间戳的备份，**不动**两套自动保留策略的文件——
// 手工备份不该被每日/升级策略顺手删掉。
func (manager BackupManager) CreateManual(ctx context.Context) (string, error) {
	backupLock.Lock()
	defer backupLock.Unlock()

	if err := manager.validate(); err != nil {
		return "", err
	}
	name := "manual_daybook_" + manager.now().UTC().Format("20060102T150405.000000000Z") + ".zip"
	if err := manager.Create(ctx, name); err != nil {
		return "", fmt.Errorf("创建手工备份失败：%w", err)
	}
	return name, nil
}

// MarkVersion 原子地记下当前版本号。
//
// 走"临时文件 → Sync → Rename"而不是直接覆盖：中途断电或被 kill 时，文件要么
// 是旧内容要么是新内容，不会留半行版本号——而版本号读成半截会让下次启动误判成
// 升级（或漏判，那才是真丢数据）。
func (manager BackupManager) MarkVersion(version string) error {
	version = strings.TrimSpace(version)
	if version == "" {
		return fmt.Errorf("必须提供应用版本号")
	}
	if strings.ContainsAny(version, "\r\n") {
		return fmt.Errorf("应用版本号必须是单行")
	}
	if strings.TrimSpace(manager.DataDir) == "" {
		return fmt.Errorf("必须提供数据目录")
	}
	if err := os.MkdirAll(manager.DataDir, 0o700); err != nil {
		return fmt.Errorf("创建数据目录失败：%w", err)
	}

	temporary, err := os.CreateTemp(manager.DataDir, versionMarkerName+"-*")
	if err != nil {
		return fmt.Errorf("创建版本标记失败：%w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()

	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("收紧版本标记权限失败：%w", err)
	}
	if _, err := temporary.WriteString(version + "\n"); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("写入版本标记失败：%w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("落盘版本标记失败：%w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("关闭版本标记失败：%w", err)
	}
	if err := os.Rename(temporaryPath, filepath.Join(manager.DataDir, versionMarkerName)); err != nil {
		return fmt.Errorf("替换版本标记失败：%w", err)
	}
	return nil
}

func (manager BackupManager) validate() error {
	if strings.TrimSpace(manager.DataDir) == "" {
		return fmt.Errorf("必须提供数据目录")
	}
	if manager.Create == nil {
		return fmt.Errorf("必须提供备份创建函数")
	}
	return nil
}

func (manager BackupManager) now() time.Time {
	if manager.Now != nil {
		return manager.Now()
	}
	return time.Now()
}

// readVersion 读版本标记；没有标记返回空串（= 第一次跑，不算升级）。
func (manager BackupManager) readVersion() (string, error) {
	contents, err := os.ReadFile(filepath.Join(manager.DataDir, versionMarkerName))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("读取版本标记失败：%w", err)
	}
	return strings.TrimSpace(string(contents)), nil
}

// backupAttrsExt 是 PocketBase 给每个备份写的伴随文件后缀。
//
// 备份落在 fileblob 文件系统上，每个 blob 都带一个 `<name>.attrs`（记大小、
// 修改时间、备注）。它自己的清理走 fsys.Delete，把两者当一体；我们这里用
// os.Remove，就必须自己补这一刀，否则 .attrs 会一天一个地无限堆积。
const backupAttrsExt = ".attrs"

// prune 只保留按名字排序（= 按时间排序）的最后 keep 份。
//
// 时间戳是定宽格式，所以字典序就是时间序，不必解析文件名。
func (manager BackupManager) prune(pattern string, keep int) error {
	files, err := filepath.Glob(filepath.Join(manager.DataDir, core.LocalBackupsDirName, pattern))
	if err != nil {
		return fmt.Errorf("列出备份失败：%w", err)
	}
	sort.Strings(files)
	for _, path := range files[:max(0, len(files)-keep)] {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("删除旧备份 %q 失败：%w", filepath.Base(path), err)
		}
		if err := os.Remove(path + backupAttrsExt); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("删除旧备份的伴随文件 %q 失败：%w", filepath.Base(path)+backupAttrsExt, err)
		}
	}
	return nil
}
