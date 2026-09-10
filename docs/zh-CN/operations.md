# 运维手册（备份 / 升级 / 排障 / 卸载）

> 部署步骤见 [deployment.md](deployment.md)。

---

## 7. 备份（务必配）

```bash
cd /opt/daybook
bash deploy/backup.sh                       # 立刻试一次，确认备份产物有内容
BACKUP_DIR=/mnt/backup/daybook KEEP_DAYS=30 bash deploy/backup.sh
```

放进 crontab：

```cron
30 4 * * * cd /opt/daybook && bash deploy/backup.sh >> /var/log/daybook-backup.log 2>&1
```

推到异地（可选）：

```cron
45 4 * * * cd /opt/daybook && RSYNC_TARGET=user@nas:/volume1/backup/daybook bash deploy/backup.sh >> /var/log/daybook-backup.log 2>&1
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
