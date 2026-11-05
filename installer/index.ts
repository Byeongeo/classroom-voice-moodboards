import { DurableObject } from 'cloudflare:workers';
import { cloudflare, cloudflareMessage } from './cloudflare';
import { accountId, install, type InstallEvent, type InstallInput } from './deploy';

interface Env {
  ASSETS: Fetcher;
  INSTALLER: DurableObjectNamespace<ClassroomInstaller>;
}

const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: responseHeaders });
const tokenPattern = /^cfut_[A-Za-z0-9]{40}[a-fA-F0-9]{8}$/;

async function readInput(request: Request) {
  if (request.method !== 'POST' || request.headers.get('Origin') !== new URL(request.url).origin
    || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json'
    || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    const data: Partial<InstallInput> | null = JSON.parse(body + decoder.decode());
    return data && typeof data.token === 'string' && tokenPattern.test(data.token) ? data : null;
  } catch {
    return null;
  }
}

export class ClassroomInstaller extends DurableObject<Env> {
  private busy = false;

  async start(input: InstallInput) {
    if (this.busy) return json({ message: '이 계정에서 이미 설치 중입니다. 처음 연 탭에서 진행 상태를 확인하세요.' }, 409);
    this.busy = true;
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream({
      start: controller => {
        const send = (event: InstallEvent) => {
          if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        const files = async (filename: string) => {
          const response = await this.env.ASSETS.fetch('https://installer.internal/template/' + filename);
          if (!response.ok) throw new Error('Template unavailable');
          return response;
        };
        this.ctx.waitUntil(install(input, files, send).finally(() => {
          this.busy = false;
          if (!cancelled) controller.close();
        }));
      },
      cancel: () => { cancelled = true; },
    });
    return new Response(stream, { headers: { ...responseHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/install.css' || pathname === '/install.js') return env.ASSETS.fetch(request);
    if (pathname !== '/api/accounts' && pathname !== '/api/install') return new Response('Not found', { status: 404 });
    const input = await readInput(request);
    if (!input) return json({ message: '이 설치 페이지에서 발급한 Cloudflare 설치 토큰을 확인해 주세요.' }, 400);
    if (pathname === '/api/accounts') {
      try {
        const accounts = await cloudflare(input.token)<{ id: string; name: string }[]>('/accounts?per_page=50');
        return json({ accounts: accounts.filter(account => accountId.test(account.id)).map(({ id, name }) => ({ id, name })) });
      } catch (error) {
        return json({ message: cloudflareMessage(error, 'Cloudflare 계정을 찾을 수 없습니다. 설치 토큰의 Account Settings 권한을 확인하세요.') }, 400);
      }
    }
    const { account, openRouterKey, teacherPassword } = input;
    if (typeof account !== 'string' || !accountId.test(account)
      || typeof openRouterKey !== 'string' || !/^sk-or-v1-[A-Za-z0-9_-]{32,150}$/.test(openRouterKey)
      || typeof teacherPassword !== 'string' || teacherPassword.trim().length < 4
      || teacherPassword.length > 128 || teacherPassword.startsWith('replace-')) {
      return json({ message: 'Cloudflare 계정을 선택하고 OpenRouter 키와 교사 비밀번호(4~128자)를 확인하세요.' }, 400);
    }
    return env.INSTALLER.getByName(account).start({ token: input.token, account, openRouterKey, teacherPassword });
  },
} satisfies ExportedHandler<Env>;
