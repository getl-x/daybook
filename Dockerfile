# daybook 应用镜像（只跑 HTTP 服务，监听 8090）
#
# 反代与 TLS 由使用者自行部署（nginx / caddy 等），本镜像与 compose 里都不包含。
# 见 DAYBOOK-DESIGN.zh-CN.md §7.1、§7.2；部署步骤见 docs/zh-CN/deployment.md。
#
# 仓库约定：所有代码都在 source/ 下（npm workspaces：shared / server / web）；
# 镜像内部铺平成 /app/{shared,server,web}，与源码里的相对路径保持一致。
#
# 多阶段：
#   阶段 1 在镜像内构建前端（vite build）——镜像可独立构建，不依赖本地产出的 dist；
#   阶段 2 只带生产依赖 + 源码 + 前端产物（Node 24 直跑 TypeScript，运行时无构建步骤）。

# ---------- 阶段 1：构建前端 ----------
FROM node:24-alpine AS web-builder

WORKDIR /app
# source/package.json 声明了 workspaces，npm ci 需要每个 workspace 的 package.json 都在
COPY source/package.json source/package-lock.json ./
COPY source/shared/package.json shared/
COPY source/server/package.json server/
COPY source/web/package.json web/
RUN npm ci --no-audit --no-fund

COPY source/shared ./shared
COPY source/web ./web
RUN npm run build -w @daybook/web

# ---------- 阶段 2：运行时 ----------
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8090

COPY source/package.json source/package-lock.json ./
COPY source/shared/package.json shared/
COPY source/server/package.json server/
COPY source/web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund

COPY source/shared ./shared
COPY source/server ./server
COPY --from=web-builder /app/web/dist ./web/dist

# 健康检查：镜像本身只声明，编排层用它判断容器是否可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

EXPOSE 8090

# 非 root 运行：应用只往 stdout 写日志、不落任何本地文件，用 node 用户即可。
# 数据库里的账号本身也不是 superuser（见 compose.yml）。
USER node

# 启动时先跑迁移（幂等），再起服务
CMD ["sh", "-c", "node server/src/db/migrate.ts && node server/src/index.ts"]
