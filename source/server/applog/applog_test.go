package applog

import (
	"bytes"
	"log"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

// 只断言 stderr 这一侧：PocketBase 那一侧是它自己的行为（异步批量写进 _logs
// 表），在这里断言它会把测试绑死在别人的实现细节上。
func TestLogfWritesToStderrWithLevelPrefix(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	original := log.Writer()
	defer log.SetOutput(original)

	cases := []struct {
		level   Level
		message string
		want    string
	}{
		{LevelInfo, "排程已推进", "[INFO] 排程已推进：user=alice"},
		{LevelWarn, "提醒发送失败", "[WARN] 提醒发送失败：user=alice"},
		{LevelError, "解析 VAPID 密钥失败", "[ERROR] 解析 VAPID 密钥失败：user=alice"},
	}
	for _, testCase := range cases {
		var buffer bytes.Buffer
		log.SetOutput(&buffer)

		Logf(app, testCase.level, "%s：user=%s", testCase.message, "alice")

		if got := buffer.String(); !strings.Contains(got, testCase.want) {
			t.Fatalf("期望 stderr 含 %q，得到 %q", testCase.want, got)
		}
	}
}

// 未知等级按 info 处理：调用点写错一个字不该让日志整条消失。
func TestLogfTreatsUnknownLevelAsInfo(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("创建测试应用失败：%v", err)
	}
	defer app.Cleanup()

	original := log.Writer()
	defer log.SetOutput(original)

	var buffer bytes.Buffer
	log.SetOutput(&buffer)
	Logf(app, Level("trace"), "兜底")

	if got := buffer.String(); !strings.Contains(got, "[INFO] 兜底") {
		t.Fatalf("未知等级应落成 [INFO]，得到 %q", got)
	}
}
