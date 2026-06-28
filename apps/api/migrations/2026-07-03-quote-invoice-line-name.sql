-- Quote & invoice lines gain a separate `name` (title) alongside `description`,
-- mirroring the catalog item's name + description. The line snapshots both from
-- the catalog item at add-time (a later catalog edit must never rewrite an
-- already-sent quote / issued invoice).
--
-- Backward compatibility: existing rows keep their `description` (which today
-- holds the title) and a NULL `name`. The renderers treat `name ?? description`
-- as the title and show `description` as a sub-line only when `name` is set, so
-- legacy lines look identical. `description` is relaxed to NULL-able because a
-- catalog item may have a name but no description.

ALTER TABLE quote_lines   ADD COLUMN IF NOT EXISTS name varchar(255);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS name varchar(255);

-- DROP NOT NULL is a no-op when the column is already nullable, so re-applying is safe.
ALTER TABLE quote_lines   ALTER COLUMN description DROP NOT NULL;
ALTER TABLE invoice_lines ALTER COLUMN description DROP NOT NULL;
