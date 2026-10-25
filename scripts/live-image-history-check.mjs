// Explicit paid, localhost-only verification using the synthetic account.
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
assert(process.argv.includes('--paid'),'Pass --paid to generate one real poster');
assert(process.env.LIVE_STUDENT_PASSWORD,'Set LIVE_STUDENT_PASSWORD for the synthetic local account');
const origin='http://127.0.0.1:8787';
let cookie='';
async function call(path,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(path==='/api/login'&&response.ok)cookie=response.headers.get('set-cookie').split(';')[0];
  const data=await response.json();assert(response.ok,`Local API ${response.status}: ${data.code||''}`);return data;
}
await call('/api/login',{grade:5,classNumber:2,studentNumber:99,name:'실제API검증학생',password:process.env.LIVE_STUDENT_PASSWORD});
const {activities,genres}=await call('/api/activities');const activity=activities.find(a=>a.opens_at<=Date.now()&&a.closes_at>Date.now());assert(activity);
let workspace=await call(`/api/activities/${activity.id}/join`,{});assert(!workspace.pending);assert(workspace.used<workspace.limit);
const usedBefore=workspace.used;const bytes=await readFile('output/live-generate.jpg');
const uploadResponse=await fetch(`${origin}/api/activities/${activity.id}/uploads`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'image/jpeg','X-Upload-ID':randomUUID(),'X-File-Name':encodeURIComponent('검증용 고양이 원본.jpg')},body:bytes});
assert.equal(uploadResponse.status,201);const {imageId:uploadedId}=await uploadResponse.json();
workspace=await call(`/api/workspace?activityId=${activity.id}`);assert.equal(workspace.used,usedBefore);
await call('/api/images/'+uploadedId,{},'DELETE');
const originalResponse=await fetch(origin+'/api/images/'+uploadedId,{headers:{Cookie:cookie}});assert.equal(originalResponse.status,200);const original=Buffer.from(await originalResponse.arrayBuffer());assert(original.equals(bytes));
await call('/api/images/'+uploadedId+'/activate',{});
const started=Date.now();
const transcript='업로드한 그림의 고양이와 파란 우산을 유지한 광고 포스터로 수정해 줘. 위쪽에는 한글로 "비 오는 날도 즐거워"라고 크고 또렷하게 쓰고, 아래쪽에는 "상상을 펼쳐요"라고 써 줘. 이 두 문구 외에는 글자를 넣지 마.';
const {eventId}=await call(`/api/activities/${activity.id}/commands`,{requestId:randomUUID(),transcript,inputMethod:'text',styleId:'poster'});console.log(JSON.stringify({stage:'accepted',eventId,uploadedImageId:uploadedId}));
let event;let lastLog=0;
while(Date.now()-started<600000){
  workspace=await call(`/api/workspace?activityId=${activity.id}`);event=workspace.events.find(e=>e.id===eventId);
  if(Date.now()-lastLog>15000){console.log(JSON.stringify({stage:event.status,analysis:event.analysis_status,seconds:Math.round((Date.now()-started)/1000)}));lastLog=Date.now();}
  if(!['queued','processing'].includes(event.status)&&['completed','failed'].includes(event.analysis_status))break;
  await new Promise(resolve=>setTimeout(resolve,2500));
}
assert.equal(event.status,'succeeded',event.error_code||'Image incomplete');assert.equal(event.analysis_status,'completed');
const image=workspace.images.find(i=>i.id===event.image_id);assert.equal(image.parent_image_id,uploadedId);
await call('/api/images/'+image.id+'/pin',{});
await call('/api/images/'+uploadedId+'/activate',{});
const response=await fetch(origin+image.imageUrl,{headers:{Cookie:cookie}});assert.equal(response.status,200);
const resultBytes=Buffer.from(await response.arrayBuffer());await writeFile('output/live-korean-poster.jpg',resultBytes);
const actions=await call(`/api/activities/${activity.id}/image-actions`);const own=actions.rows.filter(a=>[uploadedId,image.id].includes(a.image_id));
for(const action of ['upload','hide','activate','edit','pin'])assert(own.some(a=>a.action===action));
const report={checkedAt:new Date().toISOString(),environment:'local-workerd-D1-R2',provider:'real-openrouter',model:'openai/gpt-image-2',durationMs:Date.now()-started,uploadedImageId:uploadedId,generatedImageId:image.id,originalBytesPreserved:true,originalSha256:createHash('sha256').update(bytes).digest('hex'),uploadDoesNotConsumeUtterance:true,parentImageLinked:true,analysisCompleted:true,actions:own.map(a=>({id:a.id,action:a.action,imageId:a.image_id,at:a.created_at})),requestedLettering:['비 오는 날도 즐거워','상상을 펼쳐요'],imageFile:'output/live-korean-poster.jpg',genres:genres.map(g=>g.name)};
await writeFile('output/live-image-history-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
