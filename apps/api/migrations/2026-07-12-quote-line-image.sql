-- Per-line product image: a tech can attach an uploaded image directly to a
-- quote line (no catalog item required). Reuses quote_images storage (already
-- quote-scoped + RLS'd); deleting the image clears the pointer.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS image_id uuid REFERENCES quote_images(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS quote_lines_image_idx ON quote_lines(image_id);
