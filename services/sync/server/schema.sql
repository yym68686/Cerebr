CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','banned')),
 created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS devices (
 user_id uuid NOT NULL REFERENCES users(id), id uuid NOT NULL, name text NOT NULL,
 platform text NOT NULL, origin text NOT NULL DEFAULT '', app_version text NOT NULL DEFAULT '',
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 chats integer NOT NULL DEFAULT 0, messages integer NOT NULL DEFAULT 0,
 bytes_in bigint NOT NULL DEFAULT 0, bytes_out bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS records (
 user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, body json NOT NULL,
 clock bigint NOT NULL, actor text NOT NULL, deleted boolean NOT NULL,
 byte_size integer NOT NULL, chats integer NOT NULL, messages integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS conversation_shares (
 id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{48}$'),
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_chat_id text NOT NULL, snapshot json NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id, source_chat_id)
);
CREATE TABLE IF NOT EXISTS revisions (
 user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, clock bigint NOT NULL,
 actor text NOT NULL, body json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,key,clock,actor)
);
CREATE TABLE IF NOT EXISTS traffic (
 user_id uuid NOT NULL REFERENCES users(id), device_id uuid NOT NULL,
 hour timestamptz NOT NULL, bytes_in bigint NOT NULL DEFAULT 0, bytes_out bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,device_id,hour)
);
CREATE TABLE IF NOT EXISTS audit_log (
 id bigserial PRIMARY KEY, admin_id uuid NOT NULL REFERENCES users(id),
 user_id uuid REFERENCES users(id) ON DELETE SET NULL, username text, action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS username text;
UPDATE audit_log a SET username=u.username FROM users u WHERE a.user_id=u.id AND a.username IS NULL;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='audit_log'::regclass AND conname='audit_log_user_id_fkey' AND confdeltype<>'n') THEN
  ALTER TABLE audit_log ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE audit_log DROP CONSTRAINT audit_log_user_id_fkey;
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS audit_log_user_id ON audit_log(user_id);
CREATE TABLE IF NOT EXISTS sync_events (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 message json NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_events_created ON sync_events(created_at);
