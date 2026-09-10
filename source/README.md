# daybook · source

daybook 的**全部应用代码**都在这里，用 npm workspaces 组织（`shared` / `server` / `web`）。
仓库根目录只放入口文档（`README.md`、`DAYBOOK-DESIGN.zh-CN.md`）、Docker 编排（`Dockerfile`、`compose.yml`）与部署输入物（`deploy/`）。

| workspace | 说明 | 入口 |
| --- | --- | --- |
| `@daybook/shared` | 前后端共用纯逻辑（零依赖，只用内置 `Intl`） | `shared/src/time.ts` |
| `@daybook/server` | 后端：Node 24 直跑 TypeScript + Fastify + PostgreSQL | `server/src/index.ts` |
| `@daybook/web` | 前端：React + Vite + Tailwind（PWA） | `web/src/main.tsx` |

依赖统一装在 `source/node_modules`（workspaces 根），`shared` / `server` / `web` 下没有各自的 `node_modules`。

常用命令（都在本目录执行；需要 Node ≥ 24，WSL 见 `docs/zh-CN/development.md`）：

```bash
npm ci                                # 安装依赖（package-lock.json 变更后重跑）
npm test                              # shared + server 的 node --test（server 里含 PGlite 真 SQL）
npm run typecheck -w @daybook/server  # 类型检查（无构建步骤，发布前必跑）
npm run typecheck -w @daybook/web
npm run build -w @daybook/web         # 产出 web/dist（Docker 构建阶段也会跑）
npm run dev -w @daybook/server        # 本地起后端（需要环境里有 DATABASE_URL / JWT_SECRET）
```

文档：仓库根的 `README.md` 与 `DAYBOOK-DESIGN.zh-CN.md`；开发/部署/运维见 `docs/zh-CN/`。
