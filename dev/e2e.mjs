// 필름캠 전체 동작 점검: 헤드리스 Chrome + 가짜 카메라로 주요 기능을 차례로 확인한다.
// 사용: node dev/e2e.mjs [주소]   (기본 http://localhost:8731/ — 먼저 python -m http.server 8731)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] ?? 'http://localhost:8731/';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--window-size=500,900',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fc-e2e-'))}`, 'about:blank']);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(3500);

// 페이지 안에서 쓸 도우미
await run(`
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 오류 알림창이 뜨면 헤드리스에서 멈추므로 기록만 한다
  window.alert = (m) => console.error('alert: ' + m);
  window.T = {
    q, sleep,
    downloads: [],
    async waitReview() { for (let i = 0; i < 60 && q('#review').hidden; i++) await sleep(150); await sleep(200); return !q('#review').hidden; },
    async inspect(href) {
      const b = await (await fetch(href)).blob();
      const bytes = new Uint8Array(await b.arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes.subarray(0, 600));
      const bm = await createImageBitmap(b);
      const oc = new OffscreenCanvas(1, 1); oc.getContext('2d').drawImage(bm, bm.width / 2, bm.height / 2, 1, 1, 0, 0, 1, 1);
      const px = [...oc.getContext('2d').getImageData(0, 0, 1, 1).data.slice(0, 3)];
      return { px, w: bm.width, h: bm.height, exif: text.includes('Exif'), date: (text.match(/\\d{4}:\\d\\d:\\d\\d \\d\\d:\\d\\d:\\d\\d/) || [null])[0] };
    },
    async save(withOriginal) {
      T.downloads = [];
      HTMLAnchorElement.prototype.click = function () { T.downloads.push(T.inspect(this.href)); };
      q('#saveBtn').click(); await sleep(100);
      const sheet = !q('#saveSheet').hidden;
      q(withOriginal ? '#saveWithOriginal' : '#saveFilmOnly').click();
      await sleep(1200);
      return { sheet, files: await Promise.all(T.downloads), closed: q('#review').hidden };
    },
    async loadImage(path, w, h, date) {
      let blob;
      // 실서버에는 dev/ 가 없으니 못 받으면 같은 크기(900×1200)로 만들어 쓴다
      const res = path ? await fetch(path).catch(() => null) : null;
      if (res?.ok) blob = await res.blob();
      else {
        if (path) { w = 900; h = 1200; } const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = '#7a6'; x.fillRect(0, 0, w, h); blob = await c.convertToBlob({ type: 'image/jpeg' }); }
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 't.jpg', { type: 'image/jpeg', lastModified: date ?? Date.now() }));
      const input = q('#fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change'));
      await sleep(1000);
    },
  };
  return true;
`);

const results = [];
async function test(name, body, check) {
  let value, ok, err;
  try {
    value = await run(body);
    ok = check(value);
  } catch (e) {
    ok = false;
    err = e.message.split('\n')[0];
  }
  results.push({ name, ok, value: err ?? value });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      → ${JSON.stringify(err ?? value)}`}`);
}

// ---------- 테스트 ----------
await test('카메라 미리보기가 그려짐', `
  const c = T.q('#view'); const g = c.getContext('webgl'); const px = new Uint8Array(4);
  g.readPixels(c.width >> 1, c.height >> 1, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
  return { size: c.width + 'x' + c.height, px: [...px] };
`, (v) => v.size === '1920x1440' && v.px[0] + v.px[1] + v.px[2] > 30);

await test('비율 3:4 → 1:1 → 9:16 → 3:4', `
  const sizes = [];
  for (let i = 0; i < 4; i++) { await T.sleep(600); sizes.push(T.q('#ratioBtn').textContent + '=' + T.q('#view').width + 'x' + T.q('#view').height); if (i < 3) T.q('#ratioBtn').click(); }
  return sizes;
`, (v) => v.join() === '3:4=1920x1440,1:1=1440x1440,9:16=1920x1080,3:4=1920x1440');

await test('격자 켜고 끄기', `
  T.q('#gridBtn').click(); const on = !T.q('#grid').hidden;
  T.q('#gridBtn').click(); const off = T.q('#grid').hidden;
  return { on, off };
`, (v) => v.on && v.off);

await test('필름 캐러셀: 열기, 눌러서 선택, 닫기', `
  T.q('#filmToggle').click(); await T.sleep(300);
  const open = T.q('#filmDrawer').classList.contains('open');
  T.q('#filmCarousel').children[3].click(); await T.sleep(700);
  const selected = T.q('#filmCarousel [aria-selected="true"]').textContent;
  T.q('#filmToggle').click();
  return { open, selected, saved: localStorage.getItem('preset'), closed: !T.q('#filmDrawer').classList.contains('open') };
`, (v) => v.open && v.selected === '밤거리' && v.saved === 'yoru' && v.closed);

await test('핀치 줌, 줌 버튼, 길게 눌러 원본 비교', `
  const c = T.q('#view');
  const ev = (t, id, x) => c.dispatchEvent(new PointerEvent(t, { pointerId: id, clientX: x, clientY: 300, bubbles: true }));
  ev('pointerdown', 1, 200); ev('pointerdown', 2, 300); ev('pointermove', 2, 450); await T.sleep(300);
  const pinch = T.q('#zoomBtn').textContent; const badgeDuringPinch = T.q('#badge').classList.contains('on');
  ev('pointerup', 2, 450); ev('pointerup', 1, 200);
  T.q('#zoomBtn').click(); const reset = T.q('#zoomBtn').textContent;
  ev('pointerdown', 3, 250); await T.sleep(400); const hold = T.q('#badge').textContent + ':' + T.q('#badge').classList.contains('on');
  ev('pointerup', 3, 250); await T.sleep(50); const released = !T.q('#badge').classList.contains('on');
  return { pinch, badgeDuringPinch, reset, hold, released };
`, (v) => v.pinch === '2.5×' && !v.badgeDuringPinch && v.reset === '1×' && v.hold === '원본:true' && v.released);

await test('후면 플래시 미지원 안내', `
  T.q('#flashBtn').click(); await T.sleep(100);
  return { unavailable: T.q('#flashBtn').classList.contains('unavailable'), toast: T.q('#toast').textContent };
`, (v) => v.unavailable && v.toast.includes('후면 플래시'));

await test('촬영 → 결과 화면 (비교선, 가운데 정렬)', `
  T.q('#shutter').click();
  const open = await T.waitReview();
  const mid = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); };
  return { open, ar: T.q('#compare').style.getPropertyValue('--ar'), centered: mid(T.q('#stampBtn')) === Math.round(innerWidth / 2), pos: T.q('#compare').style.getPropertyValue('--pos') };
`, (v) => v.open && Math.abs(Number(v.ar) - 4 / 3) < 0.01 && v.centered && v.pos === '50%');

await test('비교선 끌기, 끄고 켜기', `
  const c = T.q('#compare'); const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, clientX: r.left + r.width * 0.3, clientY: r.top + 10, bubbles: true }));
  c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, bubbles: true }));
  const pos = c.style.getPropertyValue('--pos');
  T.q('#compareBtn').click(); const solo = c.classList.contains('solo') && getComputedStyle(T.q('.compare-line')).display === 'none';
  T.q('#compareBtn').click(); const back = !c.classList.contains('solo');
  return { pos, solo, back };
`, (v) => v.pos.startsWith('30') && v.solo && v.back);

await test('저장: 필름만 → 1장, EXIF 촬영일 포함', `return await T.save(false);`,
  (v) => v.sheet && v.closed && v.files.length === 1 && v.files[0].exif && v.files[0].date && v.files[0].w === 1920);

await test('저장: 원본도 함께 → 2장', `
  T.q('#shutter').click(); await T.waitReview();
  return await T.save(true);
`, (v) => v.files.length === 2 && v.files.every((f) => f.exif && f.w === 1920 && f.h === 1440));

await test('날짜 스탬프 + 시간 표시 (크기 그대로)', `
  T.q('#shutter').click(); await T.waitReview();
  T.q('#stampBtn').click(); await T.sleep(1200);
  const label = T.q('#stampLabel').textContent; const dateTools = !T.q('#dateTools').hidden;
  T.q('#timeBtn').click(); await T.sleep(1200);
  const timeOn = T.q('#timeBtn').classList.contains('on');
  const r = await T.save(false);
  return { label, dateTools, timeOn, file: r.files[0] };
`, (v) => v.label === '날짜' && v.dateTools && v.timeOn && v.file.w === 1920 && v.file.h === 1440);

await test('정보 프레임 + 회전 + 제목', `
  T.q('#shutter').click(); await T.waitReview();
  T.q('#stampBtn').click(); await T.sleep(1500);
  const label = T.q('#stampLabel').textContent; const tools = !T.q('#frameTools').hidden;
  T.q('#rotateBtn').click(); await T.sleep(1500);
  window.prompt = () => '테스트 제목';
  T.q('#titleBtn').click(); await T.sleep(1500);
  const r = await T.save(false);
  return { label, tools, title: T.q('#titleLabel').textContent, file: r.files[0] };
`, (v) => v.label === '정보 프레임' && v.tools && v.title === '테스트 제목' && v.file.h > v.file.w && v.file.w > 1440);

await test('버튼 빠르게 연타해도 마지막 설정으로 저장됨', `
  T.q('#shutter').click(); await T.waitReview();
  // 지금 정보 프레임 → 3번 누르면 표시 없음 → 날짜 → 정보 프레임 → 한 번 더: 표시 없음
  for (let i = 0; i < 4; i++) T.q('#stampBtn').click();
  const blockedWhileBusy = (T.q('#saveBtn').click(), T.q('#saveSheet').hidden);
  await T.sleep(2500);
  const r = await T.save(false);
  return { label: T.q('#stampLabel').textContent, blockedWhileBusy, file: r.files[0] };
`, (v) => v.label === '표시 없음' && v.blockedWhileBusy && v.file.w === 1920 && v.file.h === 1440);

await test('기울이면 가로 사진', `
  window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 5, gamma: -80 }));
  await T.sleep(200);
  const tilt = T.q('.app').dataset.tilt;
  T.q('#shutter').click(); await T.waitReview();
  const r = await T.save(false);
  window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 85, gamma: 0 }));
  await T.sleep(100);
  return { tilt, file: r.files[0], back: T.q('.app').dataset.tilt };
`, (v) => v.tilt === 'left' && v.file.w === 1440 && v.file.h === 1920 && v.back === 'portrait');

await test('9:16 전체화면', `
  while (T.q('#ratioBtn').textContent !== '9:16') { T.q('#ratioBtn').click(); await T.sleep(150); }
  await T.sleep(300);
  // 가짜 카메라는 가로 영상이라 결과도 가로 → 전체화면이 아니어야 정상
  const landscapeFull = T.q('.app').classList.contains('full');
  while (T.q('#ratioBtn').textContent !== '3:4') { T.q('#ratioBtn').click(); await T.sleep(150); }
  return { landscapeFull };
`, (v) => v.landscapeFull === false);

await test('사진 불러오기: 파일 날짜가 EXIF로', `
  await T.loadImage('dev/test-night.jpg', 0, 0, new Date(2026, 10, 3, 21, 15, 0).getTime());
  const mode = T.q('#closeImage').hidden ? 'camera' : 'image';
  while (T.q('#ratioBtn').textContent !== '3:4') { T.q('#ratioBtn').click(); await T.sleep(150); }
  T.q('#shutter').click(); await T.waitReview();
  const r = await T.save(false);
  return { mode, file: r.files[0] };
`, (v) => v.mode === 'image' && v.file.date === '2026:11:03 21:15:00' && v.file.w === 900);

await test('큰 사진(6000×4500)은 3200으로 줄여서 처리, 정보 프레임도 OK', `
  await T.loadImage(null, 6000, 4500);
  while (T.q('#ratioBtn').textContent !== '1:1') { T.q('#ratioBtn').click(); await T.sleep(150); }
  const view = T.q('#view').width + 'x' + T.q('#view').height;
  T.q('#shutter').click(); await T.waitReview();
  while (T.q('#stampLabel').textContent !== '정보 프레임') { T.q('#stampBtn').click(); await T.sleep(1500); }
  const r = await T.save(false);
  while (T.q('#ratioBtn').textContent !== '3:4') { T.q('#ratioBtn').click(); await T.sleep(150); }
  while (T.q('#stampLabel').textContent !== '표시 없음') { T.q('#stampBtn').click(); await T.sleep(800); }
  return { view, file: r.files[0], area: r.files[0].w * r.files[0].h };
`, (v) => v.view === '2048x2048' && v.file.w === 2568 && v.area < 16_700_000);

await test('카메라로 돌아가기 + 전면 화면 플래시 촬영', `
  T.q('#closeImage').click(); await T.sleep(1500);
  T.q('#flipBtn').click(); await T.sleep(1500);
  const front = !T.q('#flashBtn').classList.contains('unavailable');
  T.q('#flashBtn').click();
  T.q('#shutter').click(); await T.sleep(200);
  const white = T.q('#screenFlash').classList.contains('on');
  const open = await T.waitReview();
  T.q('#discardBtn').click();
  return { front, white, open, whiteAfter: T.q('#screenFlash').classList.contains('on') };
`, (v) => v.front && v.white && v.open && !v.whiteAfter);

await test('결과 화면 보는 사이 카메라가 끊겨도, 돌아오면 다시 켜짐', `
  T.q('#shutter').click(); await T.waitReview();
  // 아이폰 기본 창(제목 입력·공유 시트)이 카메라를 끊은 상황을 흉내
  const old = T.q('#video').srcObject.getVideoTracks()[0];
  old.stop(); old.dispatchEvent(new Event('ended'));
  await T.sleep(300);
  T.q('#discardBtn').click(); await T.sleep(2500);
  const track = T.q('#video').srcObject?.getVideoTracks()[0];
  const t0 = T.q('#video').currentTime; await T.sleep(600);
  return { newTrack: track && track !== old, live: track?.readyState, moving: T.q('#video').currentTime > t0 };
`, (v) => v.newTrack && v.live === 'live' && v.moving);

await test('카메라 화면에서 영상이 멈추면 저절로 복구', `
  T.q('#video').pause();
  const t0 = T.q('#video').currentTime;
  await T.sleep(3500);
  return { paused: T.q('#video').paused, moving: T.q('#video').currentTime > t0 };
`, (v) => !v.paused && v.moving);

await test('앱을 잠깐 내렸다 돌아와도 카메라를 다시 요청하지 않음 (권한 재질문 방지)', `
  let calls = 0;
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => { calls++; return orig(c); };
  const before = T.q('#video').srcObject.getVideoTracks()[0];
  const setHidden = (h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); };
  setHidden(true); await T.sleep(500); setHidden(false); await T.sleep(800);
  const quickSwitch = { calls, sameTrack: T.q('#video').srcObject?.getVideoTracks()[0] === before };
  // 아이폰이 그사이 카메라를 끊었다면 그때만 다시 요청
  before.stop();
  setHidden(true); await T.sleep(200); setHidden(false); await T.sleep(1500);
  const afterCut = { calls, live: T.q('#video').srcObject?.getVideoTracks()[0]?.readyState };
  delete document.hidden;
  navigator.mediaDevices.getUserMedia = orig;
  return { quickSwitch, afterCut };
`, (v) => v.quickSwitch.calls === 0 && v.quickSwitch.sameTrack && v.afterCut.calls === 1 && v.afterCut.live === 'live');

await test('찍기 전 필름 강도 0% → 필름 사진이 원본과 같음, 찍은 뒤 100%로 올리면 달라짐', `
  T.q('#filmToggle').click(); await T.sleep(300);
  const s = T.q('#strength'); s.value = 0; s.dispatchEvent(new Event('input'));
  T.q('#filmToggle').click();
  T.q('#shutter').click(); await T.waitReview(); await T.sleep(300);
  const at0 = T.q('#reviewStrength').value;
  const r0 = await T.save(true);
  const diff = (a, b) => Math.max(...a.px.map((x, i) => Math.abs(x - b.px[i])));
  T.q('#shutter').click(); await T.waitReview();
  const rs = T.q('#reviewStrength'); rs.value = 100; rs.dispatchEvent(new Event('input')); await T.sleep(1200);
  const r1 = await T.save(true);
  s.value = 100; s.dispatchEvent(new Event('input'));
  return { at0, same0: diff(r0.files[0], r0.files[1]), diff100: diff(r1.files[0], r1.files[1]), saved: localStorage.getItem('strength') };
`, (v) => v.at0 === '0' && v.same0 <= 6 && v.diff100 > 10 && v.saved === '100');

await test('밝기: 위로 밀면 밝아지고, 값 표시를 누르면 0으로', `
  const c = T.q('#view'), g = c.getContext('webgl');
  // 한 점은 이미 최대 밝기일 수 있어서, 화면 9×9 지점의 평균으로 비교
  const lum = () => { let sum = 0; const px = new Uint8Array(4); for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) { g.readPixels(Math.round(c.width * i / 10), Math.round(c.height * j / 10), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); sum += px[0] + px[1] + px[2]; } return sum / 81; };
  await T.sleep(300); const before = lum();
  const ev = (t, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 11, clientX: 250, clientY: y, bubbles: true }));
  ev('pointerdown', 400); ev('pointermove', 385); ev('pointermove', 300); ev('pointermove', 225); ev('pointerup', 225);
  await T.sleep(300);
  const pill = T.q('#evPill'), value = T.q('#evValue').textContent, after = lum();
  pill.click(); await T.sleep(100);
  return { value, brighter: after > before + 15, pillShown: true, reset: T.q('#evPill').hidden };
`, (v) => v.value === '+1.0' && v.brighter && v.reset);

await test('앨범: 썸네일, 목록, 다시 열어 강도 바꾸기, 삭제', `
  T.q('#shutter').click(); await T.waitReview(); await T.sleep(500);
  T.q('#saveBtn').click(); await T.sleep(100); HTMLAnchorElement.prototype.click = () => {}; T.q('#saveFilmOnly').click(); await T.sleep(1200);
  const thumb = !T.q('#thumbImg').hidden && T.q('#thumbImg').naturalWidth > 0;
  T.q('#albumBtn').click(); await T.sleep(800);
  const count = T.q('#albumGrid').children.length;
  T.q('#albumGrid').children[0].click(); await T.waitReview();
  const fromAlbum = !T.q('#deleteBtn').hidden;
  const rs = T.q('#reviewStrength'); rs.value = 40; rs.dispatchEvent(new Event('input')); await T.sleep(1200);
  T.q('#discardBtn').click(); await T.sleep(1000);
  const backToAlbum = !T.q('#album').hidden && T.q('#review').hidden && T.q('#albumGrid').children.length === count;
  T.q('#albumGrid').children[0].click(); await T.waitReview();
  const keptStrength = T.q('#reviewStrength').value;
  window.confirm = () => true;
  T.q('#deleteBtn').click(); await T.sleep(1000);
  const afterDelete = T.q('#albumGrid').children.length;
  T.q('#albumClose').click(); await T.sleep(1500);
  const cameraBack = T.q('#album').hidden && !T.q('#video').paused;
  return { thumb, count, fromAlbum, backToAlbum, keptStrength, afterDelete, cameraBack };
`, (v) => v.thumb && v.count >= 1 && v.fromAlbum && v.backToAlbum && v.keptStrength === '40' && v.afterDelete === v.count - 1 && v.cameraBack);

await test('다시 찍기(✕)는 방금 찍은 사진을 앨범에서 지움', `
  T.q('#albumBtn').click(); await T.sleep(600); const before = T.q('#albumGrid').children.length; T.q('#albumClose').click(); await T.sleep(1200);
  T.q('#shutter').click(); await T.waitReview(); await T.sleep(600);
  T.q('#discardBtn').click(); await T.sleep(1000);
  T.q('#albumBtn').click(); await T.sleep(600); const after = T.q('#albumGrid').children.length; T.q('#albumClose').click(); await T.sleep(1200);
  return { before, after };
`, (v) => v.before === v.after);

await test('고화질 켜고 끄기 (기본은 꺼짐)', `
  const defaultOff = T.q('#hqBtn').getAttribute('aria-pressed') === 'false';
  T.q('#hqBtn').click(); await T.sleep(2000);
  const on = T.q('#hqBtn').getAttribute('aria-pressed') === 'true' && localStorage.getItem('hq') === 'on';
  const toastText = T.q('#toast').textContent;
  const t0 = T.q('#video').currentTime; await T.sleep(500); const live = T.q('#video').currentTime > t0;
  T.q('#hqBtn').click(); await T.sleep(1500);
  return { defaultOff, on, toastText, live, off: localStorage.getItem('hq') === 'off' };
`, (v) => v.defaultOff && v.on && v.toastText.startsWith('고화질') && v.live && v.off);

await test('서비스 워커 등록 (오프라인·홈 화면 앱)', `
  const reg = await navigator.serviceWorker.getRegistration();
  return { registered: !!reg };
`, (v) => v.registered);

// ---------- 결과 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (pageErrors.length) {
  console.log(`\n페이지 오류 ${pageErrors.length}건:`);
  for (const e of [...new Set(pageErrors)]) console.log('  - ' + e.split('\n')[0]);
}
chrome.kill();
process.exit(failed.length || pageErrors.length ? 1 : 0);
