/* steer-engine.js — shared effects for the steerability landing candidates.
 *
 *  Steer.dither(canvas, options)      Paper Shaders' animated 2-colour dithering (fragment shader © paper.design,
 *                                     Apache-2.0, from @paper-design/shaders 0.0.82) on a small vanilla WebGL2 mount.
 *  Steer.glyphField(canvas, options)  A field of characters in the manner of asciify-engine (MIT): a glyph atlas,
 *                                     tone → glyph with a 4x4 Bayer blend, generated scenes or a painted source,
 *                                     and a fluid cursor wake (semi-Lagrangian advection, as asciify's field does it).
 *                                     Its handle's pulse() drops a radial splat into the wake: a burst outward from
 *                                     a point, or a draw in toward it.
 *  Steer.pulser(field, options)       A key's pulse, built on pulse(): a tap lets out a small one, holding charges
 *                                     a bigger one while the field is drawn in toward the point, and a long hold
 *                                     primes the field to throb there until the release lets out the biggest pulse
 *                                     the wake allows.
 *  Steer.needle(options)              The mark's needle: the seeking motion traced frame by frame from the brand
 *                                     animation, then spring-steered toward the pointer.
 *  Steer.logo(svg, options)           Binds a needle controller to an inline SVG of the mark.
 *  Steer.LOGO                         The mark's two paths (300 x 300 viewBox), pivot and rest angle.
 *
 *  Everything pauses when hidden or off screen and honours prefers-reduced-motion (a still frame, no wake).
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utilities
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const dpr = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  /** CSS colour → [r,g,b,a] in 0..1. Accepts #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba(), or a var(--x) read from :root. */
  function parseColor(str, el) {
    if (Array.isArray(str)) return str.length === 4 ? str : [str[0], str[1], str[2], 1];
    if (typeof str !== 'string') return [0, 0, 0, 1];
    str = str.trim();
    const v = /^var\((--[\w-]+)/.exec(str);
    if (v) str = getComputedStyle(el || document.documentElement).getPropertyValue(v[1]).trim() || '#000';
    if (str[0] === '#') {
      let h = str.slice(1);
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
      if (h.length === 6) h += 'ff';
      const n = parseInt(h, 16);
      return [((n >>> 24) & 255) / 255, ((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255];
    }
    const m = /rgba?\(([^)]+)\)/.exec(str);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }
    // Anything else: let the browser resolve it through a canvas.
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = str;
    return parseColor(c.fillStyle);
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + log);
    }
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    return p;
  }
  function uniforms(gl, p) {
    const out = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      out[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return out;
  }

  /** Runs `onChange(visible)` as the element enters or leaves the viewport and as the tab hides. */
  function watchVisible(el, onChange) {
    let inView = true, hidden = document.hidden;
    const fire = () => onChange(inView && !hidden);
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { inView = es[0].isIntersecting; fire(); }, { rootMargin: '10%' }) : null;
    if (io) io.observe(el);
    const onVis = () => { hidden = document.hidden; fire(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { if (io) io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }

  // ------------------------------------------------------------------ 1. Paper Shaders dithering
  const FULLSCREEN_VS = `#version 300 es
precision mediump float;
layout(location = 0) in vec2 a_position;
void main(){ gl_Position = vec4(a_position, 0., 1.); }`;

  // Verbatim from @paper-design/shaders/src/shaders/dithering.ts (helpers from shader-utils.ts inlined).
  const DITHER_FS = `#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_originX;
uniform float u_originY;
uniform float u_worldWidth;
uniform float u_worldHeight;
uniform float u_fit;
uniform float u_scale;
uniform float u_rotation;
uniform float u_offsetX;
uniform float u_offsetY;

uniform float u_pxSize;
uniform vec4 u_colorBack;
uniform vec4 u_colorFront;
uniform float u_shape;
uniform float u_type;

out vec4 fragColor;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

float hash11(float p) {
  p = fract(p * 0.3183099) + 0.1;
  p *= p + 19.19;
  return fract(p * p);
}
float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float getSimplexNoise(vec2 uv, float t) {
  float noise = .5 * snoise(uv - vec2(0., .3 * t));
  noise += .5 * snoise(2. * uv + vec2(0., .32 * t));
  return noise;
}

const int bayer2x2[4] = int[4](0, 2, 3, 1);
const int bayer4x4[16] = int[16](
0, 8, 2, 10,
12, 4, 14, 6,
3, 11, 1, 9,
15, 7, 13, 5
);
const int bayer8x8[64] = int[64](
0, 32, 8, 40, 2, 34, 10, 42,
48, 16, 56, 24, 50, 18, 58, 26,
12, 44, 4, 36, 14, 46, 6, 38,
60, 28, 52, 20, 62, 30, 54, 22,
3, 35, 11, 43, 1, 33, 9, 41,
51, 19, 59, 27, 49, 17, 57, 25,
15, 47, 7, 39, 13, 45, 5, 37,
63, 31, 55, 23, 61, 29, 53, 21
);

float getBayerValue(vec2 uv, int size) {
  ivec2 pos = ivec2(fract(uv / float(size)) * float(size));
  int index = pos.y * size + pos.x;
  if (size == 2) {
    return float(bayer2x2[index]) / 4.0;
  } else if (size == 4) {
    return float(bayer4x4[index]) / 16.0;
  } else if (size == 8) {
    return float(bayer8x8[index]) / 64.0;
  }
  return 0.0;
}

void main() {
  float t = .5 * u_time;

  float pxSize = u_pxSize * u_pixelRatio;
  vec2 pxSizeUV = gl_FragCoord.xy - .5 * u_resolution;
  pxSizeUV /= pxSize;
  vec2 canvasPixelizedUV = (floor(pxSizeUV) + .5) * pxSize;
  vec2 normalizedUV = canvasPixelizedUV / u_resolution;

  vec2 ditheringNoiseUV = canvasPixelizedUV;
  vec2 shapeUV = normalizedUV;

  vec2 boxOrigin = vec2(.5 - u_originX, u_originY - .5);
  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);
  givenBoxSize = max(givenBoxSize, vec2(1.)) * u_pixelRatio;
  float r = u_rotation * PI / 180.;
  mat2 graphicRotation = mat2(cos(r), sin(r), -sin(r), cos(r));
  vec2 graphicOffset = vec2(-u_offsetX, u_offsetY);

  float patternBoxRatio = givenBoxSize.x / givenBoxSize.y;
  vec2 boxSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );

  if (u_shape > 3.5) {
    vec2 objectBoxSize = vec2(0.);
    objectBoxSize.x = min(boxSize.x, boxSize.y);
    if (u_fit == 1.) {
      objectBoxSize.x = min(u_resolution.x, u_resolution.y);
    } else if (u_fit == 2.) {
      objectBoxSize.x = max(u_resolution.x, u_resolution.y);
    }
    objectBoxSize.y = objectBoxSize.x;
    vec2 objectWorldScale = u_resolution.xy / objectBoxSize;

    shapeUV *= objectWorldScale;
    shapeUV += boxOrigin * (objectWorldScale - 1.);
    shapeUV += vec2(-u_offsetX, u_offsetY);
    shapeUV /= u_scale;
    shapeUV = graphicRotation * shapeUV;
  } else {
    vec2 patternBoxSize = vec2(0.);
    patternBoxSize.x = patternBoxRatio * min(boxSize.x / patternBoxRatio, boxSize.y);
    float patternWorldNoFitBoxWidth = patternBoxSize.x;
    if (u_fit == 1.) {
      patternBoxSize.x = patternBoxRatio * min(u_resolution.x / patternBoxRatio, u_resolution.y);
    } else if (u_fit == 2.) {
      patternBoxSize.x = patternBoxRatio * max(u_resolution.x / patternBoxRatio, u_resolution.y);
    }
    patternBoxSize.y = patternBoxSize.x / patternBoxRatio;
    vec2 patternWorldScale = u_resolution.xy / patternBoxSize;

    shapeUV += vec2(-u_offsetX, u_offsetY) / patternWorldScale;
    shapeUV += boxOrigin;
    shapeUV -= boxOrigin / patternWorldScale;
    shapeUV *= u_resolution.xy;
    shapeUV /= u_pixelRatio;
    if (u_fit > 0.) {
      shapeUV *= (patternWorldNoFitBoxWidth / patternBoxSize.x);
    }
    shapeUV /= u_scale;
    shapeUV = graphicRotation * shapeUV;
    shapeUV += boxOrigin / patternWorldScale;
    shapeUV -= boxOrigin;
    shapeUV += .5;
  }

  float shape = 0.;
  if (u_shape < 1.5) {
    shapeUV *= .001;
    shape = 0.5 + 0.5 * getSimplexNoise(shapeUV, t);
    shape = smoothstep(0.3, 0.9, shape);
  } else if (u_shape < 2.5) {
    shapeUV *= .003;
    for (float i = 1.0; i < 6.0; i++) {
      shapeUV.x += 0.6 / i * cos(i * 2.5 * shapeUV.y + t);
      shapeUV.y += 0.6 / i * cos(i * 1.5 * shapeUV.x + t);
    }
    shape = .15 / max(0.001, abs(sin(t - shapeUV.y - shapeUV.x)));
    shape = smoothstep(0.02, 1., shape);
  } else if (u_shape < 3.5) {
    shapeUV *= .05;
    float stripeIdx = floor(2. * shapeUV.x / TWO_PI);
    float rand = hash11(stripeIdx * 10.);
    rand = sign(rand - .5) * pow(.1 + abs(rand), .4);
    shape = sin(shapeUV.x) * cos(shapeUV.y - 5. * rand * t);
    shape = pow(abs(shape), 6.);
  } else if (u_shape < 4.5) {
    shapeUV *= 4.;
    float wave = cos(.5 * shapeUV.x - 2. * t) * sin(1.5 * shapeUV.x + t) * (.75 + .25 * cos(3. * t));
    shape = 1. - smoothstep(-1., 1., shapeUV.y + wave);
  } else if (u_shape < 5.5) {
    float dist = length(shapeUV);
    float waves = sin(pow(dist, 1.7) * 7. - 3. * t) * .5 + .5;
    shape = waves;
  } else if (u_shape < 6.5) {
    float l = length(shapeUV);
    float angle = 6. * atan(shapeUV.y, shapeUV.x) + 4. * t;
    float twist = 1.2;
    float offset = 1. / pow(max(l, 1e-6), twist) + angle / TWO_PI;
    float mid = smoothstep(0., 1., pow(l, twist));
    shape = mix(0., fract(offset), mid);
  } else {
    shapeUV *= 2.;
    float d = 1. - pow(length(shapeUV), 2.);
    vec3 pos = vec3(shapeUV, sqrt(max(0., d)));
    vec3 lightPos = normalize(vec3(cos(1.5 * t), .8, sin(1.25 * t)));
    shape = .5 + .5 * dot(lightPos, pos);
    shape *= step(0., d);
  }

  int type = int(floor(u_type));
  float dithering = 0.0;
  switch (type) {
    case 1: {
      dithering = step(hash21(ditheringNoiseUV), shape);
    } break;
    case 2:
    dithering = getBayerValue(pxSizeUV, 2);
    break;
    case 3:
    dithering = getBayerValue(pxSizeUV, 4);
    break;
    default :
    dithering = getBayerValue(pxSizeUV, 8);
    break;
  }

  dithering -= .5;
  float res = step(.5, shape + dithering);

  vec3 fgColor = u_colorFront.rgb * u_colorFront.a;
  float fgOpacity = u_colorFront.a;
  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  float bgOpacity = u_colorBack.a;

  vec3 color = fgColor * res;
  float opacity = fgOpacity * res;

  color += bgColor * (1. - opacity);
  opacity += bgOpacity * (1. - opacity);

  fragColor = vec4(color, opacity);
}`;

  const DITHER_SHAPES = { simplex: 1, warp: 2, dots: 3, wave: 4, ripple: 5, swirl: 6, sphere: 7 };
  const DITHER_TYPES = { random: 1, '2x2': 2, '4x4': 3, '8x8': 4 };
  const FIT = { none: 0, contain: 1, cover: 2 };

  /**
   * Mounts the dithering shader on a canvas that fills its CSS box.
   * options: shape, type, size (CSS px per dither cell), colorBack, colorFront, speed, frame (ms offset), scale, fit,
   *          rotation, offsetX, offsetY, originX, originY, worldWidth, worldHeight, maxPixels, pixelRatio, watch (element
   *          whose visibility pauses the loop; default the canvas), onFrame(handle) called after each render.
   */
  function dither(canvas, options = {}) {
    const o = Object.assign({
      shape: 'sphere', type: '4x4', size: 2, colorBack: '#000000', colorFront: '#00b2ff', speed: 1, frame: 0,
      fit: 'none', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, worldWidth: 0, worldHeight: 0,
      maxPixels: 3.6e6, pixelRatio: 0, watch: null, onFrame: null, stillTime: 12,
    }, options);
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: true });
    if (!gl) return null;
    const prog = program(gl, FULLSCREEN_VS, DITHER_FS);
    const u = uniforms(gl, prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);

    let renderScale = 1, time = o.frame, last = 0, raf = 0, visible = true, playing = true, disposed = false;
    const still = reduced();

    const setStatic = () => {
      gl.uniform4fv(u.u_colorBack, parseColor(o.colorBack, canvas));
      gl.uniform4fv(u.u_colorFront, parseColor(o.colorFront, canvas));
      gl.uniform1f(u.u_shape, DITHER_SHAPES[o.shape] || 7);
      gl.uniform1f(u.u_type, DITHER_TYPES[o.type] || 3);
      gl.uniform1f(u.u_pxSize, o.size);
      gl.uniform1f(u.u_fit, FIT[o.fit] || 0);
      gl.uniform1f(u.u_scale, o.scale);
      gl.uniform1f(u.u_rotation, o.rotation);
      gl.uniform1f(u.u_offsetX, o.offsetX);
      gl.uniform1f(u.u_offsetY, o.offsetY);
      gl.uniform1f(u.u_originX, o.originX);
      gl.uniform1f(u.u_originY, o.originY);
      gl.uniform1f(u.u_worldWidth, o.worldWidth);
      gl.uniform1f(u.u_worldHeight, o.worldHeight);
    };

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth)), h = Math.max(1, Math.round(canvas.clientHeight));
      let s = o.pixelRatio || dpr();
      const px = w * s * h * s;
      if (px > o.maxPixels) s *= Math.sqrt(o.maxPixels / px);
      const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W; canvas.height = H;
        renderScale = W / w;
        gl.viewport(0, 0, W, H);
        gl.uniform2f(u.u_resolution, W, H);
        gl.uniform1f(u.u_pixelRatio, renderScale);
        render();
      }
    };

    const render = () => {
      if (disposed) return;
      gl.uniform1f(u.u_time, (still ? o.stillTime * 1000 : time) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (o.onFrame) o.onFrame(handle);
    };

    const loop = (now) => {
      raf = 0;
      if (disposed || !visible || !playing) return;
      const dt = last ? Math.min(100, now - last) : 0;
      last = now;
      time += dt * o.speed;
      render();
      if (!still && o.speed !== 0) raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!raf && !disposed) { last = 0; raf = requestAnimationFrame(loop); } };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const unwatch = watchVisible(o.watch || canvas, (v) => { visible = v; if (v) kick(); });

    const handle = {
      gl, canvas,
      get time() { return time; },
      set time(ms) { time = ms; render(); },
      get renderScale() { return renderScale; },
      set(partial) { Object.assign(o, partial); setStatic(); render(); kick(); },
      play() { playing = true; kick(); },
      pause() { playing = false; },
      render,
      destroy() {
        disposed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); unwatch();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
    setStatic();
    resize();
    kick();
    return handle;
  }

  // ------------------------------------------------------------------ 2. Glyph field (asciify manner)
  const FIELD_VS = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`;

  // Fluid wake, packed into 8-bit channels: velocity in field heights per second, energy in z.
  const FLUID_CODEC = `
const float VSCALE=6.;
vec4 decodeFluid(vec4 t){return vec4((t.xy*2.-1.)*VSCALE,t.z,t.w);}
vec4 encodeFluid(vec4 v){return vec4(clamp(v.xy/VSCALE*.5+.5,0.,1.),clamp(v.z,0.,1.),1.);}`;

  // Two kinds of splat: the pointer's capsule (uFrom → uTo, pushed along uForce) and up to four radial pulses a
  // frame (uPulse: centre in uv, radius in field heights, strength; uPulseExtra: energy, hold, ring). The profile
  // is a Gaussian disc about the centre or, with ring above 0, a Gaussian annulus at that distance. With hold at 0
  // the pulse is an impulse, pushing the field out from the centre (or in, for a negative strength); with hold
  // above 0 it instead eases the field that fraction of the way toward a steady radial flow at `strength`, which is
  // how a draw is held frame after frame without small pushes vanishing in the 8-bit texture. The same decay,
  // advection and speed cap apply to all of it.
  const PULSES = 4;
  const FLUID_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrevious;
uniform vec2 uSize;
uniform float uAspect, uDt, uDecay, uEnergyDecay, uRadius, uSplat;
uniform vec2 uFrom, uTo, uForce;
uniform vec4 uPulse[${PULSES}];
uniform vec3 uPulseExtra[${PULSES}];
uniform int uPulseCount;
out vec4 outColor;
${FLUID_CODEC}
float segment(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-8),0.,1.);return length(pa-ba*h);}
void main(){
  vec2 uv=gl_FragCoord.xy/uSize;
  vec4 here=decodeFluid(texture(uPrevious,uv));
  vec4 state=decodeFluid(texture(uPrevious,uv-uDt*here.xy*vec2(1./uAspect,1.)));
  state.xy*=exp(-uDt*uDecay);
  state.z*=exp(-uDt*uEnergyDecay);
  vec2 scale=vec2(uAspect,1.);
  if(uSplat>.5){
    float d=segment(uv*scale,uFrom*scale,uTo*scale);
    float g=exp(-d*d/(uRadius*uRadius));
    state.xy+=uForce*g;
    state.z=min(1.,state.z+g*min(1.,length(uForce)*.5+.08));
  }
  for(int i=0;i<${PULSES};i++){
    if(i>=uPulseCount)break;
    vec4 p=uPulse[i];
    vec3 e=uPulseExtra[i];
    vec2 off=(uv-p.xy)*scale;
    float d=length(off),q=(d-e.z)/p.z;
    float g=exp(-q*q);
    vec2 dir=d>1e-4?off/d:vec2(0.);
    if(e.y>0.)state.xy=mix(state.xy,dir*p.w,g*e.y);
    else state.xy+=dir*p.w*g;
    state.z=min(1.,state.z+g*e.x);
  }
  float speed=length(state.xy);
  if(speed>5.)state.xy*=5./speed;
  outColor=encodeFluid(state);
}`;

  const FIELD_SCENES = { none: 3, source: 0, orb: 2, drift: 4, swell: 5, ripple: 9, halo: 10, flow: 1 };

  const FIELD_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uAtlas, uSource, uFluid;
uniform vec2 uRes, uCell;
uniform float uCount, uTime, uBlend, uScale;
uniform int uScene;
uniform float uSourceMix, uSceneMix;
uniform vec2 uSourceScale, uSourceOffset;
uniform vec3 uInk, uHighlight;
uniform float uContrast, uBrightness, uGamma, uInvert, uShade, uVignette, uFloor;
uniform vec2 uLevels;
uniform float uFluidOn, uRefraction, uGlow;
uniform vec4 uClear[3];
uniform float uClearFeather, uClearShape;
// Focus: x, y, r0, r1 in device px. Past r0 the wake weakens and the characters shrink step by step (the atlas's
// size rows), reaching uFocusFloor.x of the wake and uFocusFloor.y of the size at r1 and staying there beyond.
// Floors of 0 make the field vanish past r1; r1 <= 0 turns the focus off.
uniform vec4 uFocus;
uniform vec2 uFocusFloor;
uniform float uSizeRows;
out vec4 outColor;
const float BAYER[16]=float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
${FLUID_CODEC}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
// Generated scenes, after asciify-engine's field: orb, drift, swell, ripple and halo.
float generated(vec2 uv,float aspect){
  vec2 p=(uv-.5)*vec2(aspect,1.)*uScale;
  if(uScene==1){
    float t=uTime*.08;
    vec2 q=vec2(fbm(p*1.6+t),fbm(p*1.6-t+3.1));
    return smoothstep(.28,.86,fbm(p*1.8+q*1.6+vec2(t*.6,-t*.4)));
  }
  if(uScene==2){
    float r=.36,d=length(p),a=uTime*.25;
    vec3 l=normalize(vec3(cos(a)*.8,.55,sin(a)*.6+.6));
    if(d<r){
      vec3 n=normalize(vec3(p.x,-p.y,sqrt(r*r-d*d)));
      float diffuse=max(dot(n,l),0.),rim=pow(1.-n.z,2.5);
      float lon=atan(n.x,n.z)+uTime*.35,lat=asin(clamp(n.y,-1.,1.));
      float bands=.5+.25*sin(lat*14.)+.25*sin(lon*6.);
      return clamp(diffuse*.85+rim*.5+bands*.12,0.,1.);
    }
    return exp(-pow((d-r)*9.,2.))*.35;
  }
  if(uScene==4){
    float t=uTime*.045;
    vec2 q=p*1.15;
    vec2 w=vec2(fbm(q*.7+vec2(t,-t*.7)),fbm(q*.7+vec2(4.3-t*.8,t+1.7)));
    float n=fbm(q+w*1.3+vec2(t*.4,t*.25));
    return smoothstep(.36,.74,n);
  }
  if(uScene==5){
    float t=uTime;
    float s=sin((dot(p,vec2(.94,.33))/.95-t/9.)*6.2831853);
    float c=sin((dot(p,vec2(.6,-.8))/.58-t/13.)*6.2831853+s*.9);
    float k=sin((dot(p,vec2(-.29,.96))/.36+t/17.)*6.2831853);
    return smoothstep(.3,.9,.5+.5*(s*.5+c*.35+k*.15));
  }
  float t=uTime+40.;
  if(uScene==9){
    float tone=0.,g=.72;
    vec2 q=p/g,id=floor(q);
    for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
      vec2 c=id+vec2(i,j),h=vec2(hash(c),hash(c+7.3));
      float period=5.+h.x*5.,age=fract(t*.3/period*4.+h.y);
      vec2 at=(c+.2+.6*h)*g;
      float d=length(p-at),r=age*.62;
      float rings=max(0.,cos((d-r)*34.))*exp(-pow((d-r)/.11,2.));
      tone+=rings*pow(1.-age,1.8)*smoothstep(0.,.06,age)*(.7+.3*h.x);
    }
    return clamp(tone*1.25,0.,1.);
  }
  if(uScene==10){
    vec2 r=vec2(min(.46,aspect*.4),min(.34,.36/max(aspect,.01)*.5+.2));
    vec2 e=p/r;
    float d=length(e),a=atan(e.y,e.x),tt=t*.07,k=min(r.x,r.y);
    float breathe=1.+.04*sin(tt*3.1);
    float rays=.5+.5*noise(vec2(a*3.2+tt,tt*.5))*(.6+.4*noise(vec2(a*7.-tt*1.2,3.+tt*.4)));
    float s=(d-breathe)*k;
    float rim=exp(-pow(s/.03,2.));
    float corona=exp(-max(0.,s)/(.1+.08*rays))*smoothstep(-.04,.015,s)*rays*smoothstep(.36,.12,s);
    return clamp(rim*(.55+.45*rays)+corona*.85,0.,1.);
  }
  return 0.;
}
void main(){
  vec2 frag=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y);
  vec2 cell=floor(frag/uCell);
  vec2 uv=(cell+.5)*uCell/uRes;
  float aspect=uRes.x/uRes.y;
  // Focus: 1 at the mark, falling to 0 at r1. Strength and size follow it down to their floors.
  float vis=1.;
  if(uFocus.w>0.){
    float d=distance((cell+.5)*uCell,uFocus.xy);
    vis=1.-smoothstep(uFocus.z,uFocus.w,d);
  }
  float strength=mix(uFocusFloor.x,1.,vis),sizeV=mix(uFocusFloor.y,1.,vis);
  float lift=0.,wake=0.;
  vec2 disp=vec2(0.);
  if(uFluidOn>.5){
    vec4 f=decodeFluid(texture(uFluid,vec2(uv.x,1.-uv.y)));
    disp=vec2(f.x/aspect,-f.y)*uRefraction*strength;
    // Any motion lights the characters: the flow's speed and the splat energy, with a little cell-to-cell grain so
    // the lit area stays a shimmer of letters rather than a solid block.
    float grain=.7+.6*hash(cell*.731+vec2(19.17,3.71));
    float speed=clamp(length(f.xy)*.22,0.,.6);
    wake=clamp((f.z*.9+speed)*uGlow,0.,1.)*strength;
    lift=wake*.7*grain;
  }
  vec2 at=uv-disp;
  float tone=uScene==3?0.:generated(at,aspect)*uSceneMix;
  if(uSourceMix>0.){
    vec2 s=at*uSourceScale+uSourceOffset;
    float src=(s.x<0.||s.y<0.||s.x>1.||s.y>1.)?0.:texture(uSource,s).r;
    tone=max(tone,src*uSourceMix);
  }
  tone=clamp((tone-uLevels.x)/max(uLevels.y-uLevels.x,.01),0.,1.);
  tone=clamp((tone-.5)*uContrast+.5+uBrightness,0.,1.);
  tone=pow(tone,1./uGamma);
  if(uInvert>.5)tone=1.-tone;
  tone=max(tone,uFloor);
  // Clear zone: the picture fades out around content so text above it stays readable. The wake is added after,
  // so a pointer still stirs the field there.
  for(int i=0;i<3;i++){
    vec4 c=uClear[i];
    if(c.z<=0.)continue;
    vec2 half_=c.zw*.5*vec2(aspect,1.),q=(uv-c.xy-c.zw*.5)*vec2(aspect,1.);
    float dz;
    if(uClearShape>.5){vec2 e=abs(q)-half_;dz=length(max(e,0.))+min(max(e.x,e.y),0.);}
    else dz=(length(q/max(half_,vec2(1e-4)))-1.)*min(half_.x,half_.y);
    tone*=smoothstep(0.,uClearFeather,dz);
  }
  tone=clamp(tone+lift,0.,1.);
  tone*=1.-uVignette*smoothstep(.35,1.05,length((uv-.5)*vec2(min(aspect,1.8),1.)*2.));
  float level=tone*(uCount-1.),upper=fract(level)>=.5?1.:0.;
  if(uBlend>.5&&tone>.02&&tone<.98){
    ivec2 q=ivec2(mod(cell,4.));
    upper=fract(level)>(BAYER[q.y*4+q.x]+.5)/16.?1.:0.;
  }
  float index=min(uCount-1.,floor(level)+upper);
  vec2 local=frag-cell*uCell;
  int row=int(floor((1.-sizeV)*(uSizeRows-1.)+.5));
  float cov=sizeV<=0.?0.:texelFetch(uAtlas,ivec2(int(index)*int(uCell.x)+int(local.x),row*int(uCell.y)+int(local.y)),0).a;
  vec3 ink=uInk*mix(1.,.3+.7*tone,uShade);
  ink=mix(ink,uHighlight,clamp(wake*1.2,0.,1.));
  outColor=vec4(ink*cov,cov);
}`;

  /**
   * A field of characters on a canvas that fills its CSS box.
   * options: charset, font, fontWeight, cellSize (CSS px, cell height), cellAspect, glyphScale, ink, highlight,
   *   scene ('none' | 'orb' | 'drift' | 'swell' | 'ripple' | 'halo' | 'flow'), paint(frame) → bool (paints the source;
   *   return true while more frames are needed; its frame carries `pen`, `w`, `h`, `scale` and `bleed`, so draw with
   *   pen.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale) to work in CSS px), sourceMix, sourcePx (source
   *   px per cell, default 2), sourceBleed (CSS px of source kept past each edge of the canvas), contrast,
   *   brightness, gamma, invert, levels [lo, hi], blend, shade, vignette, floor, scale, speed, hover ('trail' | false),
   *   trail { strength, radius, refraction, decay }, pointerScope (element receiving pointer events; default canvas's
   *   parent), clear (element | {x,y,w,h} CSS px rel. to canvas | a list of up to three | null), clearShape
   *   ('ellipse' | 'rect'), clearFeather,
   *   watch (visibility element), maxPixels, focus ({x, y, r0, r1, far, sizeFloor} in CSS px, or (w, h) => that: beyond
   *   r0 the wake weakens and the characters step down through `sizes`, reaching `far` of the wake and `sizeFloor` of
   *   the size at r1; both default to 0, which makes the field vanish there), sizes (glyph size steps, largest first).
   */
  function glyphField(canvas, options = {}) {
    const o = Object.assign({
      charset: ' .:-=+*#%@', font: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 400,
      cellSize: 10, cellAspect: 0.62, glyphScale: 0.86, ink: '#e8e8e8', highlight: null,
      scene: 'none', sceneMix: 1, paint: null, sourceMix: 1, sourcePx: 2, sourceBleed: 0, sourceFit: 'stretch',
      contrast: 1, brightness: 0, gamma: 1, invert: false, levels: [0, 1], blend: true, shade: 0, vignette: 0, floor: 0,
      scale: 1, speed: 1, hover: 'trail', trail: { strength: 1, radius: 0.09, refraction: 0.035, decay: 1.4, energyDecay: 1.1 },
      pointerScope: null, clear: null, clearShape: 'ellipse', clearFeather: 0.08, watch: null, maxPixels: 4.2e6, stillTime: 40, onFrame: null,
      focus: null, sizes: [1, 0.8, 0.62, 0.46, 0.32, 0.2],
    }, options);
    o.trail = Object.assign({ strength: 1, radius: 0.09, refraction: 0.035, decay: 1.4, energyDecay: 1.1 }, options.trail || {});
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: true });
    if (!gl) return null;
    const still = reduced();
    const fieldProg = program(gl, FIELD_VS, FIELD_FS), fieldU = uniforms(gl, fieldProg);
    const fluidProg = program(gl, FIELD_VS, FLUID_FS), fluidU = uniforms(gl, fluidProg);

    // Textures: atlas (0), source (1), fluid ping-pong (2).
    const tex = (filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const atlasTex = tex(gl.NEAREST), sourceTex = tex(gl.LINEAR);
    const fluid = [0, 1].map(() => ({ t: tex(gl.LINEAR), fb: gl.createFramebuffer() }));
    let fluidW = 0, fluidH = 0, fluidIndex = 0;
    const blank = new Uint8Array([128, 128, 0, 255]);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    let scale = 1, W = 0, H = 0, cw = 8, ch = 10, cols = 0, rows = 0, glyphCount = 1;
    let source = null, sourceCtx = null, sourceDirty = true, morePaint = true;
    let time = 0, last = 0, raf = 0, visible = true, playing = true, disposed = false, atlasReady = false;

    const buildAtlas = () => {
      const chars = [...o.charset];
      glyphCount = chars.length;
      const c = document.createElement('canvas');
      // One row per glyph size: the first at full size, the rest smaller, for the focus falloff.
      const sizes = o.sizes && o.sizes.length ? o.sizes : [1];
      c.width = Math.max(1, cw * glyphCount); c.height = ch * sizes.length;
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      sizes.forEach((k, r) => {
        x.font = `${o.fontWeight} ${Math.max(1, Math.round(ch * o.glyphScale * k))}px ${o.font}`;
        chars.forEach((g, i) => x.fillText(g, i * cw + cw / 2, r * ch + ch / 2 + ch * 0.03 * k));
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      atlasReady = true;
    };

    const setupFluid = () => {
      fluidW = Math.max(8, Math.round(cols)); fluidH = Math.max(8, Math.round(rows));
      for (const f of fluid) {
        gl.bindTexture(gl.TEXTURE_2D, f.t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fluidW, fluidH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.t, 0);
        gl.clearColor(0.5, 0.5, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    const layout = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth)), h = Math.max(1, Math.round(canvas.clientHeight));
      let s = dpr();
      if (w * h * s * s > o.maxPixels) s = Math.sqrt(o.maxPixels / (w * h));
      scale = s;
      ch = Math.max(3, Math.round(o.cellSize * s));
      cw = Math.max(2, Math.round(o.cellSize * o.cellAspect * s));
      W = Math.max(1, Math.round(w * s)); H = Math.max(1, Math.round(h * s));
      cols = Math.ceil(W / cw); rows = Math.ceil(H / ch);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      buildAtlas();
      if (o.paint) {
        // The source keeps the canvas's aspect, at `sourcePx` pixels per cell height, so painters draw in CSS px
        // under one uniform scale. `sourceBleed` CSS px of extra room on every side let a picture that runs past
        // the canvas keep its hidden part, so the wake can pull it into view whole.
        source = source || document.createElement('canvas');
        const q = o.sourcePx / o.cellSize, b = o.sourceBleed || 0;
        source.width = Math.max(2, Math.round((w + 2 * b) * q)); source.height = Math.max(2, Math.round((h + 2 * b) * q));
        sourceCtx = source.getContext('2d');
        sourceDirty = true; morePaint = true;
      }
      setupFluid();
      pointer.cur = null; pointer.last = null;
    };

    // Pointer → fluid splats, in the fluid frame (origin bottom-left). Each frame splats one capsule from where the
    // last splat ended to where the pointer is now, so a fast pointer leaves an unbroken wake.
    const pointer = { cur: null, last: null, t: 0, tLast: 0 };
    const scope = o.pointerScope || canvas.parentElement || canvas;
    const onMove = (e) => {
      if (still || o.hover !== 'trail') return;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const now = performance.now();
      const x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
      if (!pointer.cur || now - pointer.t > 160 || x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1) { pointer.last = [x, y]; pointer.tLast = now; }
      pointer.cur = [x, y]; pointer.t = now;
      kick();
    };
    const onLeave = () => { pointer.cur = null; pointer.last = null; };
    scope.addEventListener('pointermove', onMove, { passive: true });
    scope.addEventListener('pointerleave', onLeave, { passive: true });

    // Radial splats waiting for the next fluid step, as [cx, cy, radius, strength, energy, hold, ring] in the fluid
    // frame. Up to PULSES go in each step; the queue keeps a few more so a burst of calls is not lost, and drops the
    // oldest past that.
    const pulses = [], pulseData = new Float32Array(4 * PULSES), pulseExtra = new Float32Array(3 * PULSES);

    const stepFluid = (dt) => {
      gl.useProgram(fluidProg);
      const src = fluid[fluidIndex], dst = fluid[1 - fluidIndex];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, fluidW, fluidH);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, src.t);
      gl.uniform1i(fluidU.uPrevious, 2);
      gl.uniform2f(fluidU.uSize, fluidW, fluidH);
      gl.uniform1f(fluidU.uAspect, W / H);
      gl.uniform1f(fluidU.uDt, dt);
      gl.uniform1f(fluidU.uDecay, o.trail.decay);
      gl.uniform1f(fluidU.uEnergyDecay, o.trail.energyDecay);
      gl.uniform1f(fluidU.uRadius, o.trail.radius);
      let splat = false;
      if (pointer.cur && pointer.last && performance.now() - pointer.t < 160) {
        const [x0, y0] = pointer.last, [x1, y1] = pointer.cur;
        const moved = Math.hypot(x1 - x0, y1 - y0);
        if (moved > 0.0005) {
          const sdt = Math.max(0.008, (pointer.t - pointer.tLast) / 1000);
          const k = 2.4 * o.trail.strength;
          const fx = clamp(((x1 - x0) / sdt) * k, -5, 5), fy = clamp(((y1 - y0) / sdt) * k, -5, 5);
          gl.uniform2f(fluidU.uFrom, x0, y0);
          gl.uniform2f(fluidU.uTo, x1, y1);
          gl.uniform2f(fluidU.uForce, fx, fy);
          splat = true;
        }
        pointer.last = pointer.cur; pointer.tLast = pointer.t;
      }
      gl.uniform1f(fluidU.uSplat, splat ? 1 : 0);
      if (!splat) { gl.uniform2f(fluidU.uFrom, 0, 0); gl.uniform2f(fluidU.uTo, 0, 0); gl.uniform2f(fluidU.uForce, 0, 0); }
      const n = Math.min(PULSES, pulses.length);
      for (let i = 0; i < n; i++) {
        const p = pulses[i];
        pulseData[i * 4] = p[0]; pulseData[i * 4 + 1] = p[1]; pulseData[i * 4 + 2] = p[2]; pulseData[i * 4 + 3] = p[3];
        pulseExtra[i * 3] = p[4]; pulseExtra[i * 3 + 1] = p[5]; pulseExtra[i * 3 + 2] = p[6];
      }
      pulses.splice(0, n);
      gl.uniform1i(fluidU.uPulseCount, n);
      if (n) { gl.uniform4fv(fluidU.uPulse, pulseData); gl.uniform3fv(fluidU.uPulseExtra, pulseExtra); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      fluidIndex = 1 - fluidIndex;
    };

    // Up to three clear zones (elements or {x, y, w, h} boxes in CSS px), packed as uv rects; empty ones are zero.
    const clearBoxes = () => {
      const out = new Float32Array(12);
      const list = (Array.isArray(o.clear) ? o.clear : [o.clear]).filter(Boolean).slice(0, 3);
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return out;
      const pad = o.clearPad || 0;
      list.forEach((b, i) => {
        if (b instanceof Element) { const e = b.getBoundingClientRect(); b = { x: e.left - r.left, y: e.top - r.top, w: e.width, h: e.height }; }
        if (!b.w || !b.h) return;
        out.set([(b.x - pad) / r.width, (b.y - pad) / r.height, (b.w + 2 * pad) / r.width, (b.h + 2 * pad) / r.height], i * 4);
      });
      return out;
    };

    const render = (dt) => {
      if (disposed || !atlasReady) return;
      const t = still ? o.stillTime : time / 1000;
      if (o.paint && (sourceDirty || morePaint) && sourceCtx) {
        sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
        sourceCtx.globalAlpha = 1; sourceCtx.globalCompositeOperation = 'source-over';
        sourceCtx.fillStyle = '#000';
        sourceCtx.fillRect(0, 0, source.width, source.height);
        morePaint = !!o.paint({
          pen: sourceCtx, width: source.width, height: source.height,
          w: canvas.clientWidth, h: canvas.clientHeight, scale: o.sourcePx / o.cellSize, bleed: o.sourceBleed || 0,
          now: t, still, box: (el) => { const r = canvas.getBoundingClientRect(), e = el.getBoundingClientRect(); return { x: e.left - r.left, y: e.top - r.top, w: e.width, h: e.height }; },
        });
        sourceDirty = false;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
      const fluidOn = !still && o.hover === 'trail';
      if (fluidOn && dt > 0) stepFluid(Math.min(0.05, dt));

      gl.useProgram(fieldProg);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, fluid[fluidIndex].t);
      gl.uniform1i(fieldU.uAtlas, 0); gl.uniform1i(fieldU.uSource, 1); gl.uniform1i(fieldU.uFluid, 2);
      gl.uniform2f(fieldU.uRes, W, H);
      gl.uniform2f(fieldU.uCell, cw, ch);
      gl.uniform1f(fieldU.uCount, glyphCount);
      gl.uniform1f(fieldU.uTime, t * o.speed);
      gl.uniform1f(fieldU.uBlend, o.blend ? 1 : 0);
      gl.uniform1f(fieldU.uScale, o.scale);
      gl.uniform1i(fieldU.uScene, FIELD_SCENES[o.scene] ?? 3);
      gl.uniform1f(fieldU.uSourceMix, o.paint ? o.sourceMix : 0);
      gl.uniform1f(fieldU.uSceneMix, o.sceneMix);
      { const b = o.sourceBleed || 0, cw2 = Math.max(1, canvas.clientWidth), ch2 = Math.max(1, canvas.clientHeight);
        gl.uniform2f(fieldU.uSourceScale, cw2 / (cw2 + 2 * b), ch2 / (ch2 + 2 * b)); gl.uniform2f(fieldU.uSourceOffset, b / (cw2 + 2 * b), b / (ch2 + 2 * b)); }
      const ink = parseColor(o.ink, canvas), hi = o.highlight ? parseColor(o.highlight, canvas) : null;
      gl.uniform3f(fieldU.uInk, ink[0], ink[1], ink[2]);
      if (hi) gl.uniform3f(fieldU.uHighlight, hi[0], hi[1], hi[2]);
      else { const m = Math.max(ink[0], ink[1], ink[2], 0.06); gl.uniform3f(fieldU.uHighlight, ink[0] / m, ink[1] / m, ink[2] / m); }
      gl.uniform1f(fieldU.uContrast, o.contrast); gl.uniform1f(fieldU.uBrightness, o.brightness); gl.uniform1f(fieldU.uGamma, o.gamma);
      gl.uniform1f(fieldU.uInvert, o.invert ? 1 : 0); gl.uniform1f(fieldU.uShade, o.shade); gl.uniform1f(fieldU.uVignette, o.vignette);
      gl.uniform1f(fieldU.uFloor, o.floor);
      gl.uniform2f(fieldU.uLevels, o.levels[0], o.levels[1]);
      gl.uniform1f(fieldU.uFluidOn, fluidOn ? 1 : 0);
      gl.uniform1f(fieldU.uRefraction, o.trail.refraction); gl.uniform1f(fieldU.uGlow, o.trail.strength);
      gl.uniform4fv(fieldU.uClear, clearBoxes());
      const f = typeof o.focus === 'function' ? o.focus(canvas.clientWidth, canvas.clientHeight) : o.focus;
      if (f && f.r1 > 0) { gl.uniform4f(fieldU.uFocus, f.x * scale, f.y * scale, f.r0 * scale, f.r1 * scale); gl.uniform2f(fieldU.uFocusFloor, f.far ?? 0, f.sizeFloor ?? 0); }
      else { gl.uniform4f(fieldU.uFocus, 0, 0, 0, 0); gl.uniform2f(fieldU.uFocusFloor, 1, 1); }
      gl.uniform1f(fieldU.uSizeRows, o.sizes && o.sizes.length ? o.sizes.length : 1);
      gl.uniform1f(fieldU.uClearFeather, o.clearFeather); gl.uniform1f(fieldU.uClearShape, o.clearShape === 'rect' ? 1 : 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (o.onFrame) o.onFrame(handle);
    };

    const animated = () => !still && (o.scene !== 'none' || o.hover === 'trail' || morePaint);
    const loop = (now) => {
      raf = 0;
      if (disposed || !visible || !playing) return;
      const dt = last ? Math.min(100, now - last) / 1000 : 0;
      last = now;
      time += dt * 1000;
      render(dt);
      if (animated()) raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!raf && !disposed) { last = 0; raf = requestAnimationFrame(loop); } };

    const ro = new ResizeObserver(() => { layout(); render(0); kick(); });
    ro.observe(canvas);
    const unwatch = watchVisible(o.watch || canvas, (v) => { visible = v; if (v) kick(); });
    if (document.fonts && document.fonts.load) {
      document.fonts.load(`${o.fontWeight} 16px ${o.font}`).then(() => { if (!disposed) { buildAtlas(); render(0); kick(); } }).catch(() => {});
    }

    const handle = {
      gl, canvas,
      get cells() { return { cols, rows, cw, ch, scale }; },
      update(partial) {
        const relayout = ['charset', 'font', 'fontWeight', 'cellSize', 'cellAspect', 'glyphScale', 'sourcePx', 'sourceBleed', 'sizes'].some((k) => k in partial && partial[k] !== o[k]);
        const { trail, ...rest } = partial;
        Object.assign(o, rest);
        if (trail) o.trail = Object.assign({}, o.trail, trail);
        if (relayout) layout(); else sourceDirty = true;
        render(0); kick();
      },
      repaint() { sourceDirty = true; morePaint = true; kick(); },
      /**
       * A radial splat into the wake at the next fluid step: {x, y} and radius in CSS px of the canvas; strength the
       * push given to the field, outward if positive and inward if negative (the wake's own pushes run 0–5, and 5 is
       * the cap); energy how brightly it lights (0–1, 1 saturates). The splat is a soft disc of that radius, or with
       * `ring` (CSS px) a band that wide at that distance from the centre. Either way it bulges and fades where it
       * is put: the wake's advection carries nothing into still fluid, so a pulse is a flash rather than a ripple.
       * With `hold` (0–1) the field is instead eased that fraction of the way toward a steady flow at
       * `strength` — call it every frame with hold = 1 - exp(-rate * dt) to keep a draw or a stream going. Returns
       * false when the wake is off (reduced motion).
       */
      pulse({ x, y, radius = 40, strength = 0, energy = 0, hold = 0, ring = 0 }) {
        if (still || o.hover !== 'trail' || disposed) return false;
        const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
        pulses.push([x / w, 1 - y / h, Math.max(1e-3, radius / h), strength, energy, clamp(hold), Math.max(0, ring) / h]);
        if (pulses.length > 2 * PULSES) pulses.splice(0, pulses.length - 2 * PULSES);
        kick();
        return true;
      },
      play() { playing = true; kick(); },
      pause() { playing = false; },
      destroy() {
        disposed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); unwatch();
        scope.removeEventListener('pointermove', onMove); scope.removeEventListener('pointerleave', onLeave);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
    layout();
    render(0);
    kick();
    return handle;
  }

  // ------------------------------------------------------------------ 3. The mark and its needle
  const LOGO = {
    viewBox: '0 0 300 300',
    ring: 'M264.18,127.99h-.04c-.47-1.75-2.05-3.04-3.94-3.04-2.26,0-4.1,1.83-4.1,4.1h-.03c.02.89.04,1.79.04,2.68,0,30.07-10.95,57.58-29.06,78.79h-.02c-.46.55-.93,1.09-1.4,1.63-.18.21-.36.42-.54.62-.46.52-.93,1.04-1.41,1.55-.73.78-1.47,1.56-2.22,2.32-.52.53-1.05,1.05-1.58,1.56-.15.15-.31.3-.47.45-18.1,17.36-42.66,28.04-69.71,28.04-55.65,0-100.75-45.11-100.75-100.75s45.11-100.75,100.75-100.75c18.17,0,35.21,4.82,49.93,13.25v-.1c12.33,6.29,23.8,14.82,33.77,25.55,1.69,1.82,3.3,3.67,4.86,5.56l5.11,6.08,1.92,2.55h.03c.87,1.01,2.16,1.68,3.6,1.68,2.14,0,3.92-1.42,4.53-3.36h.04s1.02-3.78,1.02-3.78c0,0,0-.02,0-.03,0-.01,0-.02,0-.03l.14-.51h-.04s0-.02,0-.02l.03.02c2.39-8.46,3.64-17.5,4.13-21.54.38-3.15,1.02-8.01,1.22-11.55.27-4.67-1.32-6.79-8.08-6.87-5.41-.06-6.51.15-15.4-.16-8.57-.3-10.96-.99-15.15-3.99,0,0-.01,0-.02,0-20.09-14.72-44.86-23.42-71.67-23.42-67.06,0-121.42,54.36-121.42,121.42s54.36,121.42,121.42,121.42c41.74,0,78.56-21.07,100.41-53.14h-.04c.29-.41.58-.82.86-1.23.17-.26.34-.51.51-.77.37-.55.72-1.12,1.08-1.68.85-1.35,1.68-2.72,2.48-4.1.02-.04.04-.08.07-.11.47-.81.92-1.63,1.37-2.45,7.55-14.13,11.84-30.26,11.84-47.4,0-9.89-1.43-19.45-4.1-28.48Z',
    needle: 'M164.9,183h0s23.81-69.96,23.81-69.96c1.01-2.28.57-5.04-1.32-6.88-1.77-1.72-4.32-2.15-6.49-1.32h0s-69.72,25.92-69.72,25.92h0c-.88.31-1.7.81-2.39,1.52-2.36,2.42-2.31,6.3.12,8.66.46.45.97.81,1.52,1.08h0s26.32,12.96,26.32,12.96h0c2.01,1.06,2.99,2.7,3.22,3.12l13.69,25.98h0c.29.54.66,1.05,1.13,1.5,2.42,2.36,6.3,2.31,8.66-.12.7-.72,1.18-1.56,1.45-2.45Z',
    pivot: [148.15, 145.87],
    /** Screen angle (degrees, clockwise from +x) the needle points at rest. */
    rest: -39.5,
    /** Inline SVG markup of the mark. `fill` defaults to currentColor. */
    svg(attrs = '') {
      return `<svg viewBox="${LOGO.viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" ${attrs}><path class="ring" fill="currentColor" d="${LOGO.ring}"/><path class="needle" data-needle fill="currentColor" d="${LOGO.needle}"/></svg>`;
    },
  };

  // The brand animation's needle, traced at 20 ms a frame: [seconds, degrees relative to rest]. Negative turns
  // counter-clockwise on screen. One full turn past rest, a swing back, then it settles.
  const SEEK = [
    [0.00, -50], [0.06, -100], [0.12, -146], [0.18, -212], [0.24, -255], [0.30, -298], [0.36, -330], [0.42, -351],
    [0.48, -373], [0.54, -387], [0.60, -402], [0.66, -416], [0.78, -430], [0.90, -440], [1.02, -444], [1.14, -444],
    [1.32, -440], [1.44, -432], [1.56, -406], [1.68, -353], [1.80, -329], [1.92, -321], [2.04, -316], [2.28, -316],
    [2.34, -318], [2.52, -327], [2.70, -343], [2.88, -351], [3.06, -355], [3.24, -357], [3.42, -360.3], [3.54, -360],
  ];
  const SEEK_END = SEEK[SEEK.length - 1][0];
  /** Catmull-Rom through the traced keyframes. */
  function seekAngle(t) {
    if (t <= 0) return SEEK[0][1];
    if (t >= SEEK_END) return -360;
    let i = 0;
    while (i < SEEK.length - 2 && SEEK[i + 1][0] <= t) i++;
    const p0 = SEEK[Math.max(0, i - 1)], p1 = SEEK[i], p2 = SEEK[i + 1], p3 = SEEK[Math.min(SEEK.length - 1, i + 2)];
    const u = (t - p1[0]) / (p2[0] - p1[0]), u2 = u * u, u3 = u2 * u;
    return 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3);
  }

  /**
   * The needle's motion model. Reads `.angle` (degrees, relative to rest) and `.alpha` (the mark's fade-in).
   * options: intro (play the seek on start; default true unless reduced motion), steer (follow the pointer; default
   *   true), scope (element whose pointer the needle follows; default document), center() → {x, y} client coords of
   *   the pivot (needed for steering), reach (CSS px from the pivot within which the pointer is followed; default 420),
   *   onFrame(angle, alpha), delay (ms before the intro).
   */
  function needle(options = {}) {
    const o = Object.assign({ intro: !reduced(), steer: !reduced(), scope: document, center: null, reach: 420, onFrame: null, delay: 0, fade: 1.0 }, options);
    let angle = 0, alpha = o.intro ? 0 : 1, vel = 0, target = 0, pointer = null;
    let phase = o.intro ? 'wait' : 'idle', t0 = 0, raf = 0, disposed = false, last = 0;
    const norm = (a) => ((a % 360) + 360) % 360;

    const step = (now) => {
      raf = 0;
      if (disposed) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      let active = false;
      if (phase === 'wait') { if (now - t0 >= o.delay) { phase = 'intro'; t0 = now; } active = true; }
      if (phase === 'intro') {
        const t = (now - t0) / 1000;
        alpha = clamp(t / o.fade);
        angle = seekAngle(t);
        if (t >= SEEK_END) { phase = 'idle'; angle = 0; vel = 0; alpha = 1; }
        active = true;
      } else if (phase === 'idle') {
        // Spring toward the target, taking the short way round.
        let goal = target;
        const d = norm(goal - angle);
        goal = angle + (d > 180 ? d - 360 : d);
        const k = 90, c = 13;
        const acc = k * (goal - angle) - c * vel;
        vel += acc * dt;
        angle += vel * dt;
        if (Math.abs(goal - angle) < 0.02 && Math.abs(vel) < 0.05) { angle = goal; vel = 0; } else active = true;
      }
      if (o.onFrame) o.onFrame(angle, alpha);
      if (active) raf = requestAnimationFrame(step);
    };
    const kick = () => { if (!raf && !disposed) { last = 0; raf = requestAnimationFrame(step); } };

    const onMove = (e) => {
      if (!o.steer || !o.center) return;
      const c = o.center();
      if (!c) return;
      const dx = e.clientX - c.x, dy = e.clientY - c.y, dist = Math.hypot(dx, dy);
      if (dist > o.reach || dist < 4) { target = 0; pointer = null; }
      else { pointer = [dx, dy]; target = (Math.atan2(dy, dx) * 180) / Math.PI - LOGO.rest; }
      kick();
    };
    const onLeave = () => { target = 0; pointer = null; kick(); };
    if (o.steer) {
      o.scope.addEventListener('pointermove', onMove, { passive: true });
      o.scope.addEventListener('pointerleave', onLeave, { passive: true });
      document.addEventListener('pointerleave', onLeave, { passive: true });
    }

    const handle = {
      get angle() { return angle; },
      get alpha() { return alpha; },
      get settled() { return phase === 'idle' && !pointer; },
      get absolute() { return LOGO.rest + angle; },
      replay() { if (reduced()) return; phase = 'intro'; t0 = performance.now(); vel = 0; kick(); },
      aim(deg) { target = deg; kick(); },
      destroy() {
        disposed = true; if (raf) cancelAnimationFrame(raf);
        o.scope.removeEventListener('pointermove', onMove); o.scope.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('pointerleave', onLeave);
      },
    };
    t0 = performance.now();
    if (o.onFrame) o.onFrame(angle, alpha);
    kick();
    return handle;
  }

  /** Binds a needle controller to an inline SVG of the mark (its `[data-needle]` path turns about the pivot). */
  function logo(svg, options = {}) {
    const path = svg.querySelector('[data-needle]');
    const [px, py] = LOGO.pivot;
    const ctrl = needle(Object.assign({
      center: () => {
        const r = svg.getBoundingClientRect();
        if (!r.width) return null;
        return { x: r.left + (r.width * px) / 300, y: r.top + (r.height * py) / 300 };
      },
      onFrame: (angle, alpha) => {
        path.setAttribute('transform', `rotate(${angle.toFixed(3)} ${px} ${py})`);
        if (options.fadeTarget !== null) (options.fadeTarget || svg).style.opacity = alpha.toFixed(3);
      },
    }, options));
    if (options.replayOnClick !== false) svg.addEventListener('click', () => ctrl.replay());
    return ctrl;
  }

  // ------------------------------------------------------------------ 4. The pulse
  /**
   * A key's pulse, let out through `field.pulse()` from wherever `origin()` says. Call press() when the key goes down
   * and release() when it comes up:
   *   - a tap lets out a small pulse;
   *   - holding charges a bigger one over `prime` ms, and while it charges the field is drawn in toward the point and
   *     glows there, harder and brighter as the charge builds;
   *   - held past `prime`, the field is primed: it throbs from the point every `period` ms until the key is
   *     released, which lets out the biggest pulse the wake allows (its speed cap, full brightness).
   * A pulse here is what the wake's physics makes of a radial push: a disc that lights, bulges outward and fades
   * in under a second (the advection carries nothing into still fluid, so it is a flash rather than a ripple).
   * options: origin() → {x, y} in CSS px of the field's canvas (null for nowhere), radius() → the base radius in CSS
   *   px (the wake's own radius reads well), prime (ms, default 5000), period (ms, default 700), onFrame(charge,
   *   primed) each frame while held and once on release. Nothing happens under reduced motion.
   */
  function pulser(field, options = {}) {
    const o = Object.assign({ origin: null, radius: () => 60, prime: 5000, period: 700, onFrame: null }, options);
    let down = false, t0 = 0, last = 0, raf = 0, nextThrob = 0, disposed = false;
    const charge = (now) => clamp((now - t0) / o.prime);
    const emit = (spec) => field && field.pulse(spec);
    // The pulse let out on release, from the tap's up to the maximal one. Its radius and push grow with the square
    // of the charge, so the first second or two stay modest and the last stretch to the cap of 5 is where it gets
    // big: the tap lights about two of the base radius, the maximal pulse about seven.
    const fire = (c, at) => {
      const r = o.radius(), k = c * c;
      emit({ x: at.x, y: at.y, radius: r * (1.1 + 2.1 * k), strength: 1.4 + 3.6 * k, energy: 0.5 + 0.5 * c });
    };
    const step = (now) => {
      raf = 0;
      if (disposed || !down) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      const c = charge(now), at = o.origin ? o.origin() : null, r = o.radius();
      if (at && dt > 0) {
        if (c < 1) {
          // Charging: the field is held flowing in toward the point, faster as the charge builds, and glows there. The
          // glow is added per second of real time, so it settles at the same brightness whatever the frame rate.
          emit({ x: at.x, y: at.y, radius: r * (1 + 0.6 * c), strength: -2.2 * c, hold: 1 - Math.exp(-6 * dt) });
          emit({ x: at.x, y: at.y, radius: r * (1.2 + 0.8 * c), energy: (0.5 + 1.3 * c) * dt });
        } else {
          // Primed: a glowing core, and every `period` a beat from it — a flash a little bigger than a tap, gone
          // before the next, and a clear step down from the maximal pulse the release will bring.
          emit({ x: at.x, y: at.y, radius: r * 0.9, energy: 0.5 * dt });
          if (now >= nextThrob) { emit({ x: at.x, y: at.y, radius: r * 1.3, strength: 2.2, energy: 0.7 }); nextThrob = now + o.period; }
        }
      }
      if (o.onFrame) o.onFrame(c, c >= 1);
      raf = requestAnimationFrame(step);
    };
    const handle = {
      get held() { return down; },
      get charge() { return down ? charge(performance.now()) : 0; },
      get primed() { return down && charge(performance.now()) >= 1; },
      press() {
        if (disposed || down || reduced()) return;
        down = true; t0 = performance.now(); last = 0; nextThrob = t0 + o.prime;
        if (!raf) raf = requestAnimationFrame(step);
      },
      release() {
        if (!down) return;
        down = false;
        const at = o.origin ? o.origin() : null;
        if (at) fire(charge(performance.now()), at);
        if (o.onFrame) o.onFrame(0, false);
      },
      /** Lets go without a pulse (the window lost focus mid-hold, say). */
      cancel() { if (!down) return; down = false; if (o.onFrame) o.onFrame(0, false); },
      destroy() { disposed = true; down = false; if (raf) cancelAnimationFrame(raf); },
    };
    return handle;
  }

  window.Steer = { dither, glyphField, pulser, needle, logo, LOGO, parseColor, reduced, watchVisible, seekAngle, DITHER_SHAPES, DITHER_TYPES };
})();