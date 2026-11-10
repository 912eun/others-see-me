// 실사용 검증(QA) 모드: 측정 기록·내보내기, 런타임 정보
import { IDX, type PxLandmark, type Pose } from '../lib/geometry';

export const QA_ENABLED =
  import.meta.env.VITE_QA === '1' || new URLSearchParams(location.search).has('qa');

/** 카메라 루프가 매 프레임 갱신하는 최신 측정값 */
export interface LiveMetrics {
  t: number;
  w: number;
  h: number;
  fPx: number;
  irisPx: number;
  ipdPx: number;
  distRawM: number;
  distM: number;
  pose: Pose;
  issues: string[];
  fps: number;
  calibrated: boolean;
  /** 실시간 보정: 직전 프레임 대비 얼굴 변위 변화 RMS(px) — 정지 상태 떨림 지표 */
  jitterPx?: number;
  correctedFace?: { X: number; Y: number }[] | null;
  rawFace?: PxLandmark[];
}

export const runtime = {
  delegate: '' as '' | 'GPU' | 'CPU',
  modelSource: '' as '' | 'local' | 'remote',
  modelLoadMs: 0,
  cameraLabel: '',
  trackSettings: '' as string,
};

export type QaKind = 'distance' | 'pose' | 'warp' | 'note';

export interface QaEntry {
  id: string;
  at: string;
  kind: QaKind;
  /** distance: 줄자 실측(cm) / pose: 의도한 자세 / warp: 비교 설명 */
  label: string;
  truth?: number;
  values: Record<string, number | string | boolean>;
}

const KEY = 'osm.qa.v1';

export function loadLog(): QaEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveLog(log: QaEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    /* 저장 불가: 화면에만 유지 */
  }
}

export function addEntry(e: Omit<QaEntry, 'id' | 'at'>): QaEntry[] {
  const log = loadLog();
  log.push({ ...e, id: Math.random().toString(36).slice(2, 8), at: new Date().toISOString() });
  saveLog(log);
  return log;
}

export function deviceSummary(): Record<string, string> {
  return {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    delegate: runtime.delegate,
    model: runtime.modelSource,
    modelLoadMs: String(Math.round(runtime.modelLoadMs)),
    camera: runtime.cameraLabel,
    track: runtime.trackSettings,
  };
}

export function toCsv(log: QaEntry[]): string {
  const keys = Array.from(new Set(log.flatMap((e) => Object.keys(e.values)))).sort();
  const head = ['id', 'at', 'kind', 'label', 'truth', ...keys];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dev = deviceSummary();
  const meta = Object.entries(dev).map(([k, v]) => `# ${k}: ${v}`);
  return [
    ...meta,
    head.join(','),
    ...log.map((e) => [e.id, e.at, e.kind, e.label, e.truth, ...keys.map((k) => e.values[k])].map(esc).join(',')),
  ].join('\n');
}

/** CSV를 폰에서 꺼내기: 공유 시트 → 다운로드 → 클립보드 순으로 시도 */
export async function exportLog(log: QaEntry[]): Promise<string> {
  const csv = toCsv(log);
  const name = `others-see-me-qa-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: '검증 기록' });
      return '공유했어요';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return '공유를 취소했어요';
  }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return '파일로 저장했어요';
  } catch {
    await navigator.clipboard.writeText(csv);
    return '클립보드에 복사했어요';
  }
}

// ---------- 원근 보정 정량 검증: 얼굴 비율 비교 ----------

/** 거리로 크게 변하는 비율들. 모두 광대 폭(234-454)으로 정규화 */
const RATIOS: Record<string, [number, number] | 'height'> = {
  noseWidth: [129, 358], // 콧볼 폭
  eyeOuter: [IDX.rightEyeOuter, IDX.leftEyeOuter],
  mouthWidth: [61, 291],
  faceHeight: 'height', // 이마(10)–턱(152)
};

export function faceRatios(pts: { X: number; Y: number }[]): Record<string, number> {
  const d = (a: number, b: number) => Math.hypot(pts[a].X - pts[b].X, pts[a].Y - pts[b].Y);
  const fw = d(IDX.rightCheek, IDX.leftCheek);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(RATIOS)) {
    out[k] = (v === 'height' ? d(IDX.forehead, IDX.chin) : d(v[0], v[1])) / fw;
  }
  return out;
}

export function meshDstPoints(dst: Float32Array, n = 478): { X: number; Y: number }[] {
  return Array.from({ length: n }, (_, i) => ({ X: dst[2 * i], Y: dst[2 * i + 1] }));
}

export interface RatioComparison {
  key: string;
  ref: number;
  orig: number;
  corr: number;
  /** 기준 대비 오차(%) */
  origErr: number;
  corrErr: number;
}

export function compareRatios(ref: PxLandmark[], orig: PxLandmark[], corrected: { X: number; Y: number }[]): RatioComparison[] {
  const r = faceRatios(ref);
  const o = faceRatios(orig);
  const c = faceRatios(corrected);
  return Object.keys(r).map((key) => ({
    key,
    ref: r[key],
    orig: o[key],
    corr: c[key],
    origErr: ((o[key] - r[key]) / r[key]) * 100,
    corrErr: ((c[key] - r[key]) / r[key]) * 100,
  }));
}

export const RATIO_LABEL: Record<string, string> = {
  noseWidth: '콧볼 폭',
  eyeOuter: '눈꼬리 사이',
  mouthWidth: '입 폭',
  faceHeight: '얼굴 길이',
};
