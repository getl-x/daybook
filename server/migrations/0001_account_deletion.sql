-- 账号删除：记录"申请删除"的时间，宽限期（7 天）过后由后台任务真正清除。
-- 见 docs/development-plan.md §10 与验收标准第 10 条。
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;

-- 待删除账号的清理任务每分钟扫一次，加个部分索引
CREATE INDEX users_pending_deletion_idx ON users (deletion_requested_at)
  WHERE status = 'pending_deletion';
