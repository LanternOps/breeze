-- Partner document presentation: theme + page size (Spec A §1).
-- NULL-guarded sequence so re-application can never flip a partner's choice:
-- add nullable/no-default -> fill NULLs -> set default -> NOT NULL.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS document_theme varchar(32);
UPDATE partners SET document_theme = 'classic' WHERE document_theme IS NULL;
ALTER TABLE partners ALTER COLUMN document_theme SET DEFAULT 'classic';
ALTER TABLE partners ALTER COLUMN document_theme SET NOT NULL;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS document_page_size varchar(8);
-- Existing partners keep A4 (today's output); new partners default to Letter.
UPDATE partners SET document_page_size = 'a4' WHERE document_page_size IS NULL;
ALTER TABLE partners ALTER COLUMN document_page_size SET DEFAULT 'letter';
ALTER TABLE partners ALTER COLUMN document_page_size SET NOT NULL;

-- Frozen presentation at send time ({ theme, pageSize }); NULL until sent.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS presentation_snapshot jsonb;
