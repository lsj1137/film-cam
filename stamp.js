// 사진에 날짜 스탬프나 정보 프레임을 그려 넣는다 (2D 캔버스)

export const STAMPS = [
  { id: 'none', label: '표시 없음' },
  { id: 'date', label: '날짜' },
  { id: 'frame', label: '정보 프레임' },
];

// meta: { date, film, zoom, title }
export function compose(bitmap, style, meta) {
  const w = bitmap.width;
  const h = bitmap.height;
  const c = document.createElement('canvas');

  if (style === 'frame') {
    drawFrame(c, bitmap, meta);
    return c;
  }

  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (style === 'date') drawDateStamp(ctx, w, h, meta.date);
  return c;
}

// ---------- 날짜 스탬프: 필름 카메라가 찍어 주던 주황색 7세그먼트 숫자 ----------
const DIGITS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

function drawDateStamp(ctx, w, h, date) {
  const short = Math.min(w, h);
  const dh = short * 0.042;         // 숫자 높이
  const dw = dh * 0.52;             // 숫자 폭
  const gap = dh * 0.2;
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const text = `'${yy} ${mm} ${dd}`;

  const advance = (ch) => (ch === "'" ? dh * 0.22 : ch === ' ' ? dh * 0.42 : dw + gap);
  const total = [...text].reduce((s, ch) => s + advance(ch), 0) - gap;
  const margin = short * 0.055;
  let x = w - margin - total;
  const y = h - margin - dh;

  ctx.save();
  // 빛으로 필름에 새긴 느낌: 밝게 더하고 주변이 은은하게 번지게
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgb(255, 136, 40)';
  ctx.shadowColor = 'rgba(255, 96, 20, 0.9)';
  ctx.shadowBlur = dh * 0.45;
  ctx.globalAlpha = 0.9;
  for (const ch of text) {
    if (ch === "'") drawSegmentBar(ctx, x + dh * 0.04, y, dh * 0.1, dh * 0.3);
    else if (ch !== ' ') drawDigit(ctx, DIGITS[ch], x, y, dw, dh);
    x += advance(ch);
  }
  ctx.restore();
}

function drawDigit(ctx, segs, x, y, w, h) {
  const t = h * 0.13;    // 획 두께
  const g = t * 0.35;    // 획 사이 틈
  const half = h / 2;
  const skew = h * 0.08; // 살짝 기울임
  const sx = (px, py) => x + px + skew * (1 - py / h);
  const hSeg = (py) => hexagon(ctx, [
    [sx(g, py), y + py], [sx(g + t / 2, py - t / 2), y + py - t / 2],
    [sx(w - g - t / 2, py - t / 2), y + py - t / 2], [sx(w - g, py), y + py],
    [sx(w - g - t / 2, py + t / 2), y + py + t / 2], [sx(g + t / 2, py + t / 2), y + py + t / 2],
  ]);
  const vSeg = (px, py0, py1) => hexagon(ctx, [
    [sx(px, py0 + g), y + py0 + g], [sx(px + t / 2, py0 + g + t / 2), y + py0 + g + t / 2],
    [sx(px + t / 2, py1 - g - t / 2), y + py1 - g - t / 2], [sx(px, py1 - g), y + py1 - g],
    [sx(px - t / 2, py1 - g - t / 2), y + py1 - g - t / 2], [sx(px - t / 2, py0 + g + t / 2), y + py0 + g + t / 2],
  ]);
  const draw = {
    a: () => hSeg(0), g: () => hSeg(half), d: () => hSeg(h),
    f: () => vSeg(0, 0, half), b: () => vSeg(w, 0, half),
    e: () => vSeg(0, half, h), c: () => vSeg(w, half, h),
  };
  for (const s of segs) draw[s]();
}

function drawSegmentBar(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, w / 2);
  ctx.fill();
}

function hexagon(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fill();
}

// ---------- 정보 프레임: 사진 아래 흰 여백에 필름·날짜·설정 ----------
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

// 프레임 여백(px). 미리보기에서 '필름/원본' 표시를 사진 안쪽으로 옮길 때도 쓴다.
export const framePad = (w, h) => Math.round(Math.min(w, h) * 0.035);

function drawFrame(c, bitmap, meta) {
  const w = bitmap.width;
  const h = bitmap.height;
  const base = Math.min(w, h);
  const pad = framePad(w, h);
  const bottom = Math.round(base * 0.16);
  c.width = w + pad * 2;
  c.height = h + pad + bottom;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#f5f2ec';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, pad, pad);

  const cy = h + pad + bottom / 2;
  const left = pad + base * 0.01;
  const right = c.width - pad - base * 0.01;
  const d = meta.date;
  const pad2 = (n) => String(n).padStart(2, '0');

  ctx.textBaseline = 'alphabetic';
  // 왼쪽: 제목(있으면) 또는 필름 이름, 아래에 작게 필름 이름·앱 이름
  const title = meta.title?.trim();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1b19';
  ctx.fillText(fitText(ctx, title || meta.film, 600, base * 0.045, (right - left) * 0.62), left, cy + base * 0.004);
  ctx.fillStyle = '#8a847c';
  ctx.font = `500 ${base * 0.024}px ${FONT}`;
  ctx.letterSpacing = `${base * 0.004}px`;
  ctx.fillText(title ? `${meta.film}  ·  FILMCAM` : 'FILMCAM', left, cy + base * 0.042);
  ctx.letterSpacing = '0px';

  // 오른쪽: 촬영 날짜, 아래에 시간 (줌했으면 배율도)
  ctx.textAlign = 'right';
  ctx.fillStyle = '#1d1b19';
  ctx.font = `500 ${base * 0.032}px ${FONT}`;
  ctx.fillText(`${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`, right, cy + base * 0.002);
  ctx.fillStyle = '#8a847c';
  ctx.font = `500 ${base * 0.024}px ${FONT}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  ctx.fillText(meta.zoom > 1 ? `${time}  ·  ${meta.zoom}×` : time, right, cy + base * 0.042);
}

// 긴 제목은 글자를 줄이고, 그래도 넘치면 뒤를 말줄임
function fitText(ctx, text, weight, size, maxWidth) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && s > size * 0.7) {
    s *= 0.94;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

// 사진을 90° 단위로 돌린다
export function rotate(bitmap, deg) {
  if (!deg) return bitmap;
  const swap = deg % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? bitmap.height : bitmap.width;
  c.height = swap ? bitmap.width : bitmap.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return c;
}
