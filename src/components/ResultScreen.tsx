import { useEffect, useMemo, useRef, useState } from 'react';
import { IDX, estimatePose, faceWidthM, toPx, type PxLandmark } from '../lib/geometry';
import { buildWarpMesh, renderWarp } from '../lib/warp';
import { LIGHTING_LABEL, LUMINANCE, approxDecimalAcuity, cssBlurSigmaPx, pupilDiameterMm, type Lighting } from '../lib/vision';
import { AiError, aiEndpoint, getConsent, needsCorrection, requestCorrection, setConsent, type Consent } from '../lib/ai';
import { getLandmarker } from '../lib/landmarker';
import type { Capture } from '../types';
import { QA_ENABLED, RATIO_LABEL, addEntry, compareRatios, meshDstPoints } from '../qa/qa';

interface Props {
  capture: Capture;
  mirror: boolean;
  onMirrorChange: (m: boolean) => void;
  onRetake: () => void;
  /** 검증용 기준 사진 (1.5m에서 찍은 것) */
  reference?: Capture | null;
  onSetReference?: (c: Capture | null) => void;
}

interface Rendered {
  url: string;
  /** 크롭 이미지 폭 대비 얼굴(광대) 폭 비율 */
  faceFrac: number;
}

type AiState =
  | { s: 'off'; why: 'no_endpoint' | 'not_needed' | 'declined' }
  | { s: 'ask' }
  | { s: 'loading' }
  | { s: 'done'; url: string; remaining?: number }
  | { s: 'error'; message: string };

const TARGET_M = 1.5;

export default function ResultScreen({ capture, mirror, onMirrorChange, onRetake, reference, onSetReference }: Props) {
  const endpoint = useMemo(aiEndpoint, []);
  const pose = useMemo(() => estimatePose(capture.lms), [capture]);
  const distCm = Math.round(capture.distM * 100);
  const pitchDeg = Math.round(pose.pitchDeg);
  const need = needsCorrection(capture.distM, pose.pitchDeg);

  const crop = useMemo(() => cropRect(capture), [capture]);
  const original = useMemo(() => cropTo(capture.canvas, crop), [capture, crop]);

  // 기본 보정(기기 안): 가까이서 찍었을 때만 원근만 살짝. 슬라이더 없이 자동
  const basic = useMemo(() => {
    if (capture.distM >= 0.9) return null;
    try {
      const mesh = buildWarpMesh({ lms: capture.lms, w: capture.canvas.width, h: capture.canvas.height, fPx: capture.fPx, dM: capture.distM, targetM: TARGET_M });
      const r = cropTo(renderWarp(capture.canvas, mesh), crop);
      return { ...r, pts: meshDstPoints(mesh.dst) };
    } catch {
      return null;
    }
  }, [capture, crop]);

  const [consent, setConsentState] = useState<Consent>(getConsent);
  const [ai, setAi] = useState<AiState>(() =>
    !endpoint ? { s: 'off', why: 'no_endpoint' } : !need ? { s: 'off', why: 'not_needed' } : getConsent() === 'no' ? { s: 'off', why: 'declined' } : getConsent() === 'yes' ? { s: 'loading' } : { s: 'ask' },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!endpoint || !need || consent !== 'yes') return;
    const ctrl = new AbortController();
    setAi({ s: 'loading' });
    requestCorrection(endpoint, original.url, { distCm, pitchDeg }, ctrl.signal)
      .then((r) => setAi({ s: 'done', url: r.image, remaining: r.remaining }))
      .catch((e: AiError) => !ctrl.signal.aborted && setAi({ s: 'error', message: e.message }));
    return () => ctrl.abort();
  }, [endpoint, need, consent, original.url, distCm, pitchDeg, attempt]);

  const answerConsent = (c: 'yes' | 'no') => {
    setConsent(c);
    setConsentState(c);
    if (c === 'no') setAi({ s: 'off', why: 'declined' });
  };

  const [holdOriginal, setHoldOriginal] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [viewDist, setViewDist] = useState(TARGET_M);
  const [myopia, setMyopia] = useState(0);
  const [lighting, setLighting] = useState<Lighting>('indoor');
  const imgRef = useRef<HTMLImageElement>(null);
  const [displayW, setDisplayW] = useState(0);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDisplayW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const corrected = ai.s === 'done' ? { url: ai.url, label: 'AI 보정' } : basic ? { url: basic.url, label: '기본 보정' } : null;
  const shownUrl = holdOriginal || !corrected ? original.url : corrected.url;
  const badge = holdOriginal || !corrected ? '보정 전' : corrected.label;

  const sigma =
    displayW > 0 && myopia > 0
      ? cssBlurSigmaPx({
          myopiaD: myopia,
          viewDistM: viewDist,
          pupilMm: pupilDiameterMm(LUMINANCE[lighting]),
          faceWidthM: faceWidthM(capture.lms, capture.fPx, capture.distM),
          faceWidthDisplayPx: original.faceFrac * displayW,
        })
      : 0;

  const save = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      if (mirror) {
        ctx.translate(c.width, 0);
        ctx.scale(-1, 1);
      }
      const scale = displayW > 0 ? img.naturalWidth / displayW : 1;
      if (sigma > 0 && 'filter' in ctx) ctx.filter = `blur(${(sigma * scale).toFixed(2)}px)`;
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/jpeg', 0.92);
      a.download = 'others-see-me.jpg';
      a.click();
    };
    img.src = shownUrl;
  };

  const angleText = Math.abs(pitchDeg) < 8 ? '눈높이' : pitchDeg < 0 ? `카메라가 ${Math.abs(pitchDeg)}° 아래` : `카메라가 ${pitchDeg}° 위`;

  return (
    <div className="result">
      <div className="photo-wrap">
        <img
          ref={imgRef}
          src={shownUrl}
          alt="결과 사진"
          className={mirror ? 'mirrored' : ''}
          style={{ filter: sigma > 0.05 ? `blur(${sigma.toFixed(2)}px)` : undefined }}
          onPointerDown={() => setHoldOriginal(true)}
          onPointerUp={() => setHoldOriginal(false)}
          onPointerLeave={() => setHoldOriginal(false)}
          onContextMenu={(e) => e.preventDefault()}
          draggable={false}
        />
        <span className="badge">{badge}</span>
        {ai.s === 'loading' && <div className="loading">남이 보는 얼굴로 보정하는 중…</div>}
      </div>
      <p className="hint center">
        {distCm}cm · {angleText}에서 찍은 사진
        {corrected ? ` → 1.5m 눈높이 시점으로 보정했어요. 꾹 누르면 보정 전` : need ? '' : ' · 이미 남이 보는 거리·각도라 그대로 보여드려요'}
      </p>

      {ai.s === 'ask' && (
        <section className="card consent">
          <h3>AI로 더 자연스럽게 보정할까요?</h3>
          <p className="hint">
            가까이서 찍으면 코가 커 보이고 귀·옆머리가 가려져요. AI 보정을 쓰면 이 사진이 Google Gemini로 전송돼 보정된 뒤 돌아와요. 이 앱의 서버는 사진을 저장하지 않아요.
          </p>
          <div className="actions tight">
            <button className="secondary" onClick={() => answerConsent('no')}>
              기본 보정만
            </button>
            <button className="shutter" onClick={() => answerConsent('yes')}>
              동의하고 보정
            </button>
          </div>
        </section>
      )}
      {ai.s === 'error' && (
        <section className="card">
          <p className="error">{ai.message}</p>
          <p className="hint">{basic ? '대신 기기 안에서 한 기본 보정을 보여드리고 있어요.' : ''}</p>
          <button className="secondary sm" onClick={() => setAttempt((n) => n + 1)}>
            다시 시도
          </button>
        </section>
      )}
      {ai.s === 'off' && ai.why === 'declined' && need && (
        <p className="hint center">
          기본 보정만 쓰는 중 ·{' '}
          <button className="link inline" onClick={() => answerConsent('yes')}>
            AI 보정 켜기
          </button>
        </p>
      )}

      <section className="card">
        <div className="seg">
          <button className={!mirror ? 'on' : ''} onClick={() => onMirrorChange(false)}>
            남이 보는 모습
          </button>
          <button className={mirror ? 'on' : ''} onClick={() => onMirrorChange(true)}>
            거울 속 모습
          </button>
        </div>
        <p className="hint">남이 보는 모습이 어색한 건 정상이에요. 나는 거울 속 내 얼굴에 더 익숙하거든요.</p>
      </section>

      <button className="more-toggle" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '접기' : '더보기 · 시력별로 보기'}
      </button>
      {showMore && (
        <section className="card">
          <h3>
            보는 사람의 시력{' '}
            <span className="sub">
              {myopia === 0 ? '정상(1.0)' : `근시 -${myopia.toFixed(2)}D · 맨눈 약 ${approxDecimalAcuity(myopia).toFixed(2)}`}
            </span>
          </h3>
          <input type="range" min={0} max={6} step={0.25} value={myopia} onChange={(e) => setMyopia(+e.target.value)} />
          <div className="seg small">
            {[1, 1.5, 3].map((d) => (
              <button key={d} className={viewDist === d ? 'on' : ''} onClick={() => setViewDist(d)}>
                {d}m에서
              </button>
            ))}
          </div>
          <div className="seg small">
            {(Object.keys(LIGHTING_LABEL) as Lighting[]).map((l) => (
              <button key={l} className={lighting === l ? 'on' : ''} onClick={() => setLighting(l)}>
                {LIGHTING_LABEL[l]}
              </button>
            ))}
          </div>
          <p className="hint">안경을 벗은 근시인 사람 기준의 근사치예요.</p>
        </section>
      )}

      {QA_ENABLED && onSetReference && (
        <QaCompareCard capture={capture} reference={reference ?? null} basicPts={basic?.pts ?? null} aiUrl={ai.s === 'done' ? ai.url : null} onSetReference={onSetReference} />
      )}

      <div className="actions">
        <button className="secondary" onClick={onRetake}>
          다시 찍기
        </button>
        <button className="shutter" onClick={save}>
          사진 저장
        </button>
      </div>
    </div>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function cropRect(c: Capture) {
  const W = c.canvas.width;
  const H = c.canvas.height;
  const L = c.lms[IDX.leftCheek];
  const R = c.lms[IDX.rightCheek];
  const T = c.lms[IDX.forehead];
  const B = c.lms[IDX.chin];
  const faceW = Math.abs(L.X - R.X);
  const cx = (L.X + R.X) / 2;
  const cy = (T.Y + B.Y) / 2 - 0.05 * (B.Y - T.Y);
  let w = Math.min(W, faceW * 2.4);
  let h = w * (4 / 3);
  if (h > H) {
    h = H;
    w = h * 0.75;
  }
  const x = clamp(cx - w / 2, 0, W - w);
  const y = clamp(cy - h / 2, 0, H - h);
  return { x, y, w, h, faceW };
}

function cropTo(src: HTMLCanvasElement, r: ReturnType<typeof cropRect>): Rendered {
  const maxW = 1080;
  const s = Math.min(1, maxW / r.w);
  const out = document.createElement('canvas');
  out.width = Math.round(r.w * s);
  out.height = Math.round(r.h * s);
  out.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  return { url: out.toDataURL('image/jpeg', 0.9), faceFrac: r.faceW / r.w };
}

async function detectInUrl(url: string): Promise<PxLandmark[] | null> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const lm = await getLandmarker('IMAGE');
  const res = lm.detect(c);
  return res.faceLandmarks[0] ? toPx(res.faceLandmarks[0], c.width, c.height) : null;
}

// ---------------- 검증 모드: 보정 결과 vs 실제 1.5m 사진 ----------------

function QaCompareCard(props: {
  capture: Capture;
  reference: Capture | null;
  basicPts: { X: number; Y: number }[] | null;
  aiUrl: string | null;
  onSetReference: (c: Capture | null) => void;
}) {
  const { capture, reference, basicPts, aiUrl, onSetReference } = props;
  const [aiPts, setAiPts] = useState<PxLandmark[] | null | 'none'>(null);
  const [saved, setSaved] = useState('');
  const isRef = reference === capture;

  useEffect(() => {
    setAiPts(null);
    if (!aiUrl) return;
    detectInUrl(aiUrl)
      .then((p) => setAiPts(p ?? 'none'))
      .catch(() => setAiPts('none'));
  }, [aiUrl]);

  const refUrl = useMemo(() => (reference ? cropTo(reference.canvas, cropRect(reference)).url : null), [reference]);
  const ready = reference && !isRef;
  const base = ready ? compareRatios(reference.lms, capture.lms, capture.lms) : null;
  const basicRows = ready && basicPts ? compareRatios(reference.lms, capture.lms, basicPts) : null;
  const aiRows = ready && aiPts && aiPts !== 'none' ? compareRatios(reference.lms, capture.lms, aiPts) : null;
  const mean = (rows: { corrErr: number }[] | null) => (rows ? rows.reduce((s, r) => s + Math.abs(r.corrErr), 0) / rows.length : NaN);
  const fmt = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '–');

  const record = (rating: number) => {
    if (!reference || !base) return;
    const values: Record<string, number | string | boolean> = {
      refDistCm: Math.round(reference.distM * 100),
      shotDistCm: Math.round(capture.distM * 100),
      pitchDeg: Math.round(estimatePose(capture.lms).pitchDeg),
      origMeanErr: +mean(base.map((r) => ({ corrErr: r.origErr }))).toFixed(2),
      basicMeanErr: +mean(basicRows).toFixed(2),
      aiMeanErr: +mean(aiRows).toFixed(2),
      aiFaceFound: aiPts !== 'none',
      rating,
    };
    for (const r of base) values[`${r.key}_origErr`] = +r.origErr.toFixed(2);
    for (const r of basicRows ?? []) values[`${r.key}_basicErr`] = +r.corrErr.toFixed(2);
    for (const r of aiRows ?? []) values[`${r.key}_aiErr`] = +r.corrErr.toFixed(2);
    addEntry({ kind: 'warp', label: `${values.shotDistCm}cm ${values.pitchDeg}°`, values });
    setSaved(`기록했어요 (체감 ${rating}점)`);
  };

  return (
    <section className="card qa">
      <h3>검증 · 보정 정확도</h3>
      <div className="row">
        <button className="secondary sm" onClick={() => onSetReference(isRef ? null : capture)}>
          {isRef ? '기준 사진 해제' : '이 사진을 기준 사진으로 지정'}
        </button>
        <span className="hint">{reference ? `기준: ${Math.round(reference.distM * 100)}cm` : '1.5m 눈높이에서 찍어 지정'}</span>
      </div>

      {ready && (
        <>
          <div className="qa-compare">
            <figure>
              {refUrl && <img src={refUrl} alt="기준 사진" />}
              <figcaption>실제 {Math.round(reference.distM * 100)}cm</figcaption>
            </figure>
            <figure>
              {aiUrl && <img src={aiUrl} alt="AI 보정" />}
              <figcaption>{aiUrl ? (aiPts === 'none' ? 'AI (얼굴 인식 실패)' : 'AI 보정') : 'AI 결과 없음'}</figcaption>
            </figure>
          </div>
          <table className="qa-table">
            <thead>
              <tr>
                <th>기준 대비 오차</th>
                <th>보정 전</th>
                <th>기본</th>
                <th>AI</th>
              </tr>
            </thead>
            <tbody>
              {base!.map((r, i) => (
                <tr key={r.key}>
                  <td>{RATIO_LABEL[r.key]}</td>
                  <td>{fmt(r.origErr)}</td>
                  <td>{basicRows ? fmt(basicRows[i].corrErr) : '–'}</td>
                  <td className={aiRows ? (Math.abs(aiRows[i].corrErr) < Math.abs(r.origErr) ? 'good' : 'bad') : ''}>{aiRows ? fmt(aiRows[i].corrErr) : '–'}</td>
                </tr>
              ))}
              <tr>
                <td>평균 |오차|</td>
                <td>{fmt(mean(base!.map((r) => ({ corrErr: r.origErr }))))}</td>
                <td>{fmt(mean(basicRows))}</td>
                <td>{fmt(mean(aiRows))}</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">AI 보정이 기준 사진과 얼마나 같은 사람처럼 보여요?</p>
          <div className="seg small">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => record(n)}>
                {n}
              </button>
            ))}
          </div>
          {saved && <p className="hint">{saved}</p>}
        </>
      )}
    </section>
  );
}
