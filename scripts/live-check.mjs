// Explicit, paid integration check using synthetic LOCAL accounts only. Never logs secrets.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const origin = 'http://127.0.0.1:8787';
assert(process.env.LIVE_STUDENT_PASSWORD, 'Set LIVE_STUDENT_PASSWORD for the synthetic local account');
const mode = process.argv[2] || 'inspect';
assert(['inspect', 'generate', 'edit'].includes(mode), 'Use inspect, generate, or edit');
const statePath = 'output/live-check.json';
const vars = Object.fromEntries((await readFile('.dev.vars', 'utf8')).split(/\r?\n/).map(line => {
  const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  return match ? [match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')] : [];
}).filter(row => row.length));

async function login(body) {
  const response = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `Local login failed: ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}
async function api(cookie, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  assert(response.ok, `Local API ${path}: ${response.status} ${data.code || ''}`);
  return data;
}

const teacher = await login({ teacherPassword: vars.TEACHER_PASSWORD });
const overview = await api(teacher, '/api/admin/overview');
if (mode === 'inspect') {
  console.log(JSON.stringify({ activeActivities: overview.activities.filter(a => !a.deleted_at && a.opens_at <= Date.now() && a.closes_at > Date.now()).map(a => ({ id: a.id, title: a.title })), styles: overview.styles.filter(s => s.enabled).map(s => ({ id: s.id, name: s.name })) }));
  process.exit(0);
}
const identity = { grade: 5, classNumber: 2, studentNumber: 99, name: '실제API검증학생', password: process.env.LIVE_STUDENT_PASSWORD };
if (!overview.students.some(s => s.grade === 5 && s.class_number === 2 && s.student_number === 99)) {
  await api(teacher, '/api/admin/students', { students: [identity] });
}
const student = await login(identity);
const { activities } = await api(student, '/api/activities');
const activity = activities.find(a => a.opens_at <= Date.now() && a.closes_at > Date.now());
assert(activity, 'Create an open local activity first');
let workspace = await api(student, `/api/activities/${activity.id}/join`, {});
assert(!workspace.pending, 'A previous command is still processing');
assert(workspace.used < workspace.limit, 'Local verification account has reached its quota');
let report;
try { report = JSON.parse(await readFile(statePath, 'utf8')); } catch { report = { startedAt: new Date().toISOString(), provider: 'real-openrouter', environment: 'local-workerd-D1-R2', runs: [] }; }
if (mode === 'edit') assert(workspace.board.active_image_id, 'Generate an image first');
const parentId = workspace.board.active_image_id;
const transcript = mode === 'generate'
  ? '연한 노란색 배경 한가운데에 파란색 우산을 든 작은 고양이 한 마리가 서 있고, 고양이 오른쪽에는 빨간 튤립 세 송이가 피어 있는 장면을 수채화로 그려줘.'
  : '현재 그림에서 고양이와 파란 우산은 그대로 두고, 오른쪽 빨간 튤립 세 송이를 보라색 다섯 송이로 바꿔줘.';
const requestId = randomUUID();
const started = Date.now();
const { eventId } = await api(student, `/api/activities/${activity.id}/commands`, { requestId, transcript, inputMethod: 'text', styleId: 'watercolor' });
console.log(JSON.stringify({ stage: 'accepted', mode, eventId }));
let event;
let image;
let lastProgress = 0;
while (Date.now() - started < 660000) {
  workspace = await api(student, `/api/workspace?activityId=${activity.id}`);
  event = workspace.events.find(e => e.id === eventId);
  if (Date.now() - lastProgress >= 15000) {
    console.log(JSON.stringify({ stage: 'processing', elapsedSeconds: Math.round((Date.now() - started) / 1000), status: event?.status, analysis: event?.analysis_status }));
    lastProgress = Date.now();
  }
  if (event && !['queued', 'processing'].includes(event.status) && ['completed', 'failed'].includes(event.analysis_status)) break;
  await new Promise(resolve => setTimeout(resolve, 2500));
}
assert(event, 'Event missing from durable log');
assert.equal(event.transcript, transcript);
const duplicate = await api(student, `/api/activities/${activity.id}/commands`, { requestId, transcript, inputMethod: 'text', styleId: 'watercolor' });
assert.equal(duplicate.eventId, eventId);
const run = { mode, eventId, durationMs: Date.now() - started, status: event.status, errorCode: event.error_code, attempts: event.attempts, analysisStatus: event.analysis_status, analysisAttempts: event.analysis_attempts, transcriptStored: true, duplicateRequestIdempotent: true };
if (event.image_id) {
  image = workspace.images.find(i => i.id === event.image_id);
  assert(image && image.event_id === eventId);
  const response = await fetch(origin + image.imageUrl, { headers: { Cookie: student } });
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 1000);
  const mime = response.headers.get('content-type');
  const file = `output/live-${mode}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`;
  await writeFile(file, bytes);
  Object.assign(run, { imageId: image.id, parentImageId: image.parent_image_id, mime, imageBytes: bytes.length, imageFile: file, imageReadAfterStorage: true, frozenStyle: event.style_name });
  if (mode === 'edit') assert.equal(image.parent_image_id, parentId);
}
if (event.analysis_json) {
  const analysis = JSON.parse(event.analysis_json);
  Object.assign(run, { analysis: { engine: analysis.morphology.engine, model: analysis.model, interpretation: analysis.semantic.interpretation, specificity: analysis.semantic.specificity, irony: analysis.semantic.irony, negation: analysis.semantic.negation, needsReview: analysis.semantic.needsReview, score: analysis.score, rubricScores: analysis.semantic.rubricScores } });
}
report.runs.push(run);
await mkdir('output', { recursive: true });
await writeFile(statePath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(run));
assert.equal(event.status, 'succeeded', `Image generation failed: ${event.error_code}`);
assert.equal(event.analysis_status, 'completed', 'Language analysis failed');
assert(image, 'Image missing');
