import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_THRESHOLDS,
  ISSUE_TEXT,
  MedianFilter,
  calibrateFNorm,
  evaluateGuide,
  focalPx,
  ipdPx,
  irisPx,
  toPx,
  type GuideState,
  type PxLandmark,
} from '../lib/geometry';
import { getLandmarker } from '../lib/landmarker';
import { loadSettings, saveSettings, type CameraSettings } from '../lib/settings';
import type { Capture } from '../types';
import QaCameraPanel from '../qa/QaCameraPanel';
import { QA_ENABLED, runtime, type LiveMetrics } from '../qa/qa';

type Mode = 'stand' | 'hand';
const HOLD_MS = 700;
const COUNTDOWN = 3;

interface Props {
  mirror: boolean;
  onMirrorChange: (m: boolean) => void;
  onCapture: (c: Capture) => void;
}

export default function CameraScreen({ mirror, onMirrorChange, onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'nocamera' | 'nomodel'>('loading');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('stand');
  const [auto, setAuto] = useState(!QA_ENABLED); // 검증 중엔 측정하다 찍히지 않게 기본 꺼짐
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [settings, setSettings] = useState<CameraSettings>(loadSettings);
  const [showCalib, setShowCalib] = useState(false);

  // 루프에서 읽는 값은 ref로 (리렌더 없이 최신값)
  const modeRef = useRef(mode);
  const autoRef = useRef(auto);
  const settingsRef = useRef(settings);
  const captureReq = useRef(false);
  const lastLms = useRef<PxLandmark[] | null>(null);
  const distFilter = useRef(new MedianFilter(7));
  const smoothDist = useRef<number | null>(null);
  modeRef.current = mode;
  autoRef.current = auto;
  settingsRef.current = settings;

  const metricsRef = useRef<LiveMetrics | null>(null);
  const fpsRef = useRef({ last: 0, fps: 0 });
  const okSince = useRef<number | null>(null);
  const countStart = useRef<number | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia 미지원');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        const v = videoRef.current!;
        const track = stream.getVideoTracks()[0];
        runtime.cameraLabel = track?.label ?? '';
        try {
          runtime.trackSettings = JSON.stringify(track?.getSettings() ?? {});
        } catch {
          /* 일부 브라우저 미지원 */
        }
        v.srcObject = stream;
        await v.play();
      } catch (e) {
        setStatus('nocamera');
        setError(e instanceof Error ? e.message : String(e));
        return;
      }

      let lm;
      try {
        lm = await getLandmarker('VIDEO');
      } catch (e) {
        setStatus('nomodel');
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      setStatus('ready');

      let lastTs = -1;
      const loop = () => {
        if (stopped) return;
        const v = videoRef.current;
        if (v && v.readyState >= 2 && v.videoWidth > 0) {
          const ts = performance.now();
          if (ts > lastTs) {
            lastTs = ts;
            const res = lm.detectForVideo(v, ts);
            const w = v.videoWidth;
            const h = v.videoHeight;
            const s = settingsRef.current;
            const fPx = focalPx(s.fNorm, w, h);
            const lms = res.faceLandmarks[0] ? toPx(res.faceLandmarks[0], w, h) : null;
            lastLms.current = lms;
            const g = evaluateGuide(lms, w, h, fPx, s.ipdM, DEFAULT_THRESHOLDS, modeRef.current === 'stand');
            const distRawM = g.distM;
            if (Number.isFinite(g.distM)) {
              smoothDist.current = distFilter.current.push(g.distM);
              g.distM = smoothDist.current;
            }
            setGuide(g);
            const fr = fpsRef.current;
            if (fr.last) fr.fps = fr.fps * 0.9 + (1000 / (ts - fr.last)) * 0.1;
            fr.last = ts;
            metricsRef.current = lms
              ? {
                  t: ts,
                  w,
                  h,
                  fPx,
                  irisPx: irisPx(lms),
                  ipdPx: ipdPx(lms),
                  distRawM,
                  distM: g.distM,
                  pose: g.pose,
                  issues: g.issues,
                  fps: fr.fps,
                  calibrated: s.calibrated,
                }
              : null;

            // 자동 촬영: 조건 유지 HOLD_MS → 카운트다운
            const ok = g.issues.length === 0;
            if (autoRef.current && ok) {
              okSince.current ??= ts;
              if (ts - okSince.current > HOLD_MS) {
                countStart.current ??= ts;
                const left = COUNTDOWN - Math.floor((ts - countStart.current) / 1000);
                setCount(left);
                if (left <= 0) captureReq.current = true;
              }
            } else {
              okSince.current = null;
              countStart.current = null;
              setCount(null);
            }

            if (captureReq.current && lms) {
              captureReq.current = false;
              okSince.current = null;
              countStart.current = null;
              setCount(null);
              const c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              c.getContext('2d')!.drawImage(v, 0, 0, w, h);
              onCapture({ canvas: c, lms, fPx, distM: smoothDist.current ?? g.distM, source: 'live' });
              return;
            }
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCapture]);

  const calibrate = useCallback((knownCm: number, pdMm: number) => {
    const v = videoRef.current;
    const lms = lastLms.current;
    if (!v || !lms) return alert('얼굴이 보일 때 눌러주세요');
    const ipdM = pdMm / 1000;
    const fNorm = calibrateFNorm(lms, knownCm / 100, v.videoWidth, v.videoHeight, ipdM);
    const s = { fNorm, ipdM, calibrated: true };
    setSettings(s);
    saveSettings(s);
    distFilter.current.reset();
    smoothDist.current = null;
    setShowCalib(false);
  }, []);

  if (status === 'nocamera') return <PhotoFallback reason={error} onCapture={onCapture} />;
  if (status === 'nomodel')
    return (
      <div className="fallback">
        <h2>얼굴 인식 모델을 불러오지 못했어요</h2>
        <p className="hint">네트워크를 확인하거나, 모델을 번들에 포함해 주세요 (npm run fetch-model). ({error})</p>
        <button className="shutter" onClick={() => location.reload()}>
          다시 시도
        </button>
      </div>
    );

  const main = guide?.issues[0];
  const ready = guide && guide.issues.length === 0;

  return (
    <div className="camera">
      <div className="viewport">
        <video ref={videoRef} playsInline muted className={mirror ? 'mirrored' : ''} />
        <svg className="overlay" viewBox="0 0 100 133" preserveAspectRatio="xMidYMid slice">
          <ellipse cx="50" cy="58" rx="24" ry="32" className={ready ? 'oval ok' : 'oval'} />
          <line x1="20" x2="80" y1="50" y2="50" className="eyeline" />
        </svg>
        {count != null && count > 0 && <div className="countdown">{count}</div>}
        {status === 'loading' && <div className="toast">카메라와 얼굴 인식을 준비하고 있어요</div>}
      </div>

      <div className="guide-panel">
        <p className={ready ? 'guide-msg ok' : 'guide-msg'}>
          {status === 'loading' ? '잠시만요' : ready ? '좋아요! 그대로 있어주세요' : main ? ISSUE_TEXT[main] : ''}
        </p>
        {guide && Number.isFinite(guide.distM) && (
          <div className="chips">
            <span className="chip">거리 {guide.distM.toFixed(2)}m{settings.calibrated ? '' : ' (추정)'}</span>
            <span className="chip">상하 {guide.pose.pitchDeg.toFixed(0)}°</span>
            <span className="chip">좌우 {Math.abs(guide.pose.yawDeg).toFixed(0)}°</span>
            <span className="chip">기울기 {Math.abs(guide.pose.rollDeg).toFixed(0)}°</span>
          </div>
        )}

        <div className="seg">
          <button className={mode === 'stand' ? 'on' : ''} onClick={() => setMode('stand')}>
            폰 세워두고 (1~2m)
          </button>
          <button className={mode === 'hand' ? 'on' : ''} onClick={() => setMode('hand')}>
            손에 들고 (보정)
          </button>
        </div>
        <p className="hint">
          {mode === 'stand'
            ? '폰을 눈높이에 세워두고 1~2m 떨어져 서세요. 화면 말고 카메라 렌즈를 보면 자세가 맞을 때 자동으로 찍혀요.'
            : '팔 길이에서 찍으면 1.5m 눈높이에서 본 모습으로 자동 보정돼요.'}
        </p>

        <div className="row">
          <label className="switch">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 자동 촬영
          </label>
          <label className="switch">
            <input type="checkbox" checked={!mirror} onChange={(e) => onMirrorChange(!e.target.checked)} /> 남이 보는 방향
          </label>
          <button className="link" onClick={() => setShowCalib((s) => !s)}>
            거리 보정
          </button>
        </div>

        {showCalib && <Calibration ipdMm={settings.ipdM * 1000} onApply={calibrate} />}

        {QA_ENABLED && <QaCameraPanel metricsRef={metricsRef} />}

        <button className="shutter" disabled={status !== 'ready' || !guide || guide.issues.includes('noFace')} onClick={() => (captureReq.current = true)}>
          지금 찍기
        </button>
      </div>
    </div>
  );
}

function Calibration({ ipdMm, onApply }: { ipdMm: number; onApply: (cm: number, pdMm: number) => void }) {
  const [cm, setCm] = useState(50);
  const [pd, setPd] = useState(Math.round(ipdMm));
  return (
    <div className="calib">
      <p>
        폰마다 카메라 화각이 달라서 처음엔 거리가 추정치예요. 줄자로 카메라와 눈 사이를 정확히 재고, 렌즈를 보면서 버튼을 누르면 이 폰에 맞게 보정돼요. PD(동공간 거리)는 홍채가 잘 안 잡힐 때만 쓰여요.
      </p>
      <div className="row">
        <label>
          거리 <input type="number" value={cm} min={20} max={300} onChange={(e) => setCm(+e.target.value)} /> cm
        </label>
        <label>
          PD <input type="number" value={pd} min={50} max={75} onChange={(e) => setPd(+e.target.value)} /> mm
        </label>
      </div>
      <button className="secondary" onClick={() => onApply(cm, pd)}>
        이 거리로 보정하기
      </button>
    </div>
  );
}

/** getUserMedia가 안 되는 환경(일부 WebView): 사진 한 장으로 분석 */
function PhotoFallback({ reason, onCapture }: { reason: string; onCapture: (c: Capture) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const onFile = async (file: File) => {
    setBusy(true);
    setMsg('');
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      const lm = await getLandmarker('IMAGE');
      const res = lm.detect(c);
      if (!res.faceLandmarks[0]) throw new Error('사진에서 얼굴을 찾지 못했어요');
      const lms = toPx(res.faceLandmarks[0], c.width, c.height);
      const s = loadSettings();
      const fPx = focalPx(s.fNorm, c.width, c.height);
      const g = evaluateGuide(lms, c.width, c.height, fPx, s.ipdM);
      onCapture({ canvas: c, lms, fPx, distM: g.distM, source: 'photo' });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fallback">
      <h2>사진으로 시작하기</h2>
      <p className="hint">이 환경에서는 실시간 카메라를 쓸 수 없어요 ({reason}). 셀카를 한 장 찍거나 골라주세요.</p>
      <label className="shutter as-label">
        {busy ? '분석 중…' : '셀카 찍기 / 고르기'}
        <input type="file" accept="image/*" capture="user" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </label>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
