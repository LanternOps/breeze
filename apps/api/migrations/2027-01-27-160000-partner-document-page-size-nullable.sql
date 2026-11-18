-- #12097: partners.document_page_size becomes nullable with no default.
--
-- NULL now means "the partner never chose a page size": its documents print on
-- its region default (Letter for the US and Canada, A4 everywhere else; from
-- the billing letterhead country, then the company-details country, then the
-- deployment — see packages/shared/src/documents/pageSize.ts). Until now the
-- column defaulted to 'letter', so every partner created since 2026-08-14 got
-- Letter whatever its region.
--
-- No backfill. Every existing row already carries a value, and a value written
-- by the column default cannot be told apart from one a partner saved (the
-- Billing -> Documents form has always submitted the field on every save), so
-- existing rows keep their value as an explicit choice. Only partners created
-- after this migration start at NULL.
--
-- Schema only: no rows are written, so no system scope is needed. Both
-- statements are no-ops when re-applied.

ALTER TABLE partners ALTER COLUMN document_page_size DROP DEFAULT;
ALTER TABLE partners ALTER COLUMN document_page_size DROP NOT NULL;
