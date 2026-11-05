export class HttpError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function api<T = any>(path: string, method = 'GET', data?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 25_000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', signal: controller.signal,
      ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    });
    let result: any;
    try { result = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new HttpError('서버 응답을 읽지 못했습니다. 잠시 후 다시 연결해 주세요.', response.status || 502, 'INVALID_RESPONSE');
    }
    if (!response.ok) throw new HttpError(result?.error || '요청을 처리하지 못했습니다.', response.status, result?.code);
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('요청을 취소했습니다.', 'AbortError');
    if (timedOut) throw new HttpError('연결이 지연되고 있습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 408, 'REQUEST_TIMEOUT');
    if (error instanceof HttpError) throw error;
    throw new HttpError('서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 0, 'NETWORK_ERROR');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
export const time = (value: number) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
export function saveFile(content: Blob, name: string) {
  const url = URL.createObjectURL(content);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const statusName: Record<string, string> = { queued: '대기 중', processing: '처리 중', succeeded: '이미지 저장 완료', failed: '처리 실패', ignored: '이미지 생성 없는 발화', discarded: '현재 이미지 닫기', pending: '분석 대기', completed: '분석 완료', ready: '보관 완료', expired: '보관기간 만료', expiring: '만료 처리 중' };
