-- 多设备可辨识：每条推送订阅加"设备名"与"平台"标签，便于在设置页认出每台设备并单独开关。
-- 启停复用既有的 disabled_at 列（NULL = 启用），因此这里不新增 enabled 列。
-- 历史迁移（0000–0002）已应用过、内容不可改，本文件是新增。
ALTER TABLE push_subscriptions ADD COLUMN label text;
ALTER TABLE push_subscriptions ADD COLUMN platform text;
