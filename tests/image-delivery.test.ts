import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/env';

const mf = new Miniflare(convertV4MiniflareOptions({ modules:true, script:'export default {fetch(){return new Response("fixture storage")}}', compatibilityDate:'2026-10-24', d1Databases:['DB'], r2Buckets:['IMAGES'] }));
const origin = 'https://image-fixture.test';
const originalId = '11111111-1111-4111-8111-111111111111';
const previewId = '22222222-2222-4222-8222-222222222222';
const missingId = '33333333-3333-4333-8333-333333333333';
const missingPreviewId = '44444444-4444-4444-8444-444444444444';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=','base64');
const preview = Buffer.concat([png,Buffer.from([0])]);
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
let db:D1Database, bucket:R2Bucket, env:Env;
let dbReads=0, r2Gets=0, r2Heads=0;
const forward = vi.fn(async (_request:Request) => new Response('delegated to DO'));
function request(id=originalId, token='owner-token', method='GET', headers:Record<string,string>={}, query='') {
  return worker.fetch(new Request(`${origin}/api/images/${id}${query}`, {method,headers:{...(token?{Cookie:`classroom_session=${token}`} : {}),...headers}}),env);
}
beforeAll(async () => {
  db=await mf.getD1Database('DB') as unknown as D1Database;
  bucket=await mf.getR2Bucket('IMAGES') as unknown as R2Bucket;
  await db.batch([
    db.prepare('CREATE TABLE students(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,student_id TEXT,role TEXT NOT NULL,expires_at INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE images(id TEXT PRIMARY KEY,student_id TEXT,object_key TEXT,mime_type TEXT,byte_size INTEGER,
      preview_object_key TEXT,preview_mime_type TEXT,preview_byte_size INTEGER,preview_status TEXT,hidden_at INTEGER)`),
  ]);
  await db.batch([
    db.prepare("INSERT INTO students VALUES('owner',1),('other',1),('disabled',0)"),
    ...[['owner-token','owner','student'],['other-token','other','student'],['disabled-token','disabled','student'],['teacher-token',null,'teacher'],['removed-token','owner','student']].map(([token,studentId,role])=>db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(hash(token!),studentId,role,Date.now()+3_600_000)),
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(hash('expired-token'),'owner','student',Date.now()-1),
    db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?)').bind(originalId,'owner','fixture/original','image/png',png.length,null,null,null,'pending',Date.now()),
    db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?)').bind(previewId,'owner','fixture/original','image/png',png.length,'fixture/preview','image/png',preview.length,'ready',null),
    db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?)').bind(missingId,'owner','fixture/missing','image/png',png.length,null,null,null,'pending',null),
    db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?)').bind(missingPreviewId,'owner','fixture/original','image/png',png.length,'fixture/missing-preview','image/png',preview.length,'ready',null),
  ]);
  await bucket.put('fixture/original',png,{httpMetadata:{contentType:'image/png'}});
  await bucket.put('fixture/preview',preview,{httpMetadata:{contentType:'image/png'}});
  env={
    DB:{prepare:(query:string)=>{dbReads++;return db.prepare(query);}} as D1Database,
    IMAGES:{get:(...args:Parameters<R2Bucket['get']>)=>{r2Gets++;return bucket.get(...args);},head:(key:string)=>{r2Heads++;return bucket.head(key);}} as R2Bucket,
    TASKS:{getByName:()=>({fetch:forward})} as unknown as DurableObjectNamespace,
  } as Env;
});
beforeEach(()=>{dbReads=0;r2Gets=0;r2Heads=0;forward.mockClear();});
afterAll(async()=>{await mf.dispose();});

it('원본 GET은 단일 인증·소유권 조회 후 R2에서 직접 전송하며 숨긴 이력도 보존한다',async()=>{
  const response=await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  expect(response.headers.get('Vary')).toBe('Cookie');
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Content-Length')).toBe(String(png.length));
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('ETag')).toMatch(/^".+"$/);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(dbReads).toBe(1);expect(r2Gets).toBe(1);expect(forward).not.toHaveBeenCalled();
});

it('인증된 재검증만 현재 R2 ETag로 304를 반환하고 본문을 다시 보내지 않는다',async()=>{
  const original=await request();const etag=original.headers.get('ETag')!;await original.arrayBuffer();
  const response=await request(originalId,'owner-token','GET',{'If-None-Match':etag});
  expect(response.status).toBe(304);expect(await response.text()).toBe('');
  expect(response.headers.get('ETag')).toBe(etag);
  expect(response.headers.get('Content-Length')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
});

it('ETag를 알아도 무인증·만료·비활성·다른 학생의 요청은 R2와 304에 도달하지 않는다',async()=>{
  for(const [token,status] of [['',401],['unknown-token',401],['expired-token',401],['disabled-token',401],['other-token',404]] as const){
    const response=await request(originalId,token,'GET',{'If-None-Match':'*'});
    expect(response.status).toBe(status);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('ETag')).toBeNull();await response.arrayBuffer();
  }
  expect(r2Gets).toBe(0);expect(r2Heads).toBe(0);expect(forward).not.toHaveBeenCalled();
});

it('잘못된 재검증 헤더는 저장 장애로 표시하지 않고 인증 후 전체 파일을 반환한다',async()=>{
  for(const validator of ['null','unquoted-etag']){
    const response=await request(originalId,'owner-token','GET',{'If-None-Match':validator});
    expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  }
});

it('삭제된 세션과 존재하지 않는 이미지도 재검증으로 우회할 수 없다',async()=>{
  await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash('removed-token')).run();
  expect((await request(originalId,'removed-token','GET',{'If-None-Match':'*'})).status).toBe(401);
  expect((await request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).status).toBe(404);
  expect(r2Gets).toBe(0);
});

it('HEAD는 인증 후 메타데이터만 읽으며 조건이 맞으면 본문 없는 304를 반환한다',async()=>{
  const response=await request(originalId,'owner-token','HEAD');
  expect(response.status).toBe(200);expect(await response.text()).toBe('');
  expect(response.headers.get('Content-Length')).toBe(String(png.length));
  const etag=response.headers.get('ETag')!;
  const cached=await request(originalId,'owner-token','HEAD',{'If-None-Match':`"old", W/${etag}`});
  expect(cached.status).toBe(304);expect(await cached.text()).toBe('');
  expect((await request(originalId,'','HEAD',{'If-None-Match':etag})).status).toBe(401);
  expect(r2Heads).toBe(2);expect(r2Gets).toBe(0);expect(forward).not.toHaveBeenCalled();
});

it('교사는 보존된 원본에 접근하고 미리보기는 원본과 독립된 ETag를 사용한다',async()=>{
  const original=await request(previewId,'teacher-token');const etag=original.headers.get('ETag')!;
  expect(original.status).toBe(200);expect(Buffer.from(await original.arrayBuffer())).toEqual(png);
  const thumbnail=await request(previewId,'owner-token','GET',{'If-None-Match':etag},'?preview=1');
  expect(thumbnail.status).toBe(200);expect(thumbnail.headers.get('ETag')).not.toBe(etag);
  expect(thumbnail.headers.get('Content-Length')).toBe(String(preview.length));
  expect(Buffer.from(await thumbnail.arrayBuffer())).toEqual(preview);
  expect((await request(previewId,'other-token','GET',{'If-None-Match':'*'},'?preview=1')).status).toBe(404);
});

it('미리보기 파일이 없어도 원본으로 되돌아가며 원본 누락 오류는 저장하지 않는다',async()=>{
  const fallback=await request(missingPreviewId,'owner-token','GET',{},'?preview=1');
  expect(fallback.status).toBe(200);expect(Buffer.from(await fallback.arrayBuffer())).toEqual(png);
  const unavailable=await request(missingId);
  expect(unavailable.status).toBe(503);expect(unavailable.headers.get('Cache-Control')).toBe('private, no-store');
  expect(unavailable.headers.get('ETag')).toBeNull();await unavailable.arrayBuffer();
});

it('로그인과 이미지 변경 등 다른 API는 기존 DO 경로를 유지한다',async()=>{
  await worker.fetch(new Request(origin+'/api/login',{method:'POST'}),env);
  await request(originalId,'owner-token','DELETE');
  expect(forward).toHaveBeenCalledTimes(2);expect(dbReads).toBe(0);expect(r2Gets).toBe(0);
});
