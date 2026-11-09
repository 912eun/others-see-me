// 셀카 원근 왜곡 보정: 가까이서 찍은 사진을 먼 거리(망원)에서 본 것처럼 재투영
//
// 핀홀 카메라, 기준면(눈 평면)까지 거리 d, 어떤 점의 기준면 대비 깊이 z (가까우면 음수).
//   원래 이미지:  x  = f·X/(d+z)
//   가상 카메라:  거리 D, 기준면 크기를 맞추려 초점 f' = f·D/d
//                x' = f'·X/(D+z)
//   ⇒ x'/x = D(d+z) / (d(D+z))      (D→∞ 이면 (d+z)/d)
// 코처럼 가까운 점(z<0)은 줄어들고, 얼굴 외곽·귀(z>0)는 커짐.

import Delaunator from 'delaunator';
import { IDX, type PxLandmark, faceBox } from './geometry';

export interface WarpInput {
  lms: PxLandmark[];
  w: number;
  h: number;
  fPx: number;
  /** 촬영 거리 (m) */
  dM: number;
  /** 목표 시점 거리 (m). Infinity 허용 */
  targetM: number;
}

export interface WarpMesh {
  src: Float32Array; // [x,y]*n (px)
  dst: Float32Array;
  triangles: Uint32Array;
}

export function scaleRatio(dM: number, zM: number, targetM: number): number {
  const z = Math.max(zM, -0.6 * dM); // 수치 안정성
  if (!Number.isFinite(targetM)) return (dM + z) / dM;
  return (targetM * (dM + z)) / (dM * (targetM + z));
}

export function buildWarpMesh(i: WarpInput): WarpMesh {
  const { lms, w, h, fPx, dM, targetM } = i;
  const cx = w / 2;
  const cy = h / 2;
  const pxPerM = fPx / dM; // 기준면에서 1m가 몇 px인지
  // 기준면 = 양쪽 홍채 중심의 평균 깊이
  const zRef = (lms[IDX.rightIrisCenter].Z + lms[IDX.leftIrisCenter].Z) / 2;

  const src: number[] = [];
  const dst: number[] = [];
  const push = (sx: number, sy: number, ratio: number) => {
    src.push(sx, sy);
    dst.push(cx + (sx - cx) * ratio, cy + (sy - cy) * ratio);
  };

  let maxZ = -Infinity;
  for (const p of lms) {
    const zM = (p.Z - zRef) / pxPerM;
    if (zM > maxZ) maxZ = zM;
    push(p.X, p.Y, scaleRatio(dM, zM, targetM));
  }

  // 얼굴 밖 머리카락·귀 영역: 얼굴 외곽보다 조금 더 뒤에 있다고 가정한 링
  const b = faceBox(lms);
  const headZ = maxZ + 0.03;
  const ringR = 0.85 * Math.max(b.w, b.h);
  const ringRatio = scaleRatio(dM, headZ, targetM);
  const N = 24;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const sx = b.cx + Math.cos(a) * ringR;
    const sy = b.cy + Math.sin(a) * ringR * 1.15;
    push(sx, sy, ringRatio);
    // 바깥 링: 배경 쪽으로 갈수록 변형을 절반으로 줄여 부드럽게 이어 붙임
    const ox = b.cx + Math.cos(a) * ringR * 1.7;
    const oy = b.cy + Math.sin(a) * ringR * 1.7 * 1.15;
    if (ox > 0 && ox < w && oy > 0 && oy < h) push(ox, oy, (1 + ringRatio) / 2);
  }

  // 이미지 테두리 고정점 (배경은 움직이지 않음)
  const edge = 8;
  for (let k = 0; k <= edge; k++) {
    const t = k / edge;
    for (const [sx, sy] of [
      [t * w, 0],
      [t * w, h],
      [0, t * h],
      [w, t * h],
    ]) {
      src.push(sx, sy);
      dst.push(sx, sy);
    }
  }

  const tri = Delaunator.from(
    Array.from({ length: src.length / 2 }, (_, k) => [src[2 * k], src[2 * k + 1]] as [number, number]),
  ).triangles;

  return { src: new Float32Array(src), dst: new Float32Array(dst), triangles: new Uint32Array(tri) };
}

/** 코 끝 크기 변화율(%) — UI 표시용 */
export function noseScaleChange(i: WarpInput): number {
  const pxPerM = i.fPx / i.dM;
  const zRef = (i.lms[IDX.rightIrisCenter].Z + i.lms[IDX.leftIrisCenter].Z) / 2;
  const zNose = (i.lms[IDX.noseTip].Z - zRef) / pxPerM;
  const zCheek = ((i.lms[IDX.rightCheek].Z + i.lms[IDX.leftCheek].Z) / 2 - zRef) / pxPerM;
  // 셀카 대비 목표 시점에서 '코 : 얼굴폭' 비율 변화
  const r = scaleRatio(i.dM, zNose, i.targetM) / scaleRatio(i.dM, zCheek, i.targetM);
  return (r - 1) * 100;
}

// ---------------- WebGL 렌더러 ----------------

const VS = `
attribute vec2 aDst;
attribute vec2 aSrc;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = aSrc / uSize;
  vec2 clip = (aDst / uSize) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

/** 원본 이미지(canvas)를 메시대로 변형해 새 canvas로 돌려줌 */
export function renderWarp(source: HTMLCanvasElement, mesh: WarpMesh): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const gl = out.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL을 쓸 수 없어요');

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // 인덱스 없이 삼각형을 풀어서 업로드 (Uint32 인덱스 확장 불필요)
  const n = mesh.triangles.length;
  const dst = new Float32Array(n * 2);
  const src = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const v = mesh.triangles[k];
    dst[2 * k] = mesh.dst[2 * v];
    dst[2 * k + 1] = mesh.dst[2 * v + 1];
    src[2 * k] = mesh.src[2 * v];
    src[2 * k + 1] = mesh.src[2 * v + 1];
  }
  const bind = (name: string, data: Float32Array) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  };
  bind('aDst', dst);
  bind('aSrc', src);
  gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), w, h);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, n);
  return out;
}
