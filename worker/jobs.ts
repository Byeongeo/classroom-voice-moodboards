import { intentSchema, type Board } from '../shared/contracts';
import { INTENT_PROMPT } from './prompts';
import { ApiError, now, sql, type Env, type Job } from './env';
import { generateImage, ProviderError, textCompletion } from './openrouter';
import { analyze } from './analysis';
import { expireBackups } from './backup';
import { recoverUploads } from './images';
import { putObject, recordExistingObject, checkStorageAvailable } from './storage';

type StoredEvent = {
  id: string; student_id: string; activity_id: string; board_id: string; transcript: string;
  status: string; action: string | null; prompt: string | null; theme: string | null;
  source_image_id: string | null; attempts: number; lease_until: number; created_at: number;
  analysis_status: string; analysis_attempts: number; analysis_lease_until: number; rubric_json: string;
  style_prompt: string; kind: 'command'|'upload';
};
const terminal = (status: string) => !['queued','processing'].includes(status);
const objectKey = (event: StoredEvent) => `images/${event.student_id}/${event.id}`;

async function finishImage(env: Env, event: StoredEvent, object: R2Object) {
  const mime = object.httpMetadata?.contentType || 'image/png';
  const pin = event.action === 'SAVE_AND_NEXT' || event.action === 'START_NEW_THEME';
  await env.DB.batch([
    sql(env, `INSERT OR IGNORE INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,parent_image_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, event.id, event.id, event.student_id, event.board_id, objectKey(event), mime, object.size, event.prompt || event.transcript, event.action === 'EDIT_ACTIVE' ? event.source_image_id : null, now()),
    sql(env, 'UPDATE images SET on_board=1 WHERE id=? AND student_id=? AND ?=1', event.source_image_id, event.student_id, pin ? 1 : 0),
    sql(env, 'UPDATE boards SET active_image_id=?,title=COALESCE(?,title) WHERE id=? AND student_id=?', event.id, event.theme, event.board_id, event.student_id),
    sql(env, "UPDATE events SET status='succeeded',image_id=?,lease_until=0,error_code=NULL,updated_at=? WHERE id=?", event.id, now(), event.id),
    sql(env, `INSERT OR IGNORE INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, 'generated-'+event.id,event.student_id,event.activity_id,event.board_id,event.id,event.id,event.action==='EDIT_ACTIVE'?'edit':'generate',JSON.stringify({parentImageId:event.action==='EDIT_ACTIVE'?event.source_image_id:null}),now()),
    ...(pin&&event.source_image_id?[sql(env,`INSERT OR IGNORE INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,'pin',?,?)`,'auto-pin-'+event.id,event.student_id,event.activity_id,event.board_id,event.source_image_id,event.id,JSON.stringify({source:'spoken-command'}),now())]:[]),
  ]);
}

export async function runGeneration(env: Env, id: string): Promise<'done' | 'busy'> {
  let event = await sql(env, 'SELECT * FROM events WHERE id=?', id).first<StoredEvent>();
  if (!event || event.kind==='upload' || terminal(event.status)) return 'done';
  const claimed = await sql(env, `UPDATE events SET status='processing',lease_until=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND (status='queued' OR (status='processing' AND lease_until<?)) RETURNING *`, now() + 360_000, now(), id, now()).first<StoredEvent>();
  if (!claimed) return 'busy';
  event = claimed;
  try {
    // R2 checkpoint survives a failure between object upload and the D1 transaction.
    const checkpoint = await env.IMAGES.head(objectKey(event));
    if (checkpoint) { await recordExistingObject(env, objectKey(event), checkpoint.size); await finishImage(env, event, checkpoint); return 'done'; }
    if (event.attempts > 3) throw new ProviderError(false, 'RETRY_LIMIT');
    const board = await sql(env, 'SELECT * FROM boards WHERE id=? AND student_id=?', event.board_id, event.student_id).first<Board>();
    if (!board) throw new ApiError(404, 'BOARD_NOT_FOUND', 'Board unavailable');
    if (!event.action) {
      const active = board.active_image_id ? await sql(env, 'SELECT prompt FROM images WHERE id=? AND student_id=?', board.active_image_id, event.student_id).first<{prompt:string}>() : null;
      const parsed = intentSchema.parse(await textCompletion(env, INTENT_PROMPT, { transcript: event.transcript, theme: board.title, activeImagePrompt: active?.prompt || null }));
      if (parsed.action === 'EDIT_ACTIVE' && !active) parsed.action = 'START_NEW_THEME';
      if (['START_NEW_THEME','SAVE_AND_NEXT','EDIT_ACTIVE'].includes(parsed.action) && !parsed.imagePrompt) throw new ProviderError(false, 'MISSING_IMAGE_PROMPT');
      await sql(env, 'UPDATE events SET action=?,prompt=?,theme=?,source_image_id=?,updated_at=? WHERE id=?', parsed.action, parsed.imagePrompt, parsed.themeTitle, board.active_image_id, now(), id).run();
      event = { ...event, action: parsed.action, prompt: parsed.imagePrompt, theme: parsed.themeTitle, source_image_id: board.active_image_id };
    }
    if (event.action === 'IGNORE' || event.action === 'DISCARD_ACTIVE') {
      const statements = [sql(env, 'UPDATE events SET status=?,lease_until=0,updated_at=? WHERE id=?', event.action === 'IGNORE' ? 'ignored' : 'discarded', now(), id)];
      if (event.action === 'DISCARD_ACTIVE') {
        statements.push(sql(env, 'UPDATE boards SET active_image_id=NULL WHERE id=?', event.board_id));
        if(event.source_image_id)statements.push(sql(env,`INSERT OR IGNORE INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,'discard',?,?)`,'discard-'+event.id,event.student_id,event.activity_id,event.board_id,event.source_image_id,event.id,JSON.stringify({source:'spoken-command'}),now()));
      }
      await env.DB.batch(statements);
      return 'done';
    }
    let reference: { bytes: Uint8Array; mime: string } | undefined;
    if (event.action === 'EDIT_ACTIVE' && event.source_image_id) {
      const source = await sql(env, 'SELECT object_key,mime_type FROM images WHERE id=? AND student_id=?', event.source_image_id, event.student_id).first<{object_key:string;mime_type:string}>();
      if (!source) throw new ProviderError(false, 'SOURCE_NOT_FOUND');
      const stored = await env.IMAGES.get(source.object_key);
      if (!stored) throw new ProviderError(true, 'SOURCE_STORAGE_ERROR');
      reference = { bytes: new Uint8Array(await stored.arrayBuffer()), mime: source.mime_type };
    }
    const prompt = `${event.style_prompt}\nTheme: ${event.theme || board.title}\n${event.action === 'EDIT_ACTIVE' ? 'Edit the provided reference image, keeping the existing subject. Instruction: ' : 'Subject and composition: '}${event.prompt}`;
    await checkStorageAvailable(env);
    const image = await generateImage(env, prompt, reference);
    const stored = await putObject(env, objectKey(event), image.bytes, image.bytes.byteLength, { httpMetadata: { contentType: image.mime }, customMetadata: { eventId: id } });
    if (!stored) throw new Error('R2_WRITE_FAILED');
    await finishImage(env, event, stored);
    return 'done';
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'GENERATION_STORAGE_ERROR';
    const permanent = (error instanceof ProviderError && !error.retryable) || (error instanceof ApiError && !(error instanceof ProviderError) && error.status !== 503) || event.attempts >= 3;
    await sql(env, 'UPDATE events SET status=?,lease_until=0,error_code=?,updated_at=? WHERE id=?', permanent ? 'failed' : 'queued', code, now(), id).run();
    console.error(JSON.stringify({ type: 'generation_error', eventId: id, code, retry: !permanent }));
    if (!permanent) throw error;
    return 'done';
  }
}

export async function runAnalysis(env: Env, id: string): Promise<'done' | 'busy'> {
  const event = await sql(env, 'SELECT * FROM events WHERE id=?', id).first<StoredEvent>();
  if (!event || event.kind==='upload' || ['completed','failed','skipped'].includes(event.analysis_status)) return 'done';
  if (!terminal(event.status)) return 'busy';
  const claimed = await sql(env, `UPDATE events SET analysis_status='processing',analysis_lease_until=?,analysis_attempts=analysis_attempts+1
    WHERE id=? AND (analysis_status='pending' OR (analysis_status='processing' AND analysis_lease_until<?)) RETURNING *`, now() + 240_000, id, now()).first<StoredEvent>();
  if (!claimed) return 'busy';
  try {
    const result = await analyze(env, claimed);
    await sql(env, "UPDATE events SET analysis_status='completed',analysis_json=?,analysis_lease_until=0 WHERE id=?", JSON.stringify(result), id).run();
    return 'done';
  } catch (error) {
    const permanent = (error instanceof ProviderError && !error.retryable) || (error instanceof ApiError && !(error instanceof ProviderError)) || claimed.analysis_attempts >= 3;
    await sql(env, 'UPDATE events SET analysis_status=?,analysis_lease_until=0 WHERE id=?', permanent ? 'failed' : 'pending', id).run();
    if (!permanent) throw new Error('ANALYSIS_RETRY');
    return 'done';
  }
}

export async function processBatch(batch: MessageBatch<Job>, env: Env) {
  // One consumer processes up to six jobs in parallel. This gives a new queue
  // useful concurrency immediately instead of waiting for adaptive scaling.
  const process = async (message: Message<Job>) => {
    try {
      const job = message.body;
      const taskName = job.stage === 'maintenance' ? 'maintenance' : job.stage === 'backup' ? `backup:${job.backupId}` : `event:${job.eventId}`;
      const response = await env.TASKS.getByName(taskName).fetch('https://tasks.internal/internal/job', { method: 'POST', body: JSON.stringify(job) });
      if (!response.ok) throw new Error('TASK_FAILED');
      const { status } = await response.json() as {status:string};
      if (status === 'busy') { message.retry({ delaySeconds: 30 }); return; }
      if (job.stage === 'generation') {
        try { await env.JOBS.send({ stage: 'analysis', eventId: job.eventId }); } catch { /* recovered by cron */ }
      }
      message.ack();
    } catch { message.retry({ delaySeconds: 30 }); }
  };
  for (let offset = 0; offset < batch.messages.length; offset += 6)
    await Promise.all(batch.messages.slice(offset, offset + 6).map(process));
}

export async function recoverJobs(_controller: ScheduledController, env: Env) {
  const timestamp = now();
  const generation = await sql(env, `SELECT id FROM events WHERE kind='command' AND (
    (status='queued' AND (dispatched_at IS NULL OR dispatched_at<?)) OR (status='processing' AND lease_until<?)) LIMIT 4`, timestamp - 600_000, timestamp).all<{id:string}>();
  for (const row of generation.results) {
    await env.JOBS.send({ stage: 'generation', eventId: row.id });
    await sql(env, 'UPDATE events SET dispatched_at=? WHERE id=?', timestamp, row.id).run();
  }
  const analysis = await sql(env, `SELECT id FROM events WHERE status NOT IN ('queued','processing')
    AND (analysis_status='pending' OR (analysis_status='processing' AND analysis_lease_until<?)) LIMIT 4`, timestamp).all<{id:string}>();
  for (const row of analysis.results) await env.JOBS.send({ stage: 'analysis', eventId: row.id });
  const backups = await sql(env, "SELECT id FROM backups WHERE status IN ('queued','processing') AND lease_until<? LIMIT 1", timestamp).all<{id:string}>();
  for (const row of backups.results) await env.JOBS.send({ stage: 'backup', backupId: row.id });
  await env.DB.batch([sql(env, 'DELETE FROM sessions WHERE expires_at<?', timestamp), sql(env, 'DELETE FROM login_limits WHERE expires_at<?', timestamp)]);
  await expireBackups(env);
  await recoverUploads(env);
}
