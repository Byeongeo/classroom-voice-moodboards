import { assert, now, sql, type Env } from './env';
import type { Activity, Board, EventRecord, SavedImage, Student, Workspace, WorkspaceStatus } from '../shared/contracts';
import { digest } from './auth';
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
// Metadata tuples deliberately omit transcripts, prompts, review text and analysis
// bodies. Hashing each row's version fields catches analysis completion even when
// the generation updated_at does not change, unlike COUNT/MAX alone.
type EventMetadata = [string, string, string, string, number, number, number, number, number, number, string | null, string | null];
type ImageMetadata = [string, number, number | null, number, number, string | null, string | null, number | null, string, number];
async function workspaceSnapshot(env: Env, student: Student, activityId: string) {
  const row = await sql(env, `SELECT a.*,c.name class_name,
    b.id _status_board_id,b.title _status_board_title,b.active_image_id _status_active_image_id,b.created_at _status_board_created,
    json_array(s.id,s.grade,s.class_number,s.student_number,s.name,s.command_limit,s.quota_reset_at,s.enabled,s.current_board_id) _status_student,
    m.command_limit_override _status_limit,m.quota_reset_at _status_reset,
    (SELECT json_group_array(json_array(e.id,e.kind,e.status,e.analysis_status,e.created_at,e.updated_at,e.attempts,e.analysis_attempts,e.lease_until,e.analysis_lease_until,e.image_id,e.error_code))
      FROM (SELECT id,kind,status,analysis_status,created_at,updated_at,attempts,analysis_attempts,lease_until,analysis_lease_until,image_id,error_code FROM events WHERE board_id=b.id ORDER BY id) e) _status_events,
    (SELECT json_group_array(json_array(i.id,i.on_board,i.hidden_at,i.byte_size,i.created_at,i.preview_object_key,i.preview_mime_type,i.preview_byte_size,i.preview_status,i.preview_updated_at))
      FROM (SELECT id,on_board,hidden_at,byte_size,created_at,preview_object_key,preview_mime_type,preview_byte_size,preview_status,preview_updated_at FROM images WHERE board_id=b.id ORDER BY id) i) _status_images,
    (SELECT json_array(COUNT(*),MAX(created_at),MAX(id)) FROM image_actions WHERE board_id=b.id) _status_actions,
    (SELECT json_group_array(json_array(r.event_id,r.reviewed_at,length(r.note))) FROM
      (SELECT reviews.event_id,reviews.reviewed_at,reviews.note FROM reviews JOIN events ON events.id=reviews.event_id WHERE events.board_id=b.id ORDER BY reviews.event_id) r) _status_reviews,
    (SELECT json_group_array(json_array(p.id,p.board_id,p.status,p.updated_at,p.attempts)) FROM
      (SELECT id,board_id,status,updated_at,attempts FROM events WHERE student_id=s.id AND status IN ('queued','processing') ORDER BY id) p) _status_pending
    FROM activities a JOIN classes c ON c.id=a.class_id JOIN students s ON s.id=?
      LEFT JOIN boards b ON b.student_id=s.id AND b.activity_id=a.id
      LEFT JOIN activity_students m ON m.student_id=s.id AND m.activity_id=a.id
    WHERE a.id=? AND s.enabled=1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND ${activityAccessSql()}`, student.id, activityId).first<Record<string, unknown>>();
  assert(row, 404, 'ACTIVITY_NOT_FOUND', '배정된 활동을 찾을 수 없습니다.');
  assert(row._status_board_id, 404, 'BOARD_NOT_FOUND', '활동을 먼저 선택해 주세요.');
  const activity = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_status_'))) as Activity;
  const [id,grade,class_number,student_number,name,command_limit,quota_reset_at,enabled,current_board_id] = JSON.parse(row._status_student as string) as [string,number,number,number,string,number,number,number,string|null];
  const currentStudent: Student = { id,grade,class_number,student_number,name,command_limit,quota_reset_at,enabled,current_board_id };
  const board: Board & { student_id: string } = { id: row._status_board_id as string, student_id: student.id, activity_id: activityId, title: row._status_board_title as string, active_image_id: row._status_active_image_id as string|null, created_at: row._status_board_created as number };
  const events = JSON.parse(row._status_events as string) as EventMetadata[];
  const images = JSON.parse(row._status_images as string) as ImageMetadata[];
  const resetAt = (row._status_reset as number|null) ?? 0;
  const used = events.filter(event => event[1] === 'command' && event[4] >= resetAt).length;
  const limit = (row._status_limit as number|null) ?? activity.command_limit;
  const revision = 'w1-' + await digest(JSON.stringify([activity,board,row._status_student,row._status_limit,row._status_reset,row._status_events,row._status_images,row._status_actions,row._status_reviews,row._status_pending]));
  const hasPending = (JSON.parse(row._status_pending as string) as unknown[]).length > 0
    || events.some(event => ['pending','processing'].includes(event[3]))
    || images.some(image => ['queued','processing'].includes(image[8]));
  return { activity, board, student: currentStudent, used, limit, status: { revision, hasPending, serverTime: now() } satisfies WorkspaceStatus };
}

export async function workspaceStatus(env: Env, student: Student, activityId: string): Promise<WorkspaceStatus> {
  return (await workspaceSnapshot(env, student, activityId)).status;
}

export async function workspace(env: Env, student: Student, activityId: string): Promise<Workspace> {
  // Capture the revision before reading full data. If a mutation overlaps these
  // reads, the next status check can cause an extra refresh but cannot miss it.
  const snapshot = await workspaceSnapshot(env, student, activityId);
  const { activity, board } = snapshot;
  const [images, events, pending] = await Promise.all([
    sql(env, 'SELECT id,event_id,board_id,prompt,mime_type,parent_image_id,on_board,hidden_at,origin,byte_size,created_at,preview_object_key,preview_mime_type,preview_byte_size,preview_status,preview_updated_at FROM images WHERE board_id=? ORDER BY created_at', board.id).all<SavedImage>(),
    sql(env, `SELECT e.*,r.note review_note FROM events e LEFT JOIN reviews r ON r.event_id=e.id
      WHERE e.board_id=? ORDER BY e.created_at DESC LIMIT 200`, board.id).all<EventRecord>(),
    sql(env, "SELECT * FROM events WHERE student_id=? AND status IN ('queued','processing') LIMIT 1", student.id).first<EventRecord>(),
  ]);
  return { ...snapshot.status, student: snapshot.student, activity, board, images: images.results.map((i) => ({ ...i, imageUrl: `/api/images/${i.id}`, ...(i.preview_status === 'ready' ? { previewUrl: `/api/images/${i.id}?preview=1` } : {}) })), events: events.results, pending, used: snapshot.used, limit: snapshot.limit };
}
export function kstDayStart(timestamp: number) {
  return Math.floor((timestamp + 32_400_000) / 86_400_000) * 86_400_000 - 32_400_000;
}
