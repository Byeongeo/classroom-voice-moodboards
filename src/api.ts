export class HttpError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result: any = await response.json();
  if (!response.ok) throw new HttpError(result.error || '요청을 처리하지 못했습니다.', response.status, result.code);
  return result;
}
export const time = (value: number) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
export function saveFile(content: Blob, name: string) {
  const url = URL.createObjectURL(content);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const statusName: Record<string, string> = { queued: '대기 중', processing: '처리 중', succeeded: '이미지 저장 완료', failed: '처리 실패', ignored: '이미지 생성 없는 발화', discarded: '현재 이미지 닫기', pending: '분석 대기', completed: '분석 완료', ready: '보관 완료', expired: '보관기간 만료', expiring: '만료 처리 중' };
