# 部署手册（自有 VPS + Docker，逐条可粘贴）

> 目标：一台 VPS 从零到"能登录、能收提醒、数据丢了能救回来"。下面命令**按顺序**在 VPS 上执行即可，每条都能直接粘贴。
>
> 本文用域名 **`diary.example.com`**、目录 **`/opt/daybook`** 做例子；换域名时全局替换 `diary.example.com`。假设系统是 Ubuntu/Debian（apt），Docker 与 docker compose 已装好。
>
> 镜像里**只有应用本身**（HTTP 服务，固定 8090）：TLS、反代、证书都由你在宿主上自己配。两个 registry（`ghcr.io/getl-x/daybook`、`docker.io/getl/daybook`）的包都是 **public，无需 `docker login`**。

---

## 0. 前置（已就绪就跳过）

```bash
docker version          # 有 Server 段即可
docker compose version  # 有输出即可
dig +short diary.example.com   # 应出 VPS 的 IP（域名 A 记录已指向本机）
```

- 需要一个 A 记录指向本机 IP 的域名（提醒 / APK 都要 HTTPS）。
- 只放行 22（SSH）/ 80 / 443 三个对外端口；8090 不对公网开（见第 6 节）。

---

## 1. 把代码拉到 /opt/daybook

```bash
sudo mkdir -p /opt/daybook && sudo chown "$USER" /opt/daybook
git clone https://github.com/getl-x/daybook.git /opt/daybook
cd /opt/daybook
git log --oneline -1          # 确认拉到代码
```

> 仓库是 public，`git clone` 不需要认证。以后升级就是 `cd /opt/daybook && git pull`（见第 9 节）。

---

## 2. 配置 .env

```bash
cd /opt/daybook
cp deploy/daybook.env.example .env
chmod 600 .env
```

生成两个随机串（把输出粘进 .env）：

```bash
openssl rand -base64 24      # → POSTGRES_PASSWORD（数据库口令，仅 compose 内网用）
openssl rand -base64 48      # → JWT_SECRET（生产环境必须 ≥ 32 字符，否则拒绝启动）
```

编辑 `nano .env`，**只改这几项**（其余保持默认）：

```ini
POSTGRES_PASSWORD=<上面第一条的输出>
JWT_SECRET=<上面第二条的输出>
NODE_ENV=production
```

### VAPID（Web Push 密钥；不配也能启动，只是提醒发不出去）

任选一种，输出里 Public / Private Key 各一行：

```bash
# A. 借已拉的镜像里的依赖生成（无需本机装 node；需先做第 3 步的 docker pull）
docker run --rm --entrypoint npx ghcr.io/getl-x/daybook:0.1.2 web-push generate-vapid-keys

# B. 本机有 node 时
npx web-push generate-vapid-keys
```

填进 .env：

```ini
VAPID_PUBLIC_KEY=<Public Key>
VAPID_PRIVATE_KEY=<Private Key>
VAPID_SUBJECT=mailto:you@example.com    # ← 改成你的邮箱
```

> ⚠️ VAPID 私钥是"已订阅设备"的身份：**换密钥或丢失 = 所有设备重新订阅**。和 .env 一起安全备份。

**`CORS_ORIGINS` 不用改**：浏览器里的 PWA 与后端同源、根本用不到 CORS；Android APK 的源 `https://localhost` 已在默认名单里放行。只有在别处（例如另一个域名的自建页面）要调接口时才需要加。

---

## 3. 选镜像并启动

```bash
cd /opt/daybook

# 固定一个版本号，别用 latest（latest 会被下次发布覆盖，出问题不好回溯）
docker pull ghcr.io/getl-x/daybook:0.1.2

# --no-build 很关键：compose.yml 里有 build: .，不加这个参数会尝试在本机重新构建
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.2 docker compose up -d --no-build
```

> 从 Docker Hub 拉也一样（内容完全一致）：`docker pull getl/daybook:0.1.2`，然后把 `DAYBOOK_IMAGE` 换成 `getl/daybook:0.1.2`。

确认起来了：

```bash
docker compose ps                      # app 与 db 都应是 running / healthy
docker compose logs app --tail 50      # 应看到下面几行
curl -s http://127.0.0.1:8090/healthz  # {"status":"ok","db":"ok","time":"..."}
```

日志里应能看到：

```
迁移完成：应用 N 个，跳过 M 个（应用：0001_....sql）
前端产物已挂载：/app/web/dist
daybook 已就绪：容器内 :8090，反代请指向 http://127.0.0.1:8090
```

> 若只看到「未找到前端产物」= 镜像里缺 `web/dist`（构建阶段失败），换一个标签重拉。
> 迁移**每次启动都自动跑**、幂等；失败则容器拒绝启动。

---

## 4. 建第一个账号（注册已关闭）

账号只能用容器里的 CLI 建。口令走标准输入，**不经过命令行参数、不落 shell 历史**：

```bash
cd /opt/daybook
docker compose exec -T app sh -c "echo '换成你的口令' | node server/src/cli/user.ts create --username getl --timezone Asia/Shanghai"
docker compose exec -T app node server/src/cli/user.ts list    # 确认建好了
```

> 用户名 3–32 位，只允许小写字母、数字、下划线、连字符；`--timezone` 可省（默认 UTC）。其它账号操作（重置口令、停用/启用、删除）见 operations.md。

---

## 5. nginx 反代 + HTTPS

先判断机器上有没有 nginx：

```bash
nginx -v 2>/dev/null && echo "已有 nginx" || echo "需要新装 nginx"
```

没有就装（已装过也能安全重跑，apt 会跳过）：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
```

### 5.1 先放一个只监听 80 的最小站点（让 certbot 能验证域名）

```bash
sudo tee /etc/nginx/sites-available/daybook >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name diary.example.com;                 # ← 改我
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/daybook /etc/nginx/sites-enabled/daybook
sudo rm -f /etc/nginx/sites-enabled/default        # 别让默认站点抢域名（不存在就忽略）
sudo nginx -t && sudo systemctl reload nginx
```

### 5.2 签证书

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d diary.example.com \
  -m you@example.com --agree-tos --no-eff-email     # ← 邮箱改我
```

### 5.3 换成完整配置（HTTPS + 反代头 + 缓存 + gzip）

```bash
sudo tee /etc/nginx/sites-available/daybook >/dev/null <<'EOF'
# 80：只留 ACME 挑战，其余一律跳 HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name diary.example.com;                  # ← 改我
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# 443：反代到应用
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    # ↑ nginx ≥ 1.25.1 可改用 `listen 443 ssl;` + 单独一行 `http2 on;`
    server_name diary.example.com;                  # ← 改我

    ssl_certificate     /etc/letsencrypt/live/diary.example.com/fullchain.pem;   # ← 改我
    ssl_certificate_key /etc/letsencrypt/live/diary.example.com/privkey.pem;     # ← 改我

    # 日记正文单次请求很小，1m 足够
    client_max_body_size 1m;

    # 文本类资源压一压
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_vary on;
    gzip_types text/plain text/css application/javascript application/json
               application/manifest+json image/svg+xml;

    # 带内容哈希的构建产物：长缓存、immutable
    location /assets/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # 应用壳与 Service Worker 不缓存：发版后立刻拿新版
    location = /sw.js                { proxy_pass http://127.0.0.1:8090; add_header Cache-Control "no-cache"; }
    location = /index.html           { proxy_pass http://127.0.0.1:8090; add_header Cache-Control "no-cache"; }
    location = /manifest.webmanifest { proxy_pass http://127.0.0.1:8090; add_header Cache-Control "no-cache"; }

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;   # 千万别丢
        proxy_read_timeout 60s;
    }
}
EOF

sudo nginx -t && sudo systemctl reload nginx
```

### 5.4 自动续期

证书 90 天到期，certbot 装了 systemd timer 会自动续；让续期成功后自动 reload nginx：

```bash
sudo systemctl enable --now certbot.timer
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run          # 演练一次，确认续期链路通
```

> 用 Caddy 的话更简单（自动 HTTPS、自动续期）：`diary.example.com { encode gzip; reverse_proxy 127.0.0.1:8090 { header_up X-Forwarded-For {remote_host} } }`，`reverse_proxy` 默认保留 Host 与 Authorization。

---

## 6. 防火墙与安全

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**不要**开 8090：它只该绑在环回地址，公网进不来。核对三点：

```bash
ss -ltnp | grep 8090          # 应显示 127.0.0.1:8090（不是 0.0.0.0:8090）
docker compose ps             # db 那一行的 PORTS 应为空
docker compose port db 5432   # 应无任何输出（= 没映射到宿主）
```

---

## 7. 备份（务必配）

```bash
cd /opt/daybook
bash deploy/backup.sh          # 手动跑一次
ls -lh backups/                # 应看到 daybook-YYYYmmdd-HHMMSS.dump，且 > 1KB
```

放进 cron，每天 04:30 自动备份（日记日 04:00 切换，避开提醒高峰）：

```bash
sudo tee /etc/cron.d/daybook-backup >/dev/null <<'EOF'
30 4 * * * root cd /opt/daybook && bash deploy/backup.sh >> /var/log/daybook-backup.log 2>&1
EOF
```

> 用 `crontab -e` 也行，加同一行、去掉行首的 `root`。
> 可选：`BACKUP_DIR=/mnt/backup/daybook KEEP_DAYS=30 bash deploy/backup.sh`（默认 `./backups`、保留 14 天）；异地再加 `RSYNC_TARGET=user@nas:/path/`。
> 恢复步骤写在 `deploy/backup.sh` 头部注释里（**先 `docker compose stop app`**，再 `pg_restore`）。⚠️ 备份**不含** .env（JWT_SECRET / VAPID 私钥要单独保管，否则恢复后所有人重新登录、设备重新订阅）。

---

## 8. 验证清单

从**外网**（任意机器）：

```bash
curl -s  https://diary.example.com/healthz                                            # {"status":"ok","db":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' https://diary.example.com/v1/meta/timezones  # 401（受保护接口）
curl -s -o /dev/null -w '%{http_code}\n' https://diary.example.com/assets/nope.js     # 404（缺失静态资源）
curl -s -o /dev/null -w '%{http_code}\n' https://diary.example.com/day/2026-01-01     # 200（SPA 回退）
```

> 注意：只有「像静态资源」的路径（`/assets/*` 或带扩展名）和 `/v1/*` 才返回 404；随便一个 `/nope` 会回 SPA 的 index.html（200），这是正常的。

浏览器 / 手机：

- [ ] 打开 `https://diary.example.com` → 用第 4 步的账号登录 → 「今天」写一句能存。
- [ ] **iPhone**：Safari 打开 → 分享 → **添加到主屏幕** → 从主屏图标打开 → 登录 → 设置开启提醒（iOS 只有主屏 Web App 能收 Web Push）。
- [ ] **Android / 桌面 Chrome**：直接登录 → 设置开启提醒。
- [ ] 手机侧载 APK（见下方「附：装上 Android APK」）。

> 设置里确认「时区」与「日记日开始时间」（默认 04:00，凌晨写的算前一天）。
> 想立刻确认能不能收到提醒：把早间提醒改成几分钟后的时间，等 2 分钟（调度每分钟跑一次），再看「设置 → 最近几次提醒」。
> 提醒口径：**当天送达、不承诺准点**；手机省电模式、系统通知权限、专注模式都会影响送达时刻。

---

## 9. 升级与回滚

**升级**（换新版本）：

```bash
cd /opt/daybook
git pull                                     # 更新 compose.yml 等编排（别覆盖 .env）
docker pull ghcr.io/getl-x/daybook:0.1.2     # ← 换成新版本
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.2 docker compose up -d --no-build
docker compose logs app --tail 30            # 看到「迁移完成」
```

**回滚** = 把版本号改回旧的、重起：

```bash
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.1 docker compose up -d --no-build
```

- 升级 / 回滚**只换 app 容器**，数据库卷 `pgdata` 原样保留，数据不会丢。
- **不要**用 `docker compose down -v`：`-v` 会连数据卷一起删。
- 迁移是「只加不改」的风格，回滚一般安全；涉及删列的迁移要谨慎。

---

## 10. 常见坑

- **反代后的真实 IP**：应用开了 `trustProxy`，登录限流按 `X-Forwarded-For` 里的真实 IP 计数。反代务必带上该头（第 5 节配置已含），否则所有人共用一个限流桶，30 次就把大家锁 15 分钟。
- **必须 HTTPS**：APK 里写死了 `cleartext: false`（只认 HTTPS）；Web Push 与 Service Worker 也只在安全上下文里工作。没证书 = 手机端用不了。
- **发版后第一次打开可能还是旧版**：Service Worker 是「缓存优先 + 后台更新」——旧页面先用缓存渲染、同时后台拉新版，**再打开一次**就是新版（静态资源按内容哈希命名，不会新旧混用）。急着看新版就硬刷新（Ctrl/Cmd+Shift+R）或用无痕窗口。
- **重启自愈**：app 与 db 都设了 `restart: unless-stopped`，机器重启后自动把栈拉起来；每次启动自动跑迁移（幂等）。
- **改过 `POSTGRES_PASSWORD` 但数据卷是旧口令**：容器会起不来。要么改回原口令，要么清卷重来（先备份！）。

---

## 附：装上 Android APK（侧载）

1. 打开仓库的 **Releases** 页，下载最新的 `daybook-<版本>-android-<release|debug>.apk`（可用旁边的 `.sha256` 核对）。
2. 手机设置里允许这个来源安装应用（「未知来源」/「安装未知应用」）。
3. 打开 APK 安装 → 启动 → 用账号口令登录。
4. **服务器地址不写死了**：APK **默认不绑任何域名**，首次启动会要求填服务器地址（必须 `https://`；WebView 的源是 `https://localhost`，所以只认绝对地址，见 `androidScheme: https`）。自建者如果想给自己发的包预设默认地址，可选地在仓库变量里设 `DAYBOOK_SERVER_URL`（见 operations.md 的「配一次」）；不设也行 —— 用户首次启动自己填，填一次会记住。

> 提醒现状：APK 在本机**排本地提醒**（非精确闹钟、不用 Google 服务 / FCM；重启手机后需打开一次应用重新登记）；浏览器里把 PWA 加到主屏仍走 Web Push。

---

> 运维（备份 / 升级 / 排障 / 卸载）见 [operations.md](operations.md)。
