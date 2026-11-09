import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { runtime } from '../qa/qa';

// wasm은 postinstall 스크립트가 public/mediapipe 로 복사 (외부 CDN 의존 없음)
const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe`;
// 모델: 번들된 파일 우선(npm run fetch-model), 없으면 구글 공식 경로
const LOCAL_MODEL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;
const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function pickModel(): Promise<string> {
  try {
    const r = await fetch(LOCAL_MODEL, { method: 'HEAD' });
    if (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) return LOCAL_MODEL;
  } catch {
    /* 로컬 모델 없음 */
  }
  return REMOTE_MODEL;
}

const cache: Partial<Record<'VIDEO' | 'IMAGE', Promise<FaceLandmarker>>> = {};

export function getLandmarker(mode: 'VIDEO' | 'IMAGE'): Promise<FaceLandmarker> {
  cache[mode] ??= (async () => {
    const t0 = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const modelAssetPath = await pickModel();
    runtime.modelSource = modelAssetPath === LOCAL_MODEL ? 'local' : 'remote';
    const make = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: mode,
        numFaces: 1,
      });
    let lm: FaceLandmarker;
    try {
      lm = await make('GPU');
      runtime.delegate = 'GPU';
    } catch {
      lm = await make('CPU'); // 일부 WebView는 GPU delegate 미지원
      runtime.delegate = 'CPU';
    }
    runtime.modelLoadMs = performance.now() - t0;
    return lm;
  })();
  return cache[mode]!;
}
