import { FilmRenderer, PRESETS } from './film.js';

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
  imageCanvas: null,
  shotBlob: null,
  shotUrl: null,
};

// ---------- 필름 선택 ----------
const presetNav = $('#presets');
for (const p of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'preset';
  btn.dataset.id = p.id;
  btn.textContent = p.label;
  btn.addEventListener('click', () => selectPreset(p));
  presetNav.append(btn);
}

function selectPreset(p) {
  state.preset = p;
  localStorage.setItem('preset', p.id);
  for (const b of presetNav.children) b.classList.toggle('active', b.dataset.id === p.id);
  if (state.mode === 'image') drawImage();
}
selectPreset(state.preset);

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
  const settings = state.stream.getVideoTracks()[0].getSettings();
  state.mirror = (settings.facingMode ?? state.facing) === 'user';
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  placeholder.hidden = true;
}

function loop() {
  requestAnimationFrame(loop);
  if (state.mode !== 'camera' || !state.stream || video.readyState < 2 || !review.hidden) return;
  renderer.upload(video, video.videoWidth, video.videoHeight);
  renderer.render(state.preset, { mirror: state.mirror, bypass: state.bypass });
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
  drawImage();
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
  renderer.render(state.preset, { bypass: state.bypass, seed: 0.5 });
}

closeImage.addEventListener('click', exitImageMode);

// ---------- 길게 눌러 원본과 비교 ----------
const viewfinder = $('#viewfinder');
function setBypass(on) {
  if (state.bypass === on) return;
  state.bypass = on;
  badge.classList.toggle('on', on);
  if (state.mode === 'image') drawImage();
}
viewfinder.addEventListener('pointerdown', (e) => {
  if (e.target === canvas) setBypass(true);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  viewfinder.addEventListener(ev, () => setBypass(false));
}

// ---------- 촬영 · 저장 ----------
shutter.addEventListener('click', async () => {
  if (state.mode === 'camera' && (!state.stream || video.readyState < 2)) return;

  if (state.mode === 'camera') {
    const flash = $('#flash');
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    renderer.upload(video, video.videoWidth, video.videoHeight);
    renderer.render(state.preset, { mirror: state.mirror });
  } else {
    renderer.render(state.preset, { seed: 0.5 });
  }

  const blob = await renderer.toBlob();
  if (!blob) return;
  state.shotBlob = blob;
  if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
  state.shotUrl = URL.createObjectURL(blob);
  reviewImg.src = state.shotUrl;
  review.hidden = false;
});

function closeReview() {
  review.hidden = true;
  if (state.mode === 'image') drawImage();
}

$('#discardBtn').addEventListener('click', closeReview);

$('#saveBtn').addEventListener('click', async () => {
  const file = new File([state.shotBlob], fileName(), { type: 'image/jpeg' });

  // 휴대폰: 공유 시트 → "이미지 저장"으로 사진 앱에 저장
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      closeReview();
    } catch (e) {
      if (e.name !== 'AbortError') download(file);
    }
    return;
  }
  download(file);
  closeReview();
});

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `filmcam_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

// ---------- 시작 ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

startCamera();
loop();
