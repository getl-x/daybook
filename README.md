# daybook

私密、轻量、带固定问题引导的日记应用：**早上回顾昨天并安排今天 → 白天随手记录 → 晚上总结**。

自托管个人版：跑在自己的 VPS 上（Docker），注册关闭（账号用 CLI 创建），提醒走服务端 Web Push（当天送达，不承诺准点）。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| 0. 技术验证 | ✅ `shared/src/time.ts`：日记日 04:00 起算 / IANA 时区 / DST 安全 / 提醒时刻（19 个用例） |
| 1. 仓库骨架与地基 | ✅ monorepo、迁移、用户名+口令认证（scrypt + JWT + refresh 轮转）、Docker 镜像与 compose |
| 2. 日记核心 | ✅ 今日页（含昨日回顾）、日历页、单日详情与补写、突发事情、字段级保存与冲突提示、离线草稿 |
| 3. 通知（Web Push） | ✅ 设置页（提醒时间/开关/时区/日界）、每分钟排程 tick、订阅管理、iOS 安装引导页 |
| 4. 测试与上线 | 进行中：174 个用例全绿、容器冒烟通过；剩真实设备推送验证、导出（第二迭代） |

## 文档

| 文档 | 说明 |
| --- | --- |
| [`docs/development-plan.md`](docs/development-plan.md) | **开发计划 v1.4（自托管 + Docker，当前有效）**，末尾有实现与计划的差异记录、审查修复记录 |
| [`docs/diary-app-development-plan-v1.1.md`](docs/diary-app-development-plan-v1.1.md) | 归档：v1.1 三端方案与完整技术评审（历史） |

更早的 v1.0 仍在 `F:\Ai Code\diary-app-development-plan.md`（你的原始文件，未动）。

## 仓库结构

```text
daybook/
├── docs/       开发计划（v1.4 当前 / v1.1 归档）
├── shared/     前后端共用纯逻辑（零依赖）：time.ts
├── server/     后端：Node 24 直跑 TS + Fastify + PostgreSQL（src/、migrations/、test/）
└── web/        前端：React + Vite + Tailwind（PWA，零第三方运行时依赖）
```

## 常用命令

```bash
# 测试（Node ≥ 24 内置 runner + TS 类型擦除，无需构建）
npm test

# 类型检查 / 前端构建
npm run typecheck -w @daybook/server
npm run typecheck -w @daybook/web
npm run build -w @daybook/web

# 本地起后端（需要 .env 里的 DATABASE_URL 与 JWT_SECRET）
node server/src/db/migrate.ts && node server/src/index.ts
```

WSL 注意：系统自带的 Node 22 是**不含 TS 支持**的构建（会报 `ERR_NO_TYPESCRIPT`）。要么把 WSL 的 Node 升到 24，要么用 Windows 的 Node 24：`"/mnt/c/Program Files/nodejs/node.exe" --test ...`。

## 部署（Docker）

```bash
cp .env.example .env        # 填 DATABASE_URL / POSTGRES_PASSWORD / JWT_SECRET / VAPID_*
DAYBOOK_IMAGE=daybook:dev docker compose up -d   # 或 docker build -t daybook:dev .
```

- 应用容器**固定监听 8090**，只映射到宿主 `127.0.0.1:8090`；TLS 与反代（nginx/caddy）由你自己部署。
- 镜像里**不含** caddy/TLS/反代；容器以非 root（`node`）运行。
- 数据库只在 compose 内网，不映射端口。
- 生成 VAPID 密钥：`npx web-push generate-vapid-keys`，写进 `.env`（不配也能启动，只是提醒发不出去，日志会提示）。

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

## 技术选型（详见计划 §6、§7）

- **前端**：React + TypeScript + Vite + Tailwind，PWA（Manifest + Service Worker，hash 路由）
- **后端**：Node 24 直接运行 TypeScript（类型擦除）+ Fastify + `pg`（手写 SQL）
- **部署**：自有 VPS + Docker（应用 + PostgreSQL 16 两个容器），反代自备
- **提醒**：Postgres 任务表 + 每分钟 tick + Web Push（VAPID）；幂等键 `(用户, 日记日, 类型)`
- **时间规则**：日记日从本地 04:00 起算；服务端为唯一权威，前后端共用 `shared/src/time.ts`

## 核心数据约定（详见计划 §4、§5）

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
- 备份定期 rsync 到本地一份（部署侧自理）。
