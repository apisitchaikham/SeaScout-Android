-- Sea Scout · migration 0004 · sign in with Google / Facebook through the browser (Android, iOS, web — no app plugin).
-- oauth_states: one row per started sign-in (10 minutes, used once). auth_handoffs: one-time code the app swaps for tokens (3 minutes).
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL CHECK (provider IN ('google','facebook')),
  platform    TEXT NOT NULL,
  device      TEXT,
  locale      TEXT,
  verifier    TEXT,
  nonce       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_exp ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS auth_handoffs (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,
  provider    TEXT NOT NULL,
  created     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_handoffs_exp ON auth_handoffs(expires_at);
