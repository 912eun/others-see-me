// AI 보정 프록시 (Cloudflare Worker)
//
// 왜 필요한가: 앱(GitHub Pages·토스 WebView)의 코드는 전부 사용자 폰으로 내려가므로
// API 키를 앱에 넣으면 누구나 꺼내 쓸 수 있다. 키는 이 서버의 Secret에만 둔다.
//
// 남용 방지
//  1. 허용된 Origin만 (브라우저 밖에서는 위조 가능하므로 1차 필터일 뿐)
//  2. 클라이언트는 숫자 파라미터만 보낸다. 프롬프트는 서버에 고정 → 아무 이미지나 만드는 생성기로 못 씀
//  3. 이미지 크기·형식 검사
//  4. IP당 하루 횟수 + 전체 하루 횟수 상한 (KV)
//  5. (최후 안전장치) Google Cloud 콘솔에서 결제 한도·예산 알림 설정
//  6. 이미지는 저장하지 않고 응답만 돌려준다. 로그에도 남기지 않는다.

export interface Env {
  GEMINI_API_KEY: string;
  /** 쉼표로 구분, 예: https://912eun.github.io,http://localhost:5173 */
  ALLOWED_ORIGINS: string;
  /** IP당 하루 최대 보정 횟수 */
  PER_IP_DAILY?: string;
  /** 서비스 전체 하루 최대 보정 횟수 (비용 상한) */
  GLOBAL_DAILY?: string;
  GEMINI_MODEL?: string;
  USAGE: KVLike;
}

/** Cloudflare KV에서 쓰는 부분만 (테스트에서 대체 가능) */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface CorrectParams {
  /** 추정 촬영 거리(cm) */
  distCm: number;
  /** 카메라 높이 각도(°). 음수 = 카메라가 얼굴보다 아래 */
  pitchDeg: number;
}

const MAX_IMAGE_BYTES = 1_500_000;
const DEFAULT_MODEL = 'gemini-nano-banana-2.1';
export const TARGET_CM = 150;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseParams(raw: unknown): CorrectParams {
  const p = raw as Record<string, unknown>;
  const distCm = Number(p?.distCm);
  const pitchDeg = Number(p?.pitchDeg);
  if (!Number.isFinite(distCm) || distCm < 15 || distCm > 400) throw new HttpError(400, 'bad_params', 'distCm은 15~400');
  if (!Number.isFinite(pitchDeg) || Math.abs(pitchDeg) > 45) throw new HttpError(400, 'bad_params', 'pitchDeg는 -45~45');
  return { distCm: Math.round(distCm), pitchDeg: Math.round(pitchDeg) };
}

/** 숫자만으로 서버에서 문장을 만든다. 클라이언트 텍스트는 한 글자도 들어가지 않음 */
export function buildPrompt({ distCm, pitchDeg }: CorrectParams): string {
  const angle =
    Math.abs(pitchDeg) < 5
      ? 'at roughly eye level'
      : pitchDeg < 0
        ? `with the camera about ${Math.abs(pitchDeg)} degrees below eye level, looking up at the face`
        : `with the camera about ${pitchDeg} degrees above eye level, looking down at the face`;
  return [
    `This is a selfie taken about ${distCm} cm from the face ${angle}.`,
    `Apply a subtle, realistic correction so it looks like the same photo taken by another person standing ${TARGET_CM} cm away at eye level with a normal portrait lens.`,
    'Only remove close-range perspective distortion and camera-angle distortion: the nose and the center of the face should look slightly smaller relative to the face width, the face outline and ears slightly wider, and the jaw and nostrils no longer seen from below.',
    'Keep everything else identical: the same person and identity, eye shape, nose shape, lips, skin texture, blemishes, moles, makeup, expression, gaze, hairstyle, clothing, framing and background.',
    'Do not beautify, slim the face, smooth skin, whiten teeth, change age, or change the lighting or colors.',
    'Do not mirror or flip the image. Output a single photo with the same aspect ratio.',
  ].join(' ');
}

export function checkImage(b64: unknown): { mime: string; data: string } {
  if (typeof b64 !== 'string') throw new HttpError(400, 'bad_image', '이미지가 없어요');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b64);
  if (!m) throw new HttpError(400, 'bad_image', 'JPEG/PNG/WebP data URL만 받아요');
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', '이미지가 너무 커요');
  return { mime: m[1], data: m[2] };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 하루 사용량 카운터. KV는 최종 일관성이라 대략적인 상한 */
export async function consumeQuota(env: Env, ip: string): Promise<{ ipLeft: number; globalLeft: number }> {
  const perIp = Number(env.PER_IP_DAILY ?? 5);
  const global = Number(env.GLOBAL_DAILY ?? 200);
  const d = today();
  const ipKey = `ip:${d}:${await sha256(ip)}`; // IP 원문은 저장하지 않음
  const gKey = `global:${d}`;
  const [ipUsed, gUsed] = await Promise.all([env.USAGE.get(ipKey), env.USAGE.get(gKey)]).then((v) => v.map((x) => Number(x ?? 0)));
  if (gUsed >= global) throw new HttpError(429, 'global_limit', '오늘 AI 보정이 모두 소진됐어요. 내일 다시 시도해 주세요');
  if (ipUsed >= perIp) throw new HttpError(429, 'user_limit', `AI 보정은 하루 ${perIp}번까지예요`);
  const ttl = 60 * 60 * 26;
  await Promise.all([env.USAGE.put(ipKey, String(ipUsed + 1), { expirationTtl: ttl }), env.USAGE.put(gKey, String(gUsed + 1), { expirationTtl: ttl })]);
  return { ipLeft: perIp - ipUsed - 1, globalLeft: global - gUsed - 1 };
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function callGemini(env: Env, image: { mime: string; data: string }, prompt: string, fetchImpl: typeof fetch = fetch) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: image.mime, data: image.data } }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4', imageSize: '1K' } },
    }),
  });
  if (!r.ok) {
    // 상세 오류는 서버 로그에만 (키·이미지는 남기지 않음)
    console.error('gemini error', r.status, (await r.text()).slice(0, 300));
    throw new HttpError(502, 'upstream', 'AI 보정 서버가 응답하지 않아요');
  }
  const json = (await r.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }[] } }[];
  };
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    const d = part.inlineData ?? (part.inline_data && { mimeType: part.inline_data.mime_type, data: part.inline_data.data });
    if (d?.data) return `data:${d.mimeType ?? 'image/png'};base64,${d.data}`;
  }
  throw new HttpError(502, 'no_image', 'AI가 이미지를 만들지 못했어요');
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function handle(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const origin = req.headers.get('Origin');
  const headers = cors(origin, env);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  if (!headers['Access-Control-Allow-Origin']) return json(403, { code: 'forbidden_origin', message: '허용되지 않은 출처예요' });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/correct') return json(404, { code: 'not_found' });

  try {
    const len = Number(req.headers.get('Content-Length') ?? 0);
    if (len > MAX_IMAGE_BYTES * 1.4 + 2000) throw new HttpError(413, 'too_large', '이미지가 너무 커요');
    const body = (await req.json().catch(() => null)) as { image?: unknown; params?: unknown } | null;
    if (!body) throw new HttpError(400, 'bad_json', '요청 형식이 잘못됐어요');
    const params = parseParams(body.params);
    const image = checkImage(body.image);
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const quota = await consumeQuota(env, ip);
    const out = await callGemini(env, image, buildPrompt(params), fetchImpl);
    return json(200, { image: out, remaining: quota.ipLeft });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { code: e.code, message: e.message });
    console.error('unexpected', (e as Error).message);
    return json(500, { code: 'internal', message: '잠시 후 다시 시도해 주세요' });
  }
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
