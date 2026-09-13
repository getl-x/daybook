package ops

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// fakeBackups 顶替 PocketBase 的 CreateBackup：真的落一个文件，好让
// EnsureDaily 的"今天有没有做过"判断走真实的文件系统逻辑。
type fakeBackups struct {
	dir     string
	created []string
}

func newFakeBackups(t *testing.T) *fakeBackups {
	t.Helper()
	return &fakeBackups{dir: t.TempDir()}
}

func (fake *fakeBackups) create(_ context.Context, name string) error {
	fake.created = append(fake.created, name)
	target := filepath.Join(fake.dir, core.LocalBackupsDirName, name)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(target, []byte("zip"), 0o600); err != nil {
		return err
	}
	// 顺带写伴随文件：PocketBase 的 fileblob 就是这么存的，
	// 所以保留策略必须把它一起清掉（见 BackupManager.prune）。
	return os.WriteFile(target+backupAttrsExt, []byte("{}"), 0o600)
}

func (fake *fakeBackups) manager(now time.Time) BackupManager {
	return BackupManager{
		DataDir: fake.dir,
		Now:     func() time.Time { return now },
		Create:  fake.create,
	}
}

func (fake *fakeBackups) names(pattern string) []string {
	matches, err := filepath.Glob(filepath.Join(fake.dir, core.LocalBackupsDirName, pattern))
	if err != nil {
		return nil
	}
	for index := range matches {
		matches[index] = filepath.Base(matches[index])
	}
	return matches
}

func TestEnsureDailyCreatesOncePerUTCDay(t *testing.T) {
	fake := newFakeBackups(t)
	day := time.Date(2026, 9, 13, 3, 0, 0, 0, time.UTC)

	// 同一天跑两次只该有一份（容器重启、cron 与启动钩子都会调它）
	for attempt := 0; attempt < 2; attempt++ {
		if err := fake.manager(day).EnsureDaily(context.Background()); err != nil {
			t.Fatalf("第 %d 次失败：%v", attempt+1, err)
		}
	}
	if len(fake.created) != 1 {
		t.Fatalf("同一天应只建一份，得到 %d 份：%v", len(fake.created), fake.created)
	}
	if want := "daily_daybook_20260913.zip"; fake.created[0] != want {
		t.Fatalf("命名期望 %s，得到 %s", want, fake.created[0])
	}

	// 换一天就该再建一份
	if err := fake.manager(day.Add(24 * time.Hour)).EnsureDaily(context.Background()); err != nil {
		t.Fatalf("次日失败：%v", err)
	}
	if len(fake.created) != 2 {
		t.Fatalf("跨天应再建一份，得到 %d 份：%v", len(fake.created), fake.created)
	}
}

func TestEnsureDailyPrunesToSeven(t *testing.T) {
	fake := newFakeBackups(t)
	start := time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC)

	// 连做 10 天：只应留下最近 7 份
	for day := 0; day < 10; day++ {
		at := start.AddDate(0, 0, day)
		if err := fake.manager(at).EnsureDaily(context.Background()); err != nil {
			t.Fatalf("第 %d 天失败：%v", day, err)
		}
	}
	kept := fake.names("daily_daybook_*.zip")
	if len(kept) != dailyKeep {
		t.Fatalf("应保留 %d 份，得到 %d：%v", dailyKeep, len(kept), kept)
	}
	// 字典序 = 时间序，最早那三天应该没了
	if kept[0] != "daily_daybook_20260904.zip" || kept[len(kept)-1] != "daily_daybook_20260910.zip" {
		t.Fatalf("保留的应是最近 7 天，得到 %v", kept)
	}
	// .attrs 伴随文件必须跟着一起删：只删 zip 的话它们会一天一个地无限堆积
	orphans := fake.names("daily_daybook_*.zip" + backupAttrsExt)
	if len(orphans) != dailyKeep {
		t.Fatalf("伴随文件也应只剩 %d 份，得到 %d：%v", dailyKeep, len(orphans), orphans)
	}
}

func TestBeforeUpgradeSkipsWhenThereIsNoDatabase(t *testing.T) {
	fake := newFakeBackups(t)

	// 全新安装：没有旧数据可保，也不该写版本标记之外的任何东西
	created, err := fake.manager(time.Now()).BeforeUpgrade(context.Background(), "v1", false)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if created || len(fake.created) != 0 {
		t.Fatalf("库不存在时不该备份，得到 created=%v %v", created, fake.created)
	}
}

func TestBeforeUpgradeSkipsSameVersion(t *testing.T) {
	fake := newFakeBackups(t)
	manager := fake.manager(time.Now())

	if err := manager.MarkVersion("v1"); err != nil {
		t.Fatalf("写版本标记失败：%v", err)
	}
	created, err := manager.BeforeUpgrade(context.Background(), "v1", true)
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if created || len(fake.created) != 0 {
		t.Fatalf("版本没变就不算升级，不该备份，得到 created=%v %v", created, fake.created)
	}
}

func TestBeforeUpgradeBacksUpOnVersionChange(t *testing.T) {
	fake := newFakeBackups(t)
	manager := fake.manager(time.Date(2026, 9, 13, 1, 2, 3, 0, time.UTC))

	if err := manager.MarkVersion("v1"); err != nil {
		t.Fatalf("写版本标记失败：%v", err)
	}
	created, err := manager.BeforeUpgrade(context.Background(), "v2", true)
	if err != nil {
		t.Fatalf("备份失败：%v", err)
	}
	if !created || len(fake.created) != 1 {
		t.Fatalf("版本变了应备一份，得到 created=%v %v", created, fake.created)
	}
	if want := "preupgrade_daybook_20260913T010203.000000000Z.zip"; fake.created[0] != want {
		t.Fatalf("命名期望 %s，得到 %s", want, fake.created[0])
	}
}

func TestBeforeUpgradeRequiresVersion(t *testing.T) {
	fake := newFakeBackups(t)
	if _, err := fake.manager(time.Now()).BeforeUpgrade(context.Background(), "  ", true); err == nil {
		t.Fatal("版本号为空应当报错")
	}
}

func TestCreateManualIsNotPrunedByAutomaticSets(t *testing.T) {
	fake := newFakeBackups(t)
	day := time.Date(2026, 9, 13, 3, 0, 0, 0, time.UTC)
	manager := fake.manager(day)

	if err := manager.EnsureDaily(context.Background()); err != nil {
		t.Fatalf("日备份失败：%v", err)
	}
	name, err := manager.CreateManual(context.Background())
	if err != nil {
		t.Fatalf("手工备份失败：%v", err)
	}
	if len(fake.names("manual_daybook_*.zip")) != 1 {
		t.Fatalf("手工备份应落盘：%s", name)
	}

	// 再跑一轮自动策略：手工备份不该被顺手删掉
	if err := manager.EnsureDaily(context.Background()); err != nil {
		t.Fatalf("二次日备份失败：%v", err)
	}
	if got := fake.names("manual_daybook_*.zip"); len(got) != 1 {
		t.Fatalf("手工备份不该被自动策略删掉，得到 %v", got)
	}
	if got := fake.names("daily_daybook_*.zip"); len(got) != 1 {
		t.Fatalf("日备份应还在，得到 %v", got)
	}
}

func TestMarkVersionRoundTripAndRejectsBadInput(t *testing.T) {
	fake := newFakeBackups(t)
	manager := fake.manager(time.Now())

	if err := manager.MarkVersion("v1.2.3"); err != nil {
		t.Fatalf("写失败：%v", err)
	}
	got, err := manager.readVersion()
	if err != nil {
		t.Fatalf("读失败：%v", err)
	}
	if got != "v1.2.3" {
		t.Fatalf("读回期望 v1.2.3，得到 %q", got)
	}

	// 权限收敛：数据目录里不该出现人人可读的版本标记
	info, err := os.Stat(filepath.Join(fake.dir, versionMarkerName))
	if err != nil {
		t.Fatalf("版本标记不存在：%v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("版本标记权限期望 0600，得到 %o", perm)
	}

	if err := manager.MarkVersion("  "); err == nil {
		t.Fatal("空版本号应报错")
	}
	if err := manager.MarkVersion("v1\nv2"); err == nil {
		t.Fatal("多行版本号应报错")
	}
}

func TestBackupManagerValidatesInputs(t *testing.T) {
	if err := (BackupManager{}).EnsureDaily(context.Background()); err == nil {
		t.Fatal("缺数据目录应报错")
	}
	manager := BackupManager{DataDir: t.TempDir()}
	if err := manager.EnsureDaily(context.Background()); err == nil {
		t.Fatal("缺 Create 应报错")
	}
}
