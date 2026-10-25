export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  JOBS: Queue<Job>;
  TASKS: DurableObjectNamespace;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  TEACHER_PASSWORD: string;
  MAX_CLASS_COMMANDS_PER_DAY?: string;
  MAX_STORAGE_BYTES?: string;
}
export type Job = { eventId: string; stage: 'generation' | 'analysis' } | { backupId: string; stage: 'backup' } | { stage: 'maintenance' };
export type Session = { role: 'student' | 'teacher'; student_id: string | null };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const now = () => Date.now();
export const sql = (env: Env, query: string, ...args: unknown[]) => env.DB.prepare(query).bind(...args);
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers });
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export async function body(request: Request): Promise<unknown> {
  assert(request.headers.get('content-type')?.includes('application/json'), 415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');
  const limit = 128_000;
  const length = Number(request.headers.get('Content-Length') || 0);
  assert(!length || length <= limit, 413, 'TOO_LARGE', '요청이 너무 큽니다.');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel();throw new ApiError(413,'TOO_LARGE','요청이 너무 큽니다.');}
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text); } catch { throw new ApiError(400, 'INVALID_JSON', '요청 형식을 확인해 주세요.'); }
}
