import { createRoot } from 'react-dom/client';
import '../src/index.css';
import ResultScreen from '../src/components/ResultScreen';
import { IDX, type PxLandmark } from '../src/lib/geometry';
import { useRef, useState } from 'react';
import QaCameraPanel from '../src/qa/QaCameraPanel';
import type { LiveMetrics } from '../src/qa/qa';

const W = 1080, H = 1440, f = 1100, d = 0.3;
const proj = (x: number, y: number, z: number) => { const s = f / (d + z); return { X: W/2 + x*s, Y: H/2 + y*s, Z: z * (f/d) }; };
// 반타원체 얼굴 표면 (폭 14cm, 높이 20cm, 깊이 9cm)
const surf = (u: number, v: number) => { const x = 0.07*u, y = 0.1*v; const r = Math.max(0, 1-u*u-v*v); const nose = -0.03*Math.exp(-((u)**2+(v-0.15)**2)/0.01); return [x, y+0.02, 0.06 - 0.09*Math.sqrt(r) + nose] as const; };
const lms: PxLandmark[] = [];
for (let i = 0; i < 478; i++) { const a = i*2.39996, rr = Math.sqrt(i/478)*0.97; const [x,y,z] = surf(rr*Math.cos(a), rr*Math.sin(a)); lms.push(proj(x,y,z)); }
const setK = (i: number, x: number, y: number, z: number) => { lms[i] = proj(x,y,z); };
setK(IDX.rightIrisCenter, -0.0315, 0, -0.025); setK(IDX.leftIrisCenter, 0.0315, 0, -0.025);
setK(IDX.rightEyeOuter, -0.045, 0, -0.02); setK(IDX.leftEyeOuter, 0.045, 0, -0.02);
setK(IDX.noseTip, 0, 0.035, -0.06); setK(IDX.forehead, 0, -0.08, -0.025); setK(IDX.chin, 0, 0.12, -0.02);
setK(IDX.rightCheek, -0.07, 0.02, 0.04); setK(IDX.leftCheek, 0.07, 0.02, 0.04);

const c = document.createElement('canvas'); c.width = W; c.height = H;
const g = c.getContext('2d')!;
g.fillStyle = '#cfd8e3'; g.fillRect(0,0,W,H);
g.strokeStyle = '#9aa7b6'; for (let x=0;x<W;x+=60){g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();} for (let y=0;y<H;y+=60){g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke();}
g.fillStyle = '#f1c9a5'; g.beginPath(); for (let t=0;t<=64;t++){const a=t/64*Math.PI*2; const [x,y,z]=surf(Math.cos(a),Math.sin(a)); const p=proj(x,y,z); t?g.lineTo(p.X,p.Y):g.moveTo(p.X,p.Y);} g.fill();
g.strokeStyle = '#7a4b2a'; g.lineWidth = 3;
for (let k=-4;k<=4;k++){ g.beginPath(); for(let t=0;t<=40;t++){const u=k/5, v=-1+2*t/40; if(u*u+v*v>1) continue; const [x,y,z]=surf(u,v); const p=proj(x,y,z); g.lineTo(p.X,p.Y);} g.stroke();
  g.beginPath(); for(let t=0;t<=40;t++){const v=k/5, u=-1+2*t/40; if(u*u+v*v>1) continue; const [x,y,z]=surf(u,v); const p=proj(x,y,z); g.lineTo(p.X,p.Y);} g.stroke(); }
g.fillStyle='#222'; for (const i of [IDX.rightIrisCenter, IDX.leftIrisCenter]) { g.beginPath(); g.arc(lms[i].X, lms[i].Y, 22, 0, 7); g.fill(); }
g.fillStyle='#c0392b'; g.beginPath(); g.arc(lms[IDX.noseTip].X, lms[IDX.noseTip].Y, 30, 0, 7); g.fill();

// 기준 사진: 같은 얼굴을 1.5m에서 찍었다고 가정
const D2 = 1.5;
const proj2 = (x: number, y: number, z: number) => { const s = f / (D2 + z); return { X: W/2 + x*s*5, Y: H/2 + y*s*5, Z: z * (f/D2) * 5 }; };
const refL: PxLandmark[] = [];
for (let i = 0; i < 478; i++) { const a = i*2.39996, rr = Math.sqrt(i/478)*0.97; const [x,y,z] = surf(rr*Math.cos(a), rr*Math.sin(a)); refL.push(proj2(x,y,z)); }
for (const [i,x,y,z] of [[IDX.rightIrisCenter,-0.0315,0,-0.025],[IDX.leftIrisCenter,0.0315,0,-0.025],[IDX.rightEyeOuter,-0.045,0,-0.02],[IDX.leftEyeOuter,0.045,0,-0.02],[IDX.noseTip,0,0.035,-0.06],[IDX.forehead,0,-0.08,-0.025],[IDX.chin,0,0.12,-0.02],[IDX.rightCheek,-0.07,0.02,0.04],[IDX.leftCheek,0.07,0.02,0.04]] as const) refL[i] = proj2(x,y,z);
const ref = { canvas: c, lms: refL, fPx: f, distM: D2, source: 'live' as const };

function App(){ const [m,setM]=useState(false); const [r,setR]=useState<any>(ref);
  const mref = useRef<LiveMetrics|null>({ t: 1, w: 1080, h: 1440, fPx: 1100, irisPx: 21.4, ipdPx: 115, distRawM: 0.6, distM: 0.6, pose: { pitchDeg: -3, yawDeg: 2, rollDeg: 1 }, issues: [], fps: 28, calibrated: false });
  setInterval(()=>{ if(mref.current) mref.current = { ...mref.current, t: performance.now(), distRawM: 0.6 + Math.random()*0.02 }; }, 30);
  const qa = new URLSearchParams(location.search).has('panel');
  return <main className="app"><header><h1>harness</h1></header>
  {qa ? <QaCameraPanel metricsRef={mref}/> :
  <ResultScreen capture={{canvas:c,lms,fPx:f,distM:d,source:'live'}} mirror={m} onMirrorChange={setM} onRetake={()=>{}} reference={r} onSetReference={setR}/>}</main>; }
createRoot(document.getElementById('root')!).render(<App/>);
