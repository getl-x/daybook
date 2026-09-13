# daybook 应用镜像（单进程：PocketBase 后端 + 前端产物，监听 8090）
#
# 反代与 TLS 由使用者自行部署（nginx / caddy 等），本镜像与 compose 里都不包含。
# 见 DAYBOOK-DESIGN.zh-CN.md §7.1、§7.2；部署步骤见 docs/zh-CN/deployment.md。
#
# 与 Node 版的差别：数据库换成 PocketBase 内置的 SQLite（单文件，落在
# DAYBOOK_DATA_DIR 下），因此镜像里不再需要 Postgres 客户端，也不再需要
# DATABASE_URL。少一个容器、少一份要单独备份的数据库。
#
# 多阶段：
#   阶段 1 构建前端产物（vite build）
#   阶段 2 构建后端（CGO_ENABLED=0 → 静态二进制）
#   阶段 3 只带二进制 + 前端产物，跑在 alpine 上

# ---------- 阶段 1：构建前端 ----------
FROM node:24-alpine AS web-builder

WORKDIR /app
# source/package.json 声明了 workspaces（现在只有 shared / web），
# npm ci 需要每个 workspace 的 package.json 都在
COPY source/package.json source/package-lock.json ./
COPY source/shared/package.json shared/
COPY source/web/package.json web/
RUN npm ci --no-audit --no-fund

COPY source/shared ./shared
COPY source/web ./web
RUN npm run build -w @daybook/web

# ---------- 阶段 2：构建后端 ----------
FROM golang:1.27-alpine AS server-builder

WORKDIR /src
# 先只拷依赖清单，让 go mod download 这一层能被缓存住
COPY source/server/go.mod source/server/go.sum ./
RUN go mod download

COPY source/server ./
# CGO_ENABLED=0：SQLite 驱动是纯 Go 实现（modernc.org/sqlite），
# 所以能编出静态二进制，运行阶段不需要任何 C 运行库。
# IANA 时区库已由 `import _ "time/tzdata"`（见 main.go）编进二进制，
# 运行镜像同样不必装 tzdata——而"日记日"的计算完全依赖它。
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/daybook .

# ---------- 阶段 3：运行时 ----------
FROM alpine:3.21

# ca-certificates：Web Push 要往浏览器厂商的推送端点发 HTTPS 请求
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 10001 daybook

WORKDIR /app

COPY --from=server-builder /out/daybook /usr/local/bin/daybook
COPY --from=web-builder /app/web/dist /app/pb_public

ENV DAYBOOK_DATA_DIR=/app/pb_data \
    DAYBOOK_PUBLIC_DIR=/app/pb_public \
    DAYBOOK_ADDR=0.0.0.0:8090

# 数据目录必须可写，否则首次启动建库就失败（SQLite 要在这里落 data.db）
RUN mkdir -p /app/pb_data && chown -R daybook:daybook /app
VOLUME ["/app/pb_data"]

# 健康检查：镜像本身只声明，编排层用它判断容器是否可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8090/healthz" >/dev/null 2>&1 || exit 1

EXPOSE 8090

# 非 root 运行
USER daybook

# serve 启动时会跑迁移（幂等），无需额外的初始化步骤
CMD ["daybook", "serve", "--http=0.0.0.0:8090"]
