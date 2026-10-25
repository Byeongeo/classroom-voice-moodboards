import { activityAssignmentSchema, assignmentSchema, type ActivityAssignment, type AssignmentTargets } from '../shared/contracts';
import { assert, body, json, sql, type Env } from './env';

// Explicit student exceptions override homeroom assignments, including exclusions.
export function classAccessSql(classAlias = 'c', studentAlias = 's') {
  return `COALESCE((SELECT cs.access FROM class_students cs WHERE cs.class_id=${classAlias}.id AND cs.student_id=${studentAlias}.id),
    EXISTS(SELECT 1 FROM class_rooms cr WHERE cr.class_id=${classAlias}.id AND cr.grade=${studentAlias}.grade AND cr.class_number=${studentAlias}.class_number))=1`;
}
// A custom activity audience replaces the class default, rather than intersecting it.
export function activityAccessSql(activityAlias = 'a', classAlias = 'c', studentAlias = 's') {
  return `(CASE WHEN ${activityAlias}.assignment_mode='custom' THEN
    COALESCE((SELECT ap.access FROM activity_participants ap WHERE ap.activity_id=${activityAlias}.id AND ap.student_id=${studentAlias}.id),
      EXISTS(SELECT 1 FROM activity_rooms ar WHERE ar.activity_id=${activityAlias}.id AND ar.grade=${studentAlias}.grade AND ar.class_number=${studentAlias}.class_number))=1
    ELSE ${classAccessSql(classAlias, studentAlias)} END)`;
}
export async function validateParticipants(env: Env, targets: AssignmentTargets) {
  if (!targets.students.length) return;
  const registered = await sql(env, 'SELECT id FROM students WHERE enabled=1').all<{id:string}>();
  const ids = new Set(registered.results.map(student => student.id));
  assert(targets.students.every(student => ids.has(student.studentId)), 400, 'STUDENT_NOT_FOUND', '등록된 학생만 배정할 수 있습니다.');
}
export function activityAssignmentStatements(env: Env, activityId: string, assignment: ActivityAssignment) {
  return [
    sql(env, 'UPDATE activities SET assignment_mode=? WHERE id=?', assignment.mode, activityId),
    sql(env, 'DELETE FROM activity_rooms WHERE activity_id=?', activityId),
    sql(env, 'DELETE FROM activity_participants WHERE activity_id=?', activityId),
    ...(assignment.mode === 'custom' ? [
      ...assignment.rooms.map(room => sql(env, 'INSERT INTO activity_rooms(activity_id,grade,class_number) VALUES(?,?,?)', activityId, room.grade, room.classNumber)),
      ...assignment.students.map(student => sql(env, 'INSERT INTO activity_participants(activity_id,student_id,access) VALUES(?,?,?)', activityId, student.studentId, student.access ? 1 : 0)),
    ] : []),
  ];
}
export async function assignActivity(request: Request, env: Env, activityId: string) {
  const assignment = activityAssignmentSchema.parse(await body(request));
  assert(await sql(env, 'SELECT a.id FROM activities a JOIN classes c ON c.id=a.class_id WHERE a.id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL', activityId).first(), 404, 'ACTIVITY_NOT_FOUND', '활동을 찾을 수 없습니다.');
  await validateParticipants(env, assignment);
  await env.DB.batch(activityAssignmentStatements(env, activityId, assignment));
  return json({ok:true});
}
export async function assignClass(request: Request, env: Env, classId: string) {
  const v = assignmentSchema.parse(await body(request));
  assert(await sql(env, 'SELECT id FROM classes WHERE id=? AND deleted_at IS NULL', classId).first(), 404, 'CLASS_NOT_FOUND', '클래스를 찾을 수 없습니다.');
  if (v.students.length) {
    const registered = await sql(env, 'SELECT id FROM students WHERE enabled=1').all<{id:string}>();
    const ids = new Set(registered.results.map(s=>s.id));
    assert(v.students.every(s=>ids.has(s.studentId)), 400, 'STUDENT_NOT_FOUND', '등록된 학생만 배정할 수 있습니다.');
  }
  await env.DB.batch([
    sql(env, 'DELETE FROM class_rooms WHERE class_id=?', classId),
    sql(env, 'DELETE FROM class_students WHERE class_id=?', classId),
    ...v.rooms.map(r=>sql(env, 'INSERT INTO class_rooms(class_id,grade,class_number) VALUES(?,?,?)', classId,r.grade,r.classNumber)),
    ...v.students.map(s=>sql(env, 'INSERT INTO class_students(class_id,student_id,access) VALUES(?,?,?)', classId,s.studentId,s.access?1:0)),
  ]);
  return json({ok:true});
}
