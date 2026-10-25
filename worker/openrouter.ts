import { ApiError, assert, type Env } from './env';
import { MODELS } from '../shared/contracts';
import { Buffer } from 'node:buffer';

export class ProviderError extends ApiError {
  constructor(public retryable: boolean, code: string) { super(502, code, 'AI 서비스 요청을 처리하지 못했습니다.'); }
}
export async function openrouter(env: Env, endpoint: 'chat/completions' | 'images', data: unknown) {
  assert(env.OPENROUTER_API_KEY && !env.OPENROUTER_API_KEY.startsWith('replace-'), 503, 'API_NOT_CONFIGURED', '교사가 API 설정을 완료해야 합니다.');
  let response: Response;
  try {
    response = await fetch(`https://openrouter.ai/api/v1/${endpoint}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Classroom Moodboards' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(endpoint === 'images' ? 180_000 : 45_000),
    });
  } catch { throw new ProviderError(true, 'PROVIDER_TIMEOUT'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(response.status === 429 || response.status >= 500, `PROVIDER_${response.status}`);
  }
  // Never log model output, transcripts, API keys, student names, or upstream error bodies.
  return response.json() as Promise<any>;
}
export async function textCompletion(env: Env, system: string, data: unknown, model: string = MODELS.intent) {
  const result = await openrouter(env, 'chat/completions', {
    model, temperature: 0, max_tokens: model === MODELS.analysis ? 4000 : 900,
    provider: { data_collection: 'deny' },
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }],
  });
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new ProviderError(false, 'INVALID_MODEL_RESPONSE');
  try { return JSON.parse(content); } catch { throw new ProviderError(false, 'INVALID_MODEL_JSON'); }
}
export function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
export async function generateImage(env: Env, prompt: string, reference?: { bytes: Uint8Array; mime: string }) {
  const output = await openrouter(env, 'images', {
    model: MODELS.image, prompt: `Create a classroom-appropriate, detailed visual moodboard photograph or artwork. Follow the student's requested style. ${prompt}`,
    n: 1, size: '1024x1024', quality: 'low', output_format: 'jpeg', output_compression: 85,
    ...(reference ? { input_references: [{ type: 'image_url', image_url: { url: `data:${reference.mime};base64,${bytesToBase64(reference.bytes)}` } }] } : {}),
  });
  const encoded = output.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length > 5_592_408 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ProviderError(false, 'INVALID_IMAGE');
  const mime = output.data?.[0]?.media_type || 'image/png';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ProviderError(false, 'UNSUPPORTED_IMAGE_TYPE');
  let bytes: Uint8Array;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { throw new ProviderError(false, 'INVALID_IMAGE'); }
  if (bytes.byteLength > 4 * 1024 * 1024) throw new ProviderError(false, 'INVALID_IMAGE');
  const valid = mime === 'image/png' ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216
    : bytes[0] === 82 && bytes[1] === 73 && bytes[8] === 87 && bytes[9] === 69;
  if (!valid) throw new ProviderError(false, 'INVALID_IMAGE_BYTES');
  return { bytes, mime };
}
