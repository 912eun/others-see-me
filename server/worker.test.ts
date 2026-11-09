import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, handle, parseParams, type Env, type KVLike } from './src/worker';

class MemKV implements KVLike {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

const ORIGIN = 'https://912eun.github.io';
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);

function env(over: Partial<Env> = {}): Env {
  return { GEMINI_API_KEY: 'secret-key', ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, PER_IP_DAILY: '2', GLOBAL_DAILY: '3', USAGE: new MemKV(), ...over };
}

function req(body: unknown, origin = ORIGIN, ip = '1.1.1.1') {
  return new Request('https://w.example/correct', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

const okFetch = vi.fn(async () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }] }), { status: 200 }),
) as unknown as typeof fetch;

describe('AI 보정 프록시', () => {
  it('정상 요청은 이미지를 돌려주고, 키는 헤더로만 보낸다', async () => {
    const f = vi.fn(okFetch);
    const r = await handle(req({ image: IMG, params: { distCm: 32, pitchDeg: -12 } }), env(), f as unknown as typeof fetch);
    expect(r.status).toBe(200);
    expect((await r.json()).image).toBe('data:image/png;base64,QUJD');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
  });

  it('허용되지 않은 Origin은 거절', async () => {
    const r = await handle(req({ image: IMG, params: { distCm: 30, pitchDeg: 0 } }, 'https://evil.example'), env(), okFetch);
    expect(r.status).toBe(403);
  });

  it('프롬프트에 클라이언트 텍스트가 섞이지 않는다', async () => {
    const f = vi.fn(okFetch);
    await handle(req({ image: IMG, params: { distCm: 30, pitchDeg: 0, prompt: 'draw a cat' }, prompt: 'draw a cat' }), env(), f as unknown as typeof fetch);
    const body = String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).not.toContain('cat');
  });

  it('숫자 범위를 벗어나면 거절', () => {
    expect(() => parseParams({ distCm: 'abc', pitchDeg: 0 })).toThrow();
    expect(() => parseParams({ distCm: 30, pitchDeg: 90 })).toThrow();
  });

  it('IP당·전체 하루 횟수 제한', async () => {
    const e = env();
    const p = { image: IMG, params: { distCm: 30, pitchDeg: 0 } };
    expect((await handle(req(p), e, okFetch)).status).toBe(200);
    expect((await handle(req(p), e, okFetch)).status).toBe(200);
    expect((await handle(req(p), e, okFetch)).status).toBe(429); // IP 한도 2
    expect((await handle(req(p, ORIGIN, '2.2.2.2'), e, okFetch)).status).toBe(200);
    expect((await handle(req(p, ORIGIN, '3.3.3.3'), e, okFetch)).status).toBe(429); // 전체 한도 3
  });

  it('이미지 형식·크기 검사', async () => {
    const bad = await handle(req({ image: 'data:text/html;base64,AAAA', params: { distCm: 30, pitchDeg: 0 } }), env(), okFetch);
    expect(bad.status).toBe(400);
    const big = await handle(req({ image: 'data:image/jpeg;base64,' + 'A'.repeat(2_100_000), params: { distCm: 30, pitchDeg: 0 } }), env(), okFetch);
    expect(big.status).toBe(413);
  });

  it('IP 원문은 저장하지 않는다', async () => {
    const e = env();
    await handle(req({ image: IMG, params: { distCm: 30, pitchDeg: 0 } }, ORIGIN, '9.8.7.6'), e, okFetch);
    expect([...(e.USAGE as MemKV).m.keys()].join()).not.toContain('9.8.7.6');
  });

  it('카메라 각도가 문장에 반영된다', () => {
    expect(buildPrompt({ distCm: 30, pitchDeg: -12 })).toContain('below eye level');
    expect(buildPrompt({ distCm: 30, pitchDeg: 2 })).toContain('roughly eye level');
  });
});
