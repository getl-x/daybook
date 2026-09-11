# daybook

私密、自托管、带固定问题引导的日记：**早上回顾昨天并安排今天 → 白天随手记录 → 晚上总结。**

[English →](README.md)

## 功能

- **引导式固定字段**：`day_plan` / `day_events` / `day_meals` / `evening_summary`，外加「昨日回顾」填写入口。
- **日历补写**与**单日详情**。
- **突发事情**按时间自动归属到某一天（考虑时区与日界）。
- **字段级自动保存**，写入覆盖了更新的内容时会明确提示冲突。
- **离线草稿**：存在 IndexedDB 里，恢复联网后自动重放。
- **每日 Web Push 提醒**（VAPID），支持每用户时区与日界（日记日从本地 04:00 起算）；**静默时段**会把窗口内的提醒推迟到窗口结束（太晚则当天不发）。VAPID 密钥自动生成，无需配置。
- **多设备**：设置页能看到每台订阅提醒的设备（设备名、平台、失败次数），并**单独开关**——关掉某一台不影响其他设备。
- **可安装的 PWA**：添加到主屏即可；iOS 16.4+ 也能收 Web Push。
- **可选 Android APK**（Capacitor 壳），首次启动填写服务器地址。
- **注册关闭**，账号用 CLI 创建。
- **账号删除**有 7 天宽限期，也可以从 CLI 立即清除。
- **无第三方脚本、无遥测。**

## 快速开始（Docker）

```bash
git clone https://github.com/getl-x/daybook.git
cd daybook

cp deploy/daybook.env.example .env
# 编辑 .env：填好 POSTGRES_PASSWORD 与 JWT_SECRET（≥ 32 字符）。VAPID 密钥自动生成，无需配置。

docker pull ghcr.io/getl-x/daybook:0.1.2

DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.2 docker compose up -d --no-build

docker compose ps
curl -s http://127.0.0.1:8090/healthz   # {"status":"ok","db":"ok","time":"..."}
```

创建第一个账号（注册已关闭）：

```bash
docker compose exec -T app sh -c "echo '你的口令' | node server/src/cli/user.ts create --username 你的名字 --timezone Asia/Shanghai"
```

此时应用只监听 `127.0.0.1:8090`。要让公网访问，得在它前面加一层带 TLS 的反代——见下方「自托管」。

> `--no-build` 不能省：`compose.yml` 里有 `build: .`，不加它 Compose 会尝试在本机重新构建，而不是用拉下来的镜像。版本号务必**手动固定**，别用 `latest`（它会被下次发布覆盖）。

## 自托管

完整、可逐条粘贴的步骤在 [`docs/zh-CN/deployment.md`](docs/zh-CN/deployment.md)。要点：

- 应用容器**固定监听 8090**，只映射到宿主的 `127.0.0.1`；TLS 与反代（nginx / caddy 等）由你自己部署。
- 镜像里**只有应用本身**——不含反代、不做 TLS。
- 数据库**只在 Compose 内网可见**，不映射任何宿主端口。
- **必须 HTTPS**：APK 禁止明文流量，Web Push 与 Service Worker 也只在安全上下文里工作。
- 提醒是尽力而为的——**当天送达，不承诺准点**。

## Android 应用

1. 到 [Releases](../../releases) 页下载 APK（可选核对配套的 `.sha256`）。
2. 在手机设置里允许「未知来源」安装。
3. 首次启动填写服务器地址（必须 `https://`），填一次会记住。

- APK 已内置前端资源，**默认不绑任何域名**。自己打包时，可以用仓库变量 `DAYBOOK_SERVER_URL` 预设默认地址。
- APK 在本机**排本地提醒**（非精确闹钟、不用 Google 服务 / FCM）；浏览器里的 PWA 仍走 Web Push。重启手机后需打开一次应用才会重新登记。

## 开发

```bash
cd source
npm ci

npm test                        # 202 个用例
npm run typecheck -w @daybook/server
npm run typecheck -w @daybook/web
npm run build -w @daybook/web   # 产出 web/dist

# 本地起后端（需要环境里有 DATABASE_URL 与 JWT_SECRET）
node server/src/db/migrate.ts && node server/src/index.ts
```

需要 **Node ≥ 24**：后端靠内置的 TS 类型擦除直接运行 TypeScript。Node 太老会报 `ERR_NO_TYPESCRIPT`。

## 技术选型

- **前端**：React + TypeScript + Vite + Tailwind，PWA（Manifest + Service Worker，hash 路由）。
- **后端**：Node 24 直接运行 TypeScript（类型擦除）+ Fastify + `pg`（手写 SQL）。
- **数据库**：PostgreSQL 16。
- **部署**：自有 VPS + Docker（应用 + Postgres 两个容器）；反代自备。
- **提醒**：Postgres 任务表 + 每分钟 tick + Web Push（VAPID），幂等键 `(用户, 日记日, 类型)`。
- **时间规则**：日记日从本地 04:00 起算；服务端为唯一权威，前后端共用 `source/shared/src/time.ts`。

## 目录约定

根目录只留入口文档、Docker 构建/编排与部署输入物；**所有代码都在 `source/`**（npm workspaces）。

```text
daybook/
├── DAYBOOK-DESIGN.zh-CN.md     产品与技术设计（当前有效；v1.1 归档在 docs/zh-CN/archive/）
├── README.md                   英文说明
├── README.zh-CN.md             本文件
├── LICENSE                     MIT
├── Dockerfile / compose.yml    容器构建与编排（放根目录）
├── .dockerignore / .gitignore  两份都是「默认拒绝 + 白名单」
├── deploy/                     部署输入物：daybook.env.example、backup.sh
├── docs/zh-CN/                 面向人的文档：development / deployment / operations
└── source/                     全部应用源码
    ├── package.json            workspaces: shared / server / web
    ├── shared/                 前后端共用纯逻辑（零依赖）：time.ts
    ├── server/                 后端：Node 24 直跑 TS + Fastify + PostgreSQL（src/、migrations/、test/）
    ├── web/                    前端：React + Vite + Tailwind（PWA）
    │   ├── test/               前端纯逻辑单测（如服务器地址规范化/校验）
    │   ├── capacitor.config.ts Capacitor（Android 壳）配置
    │   └── android/            Capacitor 生成的 Android 工程（构建产物不入库）
    └── scripts/                构建/资源脚本（make-icons.mjs）
```

`.env` 放在**仓库根目录**（Compose 读它），模板是 `deploy/daybook.env.example`。`.env` 永不入库、不进镜像。

## Fork / 自建注意事项

这是个自托管项目，多数人会部署**自己构建的版本**。fork 之后有几处要改：

1. **镜像**：GitHub Packages 上的 `ghcr.io/getl-x/daybook` 是**上游**镜像。fork 后请构建自己的镜像并推到自己的 registry，把 `DAYBOOK_IMAGE` 指向它（任意镜像引用都行）。
2. **Android `applicationId`** 是 `com.getlx.daybook`。自己发版就换成自己的——注意换了就是**新的 App 身份**，已安装的用户必须卸载重装。
3. **用自己的 keystore 签正式包**（见 [`docs/zh-CN/operations.md`](docs/zh-CN/operations.md) 的「一个 jks 供多个 App 复用」）。
4. **把文档里的示例域名** `diary.example.com` 换成你自己的。
5. **上游向 GHCR / Docker Hub 推送**配了变量 `DOCKERHUB_USERNAME` + secret `DOCKERHUB_TOKEN`。fork 里默认不会推：缺任一项时流程会**跳过** Docker Hub 这一步并给出说明，**不会失败**。

## 隐私与安全

日记属于高度私密数据，代码与部署上有这些约束（都有测试或容器验证兜底）：

- 日志不打印日记正文、令牌、推送订阅 endpoint；5xx 只回 `internal_error`，不回数据库原文。
- `.env` 与备份文件权限 600，且被 `.gitignore` 与 `.dockerignore` 双重排除。
- PostgreSQL 不监听公网；应用容器非 root 运行。
- 认证：scrypt 存口令、用户名不存在也走一次 KDF（时序一致）、登录限流（按用户名 + 按真实 IP）、refresh 轮转用 CAS 防重放、每次请求校验「账号有效 + 会话未吊销」（登出/停用立即生效）。
- 备份用 [`deploy/backup.sh`](deploy/backup.sh)（cron + 可选 rsync 到异地），恢复步骤写在脚本头部。

## 状态与路线图

**已发布 v0.1.2**（Docker 镜像 + Android APK）。

下一步：

- 导出（Markdown / JSON）。
- 回顾统计。
- 冲突合并 UI。
- 原生本地通知。

## 许可证

[MIT](LICENSE)。
