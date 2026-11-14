import { FilmRenderer, PRESETS } from './film.js';
import { STAMPS, compose, framePad, rotate } from './stamp.js';
import { withExif } from './exif.js';
import { addShot, updateShot, getShot, deleteShot, listShots } from './album.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#view');
const video = $('#video');
const shutter = $('#shutter');
const placeholder = $('#placeholder');
const placeholderText = $('#placeholderText');
const badge = $('#badge');
const closeImage = $('#closeImage');
const review = $('#review');
const reviewImg = $('#reviewImg');

// 아이폰 캔버스 최대 면적(약 16.7MP)을 정보 프레임 여백까지 붙여도 넘지 않는 크기
const MAX_IMAGE_SIDE = 3200;
const isTouch = matchMedia('(pointer: coarse)').matches;
const RATIOS = [
  { label: '3:4', value: 3 / 4 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let renderer;
try {
  renderer = new FilmRenderer(canvas);
} catch (e) {
  showPlaceholder(e.message, false);
  throw e;
}

const state = {
  mode: 'camera',     // 'camera' | 'image'
  facing: 'environment',
  mirror: false,
  bypass: false,
  stream: null,
  preset: PRESETS.find((p) => p.id === localStorage.getItem('preset')) ?? PRESETS[0],
  ratio: RATIOS.find((r) => r.label === localStorage.getItem('ratio')) ?? RATIOS[0],
  grid: localStorage.getItem('grid') === 'on',
  flash: false,
  torch: false,       // 후면 카메라 손전등을 켤 수 있는지 (기기·브라우저마다 다름)
  capturing: false,
  stamp: STAMPS.find((s) => s.id === localStorage.getItem('stamp')) ?? STAMPS[0],
  imageDate: null,    // 불러온 사진의 날짜
  shot: null,         // 찍은 사진 { film, original, meta }
  rotation: 0,        // 정보 프레임에서 사진 회전 (0/90/180/270)
  title: '',          // 정보 프레임 제목
  showTime: localStorage.getItem('stampTime') === 'on', // 날짜 스탬프에 시간도 넣을지
  out: null,          // 저장할 최종 파일 { film, original }
  rendering: false,   // 최종 파일을 만드는 중 (그동안 저장 막기)
  zoom: 1,
  strength: Number(localStorage.getItem('strength') ?? 100) / 100, // 찍기 전 필름 강도
  ev: 0,              // 사용자가 조절한 밝기 (EV)
  hq: localStorage.getItem('hq') === 'on', // 고화질
  nativeZoom: null,   // 카메라 자체 줌 범위 {min, max} (지원할 때만)
  imageCanvas: null,
  shotUrl: null,
  originalUrl: null,
};

// ---------- 필름 선택: 쉐브론으로 여닫는 가로 캐러셀 ----------
const filmDrawer = $('#filmDrawer');
const filmToggle = $('#filmToggle');
const carousel = $('#filmCarousel');
for (const p of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'film-item';
  btn.setAttribute('role', 'option');
  btn.dataset.id = p.id;
  btn.textContent = p.label;
  btn.addEventListener('click', () => {
    selectPreset(p);
    centerFilm('smooth');
  });
  carousel.append(btn);
}

const filmItem = (id) => carousel.querySelector(`[data-id="${id}"]`);
function centerFilm(behavior = 'instant') {
  const el = filmItem(state.preset.id);
  carousel.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - carousel.clientWidth / 2, behavior });
}

function setDrawer(open) {
  filmDrawer.classList.toggle('open', open);
  filmToggle.setAttribute('aria-expanded', String(open));
  if (open) centerFilm();
}
filmToggle.addEventListener('click', () => setDrawer(!filmDrawer.classList.contains('open')));

// 옆으로 밀다가 멈추면 가운데 온 필름을 고른다
let scrollTimer;
carousel.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const mid = carousel.scrollLeft + carousel.clientWidth / 2;
    let best;
    for (const el of carousel.children) {
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (!best || d < best.d) best = { el, d };
    }
    const p = PRESETS.find((x) => x.id === best.el.dataset.id);
    if (p !== state.preset) selectPreset(p);
  }, 120);
});

let nameTimer;
function showFilmName(text) {
  if (state.bypass) return;
  badge.textContent = text;
  badge.classList.add('on', 'film-name');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => badge.classList.remove('on', 'film-name'), 900);
}

function selectPreset(p, { quiet = false } = {}) {
  state.preset = p;
  localStorage.setItem('preset', p.id);
  for (const el of carousel.children) el.setAttribute('aria-selected', String(el.dataset.id === p.id));
  if (!quiet) showFilmName(p.label);
  if (state.mode === 'image') drawImage();
}
selectPreset(state.preset, { quiet: true });

// ---------- 카메라 ----------
function showPlaceholder(text, withButton = true) {
  placeholderText.textContent = text;
  $('#startBtn').hidden = !withButton;
  placeholder.hidden = false;
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}

// 여러 곳(앱 복귀, 멈춤 감시, 결과 화면 닫기)에서 동시에 불러도 카메라 켜기는 한 번만 돈다
let cameraStarting = null;
function startCamera() {
  cameraStarting ??= openCamera().finally(() => { cameraStarting = null; });
  return cameraStarting;
}

async function openCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    showPlaceholder('카메라는 https 주소에서만 쓸 수 있어요. 사진 불러오기는 지금도 쓸 수 있어요.', false);
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: state.hq
        ? { facingMode: state.facing, width: { ideal: 4032 }, height: { ideal: 3024 } }
        : { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
  } catch (e) {
    const denied = e.name === 'NotAllowedError';
    showPlaceholder(denied
      ? '카메라 권한이 꺼져 있어요. 설정에서 허용한 뒤 다시 눌러 주세요.'
      : '카메라를 찾지 못했어요. 사진 불러오기로 색감을 먼저 써 볼 수 있어요.');
    return;
  }
  const track = state.stream.getVideoTracks()[0];
  // 아이폰 기본 창(입력 창, 공유 시트)이나 전화 등으로 카메라가 끊기면 다시 켠다
  track.addEventListener('ended', () => ensureCamera());
  const settings = track.getSettings();
  state.mirror = (settings.facingMode ?? state.facing) === 'user';
  const caps = track.getCapabilities?.() ?? {};
  state.torch = !state.mirror && !!caps.torch;
  state.nativeZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  updateFlashBtn();
  setZoom(1);
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  placeholder.hidden = true;
  if (state.hq && video.videoWidth) {
    toast(`고화질 ${Math.max(video.videoWidth, video.videoHeight)}×${Math.min(video.videoWidth, video.videoHeight)}`);
  }
}

function loop() {
  requestAnimationFrame(loop);
  if (state.mode !== 'camera' || !state.stream || video.readyState < 2 || !review.hidden || !album.hidden || state.capturing) return;
  watchFreeze();
  renderer.upload(video, video.videoWidth, video.videoHeight);
  renderer.render(state.preset, { ...previewOpts(), mirror: state.mirror, bypass: state.bypass });
  syncFrame();
}

// 미리보기: 고화질이거나 불러온 사진이면 화면용으로 줄여서 그린다 (찍을 때는 원래 크기)
const PREVIEW_MAX = 2048;
function previewOpts() {
  return {
    ratio: state.ratio.value,
    zoom: digitalZoom(),
    strength: state.strength,
    ev: state.ev,
    maxSide: state.hq || state.mode === 'image' ? PREVIEW_MAX : 0,
  };
}

// ---------- 카메라 멈춤 복구 ----------
// 카메라 화면으로 돌아왔을 때: 카메라가 꺼졌으면 다시 켜고, 멈춰 있으면 다시 재생
function ensureCamera() {
  if (state.mode !== 'camera' || document.hidden || !review.hidden || !album.hidden) return;
  const track = state.stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') startCamera();
  else if (video.paused) video.play().catch(() => startCamera());
}

// 미리보기 영상이 1.5초 넘게 그대로면 멈춘 것으로 보고 복구한다
let lastVideoTime = -1;
let lastVideoChange = 0;
let recovering = false;
function watchFreeze() {
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastVideoChange = now;
    return;
  }
  if (recovering || now - lastVideoChange < 1500) return;
  recovering = true;
  (async () => {
    const before = video.currentTime;
    await video.play().catch(() => {});
    await sleep(700);
    if (video.currentTime === before && state.mode === 'camera' && review.hidden) await startCamera();
  })().finally(() => {
    recovering = false;
    lastVideoChange = performance.now();
  });
}

// 화면의 사진 틀을 실제 결과 사진 비율에 맞춘다 (격자도 이 틀 기준)
let frameAr = 0;
function syncFrame() {
  const ar = canvas.width / canvas.height;
  if (Math.abs(ar - frameAr) < 1e-4) return;
  frameAr = ar;
  $('#frame').style.setProperty('--ar', ar);
  // 세로 9:16 이면 전체화면 미리보기
  $('.app').classList.toggle('full', state.ratio.label === '9:16' && ar < 1);
}

$('#startBtn').addEventListener('click', startCamera);

$('#flipBtn').addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  if (state.mode === 'image') exitImageMode();
  else startCamera();
});

// 앱을 잠깐 내렸다 돌아올 때는 카메라를 끄지 않는다.
// 다시 켜면(getUserMedia) 아이폰이 카메라 권한을 또 물어보기 때문. 아이폰은 앱이 뒤로 가면 알아서 카메라를 멈춘다.
// 돌아왔을 때 실제로 끊겨 있을 때만 다시 켜고, 오래(1분) 비우면 그때는 끈다 (PC·안드로이드에서 카메라 표시등이 계속 켜져 있지 않게).
const IDLE_CAMERA_OFF = 60_000;
let idleTimer;
document.addEventListener('visibilitychange', () => {
  clearTimeout(idleTimer);
  if (document.hidden) {
    idleTimer = setTimeout(stopCamera, IDLE_CAMERA_OFF);
  } else if (state.mode === 'camera') {
    ensureCamera();
  }
});

// ---------- 사진 불러오기 ----------
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    img.src = url;
    await img.decode();
  } catch {
    alert('이 사진은 열 수 없어요.');
    return;
  } finally {
    URL.revokeObjectURL(url);
  }
  const limit = Math.min(MAX_IMAGE_SIDE, renderer.maxSize);
  const scale = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  state.imageCanvas = c;
  state.imageDate = new Date(file.lastModified || Date.now());
  album.hidden = true;
  enterImageMode();
});

function enterImageMode() {
  state.mode = 'image';
  stopCamera();
  placeholder.hidden = true;
  closeImage.hidden = false;
  shutter.classList.add('image-mode');
  shutter.setAttribute('aria-label', '보정한 사진 저장');
  renderer.upload(state.imageCanvas, state.imageCanvas.width, state.imageCanvas.height);
  state.nativeZoom = null;
  setZoom(1);
}

function exitImageMode() {
  state.mode = 'camera';
  state.imageCanvas = null;
  closeImage.hidden = true;
  shutter.classList.remove('image-mode');
  shutter.setAttribute('aria-label', '촬영');
  if (reloadIfUpdated()) return;
  startCamera();
}

function drawImage() {
  renderer.render(state.preset, { ...previewOpts(), bypass: state.bypass, seed: 0.5 });
  syncFrame();
}

closeImage.addEventListener('click', exitImageMode);

// ---------- 줌 ----------
// 카메라가 줌을 지원하면 카메라 자체 줌(화질 좋음), 아니면 가운데를 잘라 확대하는 디지털 줌
const MAX_DIGITAL_ZOOM = 5;
const zoomBtn = $('#zoomBtn');
const maxZoom = () => (state.nativeZoom ? Math.min(state.nativeZoom.max / state.nativeZoom.min, 10) : MAX_DIGITAL_ZOOM);
const digitalZoom = () => (state.nativeZoom ? 1 : state.zoom);

function setZoom(z) {
  z = Math.min(maxZoom(), Math.max(1, z));
  state.zoom = z;
  zoomBtn.textContent = `${Number(z.toFixed(1))}×`;
  zoomBtn.classList.toggle('zoomed', z > 1.05);
  if (state.nativeZoom) applyNativeZoom(state.nativeZoom.min * z);
  else if (state.mode === 'image') drawImage();
}

// 핀치 중에는 값이 계속 바뀌므로 카메라에는 한 번에 하나씩만 보낸다
let zoomBusy = false;
let zoomWanted = null;
async function applyNativeZoom(value) {
  zoomWanted = value;
  if (zoomBusy) return;
  zoomBusy = true;
  while (zoomWanted !== null) {
    const v = zoomWanted;
    zoomWanted = null;
    await state.stream?.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {});
  }
  zoomBusy = false;
}

zoomBtn.addEventListener('click', () => setZoom(state.zoom > 1.05 ? 1 : 2));

// ---------- 화면 터치: 두 손가락은 줌, 한 손가락 길게 누르면 원본 비교 ----------
const viewfinder = $('#viewfinder');
function setBypass(on) {
  if (state.bypass === on) return;
  state.bypass = on;
  clearTimeout(nameTimer);
  badge.classList.remove('film-name');
  badge.textContent = '원본';
  badge.classList.toggle('on', on);
  if (state.mode === 'image') drawImage();
}

const pointers = new Map();
let pinch = null;
let holdTimer = 0;
const pinchDistance = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

viewfinder.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#frame')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pointers.size === 1) {
    holdTimer = setTimeout(() => setBypass(true), 250);
  } else if (pointers.size === 2) {
    clearTimeout(holdTimer);
    setBypass(false);
    pinch = { distance: pinchDistance(), zoom: state.zoom };
  }
});

viewfinder.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pinch && pointers.size >= 2) {
    setZoom(pinch.zoom * pinchDistance() / pinch.distance);
    return;
  }
  if (pointers.size !== 1) return;
  const dx = p.x - p.x0;
  const dy = p.y - p.y0;
  // 한 손가락으로 위아래로 밀면 밝기 조절 (아이폰 카메라처럼)
  if (!p.exposing && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
    p.exposing = true;
    p.ev0 = state.ev;
    p.y0 = p.y;
    clearTimeout(holdTimer);
    setBypass(false);
  } else if (!p.exposing && Math.hypot(dx, dy) > 10) {
    clearTimeout(holdTimer);
  }
  if (p.exposing) setEV(p.ev0 - (p.y - p.y0) / 160); // 160px 밀면 1 EV
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  clearTimeout(holdTimer);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) setBypass(false);
}
for (const ev of ['pointerup', 'pointercancel']) viewfinder.addEventListener(ev, endPointer);

// PC: 마우스 휠로 줌
viewfinder.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.002));
}, { passive: false });

// ---------- 촬영 · 저장 ----------
shutter.addEventListener('click', async () => {
  if (state.capturing) return;
  if (state.mode === 'camera' && (!state.stream || video.readyState < 2)) return;
  state.capturing = true;
  const deg = captureRotation(); // 폰을 가로로 들었으면 사진을 가로로 돌린다
  shutter.classList.add('busy');
  try {
    // 찍을 때는 줄이지 않고 원래 크기로. 필름은 강도 100%로 만들어 두고, 강도는 결과 화면에서 원본과 섞는다
    const opts = { ratio: state.ratio.value, zoom: digitalZoom(), ev: state.ev };
    if (state.mode === 'camera') {
      const lightOff = state.flash && canFlash() ? await lightOn() : null;
      const flash = $('#flash');
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
      renderer.upload(video, video.videoWidth, video.videoHeight);
      lightOff?.();
      opts.mirror = state.mirror;
    } else {
      opts.seed = 0.5;
    }
    // 같은 프레임으로 원본(색감 없이, 같은 비율)과 필름 사진을 하나씩 만든다
    renderer.render(state.preset, { ...opts, bypass: true });
    const original = await renderer.toBlob();
    renderer.render(state.preset, opts);
    const film = await renderer.toBlob();
    const meta = {
      date: state.mode === 'camera' ? new Date() : state.imageDate,
      film: state.preset.label,
      filmId: state.preset.id,
      zoom: Number(state.zoom.toFixed(1)),
    };
    if (film && original) await showShot(film, original, meta, { deg, strength: state.strength });
  } finally {
    state.capturing = false;
    shutter.classList.remove('busy');
  }
});

const compare = $('#compare');
const originalImg = $('#originalImg');

const canvasToBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));

// 아이폰은 캔버스 메모리 총량 제한이 있어서, 다 쓴 큰 캔버스·비트맵은 바로 비워 준다
function release(img) {
  if (!img) return;
  if (img instanceof HTMLCanvasElement) img.width = img.height = 0;
  else img.close?.();
}

// id 가 없으면 새로 찍은 사진 → 앨범에 추가. fromAlbum 이면 앨범에서 다시 연 사진.
async function showShot(film, original, meta, { deg = 0, strength = 1, id = Date.now(), fromAlbum = false } = {}) {
  let [filmBmp, originalBmp] = await Promise.all([createImageBitmap(film), createImageBitmap(original)]);
  if (deg) {
    const [f, o] = [rotate(filmBmp, deg), rotate(originalBmp, deg)];
    release(filmBmp);
    release(originalBmp);
    [filmBmp, originalBmp] = [f, o];
    [film, original] = await Promise.all([canvasToBlob(filmBmp), canvasToBlob(originalBmp)]);
  }
  release(state.shot?.filmBmp);
  release(state.shot?.originalBmp);
  state.shot = { id, film, original, filmBmp, originalBmp, meta, strength, fromAlbum };
  state.rotation = 0;
  state.title = '';
  updateFrameTools();
  setReviewStrength(strength);
  $('#deleteBtn').hidden = !fromAlbum;
  state.out = null;
  await renderReview();
  if (!state.out) return; // 만들기 실패 (안내는 renderReview 에서) — 이전 사진이 대신 뜨지 않게
  if (!fromAlbum) {
    await addShot({ id, date: meta.date.getTime(), meta, film, original, strength, thumb: await makeThumb(state.out.film) })
      .catch(() => toast('앨범에 보관하지 못했어요. 저장 공간을 확인해 주세요.'));
    refreshThumb();
  }
  setComparePos(0.5);
  setSaveSheet(false);
  review.hidden = false;
}

// 날짜·정보 표시를 적용한 최종 파일을 만들고 미리보기에 띄운다.
// 저장 버튼을 누른 뒤에 만들면 아이폰 공유 시트가 막힐 수 있어서 미리 만들어 둔다.
// 버튼을 빠르게 여러 번 누르면 이전 작업이 늦게 끝날 수 있어서, 가장 마지막 요청 결과만 반영한다
let reviewToken = 0;

async function renderReview() {
  const token = ++reviewToken;
  state.rendering = true;
  try {
    await buildReview(token);
  } catch {
    if (token === reviewToken) toast('사진을 만들지 못했어요. 다시 시도해 주세요.');
  } finally {
    if (token === reviewToken) state.rendering = false;
  }
}

async function buildReview(token) {
  const { film, original, filmBmp, originalBmp, meta, strength } = state.shot;
  const style = state.stamp.id;
  // 강도: 강도 100% 필름 사진을 원본 위에 그 비율만큼 겹친다
  const mixed = strength < 0.995 ? blend(originalBmp, filmBmp, strength) : null;
  const filmBase = mixed ?? filmBmp;
  let filmOut = mixed && style === 'none' ? await canvasToBlob(mixed) : film;
  let originalOut = original;
  let ar = filmBmp.width / filmBmp.height;
  let inset = ['0px', '0px'];
  if (style !== 'none') {
    const deg = style === 'frame' ? state.rotation : 0;
    let filmSrc = rotate(filmBase, deg);
    let originalSrc = rotate(originalBmp, deg);
    if (style === 'frame') {
      // 프레임 여백까지 붙여도 아이폰 캔버스 한도(16.7MP)를 넘지 않게
      const f = fitArea(filmSrc, FRAME_MAX_AREA);
      const o = fitArea(originalSrc, FRAME_MAX_AREA);
      if (f !== filmSrc && filmSrc !== filmBase) release(filmSrc);
      if (o !== originalSrc && originalSrc !== originalBmp) release(originalSrc);
      [filmSrc, originalSrc] = [f, o];
    }
    const info = { ...meta, title: state.title, showTime: state.showTime };
    const fc = compose(filmSrc, style, info);
    const oc = compose(originalSrc, style, info);
    [filmOut, originalOut] = await Promise.all([canvasToBlob(fc), canvasToBlob(oc)]);
    ar = fc.width / fc.height;
    if (style === 'frame') {
      const pad = framePad(filmSrc.width, filmSrc.height);
      inset = [`${(pad / fc.width) * 100}%`, `${(pad / fc.height) * 100}%`];
    }
    release(fc);
    release(oc);
    if (filmSrc !== filmBase) release(filmSrc);
    if (originalSrc !== originalBmp) release(originalSrc);
  }
  release(mixed);
  // 캔버스가 너무 크거나 메모리가 모자라면 toBlob 이 null 을 준다
  if (!filmOut || !originalOut) throw new Error('toBlob failed');
  [filmOut, originalOut] = await Promise.all([
    withExif(filmOut, { date: meta.date, description: `Film Camera ${meta.filmId}` }),
    withExif(originalOut, { date: meta.date, description: 'Film Camera original' }),
  ]);
  if (token !== reviewToken) return; // 그 사이 더 새로운 요청이 들어옴

  compare.style.setProperty('--inset-x', inset[0]);
  compare.style.setProperty('--inset-y', inset[1]);
  state.out = { film: filmOut, original: originalOut };

  if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
  if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
  state.shotUrl = URL.createObjectURL(filmOut);
  state.originalUrl = URL.createObjectURL(originalOut);
  reviewImg.src = state.shotUrl;
  originalImg.src = state.originalUrl;
  compare.style.setProperty('--ar', ar);
}

// 두 사진을 t 만큼 섞은 캔버스 (a 위에 b 를 투명도 t 로)
function blend(a, b, t) {
  const c = document.createElement('canvas');
  c.width = b.width;
  c.height = b.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(a, 0, 0, c.width, c.height);
  ctx.globalAlpha = t;
  ctx.drawImage(b, 0, 0);
  return c;
}

const FRAME_MAX_AREA = 12_000_000;
function fitArea(img, maxArea) {
  const area = img.width * img.height;
  if (area <= maxArea) return img;
  const k = Math.sqrt(maxArea / area);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// ---------- 결과 화면 필름 강도 ----------
const reviewStrength = $('#reviewStrength');
function setReviewStrength(s) {
  reviewStrength.value = Math.round(s * 100);
  $('#reviewStrengthValue').textContent = Math.round(s * 100);
}
let strengthTimer;
reviewStrength.addEventListener('input', () => {
  if (!state.shot) return;
  state.shot.strength = reviewStrength.value / 100;
  $('#reviewStrengthValue').textContent = reviewStrength.value;
  clearTimeout(strengthTimer);
  strengthTimer = setTimeout(renderReview, 120);
});

// 표시 없음 → 날짜 → 정보 프레임
const stampBtn = $('#stampBtn');
function applyStampLabel() {
  $('#stampLabel').textContent = state.stamp.label;
  stampBtn.classList.toggle('on', state.stamp.id !== 'none');
}
stampBtn.addEventListener('click', async () => {
  state.stamp = STAMPS[(STAMPS.indexOf(state.stamp) + 1) % STAMPS.length];
  localStorage.setItem('stamp', state.stamp.id);
  applyStampLabel();
  updateFrameTools();
  if (state.shot) await renderReview();
});
applyStampLabel();

// ---------- 정보 프레임: 회전, 제목 ----------
function updateFrameTools() {
  $('#frameTools').hidden = state.stamp.id !== 'frame';
  $('#dateTools').hidden = state.stamp.id !== 'date';
  $('#timeBtn').classList.toggle('on', state.showTime);
  $('#timeBtn').setAttribute('aria-pressed', String(state.showTime));
  $('#titleLabel').textContent = state.title || '제목';
  $('#titleBtn').classList.toggle('on', !!state.title);
}

$('#timeBtn').addEventListener('click', async () => {
  state.showTime = !state.showTime;
  localStorage.setItem('stampTime', state.showTime ? 'on' : 'off');
  updateFrameTools();
  await renderReview();
});

$('#rotateBtn').addEventListener('click', async () => {
  state.rotation = (state.rotation + 270) % 360; // 아이콘(↺)처럼 반시계 방향
  await renderReview();
});

$('#titleBtn').addEventListener('click', async () => {
  // 아이폰 기본 입력 창을 그대로 쓴다
  const text = prompt('사진 아래에 넣을 제목', state.title);
  if (text === null) return;
  state.title = text.trim().slice(0, 40);
  updateFrameTools();
  await renderReview();
});

// 비교선: 사진 아무 데나 누르거나 끌면 그 위치로 선이 온다
function setComparePos(t) {
  compare.style.setProperty('--pos', `${Math.min(1, Math.max(0, t)) * 100}%`);
}
function dragCompare(e) {
  const r = compare.getBoundingClientRect();
  setComparePos((e.clientX - r.left) / r.width);
}
// 상단 토글: 비교선 켜고 끄기 (설정 기억)
const compareBtn = $('#compareBtn');
function applyCompareMode(on) {
  compare.classList.toggle('solo', !on);
  compareBtn.setAttribute('aria-pressed', String(on));
  localStorage.setItem('compare', on ? 'on' : 'off');
}
compareBtn.addEventListener('click', () => applyCompareMode(compare.classList.contains('solo')));
applyCompareMode(localStorage.getItem('compare') !== 'off');

let comparing = false;
compare.addEventListener('pointerdown', (e) => {
  if (compare.classList.contains('solo')) return;
  comparing = true;
  try { compare.setPointerCapture(e.pointerId); } catch {}
  dragCompare(e);
});
compare.addEventListener('pointermove', (e) => {
  if (comparing) dragCompare(e);
});
for (const ev of ['pointerup', 'pointercancel']) compare.addEventListener(ev, () => { comparing = false; });

const saveSheet = $('#saveSheet');
function setSaveSheet(open) {
  saveSheet.hidden = !open;
}
$('#saveBackdrop').addEventListener('click', () => setSaveSheet(false));

// discard: ✕(다시 찍기). 방금 찍은 사진이면 앨범에서도 지운다. 앨범에서 연 사진이면 앨범으로 돌아간다.
async function closeReview({ discard = false } = {}) {
  const shot = state.shot;
  review.hidden = true;
  if (shot && discard && !shot.fromAlbum) {
    await deleteShot(shot.id).catch(() => {});
  } else if (shot && state.out) {
    await updateShot(shot.id, { strength: shot.strength, thumb: await makeThumb(state.out.film) }).catch(() => {});
  }
  refreshThumb();
  if (!album.hidden) renderAlbum();
  if (state.mode === 'image') drawImage();
  if (!reloadIfUpdated()) ensureCamera();
}

$('#discardBtn').addEventListener('click', () => closeReview({ discard: true }));

$('#deleteBtn').addEventListener('click', async () => {
  if (!state.shot || !confirm('이 사진을 앨범에서 지울까요?')) return;
  await deleteShot(state.shot.id).catch(() => {});
  state.shot = null;
  review.hidden = true;
  refreshThumb();
  renderAlbum();
});
$('#saveBtn').addEventListener('click', () => {
  if (state.rendering || !state.out) return; // 바뀐 설정으로 아직 만드는 중
  setSaveSheet(true);
});
$('#saveCancel').addEventListener('click', () => setSaveSheet(false));
$('#saveFilmOnly').addEventListener('click', () => save(false));
$('#saveWithOriginal').addEventListener('click', () => save(true));

async function save(withOriginal) {
  const stamp = timeStamp();
  const files = [new File([state.out.film], `filmcam_${stamp}.jpg`, { type: 'image/jpeg' })];
  if (withOriginal) files.push(new File([state.out.original], `filmcam_${stamp}_original.jpg`, { type: 'image/jpeg' }));

  // 휴대폰: 공유 시트 → "이미지 저장"으로 사진 앱에 저장 (여러 장도 한 번에)
  if (isTouch && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      closeReview();
    } catch (e) {
      if (e.name !== 'AbortError') downloadAll(files);
    }
    return;
  }
  downloadAll(files);
  closeReview();
}

function downloadAll(files) {
  // 브라우저가 동시 다운로드를 막지 않도록 조금씩 띄워서 받는다
  files.forEach((file, i) => setTimeout(() => download(file), i * 400));
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function timeStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------- 앨범 · 최근 사진 썸네일 ----------
const album = $('#album');
const albumGrid = $('#albumGrid');

async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const k = 360 / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const t = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  release(c);
  return t;
}

let thumbUrl;
async function refreshThumb() {
  const latest = (await listShots().catch(() => []))[0];
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = latest?.thumb ? URL.createObjectURL(latest.thumb) : null;
  $('#thumbImg').hidden = !thumbUrl;
  $('#thumbIcon').style.display = thumbUrl ? 'none' : '';
  if (thumbUrl) $('#thumbImg').src = thumbUrl;
}

let cellUrls = [];
async function renderAlbum() {
  const shots = await listShots().catch(() => []);
  cellUrls.forEach((u) => URL.revokeObjectURL(u));
  cellUrls = [];
  albumGrid.replaceChildren(...shots.map((rec) => {
    const cell = document.createElement('button');
    cell.className = 'album-cell';
    const img = document.createElement('img');
    const url = URL.createObjectURL(rec.thumb ?? rec.film);
    cellUrls.push(url);
    img.src = url;
    img.alt = rec.meta?.film ?? '';
    cell.append(img);
    cell.addEventListener('click', () => openFromAlbum(rec.id));
    return cell;
  }));
  $('#albumEmpty').hidden = shots.length > 0;
  $('#albumCount').textContent = shots.length ? `${shots.length}장` : '';
}

async function openFromAlbum(id) {
  const rec = await getShot(id).catch(() => null);
  if (!rec) return renderAlbum();
  await showShot(rec.film, rec.original, rec.meta, { id: rec.id, strength: rec.strength ?? 1, fromAlbum: true });
}

$('#albumBtn').addEventListener('click', async () => {
  setDrawer(false);
  album.hidden = false;
  await renderAlbum();
});
$('#albumClose').addEventListener('click', () => {
  album.hidden = true;
  if (!reloadIfUpdated()) ensureCamera();
  if (state.mode === 'image') drawImage();
});
refreshThumb();

// ---------- 밝기 (화면을 위아래로 밀기) ----------
const exposure = $('#exposure');
let exposureTimer;
function setEV(v, { show = true } = {}) {
  v = Math.round(Math.min(2, Math.max(-2, v)) * 10) / 10;
  state.ev = v;
  exposure.style.setProperty('--sun-y', `${-v * 34}px`);
  if (show) {
    exposure.classList.add('on');
    clearTimeout(exposureTimer);
    exposureTimer = setTimeout(() => exposure.classList.remove('on'), 1200);
  }
  $('#evPill').hidden = v === 0;
  $('#evValue').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  if (state.mode === 'image') drawImage();
}
$('#evPill').addEventListener('click', () => setEV(0, { show: false }));

// ---------- 찍기 전 필름 강도 ----------
const strengthInput = $('#strength');
function applyStrength() {
  strengthInput.value = Math.round(state.strength * 100);
  $('#strengthValue').textContent = Math.round(state.strength * 100);
}
strengthInput.addEventListener('input', () => {
  state.strength = strengthInput.value / 100;
  localStorage.setItem('strength', strengthInput.value);
  $('#strengthValue').textContent = strengthInput.value;
  if (state.mode === 'image') drawImage();
});
applyStrength();

// ---------- 고화질 ----------
const hqBtn = $('#hqBtn');
function applyHq() {
  hqBtn.setAttribute('aria-pressed', String(state.hq));
  localStorage.setItem('hq', state.hq ? 'on' : 'off');
}
hqBtn.addEventListener('click', () => {
  state.hq = !state.hq;
  applyHq();
  if (!state.hq) toast('기본 화질');
  if (state.mode === 'camera') startCamera();
});
applyHq();

// ---------- 사진 비율 ----------
const ratioBtn = $('#ratioBtn');
function applyRatio() {
  ratioBtn.textContent = state.ratio.label;
  localStorage.setItem('ratio', state.ratio.label);
  if (state.mode === 'image') drawImage();
}
ratioBtn.addEventListener('click', () => {
  state.ratio = RATIOS[(RATIOS.indexOf(state.ratio) + 1) % RATIOS.length];
  applyRatio();
});
applyRatio();

// ---------- 격자 ----------
const gridBtn = $('#gridBtn');
function applyGrid() {
  $('#grid').hidden = !state.grid;
  gridBtn.setAttribute('aria-pressed', String(state.grid));
  localStorage.setItem('grid', state.grid ? 'on' : 'off');
}
gridBtn.addEventListener('click', () => {
  state.grid = !state.grid;
  applyGrid();
});
applyGrid();

// ---------- 플래시 ----------
// 후면: 손전등을 잠깐 켜고 찍는다 (지원하는 기기·브라우저만). 전면: 화면을 하얗게 밝혀 비춘다.
const flashBtn = $('#flashBtn');
const canFlash = () => state.mirror || state.torch;

function updateFlashBtn() {
  flashBtn.setAttribute('aria-pressed', String(state.flash && canFlash()));
  flashBtn.classList.toggle('unavailable', !canFlash());
}

flashBtn.addEventListener('click', () => {
  if (!canFlash()) {
    toast('이 브라우저에서는 후면 플래시를 켤 수 없어요. 전면 카메라에서는 화면 플래시를 쓸 수 있어요.');
    return;
  }
  state.flash = !state.flash;
  updateFlashBtn();
});

async function lightOn() {
  if (state.mirror) {
    const el = $('#screenFlash');
    el.classList.add('on');
    await sleep(450); // 카메라가 밝아진 화면에 노출을 맞출 시간
    return () => el.classList.remove('on');
  }
  const track = state.stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({ advanced: [{ torch: true }] });
  } catch {
    toast('플래시를 켜지 못했어요.');
    return null;
  }
  await sleep(700);
  return () => track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
}

// ---------- 기울기로 가로 촬영 ----------
// 화면은 세로로 고정된 채, 폰을 옆으로 눕히면 찍힌 사진을 가로로 돌린다.
// left: 폰 윗부분이 왼쪽으로 (반시계로 눕힘), right: 폰 윗부분이 오른쪽으로
let tilt = 'portrait';

function onOrientation(e) {
  const { beta, gamma } = e;
  if (beta == null || gamma == null) return;
  let next = tilt;
  // gamma > 0: 오른쪽 모서리가 내려감 = 시계 방향으로 눕힘 (윗부분이 오른쪽)
  if (Math.abs(gamma) > 55 && Math.abs(beta) < 50) next = gamma > 0 ? 'right' : 'left';
  else if (Math.abs(gamma) < 30 && Math.abs(beta) > 45) next = 'portrait';
  // 그 사이 각도이거나 폰을 바닥에 눕혔을 때는 이전 방향을 유지
  if (next === tilt) return;
  tilt = next;
  $('.app').dataset.tilt = tilt;
}

function captureRotation() {
  // 불러온 사진이나, 화면 자체가 가로로 돌아간 경우(영상도 이미 가로)는 돌리지 않는다
  if (state.mode !== 'camera' || matchMedia('(orientation: landscape)').matches) return 0;
  return tilt === 'left' ? 270 : tilt === 'right' ? 90 : 0;
}

(function enableTilt() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;
  const start = () => addEventListener('deviceorientation', onOrientation);
  if (typeof DOE.requestPermission === 'function') {
    // 아이폰은 사용자가 화면을 한 번 눌렀을 때만 센서 권한을 물어볼 수 있다
    document.addEventListener('click', () => {
      DOE.requestPermission().then((r) => r === 'granted' && start()).catch(() => {});
    }, { once: true });
  } else {
    start();
  }
})();

// ---------- 두 번 탭 확대 · 핀치 확대 막기 (iOS는 user-scalable=no 를 무시함) ----------
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// ---------- 시작 ----------
// ---------- 자동 업데이트 ----------
// 아이폰 홈 화면 앱은 내렸다 다시 열면 메모리에 있던 옛 버전을 그대로 이어 쓴다.
// 그래서 앱으로 돌아올 때마다 새 버전을 확인하고, 있으면 다시 불러온다.
// 단, 찍은 사진을 보고 있거나 불러온 사진을 편집 중이면 끝날 때까지 기다린다.
let updateReady = false;

function reloadIfUpdated() {
  if (!updateReady || !review.hidden || !album.hidden || state.capturing || state.mode !== 'camera') return false;
  location.reload();
  return true;
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller; // 처음 설치될 때는 다시 불러올 필요 없음
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    updateReady = true;
    reloadIfUpdated();
  });
}

startCamera();
loop();
