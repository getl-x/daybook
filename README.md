# daybook

私密、轻量、带固定问题引导的日记应用：**早上回顾昨天并安排今天 → 白天随手记录 → 晚上总结**。

自托管个人版：跑在自己的 VPS 上（Docker），注册关闭（账号用 CLI 创建），提醒走服务端 Web Push（当天送达，不承诺准点）。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| 0. 技术验证 | ✅ `source/shared/src/time.ts`：日记日 04:00 起算 / IANA 时区 / DST 安全 / 提醒时刻（19 个用例） |
| 1. 仓库骨架与地基 | ✅ npm workspaces、迁移、用户名+口令认证（scrypt + JWT + refresh 轮转）、Docker 镜像与 compose |
| 2. 日记核心 | ✅ 今日页（含昨日回顾）、日历页、单日详情与补写、突发事情、字段级保存与冲突提示、离线草稿 |
| 3. 通知（Web Push） | ✅ 设置页（提醒时间/开关/时区/日界）、每分钟排程 tick、订阅管理、iOS 安装引导页 |
| 4. 测试与上线 | 进行中：189 个用例全绿、容器冒烟通过；Android 壳（Capacitor）已能出包；剩真实设备推送验证、导出（第二迭代） |

## 目录约定

**所有代码都在 `source/`**（npm workspaces）；根目录只留入口文档、Docker 编排与部署输入物。
（与同目录下的 `lastdone` 项目同一套摆法：默认拒绝的 `.gitignore` 白名单 + `source/` 收纳源码。）

```text
daybook/
├── DAYBOOK-DESIGN.zh-CN.md     产品与技术设计（当前有效；v1.1 归档在 docs/zh-CN/archive/）
├── README.md                   本文件
├── Dockerfile / compose.yml    容器构建与编排（放根目录）
├── .dockerignore / .gitignore  两份都是「默认拒绝 + 白名单」
├── deploy/                     部署输入物：daybook.env.example、backup.sh（备份脚本）
├── docs/zh-CN/                 面向人的文档：development / deployment / operations
└── source/                     全部应用源码
    ├── package.json            workspaces: shared / server / web
    ├── shared/                 前后端共用纯逻辑（零依赖）：time.ts
    ├── server/                 后端：Node 24 直跑 TS + Fastify + PostgreSQL（src/、migrations/、test/）
    ├── web/                    前端：React + Vite + Tailwind（PWA）
    │   ├── capacitor.config.ts Capacitor（Android 壳）配置
    │   └── android/            Capacitor 生成的 Android 工程（构建产物不入库）
    └── scripts/                构建/资源脚本（make-icons.mjs）
```

`.env` 放在**仓库根目录**（compose 读它），模板是 `deploy/daybook.env.example`；`.env` 永不入库、不进镜像。

## 文档

| 文档 | 说明 |
| --- | --- |
| [`DAYBOOK-DESIGN.zh-CN.md`](DAYBOOK-DESIGN.zh-CN.md) | **产品与技术设计（自托管 + Docker，当前有效）**；末尾有实现与计划的差异记录、代码审查修复记录 |
| [`docs/zh-CN/deployment.md`](docs/zh-CN/deployment.md) | 部署：前置条件、env、构建启动、nginx/caddy 反代与 HTTPS、首次使用（iPhone 主屏） |
| [`docs/zh-CN/operations.md`](docs/zh-CN/operations.md) | 运维：备份与恢复、升级与回滚、排障清单、安全自查、卸载迁移 |
| [`docs/zh-CN/development.md`](docs/zh-CN/development.md) | 开发：工具链、常用命令、目录约定、环境坑 |
| [`docs/zh-CN/archive/diary-app-development-plan-v1.1.md`](docs/zh-CN/archive/diary-app-development-plan-v1.1.md) | 归档：v1.1 三端方案与完整技术评审（历史） |

更早的 v1.0 仍在 `F:\Ai Code\diary-app-development-plan.md`（原始文件，未动）。

## 常用命令

```bash
# 依赖（每个 workspace 共用一份，装在 source/ 下）
cd source && npm ci

# 测试（Node ≥ 24 内置 runner + TS 类型擦除，无需构建）
npm test                       # 在 source/ 里跑
npm run typecheck -w @daybook/server
npm run typecheck -w @daybook/web
npm run build -w @daybook/web

# 本地起后端（需要根目录 .env 里的 DATABASE_URL 与 JWT_SECRET）
node server/src/db/migrate.ts && node server/src/index.ts    # 在 source/ 里跑
```

WSL 注意：系统自带的 Node 22 是**不含 TS 支持**的构建（会报 `ERR_NO_TYPESCRIPT`）。要么把 WSL 的 Node 升到 24，要么用 Windows 的 Node 24：`"/mnt/c/Program Files/nodejs/node.exe" --test ...`。

## 部署（Docker）

```bash
cp deploy/daybook.env.example .env         # 填 POSTGRES_PASSWORD / JWT_SECRET / VAPID_*
DAYBOOK_IMAGE=daybook:dev docker compose up -d   # 或 docker build -t daybook:dev .
```

完整步骤见 [`docs/zh-CN/deployment.md`](docs/zh-CN/deployment.md)。要点：

- 应用容器**固定监听 8090**，只映射到宿主 `127.0.0.1:8090`；TLS 与反代（nginx/caddy）由你自己部署。
- 镜像里**不含** caddy/TLS/反代；容器以非 root（`node`）运行；数据库只在 compose 内网，不映射端口。
- 生成 VAPID 密钥：`npx web-push generate-vapid-keys`，写进 `.env`（不配也能启动，只是提醒发不出去，日志会提示）。

## 发布（GitHub Actions）

三个 workflow 都在 `.github/workflows/`，push / 打标签自动跑（也能在 Actions 页面手动触发）：

| workflow | 触发 | 产物 |
| --- | --- | --- |
| `ci.yml` | push / PR 到 `main` | typecheck（server + web）+ 全部用例 + 前端构建（只验证，不出产物） |
| `docker-publish.yml` | 推 `v*` 标签（或手动） | 先用 compose + 真 Postgres 跑冒烟（healthz 200 / 缺失资源 404 / 受保护接口 401 / 非 root），通过后把镜像**同时推到两个仓库**：`ghcr.io/getl-x/daybook` 与 `docker.io/getl/daybook`（同一次构建、同名标签：`0.1.1` / `0.1` / `latest` / `sha-xxxxx`） |
| `android-release.yml` | 推 `v*` 标签（或手动） | 构建前端 → `cap sync` → gradle 打包 → 把 `daybook-<版本>-android-<release\|debug>.apk` 与 `.sha256` 附到 GitHub Release，同时上传 artifact |

> 推 Docker Hub 需要**一个变量 + 一个 secret**：变量 `DOCKERHUB_USERNAME`（= `getl`）+ secret `DOCKERHUB_TOKEN`（Docker Hub 的 Personal access token）。两个都配全才会推 Docker Hub；缺任一就只推 GHCR，并在 job summary 里标注，**不会让流程失败**。配法见 [`docs/zh-CN/operations.md`](docs/zh-CN/operations.md) 的「配一次：GitHub 上的 secrets 与变量」。

**拉已发布的镜像**（public 仓库的包可直接拉，无需登录）：

```bash
docker pull ghcr.io/getl-x/daybook:0.1.1
docker pull getl/daybook:0.1.1                       # 或从 Docker Hub 拉（内容一致）
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.1 docker compose up -d --no-build
```

> `--no-build` 不能省：`compose.yml` 里有 `build: .`；用已发布镜像时加它，避免在本机重新构建。版本号务必**手动指定**（别用 `latest`，它会被下次发布覆盖、不好回溯）。

**装 Android APK**：到仓库的 Releases 页下载 `.apk`（可选核对 `.sha256`）→ 手机允许「未知来源安装」→ 安装后用账号口令登录。APK 里已内置前端资源（离线能打开壳），后端地址在构建时由仓库变量 `DAYBOOK_SERVER_URL` 注入，所以**必须配一个 HTTPS 后端**才能连上。

> APK 里 **Web Push 用不了**（Capacitor 的 WebView 不支持），暂时靠「打开应用」看内容；浏览器把 PWA 加到主屏则 Web Push 照常可用。原生本地通知列入第二迭代。

## 账号管理（CLI）

```bash
docker compose exec -T app sh -c "echo '口令' | node server/src/cli/user.ts create --username getl --timezone Asia/Shanghai"
docker compose exec -T app sh -c "echo '新口令' | node server/src/cli/user.ts reset-password --username getl"
docker compose exec -T app node server/src/cli/user.ts disable --username getl     # / enable
docker compose exec -T app node server/src/cli/user.ts list

# 删除账号：网页里「设置 → 删除账号」会进入 7 天宽限期，到期自动彻底清除；
# 管理员也可以立即清除：
docker compose exec -T app node server/src/cli/user.ts purge --username getl
docker compose exec -T app node server/src/cli/user.ts purge-expired --grace_days 7
```

> 容器里的路径是 `/app/server/...`（镜像把 `source/` 铺平了），所以命令写成 `node server/src/cli/user.ts`。

## 技术选型（详见设计文档 §6、§7）

- **前端**：React + TypeScript + Vite + Tailwind，PWA（Manifest + Service Worker，hash 路由）
- **后端**：Node 24 直接运行 TypeScript（类型擦除）+ Fastify + `pg`（手写 SQL）
- **部署**：自有 VPS + Docker（应用 + PostgreSQL 16 两个容器），反代自备
- **提醒**：Postgres 任务表 + 每分钟 tick + Web Push（VAPID）；幂等键 `(用户, 日记日, 类型)`
- **时间规则**：日记日从本地 04:00 起算；服务端为唯一权威，前后端共用 `source/shared/src/time.ts`

## 核心数据约定（详见设计文档 §4、§5）

- **当天字段模型**：一条记录描述「这一天自己」；「昨日回顾」是填写入口，不是存储位置。
- **字段级写入**：只提交变更字段 + `base_updated_at`；冲突仍写入但返回 `overwritten`，界面提示。
- **突发事情**：归属日由 `occurred_at` + 时区 + 日界推导，改时间会跨日移动。

## 隐私与安全

日记属于高度私密数据，代码与部署上有这些约束（都有测试或容器验证兜底）：

- 日志不打印日记正文、令牌、推送订阅 endpoint；5xx 只回 `internal_error`，不回数据库原文。
- `.env` 与备份文件权限 600，且被 `.gitignore` 与 `.dockerignore` 双重排除。
- PostgreSQL 不监听公网；应用容器非 root 运行。
- 认证：scrypt 存口令、用户名不存在也走一次 KDF（时序一致）、登录限流（按用户名 + 按真实 IP）、
  refresh 轮转用 CAS 防重放、每次请求校验「账号有效 + 会话未吊销」（登出/停用立即生效）。
- 备份用 [`deploy/backup.sh`](deploy/backup.sh)（cron + 可选 rsync 到异地），恢复步骤写在脚本头部。
