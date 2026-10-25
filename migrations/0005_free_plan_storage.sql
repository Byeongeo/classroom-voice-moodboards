CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO storage_objects SELECT object_key,byte_size,created_at FROM images;
INSERT OR IGNORE INTO storage_objects SELECT bi.object_key,bi.byte_size,b.created_at FROM backup_images bi JOIN backups b ON b.id=bi.backup_id WHERE bi.copied=1 AND b.status<>'expired';
INSERT OR IGNORE INTO storage_objects SELECT p.object_key,p.byte_size,b.created_at FROM backup_parts p JOIN backups b ON b.id=p.backup_id WHERE b.status<>'expired';
INSERT OR IGNORE INTO storage_objects SELECT manifest_key,1048576,created_at FROM backups WHERE status='ready';
CREATE TABLE storage_totals (id INTEGER PRIMARY KEY CHECK(id=1), byte_size INTEGER NOT NULL DEFAULT 0, object_count INTEGER NOT NULL DEFAULT 0);
INSERT INTO storage_totals SELECT 1,COALESCE(SUM(byte_size),0),COUNT(*) FROM storage_objects;
CREATE TRIGGER storage_insert AFTER INSERT ON storage_objects BEGIN UPDATE storage_totals SET byte_size=byte_size+NEW.byte_size,object_count=object_count+1 WHERE id=1; END;
CREATE TRIGGER storage_update AFTER UPDATE OF byte_size ON storage_objects BEGIN UPDATE storage_totals SET byte_size=byte_size+NEW.byte_size-OLD.byte_size WHERE id=1; END;
CREATE TRIGGER storage_delete AFTER DELETE ON storage_objects BEGIN UPDATE storage_totals SET byte_size=byte_size-OLD.byte_size,object_count=object_count-1 WHERE id=1; END;
CREATE INDEX events_generation_recovery ON events(status,dispatched_at,lease_until) WHERE kind='command';
CREATE INDEX events_analysis_recovery ON events(analysis_status,analysis_lease_until,status);
CREATE INDEX students_identity_key ON students((grade || ':' || class_number || ':' || student_number));
