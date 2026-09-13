// Package vapid 负责 Web Push 的 VAPID 密钥解析与持久化。
//
// 与 Node 版的差别：**不再支持从环境变量注入密钥**（设计已决策）。所以这里
// 只有两级优先级——库里已存的可用密钥 > 生成一对并写回。
//
// 密钥放在 app_settings 而不是 .env：容器换机器、卷被重建时不用人工搬密钥。
// 这点很要紧——密钥一变，所有已存在的订阅都会开始收 401/403，直到各自的
// failure_count 撞到 failure_limit 被自动禁用为止。
package vapid

import (
	"encoding/json"
	"fmt"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/getl-x/daybook/source/server/applog"
	"github.com/getl-x/daybook/source/server/store"
	"github.com/pocketbase/pocketbase/core"
)

// SettingKey 是 app_settings 里保存 VAPID 密钥用的键名（与 Node 版一致）。
const SettingKey = "vapid_keys"

// DefaultSubject 是没配置 subject 时的兜底值。
//
// 刻意不沿用 Node 版的 mailto:noreply@localhost：https: 形式同样合法，而且
// 这个值已经写在 deploy/daybook.env.example 里文档化了，改成 mailto: 会让
// 现有部署的说明与实际行为不一致。
const DefaultSubject = "https://daybook.local"

// Keys 是一对 VAPID 密钥。
type Keys struct {
	PublicKey  string
	PrivateKey string
}

// storedKeys 是落库的 JSON 形状。
//
// 字段名逐字对齐 Node 版（publicKey/privateKey），这样同一份 app_settings
// 在两种实现之间来回迁移都不用转换。
type storedKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// SubjectOrDefault 归一 VAPID JWT 的 sub：空串或全空白回落到默认值。
func SubjectOrDefault(subject string) string {
	if trimmed := strings.TrimSpace(subject); trimmed != "" {
		return trimmed
	}
	return DefaultSubject
}

// ResolveKeys 取一对 VAPID 密钥：优先用 app_settings 里已存的，没有（或存的
// 不是合法 JSON）则生成一对并写回。
//
// subject 只用于日志：密钥与 subject 不匹配（比如换了域名却沿用旧密钥）是推送
// 全线 401/403 的经典成因，出事时要能从启动日志里看出当时用的是哪个 sub。
func ResolveKeys(app core.App, subject string) (*Keys, error) {
	resolvedSubject := SubjectOrDefault(subject)

	raw, found, err := store.GetAppSetting(app, SettingKey)
	if err != nil {
		return nil, fmt.Errorf("读取 VAPID 密钥失败：%w", err)
	}
	if found {
		if keys, ok := parseStoredKeys(raw); ok {
			applog.Logf(app, applog.LevelInfo,
				"使用 app_settings 里已保存的 VAPID 密钥：subject=%s", resolvedSubject)
			return keys, nil
		}
		// 脏数据（手工改库、更早版本写入的别的形状）不该让服务起不来：
		// 重新生成一对覆盖掉。代价是已存在的订阅要等到下一次推送才发现失效。
		applog.Logf(app, applog.LevelWarn,
			"app_settings 里的 VAPID 密钥不可用，将重新生成一对：subject=%s", resolvedSubject)
	}

	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return nil, fmt.Errorf("生成 VAPID 密钥失败：%w", err)
	}
	payload, err := json.Marshal(storedKeys{PublicKey: publicKey, PrivateKey: privateKey})
	if err != nil {
		return nil, fmt.Errorf("序列化 VAPID 密钥失败：%w", err)
	}
	if err := store.SetAppSetting(app, SettingKey, string(payload)); err != nil {
		return nil, fmt.Errorf("保存 VAPID 密钥失败：%w", err)
	}
	applog.Logf(app, applog.LevelInfo,
		"已生成 VAPID 密钥并存入 app_settings：subject=%s", resolvedSubject)
	return &Keys{PublicKey: publicKey, PrivateKey: privateKey}, nil
}

// parseStoredKeys 解析落库的 JSON；任何一个键为空都算不可用。
//
// 不校验密钥本身是不是合法的 P-256 点：那要等到真正发送时才暴露，
// 而现在多一层校验只会把"脏数据"变成启动失败。
func parseStoredKeys(raw string) (*Keys, bool) {
	var parsed storedKeys
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, false
	}
	if parsed.PublicKey == "" || parsed.PrivateKey == "" {
		return nil, false
	}
	return &Keys{PublicKey: parsed.PublicKey, PrivateKey: parsed.PrivateKey}, true
}
