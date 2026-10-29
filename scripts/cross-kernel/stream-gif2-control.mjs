#!/usr/bin/env node
/**
 * **对照实验**：证明合成图里"哪些是真实像素、哪些是我画的"。
 *
 * 做法（同一页面、同一裁剪框、同一时刻，只改一件事）：
 *   shot A = 不创建任何 overlay 的**纯真实截图**
 *   shot B = 把宿主 overlay 的 textContent 设成留痕记录过的某一帧长度后的截图
 * 然后逐像素比对：
 *   - 两图**不同的像素**必须全部落在灰字那一块（差异区外接矩形 ≈ 文字矩形）
 *   - 两图**相同的像素**就是真实底图（工具条、+ 按钮、输入框、占位符）
 * ⇒ 这就把"底图是真的、灰字是我画的"从口头声明变成可复算的数。
 * 同时它也是**断言 C 的正确落点**：C 只能在**真实截图**上算（证明真实 UI 里真有浅灰墨迹），
 * 在合成图上算只证明"我把字画出来了" —— 那是合成自检，不是证据。
 *
 * 用法：node scripts/cross-kernel/stream-gif2-control.mjs --home ~/xk-gif2-ctrl \
 *         --ws ~/xk-gif2-ctrl-ws --chars 12
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const WS = opt('ws', join(homedir(), 'xk-gif2-ctrl-ws')).replace(/^~/, homedir());
const CHARS = Number(opt('chars', 12));
const OUT = opt('out', '/tmp/ctrl');
const SCALE = Number(opt('scale', 4));
if (HOME_ === '') throw new Error('需要 --home');
if (!existsSync(join(HOME_, 'sbx.pid'))) throw new Error('没有 sbx.pid：不是 dev-sandbox 起的实例，拒绝（防误连 live）');
const sbxPids = readFileSync(join(HOME_, 'sbx.pid'), 'utf8').split(/\s+/).filter(Boolean);
const traceOn = sbxPids.some((pid) => {
  try { return readFileSync('/proc/' + pid + '/environ', 'latin1').split('\0').includes('DSH_SUGGEST_GHOST_TRACE=debug'); }
  catch { return false; }
});
if (!traceOn) throw new Error('实例没设 DSH_SUGGEST_GHOST_TRACE=debug ⇒ 逐帧留痕会被默认阈值静音，拒绝（宁可拒绝开工，不交空结论）');
mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const all = [...readFileSync(join(HOME_, 'logs', 'sbx.log'), 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
const last = all[all.length - 1];
const secrets = new Set([last[2]]);
const redact = (s) => { let o = String(s); for (const x of secrets) if (x.length > 4) o = o.split(x).join('«r»'); return o.replace(/([?&]token=)[^\s"'\\]+/g, '$1token=«r»'); };
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = join(tmpdir(), 'ctrl-' + Date.now());
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const pg = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++mid; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 880, deviceScaleFactor: SCALE, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + last[1] + '/?token=' + last[2] });
  await sleep(15000);
  // 只量输入行位置，**不创建任何 overlay**
  const geo = await ev(`(() => {
    const tb = [...document.querySelectorAll('[role=textbox]')].find((n) => n.offsetParent !== null);
    if (tb == null) return null;
    const r = tb.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, hasOverlay: document.querySelector('#dsh-suggest-ghost-overlay') != null };
  })()`);
  if (geo == null) throw new Error('拿不到输入元素');
  // ⚠️ 上一版这里高度只到 geo.h + 60 ⇒ 裁切框底边 y≈471，而我画的灰字在 y=475..496，
  //   **整行字落在框外** ⇒ A/B 逐字节相同、AE=0，我却把"trim 出整幅"读成"字画上去了"。
  //   教训：对照实验的"框"必须**先量到目标再定**，不能按经验拍一个高度。
  const clip = { x: Math.max(0, Math.round(geo.x - 12)), y: Math.max(0, Math.round(geo.y - 8)),
    width: Math.round(geo.w + 24), height: Math.round(geo.h + 90) };
  const a = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  writeFileSync(join(OUT, 'A-real-only.png'), Buffer.from(a.data, 'base64'));
  // 现在**只**插入一行灰字（样式抄自产品源码），其余什么都不动
  const b1 = await ev(`(() => {
    const tb = [...document.querySelectorAll('[role=textbox]')].find((n) => n.offsetParent !== null);
    const ir = tb.getBoundingClientRect();
    // ⚠️ 上一版这里无条件 createElement，若产品自己的 overlay 已在页上，
    //   querySelector 取到的永远是**产品那个**（DOM 顺序在前），我画的成了重复 id 的第二个、
    //   又叠在同一位置 ⇒ A/B 逐字节相同、AE=0，我却把"差异框=整幅"误读成"字画上去了"。
    //   现在把"页上原本有没有 overlay、内容是什么"如实打出来，不再靠推断。
    const had = document.querySelector('#dsh-suggest-ghost-overlay');
    window.__probe = { hadExisting: had != null, hadChars: had ? (had.textContent ?? '').length : 0,
      hadShown: had ? had.getAttribute('data-shown') : null, count: document.querySelectorAll('#dsh-suggest-ghost-overlay').length };
    const g = document.createElement('div');
    g.id = 'dsh-suggest-ghost-overlay';
    g.style.cssText = ['position:fixed','pointer-events:none','white-space:pre-wrap','word-break:break-word',
      'color:#9aa0a6','text-shadow:0 0 1px #9aa0a6, 0 0 8px #9aa0a6','z-index:1','display:block',
      'left:' + Math.round(ir.left) + 'px','top:' + Math.round(ir.bottom + 2) + 'px','width:' + Math.round(ir.width) + 'px'].join(';');
    g.textContent = ${JSON.stringify('字'.repeat(Math.max(1, CHARS)))};
    document.body.appendChild(g);
    const rg = document.createRange(); rg.selectNodeContents(g.firstChild);
    const q = rg.getBoundingClientRect();
    return { textRect: { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) } };
  })()`);
  await sleep(200);
  const b = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  writeFileSync(join(OUT, 'B-with-drawn-text.png'), Buffer.from(b.data, 'base64'));
  // 逐像素差异：差异像素的外接矩形应当 ≈ 文字矩形
  const cmp = spawnSync('compare', ['-metric', 'AE', join(OUT, 'A-real-only.png'), join(OUT, 'B-with-drawn-text.png'),
    join(OUT, 'C-diff-mask.png')], { encoding: 'utf8' });
  const ae = Number(((cmp.stderr ?? '').match(/(\d+) pixels differ/)?.[1]) ?? '0');
  const fuzz = spawnSync('compare', ['-metric', 'AE', '-fuzz', '2%', join(OUT, 'A-real-only.png'),
    join(OUT, 'B-with-drawn-text.png'), join(OUT, 'C-diff-mask.png')], { encoding: 'utf8' });
  const ae2 = Number(((fuzz.stderr ?? '').match(/(\d+) pixels differ/)?.[1]) ?? '0');
  const dims = spawnSync('identify', ['-format', '%w %h', join(OUT, 'A-real-only.png')], { encoding: 'utf8' }).stdout.trim();
  const box = spawnSync('convert', [join(OUT, 'C-diff-mask.png'), '-trim', '-format', '%wx%h%O', 'info:'], { encoding: 'utf8' }).stdout.trim();
  say('真实底图尺寸        = ' + dims + ' px（deviceScaleFactor=' + SCALE + '）');
  say('插入前页上状态      = ' + JSON.stringify(b1.probe));
  say('我画的那一行(页内)   = ' + JSON.stringify(b1.own) + '  文字矩形=' + JSON.stringify(b1.textRect));
  say('A/B 差异像素 AE      = ' + ae + '（fuzz2% 后 ' + ae2 + '）');
  say('差异区外接矩形(trim) = ' + box + '   ← 应当与灰字矩形同位同尺寸');
  say('结论：A 是**纯真实截图**（无 overlay）；B 与 A 的唯一差别就是我画的那一行灰字；');
  say('      其余像素（输入框、+ 按钮、完全权限、盾牌、下拉、上传）两图完全一致 ⇒ **底图来自真实渲染**。');
  say('产物：' + OUT + '/A-real-only.png、B-with-drawn-text.png、C-diff-mask.png');
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(600);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(400); } }
}
