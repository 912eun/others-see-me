import { useEffect, useMemo, useRef, useState } from 'react';
import { IDX, faceWidthM } from '../lib/geometry';
import { buildWarpMesh, noseScaleChange, renderWarp } from '../lib/warp';
import {
  LIGHTING_LABEL,
  LUMINANCE,
  approxDecimalAcuity,
  pupilDiameterMm,
  cssBlurSigmaPx,
  type Lighting,
} from '../lib/vision';
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
  naturalW: number;
}

export default function ResultScreen({ capture, mirror, onMirrorChange, onRetake, reference, onSetReference }: Props) {
  const [correct, setCorrect] = useState(capture.distM < 0.9);
  const [shotDist, setShotDist] = useState(round2(clamp(capture.distM, 0.2, 2.5)));
  const [viewDist, setViewDist] = useState(1.5);
  const [myopia, setMyopia] = useState(0);
  const [lighting, setLighting] = useState<Lighting>('indoor');
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [corrected, setCorrected] = useState<Rendered | null>(null);
  const [original, setOriginal] = useState<Rendered | null>(null);
  const [err, setErr] = useState('');
  const [correctedPts, setCorrectedPts] = useState<{ X: number; Y: number }[] | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [displayW, setDisplayW] = useState(0);

  // 크롭 영역은 원본 기준으로 한 번 정해 두고 보정본에도 같은 영역을 써서 비교가 정확하게
  const crop = useMemo(() => cropRect(capture), [capture]);

  useEffect(() => {
    setOriginal(cropTo(capture.canvas, crop));
  }, [capture, crop]);

  useEffect(() => {
    if (!correct) return;
    const t = setTimeout(() => {
      try {
        const mesh = buildWarpMesh({
          lms: capture.lms,
          w: capture.canvas.width,
          h: capture.canvas.height,
          fPx: capture.fPx,
          dM: shotDist,
          targetM: viewDist,
        });
        const warped = renderWarp(capture.canvas, mesh);
        // 보정 후 얼굴 폭은 메시의 dst 좌표에서
        const r = cropTo(warped, crop);
        r.faceFrac = Math.abs(mesh.dst[2 * IDX.leftCheek] - mesh.dst[2 * IDX.rightCheek]) / crop.w;
        setCorrected(r);
        setCorrectedPts(meshDstPoints(mesh.dst));
        setErr('');
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, 120);
    return () => clearTimeout(t);
  }, [capture, crop, correct, shotDist, viewDist]);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDisplayW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [original]);

  const shown = !holdOriginal && correct && corrected ? corrected : original;

  const realFaceW = faceWidthM(capture.lms, capture.fPx, shotDist);
  const sigma =
    shown && displayW > 0 && myopia > 0
      ? cssBlurSigmaPx({
          myopiaD: myopia,
          viewDistM: viewDist,
          pupilMm: pupilDiameterMm(LUMINANCE[lighting]),
          faceWidthM: realFaceW,
          faceWidthDisplayPx: shown.faceFrac * displayW,
        })
      : 0;

  const noseDelta = noseScaleChange({
    lms: capture.lms,
    w: capture.canvas.width,
    h: capture.canvas.height,
    fPx: capture.fPx,
    dM: shotDist,
    targetM: viewDist,
  });

  const save = () => {
    if (!shown) return;
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
    img.src = shown.url;
  };

  return (
    <div className="result">
      <div className="photo-wrap">
        {shown && (
          <img
            ref={imgRef}
            src={shown.url}
            alt="결과 사진"
            className={mirror ? 'mirrored' : ''}
            style={{ filter: sigma > 0.05 ? `blur(${sigma.toFixed(2)}px)` : undefined }}
            onPointerDown={() => setHoldOriginal(true)}
            onPointerUp={() => setHoldOriginal(false)}
            onPointerLeave={() => setHoldOriginal(false)}
            draggable={false}
          />
        )}
        <span className="badge">
          {holdOriginal ? '원본' : mirror ? '거울 속 내 모습' : '남이 보는 내 모습'}
        </span>
      </div>
      {correct && <p className="hint center">사진을 누르고 있으면 보정 전 원본이 보여요</p>}

      <section className="card">
        <div className="seg">
          <button className={!mirror ? 'on' : ''} onClick={() => onMirrorChange(false)}>
            남이 보는 모습
          </button>
          <button className={mirror ? 'on' : ''} onClick={() => onMirrorChange(true)}>
            거울 속 모습
          </button>
        </div>
        <p className="hint">
          남이 보는 모습이 어색한 건 정상이에요. 사람은 많이 본 쪽을 더 좋아해서, 나는 거울 속 내 얼굴을, 친구는 실제 내 얼굴을 더 좋아한대요.
        </p>
      </section>

      <section className="card">
        <h3>상대와의 거리 {viewDist.toFixed(1)}m</h3>
        <input type="range" min={0.5} max={5} step={0.1} value={viewDist} onChange={(e) => setViewDist(+e.target.value)} />
        <div className="seg small">
          {[
            [1, '마주 앉아 대화'],
            [1.5, '기준 거리'],
            [2.7, '조금 떨어져서'],
          ].map(([d, label]) => (
            <button key={d} className={viewDist === d ? 'on' : ''} onClick={() => setViewDist(d as number)}>
              {label as string} {d}m
            </button>
          ))}
        </div>
        <p className="hint">초상 사진의 기준 거리는 1.5m예요. 원근 보정과 시력 시뮬레이션에 함께 쓰여요.</p>
      </section>

      <section className="card">
        <label className="switch big">
          <input type="checkbox" checked={correct} onChange={(e) => setCorrect(e.target.checked)} /> 원근 보정
        </label>
        {correct && (
          <>
            <h4>촬영 거리 {shotDist.toFixed(2)}m</h4>
            <input type="range" min={0.2} max={2.5} step={0.01} value={shotDist} onChange={(e) => setShotDist(+e.target.value)} />
            <p className="hint">
              {capture.source === 'photo' ? '사진 모드에서는 추정이 부정확할 수 있어요. 실제로 찍은 거리에 맞춰주세요. ' : ''}
              이 거리에서 보면 얼굴 폭 대비 코 크기가 {noseDelta >= 0 ? '+' : ''}
              {noseDelta.toFixed(0)}% 달라져요. 30cm 셀카는 코가 약 30% 크게 찍혀요.
            </p>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </section>

      <section className="card">
        <h3>
          보는 사람의 시력{' '}
          <span className="sub">
            {myopia === 0 ? '정상(1.0)' : `근시 -${myopia.toFixed(2)}D · 맨눈 약 ${approxDecimalAcuity(myopia).toFixed(2)}`}
          </span>
        </h3>
        <input type="range" min={0} max={6} step={0.25} value={myopia} onChange={(e) => setMyopia(+e.target.value)} />
        <div className="seg small">
          {(Object.keys(LIGHTING_LABEL) as Lighting[]).map((l) => (
            <button key={l} className={lighting === l ? 'on' : ''} onClick={() => setLighting(l)}>
              {LIGHTING_LABEL[l]}
            </button>
          ))}
        </div>
        <p className="hint">
          안경을 벗은 근시인 사람 기준이에요. 어두울수록 동공이 커져(지금 약 {pupilDiameterMm(LUMINANCE[lighting]).toFixed(1)}mm) 더 흐릿하게 보여요. 시력 숫자는 개인차가 큰 근사치예요.
        </p>
      </section>

      {QA_ENABLED && onSetReference && (
        <QaWarpCard
          capture={capture}
          reference={reference ?? null}
          correctedPts={correct ? correctedPts : null}
          correctedUrl={correct ? corrected?.url ?? null : null}
          shotDist={shotDist}
          viewDist={viewDist}
          onSetReference={onSetReference}
        />
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
const round2 = (v: number) => Math.round(v * 100) / 100;

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
  return { url: out.toDataURL('image/jpeg', 0.92), faceFrac: r.faceW / r.w, naturalW: out.width };
}

// ---------------- 검증 모드: 원근 보정 vs 실제 1.5m 사진 ----------------

function QaWarpCard(props: {
  capture: Capture;
  reference: Capture | null;
  correctedPts: { X: number; Y: number }[] | null;
  correctedUrl: string | null;
  shotDist: number;
  viewDist: number;
  onSetReference: (c: Capture | null) => void;
}) {
  const { capture, reference, correctedPts, correctedUrl, shotDist, viewDist, onSetReference } = props;
  const [saved, setSaved] = useState('');
  const isRef = reference === capture;
  const refUrl = useMemo(() => (reference ? cropTo(reference.canvas, cropRect(reference)).url : null), [reference]);
  const rows = reference && !isRef && correctedPts ? compareRatios(reference.lms, capture.lms, correctedPts) : null;
  const meanAbs = (k: 'origErr' | 'corrErr') => (rows ? rows.reduce((s, r) => s + Math.abs(r[k]), 0) / rows.length : 0);

  const record = (rating: number) => {
    if (!rows || !reference) return;
    const values: Record<string, number | string | boolean> = {
      refDistCm: +(reference.distM * 100).toFixed(0),
      shotDistCm: +(shotDist * 100).toFixed(0),
      estShotDistCm: +(capture.distM * 100).toFixed(0),
      targetCm: +(viewDist * 100).toFixed(0),
      origMeanErr: +meanAbs('origErr').toFixed(2),
      corrMeanErr: +meanAbs('corrErr').toFixed(2),
      rating,
    };
    for (const r of rows) {
      values[`${r.key}_origErr`] = +r.origErr.toFixed(2);
      values[`${r.key}_corrErr`] = +r.corrErr.toFixed(2);
    }
    addEntry({ kind: 'warp', label: `${values.shotDistCm}cm→${values.targetCm}cm`, values });
    setSaved(`기록했어요 (체감 ${rating}점)`);
  };

  return (
    <section className="card qa">
      <h3>검증 · 원근 보정</h3>
      <div className="row">
        <button className="secondary sm" onClick={() => onSetReference(isRef ? null : capture)}>
          {isRef ? '기준 사진 해제' : '이 사진을 기준 사진으로 지정'}
        </button>
        <span className="hint">
          {reference ? `기준: ${(reference.distM * 100).toFixed(0)}cm에서 촬영` : '기준 사진 없음 (1.5m에서 찍어 지정)'}
        </span>
      </div>

      {reference && !isRef && !correctedPts && <p className="hint">원근 보정을 켜면 기준 사진과 비교해요.</p>}

      {rows && (
        <>
          <div className="qa-compare">
            <figure>
              {refUrl && <img src={refUrl} alt="기준 사진" />}
              <figcaption>실제 {(reference!.distM * 100).toFixed(0)}cm</figcaption>
            </figure>
            <figure>
              {correctedUrl && <img src={correctedUrl} alt="보정 결과" />}
              <figcaption>보정 결과</figcaption>
            </figure>
          </div>
          <p className="hint">기준과 목표 거리를 맞추세요(상대와의 거리 = 기준 사진 거리). 지금 목표 {Math.round(viewDist * 100)}cm.</p>
          <table className="qa-table">
            <thead>
              <tr>
                <th>얼굴 폭 대비</th>
                <th>보정 전 오차</th>
                <th>보정 후 오차</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{RATIO_LABEL[r.key]}</td>
                  <td>{r.origErr.toFixed(1)}%</td>
                  <td className={Math.abs(r.corrErr) < Math.abs(r.origErr) ? 'good' : 'bad'}>{r.corrErr.toFixed(1)}%</td>
                </tr>
              ))}
              <tr>
                <td>평균 |오차|</td>
                <td>{meanAbs('origErr').toFixed(1)}%</td>
                <td className={meanAbs('corrErr') < meanAbs('origErr') ? 'good' : 'bad'}>{meanAbs('corrErr').toFixed(1)}%</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">기준 사진과 얼마나 같은 사람처럼 보여요? (체감 점수와 함께 기록)</p>
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
