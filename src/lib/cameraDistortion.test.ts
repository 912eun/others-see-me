import { describe, expect, it } from 'vitest';
import { IDX, type PxLandmark } from './geometry';
import {
  CORRECTION,
  DisplacementField,
  LiveCorrector,
  OneEuro,
  computeTargets,
  perspectiveScale,
  stereoRadius,
  wideAngleFace,
} from './cameraDistortion';

const W = 1280, H = 960, F = 1000;

/** 3D 원(얼굴 대용)을 카메라 축에서 theta만큼 떨어진 곳에 두고 직선 투영 */
function projectedCircle(thetaDeg: number, dist = 0.5, radius = 0.07, n = 64): Float64Array {
  const th = (thetaDeg * Math.PI) / 180;
  const cX = dist * Math.sin(th), cZ = dist * Math.cos(th);
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const u = radius * Math.cos(a), v = radius * Math.sin(a);
    const X = cX + u * Math.cos(th), Z = cZ - u * Math.sin(th), Y = v;
    out[2 * i] = W / 2 + (F * X) / Z;
    out[2 * i + 1] = H / 2 + (F * Y) / Z;
  }
  return out;
}

function aspect(pts: Float64Array): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length / 2; i++) {
    minX = Math.min(minX, pts[2 * i]); maxX = Math.max(maxX, pts[2 * i]);
    minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]);
  }
  return (maxX - minX) / (maxY - minY);
}

/** 합성 얼굴: 반타원체 표면을 거리 d에서 핀홀 투영 (MediaPipe처럼 Z는 기준면 px 스케일) */
function face(d = 0.3, offX = 0): PxLandmark[] {
  const proj = (x: number, y: number, z: number) => {
    const s = F / (d + z);
    return { X: W / 2 + (x + offX) * s, Y: H / 2 + y * s, Z: z * (F / d) };
  };
  const surf = (u: number, v: number) => [0.07 * u, 0.1 * v, 0.06 - 0.09 * Math.sqrt(Math.max(0, 1 - u * u - v * v))] as const;
  const p: PxLandmark[] = [];
  for (let i = 0; i < 478; i++) {
    const a = i * 2.39996, r = Math.sqrt(i / 478) * 0.97;
    const [x, y, z] = surf(r * Math.cos(a), r * Math.sin(a));
    p.push(proj(x, y, z));
  }
  p[IDX.rightIrisCenter] = proj(-0.0315, -0.01, -0.025);
  p[IDX.leftIrisCenter] = proj(0.0315, -0.01, -0.025);
  return p;
}

describe('원근 배율', () => {
  it('Ward 2018 수준: 30cm에서 코끝(ζ≈-3cm)은 1.5m 대비 약 8% 축소, 귀 쪽은 확대', () => {
    expect(perspectiveScale(0.3, -0.03, 1.5)).toBeCloseTo(0.918, 2);
    expect(perspectiveScale(0.3, 0.08, 1.5)).toBeGreaterThan(1.15);
    expect(perspectiveScale(1.5, -0.03, 1.5)).toBeCloseTo(1, 6);
  });
});

describe('광각 늘어짐 보정', () => {
  it('스테레오그래픽 반경은 중심 근처에서 직선 투영과 거의 같고, 경계(짧은 변 절반)에서 같아짐', () => {
    expect(stereoRadius(5, F, H) / 5).toBeGreaterThan(0.85);
    expect(stereoRadius(H / 2, F, H)).toBeCloseTo(H / 2, 6);
  });
  it('가장자리 얼굴의 가로 늘어짐이 줄어든다', () => {
    const edge = projectedCircle(32);
    const before = aspect(edge);
    const after = aspect(wideAngleFace(edge, edge.length / 2, W / 2, H / 2, F, H));
    expect(before).toBeGreaterThan(1.1);
    expect(Math.abs(after - 1)).toBeLessThan(Math.abs(before - 1) / 3);
  });
  it('중앙 얼굴은 모양이 거의 그대로', () => {
    const c = projectedCircle(0);
    expect(aspect(wideAngleFace(c, c.length / 2, W / 2, H / 2, F, H))).toBeCloseTo(aspect(c), 3);
  });
});

describe('목표 변위', () => {
  it('보정을 끄면 변위 0', () => {
    const t = computeTargets(face(), W, H, F, 0.3, { perspective: false, wideAngle: false, targetM: 1.5 });
    expect(Math.max(...Array.from(t.disp).map(Math.abs))).toBeLessThan(1e-9);
  });
  it('이미 목표보다 멀면 원근 보정 없음', () => {
    const t = computeTargets(face(2), W, H, F, 2, { perspective: true, wideAngle: false, targetM: 1.5 });
    expect(Math.max(...Array.from(t.disp).map(Math.abs))).toBeLessThan(1e-9);
  });
  it('윤곽 배율은 상한을 넘지 않는다', () => {
    const lms = face(0.25);
    const t = computeTargets(lms, W, H, F, 0.25, { perspective: true, wideAngle: false, targetM: 1.5 });
    const ax = (lms[IDX.rightIrisCenter].X + lms[IDX.leftIrisCenter].X) / 2;
    for (let i = 0; i < 478; i++) {
      const r0 = Math.abs(lms[i].X - ax);
      if (r0 < 20) continue;
      expect(Math.abs(lms[i].X + t.disp[2 * i] - ax) / r0).toBeLessThanOrEqual(CORRECTION.maxRimScale + 1e-6);
    }
  });
});

describe('고정 격자 변위장', () => {
  it('목표가 없으면 변위 0, 테두리는 항상 0', () => {
    const f = new DisplacementField(W, H);
    const m = f.solve(null, 1);
    for (let i = 0; i < m.dst.length; i++) expect(m.dst[i]).toBe(m.src[i]);
  });
  it('얼굴 근처는 목표 변위를 따르고 먼 배경은 0', () => {
    const lms = face(0.3);
    const t = computeTargets(lms, W, H, F, 0.3, { perspective: true, wideAngle: false, targetM: 1.5 });
    const f = new DisplacementField(W, H);
    for (let k = 0; k < 6; k++) f.solve(t, 1); // warm start로 수렴
    // 왼쪽 볼 근처 랜드마크 하나
    let idx = 0, best = 0;
    for (let i = 0; i < 478; i++) if (Math.abs(t.disp[2 * i]) > best) { best = Math.abs(t.disp[2 * i]); idx = i; }
    const [dx] = f.displacementAt(t.pos[2 * idx], t.pos[2 * idx + 1]);
    expect(Math.sign(dx)).toBe(Math.sign(t.disp[2 * idx]));
    expect(Math.abs(dx)).toBeGreaterThan(best * 0.4);
    const [bx, by] = f.displacementAt(40, 40);
    expect(Math.hypot(bx, by)).toBeLessThan(1e-6);
  });
  it('위상이 고정: 프레임이 바뀌어도 삼각형 목록이 같다', () => {
    const f = new DisplacementField(W, H);
    const a = f.solve(computeTargets(face(0.3), W, H, F, 0.3, { perspective: true, wideAngle: true, targetM: 1.5 }), 1).triangles;
    const b = f.solve(computeTargets(face(0.35, 0.02), W, H, F, 0.35, { perspective: true, wideAngle: true, targetM: 1.5 }), 1).triangles;
    expect(a).toBe(b);
  });
});

describe('시간 안정성', () => {
  it('One Euro 필터는 정지 상태 떨림을 줄인다', () => {
    const f = new OneEuro(1.0, 0.0);
    let t = 0, rawVar = 0, outVar = 0, seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < 300; i++) {
      t += 33;
      const raw = 100 + rnd();
      const out = f.filter(raw, t);
      if (i > 50) {
        rawVar += (raw - 100) ** 2;
        outVar += (out - 100) ** 2;
      }
    }
    expect(outVar).toBeLessThan(rawVar / 4);
  });
  it('얼굴을 놓치면 200ms 안에 보정이 0으로 페이드', () => {
    const c = new LiveCorrector();
    const lms = face(0.3);
    let ts = 0;
    for (let i = 0; i < 20; i++) c.frame(lms, W, H, F, 0.3, (ts += 33), true);
    const on = c.frame(lms, W, H, F, 0.3, (ts += 33), true);
    const moved = on.dst.some((v, i) => Math.abs(v - on.src[i]) > 0.5);
    expect(moved).toBe(true);
    let m = on;
    for (let i = 0; i < 8; i++) m = c.frame(null, W, H, F, NaN, (ts += 33), true);
    expect(m.dst.every((v, i) => Math.abs(v - m.src[i]) < 1e-9)).toBe(true);
  });
  it('랜드마크 깊이 노이즈가 있어도 보정 떨림이 원본 노이즈보다 작다', () => {
    const c = new LiveCorrector();
    const base = face(0.3);
    let ts = 0, seed = 7, jSum = 0, n = 0;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < 60; i++) {
      const noisy = base.map((p) => ({ X: p.X, Y: p.Y, Z: p.Z + rnd() * 15 })); // z 노이즈
      c.frame(noisy, W, H, F, 0.3 + rnd() * 0.01, (ts += 33), true);
      if (i > 20) { jSum += c.jitterPx; n++; }
    }
    // 같은 노이즈를 평활 없이 쓰면 변위가 프레임마다 수 px 흔들림 → 평활 후 1px 미만 목표
    expect(jSum / n).toBeLessThan(1);
  });
});
