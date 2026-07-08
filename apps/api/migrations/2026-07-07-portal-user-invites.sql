-- Portal customer-onboarding: invite provenance columns on portal_users.
-- Idempotent. portal_users already has org-scoped RLS (shape 1, direct org_id);
-- new nullable columns need no new policy. Timestamps are WITHOUT time zone to
-- match the existing last_login_at/created_at columns (drizzle drift).
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id);
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS invited_at timestamp;
