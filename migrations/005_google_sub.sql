-- Google OAuth: external OIDC subject linked at first Google sign-in. Idempotent; multiple NULLs allowed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub);
