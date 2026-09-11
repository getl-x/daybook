# 部署手册（自有 VPS + Docker）

面向"一台 VPS、一个人（最多几个朋友）用"的场景。目标：**跑起来、能收到提醒、数据丢了能救回来**。

镜像里**只有应用本身**（HTTP 服务，固定 8090）：TLS、反代、证书都由你在宿主上自己配。

---

## 0. 前置条件

| 需要 | 说明 |
| --- | --- |
| VPS | 1 vCPU / 1 GB 内存也能跑（实测 app ≈ 45 MB、db ≈ 50 MB）；推荐 2C/2G 以上 |
| Docker + compose | `curl -fsSL https://get.docker.com \| sh`，或发行版仓库里的 docker.io + docker-compose-v2 |
| 域名 | 一个 A 记录指向 VPS（提醒需要 HTTPS，Service Worker 只在安全上下文里工作） |
| 反代 | nginx 或 caddy（本文两个都给样例） |
| 备份去处 | 本地目录 + 可选 rsync 到另一台机器/NAS |

---

## 1. 把代码放到服务器

```bash
sudo mkdir -p /opt/daybook && sudo chown "$USER" /opt/daybook
cd /opt/daybook

# 方式 A：从 GitHub 拉（推荐，方便以后升级）
git clone <你的仓库地址> .

# 方式 B：从开发机推（还没建仓库时）
#   在开发机执行：rsync -av --exclude node_modules --exclude source/node_modules --exclude .env \
#     "/mnt/f/Ai Code/personal-projects/daybook/" user@vps:/opt/daybook/
```

---

## 2. 配置 .env

```bash
cp deploy/daybook.env.example .env
chmod 600 .env
```

要填的项（其余保持默认）：

```ini
# 数据库口令：随便长一点，只在本机 compose 网络里用
POSTGRES_PASSWORD=<openssl rand -base64 24 的输出>

# 令牌签名密钥：生产环境必须 ≥ 32 字符，换掉之后所有人需要重新登录
JWT_SECRET=<openssl rand -base64 48 的输出>

PORT=8090
NODE_ENV=production
LOG_LEVEL=info

# Web Push（不填也能启动，只是提醒发不出去，日志会警告）
VAPID_PUBLIC_KEY=<见下>
VAPID_PRIVATE_KEY=<见下>
VAPID_SUBJECT=mailto:you@example.com
```

生成 VAPID 密钥（任选一种）：

```bash
# 在开发机上（有 node）
npx web-push generate-vapid-keys

# 或在服务器上借容器里的依赖生成
cd /opt/daybook && docker compose run --rm app npx web-push generate-vapid-keys
```

> ⚠️ VAPID 私钥决定"已订阅设备"的身份。**换密钥 = 所有设备都要重新订阅**；丢了同样如此。请和 `.env` 一起备份到安全的地方。

---

## 3. 构建并启动

```bash
cd /opt/daybook
docker compose build            # 或用预构建镜像：DAYBOOK_IMAGE=daybook:x.y.z docker compose up -d
docker compose up -d
docker compose ps               # 两个容器都应是 healthy
curl -s http://127.0.0.1:8090/healthz   # {"status":"ok","db":"ok",...}
```

数据库迁移**在容器启动时自动执行**（幂等，失败则拒绝启动），日志里会看到：

```
迁移完成：应用 N 个，跳过 M 个（应用：0001_account_deletion.sql）
前端产物已挂载：/app/web/dist
```

> 如果你在本地试过并留了测试数据：`docker compose down -v` 会连数据卷一起删掉，得到干净的一库。

---

## 4. 建账号（注册是关闭的）

```bash
docker compose exec -T app sh -c "echo '你的口令' | node server/src/cli/user.ts create --username yourname"
docker compose exec -T app node server/src/cli/user.ts list
```

其他账号操作（口令重置、停用/启用、删除）：

```bash
docker compose exec -T app sh -c "echo '新口令' | node server/src/cli/user.ts reset-password --username yourname"
docker compose exec -T app node server/src/cli/user.ts disable --username yourname
docker compose exec -T app node server/src/cli/user.ts purge --username yourname            # 立即彻底删除
docker compose exec -T app node server/src/cli/user.ts purge-expired --grace_days 7         # 清理过期的待删账号
```

> 口令走标准输入，不落 shell 历史。`reset-password` **不会**让已有登录失效，需要的话再 `disable` + `enable` 一次（会立刻作废全部会话）。

---

## 5. 反代与 HTTPS

推送（Web Push）要求 HTTPS，所以这一步不能省。反代请**原样转发** `Authorization` 头，并带上 `X-Forwarded-For`（应用开了 `trustProxy`，登录限流按真实 IP 计数；不带的话所有人共用一个桶）。

### 5.1 nginx

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name diary.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name diary.example.com;

    ssl_certificate     /etc/letsencrypt/live/diary.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/diary.example.com/privkey.pem;

    # 日记正文里可能有长文本，但单次请求仍然很小
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;   # 别丢
        proxy_read_timeout 60s;
    }
}
```

证书：

```bash
sudo apt install certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
sudo certbot --nginx -d diary.example.com --redirect -m you@example.com --agree-tos
sudo systemctl enable --now certbot.timer   # 自动续期
sudo nginx -t && sudo systemctl reload nginx
```

### 5.2 caddy（自动 HTTPS，配置最短）

```caddyfile
diary.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8090 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

> caddy 会自动申请证书。`reverse_proxy` 默认保留 Host 与 Authorization。

### 5.3 验证

```bash
curl -sI https://diary.example.com/healthz | head -1        # HTTP/2 200
curl -s  https://diary.example.com/v1/meta/timezones | head -c 60   # {"error":"unauthorized"} ← 正确
```

---

## 6. 首次使用（手机端）

1. 电脑浏览器打开 `https://diary.example.com` → 用 CLI 建的账号登录 → 「今天」页写一句话确认能存。
2. **iPhone**：Safari 打开站点 → 分享 → **添加到主屏幕** → 从主屏图标打开 → 登录 → 「设置 → 这台设备的通知 → 开启每日提醒」→ 系统弹窗选「允许」。
   （iOS 只有主屏 Web App 能收 Web Push；Safari 标签页里不行。）
3. **Android/桌面 Chrome**：直接登录 → 设置页开启提醒（权限弹窗同意）。
4. 记下你的时区与"日记日从几点开始"（默认 04:00：凌晨写的算前一天）。
5. 想立刻确认能不能收到：设置页把早间提醒改成几分钟后的时间，等 2 分钟（调度每分钟跑一次），然后看「设置 → 最近几次提醒」的状态。

> 提醒口径：**当天送达，不承诺准点**。手机省电模式、系统通知权限、专注模式都会影响送达时刻。

---

## 7. 从已发布的镜像部署（GHCR / Docker Hub，可选）

不想在本机构建、直接用 CI 已经发布好的镜像。CI 会把镜像**同时推到两个仓库**（同一次构建、同名标签），拉哪个都行：

```bash
cd /opt/daybook

# 任选其一
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.0 docker compose up -d
# 或从 Docker Hub 拉（内容与 GHCR 完全一致）
docker pull getl/daybook:0.1.0
DAYBOOK_IMAGE=getl/daybook:0.1.0 docker compose up -d
```

- 版本号请**手动指定**（`0.1.0` 这种），**不要用 `latest`**：`latest` 会被下一次发布覆盖，出问题不好回溯；要升级就显式换一个版本号再 `up -d`。
- **Docker Hub**（`getl/daybook`）：默认 **public**，可匿名 `docker pull getl/daybook:0.1.0`（有频率限制，个人使用足够）；若设为 **private**，先在 VPS 上 `docker login`（`docker login -u getl`，口令填 access token）再拉。
- **GHCR**（`ghcr.io/getl-x/daybook`）：public 包可直接拉；private 先 `echo <你的 PAT> | docker login ghcr.io -u <用户名> --password-stdin`。
- 镜像之外的东西（`.env`、反代、数据卷）和第 2、5 节一致，别漏。

---

## 8. 装上 Android APK（侧载）

1. 打开仓库的 **Releases** 页，下载最新的 `daybook-<版本>-android-<release|debug>.apk`（需要的话用旁边的 `.sha256` 核对）。
2. 手机设置里允许这个来源安装应用（「未知来源」/「安装未知应用」）。
3. 打开 APK 安装 → 启动 → 用账号口令登录。
4. **必须有一个 HTTPS 后端**：APK 里的壳把后端地址写死了（打包时由仓库变量 `DAYBOOK_SERVER_URL` 注入），且只认 HTTPS（`androidScheme: https`）。所以要先按前面几步把站点跑起来、拿到 `https://你的域名`，把它配到仓库变量再出包（见 operations.md 的「配一次」）。

> 提醒现状：APK 里 **Web Push 用不了**（Capacitor 的 WebView 不支持），暂时靠「打开应用」看内容，原生本地通知列入第二迭代；浏览器里把 PWA 加到主屏则 Web Push 照常可用。

---

> 运维（备份/升级/排障）见 [operations.md](operations.md)。
