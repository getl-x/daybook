package push

import (
	"errors"
	"testing"
)

// 分类是纯函数，穷举状态码——真实推送服务才会回 404/410，本地编不出来。
func TestClassifyStatus(t *testing.T) {
	cases := []struct {
		code int
		want Status
	}{
		{200, StatusSent},
		{201, StatusSent},
		{202, StatusSent},
		{204, StatusSent},
		{404, StatusGone},
		{410, StatusGone},
		// 401/403（VAPID 密钥跟订阅不是同一对）是永久失败 → 与 404/410 一样
		// 立即禁用，不再靠 failure_count 慢慢熬（决策见 web-push-design §6 D1）。
		{401, StatusGone},
		{403, StatusGone},
		{400, StatusFailed},
		{413, StatusFailed},
		{429, StatusFailed},
		{500, StatusFailed},
		{503, StatusFailed},
	}
	for _, tc := range cases {
		got := ClassifyStatus(tc.code)
		if got.Status != tc.want {
			t.Errorf("状态码 %d：期望 %s，得到 %s", tc.code, tc.want, got.Status)
		}
		if tc.want != StatusSent && got.Error == "" {
			t.Errorf("状态码 %d：失败必须带上原因，现在为空", tc.code)
		}
		if tc.want == StatusSent && got.Error != "" {
			t.Errorf("状态码 %d：成功不该带错误，得到 %q", tc.code, got.Error)
		}
	}
}

func TestClassifyStatusIncludesCodeInError(t *testing.T) {
	if got := ClassifyStatus(503); got.Error != "HTTP 503" {
		t.Errorf("期望错误文案 \"HTTP 503\"，得到 %q", got.Error)
	}
	if got := ClassifyStatus(410); got.Error != "HTTP 410" {
		t.Errorf("期望错误文案 \"HTTP 410\"，得到 %q", got.Error)
	}
}

func TestClassifyTransportErrorIsRetryable(t *testing.T) {
	got := classifyTransportError(errors.New("dial tcp: i/o timeout"))
	if got.Status != StatusFailed {
		t.Fatalf("传输层错误应可重试，得到 %s", got.Status)
	}
	if got.Error == "" {
		t.Error("失败必须带上原因")
	}
}

func TestNewSenderDefaultsTTL(t *testing.T) {
	instance, ok := NewSender(Options{PublicKey: "p", PrivateKey: "k", Subject: "mailto:a@b.c"}).(*sender)
	if !ok {
		t.Fatal("NewSender 应返回 *sender")
	}
	if instance.options.TTL != DefaultTTL {
		t.Fatalf("零值 TTL 应兜底为 %v，得到 %v", DefaultTTL, instance.options.TTL)
	}
}
