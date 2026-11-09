import type { PxLandmark } from './lib/geometry';

export interface Capture {
  /** 반전하지 않은 원본 프레임 (= 남이 보는 방향) */
  canvas: HTMLCanvasElement;
  lms: PxLandmark[];
  fPx: number;
  /** 촬영 시 추정 거리(m) */
  distM: number;
  source: 'live' | 'photo';
}
