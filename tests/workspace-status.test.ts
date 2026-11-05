import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { serve } from '../worker/index';
import { digest } from '../worker/auth';
import { workspace, workspaceStatus } from '../worker/data';
import type { Env } from '../worker/env';
import type { Student } from '../shared/contracts';
import { applyMigrations } from './migrations';

const mf = new Miniflare(convertV4MiniflareOptions({ modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-10-24',d1Databases:['DB'] }));
let db:D1Database;
let env:Env;
let serial=0;
let fixture:{student:Student;otherStudent:Student;classId:string;activityId:string;otherActivityId:string;deniedActivityId:string;boardId:string;otherBoardId:string;eventId:string;imageId:string;cookie:string;otherCookie:string;teacherCookie:string};
const origin='https://workspace-status.test';
const q=(query:string,...values:unknown[])=>db.prepare(query).bind(...values);

async function event(id:string,studentId:string,boardId:string,activityId:string,status='succeeded',analysis='completed') {
  const timestamp=Date.now();
  await q(`INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,kind,analysis_status,analysis_json)
    VALUES(?,?,?,?,?,'SYNTHETIC_TRANSCRIPT_KEEP_OUT_OF_STATUS','text','photo','사진','',?,'fixture','fixture','[]',?,?,'command',?,'{"private_analysis":"KEEP_OUT_OF_STATUS"}')`,id,studentId,boardId,activityId,crypto.randomUUID(),status,timestamp,timestamp,analysis).run();
}
async function status(){return workspaceStatus(env,fixture.student,fixture.activityId);}
async function endpoint(activityId=fixture.activityId,cookie=fixture.cookie) {
  return serve(new Request(`${origin}/api/workspace/status?activityId=${activityId}`,{headers:cookie?{Cookie:cookie}:{}}),env);
}
async function changed(mutate:()=>Promise<unknown>){const before=await status();await mutate();const after=await status();expect(after.revision).not.toBe(before.revision);return after;}

beforeAll(async()=>{db=await mf.getD1Database('DB') as unknown as D1Database;await applyMigrations(db);env={DB:db,ASSETS:{fetch:async()=>new Response('fixture')}} as unknown as Env;});
beforeEach(async()=>{
  const room=++serial;
  const student:Student={id:crypto.randomUUID(),grade:6,class_number:room,student_number:1,name:'합성 상태 검증',command_limit:10,quota_reset_at:0,enabled:1,current_board_id:null};
  const otherStudent:Student={...student,id:crypto.randomUUID(),student_number:2,name:'다른 합성 계정'};
  const classId=crypto.randomUUID(),deniedClass=crypto.randomUUID(),activityId=crypto.randomUUID(),otherActivityId=crypto.randomUUID(),deniedActivityId=crypto.randomUUID(),boardId=crypto.randomUUID(),otherBoardId=crypto.randomUUID(),otherStudentBoardId=crypto.randomUUID();
  const token='fixture-'+crypto.randomUUID(),otherToken='fixture-'+crypto.randomUUID(),teacherToken='fixture-'+crypto.randomUUID();
  await db.batch([
    q('INSERT INTO classes(id,name,grade,class_number) VALUES(?,?,6,?)',classId,'합성 클래스',room),
    q('INSERT INTO classes(id,name,grade,class_number) VALUES(?,?,6,49)',deniedClass,'배정되지 않은 클래스'),
    q('INSERT INTO class_rooms(class_id,grade,class_number) VALUES(?,6,?)',classId,room),
    q('INSERT INTO class_rooms(class_id,grade,class_number) VALUES(?,6,49)',deniedClass),
    ...[student,otherStudent].map(s=>q('INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,command_limit,quota_reset_at,created_at) VALUES(?,6,?,?,?,?,?,10,0,?)',s.id,room,s.student_number,s.name,'fixture-hash','fixture-salt',Date.now())),
    ...[[activityId,classId],[otherActivityId,classId],[deniedActivityId,deniedClass]].map(([id,parent])=>q('INSERT INTO activities(id,class_id,title,unit,instructions,opens_at,closes_at,command_limit,rubric_json,created_at) VALUES(?,?,\'합성 활동\',\'합성 단원\',\'\',?,?,10,\'[]\',?)',id,parent,Date.now()-10000,Date.now()+3600000,Date.now())),
    q('INSERT INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,\'합성 보드\',?)',boardId,student.id,activityId,Date.now()),
    q('INSERT INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,\'다른 활동 보드\',?)',otherBoardId,student.id,otherActivityId,Date.now()),
    q('INSERT INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,\'다른 계정 보드\',?)',otherStudentBoardId,otherStudent.id,activityId,Date.now()),
    q('INSERT INTO sessions(token_hash,student_id,role,expires_at) VALUES(?,?,\'student\',?)',await digest(token),student.id,Date.now()+3600000),
    q('INSERT INTO sessions(token_hash,student_id,role,expires_at) VALUES(?,?,\'student\',?)',await digest(otherToken),otherStudent.id,Date.now()+3600000),
    q('INSERT INTO sessions(token_hash,student_id,role,expires_at) VALUES(?,NULL,\'teacher\',?)',await digest(teacherToken),Date.now()+3600000),
  ]);
  const eventId=crypto.randomUUID(),imageId=crypto.randomUUID();await event(eventId,student.id,boardId,activityId);
  await q(`INSERT INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,on_board,created_at,preview_status)
    VALUES(?,?,?,?,?,'image/jpeg',240000,'SYNTHETIC_IMAGE_PROMPT_KEEP_OUT_OF_STATUS',1,?,'skipped')`,imageId,eventId,student.id,boardId,'fixture/'+imageId,Date.now()).run();
  fixture={student,otherStudent,classId,activityId,otherActivityId,deniedActivityId,boardId,otherBoardId,eventId,imageId,cookie:'classroom_session='+token,otherCookie:'classroom_session='+otherToken,teacherCookie:'classroom_session='+teacherToken};
});
afterAll(async()=>{await mf.dispose();});

it('읽기만 할 때 revision이 안정적이고 full workspace와 일치하며 status는 3개 쿼리와 작은 본문만 반환한다',async()=>{
  const first=await status();await new Promise(resolve=>setTimeout(resolve,10));const second=await status();
  expect(first.revision).toBe(second.revision);expect(second.hasPending).toBe(false);expect(second.serverTime).toBeGreaterThan(first.serverTime);
  const full=await workspace(env,fixture.student,fixture.activityId);expect(full.revision).toBe(first.revision);expect(full.hasPending).toBe(false);expect(full.used).toBe(1);expect(full.limit).toBe(10);
  const queries:string[]=[];const original=env;env={...env,DB:{prepare:(query:string)=>{queries.push(query);return db.prepare(query);}} as D1Database};
  try{
    const response=await endpoint();expect(response.status).toBe(200);const text=await response.text();expect(text.length).toBeLessThan(220);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['hasPending','revision','serverTime']);
    expect(text).not.toContain('KEEP_OUT_OF_STATUS');expect(text).not.toContain(fixture.student.name);expect(queries).toHaveLength(3);
    expect(queries.join('\n')).not.toMatch(/\btranscript\b|\banalysis_json\b|\bprompt\b/);
  }finally{env=original;}
});

it('generation의 상태·시각·시도 횟수와 analysis의 시각 없는 완료를 모두 감지한다',async()=>{
  await changed(()=>q('UPDATE events SET attempts=attempts+1 WHERE id=?',fixture.eventId).run());
  await changed(()=>q('UPDATE events SET status=\'processing\' WHERE id=?',fixture.eventId).run());expect((await status()).hasPending).toBe(true);
  await changed(()=>q('UPDATE events SET status=\'succeeded\',updated_at=updated_at+1 WHERE id=?',fixture.eventId).run());
  await changed(()=>q('UPDATE events SET analysis_status=\'processing\',analysis_attempts=analysis_attempts+1 WHERE id=?',fixture.eventId).run());expect((await status()).hasPending).toBe(true);
  const update=await q('SELECT updated_at FROM events WHERE id=?',fixture.eventId).first<{updated_at:number}>();
  await changed(()=>q('UPDATE events SET analysis_status=\'completed\' WHERE id=?',fixture.eventId).run());
  expect((await q('SELECT updated_at FROM events WHERE id=?',fixture.eventId).first<{updated_at:number}>())!.updated_at).toBe(update!.updated_at);expect((await status()).hasPending).toBe(false);
  await changed(()=>event(crypto.randomUUID(),fixture.student.id,fixture.boardId,fixture.activityId));
});

it('full 자료를 읽는 동안 변경되면 이전 revision을 반환하여 다음 status에서 재조회하게 한다',async()=>{
  const before=await status();let mutated=false;
  const original=env;
  const concurrentEnv={...env,DB:{prepare:(query:string)=>{
    const prepared=db.prepare(query);
    if(!query.startsWith('SELECT id,event_id,board_id,prompt'))return prepared;
    return {bind:(...bindings:unknown[])=>{
      const bound=prepared.bind(...bindings);
      return {all:async()=>{
        if(!mutated){mutated=true;await q('UPDATE events SET analysis_status=\'processing\' WHERE id=?',fixture.eventId).run();}
        return bound.all();
      }};
    }};
  }}} as unknown as Env;
  const full=await workspace(concurrentEnv,fixture.student,fixture.activityId);
  expect(mutated).toBe(true);expect(full.revision).toBe(before.revision);
  expect((await workspaceStatus(original,fixture.student,fixture.activityId)).revision).not.toBe(full.revision);
});

it('이미지 숨김·보관·복원·미리보기와 board 변경·이력·검토 메모를 감지한다',async()=>{
  await changed(()=>q('UPDATE images SET hidden_at=1,on_board=0 WHERE id=?',fixture.imageId).run());
  await changed(()=>q('UPDATE images SET hidden_at=NULL,on_board=1 WHERE id=?',fixture.imageId).run());
  await changed(()=>q('UPDATE boards SET active_image_id=?,title=\'새 합성 보드\' WHERE id=?',fixture.imageId,fixture.boardId).run());
  await changed(()=>q('UPDATE images SET preview_status=\'queued\',preview_updated_at=1 WHERE id=?',fixture.imageId).run());expect((await status()).hasPending).toBe(true);
  await changed(()=>q('UPDATE images SET preview_status=\'processing\',preview_updated_at=2 WHERE id=?',fixture.imageId).run());
  await changed(()=>q('UPDATE images SET preview_status=\'ready\',preview_object_key=\'fixture-preview\',preview_mime_type=\'image/jpeg\',preview_byte_size=12345,preview_updated_at=3 WHERE id=?',fixture.imageId).run());
  expect((await status()).hasPending).toBe(false);expect((await workspace(env,fixture.student,fixture.activityId)).images[0].previewUrl).toBe('/api/images/'+fixture.imageId+'?preview=1');
  await changed(()=>q('UPDATE images SET preview_status=\'pending\',preview_updated_at=4 WHERE id=?',fixture.imageId).run());expect((await status()).hasPending).toBe(false);
  await changed(()=>q('INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,action,created_at) VALUES(?,?,?,?,?,\'pin\',?)',crypto.randomUUID(),fixture.student.id,fixture.activityId,fixture.boardId,fixture.imageId,Date.now()).run());
  await changed(()=>q('INSERT INTO reviews(event_id,note,reviewed_at) VALUES(?,\'PRIVATE_REVIEW_KEEP_OUT_OF_STATUS\',1)',fixture.eventId).run());
  await changed(()=>q('UPDATE reviews SET reviewed_at=2 WHERE event_id=?',fixture.eventId).run());
});

it('동일 밀리초에 같은 길이의 검토 메모를 덮어써도 reviewed_at과 revision을 증가시킨다',async()=>{
  const timestamp=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(timestamp);
  const review=(note:string)=>serve(new Request(`${origin}/api/admin/events/${fixture.eventId}/review`,{
    method:'PUT',headers:{Origin:origin,Cookie:fixture.teacherCookie,'Content-Type':'application/json'},body:JSON.stringify({note}),
  }),env);
  try{
    expect((await review('same-size-a')).status).toBe(200);const first=await status();
    expect((await q('SELECT reviewed_at FROM reviews WHERE event_id=?',fixture.eventId).first<{reviewed_at:number}>())!.reviewed_at).toBe(timestamp);
    expect((await review('same-size-b')).status).toBe(200);expect((await status()).revision).not.toBe(first.revision);
    expect((await q('SELECT reviewed_at FROM reviews WHERE event_id=?',fixture.eventId).first<{reviewed_at:number}>())!.reviewed_at).toBe(timestamp+1);
    expect((await workspace(env,fixture.student,fixture.activityId)).events[0].review_note).toBe('same-size-b');
    const second=await status();clock.mockReturnValue(timestamp-100);
    expect((await review('same-size-c')).status).toBe(200);expect((await status()).revision).not.toBe(second.revision);
    expect((await q('SELECT reviewed_at FROM reviews WHERE event_id=?',fixture.eventId).first<{reviewed_at:number}>())!.reviewed_at).toBe(timestamp+2);
  }finally{clock.mockRestore();}
});

it('활동 시간·기준·안내·학급 이름·개별 한도와 초기화·학생 한도 변경을 감지한다',async()=>{
  await changed(()=>q('UPDATE activities SET command_limit=7,opens_at=opens_at+1,closes_at=closes_at+1,rubric_json=\'[{"id":"new"}]\',instructions=\'변경된 합성 안내\' WHERE id=?',fixture.activityId).run());
  await changed(()=>q('UPDATE classes SET name=\'변경된 합성 클래스\' WHERE id=?',fixture.classId).run());
  await changed(()=>q('INSERT INTO activity_students(activity_id,student_id,command_limit_override,quota_reset_at) VALUES(?,?,4,?)',fixture.activityId,fixture.student.id,Date.now()+1).run());
  const full=await workspace(env,fixture.student,fixture.activityId);expect(full.limit).toBe(4);expect(full.used).toBe(0);
  await changed(()=>q('UPDATE students SET command_limit=3,quota_reset_at=10 WHERE id=?',fixture.student.id).run());
  const fresh=await workspace(env,fixture.student,fixture.activityId);expect(fresh.student.command_limit).toBe(3);expect(fresh.student.quota_reset_at).toBe(10);
});

it('다른 활동의 본인 generation 대기와 현재 활동 analysis 대기를 반영하되 다른 학생 변경은 분리한다',async()=>{
  const before=await status();const otherBoard=await q('SELECT id FROM boards WHERE student_id=? AND activity_id=?',fixture.otherStudent.id,fixture.activityId).first<{id:string}>();
  await event(crypto.randomUUID(),fixture.otherStudent.id,otherBoard!.id,fixture.activityId,'queued','pending');expect((await status()).revision).toBe(before.revision);
  const otherEvent=crypto.randomUUID();await changed(()=>event(otherEvent,fixture.student.id,fixture.otherBoardId,fixture.otherActivityId,'queued','pending'));
  expect((await status()).hasPending).toBe(true);expect((await workspace(env,fixture.student,fixture.activityId)).pending?.id).toBe(otherEvent);
  await changed(()=>q('UPDATE events SET status=\'succeeded\' WHERE id=?',otherEvent).run());
  expect((await status()).hasPending).toBe(false);
});

it('로그인·학생 역할·현재 배정을 검사하고 권한 회수 및 삭제 후 status를 차단한다',async()=>{
  expect((await endpoint(fixture.activityId,'')).status).toBe(401);expect((await endpoint(fixture.activityId,fixture.teacherCookie)).status).toBe(403);
  expect((await endpoint(fixture.deniedActivityId)).status).toBe(404);expect((await endpoint('invalid-uuid')).status).toBe(400);
  const own=await (await endpoint()).json() as {revision:string};const other=await (await endpoint(fixture.activityId,fixture.otherCookie)).json() as {revision:string};expect(own.revision).not.toBe(other.revision);
  await q('INSERT INTO class_students(class_id,student_id,access) VALUES(?,?,0)',fixture.classId,fixture.student.id).run();expect((await endpoint()).status).toBe(404);
  await q('DELETE FROM class_students WHERE class_id=? AND student_id=?',fixture.classId,fixture.student.id).run();expect((await endpoint()).status).toBe(200);
  await q('UPDATE activities SET deleted_at=1 WHERE id=?',fixture.activityId).run();expect((await endpoint()).status).toBe(404);
  await q('UPDATE activities SET deleted_at=NULL WHERE id=?',fixture.activityId).run();await q('UPDATE students SET enabled=0 WHERE id=?',fixture.student.id).run();expect((await endpoint()).status).toBe(401);
});
