-- 应用级设置（键值对）：目前用于存放服务端**自动生成**的 VAPID 密钥。
-- 这样部署 Web Push 时不必在 .env 里手配密钥：首次启动生成并存入这里，
-- 之后每次启动都从这里读回（.env 里显式配了 VAPID_* 时仍以环境变量优先）。
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,                     -- 目前是 JSON：{"publicKey":"…","privateKey":"…"}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 静默时段（quiet hours）：落在窗口内的提醒推迟到窗口结束；窗口可跨午夜。
-- 时间用本地墙上时间 HH:MM（time 类型，与 morning_reminder_time 一致的存法）；
-- 未开启时两列为 NULL（开启时必须都填且 start != end，由接口层校验）。
ALTER TABLE user_settings ADD COLUMN quiet_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN quiet_start time;
ALTER TABLE user_settings ADD COLUMN quiet_end time;
