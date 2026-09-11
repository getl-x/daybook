# 开发指南（本地开发 / 目录约定 / 常见坑）

> 部署与运维见 [deployment.md](deployment.md) 与 [operations.md](operations.md)；产品与技术设计见仓库根目录 [`DAYBOOK-DESIGN.zh-CN.md`](../../DAYBOOK-DESIGN.zh-CN.md)。

## 1. 工具链

- **Node ≥ 24**：后端直接 `node xxx.ts` 跑 TypeScript（类型擦除），没有构建步骤。
- WSL 里系统自带的 Node 22 是**不含 TS 支持**的构建，跑测试会报 `ERR_NO_TYPESCRIPT`。两条路：
  - 在 WSL 里装 Node 24（nvm / NodeSource / 静态包，例如 `/root/.local/node24/bin`）；
  - 或直接用 Windows 侧装好的 Node 24：`"/mnt/c/Program Files/nodejs/node.exe"`。
- 依赖统一装在 `source/node_modules`（npm workspaces 根），`shared` / `server` / `web` 下没有各自的 `node_modules`。

## 2. 目录约定

- **代码全在 `source/`**（workspaces：`shared` / `server` / `web`）；
- 仓库根只放：入口文档（`README.md`、`DAYBOOK-DESIGN.zh-CN.md`）、Docker 编排（`Dockerfile`、`compose.yml`、`.dockerignore`）、部署输入物（`deploy/`）与 `.env`；
- `source/web/dist`、`node_modules`、`backups/` 都是本地产物，不入库（`.gitignore` 是"默认拒绝 + 白名单"）。

## 3. 常用命令

```bash
cd source
npm ci                                # 安装依赖
npm test                              # shared + server + web 全部用例
npm run typecheck -w @daybook/server
npm run typecheck -w @daybook/web
npm run build -w @daybook/web         # 产出 web/dist
npm run dev -w @daybook/server        # 本地起后端（--watch）

# 本地起后端（另法）：先迁移（幂等）再起服务
node server/src/db/migrate.ts && node server/src/index.ts
```

本地起后端需要环境里有 `DATABASE_URL`（一个可连的 PostgreSQL）与 `JWT_SECRET`（生产环境 ≥ 32 字符）；容器里这两个由 compose 注入，本地可以 `export` 好再跑。

## 4. 测试布局

- `source/shared/test/`：纯逻辑（日记日 / 时区 / DST / 提醒推进），零依赖；
- `source/server/test/*.test.ts`：路由与领域逻辑；`helpers/pglite.ts` 用 **PGlite 跑真实 PostgreSQL SQL 与真实迁移**（不需要 Docker）；
- `source/web/test/*.test.ts`：前端纯逻辑单测（如 `src/lib/server.ts` 的服务器地址规范化 / 校验 / 优先级）；
- 前端的其余部分（组件 / 交互）没有单测：靠 `typecheck` + `build` + 浏览器（含无头）手工验证。

## 5. 代码约定

- **类型擦除**：Node 直跑 TS，`enum`、`namespace`、构造器参数属性这类"带运行时语义"的语法不支持（`tsc` 未必拦得住，node 运行时会直接报错）；
- **时间逻辑只能写在 `source/shared/src/time.ts`**：前后端同一份，"日记日"以服务端为准，别在别处自己算日期；
- **迁移只加不改**：`source/server/migrations/*.sql` 一旦应用过就不能再改，否则启动时 checksum 校验失败、拒绝启动；要调整就新增文件；
- `.env` 权限 600，永不入库、不进镜像。

## 6. 已知陷阱

- **发版后第一次打开可能还是旧版**：前端 Service Worker 是"缓存优先 + 后台更新"——旧页面先用缓存渲染、同时在后台拉新包，**再打开一次**才是新版；急着验证就硬刷新（Ctrl/Cmd+Shift+R）或用无痕窗口。
- **`Page.navigate` 到相同 URL 不会重载**：用无头浏览器 / CDP 复验前端时，导航到当前 URL 是 no-op，会拿到旧页面；要 `Page.reload` 或加个无意义的查询参数。
