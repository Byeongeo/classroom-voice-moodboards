// Opt-in PAID production check. Creates synthetic identities only. No secrets in reports.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

assert(process.argv.includes('--paid'), 'Pass --paid explicitly: this calls OpenRouter for 31 images and analyses.');
const origin = process.env.LIVE_BASE_URL;
assert(origin && new URL(origin).protocol === 'https:', 'Set LIVE_BASE_URL to your deployed HTTPS app.');
const settings = await readFile('.dev.vars', 'utf8');
const teacherPassword = settings.split(/\r?\n/).find(line => /^\s*TEACHER_PASSWORD\s*=/.test(line))?.replace(/^\s*TEACHER_PASSWORD\s*=\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
assert(teacherPassword && !teacherPassword.startsWith('replace-'), 'Configure TEACHER_PASSWORD privately.');
await mkdir('output', { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const progress = value => console.log(JSON.stringify(value));
const report = { checkedAt: new Date().toISOString(), origin, provider: 'real OpenRouter', runtime: 'deployed Cloudflare Workers Free + SQLite Durable Objects + Queues + D1 + private R2', students: 30 };
async function api(path, method = 'GET', data, cookie = '') {
  const response = await fetch(origin + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  assert(response.ok, `${path}: ${response.status} ${value.code || 'HTTP_ERROR'}`);
  return { value, cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
}
function fixtureImage() {
  function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
  function chunk(type, bytes) { const tag = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, bytes]))); return Buffer.concat([size, tag, bytes, crc]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(512 * 1537); let seed = 1831565813;
  for (let y = 0; y < 512; y++) for (let x = 1; x <= 1536; x++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[y * 1537 + x] = seed & 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const teacher = (await api('/api/login', 'POST', { teacherPassword })).cookie;
const overview = (await api('/api/admin/overview', 'GET', undefined, teacher)).value;
const classNumber = Array.from({ length: 50 }, (_, i) => 50 - i).find(n => !overview.students.some(s => s.grade === 12 && s.class_number === n));
assert(classNumber, 'No unused synthetic classroom available.');
const roster = Array.from({ length: 30 }, (_, i) => ({ grade: 12, classNumber, studentNumber: i + 1, name: '합성부하검증' + (i + 1) }));
const credentials = [];
for (let i = 0; i < 30; i += 25) credentials.push(...(await api('/api/admin/students', 'POST', { students: roster.slice(i, i + 25) }, teacher)).value.credentials);
assert.equal(new Set(credentials.map(c => c.password)).size, 30);
const loginStart = Date.now();
const students = await Promise.all(credentials.map(async c => ({ ...c, cookie: (await api('/api/login', 'POST', c)).cookie })));
report.loginAllMs = Date.now() - loginStart;
const classroom = (await api('/api/admin/classes', 'POST', { name: '클라우드 30명 동시 검증 ' + report.checkedAt, rooms: [] }, teacher)).value;
let activity;
try {
  activity = (await api('/api/admin/activities', 'POST', { classId: classroom.id, title: '실제 클라우드 저장 검증', unit: '합성 자료', opensAt: Date.now() - 60000, closesAt: Date.now() + 3600000, commandLimit: 3, assignment: { mode: 'custom', rooms: [{ grade: 12, classNumber }], students: [] } }, teacher)).value;
  report.activityId = activity.id;
  await Promise.all(students.map(s => api(`/api/activities/${activity.id}/join`, 'POST', {}, s.cookie)));
  const started = Date.now();
  const requests = students.map((_, i) => ({ requestId: randomUUID(), transcript: ['노란', '빨간', '파란', '초록', '보라색'][i % 5] + ' 모자를 쓴 고양이 한 마리가 큰 나무 왼쪽의 잔디밭에 앉아 있는 장면을 수채화로 그려 줘.', inputMethod: 'text', styleId: 'watercolor' }));
  const accepted = await Promise.all(students.map(async (s, i) => { const at = Date.now(); const value = (await api(`/api/activities/${activity.id}/commands`, 'POST', requests[i], s.cookie)).value; return { ...value, acceptMs: Date.now() - at }; }));
  const latencies = accepted.map(e => e.acceptMs).sort((a, b) => a - b);
  report.accepted = accepted.length; report.acceptP95Ms = latencies[28]; report.acceptMaxMs = latencies[29];
  await writeFile('output/live-cloud-load-results.json', JSON.stringify({ ...report, phase: 'accepted' }, null, 2));
  progress({ phase: 'accepted', students: 30, loginAllMs: report.loginAllMs, acceptP95Ms: report.acceptP95Ms });
  async function waitForEvents(ids, timeoutMs = 900000) {
    const until = Date.now() + timeoutMs; let last = '', nextLog = 0;
    while (Date.now() < until) {
      const analytics = (await api('/api/admin/analytics?activityId=' + activity.id, 'GET', undefined, teacher)).value;
      const rows = analytics.events.filter(e => ids.includes(e.id));
      const completed = rows.filter(e => e.status === 'succeeded' && e.analysis_status === 'completed').length;
      const failed = rows.filter(e => ['failed', 'ignored', 'discarded'].includes(e.status) || e.analysis_status === 'failed');
      const processing = rows.filter(e => e.status === 'processing').length;
      report.observedProcessingPeak = Math.max(report.observedProcessingPeak || 0, processing);
      const state = `${completed}:${processing}:${failed.length}`;
      if (state !== last || Date.now() >= nextLog) { progress({ phase: 'jobs', completed, total: ids.length, processing, failed: failed.map(e => ({ id: e.id, status: e.status, code: e.error_code, analysis: e.analysis_status })), elapsedMs: Date.now() - started }); last = state; nextLog = Date.now() + 20000; }
      if (failed.length) await writeFile('output/live-cloud-job-failures.json', JSON.stringify(failed, null, 2));
      assert.equal(failed.length, 0, 'Generation or analysis failed; inspect private output/live-cloud-job-failures.json.');
      if (completed === ids.length) return analytics;
      await delay(5000);
    }
    throw new Error('Production queue did not finish in the allotted time.');
  }
  await waitForEvents(accepted.map(e => e.eventId));
  report.first30CompletedMs = Date.now() - started;
  const files = [];
  for (const [i, s] of students.entries()) {
    const workspace = (await api('/api/workspace?activityId=' + activity.id, 'GET', undefined, s.cookie)).value;
    const event = workspace.events.find(e => e.id === accepted[i].eventId);
    assert.equal(event.transcript, requests[i].transcript);
    const analysis = JSON.parse(event.analysis_json); assert.equal(analysis.language.engine, 'openrouter-ko-evidence');
    const image = workspace.images.find(image => image.id === event.image_id); assert(image);
    const response = await fetch(origin + image.imageUrl, { headers: { Cookie: s.cookie } }); assert(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, image.byte_size);
    if (i === 0) await writeFile('output/live-cloud-generated.jpeg', bytes);
    files.push({ imageId: image.id, bytes: bytes.length, sha256: hash(bytes), studentIndex: i, kind: 'generated' });
  }
  const duplicate = (await api(`/api/activities/${activity.id}/commands`, 'POST', requests[0], students[0].cookie)).value;
  assert.equal(duplicate.eventId, accepted[0].eventId);
  const foreign = await fetch(origin + '/api/images/' + files[0].imageId, { headers: { Cookie: students[1].cookie } }); assert.equal(foreign.status, 404); await foreign.arrayBuffer();
  const anonymous = await fetch(origin + '/api/images/' + files[0].imageId); assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  const uploadBytes = fixtureImage(), uploadHash = hash(uploadBytes); const uploadStart = Date.now(); let busyResponses = 0;
  const uploaded = await Promise.all(students.map(async (s, i) => {
    const uploadId = randomUUID();
    for (let attempt = 0; attempt < 35; attempt++) {
      let response;
      try { response = await fetch(origin + `/api/activities/${activity.id}/uploads`, { method: 'POST', headers: { Origin: origin, Cookie: s.cookie, 'Content-Type': 'image/png', 'X-Upload-ID': uploadId, 'X-File-Name': encodeURIComponent('합성-클라우드-검증.png') }, body: uploadBytes }); }
      catch { await delay(1000 + attempt * 500 + i * 40); continue; }
      if ([409, 429, 503].includes(response.status)) { busyResponses++; await response.arrayBuffer(); await delay(1000 + attempt * 500 + i * 40); continue; }
      const value = await response.json(); assert(response.ok, `Upload ${i}: ${response.status} ${value.code}`); return value;
    }
    throw new Error('Upload retries exceeded.');
  }));
  report.uploadAllMs = Date.now() - uploadStart; report.uploadBusyResponses = busyResponses;
  files.push(...uploaded.map((u, i) => ({ imageId: u.imageId, bytes: uploadBytes.length, sha256: uploadHash, studentIndex: i, kind: 'upload' })));
  progress({ phase: 'uploads', saved: uploaded.length, bytesEach: uploadBytes.length, durationMs: report.uploadAllMs, retriedBusyResponses: busyResponses });
  await Promise.all(students.map((s, i) => api('/api/images/' + uploaded[i].imageId, 'DELETE', undefined, s.cookie)));
  await api('/api/images/' + files[0].imageId + '/activate', 'POST', {}, students[0].cookie);
  const edit = (await api(`/api/activities/${activity.id}/commands`, 'POST', { requestId: randomUUID(), transcript: '고양이 한 마리와 큰 나무의 위치는 그대로 두고 모자 색을 분홍색으로 바꿔 줘.', inputMethod: 'text', styleId: 'watercolor' }, students[0].cookie)).value;
  await waitForEvents([edit.eventId]);
  const editedWorkspace = (await api('/api/workspace?activityId=' + activity.id, 'GET', undefined, students[0].cookie)).value;
  const edited = editedWorkspace.images.find(i => i.id === edit.eventId); assert.equal(edited.parent_image_id, files[0].imageId);
  const editedResponse = await fetch(origin + edited.imageUrl, { headers: { Cookie: students[0].cookie } }); assert(editedResponse.ok);
  const editedBytes = Buffer.from(await editedResponse.arrayBuffer()); assert.equal(editedBytes.length, edited.byte_size);
  files.push({ imageId: edited.id, bytes: editedBytes.length, sha256: hash(editedBytes), studentIndex: 0, kind: 'edit' });
  await writeFile('output/live-cloud-edited.jpeg', editedBytes);
  await api('/api/images/' + edited.id, 'DELETE', undefined, students[0].cookie);
  for (const file of files) {
    const response = await fetch(origin + '/api/images/' + file.imageId, { headers: { Cookie: students[file.studentIndex].cookie } }); assert(response.ok);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256);
  }
  const analytics = (await api('/api/admin/analytics?activityId=' + activity.id, 'GET', undefined, teacher)).value;
  assert.equal(analytics.events.length, 61); assert.equal(analytics.imageActions.length, 93);
  const usage = (await api('/api/admin/overview', 'GET', undefined, teacher)).value.storage;
  assert.equal(usage.bytes - overview.storage.bytes, files.reduce((sum, f) => sum + f.bytes, 0));
  report.persistedLogs = 61; report.persistedImages = files.length; report.imageActions = 93; report.hiddenOriginalsVerified = 31; report.verifiedImageBytes = files.reduce((sum, f) => sum + f.bytes, 0); report.files = files;
  report.accessIsolation = true; report.duplicateRequestPrevented = true;
  const backup = (await api('/api/admin/backups', 'POST', {}, teacher)).value;
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const item = (await api('/api/admin/overview', 'GET', undefined, teacher)).value.backups.find(b => b.id === backup.id);
    assert(item && item.status !== 'failed', 'Backup failed.');
    if (item.status === 'ready') break;
    progress({ phase: 'backup', status: item.status, copied: item.copied_count, total: item.image_count }); await delay(10000);
  }
  const manifest = (await api(`/api/admin/backups/${backup.id}/manifest`, 'GET', undefined, teacher)).value;
  for (const file of files) {
    const entry = manifest.files.find(f => f.name.startsWith('images/' + file.imageId + '.')); assert(entry);
    const response = await fetch(origin + entry.url, { headers: { Cookie: teacher } }); assert(response.ok);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256);
  }
  report.backupId = backup.id; report.backupImageHashesVerified = 61; report.completedAt = new Date().toISOString(); report.totalMs = Date.now() - started; report.success = true;
  await writeFile('output/live-cloud-load-results.json', JSON.stringify(report, null, 2));
  progress({ phase: 'complete', success: true, logs: 61, images: 61, actions: 93, backupHashes: 61, first30CompletedMs: report.first30CompletedMs, totalMs: report.totalMs });
} catch (error) {
  await writeFile('output/live-cloud-load-results.json', JSON.stringify({ ...report, success: false, error: error.message }, null, 2));
  throw error;
} finally {
  if (activity) await api('/api/admin/activities/' + activity.id, 'DELETE', undefined, teacher);
  await api('/api/admin/classes/' + classroom.id, 'DELETE', undefined, teacher);
}
