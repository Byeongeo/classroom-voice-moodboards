import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DEFAULT_RUBRIC, MODELS } from '../shared/contracts';
import { applyMigrations } from './migrations';

// A valid, noisy 512px PNG (~0.79MB): exercise image buffers, not a 1px placeholder.
function fixtureImage() {
  function crc32(bytes: Buffer) { let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0; }
  function chunk(type: string, bytes: Buffer) { const tag=Buffer.from(type);const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([tag,bytes])));return Buffer.concat([size,tag,bytes,crc]); }
  const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(512*(512*3+1));let seed=1831565813;
  for(let y=0;y<512;y++)for(let x=1;x<=1536;x++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[y*1537+x]=seed&255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

it('실제 workerd·SQLite Durable Objects·Queues·D1·R2에서 30명 생성/분석/업로드/수정/삭제 이력을 보존한다',async()=>{
  mkdirSync('output',{recursive:true});
  const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:buffer'],logLevel:'silent'});
  const image=fixtureImage();const checksum=createHash('sha256').update(image).digest('hex');
  let active=0,peak=0,imageCalls=0,analysisCalls=0;
  const options=convertV4MiniflareOptions({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-24',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['IMAGES'],durableObjects:{TASKS:{className:'ClassroomTasks',useSQLite:true}},
    bindings:{TEACHER_PASSWORD:'workerd-synthetic-password-only-123456',OPENROUTER_API_KEY:'fixture-only',MAX_CLASS_COMMANDS_PER_DAY:'300',MAX_STORAGE_BYTES:'8000000000'},
    serviceBindings:{ASSETS:async()=>new Response('assets')},
    queueProducers:{JOBS:'classroom-load-jobs'},queueConsumers:{'classroom-load-jobs':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:3,retryDelay:0}},
    outboundService:async(request:Request)=>{
      expect(new URL(request.url).origin).toBe('https://openrouter.ai');
      const data:any=await request.json();
      if(request.url.endsWith('/images')){
        active++;peak=Math.max(peak,active);imageCalls++;await delay(150);active--;
        return Response.json({data:[{b64_json:image.toString('base64'),media_type:'image/png'}]});
      }
      const input=JSON.parse(data.messages[1].content);
      if(data.model===MODELS.analysis){
        analysisCalls++;
        return Response.json({choices:[{message:{content:JSON.stringify({
          interpretation:'현재 발화에 나타난 대상과 색, 수량, 위치를 설명함.',
          specificity:{subject:3,attributes:3,relations:2,quantity:3,evidence:[{quote:input.original,explanation:'현재 발화 원문'}]},
          irony:{label:'unlikely',evidence:[]},negation:{label:'none',resolvedMeaning:'부정 없음',evidence:[]},needsReview:false,
          rubricScores:input.rubric.map((r:any)=>({id:r.id,score:3,reason:'원문에 구체적인 단서가 있음',evidence:[{quote:input.original,explanation:'현재 발화'}]})),
          language:{keywords:[input.original.slice(0,8)],expressions:[]},
        })}}]});
      }
      return Response.json({choices:[{message:{content:JSON.stringify({action:input.activeImagePrompt?'EDIT_ACTIVE':'START_NEW_THEME',themeTitle:'저장 검증',imagePrompt:input.transcript})}}]});
    },
  });
  const mf=new Miniflare(options);
  const origin='http://localhost:8787';
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;await applyMigrations(db);
    const bucket=await mf.getR2Bucket('IMAGES');
    const endpoint=await mf.getWorker() as unknown as {fetch:(url:string,init?:RequestInit)=>Promise<Response>};
    async function request(path:string,method='GET',data?:unknown,cookie=''){
      return endpoint.fetch(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    }
    async function value(response:any){const result=await response.json();expect(response.status,JSON.stringify(result)).toBeLessThan(300);return result as any;}
    const cookieOf=(response:any)=>response.headers.get('Set-Cookie')!.split(';')[0];
    const teacherLogin=await request('/api/login','POST',{teacherPassword:'workerd-synthetic-password-only-123456'});await value(teacherLogin);const teacher=cookieOf(teacherLogin);
    const roster=Array.from({length:30},(_,i)=>({grade:6,classNumber:4,studentNumber:i+1,name:'부하예시'+(i+1)}));
    const credentials:any[]=[];
    for(let i=0;i<roster.length;i+=25)credentials.push(...(await value(await request('/api/admin/students','POST',{students:roster.slice(i,i+25)},teacher))).credentials);
    expect(new Set(credentials.map(s=>s.password)).size).toBe(30);
    const loginStart=performance.now();
    const students=await Promise.all(credentials.map(async(s)=>{const response=await request('/api/login','POST',s);await value(response);return{...s,cookie:cookieOf(response)};}));
    const loginMs=performance.now()-loginStart;
    const c=await value(await request('/api/admin/classes','POST',{name:'6학년 검증',grade:6,classNumber:4},teacher));
    const a=await value(await request('/api/admin/activities','POST',{classId:c.id,title:'30명 동시 저장',unit:'검증',commandLimit:3,opensAt:Date.now()-60000,closesAt:Date.now()+3600000,rubric:DEFAULT_RUBRIC},teacher));
    await Promise.all(students.map(async(s)=>value(await request(`/api/activities/${a.id}/join`,'POST',{},s.cookie))));
    const start=performance.now();const latencies:number[]=[];
    const events=await Promise.all(students.map(async(s)=>{const started=performance.now();const response=await request(`/api/activities/${a.id}/commands`,'POST',{requestId:crypto.randomUUID(),transcript:`노란 모자를 쓴 고양이 ${s.studentNumber}마리를 나무 왼쪽에 그려 줘.`,inputMethod:'text',styleId:'illustration'},s.cookie);const result=await value(response);latencies.push(performance.now()-started);return result.eventId;}));
    // Miniflare's automatic consumer is serial. Exercise five additional real
    // job Objects beside it, matching the deployed six-job ceiling. D1 leases
    // and R2 checkpoints prevent duplicate calls when original messages arrive.
    const namespace=await mf.getDurableObjectNamespace('TASKS');
    await Promise.all(events.slice(-5).map(async eventId=>{
      const object=namespace.get(namespace.idFromName(`event:${eventId}`)) as unknown as {fetch:(url:string,init?:RequestInit)=>Promise<Response>};
      const response=await object.fetch('https://tasks.internal/internal/job',{method:'POST',body:JSON.stringify({stage:'generation',eventId})});
      expect(response.ok).toBe(true);await response.arrayBuffer();
    }));
    async function waitFor(sqlText:string,expected:number){
      const deadline=Date.now()+60000;
      while(Date.now()<deadline){const row=await db.prepare(sqlText).first<{n:number}>();if(row?.n===expected)return;await delay(100);}
      throw new Error('Timed out: '+sqlText);
    }
    await waitFor("SELECT COUNT(*) n FROM events WHERE status='succeeded' AND analysis_status='completed'",30);
    const firstPhaseMs=performance.now()-start;
    expect((await db.prepare('SELECT COUNT(*) n FROM images').first<any>()).n).toBe(30);
    for(const s of students){
      const workspace=await value(await request('/api/workspace?activityId='+a.id,'GET',undefined,s.cookie));
      const saved=await request(workspace.images[0].imageUrl,'GET',undefined,s.cookie);
      expect(createHash('sha256').update(new Uint8Array(await saved.arrayBuffer())).digest('hex')).toBe(checksum);
      const analysis=JSON.parse(workspace.events[0].analysis_json);expect(analysis.language.engine).toBe('openrouter-ko-evidence');expect(analysis.morphology).toBeUndefined();
    }
    const uploaded=await Promise.all(students.map(async(s)=>{
      const uploadId=crypto.randomUUID();
      for(let attempt=0;attempt<60;attempt++){
        let response:Response;
        try { response=await endpoint.fetch(origin+`/api/activities/${a.id}/uploads`,{method:'POST',headers:{Origin:origin,Cookie:s.cookie,'Content-Type':'image/png','X-Upload-ID':uploadId,'X-File-Name':encodeURIComponent('합성-검증.png')},body:image}); }
        catch { await delay(100+attempt*10);continue; }
        if(response.status===429||response.status===409){await response.arrayBuffer();await delay(100+attempt*10);continue;}
        return value(response);
      }
      throw new Error('Upload did not finish');
    }));
    expect(uploaded).toHaveLength(30);
    await Promise.all(students.map(async(s,i)=>{await value(await request('/api/images/'+uploaded[i].imageId,'DELETE',undefined,s.cookie));}));
    const s=students[0];const firstId=events[0];
    await value(await request('/api/images/'+firstId+'/activate','POST',{},s.cookie));
    await value(await request(`/api/activities/${a.id}/commands`,'POST',{requestId:crypto.randomUUID(),transcript:'고양이의 모자를 파랗게 수정해 줘.',inputMethod:'text',styleId:'watercolor'},s.cookie));
    await waitFor("SELECT COUNT(*) n FROM events WHERE kind='command' AND status='succeeded' AND analysis_status='completed'",31);
    const edited=await db.prepare('SELECT * FROM images WHERE parent_image_id=?').bind(firstId).first<any>();expect(edited).not.toBeNull();
    await value(await request('/api/images/'+edited.id,'DELETE',undefined,s.cookie));
    const finalLogs=await db.prepare('SELECT * FROM events ORDER BY created_at').all<any>();expect(finalLogs.results).toHaveLength(61);
    expect((await db.prepare('SELECT COUNT(*) n FROM images').first<any>()).n).toBe(61);
    expect((await db.prepare("SELECT COUNT(*) n FROM images WHERE hidden_at IS NOT NULL").first<any>()).n).toBe(31);
    expect((await db.prepare('SELECT COUNT(*) n FROM image_actions').first<any>()).n).toBe(93);
    for(const row of (await db.prepare('SELECT object_key FROM images').all<any>()).results){const saved=await bucket.get(row.object_key);expect(saved).not.toBeNull();expect(createHash('sha256').update(new Uint8Array(await saved!.arrayBuffer())).digest('hex')).toBe(checksum);}
    const counted=await db.prepare('SELECT byte_size,object_count FROM storage_totals WHERE id=1').first<any>();expect(counted.byte_size).toBe(61*image.byteLength);expect(counted.object_count).toBe(61);
    expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(6);
    const foreign=await request('/api/images/'+firstId,'GET',undefined,students[1].cookie);expect(foreign.status).toBe(404);await foreign.arrayBuffer();
    latencies.sort((x,y)=>x-y);
    const report={checkedAt:new Date().toISOString(),students:30,loginMs:Math.round(loginMs),accepted:30,acceptP95Ms:Math.round(latencies[28]),generationAndAnalysisMs:Math.round(firstPhaseMs),generatedAndEdited:31,uploads:30,persistedLogs:61,persistedImages:61,imageActions:93,hiddenImagesStillStored:31,imageBytesEach:image.byteLength,verifiedTotalImageBytes:counted.byte_size,imageCalls,analysisCalls,observedLocalProviderConcurrency:peak,provider:'synthetic mock, no external requests',runtime:'all API and job handlers in actual workerd + SQLite Durable Objects + local Queues + D1/R2',limits:'Does not emulate production account quotas or prove remote Free CPU compliance'};
    writeFileSync('output/workerd-load-results.json',JSON.stringify(report,null,2));
  }finally{await mf.dispose();}
},180000);
