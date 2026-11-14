// 필름 색감 렌더러 (WebGL1)
// 1단계: 원본을 1/8 크기로 줄여 흐린 이미지를 만든다 (뿌연 확산광·할레이션 재료)
// 2단계: 원본 + 흐린 이미지로 최종 색을 만든다

export const PRESETS = [
  {
    id: 'natsu', label: '여름', desc: '따뜻하고 뿌연 낮',
    exposure: 0.6,                 // EV, 일본 필름 감성의 핵심인 살짝 과노출
    lift: [0.075, 0.072, 0.062],   // 검은 부분을 이 색까지 띄움
    white: 0.965,                  // 가장 밝은 부분 상한
    haze: 0.16,                    // 흐린 이미지를 섞는 양 (뿌연 느낌)
    halation: 0.45,                // 밝은 부분 주변 붉은 번짐
    grain: 0.045,
    saturation: 0.92,
    wb: [1.08, 0.99, 0.9],         // 따뜻한 색온도
    shadowTint: [-0.012, 0.022, 0.014], // 그림자는 살짝 초록·청록 (후지 계열)
    highTint: [0.035, 0.018, -0.025],   // 밝은 부분은 크림색
    vignette: 0.18,
  },
  {
    id: 'kumori', label: '흐림', desc: '차분하고 초록빛 도는',
    exposure: 0.5,
    lift: [0.1, 0.106, 0.1],
    white: 0.94,
    haze: 0.22,
    halation: 0.22,
    grain: 0.055,
    saturation: 0.74,
    wb: [1.0, 1.02, 0.96],
    shadowTint: [-0.02, 0.03, 0.026],
    highTint: [0.02, 0.02, 0.0],
    vignette: 0.12,
  },
  {
    id: 'yuugure', label: '노을', desc: '진한 주황빛',
    exposure: 0.35,
    lift: [0.08, 0.062, 0.052],
    white: 0.97,
    haze: 0.14,
    halation: 0.6,
    grain: 0.05,
    saturation: 0.95,
    wb: [1.13, 0.99, 0.8],
    shadowTint: [0.0, 0.012, 0.02],
    highTint: [0.05, 0.02, -0.04],
    vignette: 0.22,
  },
  {
    // 밤거리·아케이드: 초록빛 짙은 검정, 주황으로 번지는 불빛, 굵은 그레인
    id: 'yoru', label: '밤거리', desc: '초록빛 밤, 번지는 불빛',
    exposure: 0.25,
    lift: [0.02, 0.045, 0.035],
    white: 0.97,
    haze: 0.08,
    halation: 1.0,
    grain: 0.075,
    saturation: 0.92,
    wb: [1.06, 1.0, 0.86],
    shadowTint: [-0.01, 0.035, 0.02],
    highTint: [0.05, 0.02, -0.04],
    vignette: 0.3,
    soft: 0.35,                    // 렌즈가 살짝 흐릿한 느낌
    contrast: 0.35,                // 0이면 그대로, 클수록 대비 강하게
  },
  {
    // 밤 인물: 차갑고 푸르스름하고 채도 낮은 뿌연 느낌
    id: 'ao', label: '푸른밤', desc: '차갑고 뿌연 밤',
    exposure: 0.55,
    lift: [0.07, 0.09, 0.1],
    white: 0.95,
    haze: 0.2,
    halation: 0.25,
    grain: 0.06,
    saturation: 0.7,
    wb: [0.94, 1.0, 1.06],
    shadowTint: [-0.02, 0.02, 0.035],
    highTint: [0.0, 0.015, 0.02],
    vignette: 0.15,
    soft: 0.4,
  },
  {
    // 일회용 카메라 플래시: 가운데는 밝게 터지고 배경은 어둡게 떨어짐
    id: 'flash', label: '플래시', desc: '가운데가 터지는 일회용 플래시',
    exposure: 0.3,
    lift: [0.03, 0.04, 0.035],
    white: 0.97,
    haze: 0.1,
    halation: 0.4,
    grain: 0.07,
    saturation: 0.9,
    wb: [1.06, 1.0, 0.9],
    shadowTint: [-0.01, 0.03, 0.02],
    highTint: [0.04, 0.02, -0.02],
    vignette: 0.35,
    soft: 0.3,
    contrast: 0.25,
    flash: 0.85,                   // 플래시 세기 (가운데 밝게, 가장자리 어둡게)
  },
];

const VERT = `
attribute vec2 aPos;
uniform float uFlipY;
uniform float uMirror;
uniform vec2 uCropOffset;
uniform vec2 uCropScale;
varying vec2 vUv;   // 원본에서 읽을 위치
varying vec2 vOut;  // 결과 사진 안에서의 위치 (0~1, 왼쪽 위가 0)
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
  vOut = uv;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vUv = uCropOffset + uv * uCropScale;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 16탭으로 블록 평균을 내서 줄인다. 선형 공간에서 평균 내야 밝은 부분 번짐이 자연스럽다.
const DOWN_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
void main() {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * uStep;
      c += pow(texture2D(uSrc, vUv + o).rgb, vec3(2.2));
    }
  }
  gl_FragColor = vec4(pow(c / 16.0, vec3(1.0 / 2.2)), 1.0);
}`;

const MAIN_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vOut;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform vec2 uBlurTexel;
uniform float uBypass;
uniform float uSeed;
uniform float uExposure;
uniform vec3 uLift;
uniform float uWhite;
uniform float uHaze;
uniform float uHalation;
uniform float uGrain;
uniform float uSat;
uniform vec3 uWb;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uVignette;
uniform vec2 uSrcTexel;
uniform float uAspect;
uniform float uSoft;
uniform float uContrast;
uniform float uFlash;
uniform float uStrength; // 필름 효과 강도 0~1
uniform float uUserEV;   // 사용자가 조절한 밝기 (EV)

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 blurAt(vec2 uv) {
  vec3 b = texture2D(uBlur, uv).rgb * 0.2;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a)) * uBlurTexel;
    b += texture2D(uBlur, uv + d * 1.5).rgb * 0.06;
    b += texture2D(uBlur, uv + d * 3.5).rgb * 0.04;
  }
  return b;
}

// 밝은 부분이 하얗게 날아가지 않고 부드럽게 넘어가는 필름 곡선 (ACES 근사)
vec3 filmCurve(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  float ev = exp2(uUserEV);
  vec3 src = texture2D(uSrc, vUv).rgb;
  vec3 plain = toSrgb(toLin(src) * ev); // 밝기만 반영한 원본
  if (uBypass > 0.5) { gl_FragColor = vec4(plain, 1.0); return; }

  vec3 lin = toLin(src);
  vec3 blur = toLin(blurAt(vUv)) * ev;

  // 렌즈 흐림: 바로 옆 픽셀들과 섞어 선명도를 살짝 죽인다
  if (uSoft > 0.0) {
    vec2 t = uSrcTexel * 1.5;
    vec3 s = toLin(texture2D(uSrc, vUv + vec2(t.x, t.y)).rgb)
           + toLin(texture2D(uSrc, vUv + vec2(-t.x, t.y)).rgb)
           + toLin(texture2D(uSrc, vUv + vec2(t.x, -t.y)).rgb)
           + toLin(texture2D(uSrc, vUv + vec2(-t.x, -t.y)).rgb);
    lin = mix(lin, s * 0.25, uSoft);
  }
  lin *= ev;

  // 뿌연 확산광
  lin = mix(lin, blur, uHaze);

  // 할레이션: 밝은 곳 주변이 붉게 번짐
  float bl = dot(blur, vec3(0.2126, 0.7152, 0.0722));
  lin += smoothstep(0.35, 1.0, bl) * vec3(1.0, 0.38, 0.14) * uHalation * 0.6;

  // 플래시: 화면 가운데(살짝 위, 얼굴 위치)는 밝게 터지고 가장자리는 어둡게 떨어진다
  if (uFlash > 0.0) {
    vec2 fp = (vOut - vec2(0.5, 0.42)) * vec2(uAspect, 1.0);
    float fd = length(fp) / length(vec2(uAspect, 1.0) * 0.5);
    float fl = 1.0 - smoothstep(0.0, 0.9, fd);
    lin *= mix(1.0, 0.3 + 2.0 * fl * fl, uFlash);
  }

  lin *= exp2(uExposure) * uWb;
  // 0.75: 필름 곡선이 중간 톤을 끌어올리는 만큼 미리 낮춰 둔다 (노출 0일 때 원본과 비슷한 밝기)
  vec3 c = toSrgb(filmCurve(lin * 0.75));

  // 채도
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);

  // 그림자/밝은 부분 색조
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l));
  c += uHighTint * smoothstep(0.45, 1.0, l);

  // 대비 (S자 곡선)
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);

  // 검은 부분 띄우기 + 흰색 상한 → 탁하고 부드러운 대비
  c = uLift + (uWhite - uLift) * clamp(c, 0.0, 1.0);

  // 비네팅
  vec2 v = vOut - 0.5;
  c *= 1.0 - uVignette * pow(clamp(length(v) * 1.35, 0.0, 1.0), 2.5);

  // 그레인: 중간 톤에서 가장 잘 보이게
  float n = hash(gl_FragCoord.xy + uSeed * 97.0) - 0.5;
  c += n * uGrain * (1.0 - abs(l - 0.5) * 1.2);

  // 강도: 밝기만 반영한 원본과 필름 결과를 섞는다
  gl_FragColor = vec4(clamp(mix(plain, c, uStrength), 0.0, 1.0), 1.0);
}`;

const DOWNSCALE = 8;

// 원본에서 가운데를 ratio 비율로 잘라낼 크기(원본 대비 비율). 가로로 든 원본이면 비율도 가로로 뒤집는다.
function cropFor(w, h, ratio) {
  if (!ratio) return { sx: 1, sy: 1 };
  const target = w > h ? 1 / ratio : ratio;
  const src = w / h;
  return src > target ? { sx: target / src, sy: 1 } : { sx: 1, sy: src / target };
}

export class FilmRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', {
      preserveDrawingBuffer: true, // 촬영 시 toBlob으로 그대로 읽기 위해
      antialias: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('이 브라우저는 WebGL을 지원하지 않아요');
    this.gl = gl;
    this.canvas = canvas;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.down = this.#program(DOWN_FRAG);
    this.main = this.#program(MAIN_FRAG);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.srcTex = this.#texture();
    this.blurTex = this.#texture();
    this.fbo = gl.createFramebuffer();
    this.w = 0;
    this.h = 0;
  }

  #texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  #program(fragSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));

    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      loc[name] = gl.getUniformLocation(p, name);
    }
    return { p, loc };
  }

  #resize(w, h) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    this.bw = Math.max(1, Math.ceil(w / DOWNSCALE));
    this.bh = Math.max(1, Math.ceil(h / DOWNSCALE));
    gl.bindTexture(gl.TEXTURE_2D, this.blurTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.bw, this.bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.blurTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // source: video 또는 canvas/image. w,h는 원본 픽셀 크기
  upload(source, w, h) {
    const gl = this.gl;
    this.#resize(w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
  }

  // ratio: 세로 기준 가로/세로 비율 (3/4, 1, 9/16 …). null이면 원본 비율 그대로
  // zoom: 디지털 줌 배율 (가운데를 더 잘라 확대, 결과 사진 크기는 그대로)
  // strength: 필름 강도 0~1, ev: 밝기(EV), maxSide: 미리보기용으로 결과 크기를 이 이하로 줄임 (0이면 원본 크기)
  render(preset, { mirror = false, bypass = false, seed = Math.random(), ratio = null, zoom = 1, strength = 1, ev = 0, maxSide = 0 } = {}) {
    const gl = this.gl;
    if (!this.w) return;
    const crop = cropFor(this.w, this.h, ratio);
    let ow = Math.round(this.w * crop.sx);
    let oh = Math.round(this.h * crop.sy);
    if (maxSide && Math.max(ow, oh) > maxSide) {
      const k = maxSide / Math.max(ow, oh);
      ow = Math.round(ow * k);
      oh = Math.round(oh * k);
    }
    if (this.canvas.width !== ow) this.canvas.width = ow;
    if (this.canvas.height !== oh) this.canvas.height = oh;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 1단계: 축소 + 흐림
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.bw, this.bh);
    gl.useProgram(this.down.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.down.loc.uSrc, 0);
    gl.uniform1f(this.down.loc.uFlipY, 0);
    gl.uniform1f(this.down.loc.uMirror, 0);
    gl.uniform2f(this.down.loc.uCropOffset, 0, 0);
    gl.uniform2f(this.down.loc.uCropScale, 1, 1);
    gl.uniform2f(this.down.loc.uStep, DOWNSCALE / 4 / this.w, DOWNSCALE / 4 / this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2단계: 최종 색
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ow, oh);
    const { p, loc } = this.main;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTex);
    gl.uniform1i(loc.uSrc, 0);
    gl.uniform1i(loc.uBlur, 1);
    gl.uniform1f(loc.uFlipY, 1);
    gl.uniform1f(loc.uMirror, mirror ? 1 : 0);
    const sx = crop.sx / zoom;
    const sy = crop.sy / zoom;
    gl.uniform2f(loc.uCropOffset, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform2f(loc.uCropScale, sx, sy);
    gl.uniform2f(loc.uBlurTexel, 1 / this.bw, 1 / this.bh);
    gl.uniform1f(loc.uBypass, bypass ? 1 : 0);
    gl.uniform1f(loc.uSeed, seed);
    gl.uniform1f(loc.uExposure, preset.exposure);
    gl.uniform3fv(loc.uLift, preset.lift);
    gl.uniform1f(loc.uWhite, preset.white);
    gl.uniform1f(loc.uHaze, preset.haze);
    gl.uniform1f(loc.uHalation, preset.halation);
    gl.uniform1f(loc.uGrain, preset.grain);
    gl.uniform1f(loc.uSat, preset.saturation);
    gl.uniform3fv(loc.uWb, preset.wb);
    gl.uniform3fv(loc.uShadowTint, preset.shadowTint);
    gl.uniform3fv(loc.uHighTint, preset.highTint);
    gl.uniform1f(loc.uVignette, preset.vignette);
    gl.uniform2f(loc.uSrcTexel, 1 / this.w, 1 / this.h);
    gl.uniform1f(loc.uAspect, ow / oh);
    gl.uniform1f(loc.uSoft, preset.soft ?? 0);
    gl.uniform1f(loc.uContrast, preset.contrast ?? 0);
    gl.uniform1f(loc.uFlash, preset.flash ?? 0);
    gl.uniform1f(loc.uStrength, strength);
    gl.uniform1f(loc.uUserEV, ev);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  toBlob(quality = 0.92) {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', quality));
  }
}
