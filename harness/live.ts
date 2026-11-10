// 실시간 보정 렌더러 시각 확인용: 합성 얼굴(가까이서 찍은 것처럼 투영) → 보정 전/후
import { LiveRenderer } from '../src/lib/liveRenderer';
import { buildCorrectionMesh, CORRECTION } from '../src/lib/cameraDistortion';
import { IDX, type PxLandmark } from '../src/lib/geometry';

const W = 720, H = 960, f = 780; // 세로 화면, 긴 변 화각 약 63°
function scene(d: number, offX: number) {
  const proj = (x: number, y: number, z: number) => { const s = f / (d + z); return { X: W/2 + (x + offX)*s, Y: H/2 + y*s, Z: z * (f/d) }; };
  const surf = (u: number, v: number) => { const r = Math.max(0, 1-u*u-v*v); const nose = -0.03*Math.exp(-((u)**2+(v-0.15)**2)/0.01); return [0.07*u, 0.1*v+0.02, 0.06 - 0.09*Math.sqrt(r) + nose] as const; };
  const lms: PxLandmark[] = [];
  for (let i = 0; i < 478; i++) { const a = i*2.39996, rr = Math.sqrt(i/478)*0.97; const [x,y,z] = surf(rr*Math.cos(a), rr*Math.sin(a)); lms.push(proj(x,y,z)); }
  const set = (i: number, x: number, y: number, z: number) => { lms[i] = proj(x,y,z); };
  set(IDX.rightIrisCenter,-0.0315,0,-0.025); set(IDX.leftIrisCenter,0.0315,0,-0.025); set(IDX.noseTip,0,0.035,-0.06);
  set(IDX.forehead,0,-0.08,-0.025); set(IDX.chin,0,0.12,-0.02); set(IDX.rightCheek,-0.07,0.02,0.04); set(IDX.leftCheek,0.07,0.02,0.04);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d')!;
  g.fillStyle = '#cfd8e3'; g.fillRect(0,0,W,H); g.strokeStyle = '#8796a8'; g.lineWidth = 2;
  for (let x=0;x<W;x+=40){g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();} for (let y=0;y<H;y+=40){g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke();}
  g.fillStyle = '#f1c9a5'; g.beginPath(); for (let t=0;t<=64;t++){const a=t/64*Math.PI*2; const [x,y,z]=surf(Math.cos(a),Math.sin(a)); const p=proj(x,y,z); t?g.lineTo(p.X,p.Y):g.moveTo(p.X,p.Y);} g.fill();
  g.strokeStyle = '#7a4b2a'; g.lineWidth = 3;
  for (let k=-4;k<=4;k++){ for (const vert of [true,false]) { g.beginPath(); for(let t=0;t<=40;t++){const a=k/5, b=-1+2*t/40; const u=vert?a:b, v=vert?b:a; if(u*u+v*v>1) continue; const [x,y,z]=surf(u,v); const p=proj(x,y,z); g.lineTo(p.X,p.Y);} g.stroke(); } }
  g.fillStyle='#222'; for (const i of [IDX.rightIrisCenter, IDX.leftIrisCenter]) { g.beginPath(); g.arc(lms[i].X, lms[i].Y, 9, 0, 7); g.fill(); }
  g.fillStyle='#c0392b'; g.beginPath(); g.arc(lms[IDX.noseTip].X, lms[IDX.noseTip].Y, 14, 0, 7); g.fill();
  return { c, lms };
}
const out = document.getElementById('out')!;
for (const [d, off, label] of [[0.3, 0, '30cm 중앙'], [0.3, 0.17, '30cm 가장자리']] as const) {
  const { c, lms } = scene(d, off);
  const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '6px';
  for (const corr of [false, true]) {
    const cv = document.createElement('canvas'); cv.style.width = '190px';
    const r = new LiveRenderer(cv);
    const mesh = corr ? buildCorrectionMesh(lms, W, H, f, d, { perspective: true, wideAngle: true, targetM: CORRECTION.targetM }) : null;
    r.draw(c, W, H, mesh, false);
    const wrap = document.createElement('div'); wrap.append(cv, document.createElement('br'), `${label} · ${corr ? '보정' : '원본'}`);
    row.append(wrap);
  }
  out.append(row);
}
(window as any).done = true;
