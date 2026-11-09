import { DEFAULT_IPD_M, defaultFNorm } from './geometry';

export interface CameraSettings {
  /** 정규화 초점거리 (초점px / 긴 변 px). 캘리브레이션하면 갱신 */
  fNorm: number;
  /** 사용자 동공간 거리(m). 안경 처방전 PD를 알면 입력 */
  ipdM: number;
  calibrated: boolean;
}

const KEY = 'osm.camera.v1';

export function loadSettings(): CameraSettings {
  const fallback: CameraSettings = { fNorm: defaultFNorm(), ipdM: DEFAULT_IPD_M, calibrated: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function saveSettings(s: CameraSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장 불가 환경: 이번 세션에만 적용 */
  }
}
