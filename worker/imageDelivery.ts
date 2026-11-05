import { digest } from './auth';
import { assert, now, sql, type Env } from './env';

type ImageRecord = {
  image_id: string | null;
  object_key: string;
  mime_type: string;
  byte_size: number;
  preview_object_key: string | null;
  preview_mime_type: string | null;
  preview_byte_size: number | null;
  preview_status: string;
};

export function imageReadId(request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  return new URL(request.url).pathname.match(/^\/api\/images\/([\w-]+)$/)?.[1] || null;
}

function matchesEtag(header: string | null, etag: string) {
  return !!header && header.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

// All authorization is checked before either R2 or conditional cache responses.
// One session digest and one indexed D1 query keep this read path suitable for
// the ordinary Worker; expensive login and background work stays in the DO.
export async function deliverImage(request: Request, env: Env, imageId: string) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)classroom_session=([^;]+)/)?.[1];
  assert(token, 401, 'LOGIN_REQUIRED', '로그인이 필요합니다.');
  const image = await sql(env, `SELECT i.id image_id,i.object_key,i.mime_type,i.byte_size,
      i.preview_object_key,i.preview_mime_type,i.preview_byte_size,i.preview_status
    FROM sessions s LEFT JOIN students st ON st.id=s.student_id
    LEFT JOIN images i ON i.id=? AND (s.role='teacher' OR i.student_id=s.student_id)
    WHERE s.token_hash=? AND s.expires_at>?
      AND (s.role='teacher' OR (s.role='student' AND st.enabled=1)) LIMIT 1`, imageId, await digest(token), now()).first<ImageRecord>();
  assert(image, 401, 'SESSION_EXPIRED', '다시 로그인해 주세요.');
  assert(image.image_id && image.object_key, 404, 'IMAGE_NOT_FOUND', '이미지를 찾을 수 없습니다.');

  const preview = new URL(request.url).searchParams.get('preview') === '1'
    && image.preview_status === 'ready' && !!image.preview_object_key && !!image.preview_mime_type;
  const original = { key: image.object_key, mime: image.mime_type };
  let selected = preview ? { key: image.preview_object_key!, mime: image.preview_mime_type! } : original;
  const candidate = request.headers.get('If-None-Match')?.trim();
  // Ignore malformed validators rather than passing them to R2 as a storage
  // error. Browsers send quoted ETags; an invalid client header is no match.
  const ifNoneMatch = candidate && /^(?:\*|(?:W\/)?"[^"\r\n]+"(?:\s*,\s*(?:W\/)?"[^"\r\n]+")*)$/.test(candidate) ? candidate : null;
  const conditional = new Headers();
  if (ifNoneMatch) conditional.set('If-None-Match', ifNoneMatch);
  const read = (key: string) => request.method === 'HEAD'
    ? env.IMAGES.head(key)
    : env.IMAGES.get(key, ifNoneMatch ? { onlyIf: conditional } : undefined);
  let object = await read(selected.key);
  // A missing derivative must never hide a preserved original.
  if (!object && preview) { selected = original; object = await read(selected.key); }
  assert(object, 503, 'IMAGE_STORAGE_ERROR', '이미지 저장소를 확인해 주세요. 잠시 후 다시 시도해 주세요.');
  assert(['image/jpeg', 'image/png', 'image/webp'].includes(selected.mime), 503, 'IMAGE_TYPE_ERROR', '이미지 형식을 확인해 주세요.');
  const headers = new Headers({
    'Content-Type': selected.mime,
    'ETag': object.httpEtag,
    'Cache-Control': 'private, no-cache',
    'Vary': 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  });
  if ((request.method === 'HEAD' && matchesEtag(ifNoneMatch, object.httpEtag))
    || (request.method === 'GET' && !('body' in object) && !!ifNoneMatch))
    return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(object.size));
  if (request.method === 'HEAD') return new Response(null, { headers });
  assert('body' in object, 503, 'IMAGE_STORAGE_ERROR', '이미지 전송을 시작하지 못했습니다. 다시 시도해 주세요.');
  // Small previews have a strict encoded-size cap. Complete that bounded R2
  // read before sending the response, so a slow client does not keep an R2
  // source stream open. Originals remain streamed without large allocations.
  if (selected.key !== original.key && object.size <= 96 * 1024)
    return new Response(await new Response((object as R2ObjectBody).body).arrayBuffer(), { headers });
  return new Response((object as R2ObjectBody).body, { headers });
}
