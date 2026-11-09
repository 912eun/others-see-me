// (실험 중, 아직 앱에서 사용하지 않음) 실시간 시점 보정: 랜드마크를 미터 단위 3D로 올린 뒤
//   ① 각도: 얼굴 중심을 축으로 회전해 카메라가 눈높이 정면에 있는 것처럼
//   ② 거리: 같은 화면 크기를 유지하며 가상 카메라를 목표 거리로 (dolly zoom)
// 다시 투영해 2D 워프 메시(src→dst)를 만든다.

import Delaunator from 'delaunator';
import { IDX, faceBox, type PxLandmark } from './geometry';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 이미지 좌표(px) + MediaPipe 상대 깊이 → 카메라 좌표(m). y는 아래, z는 카메라에서 멀어지는 방향 */
export function toMetric(lms: PxLandmark[], w: number, h: number, fPx: number, dM: number): Vec3[] {
  const cx = w / 2;
  const cy = h / 2;
  const pxPerM = fPx / dM;
  const zRef = (lms[IDX.rightIrisCenter].Z + lms[IDX.leftIrisCenter].Z) / 2;
  return lms.map((p) => {
    const z = Math.max(0.05, dM + (p.Z - zRef) / pxPerM);
    return { x: ((p.X - cx) * z) / fPx, y: ((p.Y - cy) * z) / fPx, z };
  });
}

/**
 * 얼굴의 위아래 기울기(rad): 이마(10)→턱(152) 벡터가 화면 평면에서 얼마나 기울었나.
 * 음수 = 턱이 카메라에 더 가까움 = 카메라가 얼굴보다 아래.
 */
export function facePitchRad(P: Vec3[]): number {
  const f = P[IDX.forehead];
  const c = P[IDX.chin];
  return Math.atan2(c.z - f.z, c.y - f.y);
}

export function centroid(P: Vec3[]): Vec3 {
  // 얼굴 메시 점들의 평균 (홍채 10점 제외)
  let x = 0,
    y = 0,
    z = 0;
  const n = Math.min(P.length, 468);
  for (let i = 0; i < n; i++) {
    x += P[i].x;
    y += P[i].y;
    z += P[i].z;
  }
  return { x: x / n, y: y / n, z: z / n };
}

export interface ViewCorrection {
  /** 얼굴을 x축으로 회전시킬 각도(rad). 측정된 pitch를 그대로 넣으면 정면이 됨 */
  pitchRad: number;
  /** 목표 시점 거리(m). null이면 거리 보정 없음 */
  targetM: number | null;
}

export interface ViewTransform {
  C: Vec3;
  C2: Vec3;
  cos: number;
  sin: number;
  f2: number;
  cx: number;
  cy: number;
}

export function makeTransform(P: Vec3[], fPx: number, w: number, h: number, corr: ViewCorrection): ViewTransform {
  const C = centroid(P);
  const D = corr.targetM ?? C.z;
  // 화면 위 얼굴 위치는 유지: 같은 광선 위에서 거리만 바꿈
  const C2 = { x: (C.x * D) / C.z, y: (C.y * D) / C.z, z: D };
  return {
    C,
    C2,
    cos: Math.cos(corr.pitchRad),
    sin: Math.sin(corr.pitchRad),
    f2: (fPx * D) / C.z, // 얼굴 크기 유지
    cx: w / 2,
    cy: h / 2,
  };
}

/** 3D 점 하나를 보정된 시점으로. weight<1이면 회전·거리 효과를 줄여 배경 쪽으로 부드럽게 이어짐 */
export function transformPoint(p: Vec3, t: ViewTransform): Vec3 {
  const dx = p.x - t.C.x;
  const dy = p.y - t.C.y;
  const dz = p.z - t.C.z;
  // x축 회전: [y';z'] = [cos sin; -sin cos][y;z]
  const ry = dy * t.cos + dz * t.sin;
  const rz = -dy * t.sin + dz * t.cos;
  return { x: dx + t.C2.x, y: ry + t.C2.y, z: rz + t.C2.z };
}

export function project(q: Vec3, t: ViewTransform): [number, number] {
  return [t.cx + (t.f2 * q.x) / q.z, t.cy + (t.f2 * q.y) / q.z];
}

export interface LiveMesh {
  src: Float32Array;
  dst: Float32Array;
  triangles: Uint32Array;
  /** 보정된 얼굴 랜드마크 2D (검증용, 478점) */
  faceDst: Float32Array;
}

const RING_N = 24;

/**
 * 워프 메시: 얼굴 478점 + 머리 링(24) + 바깥 완충 링(24) + 테두리 고정점(36).
 * 점 개수는 항상 같아서 프레임 간 변위를 평활화할 수 있음.
 */
export function buildLiveMesh(
  lms: PxLandmark[],
  w: number,
  h: number,
  fPx: number,
  dM: number,
  corr: ViewCorrection,
): LiveMesh {
  const P = toMetric(lms, w, h, fPx, dM);
  const t = makeTransform(P, fPx, w, h, corr);
  const src: number[] = [];
  const dst: number[] = [];

  let maxZ = -Infinity;
  for (let i = 0; i < lms.length; i++) {
    src.push(lms[i].X, lms[i].Y);
    const [x, y] = project(transformPoint(P[i], t), t);
    dst.push(x, y);
    if (P[i].z > maxZ) maxZ = P[i].z;
  }
  const faceDst = new Float32Array(dst);

  // 머리(머리카락·귀) 링: 얼굴 외곽보다 조금 뒤에 있다고 가정하고 같이 회전·이동
  const b = faceBox(lms);
  const ringR = 0.85 * Math.max(b.w, b.h);
  const headZ = maxZ + 0.03;
  const liftPx = (sx: number, sy: number, z: number): Vec3 => ({ x: ((sx - t.cx) * z) / fPx, y: ((sy - t.cy) * z) / fPx, z });
  const clampX = (v: number) => Math.min(w, Math.max(0, v));
  const clampY = (v: number) => Math.min(h, Math.max(0, v));
  for (let k = 0; k < RING_N; k++) {
    const a = (k / RING_N) * Math.PI * 2;
    const sx = b.cx + Math.cos(a) * ringR;
    const sy = b.cy + Math.sin(a) * ringR * 1.15;
    src.push(sx, sy);
    const [x, y] = project(transformPoint(liftPx(sx, sy, headZ), t), t);
    dst.push(x, y);
    // 바깥 완충 링: 변형을 절반만
    const ox = clampX(b.cx + Math.cos(a) * ringR * 1.7);
    const oy = clampY(b.cy + Math.sin(a) * ringR * 1.7 * 1.15);
    const [x2, y2] = project(transformPoint(liftPx(ox, oy, headZ + 0.05), t), t);
    src.push(ox, oy);
    dst.push((ox + x2) / 2, (oy + y2) / 2);
  }

  // 화면 테두리는 고정
  const E = 8;
  for (let k = 0; k <= E; k++) {
    const s = k / E;
    for (const [sx, sy] of [
      [s * w, 0],
      [s * w, h],
      [0, s * h],
      [w, s * h],
    ]) {
      src.push(sx, sy);
      dst.push(sx, sy);
    }
  }

  const n = src.length / 2;
  const coords = new Float64Array(src);
  const triangles = new Delaunator(coords).triangles;
  return { src: new Float32Array(src), dst: new Float32Array(dst), triangles: new Uint32Array(triangles.subarray(0, triangles.length)), faceDst: faceDst.subarray(0, Math.min(n, 478 * 2)) as Float32Array };
}

/** 프레임 간 변위(dst-src) 지수평활. 영상과 메시는 같은 프레임이라 src는 그대로 두고 변위만 부드럽게 */
export class DisplacementSmoother {
  private prev: Float32Array | null = null;
  private alpha: number;
  constructor(alpha = 0.6) {
    this.alpha = alpha;
  }
  apply(mesh: LiveMesh): LiveMesh {
    const n = mesh.src.length;
    const disp = new Float32Array(n);
    for (let i = 0; i < n; i++) disp[i] = mesh.dst[i] - mesh.src[i];
    if (this.prev && this.prev.length === n) {
      for (let i = 0; i < n; i++) disp[i] = this.alpha * this.prev[i] + (1 - this.alpha) * disp[i];
    }
    this.prev = disp;
    const dst = new Float32Array(n);
    for (let i = 0; i < n; i++) dst[i] = mesh.src[i] + disp[i];
    return { ...mesh, dst, faceDst: dst.subarray(0, mesh.faceDst.length) };
  }
  reset() {
    this.prev = null;
  }
}

/** 스칼라 지수평활 */
export class Ema {
  value: number | null = null;
  private alpha: number;
  constructor(alpha: number) {
    this.alpha = alpha;
  }
  push(v: number): number {
    if (!Number.isFinite(v)) return this.value ?? NaN;
    this.value = this.value == null ? v : this.alpha * this.value + (1 - this.alpha) * v;
    return this.value;
  }
  reset() {
    this.value = null;
  }
}
