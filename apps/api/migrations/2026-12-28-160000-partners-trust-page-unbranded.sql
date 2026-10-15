-- Trust Center (spec docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md §9, §18.3):
-- operator-granted footer removal for public trust pages. A dedicated column, not
-- settings JSONB, because settings is partner-writable and the partner must not
-- self-enable (same reasoning as ai_for_office_enabled). partners already has
-- partner-axis RLS; a non-key column inherits the row policies. DDL only.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_page_unbranded boolean NOT NULL DEFAULT false;
