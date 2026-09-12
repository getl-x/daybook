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
openssl rand -hex 32         # → POSTGRES_PASSWORD（数据库口令，仅 compose 内网用）
openssl rand -base64 48      # → JWT_SECRET（生产环境必须 ≥ 32 字符，否则拒绝启动）
```

> **口令为什么用 hex 而不是 base64**：`POSTGRES_PASSWORD` 会被拼进 `DATABASE_URL`（`postgres://daybook:<口令>@db:5432/daybook`）。hex 只含 `0-9a-f`，不会与 URL 语法冲突；base64 可能含 `/`、`+`，其中 `/` 会直接让连接串解析失败（应用报「迁移失败：Invalid URL」）。**不进 URL 的 `JWT_SECRET` 仍用 `-base64 48`**。

编辑 `nano .env`，**只改这几项**（其余保持默认）：

```ini
POSTGRES_PASSWORD=<上面第一条的输出>
JWT_SECRET=<上面第二条的输出>
NODE_ENV=production
```

### VAPID（Web Push 密钥；**不用配**）

服务端首次启动时会**自动生成**一对 VAPID 密钥并存入数据库（`app_settings` 表），之后每次启动都复用；**.env 里什么都不用填**。

只有两种情况才需要手动配置（配置后以环境变量优先）：
- 想在多实例 / 迁移时**固定**同一对密钥；
- 从旧部署（密钥原本在 .env）沿用已经订阅的设备。

手动生成时，任选一种，输出里 Public / Private Key 各一行：

```bash
# A. 借已拉的镜像里的依赖生成（无需本机装 node；需先做第 3 步的 docker pull）
docker run --rm --entrypoint npx ghcr.io/getl-x/daybook:0.1.2 web-push generate-vapid-keys

# B. 本机有 node 时
npx web-push generate-vapid-keys
```

```ini
VAPID_PUBLIC_KEY=<Public Key>
VAPID_PRIVATE_KEY=<Private Key>
VAPID_SUBJECT=mailto:you@example.com    # 可选；不填默认 mailto:noreply@localhost
```

> ⚠️ VAPID 私钥是"已订阅设备"的身份：**换密钥或丢失 = 所有设备重新订阅**。自动生成的密钥随数据库一起备份；手配在 .env 的请连同 .env 一起保管。

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

## 在共享反代网络里部署（多个 compose 项目共用 web 网络）

很多 VPS 上会用一张**公共 bridge 网络**（惯例叫 `web`，比如子网 `172.20.2.0/24`）把反代和各业务串起来：反代、vaultwarden、其它栈都挂在这张网络上，用容器 IP 互访。daybook 要么是它的一员，要么和反代写在**同一份文件**里。下面两条路选一条即可。

### 拓扑一：daybook 单独一个 compose 项目（推荐）

daybook 用自己的 compose 项目跑，只把 `app` 挂到**已存在**的 `web` 网络；`web` 声明为 `external: true`，并**显式写 `name: web`**。改动就这两处：

```yaml
# daybook 的 compose.yml（/opt/daybook）
services:
  app:
    networks:
      - default      # 与 db 私网互通（db 不写 networks，默认就只在 default 上）
      - web          # 再把 app 挂到反代所在的共享网络

networks:
  web:
    external: true   # 这个网络已存在：别去创建，更别去删除它
    name: web        # 明确真实网络名就叫 web
```

- `external: true` 是关键：compose 知道 `web` **不归本项目所有**，`up` 时不会去建它、`down` 时也**不会试图删它**。
- **不要**在这里写 `web` 的 `driver` / `ipam` / `subnet`——那是网络所有者的事（见下面「三条规矩」）。

### 拓扑二：和反代写在同一个 compose 文件里（也行）

反代（nginx / caddy）和 daybook 写在**同一份 compose.yml**、共用同一份 `networks:`。这时 `web` **由这份文件创建并拥有**（带子网）：

```yaml
services:
  app:   { ... }        # daybook 应用
  db:    { ... }        # 数据库
  caddy:                # 反代
    image: caddy:2
    ports: ["80:80", "443:443"]
    networks: [web]

networks:
  web:                  # 由这份文件创建、也由它负责
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.2.0/24
```

同一个项目内，反代可以直接用服务名反代：caddy 写 `reverse_proxy app:8090`、nginx 写 `proxy_pass http://app:8090;`。**这种写法可行，但代价是这份文件从此"拥有"了 `web`**：它一旦改错 `networks:`、或对整栈 `down`，都会波及挂在同一网络上的**其它项目**——下一节的报错就是这么来的。

### 三条规矩（贴墙上）

1. **谁创建谁定义 subnet**：`web` 的子网只写在**网络所有者**那一份文件里（`driver: bridge` + `ipam.config.subnet`）。其它任何项目都不要重复声明子网。
2. **其他人一律 `external: true`**：daybook（以及 vaultwarden / 其它栈）只写 `external: true` + `name: web`，**绝不**在自己文件里定义 `web` 的 `ipam` / `subnet`。
3. **不要把新服务加进"网络所有者"那个项目**：要加新业务就**新建一个自己的 compose 项目**、用 `external: true` 挂上 `web`；**不要**把服务塞进拥有网络的那份文件（`/opt/web` 之类）——那会让所有业务共用一份编排、一次手滑全体遭殃。

### 常见误写：两个网络 key 写了同一个 name

在**同一份** `networks:` 里给两个 key 写**同一个 `name`**（下面 `db` 的 `name` 也叫 `web`）：

```yaml
networks:
  web:
    name: web                 # ← 网络 key `web`
    ipam:
      config:
        - subnet: 172.20.2.0/24
  db:
    name: web                 # ← 问题行：另一个 key `db` 也写成 name: web
    ipam:
      config:
        - subnet: 172.20.10.0/24   # ← 子网却和上面不一样
```

**为什么会报 `network web has active endpoints`**：compose 按 `name` 把 `web` 与 `db` 两个 key 都解析成「名叫 `web` 的**同一张**网络」，可两处的 `subnet` 定义不同 → compose 判定「定义变了、得**重建** `web`」→ 重建前要先删掉现有的 `web`（`172.20.2.0/24`）→ 可上面还挂着**别的项目**的容器 → 删不掉 → 整个 `up` 中止。报错行会显示成 `network:<出错的那个 key>`（本例即 `network:db`）——**别被这个 key 名带偏**，它说的就是那张共享的 `web`。

**修正（二选一）**：

- `db` 只给本项目用 → **删掉 `db` 的 `name:`**，让 compose 自动命名成 `<项目名>_db`，与共享的 `web` 彻底分开：

  ```yaml
  networks:
    web:
      name: web
      ipam:
        config:
          - subnet: 172.20.2.0/24
    db:                        # 不给 name：compose 自动命名 <项目名>_db
      ipam:
        config:
          - subnet: 172.20.10.0/24
  ```

- 想跨项目共用 `db` 这张网络 → 把它的 `name:` 改成 `name: db`（两个 key 各是独立的网络），并**先**确认 `db` 没被占用：`docker network inspect db`（报 `No such network` 即可放心拿它当新网络名）。

**确认改对了**：两个 key 应解析到**不同**的网络名——

```bash
docker compose config | grep -A12 '^networks:'
```

### 报错「network web has active endpoints」怎么认、怎么修

**症状**：在**创建网络的**那个项目目录里跑 `docker compose up -d`（注意：不是在 daybook 目录），报：

```
✘ network:db  error while removing network: network web has active endpoints
   (name:"vaultwarden" name:"lastdone" name:"sub-store")
```

**原因**：那份文件的 `networks:` 段被改动、或整段丢了，compose 于是认为"本项目不再声明 `web`"，就打算**删掉**它；可 `web` 上还挂着别的项目（上例的 vaultwarden / lastdone / sub-store）的容器 → 删不掉 → 整个 `up` 中止。

**先诊断**：

```bash
# 1. 看当前项目声明了哪些网络（cd 到报错的项目目录后执行）
docker compose config | grep -A6 '^networks:'

# 2. 看 web 网络的真实子网（修法里要照抄这个值）
docker network inspect web --format '{{json .IPAM.Config}}'

# 3. 看 web 网络到底是哪个项目创建的（= 网络所有者）
docker network inspect web --format '{{index .Labels "com.docker.compose.project"}}'
```

**修法**：把**网络所有者**那份文件里的 `networks:` 段补回来（带 `driver` + `ipam`，子网以第 2 条 inspect 为准）：

```yaml
# 在网络所有者的 compose.yml（例如 /opt/web）里补回：
networks:
  web:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.2.0/24     # ← 用第 2 条 inspect 出来的真实子网
```

补回后再 `docker compose up -d`，compose 就不会再试图删 `web` 了。

> ⚠️ 两条红线（跨项目共享网络时尤其致命）：
> - **绝不要**在共享网络的**任何**项目里跑 `docker compose down -v`：`-v` 会连数据卷一起删（daybook 的 `pgdata` 首当其冲），而一个项目 `down` 也可能动到别人的容器。
> - **不要**用 `docker network prune`：它会清理"没有容器在用"的网络，随时可能把共享网络或别人项目的网络一起端掉。

### nginx 在容器里时，反代目标写容器 IP

反代（nginx / caddy）如果也是 `web` 网络里的一个**容器**，就按 daybook 应用容器的地址反代到它的 8090：

```nginx
# nginx 容器内，反代到 daybook 应用容器
location / {
    proxy_pass http://172.20.2.201:8090;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization     $http_authorization;   # 千万别丢
}
```

- **跨 compose 项目**时服务名不互相解析（`app` 只在 daybook 项目内是别名），所以用**容器静态 IP**（示例 `172.20.2.201:8090`）。
- 想把它钉死，就在 daybook 里给 `app` 指定 `web` 网段内的一个地址（落在子网内、且未被占用）：

```yaml
services:
  app:
    networks:
      default: {}
      web:
        ipv4_address: 172.20.2.201
```

- 容器反代**不需要**把 8090 发布到宿主机；只有反代跑在**宿主机**上（第 5 节那套）时才用 `127.0.0.1:8090:8090`。

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

### 容器重启循环：迁移失败：Invalid URL

**含义**：`DATABASE_URL` 已存在但无法被解析成 URL。（若该变量**缺失**，报的会是「缺少必需的环境变量 DATABASE_URL」，可据此区分。）

一行自检（只输出 host，不泄露口令）：

```bash
docker compose run --rm daybook sh -c 'node -e "const u=process.env.DATABASE_URL||\"\";try{const p=new URL(u);console.log(\"OK host=\"+p.host)}catch(e){console.log(\"BAD: \"+e.message)}"'
```

> 命令里的 `daybook` 是 app 服务名的占位符——**换成你自己的服务名**。本仓库 `compose.yml` 里的 app 服务名叫 `app`，请写成 `docker compose run --rm app ...`。

三个最常见原因：

1. **口令含 URL 特殊字符**（`/` `@` `:` `#` `?`，base64 口令里尤为常见）→ 改用 `openssl rand -hex 32` 重新生成。
2. **值被写成带引号**（compose 的 `environment` 列表写法里，引号会算进值本身）→ 去掉引号。
3. **`@` 后面主机名为空或不是 db 服务名** → 用 `@db:5432`（服务名要与 compose 里一致）。

> 提醒：`POSTGRES_PASSWORD` 与 `DATABASE_URL` 里的口令必须**一致**，否则报的是**认证失败**而不是解析失败；且 Postgres **只在首次初始化**时读取该口令，改了环境变量后若数据卷已存在则不生效（空库可 `docker compose down -v` 重来；⚠️ 有数据时**不要**用 `-v`）。

---

## 附：装上 Android APK（侧载）

1. 打开仓库的 **Releases** 页，下载最新的 `daybook-<版本>-android-<release|debug>.apk`（可用旁边的 `.sha256` 核对）。
2. 手机设置里允许这个来源安装应用（「未知来源」/「安装未知应用」）。
3. 打开 APK 安装 → 启动 → 用账号口令登录。
4. **服务器地址不写死了**：APK **默认不绑任何域名**，首次启动会要求填服务器地址（必须 `https://`；WebView 的源是 `https://localhost`，所以只认绝对地址，见 `androidScheme: https`）。自建者如果想给自己发的包预设默认地址，可选地在仓库变量里设 `DAYBOOK_SERVER_URL`（见 operations.md 的「配一次」）；不设也行 —— 用户首次启动自己填，填一次会记住。

> 提醒现状：APK 在本机**排本地提醒**（非精确闹钟、不用 Google 服务 / FCM；重启手机后需打开一次应用重新登记）；浏览器里把 PWA 加到主屏仍走 Web Push。

---

> 运维（备份 / 升级 / 排障 / 卸载）见 [operations.md](operations.md)。
