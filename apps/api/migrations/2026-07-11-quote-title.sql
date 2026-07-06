-- Quotes get a tech-editable title ("Office Network Refresh") shown in the
-- editor, the customer document, and the PDF. Nullable: existing quotes and
-- quotes created without a title fall back to the quote number for display.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS title varchar(200);
