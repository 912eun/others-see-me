// 시력(굴절이상) 시뮬레이션 — 기하광학 근사
// 망막 흐림 각도(rad) ≈ 동공 지름(m) × 초점 오차(디옵터)

export type Lighting = 'day' | 'indoor' | 'evening' | 'night';

/** 장면 휘도 프리셋 (cd/m²) */
export const LUMINANCE: Record<Lighting, number> = {
  day: 1000, // 맑은 낮 야외
  indoor: 100, // 밝은 실내
  evening: 10, // 어두운 실내·저녁
  night: 1, // 밤거리
};

export const LIGHTING_LABEL: Record<Lighting, string> = {
  day: '낮 야외',
  indoor: '실내',
  evening: '어두운 실내',
  night: '밤거리',
};

/**
 * 빛 적응 동공 지름(mm). Stanley–Davies 식 (Watson & Yellott 2012 통합식의 기본항)
 *   D = 7.75 − 5.75·F/(F+2),  F = (L·a/846)^0.41
 * L: 휘도(cd/m²), a: 시야 면적(deg²). 양안 넓은 시야 ≈ 60°×60°.
 */
export function pupilDiameterMm(luminance: number, fieldDeg2 = 3600): number {
  const F = Math.pow((luminance * fieldDeg2) / 846, 0.41);
  return 7.75 - (5.75 * F) / (F + 2);
}

/**
 * 근시(안경 벗은 상태)인 사람이 거리 viewDistM에서 볼 때 남는 초점 오차(D).
 * 근시 M디옵터의 원점(far point)은 1/M m. 그보다 가까우면 조절로 선명하게 볼 수 있음.
 */
export function residualDefocusD(myopiaD: number, viewDistM: number): number {
  const m = Math.abs(myopiaD);
  return Math.max(0, m - 1 / viewDistM);
}

export function blurAngleRad(defocusD: number, pupilMm: number): number {
  return (pupilMm / 1000) * defocusD;
}

/** 정상 시력의 해상 한계 1 arcmin. 시력 V(소수시력)의 최소 분해각 = 1/V arcmin */
export const ARCMIN = Math.PI / (180 * 60);

export interface BlurInput {
  myopiaD: number;
  viewDistM: number;
  pupilMm: number;
  /** 실제 얼굴 폭(m) */
  faceWidthM: number;
  /** 화면에 그려진 얼굴 폭(px, CSS 픽셀) */
  faceWidthDisplayPx: number;
}

/** CSS blur()에 넣을 가우시안 σ(px). 원형 흐림(지름 b)의 표준편차 ≈ b/4 */
export function cssBlurSigmaPx(i: BlurInput): number {
  const faceAngle = i.faceWidthM / i.viewDistM; // 작은 각 근사
  const pxPerRad = i.faceWidthDisplayPx / faceAngle;
  const defocus = residualDefocusD(i.myopiaD, i.viewDistM);
  const blurDiameterPx = blurAngleRad(defocus, i.pupilMm) * pxPerRad;
  const sigmaDefocus = blurDiameterPx / 4;
  const sigmaAcuity = (ARCMIN * pxPerRad) / 2; // 정상 눈도 이 이하 디테일은 못 봄
  return Math.sqrt(sigmaDefocus ** 2 + sigmaAcuity ** 2);
}

/**
 * 맨눈 근시 디옵터 → 대략적 소수시력.
 * CLEERE Study Group(2021): 구면 근시 0.30~0.40D 증가마다 최소분해각(MAR) 약 0.5′ 증가.
 *   MAR(′) ≈ 1 + 0.5·(D/0.35),  소수시력 = 1/MAR
 * 6~14세 데이터 기반이라 성인에겐 근사치.
 */
export function approxDecimalAcuity(myopiaD: number): number {
  const mar = 1 + 0.5 * (Math.abs(myopiaD) / 0.35);
  return 1 / mar;
}
