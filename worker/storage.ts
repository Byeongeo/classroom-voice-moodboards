import { assert, now, sql, type Env } from './env';

export const DEFAULT_STORAGE_LIMIT = 8_000_000_000;
export function storageLimit(env: Env) {
  const value = Number(env.MAX_STORAGE_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, DEFAULT_STORAGE_LIMIT) : DEFAULT_STORAGE_LIMIT;
}
async function reconcileLegacyManifests(env: Env) {
  // Migration seeds pre-existing manifests with a temporary estimate. Before
  // accepting new files, replace those estimates with actual R2 sizes.
  const legacy = await sql(env, `SELECT s.object_key FROM storage_objects s JOIN backups b ON b.manifest_key=s.object_key
    WHERE b.status='ready' AND s.updated_at=b.created_at LIMIT 4`).all<{object_key:string}>();
  for (const item of legacy.results) {
    const object = await env.IMAGES.head(item.object_key);
    await sql(env, 'UPDATE storage_objects SET byte_size=?,updated_at=? WHERE object_key=?', object?.size || 0, now()+1, item.object_key).run();
  }
  const pending = await sql(env, `SELECT 1 FROM storage_objects s JOIN backups b ON b.manifest_key=s.object_key WHERE b.status='ready' AND s.updated_at=b.created_at LIMIT 1`).first();
  assert(!pending, 503, 'STORAGE_INDEXING', '이전 백업의 용량을 확인 중입니다. 잠시 후 다시 시도해 주세요.');
}
export async function storageUsage(env: Env) {
  const result = await sql(env, 'SELECT byte_size bytes,object_count objects FROM storage_totals WHERE id=1').all<{bytes:number;objects:number}>();
  const usage = result.results[0];
  const limit = storageLimit(env);
  return { bytes: usage?.bytes || 0, objects: usage?.objects || 0, limit, warning: (usage?.bytes || 0) >= limit * 0.8, databaseBytes: result.meta.size_after || null };
}
export async function reserveObject(env: Env, key: string, bytes: number) {
  assert(Number.isSafeInteger(bytes) && bytes >= 0, 500, 'INVALID_OBJECT_SIZE', '저장 크기를 확인하지 못했습니다.');
  await reconcileLegacyManifests(env);
  // One conditional statement makes the cap atomic across concurrent students,
  // generated versions and backup copies. Retry of a key replaces its reservation.
  const result = await sql(env, `INSERT INTO storage_objects(object_key,byte_size,updated_at)
    SELECT ?,?,? WHERE (SELECT byte_size FROM storage_totals WHERE id=1)-COALESCE((SELECT byte_size FROM storage_objects WHERE object_key=?),0)+?<=?
    ON CONFLICT(object_key) DO UPDATE SET byte_size=excluded.byte_size,updated_at=excluded.updated_at RETURNING object_key`, key, bytes, now(), key, bytes, storageLimit(env)).first<{object_key:string}>();
  assert(result, 507, 'STORAGE_LIMIT', '교실의 이미지·백업 저장 상한에 도달했습니다. 원본 기록은 보존됩니다. 교사에게 알려 주세요.');
}
export async function recordExistingObject(env: Env, key: string, bytes: number) {
  // The file already exists: a quota must not prevent repairing its D1 link.
  assert(Number.isSafeInteger(bytes) && bytes >= 0, 500, 'INVALID_OBJECT_SIZE', '저장 크기를 확인하지 못했습니다.');
  await sql(env, `INSERT INTO storage_objects(object_key,byte_size,updated_at) VALUES(?,?,?)
    ON CONFLICT(object_key) DO UPDATE SET byte_size=excluded.byte_size,updated_at=excluded.updated_at`, key, bytes, now()).run();
}
export async function checkStorageAvailable(env: Env) {
  await reconcileLegacyManifests(env);
  const usage = await storageUsage(env);
  assert(usage.bytes < usage.limit, 507, 'STORAGE_LIMIT', '교실의 이미지·백업 저장 상한에 도달했습니다. 기존 원본과 기록은 보존됩니다.');
}
export async function putObject(env: Env, key: string, data: ReadableStream | Uint8Array | string, bytes: number, options: R2PutOptions) {
  await reserveObject(env, key, bytes);
  // A failed response can follow a committed R2 write. Keep the reservation on
  // uncertain failure so usage is overestimated, never silently underestimated.
  return env.IMAGES.put(key, data, options);
}
export async function deleteObjects(env: Env, keys: string[]) {
  if (!keys.length) return;
  await env.IMAGES.delete(keys);
  await sql(env, `DELETE FROM storage_objects WHERE object_key IN (${keys.map(() => '?').join(',')})`, ...keys).run();
}
