import { z, ZodError } from 'zod';
import { activitySchema, classSchema, commandSchema, genreSchema, loginSchema, MODELS, rosterSchema, type Activity, type ImageStyle, type Student } from '../shared/contracts';
import { cookie, digest, getSession, issueSession, passwordHash, rateLimitLogin, requireTeacher, sameSecret } from './auth';
import { allowedActivity, kstDayStart, quota, studentById, workspace } from './data';
import { ApiError, assert, body, json, now, sql, type Env, type Session } from './env';
import { processBatch, recoverJobs } from './jobs';
import { backupRoute, createBackup } from './backup';
import { assignClass, assignActivity, activityAccessSql, activityAssignmentStatements, validateParticipants } from './participants';
import { imageAction, uploadImage } from './images';

async function login(request: Request, env: Env) {
  const input = await body(request) as Record<string, unknown>;
  if ('teacherPassword' in input) {
    await rateLimitLogin(request, env, 'teacher');
    assert(env.TEACHER_PASSWORD?.length >= 24 && !env.TEACHER_PASSWORD.startsWith('replace-'), 503, 'ADMIN_NOT_CONFIGURED', '관리자 비밀번호 설정이 필요합니다.');
    assert(typeof input.teacherPassword === 'string' && await sameSecret(input.teacherPassword, env.TEACHER_PASSWORD), 401, 'LOGIN_FAILED', '로그인 정보를 확인해 주세요.');
    return json({ role: 'teacher' }, 200, { 'Set-Cookie': await issueSession(env, 'teacher', null, request) });
  }
  const v = loginSchema.parse(input);
  await rateLimitLogin(request, env, `${v.grade}:${v.classNumber}:${v.studentNumber}`);
  const student = await sql(env, 'SELECT * FROM students WHERE grade=? AND class_number=? AND student_number=? AND name=? AND enabled=1', v.grade, v.classNumber, v.studentNumber, v.name).first<Student & { password_hash: string; salt: string }>();
  // Run the same password derivation for an unknown identity to avoid a quick account probe.
  const derived = await passwordHash(v.password, student?.salt || 'unregistered-student-placeholder');
  assert(student && await sameSecret(derived, student.password_hash), 401, 'LOGIN_FAILED', '등록된 학년·반·번호·이름과 비밀번호를 확인해 주세요.');
  return json({ role: 'student' }, 200, { 'Set-Cookie': await issueSession(env, 'student', student.id, request) });
}

async function registerRoster(request: Request, env: Env) {
  const { students } = rosterSchema.parse(await body(request));
  const unique = new Set(students.map((s) => `${s.grade}:${s.classNumber}:${s.studentNumber}`));
  assert(unique.size === students.length, 400, 'DUPLICATE_ROSTER', '파일 안에 같은 학년·반·번호가 중복되어 있습니다.');
  const rows = await Promise.all(students.map(async (s) => {
    const existing = await sql(env, 'SELECT id FROM students WHERE grade=? AND class_number=? AND student_number=?', s.grade, s.classNumber, s.studentNumber).first();
    assert(!existing, 409, 'STUDENT_EXISTS', `${s.grade}학년 ${s.classNumber}반 ${s.studentNumber}번은 이미 등록되어 있습니다.`);
    const password = s.password || crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const salt = crypto.randomUUID();
    return { ...s, id: crypto.randomUUID(), password, salt, hash: await passwordHash(password, salt) };
  }));
  await env.DB.batch(rows.map((s) => sql(env, `INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,quota_reset_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, s.id, s.grade, s.classNumber, s.studentNumber, s.name, s.hash, s.salt, 0, now())));
  return json({ registered: rows.length, credentials: rows.map(({ grade, classNumber, studentNumber, name, password }) => ({ grade, classNumber, studentNumber, name, password })) }, 201);
}

async function admin(request: Request, env: Env, session: Session, url: URL) {
  requireTeacher(session);
  const route = url.pathname;
  if (route === '/api/admin/overview' && request.method === 'GET') {
    const [classes, activities, students, settings, backups, styles, rooms, assignments, genres, activityRooms, activityAssignments] = await Promise.all([
      sql(env, 'SELECT * FROM classes ORDER BY grade,class_number').all(),
      sql(env, 'SELECT a.*,c.name class_name FROM activities a JOIN classes c ON c.id=a.class_id ORDER BY a.opens_at DESC').all(),
      sql(env, 'SELECT id,grade,class_number,student_number,name,enabled FROM students ORDER BY grade,class_number,student_number LIMIT 2000').all(),
      sql(env, 'SELECT * FROM settings').all(),
      sql(env, `SELECT b.*, (SELECT COUNT(*) FROM backup_images i WHERE i.backup_id=b.id) image_count,
        (SELECT COUNT(*) FROM backup_images i WHERE i.backup_id=b.id AND i.copied=1) copied_count FROM backups b ORDER BY created_at DESC LIMIT 100`).all(),
      sql(env, 'SELECT * FROM image_styles ORDER BY rowid').all(),
      sql(env, 'SELECT * FROM class_rooms ORDER BY grade,class_number').all(),
      sql(env, 'SELECT * FROM class_students').all(),
      sql(env, 'SELECT * FROM writing_genres ORDER BY rowid').all(),
      sql(env, 'SELECT * FROM activity_rooms ORDER BY grade,class_number').all(),
      sql(env, 'SELECT * FROM activity_participants').all(),
    ]);
    return json({ classes: classes.results, activities: activities.results, students: students.results, settings: settings.results, backups: backups.results, styles: styles.results, rooms:rooms.results, assignments:assignments.results, genres:genres.results, activityRooms:activityRooms.results, activityAssignments:activityAssignments.results });
  }
  if (route === '/api/admin/classes' && request.method === 'POST') {
    const v = classSchema.parse(await body(request));
    const id = crypto.randomUUID();
    const rooms=v.rooms ?? (v.grade&&v.classNumber?[{grade:v.grade,classNumber:v.classNumber}]:[]);
    assert(new Set(rooms.map(r=>`${r.grade}:${r.classNumber}`)).size===rooms.length,400,'DUPLICATE_ROOMS','배정된 반이 중복되었습니다.');
    await env.DB.batch([sql(env, 'INSERT INTO classes(id,name,grade,class_number) VALUES(?,?,?,?)', id, v.name, v.grade??null, v.classNumber??null),...rooms.map(r=>sql(env,'INSERT INTO class_rooms(class_id,grade,class_number) VALUES(?,?,?)',id,r.grade,r.classNumber))]);
    return json({ id }, 201);
  }
  const assignmentMatch=route.match(/^\/api\/admin\/classes\/([\w-]+)\/assignments$/);
  if(assignmentMatch&&request.method==='PUT')return assignClass(request,env,assignmentMatch[1]);
  const classMatch = route.match(/^\/api\/admin\/classes\/([\w-]+)$/);
  if (classMatch && request.method === 'DELETE') {
    await sql(env, 'UPDATE classes SET deleted_at=? WHERE id=?', now(), classMatch[1]).run();
    return json({ ok: true });
  }
  if (route === '/api/admin/students' && request.method === 'POST') return registerRoster(request, env);
  if (route === '/api/admin/passwords/reset' && request.method === 'POST') {
    const { studentIds } = z.object({ studentIds: z.array(z.string().uuid()).min(1).max(300) }).parse(await body(request));
    assert(new Set(studentIds).size === studentIds.length, 400, 'DUPLICATE_IDS', '학생이 중복되었습니다.');
    const rows = await Promise.all(studentIds.map(async (id) => {
      const s = await studentById(env, id);
      const password = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const salt = crypto.randomUUID();
      return { ...s, password, salt, hash: await passwordHash(password, salt) };
    }));
    await env.DB.batch(rows.flatMap((s) => [sql(env, 'UPDATE students SET password_hash=?,salt=? WHERE id=?', s.hash, s.salt, s.id), sql(env, 'DELETE FROM sessions WHERE student_id=?', s.id)]));
    return json({ credentials: rows.map((s) => ({ grade: s.grade, classNumber: s.class_number, studentNumber: s.student_number, name: s.name, password: s.password })) });
  }
  if (route === '/api/admin/activities' && request.method === 'POST') {
    const v = activitySchema.parse(await body(request)); const id = crypto.randomUUID();
    assert(await sql(env, 'SELECT id FROM classes WHERE id=? AND deleted_at IS NULL', v.classId).first(), 404, 'CLASS_NOT_FOUND', '클래스를 찾을 수 없습니다.');
    if (v.assignment) await validateParticipants(env, v.assignment);
    await env.DB.batch([
      sql(env, `INSERT INTO activities(id,class_id,title,unit,instructions,opens_at,closes_at,command_limit,rubric_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, id, v.classId, v.title, v.unit, v.instructions, v.opensAt, v.closesAt, v.commandLimit, JSON.stringify(v.rubric), now()),
      ...(v.assignment ? activityAssignmentStatements(env, id, v.assignment) : []),
    ]);
    return json({ id }, 201);
  }
  const activityAssignmentMatch = route.match(/^\/api\/admin\/activities\/([\w-]+)\/assignments$/);
  if (activityAssignmentMatch && request.method === 'PUT') return assignActivity(request, env, activityAssignmentMatch[1]);
  const activityMatch = route.match(/^\/api\/admin\/activities\/([\w-]+)$/);
  if (activityMatch && request.method === 'PUT') {
    const v = activitySchema.parse(await body(request));
    const old = await sql(env, 'SELECT class_id FROM activities WHERE id=?', activityMatch[1]).first<{class_id:string}>();
    assert(old && old.class_id === v.classId, 400, 'CLASS_IMMUTABLE', '활동을 다른 클래스로 옮길 수는 없습니다. 참여할 학급·학생은 이 활동의 참여 대상에서 변경해 주세요.');
    if (v.assignment) await validateParticipants(env, v.assignment);
    await env.DB.batch([
      sql(env, 'UPDATE activities SET title=?,unit=?,instructions=?,opens_at=?,closes_at=?,command_limit=?,rubric_json=? WHERE id=?', v.title, v.unit, v.instructions, v.opensAt, v.closesAt, v.commandLimit, JSON.stringify(v.rubric), activityMatch[1]),
      ...(v.assignment ? activityAssignmentStatements(env, activityMatch[1], v.assignment) : []),
    ]);
    return json({ ok: true });
  }
  if (activityMatch && request.method === 'DELETE') {
    await sql(env, 'UPDATE activities SET deleted_at=? WHERE id=?', now(), activityMatch[1]).run();
    return json({ ok: true });
  }
  const quotaMatch = route.match(/^\/api\/admin\/activities\/([\w-]+)\/students\/([\w-]+)$/);
  if (quotaMatch && request.method === 'PUT') {
    const v = z.object({ limit: z.number().int().min(0).max(200), reset: z.boolean().default(false) }).parse(await body(request));
    const student = await studentById(env, quotaMatch[2]);
    await allowedActivity(env, student, quotaMatch[1]);
    await sql(env, `INSERT INTO activity_students(activity_id,student_id,command_limit_override,quota_reset_at) VALUES(?,?,?,?)
      ON CONFLICT(activity_id,student_id) DO UPDATE SET command_limit_override=excluded.command_limit_override,
      quota_reset_at=CASE WHEN ? THEN excluded.quota_reset_at ELSE activity_students.quota_reset_at END`, quotaMatch[1], student.id, v.limit, v.reset ? now() : 0, v.reset ? 1 : 0).run();
    return json({ ok: true });
  }
  if (route === '/api/admin/analytics' && request.method === 'GET') {
    const id = z.string().uuid().parse(url.searchParams.get('activityId'));
    const activity = await sql(env, 'SELECT a.*,c.grade,c.class_number FROM activities a JOIN classes c ON c.id=a.class_id WHERE a.id=?', id).first<Activity & {grade:number;class_number:number}>();
    assert(activity, 404, 'ACTIVITY_NOT_FOUND', '활동을 찾을 수 없습니다.');
    const [students, events, imageActions] = await Promise.all([
      sql(env, `SELECT s.id,s.grade,s.class_number,s.student_number,s.name, COALESCE(m.command_limit_override,?) effective_limit,
        (SELECT COUNT(*) FROM events e WHERE e.student_id=s.id AND e.activity_id=? AND e.kind='command' AND e.created_at>=COALESCE(m.quota_reset_at,0)) used,
        CASE WHEN ${activityAccessSql()} AND s.enabled=1 THEN 1 ELSE 0 END assigned
        FROM students s JOIN activities a ON a.id=? JOIN classes c ON c.id=a.class_id LEFT JOIN activity_students m ON m.student_id=s.id AND m.activity_id=a.id
        WHERE (${activityAccessSql()} AND s.enabled=1) OR EXISTS(SELECT 1 FROM events past WHERE past.student_id=s.id AND past.activity_id=?)
        ORDER BY s.grade,s.class_number,s.student_number`, activity.command_limit, id, id, id).all(),
      sql(env, `SELECT e.*,r.note review_note FROM events e LEFT JOIN reviews r ON r.event_id=e.id WHERE e.activity_id=? ORDER BY e.created_at LIMIT 10000`, id).all(),
      sql(env,'SELECT * FROM image_actions WHERE activity_id=? ORDER BY created_at,id LIMIT 10000',id).all(),
    ]);
    return json({ activity, students: students.results, events: events.results, imageActions:imageActions.results });
  }
  if(route==='/api/admin/genres'&&request.method==='POST'){
    const v=genreSchema.parse(await body(request));const id=crypto.randomUUID();
    if(v.recommendedStyleId)assert(await sql(env,'SELECT id FROM image_styles WHERE id=? AND enabled=1',v.recommendedStyleId).first(),400,'STYLE_NOT_FOUND','사용 중인 스타일을 선택해 주세요.');
    await sql(env,'INSERT INTO writing_genres(id,name,description,recommended_style_id) VALUES(?,?,?,?)',id,v.name,v.description,v.recommendedStyleId).run();return json({id},201);
  }
  const genreMatch=route.match(/^\/api\/admin\/genres\/([\w-]+)$/);
  if(genreMatch&&request.method==='PUT'){
    const {enabled}=z.object({enabled:z.boolean()}).parse(await body(request));
    if(!enabled){const count=await sql(env,'SELECT COUNT(*) n FROM writing_genres WHERE enabled=1 AND id<>?',genreMatch[1]).first<{n:number}>();assert(count?.n,400,'GENRE_REQUIRED','글 종류는 적어도 하나 남겨 주세요.');}
    await sql(env,'UPDATE writing_genres SET enabled=? WHERE id=?',enabled?1:0,genreMatch[1]).run();return json({ok:true});
  }
  const reviewMatch = route.match(/^\/api\/admin\/events\/([\w-]+)\/review$/);
  if (reviewMatch && request.method === 'PUT') {
    const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).parse(await body(request));
    await sql(env, 'INSERT INTO reviews(event_id,note,reviewed_at) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET note=excluded.note,reviewed_at=excluded.reviewed_at', reviewMatch[1], note, now()).run();
    return json({ ok: true });
  }
  if (route === '/api/admin/styles' && request.method === 'POST') {
    const v = z.object({ name: z.string().trim().min(1).max(50), prompt: z.string().trim().min(1).max(1000), genres: z.array(z.string().max(20)).max(10) }).parse(await body(request));
    const id = crypto.randomUUID();
    await sql(env, 'INSERT INTO image_styles(id,name,prompt,genres_json) VALUES(?,?,?,?)', id, v.name, v.prompt, JSON.stringify(v.genres)).run();
    return json({ id }, 201);
  }
  const styleMatch = route.match(/^\/api\/admin\/styles\/([\w-]+)$/);
  if (styleMatch && request.method === 'PUT') {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await body(request));
    await sql(env, 'UPDATE image_styles SET enabled=? WHERE id=?', enabled ? 1 : 0, styleMatch[1]).run();
    return json({ ok: true });
  }
  if (route === '/api/admin/settings' && request.method === 'PUT') {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(7).max(3650) }).parse(await body(request));
    await sql(env, "UPDATE settings SET value=? WHERE key='backup_retention_days'", String(retentionDays)).run();
    return json({ ok: true });
  }
  if (route === '/api/admin/backups' && request.method === 'POST') return createBackup(env);
  if (route.startsWith('/api/admin/backups/')) return backupRoute(request, env, url);
  throw new ApiError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    const local = ['localhost','127.0.0.1'].includes(url.hostname) && origin && ['localhost','127.0.0.1'].includes(new URL(origin).hostname);
    assert(origin === url.origin || local, 403, 'ORIGIN_MISMATCH', '같은 사이트에서 요청해 주세요.');
  }
  if (url.pathname === '/api/health') return json({ status: 'ok' });
  if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);
  const session = await getSession(request, env);
  if (url.pathname === '/api/me') return json({ role: session.role, student: session.student_id ? await studentById(env, session.student_id) : null, models: MODELS });
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const raw = request.headers.get('Cookie')?.match(/(?:^|;\s*)classroom_session=([^;]+)/)?.[1];
    if (raw) await sql(env, 'DELETE FROM sessions WHERE token_hash=?', await digest(raw)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', request, 0) });
  }
  if (url.pathname.startsWith('/api/admin/')) return admin(request, env, session, url);
  const imageMatch = url.pathname.match(/^\/api\/images\/([\w-]+)$/);
  if (imageMatch && request.method === 'GET') {
    const image = await sql(env, 'SELECT object_key,mime_type,student_id FROM images WHERE id=?', imageMatch[1]).first<{object_key:string;mime_type:string;student_id:string}>();
    assert(image && (session.role === 'teacher' || image.student_id === session.student_id), 404, 'IMAGE_NOT_FOUND', '이미지를 찾을 수 없습니다.');
    const object = await env.IMAGES.get(image.object_key);
    assert(object, 503, 'IMAGE_STORAGE_ERROR', '이미지 저장소를 확인해 주세요.');
    return new Response(object.body, { headers: { 'Content-Type': image.mime_type } });
  }
  assert(session.role === 'student' && session.student_id, 403, 'STUDENT_ONLY', '학생 계정으로 이용해 주세요.');
  const student = await studentById(env, session.student_id);
  if (url.pathname === '/api/activities' && request.method === 'GET') {
    const activities = await sql(env, `SELECT a.*,c.name class_name FROM activities a JOIN classes c ON c.id=a.class_id JOIN students s ON s.id=?
      WHERE ${activityAccessSql()} AND c.deleted_at IS NULL AND a.deleted_at IS NULL ORDER BY a.opens_at DESC`, student.id).all();
    const styles = await sql(env, 'SELECT * FROM image_styles WHERE enabled=1 ORDER BY rowid').all();
    const genres = await sql(env,'SELECT * FROM writing_genres WHERE enabled=1 ORDER BY rowid').all();
    return json({ activities: activities.results, styles: styles.results, genres:genres.results, serverTime: now() });
  }
  const uploadMatch=url.pathname.match(/^\/api\/activities\/([\w-]+)\/uploads$/);
  if(uploadMatch&&request.method==='POST')return uploadImage(request,env,student,uploadMatch[1]);
  const recordsMatch=url.pathname.match(/^\/api\/activities\/([\w-]+)\/(records|image-actions)$/);
  if(recordsMatch&&request.method==='GET'){
    await allowedActivity(env,student,recordsMatch[1]);
    const afterTime=z.coerce.number().int().nonnegative().parse(url.searchParams.get('afterTime')||0);
    const afterId=z.string().max(100).parse(url.searchParams.get('afterId')||'');
    const table=recordsMatch[2]==='records'?'events':'image_actions';
    const result=await sql(env,`SELECT * FROM ${table} WHERE student_id=? AND activity_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 201`,student.id,recordsMatch[1],afterTime,afterTime,afterId).all<{id:string;created_at:number}>();
    const rows=result.results.slice(0,200);const last=rows.at(-1);
    return json({rows,next:result.results.length>200&&last?{afterTime:last.created_at,afterId:last.id}:null});
  }
  const joinMatch = url.pathname.match(/^\/api\/activities\/([\w-]+)\/join$/);
  if (joinMatch && request.method === 'POST') {
    const activity = await allowedActivity(env, student, joinMatch[1]);
    const existing = await sql(env, 'SELECT id FROM boards WHERE student_id=? AND activity_id=?', student.id, activity.id).first();
    if (!existing) {
      await allowedActivity(env, student, activity.id, true);
      await env.DB.batch([
        sql(env, 'INSERT OR IGNORE INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,?,?)', crypto.randomUUID(), student.id, activity.id, activity.title, now()),
        sql(env, 'INSERT OR IGNORE INTO activity_students(activity_id,student_id) VALUES(?,?)', activity.id, student.id),
      ]);
    }
    return json(await workspace(env, student, activity.id));
  }
  if (url.pathname === '/api/workspace' && request.method === 'GET') return json(await workspace(env, student, z.string().uuid().parse(url.searchParams.get('activityId'))));
  const commandMatch = url.pathname.match(/^\/api\/activities\/([\w-]+)\/commands$/);
  if (commandMatch && request.method === 'POST') {
    const v = commandSchema.parse(await body(request));
    const existing = await sql(env, 'SELECT id,activity_id,kind FROM events WHERE student_id=? AND request_id=?', student.id, v.requestId).first<{id:string;activity_id:string;kind:string}>();
    if (existing) { assert(existing.activity_id === commandMatch[1]&&existing.kind==='command', 409, 'REQUEST_REUSED', '다른 요청 번호를 사용해 주세요.'); return json({ eventId: existing.id }, 202); }
    const activity = await allowedActivity(env, student, commandMatch[1], true);
    const board = await sql(env, 'SELECT id FROM boards WHERE student_id=? AND activity_id=?', student.id, activity.id).first<{id:string}>();
    assert(board, 400, 'JOIN_REQUIRED', '활동을 먼저 선택해 주세요.');
    const style = await sql(env, 'SELECT * FROM image_styles WHERE id=? AND enabled=1', v.styleId).first<ImageStyle>();
    assert(style, 400, 'STYLE_NOT_FOUND', '사용할 이미지 스타일을 선택해 주세요.');
    const q = await quota(env, student.id, activity); const timestamp = now(); const id = crypto.randomUUID();
    const cap = Math.max(1, Math.min(10000, Number(env.MAX_CLASS_COMMANDS_PER_DAY) || 900));
    const result = await sql(env, `INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,recognized_text,status,text_model,image_model,rubric_json,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM events WHERE student_id=? AND activity_id=? AND kind='command' AND created_at>=?) < ?
      AND (SELECT COUNT(*) FROM events WHERE kind='command' AND created_at>=?) < ?
      AND NOT EXISTS(SELECT 1 FROM events WHERE student_id=? AND status IN ('queued','processing'))
      AND EXISTS(SELECT 1 FROM activities a JOIN classes c ON c.id=a.class_id JOIN students s ON s.id=? WHERE a.id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND a.opens_at<=? AND a.closes_at>? AND ${activityAccessSql()})`,
      id, student.id, board.id, activity.id, v.requestId, v.transcript, v.inputMethod, style.id, style.name, style.prompt, v.recognizedText || null, MODELS.intent, MODELS.image, activity.rubric_json, timestamp, timestamp,
      student.id, activity.id, q.resetAt, q.limit, kstDayStart(timestamp), cap, student.id, student.id, activity.id, timestamp, timestamp).run();
    assert(result.meta.changes === 1, 409, 'LIMIT_OR_PENDING', '발화 한도에 도달했거나 이전 요청을 처리 중입니다.');
    try {
      await env.JOBS.send({ eventId: id, stage: 'generation' });
      await sql(env, 'UPDATE events SET dispatched_at=? WHERE id=?', now(), id).run();
    } catch { /* D1 is a durable outbox; the cron will dispatch this accepted request. */ }
    return json({ eventId: id }, 202);
  }
  const imageActionMatch=url.pathname.match(/^\/api\/images\/([\w-]+)(?:\/(pin|activate))?$/);
  if(imageActionMatch&&((imageActionMatch[2]&&request.method==='POST')||(!imageActionMatch[2]&&request.method==='DELETE')))return imageAction(env,student,imageActionMatch[1],request.method==='DELETE'?'hide':imageActionMatch[2] as 'pin'|'activate');
  throw new ApiError(404, 'NOT_FOUND', '요청을 찾을 수 없습니다.');
}

export default {
  async fetch(request: Request, env: Env) {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      if (error instanceof ZodError) response = json({ code: 'INVALID_INPUT', error: '입력값을 확인해 주세요.', details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
      else if (error instanceof ApiError) response = json({ code: error.code, error: error.message }, error.status);
      else {
        const conflict = String(error).includes('UNIQUE constraint');
        console.error(JSON.stringify({ type: 'request_error', code: conflict ? 'CONFLICT' : 'INTERNAL_ERROR' }));
        response = json({ code: conflict ? 'CONFLICT' : 'INTERNAL_ERROR', error: conflict ? '이미 등록된 항목입니다. 새로고침 후 확인해 주세요.' : '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, conflict ? 409 : 500);
      }
    }
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'same-origin');
    if (new URL(request.url).pathname.startsWith('/api/')) secured.headers.set('Cache-Control', 'private, no-store');
    return secured;
  },
  queue: processBatch,
  scheduled: recoverJobs,
} satisfies ExportedHandler<Env>;
