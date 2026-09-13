// Package auth 负责会话：登录、刷新令牌轮换、登出与账号状态判定。
//
// 与 Node 版 source/server/src/auth.ts 的对应关系：
//   - 访问令牌：改用 PocketBase 的 auth 令牌（HS256 + 集合密钥），有效期 15 分钟
//     （由 users.AuthToken.Duration 设定），不再自己实现 JWT 签发；
//   - 刷新令牌：沿用原设计——32 字节高熵随机串，库里只存 SHA-256 哈希，
//     30 天有效，可精确吊销；
//   - 登录失败一律返回同一个错误，且**用户不存在时也跑一次等价开销的口令校验**，
//     避免用响应时间判断用户名是否存在（原 auth.ts 的 DUMMY_HASH 机制）。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/bcrypt"
)

// RefreshTokenTTL 是刷新令牌的有效期（Node 版为 30 天）。
const RefreshTokenTTL = 30 * 24 * time.Hour

const refreshTokenBytes = 32

// dummyHash 是一段固定的 bcrypt 哈希，用于"用户不存在"时消耗等价的时间。
// 明文是随机的，不可能被匹配上。
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

var (
	// ErrInvalidCredentials 登录失败（用户名不存在或口令不对，刻意不区分）。
	ErrInvalidCredentials = errors.New("invalid_credentials")
	// ErrAccountDisabled 账号被停用或处于待删除状态。
	ErrAccountDisabled = errors.New("unauthorized")
	// ErrInvalidToken 刷新令牌不存在、已吊销或已过期。
	ErrInvalidToken = errors.New("unauthorized")
)

// Session 是一次登录/刷新后返回给客户端的东西。
type Session struct {
	UserID           string
	Username         string
	AccessToken      string
	ExpiresIn        int64
	RefreshToken     string
	RefreshExpiresAt time.Time
}

// Status 返回账号状态；字段为空（迁移前的老记录）视为 active。
func Status(record *core.Record) string {
	status := record.GetString("status")
	if status == "" {
		return "active"
	}
	return status
}

// IsUsable 判断账号当前是否允许登录/续期。
func IsUsable(record *core.Record) bool {
	return Status(record) == "active"
}

// Login 校验用户名口令并签发会话。
func Login(app core.App, username string, password string, now time.Time) (Session, error) {
	normalized := strings.TrimSpace(strings.ToLower(username))
	record, err := app.FindFirstRecordByData("users", "username", normalized)
	if err != nil {
		// 用户不存在：照样跑一次 bcrypt，把响应时间拉平（见包注释）。
		_ = bcrypt.CompareHashAndPassword([]byte(dummyHash), []byte(password))
		return Session{}, ErrInvalidCredentials
	}

	if !record.ValidatePassword(password) {
		return Session{}, ErrInvalidCredentials
	}
	if !IsUsable(record) {
		return Session{}, ErrAccountDisabled
	}

	return issue(app, record, now)
}

// Refresh 用刷新令牌换一套新会话，并轮换（旧令牌立即作废）。
func Refresh(app core.App, token string, now time.Time) (Session, error) {
	record, err := findRefreshToken(app, token)
	if err != nil {
		return Session{}, err
	}

	user, err := app.FindRecordById("users", record.GetString("user"))
	if err != nil {
		return Session{}, ErrInvalidToken
	}
	if !IsUsable(user) {
		// 账号被停用：连刷新令牌一起吊销，不给它留任何复活的余地。
		record.Set("revoked_at", now)
		_ = app.Save(record)
		return Session{}, ErrAccountDisabled
	}

	previous := record.Id
	record.Set("revoked_at", now)
	if err := app.Save(record); err != nil {
		return Session{}, ErrInvalidToken
	}

	session, err := issue(app, user, now)
	if err != nil {
		return Session{}, err
	}
	if err := markRotatedFrom(app, session.RefreshToken, previous); err != nil {
		return Session{}, err
	}
	return session, nil
}

// Logout 吊销一个刷新令牌。调用方无论结果如何都应清掉本地会话。
func Logout(app core.App, token string, now time.Time) error {
	record, err := findRefreshToken(app, token)
	if err != nil {
		// 已经无效的令牌再登出一次不算错误（客户端重复登出是常态）。
		return nil
	}
	record.Set("revoked_at", now)
	return app.Save(record)
}

// RevokeAllForUser 吊销某个账号的全部刷新令牌（停用账号时用）。
func RevokeAllForUser(app core.App, userID string, now time.Time) error {
	records, err := app.FindAllRecords("refresh_tokens", dbx.HashExp{"user": userID})
	if err != nil {
		return err
	}
	for _, record := range records {
		if !record.GetDateTime("revoked_at").IsZero() {
			continue
		}
		record.Set("revoked_at", now)
		if err := app.Save(record); err != nil {
			return err
		}
	}
	return nil
}

func issue(app core.App, record *core.Record, now time.Time) (Session, error) {
	accessToken, err := record.NewAuthToken()
	if err != nil {
		return Session{}, err
	}

	plain, hash, err := newRefreshToken()
	if err != nil {
		return Session{}, err
	}

	collection, err := app.FindCollectionByNameOrId("refresh_tokens")
	if err != nil {
		return Session{}, err
	}
	expiresAt := now.Add(RefreshTokenTTL)
	tokenRecord := core.NewRecord(collection)
	tokenRecord.Set("user", record.Id)
	tokenRecord.Set("token_hash", hash)
	tokenRecord.Set("expires_at", expiresAt)
	if err := app.Save(tokenRecord); err != nil {
		return Session{}, err
	}

	return Session{
		UserID:           record.Id,
		Username:         record.GetString("username"),
		AccessToken:      accessToken,
		ExpiresIn:        int64(record.Collection().AuthToken.DurationTime().Seconds()),
		RefreshToken:     plain,
		RefreshExpiresAt: expiresAt,
	}, nil
}

// findRefreshToken 按哈希查一条仍然有效的刷新令牌。
//
// 这里刻意只接受 app 与 token：调用方（Refresh/Logout）已经拿到了 now，
// 但校验"是否已过期"用真实时钟即可，测试里把 expires_at 写成过去时就行，
// 不必再往下传一个时间参数。
func findRefreshToken(app core.App, token string) (*core.Record, error) {
	if token == "" {
		return nil, ErrInvalidToken
	}
	record, err := app.FindFirstRecordByData("refresh_tokens", "token_hash", hashRefreshToken(token))
	if err != nil {
		return nil, ErrInvalidToken
	}
	if !record.GetDateTime("revoked_at").IsZero() {
		return nil, ErrInvalidToken
	}
	if record.GetDateTime("expires_at").Time().Before(time.Now()) {
		return nil, ErrInvalidToken
	}
	return record, nil
}

func markRotatedFrom(app core.App, plainToken string, previousID string) error {
	record, err := app.FindFirstRecordByData("refresh_tokens", "token_hash", hashRefreshToken(plainToken))
	if err != nil {
		return nil
	}
	record.Set("rotated_from", previousID)
	return app.Save(record)
}

// newRefreshToken 生成明文与入库哈希。高熵随机串不需要慢哈希，SHA-256 足够。
func newRefreshToken() (string, string, error) {
	buffer := make([]byte, refreshTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", "", err
	}
	plain := base64.RawURLEncoding.EncodeToString(buffer)
	return plain, hashRefreshToken(plain), nil
}

func hashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
