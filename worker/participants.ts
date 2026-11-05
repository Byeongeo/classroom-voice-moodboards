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
export async function validateParticipants(env: Env, targets: AssignmentTargets, existing?: { scope: 'class' | 'activity'; id: string }) {
  if (!targets.students.length) return;
  const registered = await sql(env, 'SELECT id FROM students WHERE enabled=1').all<{id:string}>();
  const ids = new Set(registered.results.map(student => student.id));
  const inactive = targets.students.filter(student => !ids.has(student.studentId));
  if (!inactive.length) return;
  // A deleted account cannot be newly assigned. Keep its saved choice when a teacher edits other targets.
  const previous = existing && (existing.scope === 'class'
    ? await sql(env, 'SELECT student_id,access FROM class_students WHERE class_id=?', existing.id).all<{ student_id: string; access: number }>()
    : await sql(env, 'SELECT student_id,access FROM activity_participants WHERE activity_id=?', existing.id).all<{ student_id: string; access: number }>());
  const saved = new Map(previous?.results.map(item => [item.student_id, !!item.access]));
  assert(inactive.every(student => saved.get(student.studentId) === student.access), 400, 'STUDENT_NOT_FOUND', '등록된 학생만 새로 배정할 수 있습니다.');
}
export function participantInserts(env: Env, scope: 'class' | 'activity', id: string, targets: AssignmentTargets) {
  const statements: D1PreparedStatement[] = [];
  const groups = [
    { table: `${scope}_rooms`, columns: `${scope}_id,grade,class_number`, rows: targets.rooms.map(r => [r.grade, r.classNumber]) },
    { table: scope === 'class' ? 'class_students' : 'activity_participants', columns: `${scope}_id,student_id,access`, rows: targets.students.map(s => [s.studentId, s.access ? 1 : 0]) },
  ];
  for (const group of groups) for (let offset = 0; offset < group.rows.length; offset += 25) {
    const page = group.rows.slice(offset, offset + 25);
    statements.push(sql(env, `INSERT INTO ${group.table}(${group.columns}) VALUES ${page.map(() => '(?,?,?)').join(',')}`, ...page.flatMap(row => [id, ...row])));
  }
  return statements;
}
export function activityAssignmentStatements(env: Env, activityId: string, assignment: ActivityAssignment) {
  return [
    sql(env, 'UPDATE activities SET assignment_mode=? WHERE id=?', assignment.mode, activityId),
    sql(env, 'DELETE FROM activity_rooms WHERE activity_id=?', activityId),
    sql(env, 'DELETE FROM activity_participants WHERE activity_id=?', activityId),
    ...(assignment.mode === 'custom' ? [
      ...participantInserts(env, 'activity', activityId, assignment),
    ] : []),
  ];
}
export async function assignActivity(request: Request, env: Env, activityId: string) {
  const assignment = activityAssignmentSchema.parse(await body(request));
  assert(await sql(env, 'SELECT a.id FROM activities a JOIN classes c ON c.id=a.class_id WHERE a.id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL', activityId).first(), 404, 'ACTIVITY_NOT_FOUND', '활동을 찾을 수 없습니다.');
  if (assignment.mode === 'custom') await validateParticipants(env, assignment, { scope: 'activity', id: activityId });
  await env.DB.batch(activityAssignmentStatements(env, activityId, assignment));
  return json({ok:true});
}
export async function assignClass(request: Request, env: Env, classId: string) {
  const v = assignmentSchema.parse(await body(request));
  assert(await sql(env, 'SELECT id FROM classes WHERE id=? AND deleted_at IS NULL', classId).first(), 404, 'CLASS_NOT_FOUND', '클래스를 찾을 수 없습니다.');
  await validateParticipants(env, v, { scope: 'class', id: classId });
  await env.DB.batch([
    sql(env, 'DELETE FROM class_rooms WHERE class_id=?', classId),
    sql(env, 'DELETE FROM class_students WHERE class_id=?', classId),
    ...participantInserts(env, 'class', classId, v),
  ]);
  return json({ok:true});
}
