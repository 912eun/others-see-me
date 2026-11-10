// 실시간 미리보기 렌더러: 매 프레임 카메라 영상을 텍스처로 올리고 워프 메시로 그린다.
// 메시가 없으면(얼굴 없음·보정 끔) 화면 전체 사각형 = 원본 그대로.

const VS = `
attribute vec2 aDst;
attribute vec2 aSrc;
uniform vec2 uSize;
uniform float uMirror;
varying vec2 vUv;
void main() {
  vUv = aSrc / uSize;
  vec2 clip = (aDst / uSize) * 2.0 - 1.0;
  gl_Position = vec4(clip.x * uMirror, -clip.y, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

export interface MeshData {
  src: Float32Array; // [x,y]*n, 영상 px
  dst: Float32Array;
  triangles: Uint32Array;
}

export class LiveRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private bufDst: WebGLBuffer;
  private bufSrc: WebGLBuffer;
  private tex: WebGLTexture;
  private locSize: WebGLUniformLocation;
  private locMirror: WebGLUniformLocation;
  private dstArr = new Float32Array(0);
  private srcArr = new Float32Array(0);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // preserveDrawingBuffer: 보이는 화면 그대로 저장할 수 있게
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL을 쓸 수 없어요');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    gl.useProgram(this.prog);
    this.bufDst = gl.createBuffer()!;
    this.bufSrc = gl.createBuffer()!;
    this.locSize = gl.getUniformLocation(this.prog, 'uSize')!;
    this.locMirror = gl.getUniformLocation(this.prog, 'uMirror')!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** 삼각형을 풀어서(인덱스 없이) 버퍼에 올림 — Uint32 인덱스 확장 없이 동작 */
  private upload(mesh: MeshData | null, w: number, h: number): number {
    const gl = this.gl;
    let n: number;
    if (!mesh) {
      const q = [0, 0, w, 0, 0, h, w, 0, w, h, 0, h];
      n = 6;
      if (this.dstArr.length < 12) {
        this.dstArr = new Float32Array(12);
        this.srcArr = new Float32Array(12);
      }
      this.dstArr.set(q);
      this.srcArr.set(q);
    } else {
      n = mesh.triangles.length;
      if (this.dstArr.length < n * 2) {
        this.dstArr = new Float32Array(n * 2);
        this.srcArr = new Float32Array(n * 2);
      }
      for (let k = 0; k < n; k++) {
        const v = mesh.triangles[k];
        this.dstArr[2 * k] = mesh.dst[2 * v];
        this.dstArr[2 * k + 1] = mesh.dst[2 * v + 1];
        this.srcArr[2 * k] = mesh.src[2 * v];
        this.srcArr[2 * k + 1] = mesh.src[2 * v + 1];
      }
    }
    const bind = (buf: WebGLBuffer, data: Float32Array, name: string) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 2), gl.DYNAMIC_DRAW);
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };
    bind(this.bufDst, this.dstArr, 'aDst');
    bind(this.bufSrc, this.srcArr, 'aSrc');
    return n;
  }

  draw(source: TexImageSource, w: number, h: number, mesh: MeshData | null, mirror: boolean) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const n = this.upload(mesh, w, h);
    gl.uniform2f(this.locSize, w, h);
    gl.uniform1f(this.locMirror, mirror ? -1 : 1);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, n);
  }
}
