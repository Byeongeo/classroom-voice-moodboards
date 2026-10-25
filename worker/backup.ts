import { assert, json, now, sql, type Env } from './env';
import { putObject, deleteObjects } from './storage';

const TABLES = [
  ['students', 'id,grade,class_number,student_number,name,enabled,created_at'],
  ['classes', '*'], ['class_rooms','*'], ['class_students','*'], ['activities', '*'], ['activity_rooms','*'], ['activity_participants','*'], ['activity_students', '*'],
  ['boards', '*'], ['events', '*'], ['images', '*'], ['image_actions','*'], ['reviews', '*'], ['image_styles', '*'], ['writing_genres','*'],
] as const;
type Backup = { id: string; status: string; phase: string; manifest_key: string; table_index: number; cursor: number; created_at: number; expires_at: number };

export async function createBackup(env: Env) {
  assert(!await sql(env, "SELECT id FROM events WHERE status IN ('queued','processing') OR analysis_status IN ('pending','processing') LIMIT 1").first(), 409, 'WAIT_FOR_JOBS', '진행 중인 이미지·분석 작업이 끝난 뒤 백업을 실행해 주세요.');
  assert(!await sql(env, "SELECT id FROM backups WHERE status IN ('queued','processing') LIMIT 1").first(), 409, 'BACKUP_BUSY', '이전 백업이 완료된 뒤 다시 시도해 주세요.');
  const retention = await sql(env, "SELECT value FROM settings WHERE key='backup_retention_days'").first<{value:string}>();
  const id = crypto.randomUUID(); const timestamp = now();
  await env.DB.batch([
    sql(env, 'INSERT INTO backups(id,manifest_key,created_at,expires_at) VALUES(?,?,?,?)', id, `backups/${id}/manifest.json`, timestamp, timestamp + Number(retention?.value || 90) * 86_400_000),
    sql(env, `INSERT INTO backup_images(backup_id,image_id,source_key,object_key,mime_type,byte_size)
      SELECT ?,id,object_key,? || id,mime_type,byte_size FROM images WHERE created_at<=?`, id, `backups/${id}/images/`, timestamp),
  ]);
  try { await env.JOBS.send({ stage: 'backup', backupId: id }); } catch { /* cron recovers the outbox */ }
  return json({ id }, 202);
}

export async function processBackup(env: Env, id: string) {
  const backup = await sql(env, `UPDATE backups SET status='processing',lease_until=? WHERE id=?
    AND status IN ('queued','processing') AND lease_until<? RETURNING *`, now() + 120_000, id, now()).first<Backup>();
  if (!backup) return;
  try {
    if (backup.phase === 'metadata' && backup.table_index < TABLES.length) {
      const [table, columns] = TABLES[backup.table_index];
      // Fixed table allowlist; no user input enters the SQL identifiers.
      const dated = ['students','activities','boards','events','images','image_actions'].includes(table);
      const page = await sql(env, `SELECT rowid _rowid,${columns} FROM ${table} WHERE rowid>? ${dated ? 'AND created_at<=?' : ''} ORDER BY rowid LIMIT 25`, ...[backup.cursor, ...(dated ? [backup.created_at] : [])]).all<Record<string, unknown> & {_rowid:number}>();
      if (page.results.length) {
        const key = `backups/${id}/metadata/${table}-${backup.cursor}.json`;
        const data = JSON.stringify({ table, rows: page.results.map(({ _rowid, ...row }) => row) });
        const bytes = new TextEncoder().encode(data);
        await putObject(env,key,bytes,bytes.byteLength,{ httpMetadata: { contentType: 'application/json' } });
        await env.DB.batch([
          sql(env, 'INSERT OR REPLACE INTO backup_parts(backup_id,object_key,byte_size) VALUES(?,?,?)', id, key, bytes.byteLength),
          sql(env, 'UPDATE backups SET cursor=?,status=\'queued\',lease_until=0 WHERE id=?', page.results[page.results.length - 1]._rowid, id),
        ]);
      } else {
        await sql(env, "UPDATE backups SET table_index=table_index+1,cursor=0,status='queued',lease_until=0 WHERE id=?", id).run();
      }
    } else {
      await sql(env, "UPDATE backups SET phase='images' WHERE id=?", id).run();
      const images = await sql(env, 'SELECT * FROM backup_images WHERE backup_id=? AND copied=0 LIMIT 3', id).all<{image_id:string;source_key:string;object_key:string;mime_type:string}>();
      for (const image of images.results) {
        const source = await env.IMAGES.get(image.source_key);
        assert(source, 503, 'BACKUP_SOURCE_MISSING', '원본 이미지가 없어 백업을 완료하지 못했습니다.');
        await putObject(env,image.object_key,source.body,source.size,{ httpMetadata: { contentType: image.mime_type } });
        await sql(env, 'UPDATE backup_images SET copied=1 WHERE backup_id=? AND image_id=?', id, image.image_id).run();
      }
      if (!images.results.length) {
        const parts = await sql(env, 'SELECT object_key,byte_size FROM backup_parts WHERE backup_id=? ORDER BY object_key', id).all<{object_key:string;byte_size:number}>();
        const allImages = await sql(env, 'SELECT image_id,mime_type,byte_size FROM backup_images WHERE backup_id=? AND copied=1', id).all<{image_id:string;mime_type:string;byte_size:number}>();
        const manifest = {
          version: 1, id, startedAt: backup.created_at, completedAt: now(), expiresAt: backup.expires_at,
          description: '학습 기록 백업. 암호와 세션은 제외합니다. 메타데이터는 백업 처리 기간에 걸쳐 수집됩니다.',
          files: [
            ...parts.results.map((p) => ({ name: p.object_key.split(`/backups/${id}/`)[1] || p.object_key.replace(`backups/${id}/`, ''), bytes: p.byte_size, url: `/api/admin/backups/${id}/file?key=${encodeURIComponent(p.object_key)}` })),
            ...allImages.results.map((p) => ({ name: `images/${p.image_id}.${p.mime_type.split('/')[1]}`, bytes: p.byte_size, url: `/api/admin/backups/${id}/image/${p.image_id}` })),
          ],
        };
        const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
        await putObject(env,backup.manifest_key,manifestBytes,manifestBytes.byteLength,{ httpMetadata: { contentType: 'application/json' } });
        await sql(env, "UPDATE backups SET status='ready',lease_until=0,error_code=NULL WHERE id=?", id).run();
        return;
      }
      await sql(env, "UPDATE backups SET status='queued',lease_until=0 WHERE id=?", id).run();
    }
    await sql(env, 'UPDATE backups SET failures=0,error_code=NULL WHERE id=?', id).run();
    await env.JOBS.send({ stage: 'backup', backupId: id });
  } catch (error) {
    await sql(env, "UPDATE backups SET status=CASE WHEN failures>=2 THEN 'failed' ELSE 'queued' END,failures=failures+1,lease_until=0,error_code='BACKUP_RETRY' WHERE id=?", id).run();
    throw error;
  }
}

export async function backupRoute(request: Request, env: Env, url: URL) {
  assert(request.method === 'GET', 405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.');
  const match = url.pathname.match(/^\/api\/admin\/backups\/([\w-]+)\/(manifest|file|image)(?:\/([\w-]+))?$/);
  assert(match, 404, 'NOT_FOUND', '백업 파일을 찾을 수 없습니다.');
  const backup = await sql(env, "SELECT * FROM backups WHERE id=? AND status='ready' AND expires_at>?", match[1], now()).first<Backup>();
  assert(backup, 404, 'BACKUP_NOT_READY', '완료된 백업을 찾을 수 없습니다.');
  let key = backup.manifest_key;
  if (match[2] === 'file') {
    const part = await sql(env, 'SELECT object_key FROM backup_parts WHERE backup_id=? AND object_key=?', backup.id, url.searchParams.get('key')).first<{object_key:string}>();
    assert(part, 404, 'NOT_FOUND', '백업 파일을 찾을 수 없습니다.'); key = part.object_key;
  } else if (match[2] === 'image') {
    const image = await sql(env, 'SELECT object_key FROM backup_images WHERE backup_id=? AND image_id=? AND copied=1', backup.id, match[3] || '').first<{object_key:string}>();
    assert(image, 404, 'NOT_FOUND', '백업 이미지를 찾을 수 없습니다.'); key = image.object_key;
  }
  const object = await env.IMAGES.get(key);
  assert(object, 503, 'BACKUP_STORAGE_ERROR', '백업 저장소를 확인해 주세요.');
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' } });
}

export async function expireBackups(env: Env) {
  const expired = await sql(env, "SELECT id FROM backups WHERE expires_at<? AND status IN ('ready','failed','expiring') LIMIT 1", now()).first<{id:string}>();
  if (!expired) return;
  await sql(env, "UPDATE backups SET status='expiring' WHERE id=?", expired.id).run();
  const objects = await env.IMAGES.list({ prefix: `backups/${expired.id}/`, limit: 10 });
  if (objects.objects.length) await deleteObjects(env,objects.objects.map((o) => o.key));
  if (!objects.truncated) {
    await env.DB.batch([
      sql(env, 'DELETE FROM storage_objects WHERE object_key LIKE ?', `backups/${expired.id}/%`),
      sql(env, 'DELETE FROM backup_images WHERE backup_id=?', expired.id),
      sql(env, 'DELETE FROM backup_parts WHERE backup_id=?', expired.id),
      sql(env, "UPDATE backups SET status='expired' WHERE id=?", expired.id),
    ]);
  }
}
