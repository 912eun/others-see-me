// 얼굴 랜드마크 기반 거리·자세 추정 (순수 함수, 테스트 가능)
// MediaPipe Face Landmarker 478점 인덱스 (468~477은 홍채)

export const IDX = {
  rightIrisCenter: 468, // 피사체 기준 오른쪽 눈
  leftIrisCenter: 473,
  forehead: 10,
  chin: 152,
  rightCheek: 234,
  leftCheek: 454,
  noseTip: 1,
  rightEyeOuter: 33,
  leftEyeOuter: 263,
  // 홍채 외곽 (좌우 끝점)
  rightIrisA: 469,
  rightIrisB: 471,
  leftIrisA: 474,
  leftIrisB: 476,
} as const;

/** 정규화 랜드마크 (x,y: 0~1, z: x와 같은 스케일 = 이미지 너비 기준) */
export interface NLandmark {
  x: number;
  y: number;
  z: number;
}

/** 픽셀 좌표 랜드마크. Z도 픽셀 단위(이미지 너비 스케일)로 변환 */
export interface PxLandmark {
  X: number;
  Y: number;
  Z: number;
}

export function toPx(lms: NLandmark[], w: number, h: number): PxLandmark[] {
  return lms.map((l) => ({ X: l.x * w, Y: l.y * h, Z: l.z * w }));
}

const dist2d = (a: PxLandmark, b: PxLandmark) => Math.hypot(a.X - b.X, a.Y - b.Y);

export const DEFAULT_IPD_M = 0.063; // 성인 평균 동공간 거리 (Dodgson 2004, 평균 약 63mm)
/** 홍채 수평 직경은 사람 간 편차가 매우 작음: 11.7±0.5mm (Ablavatski et al. 2020, MediaPipe Iris) */
export const IRIS_DIAMETER_M = 0.0117;
// 전면 카메라 23mm 환산(예: iPhone 13 Pro, DxOMark) → 4:3 긴 변 화각 약 74°.
// 원근 보정량은 홍채로 미터 환산한 깊이를 쓰므로 초점거리 오차는 거리 d를 통해서만 영향 (10% 오차 → 보정량 약 10%)
export const DEFAULT_LONG_SIDE_FOV_DEG = 74; // 폰 전면 카메라 긴 변 화각 가정치 (보정 전)

/** 초점거리(px) = 정규화 초점거리 × 긴 변 픽셀 */
export function focalPx(fNorm: number, w: number, h: number): number {
  return fNorm * Math.max(w, h);
}

export function defaultFNorm(longSideFovDeg = DEFAULT_LONG_SIDE_FOV_DEG): number {
  return 0.5 / Math.tan(((longSideFovDeg / 2) * Math.PI) / 180);
}

export function ipdPx(p: PxLandmark[]): number {
  return dist2d(p[IDX.rightIrisCenter], p[IDX.leftIrisCenter]);
}

/** 좌우 홍채 직경(px) 평균. 홍채 점이 없거나 너무 작으면 NaN */
export function irisPx(p: PxLandmark[]): number {
  if (p.length < 478) return NaN;
  const r = dist2d(p[IDX.rightIrisA], p[IDX.rightIrisB]);
  const l = dist2d(p[IDX.leftIrisA], p[IDX.leftIrisB]);
  const v = (r + l) / 2;
  return v >= 4 ? v : NaN; // 4px 미만이면 노이즈가 커서 사용 안 함
}

/**
 * 핀홀 모델 거리 추정. 1순위 홍채(d = f·11.7mm/iris_px, 평균 상대오차 약 4%),
 * 홍채가 불안정하면 동공간 거리(d = f·IPD/IPD_px, 고개 돌림은 yaw로 보정)로 대체.
 */
export function estimateDistanceM(p: PxLandmark[], fPx: number, ipdM = DEFAULT_IPD_M): number {
  const iris = irisPx(p);
  if (Number.isFinite(iris)) return (fPx * IRIS_DIAMETER_M) / iris;
  const yaw = estimatePose(p).yawDeg;
  const cos = Math.max(0.5, Math.cos((yaw * Math.PI) / 180));
  return (fPx * ipdM) / (ipdPx(p) / cos);
}

/** 알려진 거리에서 측정한 값으로 초점거리 역산 (캘리브레이션) */
export function calibrateFNorm(p: PxLandmark[], knownDistM: number, w: number, h: number, ipdM = DEFAULT_IPD_M): number {
  const iris = irisPx(p);
  const fPx = Number.isFinite(iris) ? (iris * knownDistM) / IRIS_DIAMETER_M : (ipdPx(p) * knownDistM) / ipdM;
  return fPx / Math.max(w, h);
}

/** 프레임별 거리 추정의 떨림을 줄이는 중앙값 필터 */
export class MedianFilter {
  private buf: number[] = [];
  private size: number;
  constructor(size = 7) {
    this.size = size;
  }
  push(v: number): number {
    if (Number.isFinite(v)) {
      this.buf.push(v);
      if (this.buf.length > this.size) this.buf.shift();
    }
    if (!this.buf.length) return NaN;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  reset() {
    this.buf = [];
  }
}

export interface Pose {
  /** 음수 = 턱이 이마보다 카메라에 가까움 = 카메라가 얼굴보다 낮음(올려다보는 각도) */
  pitchDeg: number;
  /** 크기만 의미 있음 (좌우 방향 안내는 하지 않음) */
  yawDeg: number;
  rollDeg: number;
}

const deg = (r: number) => (r * 180) / Math.PI;

export function estimatePose(p: PxLandmark[]): Pose {
  const f = p[IDX.forehead];
  const c = p[IDX.chin];
  const r = p[IDX.rightCheek];
  const l = p[IDX.leftCheek];
  const re = p[IDX.rightEyeOuter];
  const le = p[IDX.leftEyeOuter];
  // z가 작을수록 카메라에 가까움 (MediaPipe 규약)
  const pitchDeg = deg(Math.atan2(c.Z - f.Z, Math.abs(c.Y - f.Y)));
  const yawDeg = deg(Math.atan2(l.Z - r.Z, Math.abs(l.X - r.X)));
  const rollDeg = deg(Math.atan2(le.Y - re.Y, le.X - re.X));
  return { pitchDeg, yawDeg, rollDeg: normalizeRoll(rollDeg) };
}

function normalizeRoll(a: number): number {
  // 미러 여부와 무관하게 수평 기준 편차만
  let x = a;
  while (x > 90) x -= 180;
  while (x < -90) x += 180;
  return x;
}

export function faceBox(p: PxLandmark[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p) {
    if (q.X < minX) minX = q.X;
    if (q.Y < minY) minY = q.Y;
    if (q.X > maxX) maxX = q.X;
    if (q.Y > maxY) maxY = q.Y;
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** 얼굴 실제 폭(m) — 광대 사이 픽셀 폭을 거리로 환산 */
export function faceWidthM(p: PxLandmark[], fPx: number, distM: number): number {
  return (dist2d(p[IDX.rightCheek], p[IDX.leftCheek]) * distM) / fPx;
}

export type GuideIssue = 'noFace' | 'tooClose' | 'tooFar' | 'cameraLow' | 'cameraHigh' | 'turned' | 'tilted' | 'offCenter';

export interface GuideThresholds {
  minDistM: number;
  maxDistM: number;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
}

export const DEFAULT_THRESHOLDS: GuideThresholds = {
  minDistM: 0.9,
  maxDistM: 2.0,
  pitchDeg: 10,
  yawDeg: 10,
  rollDeg: 6,
};

export interface GuideState {
  issues: GuideIssue[];
  distM: number;
  pose: Pose;
}

export function evaluateGuide(
  p: PxLandmark[] | null,
  w: number,
  h: number,
  fPx: number,
  ipdM: number,
  t: GuideThresholds = DEFAULT_THRESHOLDS,
  requireDistance = true,
): GuideState {
  if (!p) return { issues: ['noFace'], distM: NaN, pose: { pitchDeg: 0, yawDeg: 0, rollDeg: 0 } };
  const pose = estimatePose(p);
  const distM = estimateDistanceM(p, fPx, ipdM);
  const issues: GuideIssue[] = [];
  if (requireDistance) {
    if (distM < t.minDistM) issues.push('tooClose');
    if (distM > t.maxDistM) issues.push('tooFar');
  }
  if (pose.pitchDeg < -t.pitchDeg) issues.push('cameraLow');
  if (pose.pitchDeg > t.pitchDeg) issues.push('cameraHigh');
  if (Math.abs(pose.yawDeg) > t.yawDeg) issues.push('turned');
  if (Math.abs(pose.rollDeg) > t.rollDeg) issues.push('tilted');
  const b = faceBox(p);
  if (Math.abs(b.cx / w - 0.5) > 0.2 || Math.abs(b.cy / h - 0.45) > 0.22) issues.push('offCenter');
  return { issues, distM, pose };
}

export const ISSUE_TEXT: Record<GuideIssue, string> = {
  noFace: '얼굴을 화면 안에 맞춰주세요',
  tooClose: '조금 더 멀리 떨어져 주세요',
  tooFar: '조금 더 가까이 와주세요',
  cameraLow: '카메라가 얼굴보다 낮아요 · 눈높이로 올려주세요',
  cameraHigh: '카메라가 얼굴보다 높아요 · 눈높이로 내려주세요',
  turned: '얼굴을 카메라 정면으로 향해주세요',
  tilted: '고개를 똑바로 세워주세요',
  offCenter: '얼굴을 화면 가운데에 맞춰주세요',
};
