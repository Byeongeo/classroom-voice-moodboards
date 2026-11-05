const api = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(readonly status: number, readonly codes: number[] = []) {
    super('Cloudflare API request failed');
  }
}

export function cloudflare(token: string) {
  return async function call<T = unknown>(path: string, method = 'GET', data?: object, uploadToken = token): Promise<T> {
    const headers = new Headers({ Authorization: 'Bearer ' + uploadToken });
    const body = data instanceof FormData ? data : data ? JSON.stringify(data) : undefined;
    if (typeof body === 'string') headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetch(api + path, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new CloudflareError(0);
    }
    const result = await response.json<{
      success?: boolean;
      errors?: { code: number }[];
      result: T;
    }>().catch(() => null);
    if (!response.ok || !result?.success) {
      throw new CloudflareError(response.status, result?.errors?.map(error => error.code).filter(Number.isInteger));
    }
    return result.result;
  };
}

export function cloudflareMessage(error: unknown, fallback: string) {
  if (!(error instanceof CloudflareError)) return fallback;
  const code = error.codes.length ? ` (Cloudflare ${error.codes.join(', ')})` : '';
  if (error.status === 401 || error.status === 403 || error.codes.includes(10000)) {
    return '설치 토큰이 만료됐거나 권한이 부족합니다. 같은 Cloudflare 계정을 선택했는지, 설치 토큰에 5가지 권한이 있는지 확인하세요.' + code;
  }
  if (error.status === 429) return 'Cloudflare 요청이 몰렸습니다. 잠시 기다린 뒤 다시 시도해 주세요.' + code;
  if (error.status === 0) return 'Cloudflare 연결 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return fallback + code;
}
