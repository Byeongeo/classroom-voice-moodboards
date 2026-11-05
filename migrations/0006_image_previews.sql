-- Derived display images only. Original object keys, files and history remain intact.
ALTER TABLE images ADD COLUMN preview_object_key TEXT;
ALTER TABLE images ADD COLUMN preview_mime_type TEXT;
ALTER TABLE images ADD COLUMN preview_byte_size INTEGER;
ALTER TABLE images ADD COLUMN preview_status TEXT NOT NULL DEFAULT 'pending' CHECK(preview_status IN ('pending','queued','processing','ready','skipped','failed'));
ALTER TABLE images ADD COLUMN preview_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN preview_lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN preview_updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX images_preview_recovery ON images(preview_status,preview_lease_until,created_at);
