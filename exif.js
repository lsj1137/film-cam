// JPEG에 최소한의 EXIF(촬영 일시, 카메라·필름 정보)를 넣는다.
// 캔버스로 만든 JPEG에는 EXIF가 없어서, 사진 앱이 촬영일을 저장한 시각으로 잡는 걸 막기 위함.

const ASCII = 2;
const LONG = 4;

export async function withExif(blob, { date, description }) {
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return blob;

  const stamp = exifDate(date);
  const tiff = buildTiff(
    [
      ascii(0x010e, description),       // ImageDescription
      ascii(0x010f, 'Film Camera'),     // Make
      ascii(0x0110, 'Film Camera Web'), // Model
      ascii(0x0131, 'Film Camera'),     // Software
      ascii(0x0132, stamp),             // DateTime
      { tag: 0x8769, type: LONG, value: 0 }, // Exif IFD 위치 (아래에서 채움)
    ],
    [
      ascii(0x9003, stamp),             // DateTimeOriginal
      ascii(0x9004, stamp),             // DateTimeDigitized
      ascii(0x9011, offsetText(date)),  // OffsetTimeOriginal (시간대)
    ],
  );

  const app1 = new Uint8Array(4 + 6 + tiff.length);
  app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 0xff]);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  app1.set(tiff, 10);

  // 캔버스 JPEG의 JFIF(APP0) 구간은 빼고 SOI 바로 뒤에 EXIF(APP1)를 넣는다
  let rest = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) rest = 4 + ((jpeg[4] << 8) | jpeg[5]);
  return new Blob([jpeg.subarray(0, 2), app1, jpeg.subarray(rest)], { type: 'image/jpeg' });
}

const ascii = (tag, text) => ({ tag, type: ASCII, bytes: new TextEncoder().encode(`${text}\0`) });

function ifdSize(entries) {
  let data = 0;
  for (const e of entries) {
    if (e.type === ASCII && e.bytes.length > 4) data += e.bytes.length + (e.bytes.length & 1);
  }
  return 2 + entries.length * 12 + 4 + data;
}

function writeIfd(view, u8, offset, entries) {
  view.setUint16(offset, entries.length, true);
  let dataOffset = offset + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = offset + 2 + i * 12;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    if (e.type === ASCII) {
      const n = e.bytes.length;
      view.setUint32(p + 4, n, true);
      if (n <= 4) {
        u8.set(e.bytes, p + 8);
      } else {
        view.setUint32(p + 8, dataOffset, true);
        u8.set(e.bytes, dataOffset);
        dataOffset += n + (n & 1);
      }
    } else {
      view.setUint32(p + 4, 1, true);
      view.setUint32(p + 8, e.value, true);
    }
  });
  view.setUint32(offset + 2 + entries.length * 12, 0, true); // 다음 IFD 없음
}

// 리틀엔디언 TIFF: 헤더 → IFD0 → Exif IFD
function buildTiff(ifd0, exifIfd) {
  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdSize(ifd0);
  ifd0.find((e) => e.tag === 0x8769).value = exifOffset;

  const u8 = new Uint8Array(exifOffset + ifdSize(exifIfd));
  const view = new DataView(u8.buffer);
  u8.set([0x49, 0x49, 0x2a, 0x00]); // "II", 42
  view.setUint32(4, ifd0Offset, true);
  writeIfd(view, u8, ifd0Offset, ifd0);
  writeIfd(view, u8, exifOffset, exifIfd);
  return u8;
}

const pad2 = (n) => String(n).padStart(2, '0');

function exifDate(d) {
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function offsetText(d) {
  const m = -d.getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  return `${sign}${pad2(Math.floor(Math.abs(m) / 60))}:${pad2(Math.abs(m) % 60)}`;
}
