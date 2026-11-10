// 실시간 카메라 왜곡 보정 (각도·조명·생김새는 건드리지 않음)
//
//   ① 근거리 원근 왜곡 (Fried 2016, Ward 2018)
//      랜드마크별 배율 k_i = (1 + ζ_i/d) / (1 + ζ_i/D),  ζ: 눈 평면 기준 깊이(m), d: 촬영 거리, D: 목표 거리
//      ζ는 홍채 크기로 미터 환산되므로 초점거리 오차의 영향은 d를 통해서만 들어옴
//   ② 광각 투영 늘어짐 (Shih 2019, Lai 2022)
//      얼굴 점만 스테레오그래픽 r_u = r0·tan(½·atan(r_p/f))로 옮기고 닮음변환으로 위치·크기 복원,
//      가장자리에 있을수록 강하게: w = tanh(2·r/r_max)
//
// 안정성 (Lai 2022, Shih 2019, Casiez 2012 권고)
//   - 메시 위상 고정: 매 프레임 삼각분할 대신 고정 격자에 변위를 확산(라플라시안 Jacobi, 이전 해에서 시작)
//   - 얼굴 크기로 정규화한 변위를 지수평활 (u = 0.2·raw + 0.8·prev ≈ Lai의 λ_f:λ_t = 4:16)
//   - 머리 바깥으로 갈수록 변위 0 (배경 고정), 이미지 테두리 0
//   - 얼굴을 놓치면 200ms 동안 보정을 0으로 페이드

import { IDX, faceBox, type PxLandmark } from './geometry';

export const CORRECTION = {
  /** 목표 시점 거리(m): 초상 사진 관례 1.5m (Ward 2018), Zhao 2019는 1.4~2m 권장 */
  targetM: 1.5,
  /** 얼굴 로컬 변위 평활 계수 (새 값 비중) */
  dispAlpha: 0.2,
  /** 귀·윤곽 배율 상한: 메시 워프는 가려진 귀를 만들 수 없으므로 과도한 확장 방지 */
  maxRimScale: 1.1,
  /** 얼굴을 놓쳤을 때 보정을 끄는 시간(ms) */
  fadeMs: 200,
  /** 머리 타원 반경 대비 변위 감쇠 구간 */
  falloff: [1.1, 1.6] as [number, number],
  /** 격자 셀 크기(px, 긴 변 1280 기준) */
  cellPx: 32,
  jacobiIters: 24,
  /** 거리 1€ 필터 */
  oneEuro: { minCutoff: 0.8, beta: 0.4, dCutoff: 1.0 },
};

export interface CorrectionOptions {
  perspective: boolean;
  wideAngle: boolean;
  targetM: number;
}

// ---------------- ① 원근 ----------------

/** k_i = (1 + ζ/d) / (1 + ζ/D). D=∞면 1 + ζ/d */
export function perspectiveScale(dM: number, zetaM: number, targetM: number): number {
  const z = Math.max(zetaM, -0.6 * dM);
  if (!Number.isFinite(targetM)) return 1 + z / dM;
  return (1 + z / dM) / (1 + z / targetM);
}

// ---------------- ② 광각 ----------------

/** Shih 2019: 이미지 경계(반경 d/2)에서 직선 투영과 같아지도록 맞춘 스테레오그래픽 반경 */
export function stereoRadius(r: number, f: number, minDim: number): number {
  const half = minDim / 2;
  const r0 = half / Math.tan(0.5 * Math.atan(half / f));
  return r0 * Math.tan(0.5 * Math.atan(r / f));
}

/**
 * 얼굴 점들을 스테레오그래픽으로 옮긴 뒤 원래 점들에 맞는 닮음변환(평행이동+균일 배율, 회전 없음)으로 되돌림.
 * → 위치·크기는 유지, 방사 방향으로만 늘어난 모양이 원래 비율로
 */
export function wideAngleFace(pts: Float64Array, n: number, cx: number, cy: number, f: number, minDim: number): Float64Array {
  const s = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const dx = pts[2 * i] - cx;
    const dy = pts[2 * i + 1] - cy;
    const r = Math.hypot(dx, dy);
    const k = r > 1e-6 ? stereoRadius(r, f, minDim) / r : 1;
    s[2 * i] = cx + dx * k;
    s[2 * i + 1] = cy + dy * k;
  }
  let pmx = 0, pmy = 0, smx = 0, smy = 0;
  for (let i = 0; i < n; i++) {
    pmx += pts[2 * i]; pmy += pts[2 * i + 1]; smx += s[2 * i]; smy += s[2 * i + 1];
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

// ---------------- 목표 변위 (랜드마크 + 머리 링) ----------------

export const RING_N = 32;
export const TARGET_POINTS = 478 + RING_N;

export interface Targets {
  /** 위치 [x,y]*N (영상 px) */
  pos: Float64Array;
  /** 변위 [dx,dy]*N */
  disp: Float64Array;
  /** 얼굴 크기(px): 변위 정규화용 */
  scale: number;
  /** 머리 타원 (변위 감쇠 기준) */
  head: { cx: number; cy: number; rx: number; ry: number };
}

export function computeTargets(lms: PxLandmark[], w: number, h: number, fPx: number, dM: number, opt: CorrectionOptions): Targets {
  const n = 478;
  const pos = new Float64Array(TARGET_POINTS * 2);
  const disp = new Float64Array(TARGET_POINTS * 2);
  // 원근 배율의 기준점: 두 눈 사이(ζ=0 평면). 화면 중심 기준이면 얼굴 전체가 밀려 배경까지 끌고 감
  const ax = (lms[IDX.rightIrisCenter].X + lms[IDX.leftIrisCenter].X) / 2;
  const ay = (lms[IDX.rightIrisCenter].Y + lms[IDX.leftIrisCenter].Y) / 2;
  const pxPerM = fPx / dM;
  const zRef = (lms[IDX.rightIrisCenter].Z + lms[IDX.leftIrisCenter].Z) / 2;
  const targetM = Math.max(opt.targetM, dM); // 이미 목표보다 멀면 원근 보정 없음

  const moved = new Float64Array(n * 2);
  let maxZeta = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = lms[i];
    pos[2 * i] = p.X;
    pos[2 * i + 1] = p.Y;
    const zeta = (p.Z - zRef) / pxPerM;
    if (zeta > maxZeta) maxZeta = zeta;
    let k = opt.perspective ? perspectiveScale(dM, zeta, targetM) : 1;
    k = Math.min(k, CORRECTION.maxRimScale);
    moved[2 * i] = ax + (p.X - ax) * k;
    moved[2 * i + 1] = ay + (p.Y - ay) * k;
  }

  let final = moved;
  const b = faceBox(lms);
  if (opt.wideAngle) {
    const cx = w / 2, cy = h / 2;
    const rMax = Math.hypot(cx, cy);
    const rFace = Math.hypot(b.cx - cx, b.cy - cy);
    const wt = Math.tanh((2 * rFace) / rMax); // Lai 2022: 가장자리일수록 강하게
    if (wt > 0.02) {
      const st = wideAngleFace(moved, n, cx, cy, fPx, Math.min(w, h));
      final = new Float64Array(n * 2);
      for (let i = 0; i < 2 * n; i++) final[i] = moved[i] + wt * (st[i] - moved[i]);
    }
  }
  let mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    disp[2 * i] = final[2 * i] - pos[2 * i];
    disp[2 * i + 1] = final[2 * i + 1] - pos[2 * i + 1];
    mdx += final[2 * i] - moved[2 * i];
    mdy += final[2 * i + 1] - moved[2 * i + 1];
  }
  mdx /= n;
  mdy /= n;

  // 머리 링(머리카락·귀): 얼굴 윤곽 바로 바깥, 윤곽보다 조금 뒤에 있다고 보고 상한 배율 적용
  const head = { cx: b.cx, cy: b.cy - 0.08 * b.h, rx: 0.62 * b.w, ry: 0.66 * b.h };
  let kRim = opt.perspective ? perspectiveScale(dM, maxZeta + 0.02, targetM) : 1;
  kRim = Math.min(kRim, CORRECTION.maxRimScale);
  for (let j = 0; j < RING_N; j++) {
    const a = (j / RING_N) * Math.PI * 2;
    const sx = head.cx + Math.cos(a) * head.rx;
    const sy = head.cy + Math.sin(a) * head.ry;
    const i = n + j;
    pos[2 * i] = sx;
    pos[2 * i + 1] = sy;
    disp[2 * i] = ax + (sx - ax) * kRim - sx + mdx;
    disp[2 * i + 1] = ay + (sy - ay) * kRim - sy + mdy;
  }
  return { pos, disp, scale: Math.max(b.w, b.h), head };
}

// ---------------- 고정 격자 변위장 ----------------

export interface FieldMesh {
  src: Float32Array;
  dst: Float32Array;
  triangles: Uint32Array;
}

export class DisplacementField {
  readonly w: number;
  readonly h: number;
  readonly gx: number;
  readonly gy: number;
  private ux: Float64Array;
  private uy: Float64Array;
  private wsum: Float64Array;
  private tx: Float64Array;
  private ty: Float64Array;
  private nx: Float64Array;
  private ny: Float64Array;
  readonly mesh: FieldMesh;

  constructor(w: number, h: number, cellPx = CORRECTION.cellPx * (Math.max(w, h) / 1280)) {
    this.w = w;
    this.h = h;
    this.gx = Math.max(8, Math.round(w / cellPx));
    this.gy = Math.max(8, Math.round(h / cellPx));
    const nv = (this.gx + 1) * (this.gy + 1);
    this.ux = new Float64Array(nv);
    this.uy = new Float64Array(nv);
    this.wsum = new Float64Array(nv);
    this.tx = new Float64Array(nv);
    this.ty = new Float64Array(nv);
    this.nx = new Float64Array(nv);
    this.ny = new Float64Array(nv);
    const src = new Float32Array(nv * 2);
    for (let j = 0; j <= this.gy; j++)
      for (let i = 0; i <= this.gx; i++) {
        const v = j * (this.gx + 1) + i;
        src[2 * v] = (i / this.gx) * w;
        src[2 * v + 1] = (j / this.gy) * h;
      }
    const tri: number[] = [];
    for (let j = 0; j < this.gy; j++)
      for (let i = 0; i < this.gx; i++) {
        const a = j * (this.gx + 1) + i, b2 = a + 1, c = a + this.gx + 1, d = c + 1;
        tri.push(a, b2, c, b2, d, c);
      }
    this.mesh = { src, dst: Float32Array.from(src), triangles: new Uint32Array(tri) };
  }

  reset() {
    this.ux.fill(0);
    this.uy.fill(0);
  }

  /** 격자 정점 변위 (검증·테스트용) */
  displacementAt(px: number, py: number): [number, number] {
    const i = Math.round((px / this.w) * this.gx);
    const j = Math.round((py / this.h) * this.gy);
    const v = j * (this.gx + 1) + i;
    return [this.mesh.dst[2 * v] - this.mesh.src[2 * v], this.mesh.dst[2 * v + 1] - this.mesh.src[2 * v + 1]];
  }

  /**
   * 목표 변위를 격자에 이선형으로 뿌리고(soft constraint), 라플라시안 Jacobi로 빈 곳을 채움.
   * 이전 프레임 해에서 시작(warm start)해 반복 횟수를 줄이고 시간적으로도 안정.
   * strength: 0~1 (페이드)
   */
  solve(t: Targets | null, strength: number, iters = CORRECTION.jacobiIters): FieldMesh {
    const { gx, gy } = this;
    const W1 = gx + 1;
    this.wsum.fill(0);
    this.tx.fill(0);
    this.ty.fill(0);
    if (t && strength > 0) {
      const N = t.pos.length / 2;
      for (let p = 0; p < N; p++) {
        const fx = (t.pos[2 * p] / this.w) * gx;
        const fy = (t.pos[2 * p + 1] / this.h) * gy;
        if (fx < 0 || fy < 0 || fx > gx || fy > gy) continue;
        const i0 = Math.min(gx - 1, Math.floor(fx)), j0 = Math.min(gy - 1, Math.floor(fy));
        const ax = fx - i0, ay = fy - j0;
        const dx = t.disp[2 * p] * strength, dy = t.disp[2 * p + 1] * strength;
        const add = (i: number, j: number, wt: number) => {
          const v = j * W1 + i;
          this.wsum[v] += wt;
          this.tx[v] += wt * dx;
          this.ty[v] += wt * dy;
        };
        add(i0, j0, (1 - ax) * (1 - ay));
        add(i0 + 1, j0, ax * (1 - ay));
        add(i0, j0 + 1, (1 - ax) * ay);
        add(i0 + 1, j0 + 1, ax * ay);
      }
    }
    const lambda = 40; // 데이터 항 가중치
    const ux = this.ux, uy = this.uy, nx = this.nx, ny = this.ny;
    for (let it = 0; it < iters; it++) {
      for (let j = 0; j <= gy; j++)
        for (let i = 0; i <= gx; i++) {
          const v = j * W1 + i;
          if (i === 0 || j === 0 || i === gx || j === gy) {
            nx[v] = 0;
            ny[v] = 0;
            continue;
          }
          const sx = ux[v - 1] + ux[v + 1] + ux[v - W1] + ux[v + W1];
          const sy = uy[v - 1] + uy[v + 1] + uy[v - W1] + uy[v + W1];
          const ws = this.wsum[v];
          const lw = lambda * ws;
          nx[v] = (sx + (ws > 0 ? lambda * this.tx[v] : 0)) / (4 + lw);
          ny[v] = (sy + (ws > 0 ? lambda * this.ty[v] : 0)) / (4 + lw);
        }
      ux.set(nx);
      uy.set(ny);
    }
    // 머리 바깥 감쇠 (배경 고정)
    const dst = this.mesh.dst;
    const src = this.mesh.src;
    const [r0, r1] = CORRECTION.falloff;
    for (let v = 0; v < ux.length; v++) {
      let fall = 0;
      if (t) {
        const ex = (src[2 * v] - t.head.cx) / t.head.rx;
        const ey = (src[2 * v + 1] - t.head.cy) / t.head.ry;
        fall = 1 - smoothstep(r0, r1, Math.hypot(ex, ey));
      }
      dst[2 * v] = src[2 * v] + ux[v] * fall;
      dst[2 * v + 1] = src[2 * v + 1] + uy[v] * fall;
    }
    return this.mesh;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------- 시간 평활 ----------------

/** 얼굴 크기로 정규화한 변위를 지수평활 (위치는 매 프레임 실제 추적을 따름) */
export class TargetSmoother {
  private prev: Float64Array | null = null;
  private alpha: number;
  constructor(alpha = CORRECTION.dispAlpha) {
    this.alpha = alpha;
  }
  apply(t: Targets): Targets {
    const u = new Float64Array(t.disp.length);
    for (let i = 0; i < u.length; i++) u[i] = t.disp[i] / t.scale;
    if (this.prev && this.prev.length === u.length) {
      for (let i = 0; i < u.length; i++) u[i] = this.alpha * u[i] + (1 - this.alpha) * this.prev[i];
    }
    this.prev = u;
    const disp = new Float64Array(u.length);
    for (let i = 0; i < u.length; i++) disp[i] = u[i] * t.scale;
    return { ...t, disp };
  }
  reset() {
    this.prev = null;
  }
}

/** One Euro 필터 (Casiez et al. CHI 2012), 스칼라 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, tMs: number): number {
    if (!Number.isFinite(v)) return this.x ?? NaN;
    if (this.x == null) {
      this.x = v;
      this.tPrev = tMs;
      return v;
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx = ad * ((v - this.x) / dt) + (1 - ad) * this.dx;
    const a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * v + (1 - a) * this.x;
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** 카메라 프레임마다 호출하는 보정 파이프라인 */
export class LiveCorrector {
  private field: DisplacementField | null = null;
  private smoother = new TargetSmoother();
  private dist = new OneEuro(CORRECTION.oneEuro.minCutoff, CORRECTION.oneEuro.beta, CORRECTION.oneEuro.dCutoff);
  private strength = 0;
  private lastTs = 0;
  private lastTargets: Targets | null = null;
  private prevFaceDisp: Float64Array | null = null;
  /** 검증용: 직전 프레임 대비 얼굴 변위 변화량 RMS(px) */
  jitterPx = 0;
  /** 검증용: 1€ 필터를 거친 거리(m) */
  filteredDistM = NaN;

  frame(
    lms: PxLandmark[] | null,
    w: number,
    h: number,
    fPx: number,
    distM: number,
    tsMs: number,
    enabled: boolean,
    opt: Omit<CorrectionOptions, 'targetM'> = { perspective: true, wideAngle: true },
  ): FieldMesh {
    if (!this.field || this.field.w !== w || this.field.h !== h) this.field = new DisplacementField(w, h);
    const dt = this.lastTs ? tsMs - this.lastTs : 16;
    this.lastTs = tsMs;
    const active = enabled && !!lms && Number.isFinite(distM);
    // 켜질 때·꺼질 때 모두 페이드 (뚝 끊기는 느낌 방지)
    this.strength = Math.min(1, Math.max(0, this.strength + (active ? 1 : -1) * (dt / CORRECTION.fadeMs)));
    if (active) {
      const d = this.dist.filter(distM, tsMs);
      this.filteredDistM = d;
      const raw = computeTargets(lms!, w, h, fPx, d, { ...opt, targetM: CORRECTION.targetM });
      this.lastTargets = this.smoother.apply(raw);
      const fd = this.lastTargets.disp.subarray(0, 478 * 2);
      if (this.prevFaceDisp) {
        let s = 0;
        for (let i = 0; i < fd.length; i++) s += (fd[i] - this.prevFaceDisp[i]) ** 2;
        this.jitterPx = Math.sqrt(s / 478);
      }
      this.prevFaceDisp = Float64Array.from(fd);
    } else if (this.strength === 0) {
      this.smoother.reset();
      this.dist.reset();
      this.lastTargets = null;
      this.prevFaceDisp = null;
      this.field.reset();
    }
    return this.field.solve(this.lastTargets, this.strength);
  }

  /** 현재 보정된 얼굴 랜드마크 (검증용) */
  correctedFace(): { X: number; Y: number }[] | null {
    const t = this.lastTargets;
    if (!t) return null;
    return Array.from({ length: 478 }, (_, i) => ({ X: t.pos[2 * i] + t.disp[2 * i] * this.strength, Y: t.pos[2 * i + 1] + t.disp[2 * i + 1] * this.strength }));
  }
}
