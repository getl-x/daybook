package ops

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
)

// RegisterCommands 往 PocketBase 的 CLI 上挂两个运维子命令。
//
// 做成子命令而不是脚本：运行镜像里只有这一个二进制，于是容器编排的健康检查
// （Dockerfile 的 HEALTHCHECK、compose 的 healthcheck）可以直接调它，不必假设
// 镜像里有 wget/curl；备份也能 `docker compose exec app daybook backup` 一条命令
// 搞定，还不用在宿主上装东西。
func RegisterCommands(application core.App, root *cobra.Command) {
	root.AddCommand(newHealthcheckCommand())
	root.AddCommand(newBackupCommand(application))
}

func newHealthcheckCommand() *cobra.Command {
	defaultURL := os.Getenv("DAYBOOK_HEALTH_URL")
	if defaultURL == "" {
		defaultURL = "http://127.0.0.1:8090"
	}
	var healthURL string
	command := &cobra.Command{
		Use:   "healthcheck",
		Short: "Check whether the daybook HTTP server is ready",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client := &http.Client{Timeout: 5 * time.Second}
			return CheckHealth(command.Context(), client, healthURL)
		},
	}
	command.Flags().StringVar(&healthURL, "url", defaultURL, "daybook 服务地址或健康检查完整地址")
	return command
}

func newBackupCommand(application core.App) *cobra.Command {
	return &cobra.Command{
		Use:   "backup",
		Short: "Create a manual daybook backup",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			// 备份要用到 DataDir 与 CreateBackup，得先把 app 起起来（只走启动钩子，
			// 不监听 HTTP）。注意这也会顺带跑一次 EnsureDaily——它是幂等的，
			// 代价最多是"今天的第一份日备份由这次手工备份顺带产生"。
			if err := application.Bootstrap(); err != nil {
				return fmt.Errorf("启动应用失败：%w", err)
			}
			defer func() { _ = application.ResetBootstrapState() }()

			manager := BackupManager{
				DataDir: application.DataDir(),
				Create:  application.CreateBackup,
			}
			name, err := manager.CreateManual(command.Context())
			if err != nil {
				return err
			}
			// 只有文件名走 stdout（日志走 stderr）。注意 docker compose exec 会把
			// 两个流一起回显，脚本接的时候得自己丢掉 stderr：
			//   name=$(docker compose exec -T app daybook backup 2>/dev/null)
			_, err = fmt.Fprintln(command.OutOrStdout(), name)
			return err
		},
	}
}
