ALTER TABLE activities ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'class' CHECK(assignment_mode IN ('class','custom'));
CREATE TABLE activity_rooms (
  activity_id TEXT NOT NULL REFERENCES activities(id),
  grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 12),
  class_number INTEGER NOT NULL CHECK(class_number BETWEEN 1 AND 50),
  PRIMARY KEY(activity_id,grade,class_number)
);
CREATE INDEX activity_rooms_identity ON activity_rooms(grade,class_number,activity_id);
CREATE TABLE activity_participants (
  activity_id TEXT NOT NULL REFERENCES activities(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  access INTEGER NOT NULL CHECK(access IN (0,1)),
  PRIMARY KEY(activity_id,student_id)
);
CREATE INDEX activity_participants_identity ON activity_participants(student_id,activity_id);
