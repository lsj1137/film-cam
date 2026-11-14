import { FilmRenderer, PRESETS } from './film.js';
import { STAMPS, compose, framePad } from './stamp.js';
import { withExif } from './exif.js';

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

const MAX_IMAGE_SIDE = 4096;
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
  out: null,          // 저장할 최종 파일 { film, original }
  zoom: 1,
  nativeZoom: null,   // 카메라 자체 줌 범위 {min, max} (지원할 때만)
  imageCanvas: null,
  shotBlob: null,
  shotUrl: null,
};

// ---------- 필름 선택: 쉐브론으로 여닫는 가로 캐러셀 ----------
const filmDrawer = $('#filmDrawer');
const filmToggle = $('#filmToggle');
const carousel = $('#filmCarousel');
for (const p of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'film-item';
  btn.role = 'option';
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

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    showPlaceholder('카메라는 https 주소에서만 쓸 수 있어요. 사진 불러오기는 지금도 쓸 수 있어요.', false);
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
  } catch (e) {
    const denied = e.name === 'NotAllowedError';
    showPlaceholder(denied
      ? '카메라 권한이 꺼져 있어요. 설정에서 허용한 뒤 다시 눌러 주세요.'
      : '카메라를 찾지 못했어요. 사진 불러오기로 색감을 먼저 써 볼 수 있어요.');
    return;
  }
  const track = state.stream.getVideoTracks()[0];
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
}

function loop() {
  requestAnimationFrame(loop);
  if (state.mode !== 'camera' || !state.stream || video.readyState < 2 || !review.hidden || state.capturing) return;
  renderer.upload(video, video.videoWidth, video.videoHeight);
  renderer.render(state.preset, { mirror: state.mirror, bypass: state.bypass, ratio: state.ratio.value, zoom: digitalZoom() });
  syncFrame();
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

// 앱을 내리면 카메라를 끄고, 돌아오면 다시 켠다
document.addEventListener('visibilitychange', () => {
  if (state.mode !== 'camera') return;
  if (document.hidden) stopCamera();
  else startCamera();
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
  startCamera();
}

function drawImage() {
  renderer.render(state.preset, { bypass: state.bypass, seed: 0.5, ratio: state.ratio.value, zoom: digitalZoom() });
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
  if (pinch && pointers.size >= 2) setZoom(pinch.zoom * pinchDistance() / pinch.distance);
  else if (Math.hypot(p.x - p.x0, p.y - p.y0) > 10) clearTimeout(holdTimer);
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
  shutter.classList.add('busy');
  try {
    const opts = { ratio: state.ratio.value, zoom: digitalZoom() };
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
      ratio: state.ratio.label,
      camera: state.mode === 'camera' ? (state.mirror ? '전면' : '후면') : '',
    };
    if (film && original) await showShot(film, original, meta);
  } finally {
    state.capturing = false;
    shutter.classList.remove('busy');
  }
});

const compare = $('#compare');
const originalImg = $('#originalImg');

async function showShot(film, original, meta) {
  const [filmBmp, originalBmp] = await Promise.all([createImageBitmap(film), createImageBitmap(original)]);
  state.shot = { film, original, filmBmp, originalBmp, meta };
  await renderReview();
  setComparePos(0.5);
  setSaveSheet(false);
  review.hidden = false;
}

// 날짜·정보 표시를 적용한 최종 파일을 만들고 미리보기에 띄운다.
// 저장 버튼을 누른 뒤에 만들면 아이폰 공유 시트가 막힐 수 있어서 미리 만들어 둔다.
async function renderReview() {
  const { film, original, filmBmp, originalBmp, meta } = state.shot;
  const style = state.stamp.id;
  const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  let filmOut = film;
  let originalOut = original;
  let ar = filmBmp.width / filmBmp.height;
  let inset = ['0px', '0px'];
  if (style !== 'none') {
    const fc = compose(filmBmp, style, meta);
    const oc = compose(originalBmp, style, meta);
    [filmOut, originalOut] = await Promise.all([toBlob(fc), toBlob(oc)]);
    ar = fc.width / fc.height;
    if (style === 'frame') {
      const pad = framePad(filmBmp.width, filmBmp.height);
      inset = [`${(pad / fc.width) * 100}%`, `${(pad / fc.height) * 100}%`];
    }
  }
  compare.style.setProperty('--inset-x', inset[0]);
  compare.style.setProperty('--inset-y', inset[1]);
  [filmOut, originalOut] = await Promise.all([
    withExif(filmOut, { date: meta.date, description: `FilmCam ${meta.filmId}` }),
    withExif(originalOut, { date: meta.date, description: 'FilmCam original' }),
  ]);
  state.out = { film: filmOut, original: originalOut };

  if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
  if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
  state.shotUrl = URL.createObjectURL(filmOut);
  state.originalUrl = URL.createObjectURL(originalOut);
  reviewImg.src = state.shotUrl;
  originalImg.src = state.originalUrl;
  compare.style.setProperty('--ar', ar);
}

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
  if (state.shot) await renderReview();
});
applyStampLabel();

// 비교선: 사진 아무 데나 누르거나 끌면 그 위치로 선이 온다
function setComparePos(t) {
  compare.style.setProperty('--pos', `${Math.min(1, Math.max(0, t)) * 100}%`);
}
function dragCompare(e) {
  const r = compare.getBoundingClientRect();
  setComparePos((e.clientX - r.left) / r.width);
}
let comparing = false;
compare.addEventListener('pointerdown', (e) => {
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

function closeReview() {
  review.hidden = true;
  if (state.mode === 'image') drawImage();
}

$('#discardBtn').addEventListener('click', closeReview);
$('#saveBtn').addEventListener('click', () => setSaveSheet(true));
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

// ---------- 두 번 탭 확대 · 핀치 확대 막기 (iOS는 user-scalable=no 를 무시함) ----------
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// ---------- 시작 ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

startCamera();
loop();
