#!/usr/bin/env bash
# daybook 数据库备份：pg_dump（自定义格式，自带压缩）→ 本地目录 → 可选 rsync 到异地。
#
# 用法（在仓库根目录执行；脚本自己会 cd 到仓库根）：
#   bash deploy/backup.sh                    # 备份到 ./backups，保留 14 天
#   BACKUP_DIR=/mnt/backup/daybook bash deploy/backup.sh
#   KEEP_DAYS=30 RSYNC_TARGET=user@host:/path/ bash deploy/backup.sh
#
# 放进 crontab（每天 04:30，避开提醒高峰；日记日 04:00 切换）：
#   30 4 * * * cd /opt/daybook && bash deploy/backup.sh >> /var/log/daybook-backup.log 2>&1
#
# 恢复（⚠️ 会覆盖现有数据，先停应用容器）：
#   docker compose stop app
#   docker compose exec -T db dropdb -U daybook --if-exists daybook
#   docker compose exec -T db createdb -U daybook daybook
#   docker compose exec -T db pg_restore -U daybook -d daybook --no-owner < backups/daybook-YYYYmmdd-HHMMSS.dump
#   docker compose start app
#
# 注意：备份里**不含** .env（JWT_SECRET / VAPID 私钥）。口令与密钥请另行安全保管，
# 否则恢复后所有人需要重新登录、已订阅的设备也要重新订阅。
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-daybook}"
DB_NAME="${DB_NAME:-daybook}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/daybook-$STAMP.dump"

echo "[$(date -Is)] 开始备份 → $FILE"
# -T: 不要分配 TTY（cron 里必须）; -Fc: 自定义格式，pg_restore 可选择性恢复
docker compose exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$FILE"

# 简单校验：pg_dump 自定义格式的魔数，且文件不能是 0 字节
SIZE="$(wc -c < "$FILE" | tr -d ' ')"
if [ "$SIZE" -lt 1024 ] || [ "$(head -c 5 "$FILE")" != "PGDMP" ]; then
  echo "[$(date -Is)] 备份校验失败（大小 ${SIZE}B）：$FILE" >&2
  exit 1
fi
echo "[$(date -Is)] 备份完成（${SIZE} 字节）"

# 保留策略
DELETED="$(find "$BACKUP_DIR" -name 'daybook-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')"
echo "[$(date -Is)] 清理了 $DELETED 个超过 $KEEP_DAYS 天的旧备份"

# 可选：推到异地（rsync 走 SSH；密钥/known_hosts 自己配好）
if [ -n "${RSYNC_TARGET:-}" ]; then
  echo "[$(date -Is)] rsync → $RSYNC_TARGET"
  rsync -az --partial "$FILE" "$RSYNC_TARGET"
  echo "[$(date -Is)] 异地同步完成"
fi
