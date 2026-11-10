// 실시간 카메라 왜곡 보정 (각도·조명·생김새는 건드리지 않음)
//   ① 근거리 원근 왜곡: 가까운 카메라 → 목표 거리(기본 1.5m)에서 같은 얼굴 크기로 본 것처럼
//      x' = c + (x − c)·D(d+z) / (d(D+z))     (Fried 2016의 dolly-zoom 재투영을 랜드마크별로)
//   ② 광각 투영 늘어짐: 화면 가장자리 얼굴이 방사 방향으로 늘어나는 것을
//      얼굴 영역만 스테레오그래픽 투영으로 바꿔 등방성으로 (Shih 2019의 국소 투영 아이디어)
// 점 개수는 프레임마다 고정 → 시간 평활화 가능

import Delaunator from 'delaunator';
import { IDX, faceBox, type PxLandmark } from './geometry';
import { scaleRatio } from './warp';

export interface CorrectionOptions {
  perspective: boolean;
  wideAngle: boolean;
  /** 목표 시점 거리(m) */
  targetM: number;
}

export interface CorrectionMesh {
  src: Float32Array;
  dst: Float32Array;
  triangles: Uint32Array;
  /** 얼굴 478점의 보정 후 좌표 개수(×2) — 검증용 */
  faceCount: number;
}

export const RING_N = 24;
const EDGE_N = 8;
export const MESH_POINTS = 478 + RING_N * 2 + (EDGE_N + 1) * 4;

/** 직선(rectilinear) 반지름 → 스테레오그래픽 반지름 */
export function stereoRadius(r: number, f: number): number {
  const theta = Math.atan(r / f);
  return 2 * f * Math.tan(theta / 2);
}

/**
 * 얼굴 점들을 스테레오그래픽으로 옮긴 뒤, 원래 점들에 가장 가깝게 맞는 닮음변환(평행이동+균일 배율)으로 되돌림.
 * → 위치·크기는 그대로, 방사 방향으로만 늘어났던 모양이 원래 비율로.
 */
export function wideAngleFace(pts: Float64Array, n: number, cx: number, cy: number, f: number): Float64Array {
  const s = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const dx = pts[2 * i] - cx;
    const dy = pts[2 * i + 1] - cy;
    const r = Math.hypot(dx, dy);
    const k = r > 1e-6 ? stereoRadius(r, f) / r : 1;
    s[2 * i] = cx + dx * k;
    s[2 * i + 1] = cy + dy * k;
  }
  // 최소제곱 닮음변환 (회전 없음): p ≈ a·s + t
  let pmx = 0, pmy = 0, smx = 0, smy = 0;
  for (let i = 0; i < n; i++) {
    pmx += pts[2 * i];
    pmy += pts[2 * i + 1];
    smx += s[2 * i];
    smy += s[2 * i + 1];
  }
  pmx /= n; pmy /= n; smx /= n; smy /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = s[2 * i] - smx, sy = s[2 * i + 1] - smy;
    num += sx * (pts[2 * i] - pmx) + sy * (pts[2 * i + 1] - pmy);
    den += sx * sx + sy * sy;
  }
  const a = den > 0 ? num / den : 1;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = pmx + a * (s[2 * i] - smx);
    out[2 * i + 1] = pmy + a * (s[2 * i + 1] - smy);
  }
  return out;
}

export function buildCorrectionMesh(
  lms: PxLandmark[],
  w: number,
  h: number,
  fPx: number,
  dM: number,
  opt: CorrectionOptions,
): CorrectionMesh {
  const n = Math.min(lms.length, 478);
  const cx = w / 2; // 광각 보정의 광학 중심
  const cy = h / 2;
  // 원근 배율의 기준점: 두 눈 사이(기준면 위). 화면 중심 기준이면 얼굴 전체가 밀려나 배경까지 끌고 감
  const ax = (lms[IDX.rightIrisCenter].X + lms[IDX.leftIrisCenter].X) / 2;
  const ay = (lms[IDX.rightIrisCenter].Y + lms[IDX.leftIrisCenter].Y) / 2;
  const pxPerM = fPx / dM;
  const zRef = (lms[IDX.rightIrisCenter].Z + lms[IDX.leftIrisCenter].Z) / 2;

  const src = new Float32Array(MESH_POINTS * 2);
  const dst = new Float32Array(MESH_POINTS * 2);

  // ① 원근
  const face = new Float64Array(n * 2);
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = lms[i];
    src[2 * i] = p.X;
    src[2 * i + 1] = p.Y;
    const zM = (p.Z - zRef) / pxPerM;
    if (zM > maxZ) maxZ = zM;
    const r = opt.perspective ? scaleRatio(dM, zM, opt.targetM) : 1;
    face[2 * i] = ax + (p.X - ax) * r;
    face[2 * i + 1] = ay + (p.Y - ay) * r;
  }

  // ② 광각
  const corrected = opt.wideAngle ? wideAngleFace(face, n, cx, cy, fPx) : face;
  for (let i = 0; i < 2 * n; i++) dst[i] = corrected[i];

  // 얼굴 전체 평균 이동량 (머리 링에 절반 전달)
  let mdx = 0, mdy = 0;
  if (opt.wideAngle) {
    for (let i = 0; i < n; i++) {
      mdx += corrected[2 * i] - face[2 * i];
      mdy += corrected[2 * i + 1] - face[2 * i + 1];
    }
    mdx /= n;
    mdy /= n;
  }

  // 머리(머리카락·귀) 링 + 바깥 완충 링. 배경은 움직이지 않음:
  // 배경까지 같은 식을 적용하면 dolly zoom처럼 배경이 몇 배로 커지므로, 머리 바로 바깥에서 변위를 0으로 감쇠
  const b = faceBox(lms);
  const ringRx = 0.62 * b.w;
  const ringRy = 0.62 * b.h;
  const headRatio = opt.perspective ? scaleRatio(dM, maxZ + 0.02, opt.targetM) : 1;
  const clampX = (v: number) => Math.min(w, Math.max(0, v));
  const clampY = (v: number) => Math.min(h, Math.max(0, v));
  let k = n;
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * Math.PI * 2;
    const sx = b.cx + Math.cos(a) * ringRx;
    const sy = b.cy + Math.sin(a) * ringRy;
    src[2 * k] = sx;
    src[2 * k + 1] = sy;
    dst[2 * k] = ax + (sx - ax) * headRatio + mdx * 0.5;
    dst[2 * k + 1] = ay + (sy - ay) * headRatio + mdy * 0.5;
    k++;
    // 바깥 링: 변위 0 (배경 고정)
    const ox = clampX(b.cx + Math.cos(a) * ringRx * 1.8);
    const oy = clampY(b.cy + Math.sin(a) * ringRy * 1.6);
    src[2 * k] = dst[2 * k] = ox;
    src[2 * k + 1] = dst[2 * k + 1] = oy;
    k++;
  }

  // 화면 테두리 고정
  for (let j = 0; j <= EDGE_N; j++) {
    const s = j / EDGE_N;
    for (const [ex, ey] of [
      [s * w, 0],
      [s * w, h],
      [0, s * h],
      [w, s * h],
    ]) {
      src[2 * k] = dst[2 * k] = ex;
      src[2 * k + 1] = dst[2 * k + 1] = ey;
      k++;
    }
  }

  const tri = new Delaunator(Float64Array.from(src)).triangles;
  return { src, dst, triangles: new Uint32Array(tri), faceCount: n };
}

/**
 * One Euro 필터 (Casiez et al. 2012): 느리게 움직일 땐 강하게 평활(떨림 제거),
 * 빠르게 움직일 땐 약하게(지연 감소). 값 배열 단위로 적용.
 */
export class OneEuroArray {
  private x: Float64Array | null = null;
  private dx: Float64Array | null = null;
  private tPrev = 0;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  /** tMs: 타임스탬프(ms) */
  filter(v: ArrayLike<number>, tMs: number): Float64Array {
    const n = v.length;
    if (!this.x || this.x.length !== n) {
      this.x = Float64Array.from(v);
      this.dx = new Float64Array(n);
      this.tPrev = tMs;
      return Float64Array.from(this.x);
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const ad = OneEuroArray.alpha(this.dCutoff, dt);
    for (let i = 0; i < n; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx![i] = ad * d + (1 - ad) * this.dx![i];
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx![i]);
      const a = OneEuroArray.alpha(cutoff, dt);
      this.x[i] = a * v[i] + (1 - a) * this.x[i];
    }
    return Float64Array.from(this.x);
  }
  reset() {
    this.x = null;
    this.dx = null;
  }
}

/** 실시간 보정 기본값 (선행연구 반영해 조정) */
export const CORRECTION = {
  targetM: 1.5,
  oneEuro: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
};
