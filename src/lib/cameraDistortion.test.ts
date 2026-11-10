import { describe, expect, it } from 'vitest';
import { IDX, type PxLandmark } from './geometry';
import { MESH_POINTS, OneEuroArray, buildCorrectionMesh, stereoRadius, wideAngleFace } from './cameraDistortion';

const W = 1280, H = 960, F = 1000;

/** 3D 구(얼굴 대용)를 카메라 축에서 각도 theta만큼 떨어진 곳에 두고 직선 투영 */
function projectedCircle(thetaDeg: number, dist = 0.5, radius = 0.07, n = 64): Float64Array {
  const th = (thetaDeg * Math.PI) / 180;
  const cX = dist * Math.sin(th), cZ = dist * Math.cos(th);
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    // 시선에 수직인 평면 위 원
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

function face(): PxLandmark[] {
  const p: PxLandmark[] = [];
  for (let i = 0; i < 478; i++) {
    const a = i * 2.39996, r = Math.sqrt(i / 478) * 150;
    p.push({ X: W / 2 + r * Math.cos(a), Y: H / 2 + r * Math.sin(a) * 1.3, Z: (r / 150) ** 2 * 60 - 30 });
  }
  p[IDX.rightIrisCenter] = { X: W / 2 - 60, Y: H / 2 - 30, Z: -10 };
  p[IDX.leftIrisCenter] = { X: W / 2 + 60, Y: H / 2 - 30, Z: -10 };
  return p;
}

describe('광각 늘어짐 보정', () => {
  it('스테레오그래픽 반지름은 중심 근처에서 직선 투영과 거의 같다', () => {
    expect(stereoRadius(10, F)).toBeCloseTo(10, 1);
    expect(stereoRadius(600, F)).toBeLessThan(600);
  });
  it('가장자리 얼굴의 가로 늘어짐이 줄어든다', () => {
    const edge = projectedCircle(32);
    const before = aspect(edge);
    const after = aspect(wideAngleFace(edge, edge.length / 2, W / 2, H / 2, F));
    expect(before).toBeGreaterThan(1.1);
    expect(Math.abs(after - 1)).toBeLessThan(Math.abs(before - 1) / 3);
  });
  it('중앙 얼굴은 거의 그대로', () => {
    const c = projectedCircle(0);
    const out = wideAngleFace(c, c.length / 2, W / 2, H / 2, F);
    let maxD = 0;
    for (let i = 0; i < c.length; i++) maxD = Math.max(maxD, Math.abs(out[i] - c[i]));
    expect(maxD).toBeLessThan(0.5);
  });
});

describe('보정 메시', () => {
  it('보정을 모두 끄면 변형 없음, 점 개수는 고정', () => {
    const m = buildCorrectionMesh(face(), W, H, F, 0.35, { perspective: false, wideAngle: false, targetM: 1.5 });
    expect(m.src.length).toBe(MESH_POINTS * 2);
    for (let i = 0; i < 478 * 2; i++) expect(m.dst[i]).toBeCloseTo(m.src[i], 6);
  });
  it('원근 보정: 가까운 점(코)은 안쪽으로, 먼 점(외곽)은 바깥으로', () => {
    const lms = face();
    const m = buildCorrectionMesh(lms, W, H, F, 0.35, { perspective: true, wideAngle: false, targetM: 1.5 });
    const r = (i: number, arr: Float32Array) => Math.hypot(arr[2 * i] - W / 2, arr[2 * i + 1] - H / 2);
    // 깊이가 음수(가까움)인 점 vs 양수(멂)인 점
    const near = lms.findIndex((p, i) => i > 5 && p.Z < -25);
    const far = lms.findIndex((p) => p.Z > 25);
    expect(r(near, m.dst) / r(near, m.src)).toBeLessThan(1);
    expect(r(far, m.dst) / r(far, m.src)).toBeGreaterThan(1);
  });
  it('테두리 점은 고정', () => {
    const m = buildCorrectionMesh(face(), W, H, F, 0.35, { perspective: true, wideAngle: true, targetM: 1.5 });
    const last = MESH_POINTS - 1;
    expect(m.dst[2 * last]).toBe(m.src[2 * last]);
  });
});

describe('One Euro 필터', () => {
  it('정지 상태의 떨림을 줄인다', () => {
    const f = new OneEuroArray(1.0, 0.0);
    let t = 0, rawVar = 0, outVar = 0;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < 300; i++) {
      t += 33;
      const raw = 100 + rnd();
      const out = f.filter([raw], t)[0];
      if (i > 50) {
        rawVar += (raw - 100) ** 2;
        outVar += (out - 100) ** 2;
      }
    }
    expect(outVar).toBeLessThan(rawVar / 4);
  });
});
