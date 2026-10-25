import { z } from 'zod';
import type { Activity, Board, Student } from '../shared/contracts';
import { allowedActivity } from './data';
import { ApiError, assert, json, now, sql, type Env } from './env';

const MAX_UPLOAD = 4 * 1024 * 1024;
export async function readUpload(request: Request) {
  assert(['image/jpeg','image/png','image/webp'].includes(request.headers.get('Content-Type') || ''), 415, 'IMAGE_TYPE', 'JPEG·PNG·WebP 이미지만 업로드할 수 있습니다.');
  assert(Number(request.headers.get('Content-Length') || 0) <= MAX_UPLOAD, 413, 'IMAGE_TOO_LARGE', '이미지는 4MB 이하여야 합니다.');
  const chunks: Uint8Array[] = []; let length = 0;
  const reader = request.body?.getReader();
  assert(reader, 400, 'IMAGE_EMPTY', '이미지 파일을 선택해 주세요.');
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_UPLOAD) {await reader.cancel();throw new ApiError(413,'IMAGE_TOO_LARGE','이미지는 4MB 이하여야 합니다.');}
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) {bytes.set(part,offset);offset+=part.length;}
  const dimensions = imageDimensions(bytes);
  assert(dimensions && dimensions.width > 0 && dimensions.height > 0 && dimensions.width <= 4096 && dimensions.height <= 4096, 400, 'IMAGE_INVALID', '4096픽셀 이하의 올바른 JPEG·PNG·WebP 파일을 선택해 주세요.');
  assert(dimensions.mime === request.headers.get('Content-Type'), 400, 'IMAGE_TYPE_MISMATCH', '파일의 실제 형식과 전송 형식이 다릅니다.');
  return {bytes,...dimensions};
}
function imageDimensions(bytes: Uint8Array): {width:number;height:number;mime:string}|null {
  const data = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (bytes.length >= 33 && bytes.slice(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i]) && data.getUint32(8) === 13 && data.getUint32(12) === 0x49484452) return {width:data.getUint32(16),height:data.getUint32(20),mime:'image/png'};
  if(bytes.length>=26 && data.getUint32(0)===0x52494646 && data.getUint32(4,true)+8===bytes.length && data.getUint32(8)===0x57454250){
    const kind=data.getUint32(12);const bits=(offset:number)=>bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16);
    if(kind===0x56503858&&bytes.length>=30)return {width:bits(24)+1,height:bits(27)+1,mime:'image/webp'};
    if(kind===0x56503820 && bytes.length>=30 && bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a)return {width:data.getUint16(26,true)&0x3fff,height:data.getUint16(28,true)&0x3fff,mime:'image/webp'};
    if(kind===0x5650384c && bytes[20]===0x2f){const bits=data.getUint32(21,true);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1,mime:'image/webp'};}
    return null;
  }
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at++] !== 255) return null;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const size = data.getUint16(at);
    if (size < 2 || at + size > bytes.length) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 8) return {width:data.getUint16(at+5),height:data.getUint16(at+3),mime:'image/jpeg'};
    at += size;
  }
  return null;
}
type UploadEvent = {id:string;student_id:string;activity_id:string;board_id:string;transcript:string;status:string;attempts:number};
const key = (event: UploadEvent) => `images/${event.student_id}/${event.id}`;
async function finishUpload(env: Env, event: UploadEvent, object: R2Object) {
  await env.DB.batch([
    sql(env, `INSERT OR IGNORE INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,origin,created_at) VALUES(?,?,?,?,?,?,?,?,'upload',?)`,event.id,event.id,event.student_id,event.board_id,key(event),object.httpMetadata?.contentType||'image/jpeg',object.size,'학생이 업로드한 참고 이미지',now()),
    sql(env, 'UPDATE boards SET active_image_id=? WHERE id=?',event.id,event.board_id),
    sql(env, "UPDATE events SET status='succeeded',image_id=?,lease_until=0,error_code=NULL,updated_at=? WHERE id=?",event.id,now(),event.id),
    sql(env, `INSERT OR IGNORE INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,'upload',?,?)`,'uploaded-'+event.id,event.student_id,event.activity_id,event.board_id,event.id,event.id,JSON.stringify({filename:event.transcript.replace('[이미지 업로드] ',''),bytes:object.size,sha256:object.customMetadata?.sha256||null}),now()),
  ]);
}
export async function uploadImage(request: Request, env: Env, student: Student, activityId: string) {
  const requestId = z.string().uuid().parse(request.headers.get('X-Upload-ID'));
  let event = await sql(env, "SELECT * FROM events WHERE student_id=? AND request_id=? AND kind='upload'",student.id,requestId).first<UploadEvent>();
  assert(!event || event.activity_id === activityId, 409, 'REQUEST_REUSED', '다른 요청 번호를 사용해 주세요.');
  const activity = await allowedActivity(env,student,activityId,true);
  if (event?.status === 'succeeded') return json({eventId:event.id,imageId:event.id},200);
  assert(!event || event.status === 'failed',409,'UPLOAD_BUSY','이미지를 저장하고 있습니다. 잠시 후 기록을 확인해 주세요.');
  const board = await sql(env, 'SELECT * FROM boards WHERE student_id=? AND activity_id=?',student.id,activity.id).first<Board>();
  assert(board,400,'JOIN_REQUIRED','활동을 먼저 선택해 주세요.');
  let filename = '업로드 이미지';
  try {filename = decodeURIComponent(request.headers.get('X-File-Name') || filename).replace(/[\x00-\x1f\x7f]/g,'').slice(0,120);} catch {throw new ApiError(400,'INVALID_FILENAME','파일 이름을 확인해 주세요.');}
  if (!event) {
    const count=await sql(env,"SELECT COUNT(*) n FROM events WHERE student_id=? AND activity_id=? AND kind='upload'",student.id,activity.id).first<{n:number}>();
    assert((count?.n||0)<50,409,'UPLOAD_LIMIT','활동의 업로드 한도 50장에 도달했습니다.');
    const id = crypto.randomUUID(); const timestamp = now();
    const result = await sql(env, `INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,kind,analysis_status,attempts,lease_until)
      SELECT ?,?,?,?,?,?,'text','upload','업로드','','processing','user-upload','user-upload',?,?,?,'upload','skipped',1,?
      WHERE NOT EXISTS(SELECT 1 FROM events WHERE student_id=? AND status IN ('queued','processing'))
      AND (SELECT COUNT(*) FROM events WHERE student_id=? AND activity_id=? AND kind='upload')<50
      AND (SELECT COUNT(*) FROM events WHERE kind='upload' AND status='processing')<4`,id,student.id,board.id,activity.id,requestId,'[이미지 업로드] '+filename,activity.rubric_json,timestamp,timestamp,timestamp+120000,student.id,student.id,activity.id).run();
    assert(result.meta.changes===1,429,'UPLOAD_BUSY','다른 이미지 저장이 끝날 때까지 잠시 기다려 주세요.');
    event = {id,student_id:student.id,activity_id:activity.id,board_id:board.id,transcript:'[이미지 업로드] '+filename,status:'processing',attempts:1};
  } else {
    assert(event.attempts < 3,409,'UPLOAD_RETRY_LIMIT','업로드를 다시 선택해 주세요.');
    const result = await sql(env, `UPDATE events SET status='processing',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='failed'
      AND NOT EXISTS(SELECT 1 FROM events WHERE student_id=? AND status IN ('queued','processing'))
      AND (SELECT COUNT(*) FROM events WHERE kind='upload' AND status='processing')<4`,now()+120000,now(),event.id,student.id).run();
    assert(result.meta.changes===1,429,'UPLOAD_BUSY','다른 이미지 저장이 끝날 때까지 잠시 기다려 주세요.');
  }
  try {
    let object = await env.IMAGES.head(key(event));
    if (!object) {
      const source = await readUpload(request);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',source.bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      object = await env.IMAGES.put(key(event),source.bytes,{httpMetadata:{contentType:source.mime},customMetadata:{eventId:event.id,sha256:hash}});
    }
    assert(object,503,'UPLOAD_STORAGE_ERROR','이미지 저장을 완료하지 못했습니다.');
    await finishUpload(env,event,object);
    return json({eventId:event.id,imageId:event.id},201);
  } catch(error) {
    await sql(env,"UPDATE events SET status='failed',lease_until=0,error_code=?,updated_at=? WHERE id=?",error instanceof ApiError?error.code:'UPLOAD_STORAGE_ERROR',now(),event.id).run();
    if(error instanceof ApiError)throw error;
    throw new ApiError(503,'UPLOAD_STORAGE_ERROR','업로드 기록은 남아 있습니다. 같은 파일로 다시 시도해 주세요.');
  }
}
export async function recoverUploads(env: Env) {
  const rows = await sql(env,"SELECT * FROM events WHERE kind='upload' AND status='processing' AND lease_until<? LIMIT 30",now()).all<UploadEvent>();
  for (const event of rows.results) {
    const object = await env.IMAGES.head(key(event));
    if (object) await finishUpload(env,event,object);
    else await sql(env,"UPDATE events SET status='failed',error_code='UPLOAD_INTERRUPTED',lease_until=0,updated_at=? WHERE id=? AND status='processing'",now(),event.id).run();
  }
}
export async function imageAction(env: Env, student: Student, id: string, action: 'pin'|'hide'|'activate') {
  const image = await sql(env, `SELECT i.*,b.activity_id FROM images i JOIN boards b ON b.id=i.board_id WHERE i.id=? AND i.student_id=?`,id,student.id).first<{board_id:string;activity_id:string;on_board:number;hidden_at:number|null}>();
  assert(image,404,'IMAGE_NOT_FOUND','이미지를 찾을 수 없습니다.');
  await allowedActivity(env,student,image.activity_id,true);
  assert(!await sql(env,"SELECT id FROM events WHERE student_id=? AND status IN ('queued','processing')",student.id).first(),409,'BUSY','이미지 처리가 끝난 뒤 변경해 주세요.');
  const timestamp=now();
  await env.DB.batch([
    sql(env, 'UPDATE images SET on_board=?,hidden_at=? WHERE id=?',action==='pin'?1:action==='hide'?0:image.on_board,action==='hide'?timestamp:null,id),
    action==='activate' ? sql(env,'UPDATE boards SET active_image_id=? WHERE id=?',id,image.board_id) : sql(env,'UPDATE boards SET active_image_id=NULL WHERE id=? AND active_image_id=?',image.board_id,id),
    sql(env, 'INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)',crypto.randomUUID(),student.id,image.activity_id,image.board_id,id,action,JSON.stringify({previousOnBoard:image.on_board,previousHiddenAt:image.hidden_at}),timestamp),
  ]);
  return json({ok:true});
}
