import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { encode as jpegEncode, decode as jpegDecode } from 'jpeg-js';
import { encode as pngEncode } from 'fast-png';
import { createPreview, queuePreview, runPreview } from '../worker/previews';
import { recordExistingObject, storageUsage } from '../worker/storage';
import type { Env, Job } from '../worker/env';
import { applyMigrations } from './migrations';
import { build } from 'esbuild';

function pixels(width:number,height:number,alpha=false) {
  const data=new Uint8Array(width*height*4);let value=0x1739a;
  for(let at=0;at<data.length;at+=4){value^=value<<13;value^=value>>>17;value^=value<<5;data[at]=value&255;data[at+1]=(value>>>8)&255;data[at+2]=(value>>>16)&255;data[at+3]=alpha&&at<width*4*8?0:255;}
  return {width,height,data};
}
const jpeg=()=>new Uint8Array(jpegEncode(pixels(1024,768),85).data);
const png=()=>pngEncode({...pixels(512,512,true),depth:8,channels:4});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it('JPEG 원본을 보존하면서 최대 512픽셀·96KiB 이내 미리보기를 만든다',()=>{
  const original=jpeg(),before=hash(original),preview=createPreview(original,'image/jpeg');
  expect(preview).not.toBeNull();expect(preview!.width).toBe(512);expect(preview!.height).toBe(384);
  expect(preview!.bytes.length).toBeLessThan(96*1024);expect(preview!.bytes.length).toBeLessThan(original.length/2);
  const decoded=jpegDecode(preview!.bytes,{useTArray:true});expect(decoded.width).toBe(512);expect(decoded.height).toBe(384);
  expect(hash(original)).toBe(before);
});

it('큰 PNG는 축소·압축하고 투명 부분을 흰 배경으로 합성한다',()=>{
  const original=png(),before=hash(original),preview=createPreview(original,'image/png');
  expect(preview).not.toBeNull();expect(preview!.bytes.length).toBeLessThan(96*1024);expect(preview!.bytes.length).toBeLessThan(original.length/3);
  const decoded=jpegDecode(preview!.bytes,{useTArray:true});expect(Math.max(decoded.width,decoded.height)).toBeLessThanOrEqual(512);
  expect(decoded.data[0]).toBeGreaterThan(245);expect(decoded.data[1]).toBeGreaterThan(245);expect(decoded.data[2]).toBeGreaterThan(245);
  expect(hash(original)).toBe(before);
});

function pngChunk(type:string,bytes:Uint8Array){
  const tag=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);
  let check=0xffffffff;for(const byte of Buffer.concat([tag,bytes])){check^=byte;for(let i=0;i<8;i++)check=(check>>>1)^((check&1)?0xedb88320:0);}crc.writeUInt32BE((check^0xffffffff)>>>0);
  return Buffer.concat([length,tag,bytes,crc]);
}
it('빈·잘린·과대 이미지와 지원하지 않는 형식은 원본 경로로 안전하게 돌아간다',()=>{
  expect(createPreview(new Uint8Array(),'image/jpeg')).toBeNull();expect(createPreview(new Uint8Array(4*1024*1024+1),'image/jpeg')).toBeNull();
  expect(createPreview(new Uint8Array([255,216,255]),'image/jpeg')).toBeNull();expect(createPreview(png(),'image/webp')).toBeNull();
  const large=png();new DataView(large.buffer,large.byteOffset,large.byteLength).setUint32(16,4096);new DataView(large.buffer,large.byteOffset,large.byteLength).setUint32(20,4096);
  expect(createPreview(large,'image/png')).toBeNull();
});
it('휴대전화 방향·위치 메타데이터가 있는 사진은 원본 표시를 유지한다',()=>{
  const original=jpeg(),metadata=Buffer.from('Exif\0\0synthetic-orientation-and-GPS-metadata'),length=Buffer.alloc(2);length.writeUInt16BE(metadata.length+2);
  const frame=Buffer.from(original).indexOf(Buffer.from([255,192]));expect(frame).toBeGreaterThan(0);
  const afterFrame=frame+2+Buffer.from(original).readUInt16BE(frame+2);
  for(const at of [2,afterFrame]){
    const exif=Buffer.concat([original.subarray(0,at),Buffer.from([255,225]),length,metadata,original.subarray(at)]),before=hash(exif);
    expect(createPreview(exif,'image/jpeg')).toBeNull();expect(hash(exif)).toBe(before);
  }
});
it('PNG IDAT 압축폭탄을 예상 픽셀 크기에서 차단하고 압축 부가정보는 읽지 않는다',()=>{
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  const bomb=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.alloc(16*1024*1024))),pngChunk('IEND',new Uint8Array())]);
  expect(createPreview(bomb,'image/png')).toBeNull();
  const original=png(),metadata=pngChunk('iCCP',Buffer.concat([Buffer.from('profile\0\0'),deflateSync(Buffer.alloc(16*1024*1024))]));
  const extended=Buffer.concat([original.subarray(0,33),metadata,original.subarray(33)]);
  expect(createPreview(extended,'image/png')).not.toBeNull();
  const oversizedPalette=Buffer.concat([original.subarray(0,33),pngChunk('PLTE',Buffer.alloc(771)),original.subarray(33)]);
  expect(createPreview(oversizedPalette,'image/png')).toBeNull();
});

const storage=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("preview fixture")}}',compatibilityDate:'2026-10-24',d1Databases:['DB'],r2Buckets:['IMAGES']}));
let env:Env;const sent:Job[]=[];const studentId=crypto.randomUUID(),classId=crypto.randomUUID(),activityId=crypto.randomUUID(),boardId=crypto.randomUUID();
beforeAll(async()=>{
  const DB=await storage.getD1Database('DB') as unknown as D1Database,IMAGES=await storage.getR2Bucket('IMAGES') as unknown as R2Bucket;
  await applyMigrations(DB);env={DB,IMAGES,JOBS:{send:async(job:Job)=>{sent.push(job);}} as unknown as Queue<Job>} as Env;
  await DB.batch([
    DB.prepare('INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,quota_reset_at,created_at) VALUES(?,12,49,1,?,?,?,0,?)').bind(studentId,'합성 미리보기','fixture-hash','fixture-salt',Date.now()),
    DB.prepare('INSERT INTO classes(id,name) VALUES(?,?)').bind(classId,'합성 클래스'),
    DB.prepare('INSERT INTO activities(id,class_id,title,unit,opens_at,closes_at,rubric_json,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(activityId,classId,'합성 활동','시험',0,Date.now()+3600000,'[]',Date.now()),
    DB.prepare('INSERT INTO boards(id,student_id,activity_id,created_at) VALUES(?,?,?,?)').bind(boardId,studentId,activityId,Date.now()),
  ]);
});
afterAll(async()=>{await storage.dispose();});
async function image(source=jpeg(),mime='image/jpeg'){
  const id=crypto.randomUUID(),key=`images/${studentId}/${id}`,timestamp=Date.now();
  await env.IMAGES.put(key,source,{httpMetadata:{contentType:mime}});await recordExistingObject(env,key,source.length);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,analysis_status,image_id) VALUES(?,?,?,?,?,'합성 원문','text','photo','합성','','succeeded','fixture','fixture','[]',?,?,'completed',?)`).bind(id,studentId,boardId,activityId,crypto.randomUUID(),timestamp,timestamp,id),
    env.DB.prepare('INSERT INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,id,studentId,boardId,key,mime,source.length,'합성 원문 보존',timestamp),
  ]);
  return {id,key,source};
}

it('미리보기는 별도 비공개 파일·용량 장부에 저장되고 원본·학습 기록을 바꾸지 않는다',async()=>{
  const original=await image(),before=await storageUsage(env);
  expect(await runPreview(env,original.id)).toBe('done');
  const row=await env.DB.prepare('SELECT * FROM images WHERE id=?').bind(original.id).first<any>();
  expect(row.preview_status).toBe('ready');expect(row.preview_object_key).toBe(`previews/${studentId}/${original.id}`);expect(row.object_key).toBe(original.key);
  const preview=await env.IMAGES.get(row.preview_object_key),source=await env.IMAGES.get(original.key);
  expect(hash(new Uint8Array(await source!.arrayBuffer()))).toBe(hash(original.source));
  const bytes=new Uint8Array(await preview!.arrayBuffer());expect(bytes.length).toBe(row.preview_byte_size);expect(jpegDecode(bytes).width).toBe(512);
  const after=await storageUsage(env);expect(after.bytes-before.bytes).toBe(bytes.length);expect(after.objects-before.objects).toBe(1);
  expect((await env.DB.prepare('SELECT status,analysis_status,transcript FROM events WHERE id=?').bind(original.id).first<any>())).toEqual({status:'succeeded',analysis_status:'completed',transcript:'합성 원문'});
  expect(await runPreview(env,original.id)).toBe('done');expect((await storageUsage(env)).bytes).toBe(after.bytes);
});

it('동시 예약은 메시지 하나만 보내고 큐 오류가 원본 성공 상태를 덮어쓰지 않는다',async()=>{
  const original=await image(),before=sent.length;
  await Promise.all([queuePreview(env,original.id),queuePreview(env,original.id)]);expect(sent.length-before).toBe(1);
  expect(sent.at(-1)).toEqual({stage:'preview',imageId:original.id});
  const second=await image();await queuePreview({...env,JOBS:{send:async()=>{throw new Error('fixture queue unavailable');}} as unknown as Queue<Job>},second.id);
  expect((await env.DB.prepare('SELECT preview_status FROM images WHERE id=?').bind(second.id).first<any>()).preview_status).toBe('pending');
  expect((await env.DB.prepare('SELECT status FROM events WHERE id=?').bind(second.id).first<any>()).status).toBe('succeeded');
});

it('지원하지 않는 원본은 보존하고 새 파일 없이 미리보기만 건너뛴다',async()=>{
  const original=await image(new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80]),'image/webp'),before=await storageUsage(env);
  expect(await runPreview(env,original.id)).toBe('done');
  expect((await env.DB.prepare('SELECT preview_status,preview_object_key FROM images WHERE id=?').bind(original.id).first<any>())).toEqual({preview_status:'skipped',preview_object_key:null});
  expect((await storageUsage(env)).bytes).toBe(before.bytes);expect(await env.IMAGES.head(original.key)).not.toBeNull();
});

it('R2 저장 응답 오류 뒤 재시도는 기존 미리보기를 연결해 중복 파일을 만들지 않는다',async()=>{
  const original=await image();let fail=true;
  const bucket={get:(key:string)=>env.IMAGES.get(key),head:(key:string)=>env.IMAGES.head(key),put:async(key:string,data:any,options:any)=>{const value=await env.IMAGES.put(key,data,options);if(fail){fail=false;throw new Error('fixture uncertain write');}return value;}} as unknown as R2Bucket;
  await expect(runPreview({...env,IMAGES:bucket},original.id)).rejects.toThrow('PREVIEW_RETRY');
  const before=await storageUsage(env);expect(await runPreview(env,original.id)).toBe('done');expect((await storageUsage(env)).bytes).toBe(before.bytes);
  const row=await env.DB.prepare('SELECT preview_status,preview_attempts FROM images WHERE id=?').bind(original.id).first<any>();expect(row).toEqual({preview_status:'ready',preview_attempts:2});
  expect(hash(new Uint8Array(await (await env.IMAGES.get(original.key))!.arrayBuffer()))).toBe(hash(original.source));
});

it('저장 상한에 도달하면 원본은 유지하고 미리보기만 생략한다',async()=>{
  const original=await image(),before=await storageUsage(env);
  expect(await runPreview({...env,MAX_STORAGE_BYTES:String(before.bytes)},original.id)).toBe('done');
  expect((await env.DB.prepare('SELECT preview_status FROM images WHERE id=?').bind(original.id).first<any>()).preview_status).toBe('skipped');
  expect((await storageUsage(env)).bytes).toBe(before.bytes);expect(await env.IMAGES.head(original.key)).not.toBeNull();
});

it('실제 workerd Durable Object에서도 JPEG와 제한된 PNG 코덱이 실행된다',async()=>{
  const bundle=await build({stdin:{contents:`import {createPreview} from './worker/previews';
    export class Codec { async fetch(request){const result=createPreview(new Uint8Array(await request.arrayBuffer()),request.headers.get('content-type'));return Response.json(result?{bytes:result.bytes.byteLength,width:result.width,height:result.height}:null);} }
    export default {fetch(request,env){return env.CODEC.get(env.CODEC.idFromName('synthetic')).fetch(request);}};`,resolveDir:process.cwd(),sourcefile:'preview-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*'],logLevel:'silent'});
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-24',compatibilityFlags:['nodejs_compat'],durableObjects:{CODEC:'Codec'}}));
  try {
    for(const [mime,bytes] of [['image/jpeg',jpeg()],['image/png',png()]] as const){
      const response=await runtime.dispatchFetch('https://synthetic.test/',{method:'POST',headers:{'Content-Type':mime},body:bytes});
      expect(response.status).toBe(200);const result=await response.json() as {bytes:number;width:number;height:number};
      expect(result).not.toBeNull();expect(result.bytes).toBeLessThanOrEqual(96*1024);expect(Math.max(result.width,result.height)).toBeLessThanOrEqual(512);
    }
  } finally {await runtime.dispose();}
});
