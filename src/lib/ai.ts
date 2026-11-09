// AI 보정 클라이언트. API 키는 여기 없음 — 프록시 서버(server/)만 호출

const LS_ENDPOINT = 'osm.ai.endpoint';
const LS_CONSENT = 'osm.ai.consent.v1';

/** 빌드 변수 VITE_AI_ENDPOINT, 없으면 ?ai=https://... 로 한 번 지정한 값 */
export function aiEndpoint(): string | null {
  try {
    const q = new URLSearchParams(location.search).get('ai');
    if (q && /^https:\/\//.test(q)) localStorage.setItem(LS_ENDPOINT, q.replace(/\/$/, ''));
  } catch {
    /* 저장 불가 */
  }
  const fromBuild = import.meta.env.VITE_AI_ENDPOINT as string | undefined;
  if (fromBuild) return fromBuild.replace(/\/$/, '');
  try {
    return localStorage.getItem(LS_ENDPOINT);
  } catch {
    return null;
  }
}

export type Consent = 'yes' | 'no' | null;

export function getConsent(): Consent {
  try {
    return (localStorage.getItem(LS_CONSENT) as Consent) ?? null;
  } catch {
    return null;
  }
}

export function setConsent(c: Exclude<Consent, null>) {
  try {
    localStorage.setItem(LS_CONSENT, c);
  } catch {
    /* 이번 세션만 */
  }
}

/** 이 정도면 이미 '남이 보는' 조건이라 AI 보정이 필요 없음 */
export function needsCorrection(distM: number, pitchDeg: number): boolean {
  return distM < 0.9 || Math.abs(pitchDeg) >= 8;
}

export class AiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function requestCorrection(
  endpoint: string,
  imageDataUrl: string,
  params: { distCm: number; pitchDeg: number },
  signal?: AbortSignal,
): Promise<{ image: string; remaining?: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const r = await fetch(`${endpoint}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl, params }),
      signal: ctrl.signal,
    });
    const body = (await r.json().catch(() => ({}))) as { image?: string; remaining?: number; code?: string; message?: string };
    if (!r.ok || !body.image) throw new AiError(body.code ?? `http_${r.status}`, body.message ?? 'AI 보정에 실패했어요');
    return { image: body.image, remaining: body.remaining };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error).name === 'AbortError') throw new AiError('timeout', 'AI 보정이 너무 오래 걸려요');
    throw new AiError('network', 'AI 보정 서버에 연결하지 못했어요');
  } finally {
    clearTimeout(timer);
  }
}
