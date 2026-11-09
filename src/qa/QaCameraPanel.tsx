import { useEffect, useState, type RefObject } from 'react';
import { DEFAULT_IPD_M, IRIS_DIAMETER_M, type GuideIssue } from '../lib/geometry';
import { addEntry, deviceSummary, exportLog, loadLog, saveLog, type LiveMetrics, type QaEntry } from './qa';

const POSE_TESTS: { label: string; expect: GuideIssue | null }[] = [
  { label: '눈높이 정면', expect: null },
  { label: '카메라를 턱 아래로', expect: 'cameraLow' },
  { label: '카메라를 머리 위로', expect: 'cameraHigh' },
  { label: '고개를 옆으로 돌림', expect: 'turned' },
  { label: '고개를 갸웃', expect: 'tilted' },
];
const POSE_ISSUES: GuideIssue[] = ['cameraLow', 'cameraHigh', 'turned', 'tilted'];
const DIST_PRESETS = [30, 50, 100, 150, 200];
const SAMPLES = 20;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const sd = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/** 매 프레임 갱신되는 metricsRef에서 n프레임을 모음 */
function sample(ref: RefObject<LiveMetrics | null>, n: number): Promise<LiveMetrics[]> {
  return new Promise((resolve) => {
    const out: LiveMetrics[] = [];
    let lastT = -1;
    const tick = () => {
      const m = ref.current;
      if (m && m.t !== lastT && Number.isFinite(m.distRawM)) {
        lastT = m.t;
        out.push(m);
      }
      if (out.length >= n) resolve(out);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

export default function QaCameraPanel({ metricsRef }: { metricsRef: RefObject<LiveMetrics | null> }) {
  const [m, setM] = useState<LiveMetrics | null>(null);
  const [log, setLog] = useState<QaEntry[]>(loadLog);
  const [cm, setCm] = useState(50);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const id = setInterval(() => setM(metricsRef.current ? { ...metricsRef.current } : null), 200);
    return () => clearInterval(id);
  }, [metricsRef]);

  const recordDistance = async () => {
    setBusy('dist');
    const frames = await sample(metricsRef, SAMPLES);
    const raw = frames.map((f) => f.distRawM);
    const f = frames[frames.length - 1];
    const irisPx = median(frames.map((x) => x.irisPx));
    const ipdPx = median(frames.map((x) => x.ipdPx));
    const truthM = cm / 100;
    const est = median(raw);
    setLog(
      addEntry({
        kind: 'distance',
        label: `${cm}cm`,
        truth: cm,
        values: {
          estCm: +(est * 100).toFixed(1),
          errPct: +(((est - truthM) / truthM) * 100).toFixed(1),
          sdCm: +(sd(raw) * 100).toFixed(2),
          ipdEstCm: +(((f.fPx * DEFAULT_IPD_M) / ipdPx) * 100).toFixed(1),
          irisPx: +irisPx.toFixed(2),
          ipdPx: +ipdPx.toFixed(1),
          // 이 측정으로 역산한 정규화 초점거리 → 기기 화각 추정에 사용
          impliedFNorm: +((truthM * irisPx) / IRIS_DIAMETER_M / Math.max(f.w, f.h)).toFixed(4),
          yawDeg: +f.pose.yawDeg.toFixed(1),
          calibrated: f.calibrated,
          res: `${f.w}x${f.h}`,
          fps: +f.fps.toFixed(1),
        },
      }),
    );
    setBusy('');
  };

  const recordPose = async (t: (typeof POSE_TESTS)[number]) => {
    setBusy(t.label);
    const frames = await sample(metricsRef, 10);
    const f = frames[frames.length - 1];
    const got = POSE_ISSUES.filter((i) => frames.filter((x) => x.issues.includes(i)).length >= 5);
    const pass = t.expect ? got.includes(t.expect) : got.length === 0;
    setLog(
      addEntry({
        kind: 'pose',
        label: t.label,
        values: {
          expect: t.expect ?? 'none',
          got: got.join('|') || 'none',
          pass,
          pitchDeg: +median(frames.map((x) => x.pose.pitchDeg)).toFixed(1),
          yawDeg: +median(frames.map((x) => x.pose.yawDeg)).toFixed(1),
          rollDeg: +median(frames.map((x) => x.pose.rollDeg)).toFixed(1),
          distCm: +(f.distM * 100).toFixed(0),
        },
      }),
    );
    setBusy('');
  };

  const clear = () => {
    if (!confirm('검증 기록을 모두 지울까요?')) return;
    saveLog([]);
    setLog([]);
  };

  const dist = log.filter((e) => e.kind === 'distance');
  const pose = log.filter((e) => e.kind === 'pose');
  const mape = dist.length ? dist.reduce((s, e) => s + Math.abs(Number(e.values.errPct)), 0) / dist.length : NaN;
  const lastPose = (label: string) => [...pose].reverse().find((e) => e.label === label);

  return (
    <section className="qa">
      <h3>검증 모드</h3>

      <div className="qa-live">
        {m ? (
          <>
            <span>거리 {(m.distM * 100).toFixed(0)}cm (raw {(m.distRawM * 100).toFixed(0)})</span>
            <span>홍채 {m.irisPx.toFixed(1)}px · 동공간 {m.ipdPx.toFixed(0)}px</span>
            <span>
              pitch {m.pose.pitchDeg.toFixed(1)}° · yaw {m.pose.yawDeg.toFixed(1)}° · roll {m.pose.rollDeg.toFixed(1)}°
            </span>
            <span>
              {m.w}×{m.h} · {m.fps.toFixed(0)}fps · f {m.fPx.toFixed(0)}px {m.calibrated ? '(보정됨)' : '(기본값)'}
            </span>
          </>
        ) : (
          <span>얼굴 대기 중</span>
        )}
      </div>

      <h4>1. 거리 정확도</h4>
      <p className="hint">
        줄자로 렌즈~눈 거리를 맞추고, 렌즈를 보면서 기록하세요. 거리 보정 <b>전</b>에 5개 거리를 다 찍고, 보정한 뒤 다시 찍으면 비교가 돼요.
      </p>
      <div className="seg small">
        {DIST_PRESETS.map((d) => (
          <button key={d} className={cm === d ? 'on' : ''} onClick={() => setCm(d)}>
            {d}
          </button>
        ))}
      </div>
      <div className="row">
        <label>
          실측 <input type="number" value={cm} min={10} max={400} onChange={(e) => setCm(+e.target.value)} /> cm
        </label>
        <button className="secondary sm" disabled={!!busy || !m} onClick={recordDistance}>
          {busy === 'dist' ? '측정 중…' : '이 거리 기록'}
        </button>
      </div>
      {dist.length > 0 && (
        <table className="qa-table">
          <thead>
            <tr>
              <th>실측</th>
              <th>홍채</th>
              <th>오차</th>
              <th>동공간</th>
              <th>보정</th>
            </tr>
          </thead>
          <tbody>
            {dist.slice(-8).map((e) => (
              <tr key={e.id}>
                <td>{e.truth}</td>
                <td>{e.values.estCm}</td>
                <td className={Math.abs(Number(e.values.errPct)) > 10 ? 'bad' : 'good'}>{e.values.errPct}%</td>
                <td>{e.values.ipdEstCm}</td>
                <td>{e.values.calibrated ? '후' : '전'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {Number.isFinite(mape) && <p className="hint">평균 절대 오차 {mape.toFixed(1)}% (목표 10% 이내)</p>}

      <h4>2. 자세 판정</h4>
      <p className="hint">폰을 세워두고 각 자세를 취한 채 버튼을 누르세요(1초 측정). 기대한 안내가 나오면 통과.</p>
      <div className="qa-pose">
        {POSE_TESTS.map((t) => {
          const r = lastPose(t.label);
          return (
            <button key={t.label} disabled={!!busy || !m} onClick={() => recordPose(t)} className={r ? (r.values.pass ? 'pass' : 'fail') : ''}>
              {busy === t.label ? '측정 중…' : t.label}
              {r && <small>{r.values.pass ? '통과' : `실패 (${r.values.got}, pitch ${r.values.pitchDeg}°)`}</small>}
            </button>
          );
        })}
      </div>

      <h4>3. 원근 보정</h4>
      <p className="hint">
        ① 폰을 세워두고 1.5m에서 찍은 뒤 결과 화면에서 "기준 사진으로 지정" ② 같은 조명에서 팔 길이 셀카를 찍으면 보정 결과와 기준 사진의 얼굴 비율을 비교해요.
      </p>

      <div className="row qa-actions">
        <span className="hint">기록 {log.length}건</span>
        <button className="secondary sm" disabled={!log.length} onClick={async () => setMsg(await exportLog(log))}>
          CSV 내보내기
        </button>
        <button className="link danger" disabled={!log.length} onClick={clear}>
          초기화
        </button>
      </div>
      {msg && <p className="hint">{msg}</p>}
      <details>
        <summary className="hint">기기 정보</summary>
        <pre className="qa-pre">{JSON.stringify(deviceSummary(), null, 1)}</pre>
      </details>
    </section>
  );
}
