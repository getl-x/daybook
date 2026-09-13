package app

import "os"

// DatabaseVersion 随每次新增迁移递增；运维排查时用来确认容器里的库结构版本。
const DatabaseVersion = "202609130001"

// Config 是进程启动所需的全部外部配置。
//
// 与 Node 版的差别：不再需要 DATABASE_URL 与 JWT_SECRET——
// 数据库是 PocketBase 自带的 SQLite 单文件，令牌签发由 PocketBase 负责。
type Config struct {
	// DataDir 存放 SQLite 数据库、上传文件与备份。
	DataDir string
	// PublicDir 存放前端构建产物（静态托管）。
	PublicDir string
	// AppVersion 用于健康检查与发布排查。
	AppVersion string
	// VAPIDSubject Web Push 的签发者标识（mailto: 或 https: URL）。
	VAPIDSubject string
	// Addr 监听地址，对应 Node 版固定的容器内 8090 端口。
	Addr string
}

func DefaultConfig() Config {
	return Config{
		DataDir:      envOrDefault("DAYBOOK_DATA_DIR", "pb_data"),
		PublicDir:    envOrDefault("DAYBOOK_PUBLIC_DIR", "pb_public"),
		AppVersion:   envOrDefault("DAYBOOK_VERSION", "dev"),
		VAPIDSubject: envOrDefault("DAYBOOK_VAPID_SUBJECT", "https://daybook.local"),
		Addr:         envOrDefault("DAYBOOK_ADDR", "0.0.0.0:8090"),
	}
}

func envOrDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
