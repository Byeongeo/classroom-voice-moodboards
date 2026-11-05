import { cloudflare, CloudflareError, cloudflareMessage } from './cloudflare';

export interface InstallInput {
  token: string;
  account: string;
  openRouterKey: string;
  teacherPassword: string;
}

export type InstallEvent =
  | { type: 'step'; step: number; message: string }
  | { type: 'done'; url: string; verified: boolean }
  | { type: 'error'; message: string; resourcePrefix?: string };

interface Template {
  manifest: Record<string, { hash: string; size: number }>;
  contentTypes: Record<string, string>;
  migrations: { name: string; statements: string[] }[];
  metadata: object;
  assetConfig: object;
  vars: Record<string, string>;
  crons: { cron: string }[];
  consumer: object;
}

type TemplateFile = (filename: string) => Promise<Response>;
type AccountCall = <T = unknown>(path: string, method?: string, body?: object, uploadToken?: string) => Promise<T>;
export const accountId = /^[a-f0-9]{32}$/;
const databaseId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const subdomainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

async function uploadAssets(call: AccountCall, workerPath: string, files: TemplateFile, template: Template) {
  const session = await call<{ jwt: string; buckets: string[][] }>(
    workerPath + '/assets-upload-session', 'POST', { manifest: template.manifest },
  );
  let completion = session.buckets.length === 0 ? session.jwt : '';
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      if (!Object.hasOwn(template.contentTypes, hash)) throw new Error('Unknown asset');
      const encoded = await (await files(hash + '.txt')).text();
      form.append(hash, new Blob([encoded], { type: template.contentTypes[hash] }), hash);
    }
    const result = await call<{ jwt?: string }>('/workers/assets/upload?base64=true', 'POST', form, session.jwt);
    if (result.jwt) completion = result.jwt;
  }
  if (!completion) throw new Error('Missing upload completion');
  return completion;
}

async function verifyAddress(url: string) {
  for (const delay of [0, 1_500, 3_000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url + 'api/health', {
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5_000),
      });
      if (response.ok && (await response.json<{ status?: string }>()).status === 'ok') return true;
      await response.body?.cancel().catch(() => {});
    } catch { /* The workers.dev address may still be propagating. */ }
  }
  return false;
}

export async function install(input: InstallInput, files: TemplateFile, emit: (event: InstallEvent) => void) {
  const { token, account, openRouterKey, teacherPassword } = input;
  const api = cloudflare(token);
  const call: AccountCall = (path, method, body, uploadToken) => api('/accounts/' + account + path, method, body, uploadToken);
  const name = 'voice-classroom-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const workerPath = '/workers/scripts/' + name;
  const bucketPath = '/r2/buckets/' + name;
  const jobs = name + '-jobs';
  const deadLetter = name + '-dlq';
  const created: string[] = [];
  let attemptedWrite = false;
  let fallback = '설치 파일을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  try {
    emit({ type: 'step', step: 1, message: '계정과 R2 이미지 저장소 사용 가능 여부 확인 중' });
    const template = await (await files('package.json')).json<Template>();
    const worker = await (await files('worker.txt')).blob();
    fallback = 'R2를 사용할 수 없습니다. 선택한 계정의 R2 화면에서 활성화를 완료한 뒤 다시 시도해 주세요.';
    await call('/r2/buckets?per_page=1');
    fallback = 'Workers 주소를 확인하지 못했습니다. 선택한 계정과 Workers Scripts 권한을 확인해 주세요.';
    const subdomainPath = '/workers/subdomain';
    let address = await call<{ subdomain?: string }>(subdomainPath).catch(error => {
      if (error instanceof CloudflareError && (error.status === 404 || error.codes.includes(10007))) return null;
      throw error;
    });
    if (!address?.subdomain) address = await call<{ subdomain?: string }>(subdomainPath, 'PUT', { subdomain: name });
    const subdomain = address.subdomain;
    if (!subdomain || !subdomainLabel.test(subdomain)) throw new Error('Missing subdomain');
    const scriptExists = await call(workerPath + '/settings').then(() => true, error => {
      if (error instanceof CloudflareError && error.status === 404) return false;
      throw error;
    });
    if (scriptExists) throw new Error('Worker already exists');

    emit({ type: 'step', step: 2, message: '새 데이터베이스와 비공개 이미지 저장소 만드는 중' });
    fallback = '저장소를 만들지 못했습니다. D1과 R2 권한, 계정의 리소스 한도를 확인하세요.';
    attemptedWrite = true;
    await call('/r2/buckets', 'POST', { name, storage_class: 'Standard' });
    created.push(bucketPath);
    const database = await call<{ uuid: string }>('/d1/database', 'POST', { name });
    if (!databaseId.test(database.uuid)) throw new Error('Invalid database ID');
    const dbPath = '/d1/database/' + database.uuid;
    created.push(dbPath);
    const query = (batch: { sql: string; params?: string[] }[]) =>
      call<{ success: boolean }[]>(dbPath + '/query', 'POST', { batch }).then(result => {
        if (!result.every(statement => statement.success)) throw new Error('D1 migration failed');
      });
    await query([{ sql: 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)' }]);
    for (const migration of template.migrations) {
      await query([
        ...migration.statements.map(sql => ({ sql })),
        { sql: 'INSERT INTO d1_migrations (name) VALUES (?)', params: [migration.name] },
      ]);
    }

    fallback = '이미지 작업 큐를 만들지 못했습니다. Queues 권한과 계정의 리소스 한도를 확인하세요.';
    for (const queue_name of [deadLetter, jobs]) {
      const { queue_id } = await call<{ queue_id: string }>('/queues', 'POST', { queue_name });
      if (!accountId.test(queue_id)) throw new Error('Invalid queue ID');
      created.push('/queues/' + queue_id);
    }
    const jobsPath = created.at(-1)!;

    emit({ type: 'step', step: 3, message: '학생·교사 화면 업로드하고 비밀값 등록 중' });
    fallback = '앱 파일을 올리지 못했습니다. Workers Scripts 권한과 계정의 리소스 한도를 확인하세요.';
    const jwt = await uploadAssets(call, workerPath, files, template);
    const form = new FormData();
    form.set('metadata', JSON.stringify({
      ...template.metadata, assets: { jwt, config: template.assetConfig },
      bindings: [
        { type: 'assets', name: 'ASSETS' },
        { type: 'd1', name: 'DB', id: database.uuid },
        { type: 'r2_bucket', name: 'IMAGES', bucket_name: name },
        { type: 'queue', name: 'JOBS', queue_name: jobs },
        { type: 'queue', name: 'DEAD_LETTER_JOBS', queue_name: deadLetter },
        { type: 'durable_object_namespace', name: 'TASKS', class_name: 'ClassroomTasks' },
        { type: 'secret_text', name: 'OPENROUTER_API_KEY', text: openRouterKey },
        { type: 'secret_text', name: 'TEACHER_PASSWORD', text: teacherPassword },
        ...Object.entries(template.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
      ],
    }));
    form.set('index.js', new Blob([worker], { type: 'application/javascript+module' }), 'index.js');
    await call(workerPath, 'PUT', form);
    created.push(workerPath);

    emit({ type: 'step', step: 4, message: '이미지 작업과 자동 실행을 연결하고 접속 주소 확인 중' });
    fallback = '이미지 작업을 연결하지 못했습니다. Workers Scripts와 Queues 권한을 확인하세요.';
    const consumer = await call<{ consumer_id?: string }>(jobsPath + '/consumers', 'POST', {
      type: 'worker', script_name: name, dead_letter_queue: deadLetter, settings: template.consumer,
    });
    if (consumer.consumer_id && accountId.test(consumer.consumer_id)) created.push(jobsPath + '/consumers/' + consumer.consumer_id);
    fallback = '자동 실행 일정 또는 앱 주소를 설정하지 못했습니다. Workers 권한과 계정의 Cron Trigger 여유를 확인하세요.';
    await call(workerPath + '/schedules', 'PUT', template.crons);
    await call(workerPath + '/subdomain', 'POST', { enabled: true, previews_enabled: false });
    const url = `https://${name}.${subdomain}.workers.dev/`;
    emit({ type: 'done', url, verified: await verifyAddress(url) });
  } catch (error) {
    const message = cloudflareMessage(error, fallback);
    let needsInspection = attemptedWrite && error instanceof CloudflareError && error.status === 0;
    if (created.length) emit({ type: 'step', step: 0, message: '설치 중 이번 시도에서 만든 리소스를 정리하는 중' });
    for (const path of created.reverse()) {
      await call(path, 'DELETE').catch(error => {
        if (!(error instanceof CloudflareError) || error.status !== 404) needsInspection = true;
      });
    }
    emit({ type: 'error', message, ...(needsInspection && { resourcePrefix: name }) });
  }
}
