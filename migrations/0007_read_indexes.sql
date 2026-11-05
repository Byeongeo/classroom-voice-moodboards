-- Page recent activity records without sorting every matching row first.
CREATE INDEX events_activity_date ON events(activity_id,created_at,id);
-- Preserve the existing lookup prefix while also ordering timestamp ties.
DROP INDEX events_activity_student;
CREATE INDEX events_activity_student ON events(activity_id,student_id,created_at,id);
CREATE INDEX image_actions_activity_date ON image_actions(activity_id,created_at,id);
CREATE INDEX image_actions_student_activity_date ON image_actions(student_id,activity_id,created_at,id);
-- The periodic cleanup should seek expired login counters, not scan live ones.
CREATE INDEX login_limits_expiry ON login_limits(expires_at);
