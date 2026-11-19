-- Sea Scout · migration 0003 · allow Facebook as a sign-in provider + login screen flags.
-- SQLite cannot change a CHECK constraint in place, so identities is rebuilt (data copied as-is).

CREATE TABLE identities_new (
  provider    TEXT NOT NULL CHECK (provider IN ('google','apple','facebook')),
  subject     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
INSERT INTO identities_new (provider, subject, user_id, email, created_at) SELECT provider, subject, user_id, email, created_at FROM identities;
DROP TABLE identities;
ALTER TABLE identities_new RENAME TO identities;
CREATE INDEX identities_user ON identities(user_id);

INSERT INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES
  ('login_screen',   1, 'Show the sign-in screen after the app loads (Google / Facebook / Apple / email / skip)', 0, 'migration'),
  ('login_required', 0, 'Hide "skip" on the sign-in screen (never blocks the app when offline)', 0, 'migration');
