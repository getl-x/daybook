#!/usr/bin/env bash
# daybook 备份：现在由应用内置（见 docs/zh-CN/operations.md §9）。
#
# 这个脚本保留成一层薄包装，因为部署机的 crontab 里很可能已经写着它。它现在把活
# 交给 `docker compose exec app daybook backup`，也就是 BackupManager.CreateManual：
# 走 PocketBase 自己的 CreateBackup，拿到的是 SQLite 的一致快照，不必停容器、也
# 不必猜哪些文件要拷。
#
# 用法（在仓库根目录执行；脚本自己会 cd 到仓库根）：
#   bash deploy/backup.sh                                # 打一份手工备份并回文件名
#   RSYNC_TARGET=user@host:/path/ bash deploy/backup.sh   # 顺便拷到宿主再推到异地
#
# 放进 crontab（只为顺带推异地；日备份本来就是自动的）：
#   30 4 * * * cd /opt/daybook && bash deploy/backup.sh >> /var/log/daybook-backup.log 2>&1
#
# 几点说明：
#   - 日备份（每天 03:00 UTC，保留 7 份）与升级前备份（保留 3 份）都由应用自己完成，
#     不需要这个脚本；它们落在数据卷的 pb_data/backups/ 里，和数据库是同一个卷。
#   - 所以"搬到异地"仍然要你自己做。本脚本的 RSYNC_TARGET 只搬最新那一份；整个卷的
#     快照（连库带全部备份）见手册 §9。
#   - 恢复：去 /_/ 的 Settings → Backups 点 restore，或者停容器后用快照覆盖 pb_data。
#
# 历史包袱提醒：这个脚本以前是 Postgres 版（docker compose exec db pg_dump），而 Go
# 版早就没有 db 服务了，所以它从重写那天起就一直在失败。现在换成调用内置备份。
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"

echo "[$(date -Is)] 让应用自己打一份手工备份…"
# -T：不分配 TTY（cron 里必须）；2>/dev/null 丢掉应用日志，只留文件名。
# 末尾的 || true 是为了让"容器没起来"走到下面那句人话，而不是被 set -e 直接掐掉。
NAME="$(docker compose exec -T app daybook backup 2>/dev/null | tail -1 || true)"

case "$NAME" in
  manual_daybook_*.zip) ;;
  *)
    echo "[$(date -Is)] 没拿到备份文件名——容器没起来？先 docker compose up -d 再重试。" >&2
    exit 1
    ;;
esac
echo "[$(date -Is)] 备份完成：$NAME（在数据卷的 pb_data/backups/ 里）"

# 可选：拷到宿主再推到异地。用 compose cp 从运行中的容器里取，不用管卷挂在哪。
if [ -n "${RSYNC_TARGET:-}" ]; then
  mkdir -p "$BACKUP_DIR"
  docker compose cp "app:/app/pb_data/backups/$NAME" "$BACKUP_DIR/$NAME"
  echo "[$(date -Is)] rsync → $RSYNC_TARGET"
  rsync -az --partial "$BACKUP_DIR/$NAME" "$RSYNC_TARGET"
  echo "[$(date -Is)] 异地同步完成"
fi
