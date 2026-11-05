import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { imageBlob } from '../src/imageFiles';
import type { SavedImage } from '../shared/contracts';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('응답 헤더 뒤 본문이 멈춰도 시간 초과로 종료하고 재시도 안내를 제공한다', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async (_path,init) => {
    const stream=new ReadableStream({ start(controller) { init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError'))); } });
    return new Response(stream,{headers:{'Content-Type':'application/json'}});
  }));
  const result=api('/api/workspace').catch(error=>error);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(await result).toMatchObject({status:408,code:'REQUEST_TIMEOUT'});
});

it('탭 전환에 따른 취소는 네트워크 오류로 잘못 표시하지 않는다', async () => {
  vi.stubGlobal('fetch',vi.fn((_path,init) => new Promise((_resolve,reject) => { init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))); })));
  const controller=new AbortController();const result=api('/api/workspace','GET',undefined,{signal:controller.signal}).catch(error=>error);
  controller.abort();expect((await result).name).toBe('AbortError');
});

it('로그인 만료·횟수 제한의 HTTP 상태와 코드를 유지한다', async () => {
  vi.stubGlobal('fetch',vi.fn(async () => Response.json({code:'LOGIN_RATE_LIMIT',error:'로그인 제한'},{status:429})));
  await expect(api('/api/login','POST',{})).rejects.toMatchObject({status:429,code:'LOGIN_RATE_LIMIT'});
});

it('원본 다운로드 본문이 멈춰도 45초 후 종료하여 계속 다운로드 중으로 남지 않는다', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async (_path,init) => new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')));}}))));
  const result=imageBlob({imageUrl:'/api/images/synthetic-only'} as SavedImage).catch(error=>error);
  await vi.advanceTimersByTimeAsync(45_000);
  expect((await result).message).toContain('원본은 서버에 보관');
});
