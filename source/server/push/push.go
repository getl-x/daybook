// Package push 是 Web Push 发送的薄适配层。
//
// 为什么不直接用 webpush-go：它的 SendNotificationWithContext 末尾是
// `return client.Do(req)`，**不校验状态码**。订阅失效（404/410）必须被认出来
// 并立即禁用，否则会一直往一个已死的 endpoint 发。所以分类由本包实现。
package push

import (
	"context"
	"fmt"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Status 是发送结果三态。
type Status string

const (
	// StatusSent 表示已交给推送服务。
	StatusSent Status = "sent"
	// StatusGone 表示这条订阅永久发不出去了，调用方应立即禁用、别再重试：
	// 既涵盖 404/410（订阅真的没了），也涵盖 401/403（VAPID 密钥跟订阅不是同一对）。
	StatusGone Status = "gone"
	// StatusFailed 表示暂时性失败，可以重试。
	StatusFailed Status = "failed"
)

// Result 是发送结果；Error 只在非 sent 时非空，便于落库到 last_error。
type Result struct {
	Status Status
	Error  string
}

// Subscription 是发送所需的最小订阅信息。
type Subscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// Sender 抽象发送动作，便于测试注入假实现。
type Sender interface {
	Send(ctx context.Context, subscription Subscription, payload []byte) Result
}

// Options 是发送配置。
type Options struct {
	PublicKey  string
	PrivateKey string
	// Subject 是 VAPID JWT 的 sub（mailto: 或 https: URL）。
	Subject string
	// TTL 是推送服务保留消息的时长；零值取 12 小时。
	TTL time.Duration
}

// DefaultTTL 与 Node 版一致：够覆盖"当天送达"。
const DefaultTTL = 12 * time.Hour

// ClassifyStatus 把 HTTP 状态码映射成三态。纯函数，便于穷举测试。
func ClassifyStatus(statusCode int) Result {
	switch {
	case statusCode >= 200 && statusCode < 300:
		return Result{Status: StatusSent}
	case statusCode == http.StatusNotFound ||
		statusCode == http.StatusGone ||
		statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden:
		// 两类永久失败，都必须立即禁用而不是重试：
		//   404/410 —— 订阅真的没了（用户清数据、卸载、浏览器换 token）；
		//   401/403 —— 本机的 VAPID 密钥跟这条订阅不是同一对，再发一万次也一样。
		// 后者永远不会自愈（典型成因是数据卷被重建），让旧订阅立刻消失比每天刷
		// 失败日志好；决策与代价见 web-push-design §6 D1。
		return Result{Status: StatusGone, Error: fmt.Sprintf("HTTP %d", statusCode)}
	default:
		// 其余（400/413/429/5xx）都是可重试失败，靠 failure_count 累计到
		// FAILURE_LIMIT 后自动禁用。
		return Result{Status: StatusFailed, Error: fmt.Sprintf("HTTP %d", statusCode)}
	}
}

// classifyTransportError 处理请求根本没送出去的情况（DNS/TLS/超时/密钥解码失败）。
func classifyTransportError(err error) Result {
	return Result{Status: StatusFailed, Error: err.Error()}
}

type sender struct {
	options Options
}

// NewSender 构造基于 webpush-go 的发送器。
func NewSender(options Options) Sender {
	if options.TTL <= 0 {
		options.TTL = DefaultTTL
	}
	return &sender{options: options}
}

func (s *sender) Send(ctx context.Context, subscription Subscription, payload []byte) Result {
	response, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: subscription.P256dh,
			Auth:   subscription.Auth,
		},
	}, &webpush.Options{
		Subscriber:      s.options.Subject,
		VAPIDPublicKey:  s.options.PublicKey,
		VAPIDPrivateKey: s.options.PrivateKey,
		TTL:             int(s.options.TTL.Seconds()),
	})
	if err != nil {
		return classifyTransportError(err)
	}
	if response == nil {
		return Result{Status: StatusFailed, Error: "推送服务没有返回响应"}
	}
	defer func() { _ = response.Body.Close() }()

	return ClassifyStatus(response.StatusCode)
}
