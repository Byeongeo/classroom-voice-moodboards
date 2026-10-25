import { assert, now, sql, type Env } from './env';
import type { Activity, Board, EventRecord, SavedImage, Student, Workspace } from '../shared/contracts';
import { activityAccessSql } from './participants';

export async function studentById(env: Env, id: string) {
  const student = await sql(env, 'SELECT id,grade,class_number,student_number,name,command_limit,quota_reset_at,enabled,current_board_id FROM students WHERE id=? AND enabled=1', id).first<Student>();
  assert(student, 403, 'STUDENT_DISABLED', '등록 상태를 교사에게 확인해 주세요.');
  return student;
}
export async function allowedActivity(env: Env, student: Student, activityId: string, requireOpen = false) {
  const activity = await sql(env, `SELECT a.*,c.name class_name FROM activities a JOIN classes c ON c.id=a.class_id JOIN students s ON s.id=?
    WHERE a.id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND ${activityAccessSql()}`, student.id, activityId).first<Activity>();
  assert(activity, 404, 'ACTIVITY_NOT_FOUND', '배정된 활동을 찾을 수 없습니다.');
  if (requireOpen) assert(now() >= activity.opens_at && now() < activity.closes_at, 403, 'ACTIVITY_CLOSED', '지금은 활동 시간이 아닙니다.');
  return activity;
}
export async function quota(env: Env, studentId: string, activity: Activity) {
  const member = await sql(env, 'SELECT command_limit_override,quota_reset_at FROM activity_students WHERE student_id=? AND activity_id=?', studentId, activity.id).first<{ command_limit_override: number | null; quota_reset_at: number }>();
  const used = await sql(env, "SELECT COUNT(*) count FROM events WHERE student_id=? AND activity_id=? AND kind='command' AND created_at>=?", studentId, activity.id, member?.quota_reset_at ?? 0).first<{ count: number }>();
  return { limit: member?.command_limit_override ?? activity.command_limit, used: used?.count ?? 0, resetAt: member?.quota_reset_at ?? 0 };
}
export async function workspace(env: Env, student: Student, activityId: string): Promise<Workspace> {
  const activity = await allowedActivity(env, student, activityId);
  const board = await sql(env, 'SELECT * FROM boards WHERE student_id=? AND activity_id=?', student.id, activityId).first<Board>();
  assert(board, 404, 'BOARD_NOT_FOUND', '활동을 먼저 선택해 주세요.');
  const [images, events, pending, q] = await Promise.all([
    sql(env, 'SELECT id,event_id,board_id,prompt,mime_type,parent_image_id,on_board,hidden_at,origin,byte_size,created_at FROM images WHERE board_id=? ORDER BY created_at', board.id).all<SavedImage>(),
    sql(env, `SELECT e.*,r.note review_note FROM events e LEFT JOIN reviews r ON r.event_id=e.id
      WHERE e.board_id=? ORDER BY e.created_at DESC LIMIT 200`, board.id).all<EventRecord>(),
    sql(env, "SELECT * FROM events WHERE student_id=? AND status IN ('queued','processing') LIMIT 1", student.id).first<EventRecord>(),
    quota(env, student.id, activity),
  ]);
  return { student, activity, board, images: images.results.map((i) => ({ ...i, imageUrl: `/api/images/${i.id}` })), events: events.results, pending, used: q.used, limit: q.limit };
}
export function kstDayStart(timestamp: number) {
  return Math.floor((timestamp + 32_400_000) / 86_400_000) * 86_400_000 - 32_400_000;
}
