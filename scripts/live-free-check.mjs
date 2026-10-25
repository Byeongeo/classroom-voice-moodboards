// Opt-in PAID smoke test. Only synthetic identities/text; never print credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

assert(process.argv.includes('--paid'), 'Pass --paid explicitly to call OpenRouter');
const origin = process.env.LIVE_BASE_URL || 'http://127.0.0.1:8787';
const settings = await readFile('.dev.vars', 'utf8');
const teacherPassword = settings.split(/\r?\n/).find(line => /^\s*TEACHER_PASSWORD\s*=/.test(line))?.replace(/^\s*TEACHER_PASSWORD\s*=\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
assert(teacherPassword && !teacherPassword.startsWith('replace-'), 'Set TEACHER_PASSWORD in .dev.vars');
await mkdir('output', { recursive: true });
async function api(path, method='GET', data, cookie='') {
  const response = await fetch(origin+path, { method, headers:{ Origin:origin, ...(cookie?{Cookie:cookie}:{}), ...(data===undefined?{}:{'Content-Type':'application/json'}) }, ...(data===undefined?{}:{body:JSON.stringify(data)}) });
  const value = await response.json();
  assert(response.ok, `${path}: ${response.status} ${value.code || 'HTTP_ERROR'}`);
  return { value, cookie:response.headers.get('Set-Cookie')?.split(';')[0] };
}
const teacher=(await api('/api/login','POST',{teacherPassword})).cookie;
const overview=(await api('/api/admin/overview','GET',undefined,teacher)).value;
const used=new Set(overview.students.filter(s=>s.grade===12&&s.class_number===49).map(s=>s.student_number));
const number=Array.from({length:100},(_,i)=>i+1).find(n=>!used.has(n));assert(number,'Synthetic room is full');
const identity={grade:12,classNumber:49,studentNumber:number,name:'무료구성검증'+number};
const registered=(await api('/api/admin/students','POST',{students:[identity]},teacher)).value;
const student=(await api('/api/login','POST',registered.credentials[0])).cookie;
const me=(await api('/api/me','GET',undefined,student)).value;
const classroom=(await api('/api/admin/classes','POST',{name:'무료 구성 API 검증 '+new Date().toISOString(),rooms:[]},teacher)).value;
let activity;
try {
  activity=(await api('/api/admin/activities','POST',{classId:classroom.id,title:'OpenRouter 통합 검증',unit:'합성 자료',opensAt:Date.now()-60000,closesAt:Date.now()+3600000,commandLimit:2,assignment:{mode:'custom',rooms:[],students:[{studentId:me.student.id,access:true}]}},teacher)).value;
  await api(`/api/activities/${activity.id}/join`,'POST',{},student);
  const runs=[];
  for(const [index,text] of [
    '수채화로 빨간 우비를 입은 오리 두 마리가 작은 연못 오른쪽에 서 있는 장면을 그려 줘.',
    '오리 두 마리와 연못은 유지하고, 우비를 파란색으로 바꿔 줘.',
  ].entries()) {
    const started=Date.now();const requestId=randomUUID();
    const event=(await api(`/api/activities/${activity.id}/commands`,'POST',{requestId,transcript:text,inputMethod:'text',styleId:'watercolor'},student)).value;
    const deadline=Date.now()+240000;let workspace,record;
    while(Date.now()<deadline) {
      workspace=(await api('/api/workspace?activityId='+activity.id,'GET',undefined,student)).value;
      record=workspace.events.find(e=>e.id===event.eventId);
      if(record&&['failed','ignored','discarded'].includes(record.status))throw new Error('Generation: '+record.status+' '+record.error_code);
      if(record?.status==='succeeded'&&['completed','failed'].includes(record.analysis_status))break;
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    assert(record?.status==='succeeded'&&record.analysis_status==='completed','Generation/analysis did not complete');
    const image=workspace.images.find(i=>i.id===record.image_id);assert(image,'Image metadata missing');
    const response=await fetch(origin+image.imageUrl,{headers:{Cookie:student}});assert(response.ok,'Stored image unavailable');
    const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length===image.byte_size,'Stored size mismatch');
    const analysis=JSON.parse(record.analysis_json);assert(analysis.language?.engine==='openrouter-ko-evidence'&&!analysis.morphology,'Unexpected analysis engine');
    const duplicate=(await api(`/api/activities/${activity.id}/commands`,'POST',{requestId,transcript:text,inputMethod:'text',styleId:'watercolor'},student)).value;assert(duplicate.eventId===event.eventId,'Duplicate command');
    if(index===1)assert(image.parent_image_id===runs[0].imageId,'Edit parent missing');
    await writeFile(`output/live-free-${index===0?'generate':'edit'}.${image.mime_type.split('/')[1]}`,bytes);
    runs.push({eventId:record.id,imageId:image.id,parentImageId:image.parent_image_id,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),durationMs:Date.now()-started,analysis});
    console.log(JSON.stringify({stage:index===0?'generate':'edit',stored:true,bytes:bytes.length,durationMs:Date.now()-started,engine:analysis.language.engine}));
  }
  await api('/api/images/'+runs[1].imageId+'/pin','POST',{},student);
  await api('/api/images/'+runs[1].imageId,'DELETE',undefined,student);
  for(const run of runs){const response=await fetch(origin+'/api/images/'+run.imageId,{headers:{Cookie:student}});assert(response.ok);assert(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')===run.sha256,'Original changed');}
  const history=(await api(`/api/activities/${activity.id}/image-actions`,'GET',undefined,student)).value;
  assert(['generate','edit','pin','hide'].every(action=>history.rows.some(row=>row.action===action)),'Missing immutable actions');
  await writeFile('output/live-free-check.json',JSON.stringify({checkedAt:new Date().toISOString(),runtime:'local Wrangler + SQLite Durable Objects + local Queues/D1/R2',provider:'real OpenRouter',note:'Two synthetic image requests; not a 30-user live API benchmark.',runs,imageActions:history.rows.length},null,2));
  console.log(JSON.stringify({complete:true,hiddenImagesStillReadable:true,immutableActions:history.rows.length}));
}finally{
  if(activity)await api('/api/admin/activities/'+activity.id,'DELETE',undefined,teacher);
  await api('/api/admin/classes/'+classroom.id,'DELETE',undefined,teacher);
}
