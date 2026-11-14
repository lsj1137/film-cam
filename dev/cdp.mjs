// 사용: node dev/cdp.mjs <url> <대기ms> <JS식>  → 페이지에서 식을 평가한 결과와 콘솔 로그 출력
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [url, wait, expr] = process.argv.slice(2);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=9333', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--window-size=500,900',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fc-'))}`, 'about:blank']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') console.log('[console]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') console.log('[error]', msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(Number(wait));
const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
if (process.argv[5]) { await sleep(500); const s = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(process.argv[5], Buffer.from(s.result.data, "base64")); }
chrome.kill();
process.exit(0);
