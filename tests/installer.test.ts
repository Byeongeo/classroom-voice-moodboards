import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import type { InstallEvent } from '../installer/deploy';

it('브라우저 요청으로 새 앱을 설치하고 실패 시 이번에 만든 리소스만 정리한다', async () => {
  const { outputFiles } = await build({
    entryPoints: ['installer/index.ts'], bundle: true, write: false, format: 'esm',
    platform: 'browser', external: ['cloudflare:workers'],
  });
  const origin = 'https://installer.test';
  const account = 'a'.repeat(32);
  const db = 'c10196cf-dda2-4f5d-ab08-ea56c5f6019a';
  const dlq = 'b'.repeat(32);
  const queue = 'c'.repeat(32);
  const hash = 'd'.repeat(32);
  const assetJwt = 'test-assets-only';
  const token = 'cfut_' + 'Z'.repeat(40) + '1'.repeat(8);
  const openRouterKey = 'sk-or-v1-' + 'z'.repeat(64);
  const teacherPassword = 'Test-only-1234';
  const deletes: string[] = [];
  let fails = false;
  let script = '';
  const ok = (result: unknown) => Response.json({ success: true, result });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-10-24',
    durableObjects: { INSTALLER: { className: 'ClassroomInstaller', useSQLite: true } },
    serviceBindings: { ASSETS: async (request: Request) => {
      const filename = new URL(request.url).pathname.split('/').at(-1);
      if (filename === 'package.json') return Response.json({
        manifest: { '/index.html': { hash, size: 2 } }, contentTypes: { [hash]: 'text/html' },
        migrations: [{ name: '0001_test.sql', statements: ['CREATE TABLE fixture (id INTEGER)'] }],
        metadata: { main_module: 'index.js' }, assetConfig: {}, vars: {}, crons: [], consumer: {},
      });
      return new Response(filename === 'worker.txt' ? 'export default {}' : 'b2s=');
    } },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname.endsWith('.workers.dev')) return Response.json({ status: 'ok' });
      expect(url.origin).toBe('https://api.cloudflare.com');
      const path = url.pathname.replace('/client/v4', '');
      const route = path.replace('/accounts/' + account, '');
      expect(request.headers.get('Authorization') === 'Bearer ' + (route === '/workers/assets/upload' ? assetJwt : token)).toBe(true);
      if (request.method === 'DELETE') {
        deletes.push(route);
        return ok({});
      }
      if (route === '/accounts') return ok([{ id: account, name: '연수 시험 계정' }]);
      if (route === '/workers/subdomain') return ok({ subdomain: 'training-test' });
      if (route.endsWith('/settings')) {
        script = route.replace('/settings', '');
        return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
      }
      if (route === '/r2/buckets') return ok({});
      if (route === '/d1/database') return ok({ uuid: db });
      if (route.endsWith('/query')) {
        const body = await request.json() as { batch: unknown[] };
        return ok(body.batch.map(() => ({ success: true })));
      }
      if (route === '/queues') {
        const body = await request.json() as { queue_name: string };
        return ok({ queue_id: body.queue_name.endsWith('-dlq') ? dlq : queue });
      }
      if (route.endsWith('/assets-upload-session')) return ok({ jwt: assetJwt, buckets: [[hash]] });
      if (route === '/workers/assets/upload') {
        expect((await request.formData()).get(hash)?.toString()).toBe('[object File]');
        return ok({ jwt: 'test-completion' });
      }
      if (route === script && request.method === 'PUT') {
        const form = await request.formData();
        expect(JSON.parse(String(form.get('metadata'))).bindings).toEqual(expect.arrayContaining([
          { type: 'secret_text', name: 'OPENROUTER_API_KEY', text: openRouterKey },
          { type: 'secret_text', name: 'TEACHER_PASSWORD', text: teacherPassword },
          { type: 'd1', name: 'DB', id: db },
        ]));
        return ok({});
      }
      if (route.endsWith('/consumers')) return ok({ consumer_id: 'e'.repeat(32) });
      if (route.endsWith('/schedules') && fails) {
        return Response.json({ success: false, errors: [{ code: 10100, message: token }] }, { status: 400 });
      }
      if (route.endsWith('/schedules') || route.endsWith('/subdomain')) return ok({});
      throw new Error('Unexpected route ' + route);
    },
  }));
  try {
    const post = (path: string, data: object, requestOrigin = origin) =>
      mf.dispatchFetch(origin + '/api/' + path, {
        method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    expect((await mf.dispatchFetch(origin + '/template/package.json')).status).toBe(404);
    expect((await post('accounts', { token }, 'https://other.test')).status).toBe(400);
    expect(await (await post('accounts', { token })).json()).toEqual({ accounts: [{ id: account, name: '연수 시험 계정' }] });
    const input = { token, account, openRouterKey, teacherPassword };
    const install = async () => {
      const response = await post('install', input);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.text();
      for (const secret of [token, openRouterKey, teacherPassword]) expect(body).not.toContain(secret);
      return body.trim().split('\n').map(line => JSON.parse(line) as InstallEvent).at(-1);
    };
    expect(await install()).toMatchObject({
      type: 'done', verified: true, url: expect.stringMatching(/^https:\/\/voice-classroom-.*\.training-test\.workers\.dev\/$/),
    });
    expect(deletes).toEqual([]);

    fails = true;
    expect(await install()).toMatchObject({ type: 'error', message: expect.stringContaining('10100') });
    expect(deletes).toEqual([
      '/queues/' + queue + '/consumers/' + 'e'.repeat(32), script,
      '/queues/' + queue, '/queues/' + dlq, '/d1/database/' + db,
      '/r2/buckets/' + script.split('/').at(-1),
    ]);
  } finally {
    await mf.dispose();
  }
});
