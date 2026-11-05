import { z } from 'zod';
import { identitySchema, rosterSchema, studentPasswordSchema, type RosterStudent } from '../shared/contracts';
import { passwordHash } from './auth';
import { ApiError, assert, body, json, now, sql, type Env } from './env';

const rosterFields = 'id,grade,class_number,student_number,name,enabled';
const generatePassword = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);
const manualPassword = studentPasswordSchema.refine(password => password.trim().length > 0);

async function hashedPassword(password: string) {
  const salt = crypto.randomUUID();
  return { salt, hash: await passwordHash(password, salt) };
}

export async function registerRoster(request: Request, env: Env) {
  const { students } = rosterSchema.parse(await body(request));
  const unique = new Set(students.map(s => `${s.grade}:${s.classNumber}:${s.studentNumber}`));
  assert(unique.size === students.length, 400, 'DUPLICATE_ROSTER', '파일 안에 같은 학년·반·번호가 중복되어 있습니다.');
  const duplicate = await sql(env, `SELECT grade,class_number,student_number,enabled FROM students
    WHERE (grade || ':' || class_number || ':' || student_number) IN (${[...unique].map(() => '?').join(',')})`, ...unique)
    .first<Pick<RosterStudent, 'grade' | 'class_number' | 'student_number' | 'enabled'>>();
  if (duplicate) {
    const label = `${duplicate.grade}학년 ${duplicate.class_number}반 ${duplicate.student_number}번`;
    throw new ApiError(409, 'STUDENT_EXISTS', duplicate.enabled
      ? `${label}은 이미 등록되어 있습니다. 등록 학생 목록에서 이름을 수정할 수 있습니다.`
      : `${label}은 삭제된 학생 목록에 있습니다. 같은 학생이면 목록에서 복구해 주세요.`);
  }
  const rows = await Promise.all(students.map(async student => {
    const password = student.password ?? generatePassword();
    return { ...student, id: crypto.randomUUID(), password, ...await hashedPassword(password) };
  }));
  await env.DB.batch(rows.map(s => sql(env, `INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,quota_reset_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, s.id, s.grade, s.classNumber, s.studentNumber, s.name, s.hash, s.salt, 0, now())));
  return json({ registered: rows.length, credentials: rows.map(({ grade, classNumber, studentNumber, name, password }) => ({ grade, classNumber, studentNumber, name, password })) }, 201);
}

export async function renameStudent(request: Request, env: Env, id: string) {
  const { name } = identitySchema.pick({ name: true }).parse(await body(request));
  const student = await sql(env, `UPDATE students SET name=? WHERE id=? AND enabled=1 RETURNING ${rosterFields}`, name, id).first<RosterStudent>();
  assert(student, 404, 'STUDENT_NOT_FOUND', '등록된 학생을 선택해 주세요.');
  return json({ student });
}

export async function removeStudent(env: Env, id: string) {
  const [updated] = await env.DB.batch<RosterStudent>([
    sql(env, `UPDATE students SET enabled=0 WHERE id=? RETURNING ${rosterFields}`, id),
    sql(env, 'DELETE FROM sessions WHERE student_id=?', id),
  ]);
  const student = updated.results[0];
  assert(student, 404, 'STUDENT_NOT_FOUND', '등록된 학생을 선택해 주세요.');
  return json({ student });
}

async function replacePasswords(env: Env, changes: { id: string; password: string }[], enabled: 0 | 1 = 1) {
  const rows = await Promise.all(changes.map(async row => ({ ...row, ...await hashedPassword(row.password) })));
  const results = await env.DB.batch<RosterStudent>(rows.flatMap(row => [
    sql(env, `UPDATE students SET password_hash=?,salt=?,enabled=1 WHERE id=? AND enabled=? RETURNING ${rosterFields}`,
      row.hash, row.salt, row.id, enabled),
    sql(env, 'DELETE FROM sessions WHERE student_id=? AND EXISTS(SELECT 1 FROM students WHERE id=? AND salt=?)',
      row.id, row.id, row.salt),
  ]));
  return rows.flatMap(({ password }, index) => {
    const student = results[index * 2].results[0];
    if (!student) return [];
    return [{ student, credential: {
      grade: student.grade, classNumber: student.class_number, studentNumber: student.student_number, name: student.name, password,
    } }];
  });
}

export async function updateStudentPassword(request: Request, env: Env, id: string, restore: boolean) {
  const schema = z.object({ password: restore ? manualPassword.optional() : manualPassword });
  const { password } = schema.parse(await body(request));
  const [result] = await replacePasswords(env, [{ id, password: password ?? generatePassword() }], restore ? 0 : 1);
  assert(result, 404, 'STUDENT_NOT_FOUND', restore ? '삭제된 학생을 선택해 주세요.' : '등록된 학생을 선택해 주세요.');
  return json({ student: result.student, credentials: [result.credential] });
}

export async function resetRosterPasswords(request: Request, env: Env) {
  const { studentIds } = z.object({ studentIds: z.array(z.string().uuid()).min(1).max(20) }).parse(await body(request));
  assert(new Set(studentIds).size === studentIds.length, 400, 'DUPLICATE_IDS', '학생이 중복되었습니다.');
  const selected = await sql(env, `SELECT id FROM students WHERE enabled=1 AND id IN (${studentIds.map(() => '?').join(',')})`, ...studentIds).all<{ id: string }>();
  assert(selected.results.length === studentIds.length, 404, 'STUDENT_NOT_FOUND', '등록된 학생을 선택해 주세요.');
  const results = await replacePasswords(env, studentIds.map(id => ({ id, password: generatePassword() })));
  return json({ credentials: results.map(result => result.credential) });
}
