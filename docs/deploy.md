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
#   在开发机执行：rsync -av --exclude node_modules --exclude web/dist --exclude .env \
#     "/mnt/f/Ai Code/personal-projects/daybook/" user@vps:/opt/daybook/
```

---

## 2. 配置 .env

```bash
cp .env.example .env
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

## 7. 备份（务必配）

```bash
cd /opt/daybook
bash scripts/backup.sh                       # 立刻试一次，确认备份产物有内容
BACKUP_DIR=/mnt/backup/daybook KEEP_DAYS=30 bash scripts/backup.sh
```

放进 crontab：

```cron
30 4 * * * cd /opt/daybook && bash scripts/backup.sh >> /var/log/daybook-backup.log 2>&1
```

推到异地（可选）：

```cron
45 4 * * * cd /opt/daybook && RSYNC_TARGET=user@nas:/volume1/backup/daybook bash scripts/backup.sh >> /var/log/daybook-backup.log 2>&1
```

恢复步骤写在脚本头部注释里（`pg_restore` 前先 `docker compose stop app`）。

> 备份**不含** `.env`：`JWT_SECRET` 丢了 = 所有人重新登录；VAPID 私钥丢了 = 所有设备重新订阅。请单独安全保存。

---

## 8. 升级

```bash
cd /opt/daybook
git pull                                   # 或 rsync 覆盖代码（别覆盖 .env）
docker compose build
docker compose up -d                       # 迁移自动跑，失败会拒绝启动
curl -s http://127.0.0.1:8090/healthz
docker compose logs app --tail 50
```

回滚：`git checkout <上一个 tag> && docker compose build && docker compose up -d`（数据库迁移是**只加不改**的风格，回滚一般安全；涉及删列的迁移要谨慎）。

> **发版后第一次打开可能还是旧版**：前端的 Service Worker 是「缓存优先 + 后台更新」，所以旧页面会先用缓存渲染、同时在后台拉新版本，**再打开一次**就是新版（静态资源按内容哈希命名，不会新旧混用）。急着看新版就硬刷新（Ctrl/Cmd+Shift+R）或用无痕窗口。
> 这一点在验证阶段真实踩到过：无头浏览器复验某个前端修复时，第一次跑拿到的是 SW 缓存里的旧包。

---

## 9. 排障清单

**容器起不来**

```bash
docker compose ps
docker compose logs app --tail 100
docker compose logs db  --tail 100
```
- `ConfigError: JWT_SECRET 太短` → `.env` 里换成长随机串。
- `MigrationChecksumError` → 迁移文件被改过而库里已记录不同校验和；**不要**手改已应用的迁移，加新文件。
- 数据库健康检查不过 → 看 `db` 日志；`POSTGRES_PASSWORD` 改过但数据卷还是旧口令时，要么改回原口令、要么清卷重来。

**打不开页面 / 白屏**
- `curl -sI http://127.0.0.1:8090/` 应返回 200 HTML；404 说明镜像里没有前端产物（构建阶段失败）。
- 浏览器控制台报 `MIME type ... text/html`：说明请求的 `/assets/xxx.js` 不存在（旧页面缓存了已删除的资源）→ 让用户硬刷新（Ctrl+Shift+R）；应用本身已对这种情况返回 404 而不是 HTML。
- 404 之外还可能是反代没把 `/v1/*` 转发过去（检查 `location` 是否覆盖全部路径）。

**登录提示"尝试次数太多"**：限流是"每用户名 5 次 / 每 IP 30 次，15 分钟窗口"。等 15 分钟，或重启 app 容器（内存计数会清空）。确认反代带上了 `X-Forwarded-For`。

**收不到提醒**（按顺序查）

```bash
# 1) VAPID 配了吗
docker compose logs app | grep -i vapid          # 不应出现"未配置 VAPID 密钥"
# 2) 这台设备订阅上了吗、最近发过没
curl -s -H "authorization: Bearer <access token>" https://diary.example.com/v1/notifications/status
#   看 subscriptions 数量、recent_deliveries 里 status/attempts/last_error
# 3) 调度器在跑吗
docker compose logs app | grep "提醒 tick 完成"
```
- `recent_deliveries` 里 `failed` + `HTTP 410` → 订阅已失效（多半是浏览器清了数据或换了设备）→ 在设置页重新开启提醒。
- 一直 `没有可用的推送订阅` → 设备侧没订阅成功：iOS 必须是**主屏图标**打开的 PWA；浏览器必须是 HTTPS。
- `skipped` → 你当时已经写完了（"仅未完成时提醒"开着）。
- 都正常但仍收不到 → 手机系统层：通知权限、省电/后台限制、专注模式。

**忘记口令**：`reset-password` +（可选）`disable`/`enable` 强制所有设备重新登录。

---

## 10. 安全清单（部署后自查）

- [ ] `https://` 能开、`http://` 会跳转；证书自动续期已启用（`systemctl list-timers | grep certbot`）。
- [ ] 8090 **只**绑在 `127.0.0.1`（`ss -ltnp | grep 8090` 应显示 127.0.0.1），公网直接访问 `IP:8090` 不通。
- [ ] 5432 没有对外映射（compose 里 db 没有 `ports`）。
- [ ] `.env` 权限 600，且不在任何仓库/备份快照里被提交（`.gitignore` 已排除）。
- [ ] 备份任务真的在跑（看 `/var/log/daybook-backup.log` 与备份目录大小）。
- [ ] `docker compose logs app | grep -c '"error"'` 平时应接近 0。
- [ ] 系统与基础镜像定期更新：`docker compose build --pull`。

---

## 11. 卸载 / 迁移

```bash
# 停掉但保留数据
docker compose down

# 连数据一起删（不可恢复，先备份！）
docker compose down -v

# 迁移到新机器：老机器上 docker compose down → 打包 /opt/daybook（含 .env）与数据卷目录，
# 或在新机器上先 up 起空库，再用备份文件 pg_restore。
```
