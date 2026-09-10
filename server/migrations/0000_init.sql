-- daybook 初始结构（对应 docs/development-plan.md 附录 A）
-- 迁移由 server/src/db/migrator.ts 执行；历史迁移一旦应用过就不要再改，需要调整请新增文件。

-- 用户：注册关闭，账号由管理员侧 CLI 添加（用户名小写、无邮箱）
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  username      text NOT NULL UNIQUE
                CHECK (username = lower(username) AND username ~ '^[a-z0-9_-]{3,32}$'),
  password_hash text NOT NULL,                   -- scrypt$N$r$p$salt$hash
  status        text NOT NULL DEFAULT 'active',  -- active | disabled | pending_deletion
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE user_settings (
  user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone                  text NOT NULL DEFAULT 'Asia/Shanghai',   -- IANA
  day_start_hour            smallint NOT NULL DEFAULT 4 CHECK (day_start_hour BETWEEN 0 AND 6),
  morning_reminder_enabled  boolean NOT NULL DEFAULT true,
  morning_reminder_time     time NOT NULL DEFAULT '09:00',
  evening_reminder_enabled  boolean NOT NULL DEFAULT true,
  evening_reminder_time     time NOT NULL DEFAULT '21:00',
  notify_only_if_incomplete boolean NOT NULL DEFAULT true,
  theme                     text NOT NULL DEFAULT 'system',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- 每日记录：一条记录描述"这一天自己"（昨日回顾只是填写入口）
CREATE TABLE daily_entries (
  id                         uuid PRIMARY KEY,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date                 date NOT NULL,
  day_events                 text,
  day_meals                  text,
  day_plan                   text,
  evening_summary            text,
  day_events_updated_at      timestamptz,
  day_meals_updated_at       timestamptz,
  day_plan_updated_at        timestamptz,
  evening_summary_updated_at timestamptz,
  version                    integer NOT NULL DEFAULT 1,
  reviewed_at                timestamptz,
  summarized_at              timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date)
);

CREATE TABLE incidents (
  id          uuid PRIMARY KEY,                 -- 客户端生成
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date  date NOT NULL,                    -- 服务端按 occurred_at + 时区 + 日界计算
  occurred_at timestamptz NOT NULL,
  content     text NOT NULL CHECK (char_length(content) <= 2000),
  tag         text CHECK (tag IN ('work','life','emotion','idea','other')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_user_date_idx ON incidents (user_id, entry_date, occurred_at);

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  last_success_at timestamptz,
  failure_count   integer NOT NULL DEFAULT 0,
  disabled_at     timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE disabled_at IS NULL;

CREATE TABLE reminder_schedule (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('morning','evening')),
  next_fire_at timestamptz,                     -- NULL = 关闭
  locked_at    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX reminder_schedule_due_idx ON reminder_schedule (next_fire_at) WHERE next_fire_at IS NOT NULL;

CREATE TABLE notification_deliveries (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,                     -- 日记日
  kind       text NOT NULL CHECK (kind IN ('morning','evening')),
  status     text NOT NULL,                     -- pending | sent | failed | skipped
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date, kind)             -- 幂等键
);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,             -- SHA-256(token)
  expires_at   timestamptz NOT NULL,
  rotated_from uuid,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
