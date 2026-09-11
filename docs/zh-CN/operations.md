# 运维手册（备份 / 升级 / 排障 / 卸载）

> 部署步骤见 [deployment.md](deployment.md)。

---

## 9. 备份（务必配）

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

## 10. 升级

用预构建镜像（推荐，见部署手册第 9 节）：

```bash
cd /opt/daybook
git pull                                   # 更新 compose.yml 等编排（别覆盖 .env）
docker pull ghcr.io/getl-x/daybook:<新版本>
DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:<新版本> docker compose up -d --no-build   # 用预构建镜像，不在本机重建
curl -s http://127.0.0.1:8090/healthz
docker compose logs app --tail 50          # 迁移自动跑，失败会拒绝启动
```

> `--no-build` 不能省：`compose.yml` 里有 `build: .`，不加这个参数会尝试在本机重新构建。
> 要从本地源码构建时才用：`docker compose build && docker compose up -d`。

回滚：把 `DAYBOOK_IMAGE` 改回上一个版本再 `docker compose up -d --no-build` 即可（只换 app 容器，数据库卷 `pgdata` 保留；迁移是**只加不改**的风格，回滚一般安全，涉及删列的迁移要谨慎）。用本地构建的则 `git checkout <上一个 tag> && docker compose build && docker compose up -d`。

> **发版后第一次打开可能还是旧版**：前端的 Service Worker 是「缓存优先 + 后台更新」，所以旧页面会先用缓存渲染、同时在后台拉新版本，**再打开一次**就是新版（静态资源按内容哈希命名，不会新旧混用）。急着看新版就硬刷新（Ctrl/Cmd+Shift+R）或用无痕窗口。
> 这一点在验证阶段真实踩到过：无头浏览器复验某个前端修复时，第一次跑拿到的是 SW 缓存里的旧包。

---

## 11. 发一个新版

打一个 `v*` 标签推上去，两个发布流程会同时开始：

```bash
git tag v0.1.1
git push origin v0.1.1
```

随后：

- `docker-publish.yml`：先构建镜像、用 compose + 真 Postgres 跑冒烟，通过后推 `ghcr.io/getl-x/daybook:v0.1.1`（带 semver 与 sha 标签，并更新 `latest`）。
- `android-release.yml`：构建前端 → `cap sync` → 打包 APK → 建 / 更新 GitHub Release，把 `daybook-0.1.1-android-<release|debug>.apk` 与 `.sha256` 附上去，同时上传 artifact。

在 **Actions** 页面看进度（点进对应的 run）；失败了点右上角 **Re-run jobs** 重跑，重跑前先修好对应的问题 —— 例如 `android-release` 缺签名 secret 时会打 `::warning::` 并退化成 debug 包（缺 `DAYBOOK_SERVER_URL` 不再是问题：APK 首次启动会要求填服务器地址）。

---

## 12. 配一次：GitHub 上的 secrets 与变量

仓库 **Settings → Secrets and variables → Actions** 里配这些东西（本机装了 `gh` 也可以直接命令行设）：

**变量（Variables）** —— 后端地址**默认不绑**：APK 首次启动会让用户自己填。这个变量是**可选**的，只有在你想给自己发一个“预填好地址”的包时才需要设（例如你自建服务、想省掉家人每次手填）：

```bash
gh variable set DAYBOOK_SERVER_URL --body 'https://你的域名'     # 可选；不设也行
```

**Secrets** —— 可选。配了就出正式签名包，没配自动退化成 debug 签名包。用你现有的 `.jks`：

```bash
keytool -list -v -keystore 你的.jks        # 输出里的 "Alias name" / "别名" 就是 ANDROID_KEY_ALIAS（顺便确认口令对）
base64 -w0 你的.jks > keystore.b64
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
rm keystore.b64                            # 别把 base64 文件留在本地
```

- `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` 这三个 secret 与 lastdone 仓库同名，可直接用同一套值。
- 四个 secret 缺任意一个，`android-release.yml` 就退化成 **debug 签名包**：能装能测，但密钥是公开的调试密钥，**不能当正式版升级**（换正式包要卸载重装）。
- 仓库里只有 `source/web/android/keystore.properties.example`；真实的 `.jks` 与 `keystore.properties` 都不进仓库（`.gitignore` 已排除）。

**变量 + secret（推 Docker Hub 用）** —— 让 `docker-publish.yml` 把镜像**同时**推到 [Docker Hub](https://hub.docker.com/) 的 `docker.io/getl/daybook`（与 `ghcr.io/getl-x/daybook` 同一次构建、同名标签：`0.1.1` / `0.1` / `latest` / `sha-xxxxx`）。两处字段都在同一个 **Settings → Secrets and variables → Actions** 页面里，和上面 Android 签名那些并列：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| **变量**（Variables） | `DOCKERHUB_USERNAME` | `getl`（你的 Docker Hub 用户名；已设好） |
| **secret**（Secrets） | `DOCKERHUB_TOKEN` | Docker Hub 的 Personal access token（**你自己生成**，见下） |

生成 token：打开 https://hub.docker.com/settings/security → **New Access Token** → Description 随意（例：`daybook-ci-github-actions`）→ Access permissions 选 **Read & Write** → 生成后**只显示一次**，立即复制。（也可以复用 lastdone 那个 token，如果当时存下来了。）

命令行等价写法（回车后粘贴 token）：

```bash
gh variable set DOCKERHUB_USERNAME --body getl -R getl-x/daybook
gh secret set DOCKERHUB_TOKEN -R getl-x/daybook
```

- `docker.io/getl/daybook` 这个仓库**不用手动建**：首次 push 会自动创建（**默认 public**，和 `getl/lastdone` 一样）。
- 想 private：先在 Hub 上手动建一个 private 仓库（免费账号只能 1 个 private），那样 VPS 上要先 `docker login` 才能拉。
- 两个字段**缺任一**，发布流程**不会挂**：只推 GHCR，并在 job summary 里标注一行说明。
- 验证：`docker manifest inspect docker.io/getl/daybook:0.1.1`（public 包可匿名），或 `docker pull getl/daybook:0.1.1`。Docker Hub 对匿名拉取有频率限制（个人使用足够）；两个仓库内容完全一致。

---

## 一个 jks 供多个 App 复用

同一个 keystore 文件 + 同一套 4 个 secret 名，可以给后续所有 App 复用，不用每次重新生成：

- **secret 名不变**：`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` —— 新仓库照抄这 4 个名字即可（值也照旧）。
- **`applicationId` 必须各异**：同一台手机上两个 App 的包名不能一样，否则装第二个会覆盖第一个。改 `source/web/capacitor.config.ts` 的 `appId`（以及 Android 工程里的 `applicationId`）。
- **更规范的做法**：用**同一个 keystore 里的不同 alias** 给不同 App 签名，一个项目一个别名，互不干扰：

  ```bash
  keytool -genkeypair -alias 应用名 -keystore 同一个.jks
  ```

- **务必备份** `.jks` + alias + 口令（三个一起稳妥存好）：**丢了就再也发不出能覆盖升级的包** —— 用户只能卸载重装（侧载的后果是卸载重装、重新登录）。注意数据在**服务器**上，不会因为重装而丢，重新登录后照常看到。
- 忘了 alias 叫什么、或不确定口令对不对，随时可以查：

  ```bash
  keytool -list -v -keystore 你的.jks        # 输出里的 "Alias name" / "别名" 就是 alias
  ```

---

## 13. 排障清单

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

## 14. 安全清单（部署后自查）

- [ ] `https://` 能开、`http://` 会跳转；证书自动续期已启用（`systemctl list-timers | grep certbot`）。
- [ ] 8090 **只**绑在 `127.0.0.1`（`ss -ltnp | grep 8090` 应显示 127.0.0.1），公网直接访问 `IP:8090` 不通。
- [ ] 5432 没有对外映射（compose 里 db 没有 `ports`）。
- [ ] `.env` 权限 600，且不在任何仓库/备份快照里被提交（`.gitignore` 已排除）。
- [ ] 备份任务真的在跑（看 `/var/log/daybook-backup.log` 与备份目录大小）。
- [ ] `docker compose logs app | grep -c '"error"'` 平时应接近 0。
- [ ] 系统与基础镜像定期更新：应用镜像走 `docker compose pull`；从源码构建时才 `docker compose build --pull`。

---

## 15. 卸载 / 迁移

```bash
# 停掉但保留数据
docker compose down

# 连数据一起删（不可恢复，先备份！）
docker compose down -v

# 迁移到新机器：老机器上 docker compose down → 打包 /opt/daybook（含 .env）与数据卷目录，
# 或在新机器上先 up 起空库，再用备份文件 pg_restore。
```
