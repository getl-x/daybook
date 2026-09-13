package api

import (
	"strings"
	"sync"
	"time"
)

// 登录限流：同一用户名在窗口内失败次数过多就拒绝。
//
// 这是单进程内存实现——daybook 是自托管的单实例应用，没有多副本共享
// 状态的问题（这也是选 PocketBase 的同一套取舍）。进程重启会清空计数，
// 可以接受：重启本身就是不常见的运维动作，而限流要挡的是在线暴力破解。
//
// 顺带说明为什么不复用 PocketBase 自带限流：它挂在 PocketBase 自己的
// /api/collections/*/auth-with-password 路由上，而 /v1/auth/login 是
// 我们自定义的路由，不在它的覆盖范围内。
const (
	loginWindow      = 15 * time.Minute
	loginMaxFailures = 8
)

type loginAttempts struct {
	failures int
	firstAt  time.Time
}

type loginThrottle struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempts
}

func (t *loginThrottle) allow(username string, instant time.Time) bool {
	key := normalizeLoginKey(username)
	t.mu.Lock()
	defer t.mu.Unlock()

	window, ok := t.attempts[key]
	if !ok {
		return true
	}
	if instant.Sub(window.firstAt) > loginWindow {
		delete(t.attempts, key)
		return true
	}
	return window.failures < loginMaxFailures
}

func (t *loginThrottle) recordFailure(username string, instant time.Time) {
	key := normalizeLoginKey(username)
	t.mu.Lock()
	defer t.mu.Unlock()

	window, ok := t.attempts[key]
	if !ok || instant.Sub(window.firstAt) > loginWindow {
		t.attempts[key] = &loginAttempts{failures: 1, firstAt: instant}
		return
	}
	window.failures++
}

func (t *loginThrottle) recordSuccess(username string) {
	key := normalizeLoginKey(username)
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.attempts, key)
}

func normalizeLoginKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

var sharedThrottle = &loginThrottle{attempts: make(map[string]*loginAttempts)}

func loginLimiter() *loginThrottle { return sharedThrottle }
