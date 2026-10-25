import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { DEFAULT_RUBRIC, MODELS } from '../shared/contracts';
import { runAnalysis, runGeneration, recoverJobs } from '../worker/jobs';
import { processBackup, expireBackups } from '../worker/backup';
import { validateLanguage, validateSemantic } from '../worker/analysis';
import { ClassroomTasks } from '../worker/tasks';
import { storageUsage, reserveObject } from '../worker/storage';
import { normalizeXlsx, readRoster, validateRows } from '../src/roster';
import { splitBackupFiles } from '../src/backupFiles';
import type { Env, Job } from '../worker/env';
import { applyMigrations } from './migrations';

const storage = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("storage harness"); } };', compatibilityDate: '2026-10-19', d1Databases: ['DB'], r2Buckets: ['IMAGES'] }));
const env = {} as { DB: D1Database; IMAGES: R2Bucket };
const origin = 'https://classroom.test';
const teacherPassword = 'test-teacher-password-only-123456789';
const jobs: Job[] = [];
let apiEnv: Env;
let teacherCookie = '';
let classId = '';
let activityId = '';
let students: {cookie:string;id:string;name:string;number:number}[] = [];
let imageCalls = 0;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=';
const utterance = '노란 우비를 입은 아이 세 명이 빨간 우체통 옆에 서 있어.';
function semantic(text=utterance, rubric=DEFAULT_RUBRIC) {
  return { interpretation:'노란 우비를 입은 아이 세 명과 우체통의 위치를 묘사한다.',
    specificity:{subject:3,attributes:3,relations:2,quantity:3,evidence:[{quote:text,explanation:'현재 발화의 구체적인 설명'}]},
    irony:{label:'unlikely',evidence:[]},negation:{label:'none',resolvedMeaning:'부정 표현이 없다.',evidence:[]},needsReview:false,
    language:{keywords:[text.slice(0,12)],expressions:[{quote:text,category:'subject',explanation:'현재 발화의 표현'}]},
    rubricScores:rubric.map((r)=>({id:r.id,score:3,evidence:[{quote:text,explanation:'현재 발화 근거'}]})) };
}
async function call(path:string,method='GET',data?:unknown,cookie='') {
  return worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})}),apiEnv);
}
const value = async (response:Response):Promise<any> => response.json();
const cookieOf = (response:Response) => response.headers.get('Set-Cookie')!.split(';')[0];
async function teacher(path:string,method='GET',data?:unknown){return call(path,method,data,teacherCookie);}
async function command(s=students[0],text=utterance,requestId=crypto.randomUUID(),activity=activityId,style='photo') {
  return call('/api/activities/'+activity+'/commands','POST',{requestId,transcript:text,inputMethod:'speech',recognizedText:text,styleId:style},s.cookie);
}
beforeAll(async()=>{
  mkdirSync('output', { recursive: true });
  env.DB = await storage.getD1Database('DB') as unknown as D1Database;
  env.IMAGES = await storage.getR2Bucket('IMAGES') as unknown as R2Bucket;
  await applyMigrations(env.DB);
  apiEnv={DB:env.DB,IMAGES:env.IMAGES,OPENROUTER_API_KEY:'test-openrouter-key',TEACHER_PASSWORD:teacherPassword,MAX_CLASS_COMMANDS_PER_DAY:'900',
    JOBS:{send:async(job:Job)=>{jobs.push(job);}} as any,
    TASKS:{getByName:()=>({fetch:async(input:Request|string,init?:RequestInit)=>new ClassroomTasks({} as DurableObjectState,apiEnv).fetch(input instanceof Request?input:new Request(input,init))})} as any,
    ASSETS:{fetch:async()=>new Response('asset')} as any};
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
    const data=JSON.parse(init.body as string);
    if(url.endsWith('/images')){imageCalls++;expect(data.model).toBe(MODELS.image);return Response.json({data:[{b64_json:png,media_type:'image/png'}]});}
    const input=JSON.parse(data.messages[1].content);
    expect(data.provider.data_collection).toBe('deny');
    if(data.model===MODELS.analysis)return Response.json({choices:[{message:{content:JSON.stringify(semantic(input.original,input.rubric))}}]});
    const action=input.transcript==='삭제'?'DISCARD_ACTIVE':input.transcript==='음'?'IGNORE':input.transcript.includes('수정')?'EDIT_ACTIVE':input.activeImagePrompt?'SAVE_AND_NEXT':'START_NEW_THEME';
    return Response.json({choices:[{message:{content:JSON.stringify({action,themeTitle:'우리의 이야기',imagePrompt:['IGNORE','DISCARD_ACTIVE'].includes(action)?null:input.transcript})}}]});
  }));
  const login=await call('/api/login','POST',{teacherPassword});expect(login.status).toBe(200);teacherCookie=cookieOf(login);
  const group=await teacher('/api/admin/classes','POST',{name:'5학년 2반 국어',grade:5,classNumber:2});expect(group.status).toBe(201);classId=(await value(group)).id;
  const activity=await teacher('/api/admin/activities','POST',{classId,title:'장면 묘사',unit:'3단원',instructions:'구체적으로 묘사해요.',opensAt:Date.now()-60000,closesAt:Date.now()+3600000,commandLimit:5,rubric:DEFAULT_RUBRIC});expect(activity.status).toBe(201);activityId=(await value(activity)).id;
});
afterAll(async()=>{vi.unstubAllGlobals();await storage.dispose();});

describe('학생 등록·활동 권한·시간',()=>{
  it('등록되지 않은 학생의 입장을 차단한다',async()=>{
    expect((await call('/api/login','POST',{grade:5,classNumber:2,studentNumber:99,name:'미등록',password:'student-pass'})).status).toBe(401);
    expect((await call('/api/admin/overview')).status).toBe(401);
  });
  it('30명의 명단을 한 번에 등록하고 로그인한다',async()=>{
    const roster=Array.from({length:30},(_,i)=>({grade:5,classNumber:2,studentNumber:i+1,name:'예시학생'+(i+1),password:'student-pass'}));
    let registeredCount=0;for(let offset=0;offset<roster.length;offset+=25){const registered=await teacher('/api/admin/students','POST',{students:roster.slice(offset,offset+25)});expect(registered.status).toBe(201);registeredCount+=(await value(registered)).registered;}expect(registeredCount).toBe(30);
    students=await Promise.all(roster.map(async(s)=>{
      const response=await call('/api/login','POST',s);expect(response.status).toBe(200);const cookie=cookieOf(response);const me=await value(await call('/api/me','GET',undefined,cookie));
      expect(JSON.stringify(me)).not.toContain('password_hash');
      return {cookie,id:me.student.id,name:s.name,number:s.studentNumber};
    }));
    expect(students.length).toBe(30);
  });
  it('잘못된 이름·비밀번호, 학생의 관리자 접근, 외부 출처 요청을 차단한다',async()=>{
    expect((await call('/api/login','POST',{grade:5,classNumber:2,studentNumber:1,name:'다른이름',password:'student-pass'})).status).toBe(401);
    expect((await call('/api/login','POST',{grade:5,classNumber:2,studentNumber:1,name:'예시학생1',password:'wrong-pass'})).status).toBe(401);
    expect((await call('/api/admin/overview','GET',undefined,students[0].cookie)).status).toBe(403);
    expect((await call('/api/login','POST',{password:'a'.repeat(130000)})).status).toBe(413);
    expect((await worker.fetch(new Request(origin+'/api/login',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'}),apiEnv)).status).toBe(403);
  });
  it('미래 활동의 참여와 다른 반 활동의 열람을 차단한다',async()=>{
    const future=await value(await teacher('/api/admin/activities','POST',{classId,title:'다음 단원',unit:'4단원',opensAt:Date.now()+3600000,closesAt:Date.now()+7200000,commandLimit:10}));
    expect((await call('/api/activities/'+future.id+'/join','POST',{},students[0].cookie)).status).toBe(403);
    const other=await value(await teacher('/api/admin/classes','POST',{name:'다른 반',grade:5,classNumber:3}));
    const otherActivity=await value(await teacher('/api/admin/activities','POST',{classId:other.id,title:'다른 반 활동',unit:'3단원',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:10}));
    expect((await call('/api/activities/'+otherActivity.id+'/join','POST',{},students[0].cookie)).status).toBe(404);
  });
});

describe('30명 동시 요청과 영구 저장',()=>{
  it('30개의 발화를 수락하고 D1 기록과 R2 이미지 30개를 연결해 보존한다',async()=>{
    await Promise.all(students.map(async(s)=>expect((await call('/api/activities/'+activityId+'/join','POST',{},s.cookie)).status).toBe(200)));
    const started=performance.now();
    const latencies:number[]=[];
    const results=await Promise.all(students.map(async(s)=>{const start=performance.now();const r=await command(s);latencies.push(performance.now()-start);expect(r.status).toBe(202);return (await value(r)).eventId as string;}));
    let next=0,active=0,peak=0;
    await Promise.all(Array.from({length:6},async()=>{while(next<results.length){const id=results[next++];active++;peak=Math.max(peak,active);await runGeneration(apiEnv,id);active--;}}));
    expect(peak).toBe(6);
    const rows=await env.DB.prepare("SELECT * FROM events WHERE status='succeeded'").all<any>();expect(rows.results.length).toBe(30);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM images').first<any>()).n).toBe(30);
    for(const s of students){
      const ws=await value(await call('/api/workspace?activityId='+activityId,'GET',undefined,s.cookie));
      expect(ws.events[0].transcript).toBe(utterance);expect(ws.used).toBe(1);expect(ws.images.length).toBe(1);expect(ws.board.active_image_id).toBe(ws.images[0].id);
      const image=await call(ws.images[0].imageUrl,'GET',undefined,s.cookie);expect(image.status).toBe(200);expect(image.headers.get('Cache-Control')).toBe('private, no-store');expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(30);
    }
    latencies.sort((a,b)=>a-b);
    const report = {students:30,accepted:30,persistedLogs:30,persistedImages:30,concurrency:peak,acceptP95Ms:Math.round(latencies[28]),totalMs:Math.round(performance.now()-started),provider:'mock',handler:'Node test runner',storage:'real local D1/R2 in workerd'};
    writeFileSync('output/load-results.json', JSON.stringify(report,null,2));
  });
  it('다른 학생의 이미지를 차단하고 같은 요청의 재전송은 중복 작업을 만들지 않는다',async()=>{
    const image=await env.DB.prepare('SELECT id FROM images WHERE student_id=?').bind(students[0].id).first<any>();
    expect((await call('/api/images/'+image.id,'GET',undefined,students[1].cookie)).status).toBe(404);
    const id=crypto.randomUUID();const a=await command(students[0],utterance,id);const b=await command(students[0],utterance,id);
    expect(a.status).toBe(202);expect(b.status).toBe(202);expect((await value(a)).eventId).toBe((await value(b)).eventId);
    const row=await env.DB.prepare('SELECT id FROM events WHERE request_id=?').bind(id).first<any>();await runGeneration(apiEnv,row.id);
  });
  it('R2 업로드 후 D1 저장이 실패해도 이미지를 재생성하지 않고 복구한다',async()=>{
    const r=await value(await command(students[1]));const before=imageCalls;let fail=true;
    const flaky={...apiEnv,DB:{prepare:(q:string)=>env.DB.prepare(q),batch:async(statements:D1PreparedStatement[])=>{if(fail){fail=false;throw new Error('simulated D1 outage');}return env.DB.batch(statements);}}} as Env;
    await expect(runGeneration(flaky,r.eventId)).rejects.toThrow();
    expect(imageCalls).toBe(before+1);await runGeneration({...apiEnv,MAX_STORAGE_BYTES:'1'},r.eventId);expect(imageCalls).toBe(before+1);
    expect((await env.DB.prepare('SELECT status FROM events WHERE id=?').bind(r.eventId).first<any>()).status).toBe('succeeded');
  });
  it('학생별 한도와 동시 제출을 서버에서 막는다',async()=>{
    await teacher('/api/admin/activities/'+activityId+'/students/'+students[2].id,'PUT',{limit:2});
    const requests=await Promise.all([command(students[2]),command(students[2])]);expect(requests.filter((r)=>r.status===202).length).toBe(1);
    const accepted=await value(requests.find((r)=>r.status===202)!);await runGeneration(apiEnv,accepted.eventId);
    expect((await command(students[2])).status).toBe(409);
  });
  it('큐 발행 실패가 발생해도 발화 원문을 잃지 않고 outbox가 복구한다',async()=>{
    const original=apiEnv.JOBS;apiEnv.JOBS={send:async()=>{throw new Error('queue temporarily unavailable');}} as any;
    const r=await command(students[3]);expect(r.status).toBe(202);const id=(await value(r)).eventId;
    expect((await env.DB.prepare('SELECT transcript FROM events WHERE id=?').bind(id).first<any>()).transcript).toBe(utterance);
    apiEnv.JOBS=original;await recoverJobs({} as any,apiEnv);expect(jobs.some((j)=>j.stage==='generation'&&j.eventId===id)).toBe(true);await runGeneration(apiEnv,id);
  });
  it('수정 이미지의 원본 연결과 스타일 선택을 보존한다',async()=>{
    const original=await env.DB.prepare('SELECT active_image_id FROM boards WHERE student_id=? AND activity_id=?').bind(students[4].id,activityId).first<any>();
    const r=await value(await command(students[4],'수정: 노란 우비를 파란색으로 바꿔 줘.',crypto.randomUUID(),activityId,'watercolor'));await runGeneration(apiEnv,r.eventId);
    const image=await env.DB.prepare('SELECT parent_image_id FROM images WHERE event_id=?').bind(r.eventId).first<any>();expect(image.parent_image_id).toBe(original.active_image_id);
    expect((await env.DB.prepare('SELECT style_name FROM events WHERE id=?').bind(r.eventId).first<any>()).style_name).toBe('수채화');
  });
});

describe('분석·백업·관리',()=>{
  it('큰 백업을 파일 누락 없이 메모리 한도 내 여러 ZIP으로 나눈다',()=>{
    const files=Array.from({length:12},(_,i)=>({name:String(i),bytes:15,url:'/file/'+i}));
    const parts=splitBackupFiles(files,80);
    expect(parts.flat()).toEqual(files);
    expect(parts.every((part)=>part.reduce((n,file)=>n+file.bytes,0)<=80)).toBe(true);
  });
  it('원문 근거를 검증하고 반어·이중 부정의 교사 검토를 강제한다',()=>{
    const s:any=semantic();s.irony.label='uncertain';s.needsReview=false;expect(validateSemantic(s,utterance,JSON.stringify(DEFAULT_RUBRIC)).semantic.needsReview).toBe(true);
    const d:any=semantic();d.negation={label:'double',resolvedMeaning:'완곡한 긍정',evidence:[{quote:utterance,explanation:'검토용 fixture'}]};expect(validateSemantic(d,utterance,JSON.stringify(DEFAULT_RUBRIC)).semantic.needsReview).toBe(true);
    const bad:any=semantic();bad.specificity.evidence[0].quote='원문에 없는 근거';expect(()=>validateSemantic(bad,utterance,JSON.stringify(DEFAULT_RUBRIC))).toThrow('UNGROUNDED_EVIDENCE');
  });
  it('현재 발화에만 근거한 분석과 당시 평가 기준을 저장한다',async()=>{
    const event=await env.DB.prepare('SELECT * FROM events WHERE student_id=? ORDER BY created_at LIMIT 1').bind(students[0].id).first<any>();
    await runAnalysis(apiEnv,event.id);
    const stored=await env.DB.prepare('SELECT analysis_status,analysis_json FROM events WHERE id=?').bind(event.id).first<any>();expect(stored.analysis_status).toBe('completed');expect(JSON.parse(stored.analysis_json).rubric).toEqual(DEFAULT_RUBRIC);
    await teacher('/api/admin/activities/'+activityId,'PUT',{classId,title:'장면 묘사',unit:'3단원',opensAt:Date.now()-60000,closesAt:Date.now()+3600000,commandLimit:5,rubric:[{id:'custom',label:'비교 표현',description:'비교 대상을 구체적으로 드러낸다.'}]});
    expect(JSON.parse((await env.DB.prepare('SELECT analysis_json FROM events WHERE id=?').bind(event.id).first<any>()).analysis_json).rubric).toEqual(DEFAULT_RUBRIC);
  });
  it('Excel/CSV 행 검증은 잘못된 명단·중복 명단을 거부한다',()=>{
    expect(validateRows([['학년','반','번호','이름','비밀번호'],[5,2,1,'학생','secret']])).toHaveLength(1);
    expect(()=>validateRows([['학년','반','번호','이름','비밀번호'],[5,2,1,'','secret']])).toThrow();
    expect(()=>validateRows([['학년','반','번호','이름','비밀번호'],[5,2,1,'학생','secret'],[5,2,1,'학생','secret']])).toThrow('중복');
  });
  it('실제 다운로드 양식의 XML 호환성과 Excel·CSV 일괄 업로드를 검증한다',async()=>{
    const {default:ExcelJS}=await import('exceljs');
    const workbook=new ExcelJS.Workbook();
    const template=readFileSync('public/templates/student-roster.xlsx');
    await workbook.xlsx.load(await normalizeXlsx(template.buffer.slice(template.byteOffset,template.byteOffset+template.byteLength)));
    const sheet=workbook.getWorksheet('학생명단')!;
    expect(sheet.getRow(1).getCell(1).text).toBe('학년');
    sheet.getRow(2).values=[5,2,1,'예시학생','sample-pass'];
    const bytes=await workbook.xlsx.writeBuffer();
    writeFileSync('output/sample-roster.xlsx',new Uint8Array(bytes));
    const excel=await readRoster(new File([bytes as ArrayBuffer],'students.xlsx'));
    expect(excel[0].name).toBe('예시학생');
    const csv=await readRoster(new File(['\uFEFF학년,반,번호,이름,비밀번호\r\n5,2,2,예시학생둘,sample-pass\r\n'],'students.csv'));
    expect(csv[0].studentNumber).toBe(2);
  });
  it('비밀번호 일괄 재발급은 기존 세션과 기존 비밀번호를 폐기한다',async()=>{
    const s=students[29];const reset=await teacher('/api/admin/passwords/reset','POST',{studentIds:[s.id]});expect(reset.status).toBe(200);const password=(await value(reset)).credentials[0].password;
    expect((await call('/api/me','GET',undefined,s.cookie)).status).toBe(401);
    expect((await call('/api/login','POST',{grade:5,classNumber:2,studentNumber:30,name:s.name,password:'student-pass'})).status).toBe(401);
    expect((await call('/api/login','POST',{grade:5,classNumber:2,studentNumber:30,name:s.name,password})).status).toBe(200);
  });
  it('학습 기록과 이미지 사본을 백업하고 만료 시 원본은 보존한다',async()=>{
    // Generation/analysis are separately durable; complete pending analyses first.
    const all=await env.DB.prepare("SELECT id FROM events WHERE analysis_status IN ('pending','processing')").all<any>();
    for(const event of all.results)await runAnalysis(apiEnv,event.id);
    const created=await teacher('/api/admin/backups','POST',{});expect(created.status).toBe(202);const id=(await value(created)).id;
    for(let i=0;i<100;i++){const b=await env.DB.prepare('SELECT status FROM backups WHERE id=?').bind(id).first<any>();if(b.status==='ready')break;await processBackup(apiEnv,id);}
    expect((await env.DB.prepare('SELECT status FROM backups WHERE id=?').bind(id).first<any>()).status).toBe('ready');
    const manifest=await value(await teacher('/api/admin/backups/'+id+'/manifest'));expect(manifest.files.some((f:any)=>f.name.startsWith('images/'))).toBe(true);
    for(const file of manifest.files){const r=await teacher(file.url);expect(r.status).toBe(200);if(file.name.includes('students'))expect(await r.text()).not.toContain('password_hash');}
    const originalCount=(await env.DB.prepare('SELECT COUNT(*) n FROM images').first<any>()).n;
    await env.DB.prepare('UPDATE backups SET expires_at=? WHERE id=?').bind(Date.now()-1,id).run();await expireBackups(apiEnv);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM images').first<any>()).n).toBe(originalCount);
    expect((await teacher('/api/admin/backups/'+id+'/manifest')).status).toBe(404);
  });
});

describe('확장된 배정·비밀번호·이미지 전체 이력',()=>{
  it('30명 동시 업로드의 본문 처리를 4개로 제한하고 재시도 후 30개 원본을 모두 보존한다',async()=>{
    const c=await value(await teacher('/api/admin/classes','POST',{name:'업로드 동시 사용',grade:5,classNumber:2}));
    const a=await value(await teacher('/api/admin/activities','POST',{classId:c.id,title:'30명 업로드',unit:'검증',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:0}));
    const added={grade:5,classNumber:2,studentNumber:31,name:'동시업로드31',password:'upload-pass'};expect((await teacher('/api/admin/students','POST',{students:[added]})).status).toBe(201);
    const extraCookie=cookieOf(await call('/api/login','POST',added));const cookies=[...students.slice(0,29).map(s=>s.cookie),extraCookie];
    for(const cookie of cookies)expect((await call('/api/activities/'+a.id+'/join','POST',{},cookie)).status).toBe(200);
    let release!:()=>void,ready!:()=>void,allDenied!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const four=new Promise<void>(resolve=>ready=resolve);const deniedReady=new Promise<void>(resolve=>allDenied=resolve);let active=0,peak=0,entered=0,denied=0;
    const original=apiEnv.IMAGES;apiEnv.IMAGES=new Proxy(original,{get(target,property){if(property==='put')return async(...args:any[])=>{active++;entered++;peak=Math.max(peak,active);if(entered===4)ready();try{await gate;return await (original.put as any)(...args);}finally{active--;}};const item=Reflect.get(target,property);return typeof item==='function'?item.bind(target):item;}});
    const ids=cookies.map(()=>crypto.randomUUID());const bytes=Uint8Array.from(Buffer.from(png,'base64'));
    const upload=(index:number)=>worker.fetch(new Request(origin+'/api/activities/'+a.id+'/uploads',{method:'POST',headers:{Origin:origin,Cookie:cookies[index],'Content-Type':'image/png','X-Upload-ID':ids[index]},body:bytes}),apiEnv);
    const requests=cookies.map((_,index)=>upload(index).then(response=>{if(response.status===429&&++denied===26)allDenied();return response;}));
    try{
      await Promise.race([Promise.all([four,deniedReady]),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Upload claim timeout')),10000))]);
      expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind='upload' AND status='processing'").first<any>()).n).toBe(4);release();
      const responses=await Promise.all(requests);expect(responses.filter(r=>r.status===201)).toHaveLength(4);expect(responses.filter(r=>r.status===429)).toHaveLength(26);
      for(const [index,response]of responses.entries())if(response.status===429)expect((await upload(index)).status).toBe(201);
      const images=await env.DB.prepare('SELECT i.* FROM images i JOIN events e ON e.id=i.event_id WHERE e.activity_id=?').bind(a.id).all<any>();expect(images.results).toHaveLength(30);
      for(const image of images.results){const object=await original.get(image.object_key);expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);}
      expect((await env.DB.prepare('SELECT COUNT(*) n FROM image_actions WHERE activity_id=? AND action=\'upload\'').bind(a.id).first<any>()).n).toBe(30);
      expect(peak).toBe(4);writeFileSync('output/upload-load-results.json',JSON.stringify({students:30,firstAccepted:4,queuedForClientRetry:26,storedUploads:30,originalBytesPreserved:true,maxConcurrentBodies:peak,handler:'Node test runner',storage:'real local D1/R2 in workerd',openrouterCalls:0},null,2));
    }finally{release();await Promise.allSettled(requests);apiEnv.IMAGES=original;}
  });
  it('여러 반과 특정 학생을 배정하고 개별 제외·반 삭제 후의 접근을 차단하며 기존 기록을 보존한다',async()=>{
    const c=await value(await teacher('/api/admin/classes','POST',{name:'복수 반 수업',grade:5,classNumber:2}));
    const a=await value(await teacher('/api/admin/activities','POST',{classId:c.id,title:'공동 수업',unit:'5단원',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:10}));
    const newRoster=[{grade:6,classNumber:1,studentNumber:1,name:'타반학생',password:'class-pass'},{grade:6,classNumber:2,studentNumber:1,name:'개별학생',password:'class-pass'}];
    const added=await teacher('/api/admin/students','POST',{students:newRoster});expect(added.status).toBe(201);
    const others=await Promise.all(newRoster.map(async s=>{const login=await call('/api/login','POST',s);const cookie=cookieOf(login);const me=await value(await call('/api/me','GET',undefined,cookie));return{id:me.student.id,cookie};}));
    const assigned=await teacher('/api/admin/classes/'+c.id+'/assignments','PUT',{rooms:[{grade:5,classNumber:2},{grade:6,classNumber:1}],students:[{studentId:students[1].id,access:false},{studentId:others[1].id,access:true}]});expect(assigned.status).toBe(200);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},students[1].cookie)).status).toBe(404);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},others[0].cookie)).status).toBe(200);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},others[1].cookie)).status).toBe(200);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},students[0].cookie)).status).toBe(200);
    const accepted=await value(await command(students[0],utterance,crypto.randomUUID(),a.id));await runGeneration(apiEnv,accepted.eventId);
    await teacher('/api/admin/classes/'+c.id+'/assignments','PUT',{rooms:[],students:[{studentId:others[1].id,access:true}]});
    expect((await command(students[0],utterance,crypto.randomUUID(),a.id)).status).toBe(404);
    expect((await call('/api/workspace?activityId='+a.id,'GET',undefined,others[0].cookie)).status).toBe(404);
    const list=await value(await call('/api/activities','GET',undefined,students[0].cookie));expect(list.activities.some((x:any)=>x.id===a.id)).toBe(false);
    const analytics=await value(await teacher('/api/admin/analytics?activityId='+a.id));expect(analytics.events.some((e:any)=>e.id===accepted.eventId)).toBe(true);expect(analytics.students.find((s:any)=>s.id===students[0].id).assigned).toBe(0);
    expect((await teacher('/api/admin/classes/'+c.id+'/assignments','PUT',{rooms:[],students:[{studentId:crypto.randomUUID(),access:true}]})).status).toBe(400);
  });
  it('30명 전원의 비밀번호를 자동 발급하고 비밀번호만으로 미배정 활동에 들어가지 못하게 한다',async()=>{
    const roster=Array.from({length:30},(_,i)=>({grade:7,classNumber:1,studentNumber:i+1,name:'자동발급'+(i+1)}));
    const result:{credentials:any[]}={credentials:[]};for(let offset=0;offset<roster.length;offset+=25){const r=await teacher('/api/admin/students','POST',{students:roster.slice(offset,offset+25)});expect(r.status).toBe(201);result.credentials.push(...(await value(r)).credentials);}expect(result.credentials).toHaveLength(30);expect(new Set(result.credentials.map((s:any)=>s.password)).size).toBe(30);
    const login=await call('/api/login','POST',result.credentials[0]);expect(login.status).toBe(200);const cookie=cookieOf(login);
    expect((await value(await call('/api/activities','GET',undefined,cookie))).activities).toEqual([]);
    expect((await call('/api/activities/'+activityId+'/join','POST',{},cookie)).status).toBe(404);
  });
  it('글 종류를 추가하고 학생 선택 목록에 반영하며 숨긴 종류의 기존 기록은 유지한다',async()=>{
    const result=await teacher('/api/admin/genres','POST',{name:'기행문',description:'여행에서 관찰한 풍경',recommendedStyleId:'watercolor'});expect(result.status).toBe(201);const id=(await value(result)).id;
    expect((await value(await call('/api/activities','GET',undefined,students[0].cookie))).genres.some((g:any)=>g.name==='기행문')).toBe(true);
    await teacher('/api/admin/genres/'+id,'PUT',{enabled:false});expect((await value(await call('/api/activities','GET',undefined,students[0].cookie))).genres.some((g:any)=>g.name==='기행문')).toBe(false);
    expect((await teacher('/api/admin/genres','POST',{name:'부적절한 참조',recommendedStyleId:'missing-style'})).status).toBe(400);
  });
  it('업로드 원본·수정본·제거·보관·복원 이력을 모두 남기고 원본 바이트와 요청 한도를 보존한다',async()=>{
    const c=await value(await teacher('/api/admin/classes','POST',{name:'이미지 이력 수업',grade:5,classNumber:2}));
    const a=await value(await teacher('/api/admin/activities','POST',{classId:c.id,title:'업로드 수정',unit:'6단원',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:1}));
    const s=students[5];await call('/api/activities/'+a.id+'/join','POST',{},s.cookie);
    const bytes=Uint8Array.from(Buffer.from(png,'base64'));const uploadId=crypto.randomUUID();
    const upload=(mime='image/png',data=bytes)=>worker.fetch(new Request(origin+'/api/activities/'+a.id+'/uploads',{method:'POST',headers:{Cookie:s.cookie,Origin:origin,'Content-Type':mime,'X-Upload-ID':uploadId,'X-File-Name':encodeURIComponent('학생 그림.png')},body:data}),apiEnv);
    const response=await upload();expect(response.status).toBe(201);const imageId=(await value(response)).imageId;expect((await value(await upload())).imageId).toBe(imageId);
    expect((await value(await call('/api/workspace?activityId='+a.id,'GET',undefined,s.cookie))).used).toBe(0);
    expect(new Uint8Array(await (await call('/api/images/'+imageId,'GET',undefined,s.cookie)).arrayBuffer())).toEqual(bytes);
    expect((await call('/api/images/'+imageId,'DELETE',{},students[6].cookie)).status).toBe(404);
    for(const [method,path]of [['DELETE',''],['POST','/activate'],['POST','/pin'],['POST','/activate']])expect((await call('/api/images/'+imageId+path,method,{},s.cookie)).status).toBe(200);
    const accepted=await value(await command(s,'수정: 꽃 세 송이를 그려 줘.',crypto.randomUUID(),a.id));await runGeneration(apiEnv,accepted.eventId);await runAnalysis(apiEnv,accepted.eventId);
    const edited=await env.DB.prepare('SELECT * FROM images WHERE event_id=?').bind(accepted.eventId).first<any>();expect(edited.parent_image_id).toBe(imageId);
    expect((await call('/api/images/'+edited.id,'DELETE',{},s.cookie)).status).toBe(200);
    const workspace=await value(await call('/api/workspace?activityId='+a.id,'GET',undefined,s.cookie));expect(workspace.used).toBe(1);expect(workspace.images).toHaveLength(2);expect(workspace.images.find((i:any)=>i.id===edited.id).hidden_at).not.toBeNull();
    const records=await value(await call('/api/activities/'+a.id+'/records','GET',undefined,s.cookie));expect(records.rows.map((e:any)=>e.kind)).toEqual(['upload','command']);
    const history=await value(await call('/api/activities/'+a.id+'/image-actions','GET',undefined,s.cookie));expect(history.rows.map((e:any)=>e.action)).toEqual(['upload','hide','activate','pin','activate','edit','hide']);
    expect((await call('/api/images/'+edited.id,'GET',undefined,s.cookie)).status).toBe(200);
    expect((await call('/api/activities/'+a.id+'/image-actions','GET',undefined,students[6].cookie)).status).toBe(200); // own history only
    expect((await value(await call('/api/activities/'+a.id+'/image-actions','GET',undefined,students[6].cookie))).rows).toEqual([]);
    expect((await value(await teacher('/api/admin/analytics?activityId='+a.id))).imageActions).toHaveLength(7);
    const more=Array.from({length:205},()=>env.DB.prepare("INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,action,created_at)VALUES(?,?,?,?,?,'activate',?)").bind(crypto.randomUUID(),s.id,a.id,edited.board_id,imageId,Date.now()));await env.DB.batch(more);
    let next:any=null;const all:string[]=[];do{const query=next?'?'+new URLSearchParams({afterTime:String(next.afterTime),afterId:next.afterId}):'';const page=await value(await call('/api/activities/'+a.id+'/image-actions'+query,'GET',undefined,s.cookie));all.push(...page.rows.map((r:any)=>r.id));next=page.next;}while(next);expect(all).toHaveLength(212);expect(new Set(all).size).toBe(212);
    const badRequest=(mime:string,body:BodyInit)=>worker.fetch(new Request(origin+'/api/activities/'+a.id+'/uploads',{method:'POST',headers:{Cookie:s.cookie,Origin:origin,'Content-Type':mime,'X-Upload-ID':crypto.randomUUID()},body}),apiEnv);
    expect((await badRequest('image/svg+xml','<svg/>')).status).toBe(415);expect((await badRequest('image/png','not-an-image')).status).toBe(400);expect((await badRequest('image/jpeg',bytes)).status).toBe(400);
  });
});

describe('OpenRouter 원문 분석과 무료 저장 상한',()=>{
  it('저장 상한 도달 시 유료 이미지 호출 전에 중단하고 발화와 기존 원본은 남긴다',async()=>{
    const usage=await storageUsage(apiEnv);const before=imageCalls;
    const accepted=await value(await command(students[10]));
    await runGeneration({...apiEnv,MAX_STORAGE_BYTES:String(usage.bytes)},accepted.eventId);
    const record=await env.DB.prepare('SELECT transcript,status,error_code FROM events WHERE id=?').bind(accepted.eventId).first<any>();
    expect(record).toEqual({transcript:utterance,status:'failed',error_code:'STORAGE_LIMIT'});expect(imageCalls).toBe(before);
    expect((await storageUsage(apiEnv)).bytes).toBe(usage.bytes);
  });
  it('이전 백업의 임시 예약은 새 파일 저장 전에 R2 실제 용량으로 보정한다',async()=>{
    const before=await storageUsage(apiEnv);const id=crypto.randomUUID();const created=Date.now()-100000;const key=`backups/${id}/manifest.json`;
    const data='{"version":1,"files":[]}';const bytes=new TextEncoder().encode(data).byteLength;
    await env.DB.prepare("INSERT INTO backups(id,status,manifest_key,created_at,expires_at) VALUES(?,'ready',?,?,?)").bind(id,key,created,Date.now()+100000).run();
    await env.IMAGES.put(key,data);
    await env.DB.prepare('INSERT INTO storage_objects(object_key,byte_size,updated_at) VALUES(?,?,?)').bind(key,1048576,created).run();
    await reserveObject(apiEnv,'legacy-reconcile-test',100);
    expect((await storageUsage(apiEnv)).bytes).toBe(before.bytes+bytes+100);
    await env.IMAGES.delete(key);await env.DB.prepare('DELETE FROM storage_objects WHERE object_key IN (?,?)').bind(key,'legacy-reconcile-test').run();await env.DB.prepare('DELETE FROM backups WHERE id=?').bind(id).run();
    expect((await storageUsage(apiEnv)).bytes).toBe(before.bytes);
  });
  it('핵심 표현은 원문에 있는 표현만 허용하고 빈도를 서버에서 센다',()=>{
    const result=validateLanguage({keywords:['꽃','꽃','집'],expressions:[{quote:'꽃 두 송이',category:'quantity',explanation:'수량을 명시함'}]},'집 앞에 꽃 두 송이와 꽃 한 송이');
    expect(result.keywords).toEqual([{word:'꽃',count:2},{word:'집',count:1}]);
    expect(()=>validateLanguage({keywords:['장미'],expressions:[]},'꽃 두 송이')).toThrow('UNGROUNDED_LANGUAGE');
    expect(()=>validateLanguage({keywords:[],expressions:[{quote:'빨간',category:'attributes',explanation:'원문에 없음'}]},'꽃 두 송이')).toThrow('UNGROUNDED_LANGUAGE');
  });
  it('30개 동시 용량 예약도 상한을 넘기지 않고 재시도는 이중 계산하지 않는다',async()=>{
    const before=await storageUsage(apiEnv);const limited={...apiEnv,MAX_STORAGE_BYTES:String(before.bytes+500)};
    const keys=Array.from({length:30},(_,i)=>'quota-test/'+i);
    const results=await Promise.allSettled(keys.map(key=>reserveObject(limited,key,100)));
    const accepted=results.flatMap((r,i)=>r.status==='fulfilled'?[keys[i]]:[]);
    expect(accepted).toHaveLength(5);expect((await storageUsage(apiEnv)).bytes).toBe(before.bytes+500);
    await reserveObject(limited,accepted[0],100);expect((await storageUsage(apiEnv)).bytes).toBe(before.bytes+500);
    await env.DB.prepare("DELETE FROM storage_objects WHERE object_key LIKE 'quota-test/%'").run();
    expect((await storageUsage(apiEnv)).bytes).toBe(before.bytes);
  });
});

describe('활동별 독립 참여 대상',()=>{
  it('같은 클래스의 활동마다 대상을 분리하고 기본 배정 변경·해제 후에도 권한과 기록·백업을 보존한다',async()=>{
    const roster=[{grade:9,classNumber:1,studentNumber:1,name:'활동가',password:'activity-pass'},{grade:9,classNumber:1,studentNumber:2,name:'활동나',password:'activity-pass'},{grade:9,classNumber:2,studentNumber:1,name:'활동다',password:'activity-pass'}];
    expect((await teacher('/api/admin/students','POST',{students:roster})).status).toBe(201);
    const group=await value(await teacher('/api/admin/classes','POST',{name:'활동별 배정 검증',grade:9,classNumber:1}));
    const members=await Promise.all(roster.map(async(s)=>{const login=await call('/api/login','POST',s);const cookie=cookieOf(login);const me=await value(await call('/api/me','GET',undefined,cookie));return {id:me.student.id,cookie,name:s.name,number:s.studentNumber};}));
    const draft={classId:group.id,title:'활동 가',unit:'독립 배정',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:5};
    const createA=await teacher('/api/admin/activities','POST',{...draft,assignment:{mode:'custom',rooms:[{grade:9,classNumber:1}],students:[{studentId:members[1].id,access:false}]}});expect(createA.status).toBe(201);const a=await value(createA);
    const createB=await teacher('/api/admin/activities','POST',{...draft,title:'활동 나',assignment:{mode:'custom',rooms:[{grade:9,classNumber:2}],students:[{studentId:members[1].id,access:true}]}});expect(createB.status).toBe(201);const b=await value(createB);
    const c=await value(await teacher('/api/admin/activities','POST',{...draft,title:'기본 배정 활동'}));
    const visible=async(cookie:string)=>(await value(await call('/api/activities','GET',undefined,cookie))).activities.map((item:any)=>item.id);
    expect(await visible(members[0].cookie)).toEqual(expect.arrayContaining([a.id,c.id]));expect(await visible(members[0].cookie)).not.toContain(b.id);
    expect(await visible(members[1].cookie)).toEqual(expect.arrayContaining([b.id,c.id]));expect(await visible(members[1].cookie)).not.toContain(a.id);
    expect(await visible(members[2].cookie)).toContain(b.id);expect(await visible(members[2].cookie)).not.toContain(c.id);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},members[0].cookie)).status).toBe(200);
    expect((await call('/api/activities/'+a.id+'/join','POST',{},members[1].cookie)).status).toBe(404);
    expect((await call('/api/activities/'+b.id+'/join','POST',{},members[2].cookie)).status).toBe(200);
    expect((await value(await teacher('/api/admin/analytics?activityId='+b.id))).students.map((s:any)=>s.id)).toEqual(expect.arrayContaining([members[1].id,members[2].id]));
    await teacher('/api/admin/classes/'+group.id+'/assignments','PUT',{rooms:[],students:[]});
    expect(await visible(members[0].cookie)).toContain(a.id);expect(await visible(members[0].cookie)).not.toContain(c.id);expect(await visible(members[2].cookie)).toContain(b.id);
    const event=await value(await command(members[0],utterance,crypto.randomUUID(),a.id));expect(event.eventId).toBeTruthy();await runGeneration(apiEnv,event.eventId);await runAnalysis(apiEnv,event.eventId);
    const image=await env.DB.prepare('SELECT id FROM images WHERE event_id=?').bind(event.eventId).first<any>();
    expect((await teacher('/api/admin/activities/'+a.id+'/assignments','PUT',{mode:'custom',rooms:[],students:[]})).status).toBe(200);
    for(const suffix of ['/join','/commands'])expect((await call('/api/activities/'+a.id+suffix,'POST',suffix==='/commands'?{requestId:crypto.randomUUID(),transcript:utterance,inputMethod:'text',styleId:'photo'}:{},members[0].cookie)).status).toBe(404);
    for(const path of ['/api/workspace?activityId='+a.id,'/api/activities/'+a.id+'/records','/api/activities/'+a.id+'/image-actions'])expect((await call(path,'GET',undefined,members[0].cookie)).status).toBe(404);
    const bytes=Uint8Array.from(Buffer.from(png,'base64'));
    const upload=await worker.fetch(new Request(origin+'/api/activities/'+a.id+'/uploads',{method:'POST',headers:{Origin:origin,Cookie:members[0].cookie,'Content-Type':'image/png','X-Upload-ID':crypto.randomUUID()},body:bytes}),apiEnv);expect(upload.status).toBe(404);
    expect((await call('/api/images/'+image.id+'/activate','POST',{},members[0].cookie)).status).toBe(404);
    const analytics=await value(await teacher('/api/admin/analytics?activityId='+a.id));expect(analytics.events.some((item:any)=>item.id===event.eventId)).toBe(true);expect(analytics.students.find((s:any)=>s.id===members[0].id).assigned).toBe(0);
    expect((await call('/api/images/'+image.id,'GET',undefined,members[0].cookie)).status).toBe(200);expect(await visible(members[2].cookie)).toContain(b.id);
    await teacher('/api/admin/activities/'+a.id+'/assignments','PUT',{mode:'class',rooms:[],students:[]});
    await teacher('/api/admin/classes/'+group.id+'/assignments','PUT',{rooms:[{grade:9,classNumber:1}],students:[]});
    expect(await visible(members[0].cookie)).toEqual(expect.arrayContaining([a.id,c.id]));expect(await visible(members[0].cookie)).not.toContain(b.id);
    const overview=await value(await teacher('/api/admin/overview'));expect(overview.activities.find((item:any)=>item.id===b.id).assignment_mode).toBe('custom');expect(overview.activityRooms.some((item:any)=>item.activity_id===b.id)).toBe(true);
    const pending=await env.DB.prepare("SELECT id FROM events WHERE analysis_status IN ('pending','processing')").all<any>();for(const item of pending.results)await runAnalysis(apiEnv,item.id);
    const backup=await teacher('/api/admin/backups','POST',{});expect(backup.status).toBe(202);const backupId=(await value(backup)).id;
    for(let i=0;i<100;i++){if((await env.DB.prepare('SELECT status FROM backups WHERE id=?').bind(backupId).first<any>()).status==='ready')break;await processBackup(apiEnv,backupId);}
    const manifest=await value(await teacher('/api/admin/backups/'+backupId+'/manifest'));
    for(const table of ['activity_rooms','activity_participants']){const file=manifest.files.find((item:any)=>item.name.startsWith('metadata/'+table+'-'));expect(file).toBeTruthy();const part=await value(await teacher(file.url));expect(part.rows.some((item:any)=>item.activity_id===b.id)).toBe(true);}
  });
  it('활동과 대상을 함께 검증해 잘못된 배정은 생성·수정하지 않고 학생의 배정 변경을 차단한다',async()=>{
    const group=await value(await teacher('/api/admin/classes','POST',{name:'배정 원자성 검증'}));
    const draft={classId:group.id,title:'수정 전',unit:'검증',opensAt:Date.now()-1000,closesAt:Date.now()+3600000,commandLimit:5};
    const invalid={mode:'custom',rooms:[],students:[{studentId:crypto.randomUUID(),access:true}]};
    expect((await teacher('/api/admin/activities','POST',{...draft,assignment:invalid})).status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM activities WHERE class_id=?').bind(group.id).first<any>()).n).toBe(0);
    const created=await value(await teacher('/api/admin/activities','POST',{...draft,assignment:{mode:'custom',rooms:[{grade:10,classNumber:1}],students:[]}}));
    expect((await teacher('/api/admin/activities/'+created.id,'PUT',{...draft,title:'수정되면 안 됨',assignment:invalid})).status).toBe(400);
    expect((await env.DB.prepare('SELECT title,assignment_mode FROM activities WHERE id=?').bind(created.id).first())).toEqual({title:'수정 전',assignment_mode:'custom'});
    expect((await env.DB.prepare('SELECT grade,class_number FROM activity_rooms WHERE activity_id=?').bind(created.id).first())).toEqual({grade:10,class_number:1});
    expect((await teacher('/api/admin/activities/'+created.id+'/assignments','PUT',{mode:'custom',rooms:[{grade:10,classNumber:1},{grade:10,classNumber:1}],students:[]})).status).toBe(400);
    expect((await call('/api/admin/activities/'+created.id+'/assignments','PUT',{mode:'custom',rooms:[],students:[]},students[0].cookie)).status).toBe(403);
    expect((await teacher('/api/admin/activities/'+created.id+'/assignments','PUT',{mode:'unknown',rooms:[],students:[]})).status).toBe(400);
    expect((await teacher('/api/admin/activities/'+crypto.randomUUID()+'/assignments','PUT',{mode:'custom',rooms:[],students:[]})).status).toBe(404);
  });
});
