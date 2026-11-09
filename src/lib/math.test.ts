import { describe, expect, it } from 'vitest';
import { IDX, calibrateFNorm, estimateDistanceM, estimatePose, type PxLandmark } from './geometry';
import { approxDecimalAcuity, cssBlurSigmaPx, pupilDiameterMm, residualDefocusD } from './vision';
import { buildWarpMesh, noseScaleChange, scaleRatio } from './warp';

/** 핀홀 카메라로 합성 얼굴을 투영해 478점 생성 (단위 m, 카메라 좌표) */
function synthFace(dM: number, fPx: number, w = 1080, h = 1440, pitchRad = 0, withIris = false): PxLandmark[] {
  const pts: PxLandmark[] = Array.from({ length: 478 }, () => ({ X: w / 2, Y: h / 2, Z: 0 }));
  const set = (i: number, x: number, y: number, z: number) => {
    // x축 회전(pitch): 양수면 턱이 뒤로
    const y2 = y * Math.cos(pitchRad) - z * Math.sin(pitchRad);
    const z2 = y * Math.sin(pitchRad) + z * Math.cos(pitchRad);
    const depth = dM + z2;
    const s = fPx / depth;
    // MediaPipe처럼 z는 x와 같은 픽셀 스케일 (기준면 스케일로 근사)
    pts[i] = { X: w / 2 + x * s, Y: h / 2 + y2 * s, Z: z2 * (fPx / dM) };
  };
  set(IDX.rightIrisCenter, -0.0315, 0, 0);
  set(IDX.leftIrisCenter, 0.0315, 0, 0);
  set(IDX.rightEyeOuter, -0.045, 0, 0.005);
  set(IDX.leftEyeOuter, 0.045, 0, 0.005);
  set(IDX.noseTip, 0, 0.04, -0.03);
  set(IDX.forehead, 0, -0.07, -0.005);
  set(IDX.chin, 0, 0.11, -0.005);
  set(IDX.rightCheek, -0.07, 0.02, 0.04);
  set(IDX.leftCheek, 0.07, 0.02, 0.04);
  if (withIris) {
    set(IDX.rightIrisA, -0.0315 - 0.00585, 0, 0);
    set(IDX.rightIrisB, -0.0315 + 0.00585, 0, 0);
    set(IDX.leftIrisA, 0.0315 - 0.00585, 0, 0);
    set(IDX.leftIrisB, 0.0315 + 0.00585, 0, 0);
  }
  return pts;
}

describe('거리 추정', () => {
  it('핀홀 투영한 얼굴의 거리를 복원한다', () => {
    const f = 1100;
    for (const d of [0.3, 1, 1.8]) {
      expect(estimateDistanceM(synthFace(d, f), f)).toBeCloseTo(d, 2);
    }
  });
  it('홍채(11.7mm) 기반으로도 거리를 복원한다', () => {
    const f = 1100;
    for (const d of [0.3, 1, 1.5]) {
      expect(estimateDistanceM(synthFace(d, f, 1080, 1440, 0, true), f)).toBeCloseTo(d, 2);
    }
  });
  it('캘리브레이션은 초점거리를 역산한다', () => {
    const f = 1234;
    const fNorm = calibrateFNorm(synthFace(0.5, f), 0.5, 1080, 1440);
    expect(fNorm * 1440).toBeCloseTo(f, 0);
  });
});

describe('자세 추정', () => {
  it('정면이면 pitch·yaw·roll이 작다', () => {
    const p = estimatePose(synthFace(1, 1100));
    expect(Math.abs(p.pitchDeg)).toBeLessThan(2);
    expect(Math.abs(p.yawDeg)).toBeLessThan(2);
    expect(Math.abs(p.rollDeg)).toBeLessThan(2);
  });
  it('턱이 카메라 쪽으로 오면(카메라가 낮음) pitch가 음수', () => {
    expect(estimatePose(synthFace(1, 1100, 1080, 1440, -0.3)).pitchDeg).toBeLessThan(-10);
  });
});

describe('원근 보정', () => {
  it('목표 거리 = 촬영 거리면 변화 없음', () => {
    expect(scaleRatio(0.3, -0.03, 0.3)).toBeCloseTo(1, 6);
  });
  it('30cm 셀카를 1.5m 시점으로 바꾸면 코는 줄고 외곽은 커진다', () => {
    expect(scaleRatio(0.3, -0.03, 1.5)).toBeLessThan(1);
    expect(scaleRatio(0.3, 0.04, 1.5)).toBeGreaterThan(1);
  });
  it('코/얼굴폭 비율 변화가 문헌 수준(수십 %)과 같은 방향', () => {
    const f = 1100;
    const lms = synthFace(0.3, f);
    const delta = noseScaleChange({ lms, w: 1080, h: 1440, fPx: f, dM: 0.3, targetM: 1.5 });
    expect(delta).toBeLessThan(-10);
    expect(delta).toBeGreaterThan(-40);
  });
  it('메시가 만들어지고 테두리는 고정', () => {
    const f = 1100;
    const m = buildWarpMesh({ lms: synthFace(0.3, f), w: 1080, h: 1440, fPx: f, dM: 0.3, targetM: 1.5 });
    expect(m.triangles.length % 3).toBe(0);
    expect(m.triangles.length).toBeGreaterThan(30);
    const n = m.src.length / 2;
    expect(m.dst[2 * (n - 1)]).toBe(m.src[2 * (n - 1)]);
  });
});

describe('시력 시뮬레이션', () => {
  it('원점보다 가까우면 초점 오차 0', () => {
    expect(residualDefocusD(2, 0.4)).toBe(0); // -2D 원점 50cm
    expect(residualDefocusD(2, 1)).toBeCloseTo(1);
  });
  it('멀수록, 어두울수록 더 흐리다', () => {
    const base = { myopiaD: 2, faceWidthM: 0.14, faceWidthDisplayPx: 200 };
    const near = cssBlurSigmaPx({ ...base, viewDistM: 1, pupilMm: 4 });
    const far = cssBlurSigmaPx({ ...base, viewDistM: 3, pupilMm: 4 });
    const dark = cssBlurSigmaPx({ ...base, viewDistM: 1, pupilMm: 6 });
    expect(far).toBeGreaterThan(near);
    expect(dark).toBeGreaterThan(near);
  });
  it('시력 근사(CLEERE): -1D≈0.4, -2D≈0.25', () => {
    expect(approxDecimalAcuity(0)).toBe(1);
    expect(approxDecimalAcuity(1)).toBeCloseTo(0.41, 1);
    expect(approxDecimalAcuity(2)).toBeCloseTo(0.26, 1);
  });
  it('동공 지름: 밝을수록 작고 2~8mm 범위', () => {
    const day = pupilDiameterMm(1000), night = pupilDiameterMm(1);
    expect(day).toBeLessThan(night);
    expect(day).toBeGreaterThan(2);
    expect(night).toBeLessThan(8);
  });
});
