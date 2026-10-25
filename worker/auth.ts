import { ApiError, assert, now, sql, type Env, type Session } from './env';

const encoder = new TextEncoder();
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sameSecret(a: string, b: string) {
  const x = await digest(a); const y = await digest(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export function cookie(token: string, request: Request, maxAge = 60 * 60 * 8) {
  return `classroom_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function issueSession(env: Env, role: Session['role'], studentId: string | null, request: Request) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await sql(env, 'INSERT INTO sessions(token_hash, student_id, role, expires_at) VALUES(?,?,?,?)', await digest(token), studentId, role, now() + 28_800_000).run();
  return cookie(token, request);
}
export async function getSession(request: Request, env: Env): Promise<Session> {
  const raw = request.headers.get('Cookie')?.match(/(?:^|;\s*)classroom_session=([^;]+)/)?.[1];
  if (!raw) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인이 필요합니다.');
  const session = await sql(env, `SELECT s.role, s.student_id FROM sessions s
    LEFT JOIN students st ON st.id=s.student_id WHERE s.token_hash=? AND s.expires_at>?
    AND (s.role='teacher' OR st.enabled=1)`, await digest(raw), now()).first<Session>();
  assert(session, 401, 'SESSION_EXPIRED', '다시 로그인해 주세요.');
  return session;
}
export function requireTeacher(session: Session) {
  assert(session.role === 'teacher', 403, 'TEACHER_ONLY', '관리자만 이용할 수 있습니다.');
}
export async function rateLimitLogin(request: Request, env: Env, identity: string) {
  const window = Math.floor(now() / 600_000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  for (const [key, limit] of [[`ip:${ip}:${window}`, 120], [`identity:${identity}:${window}`, 10]] as const) {
    const row = await sql(env, `INSERT INTO login_limits(key,hits,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits`, await digest(key), now() + 1_200_000).first<{ hits: number }>();
    assert(row && row.hits <= limit, 429, 'LOGIN_RATE_LIMIT', '로그인 시도가 많습니다. 10분 후 다시 시도해 주세요.');
  }
}
