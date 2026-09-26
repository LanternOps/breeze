-- #4910: stamp elevation_audit.created_at with the time of the INSERT, not
-- the inserting transaction's start. The ledger export pages on
-- (created_at, id) behind a watermark; with now() (transaction start) a
-- transaction that began long ago could insert a row whose created_at is
-- already behind a cursor. clock_timestamp() makes a later insert always sort
-- later. Default change only: existing rows keep their values, no rewrite.
ALTER TABLE elevation_audit ALTER COLUMN created_at SET DEFAULT clock_timestamp();
