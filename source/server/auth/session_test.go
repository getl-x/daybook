package auth

import (
	"errors"
	"testing"
	"time"

	// 触发 migrations 包注册，让测试库拿到真实集合结构。
	_ "github.com/getl-x/daybook/source/server/migrations"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

const goodPassword = "correct-horse-battery"

func newApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("执行迁移失败：%v", err)
	}
	return app
}

func createUser(t *testing.T, app core.App, username string, password string, status string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("找不到 users 集合：%v", err)
	}
	record := core.NewRecord(collection)
	record.Set("username", username)
	record.Set("status", status)
	record.SetPassword(password)
	if err := app.Save(record); err != nil {
		t.Fatalf("创建账号 %s 失败：%v", username, err)
	}
	return record
}

func TestLoginIssuesSession(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	session, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("登录失败：%v", err)
	}
	if session.AccessToken == "" {
		t.Error("访问令牌不能为空")
	}
	if session.RefreshToken == "" {
		t.Error("刷新令牌不能为空")
	}
	if session.Username != "getl" {
		t.Errorf("用户名 = %q，期望 getl", session.Username)
	}
	// 访问令牌 15 分钟（迁移里设定），与 Node 版的 ACCESS_TOKEN_TTL_SECONDS 对齐。
	if session.ExpiresIn != 900 {
		t.Errorf("expiresIn = %d，期望 900", session.ExpiresIn)
	}
	if !session.RefreshExpiresAt.After(time.Now().Add(29 * 24 * time.Hour)) {
		t.Errorf("刷新令牌有效期应当接近 30 天，得到 %s", session.RefreshExpiresAt)
	}

	// 拿到的访问令牌必须能被 PocketBase 反查回这条账号。
	record, err := app.FindAuthRecordByToken(session.AccessToken, core.TokenTypeAuth)
	if err != nil {
		t.Fatalf("访问令牌无法通过校验：%v", err)
	}
	if record.Id != session.UserID {
		t.Errorf("令牌解析出的账号 = %s，期望 %s", record.Id, session.UserID)
	}
}

// 用户名大小写与首尾空白不该影响登录（与"只允许小写"的存储约束配套）。
func TestLoginNormalizesUsername(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	if _, err := Login(app, "  Getl ", goodPassword, time.Now()); err != nil {
		t.Errorf("大小写/空白不同的用户名应当能登录：%v", err)
	}
}

// 这是原设计明确要求的：不区分"用户不存在"与"口令错误"。
func TestLoginRejectsUnknownUserAndWrongPasswordAlike(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	if _, err := Login(app, "getl", "definitely-wrong", time.Now()); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("口令错误应返回 ErrInvalidCredentials，得到 %v", err)
	}
	if _, err := Login(app, "nobody-here", "definitely-wrong", time.Now()); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("用户不存在也应返回同一个错误，得到 %v", err)
	}
}

func TestDisabledAccountCannotLogin(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "disabled")

	if _, err := Login(app, "getl", goodPassword, time.Now()); !errors.Is(err, ErrAccountDisabled) {
		t.Errorf("停用账号应返回 ErrAccountDisabled，得到 %v", err)
	}
}

// 刷新令牌是一次性的：换新之后旧的立刻作废（轮换 + 可吊销）。
func TestRefreshRotatesAndInvalidatesPrevious(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	first, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("登录失败：%v", err)
	}

	second, err := Refresh(app, first.RefreshToken, time.Now())
	if err != nil {
		t.Fatalf("刷新失败：%v", err)
	}
	if second.RefreshToken == first.RefreshToken {
		t.Error("刷新应当轮换出新的刷新令牌")
	}
	if second.UserID != first.UserID {
		t.Error("刷新后账号不应改变")
	}

	if _, err := Refresh(app, first.RefreshToken, time.Now()); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("旧的刷新令牌应当已作废，得到 %v", err)
	}
	if _, err := Refresh(app, second.RefreshToken, time.Now()); err != nil {
		t.Errorf("新的刷新令牌应当可用：%v", err)
	}
}

func TestLogoutRevokesRefreshToken(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	session, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("登录失败：%v", err)
	}
	if err := Logout(app, session.RefreshToken, time.Now()); err != nil {
		t.Fatalf("登出失败：%v", err)
	}
	if _, err := Refresh(app, session.RefreshToken, time.Now()); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("登出后刷新令牌应当失效，得到 %v", err)
	}

	// 重复登出同一个令牌不该报错——客户端重试是常态。
	if err := Logout(app, session.RefreshToken, time.Now()); err != nil {
		t.Errorf("重复登出不该报错：%v", err)
	}
}

func TestRefreshRejectsExpiredToken(t *testing.T) {
	app := newApp(t)
	user := createUser(t, app, "getl", goodPassword, "active")

	// 直接塞一条已过期的令牌：过期判定走真实时钟，所以这里把 expires_at 写在过去。
	collection, err := app.FindCollectionByNameOrId("refresh_tokens")
	if err != nil {
		t.Fatalf("找不到 refresh_tokens 集合：%v", err)
	}
	const plain = "expired-token-value"
	record := core.NewRecord(collection)
	record.Set("user", user.Id)
	record.Set("token_hash", hashRefreshToken(plain))
	record.Set("expires_at", time.Now().Add(-time.Hour))
	if err := app.Save(record); err != nil {
		t.Fatalf("写入过期令牌失败：%v", err)
	}

	if _, err := Refresh(app, plain, time.Now()); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("过期刷新令牌应当被拒，得到 %v", err)
	}
}

// 停用账号后，连刷新令牌一起失效——"停用后既有令牌立即失效"这条验收标准。
func TestDisabledAccountCannotRefresh(t *testing.T) {
	app := newApp(t)
	user := createUser(t, app, "getl", goodPassword, "active")

	session, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("登录失败：%v", err)
	}

	user.Set("status", "disabled")
	if err := app.Save(user); err != nil {
		t.Fatalf("停用账号失败：%v", err)
	}

	if _, err := Refresh(app, session.RefreshToken, time.Now()); !errors.Is(err, ErrAccountDisabled) {
		t.Errorf("停用账号刷新应被拒，得到 %v", err)
	}
	// 而且该令牌已经被顺手吊销，之后连"账号被重新启用"也救不回来
	user.Set("status", "active")
	if err := app.Save(user); err != nil {
		t.Fatalf("重新启用失败：%v", err)
	}
	if _, err := Refresh(app, session.RefreshToken, time.Now()); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("刷新令牌应已被吊销，得到 %v", err)
	}
}

func TestRevokeAllForUser(t *testing.T) {
	app := newApp(t)
	createUser(t, app, "getl", goodPassword, "active")

	first, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("登录失败：%v", err)
	}
	second, err := Login(app, "getl", goodPassword, time.Now())
	if err != nil {
		t.Fatalf("第二次登录失败：%v", err)
	}

	if err := RevokeAllForUser(app, first.UserID, time.Now()); err != nil {
		t.Fatalf("吊销失败：%v", err)
	}
	for label, token := range map[string]string{"第一个": first.RefreshToken, "第二个": second.RefreshToken} {
		if _, err := Refresh(app, token, time.Now()); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s会话应当已被吊销，得到 %v", label, err)
		}
	}
}

func TestIsUsableTreatsEmptyStatusAsActive(t *testing.T) {
	app := newApp(t)
	// 迁移前就存在的记录没有 status 字段，应当视为可用。
	user := createUser(t, app, "getl", goodPassword, "")
	if !IsUsable(user) {
		t.Error("status 为空应当视为 active")
	}
}
