PRAGMA defer_foreign_keys = ON;
CREATE TABLE classes_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grade INTEGER,
  class_number INTEGER,
  deleted_at INTEGER
);
INSERT INTO classes_new SELECT id,name,grade,class_number,deleted_at FROM classes;
DROP TABLE classes;
ALTER TABLE classes_new RENAME TO classes;
PRAGMA defer_foreign_keys = OFF;

CREATE TABLE class_rooms (
  class_id TEXT NOT NULL REFERENCES classes(id),
  grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 12),
  class_number INTEGER NOT NULL CHECK(class_number BETWEEN 1 AND 50),
  PRIMARY KEY(class_id,grade,class_number)
);
INSERT INTO class_rooms SELECT id,grade,class_number FROM classes WHERE grade IS NOT NULL AND class_number IS NOT NULL;
CREATE INDEX class_rooms_identity ON class_rooms(grade,class_number,class_id);
CREATE TABLE class_students (
  class_id TEXT NOT NULL REFERENCES classes(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  access INTEGER NOT NULL CHECK(access IN (0,1)),
  PRIMARY KEY(class_id,student_id)
);
CREATE INDEX class_students_identity ON class_students(student_id,class_id);

ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'command' CHECK(kind IN ('command','upload'));
ALTER TABLE images ADD COLUMN hidden_at INTEGER;
ALTER TABLE images ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated' CHECK(origin IN ('generated','upload'));
CREATE TABLE image_actions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  activity_id TEXT NOT NULL REFERENCES activities(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  image_id TEXT NOT NULL REFERENCES images(id),
  event_id TEXT REFERENCES events(id),
  action TEXT NOT NULL CHECK(action IN ('upload','generate','edit','hide','pin','activate','discard')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX image_actions_board ON image_actions(board_id,created_at,id);
INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,metadata_json,created_at)
  SELECT 'generated-'||i.id,i.student_id,e.activity_id,i.board_id,i.id,e.id,
  CASE WHEN i.parent_image_id IS NULL THEN 'generate' ELSE 'edit' END,
  json_object('parentImageId',i.parent_image_id,'importedExistingHistory',1),i.created_at
  FROM images i JOIN events e ON e.id=i.event_id;

CREATE TABLE writing_genres (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  recommended_style_id TEXT REFERENCES image_styles(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
INSERT INTO writing_genres(id,name,recommended_style_id) VALUES
('explanation','설명문','photo'),('argument','논설문','photo'),('advertisement','광고','poster'),('fiction','소설','illustration'),('poetry','시','watercolor');
