import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { serve } from '../worker/index';
import { digest } from '../worker/auth';
import { ANALYSIS_VERSION, DEFAULT_RUBRIC } from '../shared/contracts';
import type { Env } from '../worker/env';
import { applyMigrations } from './migrations';

const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-10-24',d1Databases:['DB']}));
let db:D1Database,env:Env,room=0;
let f:{activity:string;classId:string;student:string;otherStudent:string;board:string;otherBoard:string;teacherCookie:string;studentCookie:string;otherCookie:string;prefix:string};
const origin='https://analytics.test';
const q=(query:string,...bindings:unknown[])=>db.prepare(query).bind(...bindings);
async function call(route:string,cookie=f.teacherCookie,method='GET',data?:unknown){return serve(new Request(origin+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env);}
async function json(route:string,cookie=f.teacherCookie){const response=await call(route,cookie);expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<any>;}
const summary=(studentId='')=>json('/api/admin/analytics?activityId='+f.activity+(studentId?'&studentId='+studentId:''));
function analysis(scores=[1,2,3,4],options:{version?:string;rubric?:typeof DEFAULT_RUBRIC;needsReview?:boolean;keywords?:{word:string;count:number}[];score?:number|null}={}){
  return {version:options.version||ANALYSIS_VERSION,rubric:options.rubric||DEFAULT_RUBRIC,score:options.score===undefined?Math.round(scores.reduce((a,b)=>a+b,0)/16*100):options.score,
    semantic:{needsReview:options.needsReview||false,rubricScores:DEFAULT_RUBRIC.map((r,i)=>({id:r.id,score:scores[i],reason:'합성 근거',evidence:[{quote:'고양이',explanation:'합성 설명'}]}))},
    language:{keywords:options.keywords||[{word:'고양이',count:1}]}};
}
async function addEvent(suffix:string,options:{student?:string;board?:string;created?:number;kind?:'command'|'upload';analysis?:unknown;analysisStatus?:string;status?:string;image?:boolean}={}){
  const id=f.prefix+'-'+suffix,student=options.student||f.student,board=options.board||f.board,created=options.created||Date.now();
  await q(`INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,kind,analysis_status,analysis_json,image_id)
    VALUES(?,?,?,?,?,'PRIVATE_TRANSCRIPT_KEEP_OUT 고양이와 배','text','photo','사진','PRIVATE_STYLE_KEEP_OUT',?,'fixture','fixture',?,?,?,?,?,?,?)`,
    id,student,board,f.activity,id,options.status||'succeeded',JSON.stringify(DEFAULT_RUBRIC),created,created,options.kind||'command',options.analysisStatus||(options.analysis?'completed':'skipped'),options.analysis?JSON.stringify(options.analysis):null,options.image?id:null).run();
  if(options.image)await q(`INSERT INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,created_at) VALUES(?,?,?,?,?,'image/jpeg',12000,'PRIVATE_IMAGE_PROMPT_KEEP_OUT',?)`,id,id,student,board,'fixture/'+id,created).run();
  return id;
}
async function addAction(imageId:string,suffix:string,options:{student?:string;board?:string;created?:number}={}){
  const id=f.prefix+'-'+suffix;await q(`INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,'pin','{}',?)`,id,options.student||f.student,f.activity,options.board||f.board,imageId,options.created||Date.now()).run();return id;
}
beforeAll(async()=>{db=await mf.getD1Database('DB') as unknown as D1Database;await applyMigrations(db);env={DB:db,ASSETS:{fetch:async()=>new Response('fixture')}} as unknown as Env;});
beforeEach(async()=>{
  const n=++room,student=crypto.randomUUID(),otherStudent=crypto.randomUUID(),classId=crypto.randomUUID(),activity=crypto.randomUUID(),board=crypto.randomUUID(),otherBoard=crypto.randomUUID();
  const teacher='fixture-teacher-'+crypto.randomUUID(),token='fixture-student-'+crypto.randomUUID(),other='fixture-student-'+crypto.randomUUID();
  await db.batch([
    q('INSERT INTO classes(id,name,grade,class_number) VALUES(?,\'합성 클래스\',7,?)',classId,n),q('INSERT INTO class_rooms(class_id,grade,class_number) VALUES(?,7,?)',classId,n),
    ...[[student,1],[otherStudent,2]].map(([id,number])=>q('INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,quota_reset_at,created_at) VALUES(?,7,?,?,\'합성 학생\',\'fixture\',\'fixture\',0,?)',id,n,number,Date.now())),
    q('INSERT INTO activities(id,class_id,title,unit,opens_at,closes_at,command_limit,rubric_json,created_at) VALUES(?,?,\'합성 활동\',\'단원\',?,?,10,?,?)',activity,classId,Date.now()-10000,Date.now()+3600000,JSON.stringify(DEFAULT_RUBRIC),Date.now()),
    ...[[board,student],[otherBoard,otherStudent]].map(([id,sid])=>q('INSERT INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,\'합성 보드\',?)',id,sid,activity,Date.now())),
    q('INSERT INTO sessions(token_hash,role,expires_at) VALUES(?,\'teacher\',?)',await digest(teacher),Date.now()+3600000),
    q('INSERT INTO sessions(token_hash,student_id,role,expires_at) VALUES(?,?,\'student\',?)',await digest(token),student,Date.now()+3600000),
    q('INSERT INTO sessions(token_hash,student_id,role,expires_at) VALUES(?,?,\'student\',?)',await digest(other),otherStudent,Date.now()+3600000),
  ]);
  f={activity,classId,student,otherStudent,board,otherBoard,teacherCookie:'classroom_session='+teacher,studentCookie:'classroom_session='+token,otherCookie:'classroom_session='+other,prefix:crypto.randomUUID()};
});
afterAll(async()=>{await mf.dispose();});

it('요약은 현재 기준 점수·이전 분석·검토 후 집계·학생 필터를 보존하고 원문과 분석 본문을 전송하지 않는다',async()=>{
  const first=await addEvent('current',{analysis:analysis([1,2,3,4],{needsReview:true,keywords:[{word:'고양이',count:2}]}),image:true,created:100});
  const second=await addEvent('other-current',{student:f.otherStudent,board:f.otherBoard,analysis:analysis([4,4,4,4],{needsReview:true}),image:true,created:101});
  const legacy:any=analysis([0,0,0,0],{version:'legacy',needsReview:true});delete legacy.language;legacy.morphology={keywords:[{word:'고양이',count:3}]};
  await addEvent('legacy',{analysis:legacy,created:102});
  await addEvent('changed-rubric',{analysis:analysis([4,4,4,4],{rubric:DEFAULT_RUBRIC.map(r=>({...r,label:r.label+' 변경'})),keywords:[{word:'배',count:4}]}),created:103});
  await addEvent('pending',{analysisStatus:'pending',created:104});await addEvent('failed',{analysisStatus:'failed',created:105});
  await addEvent('upload',{kind:'upload',image:true,created:106});await q('INSERT INTO reviews(event_id,note,reviewed_at) VALUES(?,\'검토 완료\',1)',second).run();await addAction(first,'action');
  const result=await summary();
  expect(result.events).toBeUndefined();expect(result.imageActions).toBeUndefined();expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TRANSCRIPT|PRIVATE_STYLE|PRIVATE_IMAGE_PROMPT|analysis_json|rubricScores|합성 근거/);
  expect(result.stats).toMatchObject({recordCount:7,eventsCount:6,participantCount:2,imageCount:3,imageActionCount:1,analysisCount:4,comparableCount:2,scoredCount:2,previousCount:2,average:82,reviewCount:2});
  expect(result.criteria.subject).toEqual({sum:5,sampleCount:2,average:2.5,evidenceCount:2});expect(result.keywords).toEqual([{word:'고양이',count:6},{word:'배',count:4}]);expect(result.trend.map((t:any)=>t.score)).toEqual([63,100]);expect(result.hasPending).toBe(true);
  expect(result.students.find((s:any)=>s.id===f.student)).toMatchObject({used:5,imageCount:2,scoreAverage:63,scoredCount:1,needsReviewCount:2,assigned:1});
  const filtered=await summary(f.student);expect(filtered.stats).toMatchObject({recordCount:6,eventsCount:5,participantCount:1,scoredCount:1,average:63,reviewCount:2});expect(filtered.students).toHaveLength(2);expect(filtered.criteria.subject.average).toBe(1);
  await q('INSERT INTO class_students(class_id,student_id,access) VALUES(?,?,0)',f.classId,f.student).run();const removed=await summary();expect(removed.students.find((s:any)=>s.id===f.student).assigned).toBe(0);expect(removed.stats.recordCount).toBe(7);
});

it('최근 학생 기록은 DESC 커서로 중복 없이 페이지를 읽고 최소 필드만 반환하며 전체 ASC 내보내기는 보존한다',async()=>{
  const ids=[];for(let i=0;i<5;i++)ids.push(await addEvent('record-'+i,{analysis:analysis(),created:1000}));await addEvent('foreign',{student:f.otherStudent,board:f.otherBoard,analysis:analysis(),created:2000});
  let next:any=null;const got:string[]=[];
  do{const page=await json(`/api/activities/${f.activity}/records?view=recent&limit=2`+(next?'&'+new URLSearchParams({beforeTime:String(next.beforeTime),beforeId:next.beforeId}):''),f.studentCookie);got.push(...page.rows.map((r:any)=>r.id));expect(page.rows.length).toBeLessThanOrEqual(2);expect(Object.keys(page.rows[0]).sort()).toEqual(['activity_id','created_at','id','image_id','input_method','kind','status','student_id','transcript']);next=page.next;}while(next);
  expect(got).toEqual(ids.sort().reverse());expect(new Set(got).size).toBe(5);
  const exported=await json(`/api/activities/${f.activity}/records`,f.studentCookie);expect(exported.rows).toHaveLength(5);expect(exported.rows[0].analysis_json).toBeTruthy();expect(exported.rows[0].rubric_json).toBeTruthy();
  const filtered=await json(`/api/admin/activities/${f.activity}/records?studentId=${f.otherStudent}&limit=1`);expect(filtered.rows).toHaveLength(1);expect(filtered.rows[0].student_id).toBe(f.otherStudent);expect(filtered.rows[0].analysis_json).toBeTruthy();
});

it('교사·학생 이미지 변경 이력은 해당 범위와 동일시각 cursor 경계를 지킨다',async()=>{
  const one=await addEvent('image',{image:true}),two=await addEvent('foreign-image',{student:f.otherStudent,board:f.otherBoard,image:true});
  const ids=[];for(let i=0;i<4;i++)ids.push(await addAction(one,'action-'+i,{created:1000}));await addAction(two,'foreign-action',{student:f.otherStudent,board:f.otherBoard,created:2000});
  const page=await json(`/api/activities/${f.activity}/image-actions?view=recent&limit=2`,f.studentCookie);expect(page.rows.map((r:any)=>r.id)).toEqual(ids.sort().reverse().slice(0,2));
  const second=await json(`/api/admin/activities/${f.activity}/image-actions?studentId=${f.student}&limit=2&beforeTime=${page.next.beforeTime}&beforeId=${page.next.beforeId}`);expect(second.rows.map((r:any)=>r.id)).toEqual(ids.sort().reverse().slice(2));expect(second.next).toBeNull();
  expect((await json(`/api/activities/${f.activity}/image-actions`,f.studentCookie)).rows).toHaveLength(4);
});

it('점수 근거는 선택 기준·학생별 최근 페이지만 반환하고 전체 합계·평균은 유지한다',async()=>{
  const one=await addEvent('score-a',{analysis:analysis([1,2,3,4]),created:1000});const two=await addEvent('score-b',{analysis:analysis([3,2,3,4]),created:1001});
  await addEvent('score-old',{analysis:analysis([4,4,4,4],{version:'old'}),created:1002});
  const page=await json(`/api/admin/activities/${f.activity}/score-evidence?criterionId=subject&limit=1`);expect(page).toMatchObject({total:2,sum:4,average:2});expect(page.rows[0]).toMatchObject({id:two,studentId:f.student,score:3,reason:'합성 근거',evidence:[{quote:'고양이',explanation:'합성 설명'}]});
  expect(JSON.stringify(page)).not.toContain('analysis_json');
  const next=await json(`/api/admin/activities/${f.activity}/score-evidence?criterionId=subject&limit=1&beforeTime=${page.next.beforeTime}&beforeId=${page.next.beforeId}`);expect(next.rows[0].id).toBe(one);expect(next.next).toBeNull();expect(next.total).toBe(2);
  expect((await call(`/api/admin/activities/${f.activity}/score-evidence?criterionId=unknown`)).status).toBe(404);
});

it('10000건을 넘는 활동도 요약 전체 수와 최신 기록·점수 근거를 빠뜨리지 않는다',async()=>{
  const total=10005,doc=JSON.stringify(analysis([4,4,4,4]));
  await q(`WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,kind,analysis_status,analysis_json)
    SELECT ?||printf('-%05d',n),?,?,?,?||printf('-request-%05d',n),'PRIVATE_BULK_TRANSCRIPT_KEEP_OUT','text','photo','사진','','ignored','fixture','fixture','[]',n,n,'command',CASE WHEN n=? THEN 'completed' ELSE 'skipped' END,CASE WHEN n=? THEN ? ELSE NULL END FROM seq`,total,f.prefix,f.student,f.board,f.activity,f.prefix,total,total,doc).run();
  const result=await summary();expect(result.stats).toMatchObject({recordCount:total,eventsCount:total,scoredCount:1,average:100});expect(JSON.stringify(result)).not.toContain('PRIVATE_BULK');
  const page=await json(`/api/admin/activities/${f.activity}/records?limit=2`);expect(page.rows[0].id).toBe(f.prefix+'-10005');expect(page.rows).toHaveLength(2);expect(page.next).not.toBeNull();
  const evidence=await json(`/api/admin/activities/${f.activity}/score-evidence?criterionId=subject`);expect(evidence.total).toBe(1);expect(evidence.rows[0].id).toBe(f.prefix+'-10005');
});

it('빈 표본·null 점수를 0점으로 만들지 않고 요약 revision은 검토 수정·권한 변경을 감지한다',async()=>{
  const empty=await summary();expect(empty.stats.average).toBeNull();expect(empty.criteria.subject.average).toBeNull();expect((await summary()).revision).toBe(empty.revision);
  await q('UPDATE activities SET rubric_json=\'[]\' WHERE id=?',f.activity).run();const id=await addEvent('null-score',{analysis:analysis([0,0,0,0],{rubric:[],score:null,needsReview:true})});
  const before=await summary();expect(before.stats).toMatchObject({analysisCount:1,comparableCount:1,scoredCount:0,average:null,reviewCount:1});expect(before.criteria).toEqual({});
  expect((await call(`/api/admin/events/${id}/review`,f.teacherCookie,'PUT',{note:'same-size-a'})).status).toBe(200);const reviewed=await summary();expect(reviewed.stats.reviewCount).toBe(0);expect(reviewed.revision).not.toBe(before.revision);
  expect((await call(`/api/admin/events/${id}/review`,f.teacherCookie,'PUT',{note:'same-size-b'})).status).toBe(200);expect((await summary()).revision).not.toBe(reviewed.revision);
});

it('최근 조회의 권한·인자 검사를 지키고 학생은 교사 상세·근거 API를 사용할 수 없다',async()=>{
  const own=`/api/activities/${f.activity}/records?view=recent`;
  expect((await call(own,'')).status).toBe(401);expect((await call(`/api/admin/activities/${f.activity}/records`,f.studentCookie)).status).toBe(403);expect((await call(`/api/admin/activities/${f.activity}/score-evidence?criterionId=subject`,f.studentCookie)).status).toBe(403);
  for(const query of ['limit=101','limit=0','beforeTime=1','beforeId=x','beforeTime=-1&beforeId=x'])expect((await call(own+'&'+query,f.studentCookie)).status).toBe(400);
  expect((await call('/api/admin/analytics?activityId='+f.activity+'&studentId=invalid')).status).toBe(400);
  await q('INSERT INTO class_students(class_id,student_id,access) VALUES(?,?,0)',f.classId,f.student).run();expect((await call(own,f.studentCookie)).status).toBe(404);
});
