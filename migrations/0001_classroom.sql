PRAGMA foreign_keys = ON;
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  class_number INTEGER NOT NULL,
  student_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  command_limit INTEGER NOT NULL DEFAULT 10 CHECK(command_limit BETWEEN 0 AND 200),
  quota_reset_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  current_board_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(grade, class_number, student_number)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  student_id TEXT REFERENCES students(id),
  role TEXT NOT NULL CHECK(role IN ('student','teacher')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  activity_id TEXT NOT NULL REFERENCES activities(id),
  title TEXT NOT NULL DEFAULT '새 무드보드',
  active_image_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(student_id, activity_id)
);
CREATE INDEX boards_student ON boards(student_id, created_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  activity_id TEXT NOT NULL REFERENCES activities(id),
  request_id TEXT NOT NULL,
  transcript TEXT NOT NULL,
  recognized_text TEXT,
  input_method TEXT NOT NULL CHECK(input_method IN ('speech','text')),
  style_id TEXT NOT NULL,
  style_name TEXT NOT NULL,
  style_prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','succeeded','ignored','discarded','failed')),
  action TEXT,
  prompt TEXT,
  theme TEXT,
  source_image_id TEXT,
  image_id TEXT,
  text_model TEXT NOT NULL,
  image_model TEXT NOT NULL,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  dispatched_at INTEGER,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_json TEXT,
  rubric_json TEXT NOT NULL,
  analysis_attempts INTEGER NOT NULL DEFAULT 0,
  analysis_lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(student_id, request_id)
);
CREATE UNIQUE INDEX one_pending_per_student ON events(student_id) WHERE status IN ('queued','processing');
CREATE INDEX events_student_date ON events(student_id, created_at);
CREATE INDEX events_board_date ON events(board_id, created_at);
CREATE INDEX events_status ON events(status, updated_at);
CREATE INDEX events_analysis ON events(analysis_status, analysis_lease_until);
CREATE INDEX events_date ON events(created_at);
CREATE INDEX events_activity_student ON events(activity_id, student_id, created_at);
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  parent_image_id TEXT,
  on_board INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX images_board ON images(board_id, created_at);
CREATE INDEX images_student ON images(student_id, created_at);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE reviews (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  note TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL
);
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grade INTEGER NOT NULL,
  class_number INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(grade, class_number)
);
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL,
  unit TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  command_limit INTEGER NOT NULL DEFAULT 10 CHECK(command_limit BETWEEN 0 AND 200),
  rubric_json TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(closes_at > opens_at)
);
CREATE INDEX activities_class ON activities(class_id, opens_at);
CREATE TABLE activity_students (
  activity_id TEXT NOT NULL REFERENCES activities(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  command_limit_override INTEGER CHECK(command_limit_override BETWEEN 0 AND 200),
  quota_reset_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(activity_id, student_id)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key,value) VALUES('backup_retention_days','90');
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  manifest_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  error_code TEXT
  ,phase TEXT NOT NULL DEFAULT 'metadata'
  ,table_index INTEGER NOT NULL DEFAULT 0
  ,cursor INTEGER NOT NULL DEFAULT 0
  ,lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE backup_images (
  backup_id TEXT NOT NULL REFERENCES backups(id),
  image_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  copied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(backup_id,image_id)
);
CREATE TABLE backup_parts (
  backup_id TEXT NOT NULL REFERENCES backups(id),
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY(backup_id,object_key)
);
CREATE TABLE image_styles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  genres_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO image_styles(id,name,prompt,genres_json) VALUES
('photo','실사 사진','Photorealistic editorial photograph with natural lighting and rich details.','["설명문","논설문"]'),
('diagram','도해·인포그래픽','Clear educational diagram or infographic. Accurate relationships, simple visual hierarchy, minimal text.','["설명문","논설문"]'),
('poster','광고 포스터','Expressive advertising poster with bold composition and memorable visual metaphor.','["광고"]'),
('illustration','이야기 일러스트','Narrative book illustration with expressive characters, atmosphere and coherent scene.','["소설","시"]'),
('watercolor','수채화','Soft watercolor illustration, translucent pigments, visible paper texture and poetic atmosphere.','["소설","시"]'),
('comic','만화','Narrative comic-style illustration, expressive linework and clear visual storytelling.','["광고","소설"]');
