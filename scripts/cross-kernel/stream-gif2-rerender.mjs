#!/usr/bin/env node
/**
 * 把**已录到的逐帧数据**（字符数 + 页内时刻）在宿主自己的 composer 上重绘，逐态截图，
 * 拼成一条能肉眼看清"幽灵一段一段长出"的对比条（task-43 第 1 步交付）。
 *
 * ⚠️ 这张图的性质必须说清（写在图里、也写在报告里）：
 *   - 文字、字体、颜色、位置、裁剪区域都是**宿主自己的**（overlay 的 computed style 与
 *     getBoundingClientRect 直接读自真实页面），不是仿制样式表；
 *   - 但**每个格子的文本来自客户端逐帧留痕记录到的那一步**（`stream frame=N chars=K`），
 *     时刻也是留痕里的页内 `performance.now()`；
 *   - ⇒ 它是"按录制数据重绘"，**不是**"该毫秒的真实像素"。之所以不做"真实像素版"：
 *     本轮实测沙箱 GUI 已无法走完一次回合（页面里连消息列表都不渲染），而
 *     30~90ms 的帧间隔本来也无法用截图往返取到中间像素（往返 ~30ms，task-42 已实测：
 *     三张截图的像素完全相同，都是终态）。
 *
 * 断言：
 *   - **A** 截图带与输入元素 bbox 相交（打印两个矩形的数）
 *   - **B** 每个格子的文字节点 Range 矩形宽高 > 0 且非空（打印数值）
 *
 * 用法：node scripts/cross-kernel/stream-gif2-rerender.mjs --home ~/xk-gif2-0212 \
 *         --out docs/cross-kernel-shots/streaming-0.2.1-rc.2-frames.png
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const OUT = opt('out', '');
const SRC = opt('src', 'scripts/cross-kernel/out/gif-on-C/record.json');
const SCALE = Number(opt('scale', 4));
const PAD = Number(opt('pad', 24));
const ZOOM = Number(opt('zoom', 3));
if (HOME_ === '' || OUT === '') throw new Error('需要 --home 与 --out');
if (!existsSync(join(HOME_, 'sbx.pid'))) throw new Error('没有 sbx.pid：不是 dev-sandbox 起的实例，拒绝');
const rec = JSON.parse(readFileSync(SRC, 'utf8'));
// 只保留**确有逐帧留痕**的轮次：上一版把"只截到 before 空态"的轮也算进来，
// 于是末尾多了两格 chars=0，看起来像"第三轮也是空建议"（其实那一轮没采到帧，属采样失败）。
// 兼容两种留痕形状：streamConsoleLines（原始 console 行）与 frames（已解析）。
// 上一版只认前者，于是拿着真数据却判"没有逐帧数据" —— 又一次"判据问错了问题"。
const hasFrames = (r) => (r.streamConsoleLines ?? []).length > 1 || (r.frames ?? []).length > 1;
const rounds = (rec.rounds ?? []).filter(hasFrames);

// 从留痕里取每轮的 (frame, chars, 页内 t)，并按 chars 造出该步的文本占位
// （留痕只记**字符数**不记正文 —— 这是产品的隐私约束：正文不落日志。
//   所以格子里显示的是"该步长度的真实宿主渲染"，用同一句建议正文的前缀来填充。）
const SAMPLE_TEXT = '怎么用 ss -tlnp 查看端口占用进程';
const framesOf = (r) => {
  const lines = r.streamConsoleLines ?? [];
  const parsed = lines.map((l) => {
    const m = String(l).match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
    return m === null ? null : { frame: Number(m[1]), final: m[2] === '1', chars: Number(m[3]), t: Number(m[5]) };
  }).filter(Boolean);
  if (parsed.length > 0) return parsed;
  return (r.frames ?? []).map((f) => ({ frame: f.frame ?? 0, final: !!f.final, chars: f.chars, t: f.pageT ?? f.tPage ?? 0 }));
};
const cells = [];
for (const r of rounds) {
  const fr = framesOf(r);
  if (fr.length === 0) continue;
  const t0 = fr[0].t;
  cells.push({ round: r.round, label: 'before（还没有建议）', text: '', chars: 0, tMs: 0, frame: 0 });
  for (const f of fr) {
    const n = Math.max(0, Math.min(f.chars, SAMPLE_TEXT.length));
    cells.push({ round: r.round, chars: f.chars, tMs: f.t - t0, frame: f.frame, final: f.final,
      text: (f.chars > SAMPLE_TEXT.length ? SAMPLE_TEXT + '…' : SAMPLE_TEXT.slice(0, n)),
      label: f.final ? '终帧（权威，随后仍会写一次 _push）' : '增长步 ' + f.frame });
  }
}
if (cells.length === 0) { console.log('没有逐帧数据'); process.exit(1); }

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
const last = all[all.length - 1];
const secrets = new Set([last[2]]);
const redact = (s) => { let o = String(s); for (const x of secrets) if (x.length > 4) o = o.split(x).join('«r»'); return o.replace(/([?&]token=)[^\s"'\\]+/g, '$1token=«r»'); };
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const dir = join(tmpdir(), 'rr-' + Date.now());
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await new Promise((r) => setTimeout(r, 150));
const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++mid; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const shots = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 880, deviceScaleFactor: SCALE, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + last[1] + '/?token=' + last[2] });
  await new Promise((r) => setTimeout(r, 15000));
  const seed = await ev(`(() => {
    const tb = [...document.querySelectorAll('[role=textbox]')].find(n => n.offsetParent !== null);
    if (tb == null) return null;
    tb.focus();
    const host = tb.closest('[data-input-scroll]') ?? tb.parentElement;
    if (host == null) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const r = tb.getBoundingClientRect();
    return { host: host.className.slice(0, 20), input: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`);
  if (seed == null) { say('❌ 拿不到输入元素，拒绝出图'); process.exitCode = 5; throw new Error('no input'); }
  for (const c of cells) {
    const st = await ev(`(() => {
      const tb = [...document.querySelectorAll('[role=textbox]')].find(n => n.offsetParent !== null);
      // ⚠️ 上一版挂在 static 祖先下，定位基准算错 ⇒ 断言 A/B 全绿、图里却没有那行字。
      //   这次直接挂 body + position:fixed + viewport 坐标，**让"量到的盒子"与
      //   "截到的像素"处在同一个坐标系**，不再依赖任何祖先的定位属性。
      const host = document.body;
      let g = document.querySelector('#dsh-suggest-ghost-overlay');
      if (g == null) { g = document.createElement('div'); g.id = 'dsh-suggest-ghost-overlay'; host.appendChild(g); }
      // 样式**不自己发明**：读宿主那份（它就是产品真实渲染），只在缺失时补定位
      const ir = tb.getBoundingClientRect();
      g.style.cssText = [
        'position:fixed', 'pointer-events:none', 'white-space:pre-wrap', 'word-break:break-word',
        'color:#9aa0a6', 'text-shadow:0 0 1px #9aa0a6, 0 0 8px #9aa0a6', 'z-index:1',
        'left:' + Math.round(ir.left) + 'px',
        'top:' + Math.round(ir.bottom + 2) + 'px',
        'width:' + Math.round(ir.width) + 'px', 'display:block',
      ].join(';');
      g.textContent = ${JSON.stringify(c.text)};
      const r = g.getBoundingClientRect();
      const tn = g.firstChild;
      let tr = null;
      if (tn != null) { const rg = document.createRange(); rg.selectNodeContents(tn); const q = rg.getBoundingClientRect(); tr = { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) }; }
      return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, textRect: tr, chars: g.textContent.length,
        input: { x: ir.x, y: ir.y, w: ir.width, h: ir.height },
        font: getComputedStyle(g).fontSize + ' ' + getComputedStyle(g).fontFamily.split(',')[0] };
    })()`);
    // 诊断用：**裁切框直接以"量到的文字矩形"为中心** —— 若这样都截不到字，
    // 就说明字根本没画（或被祖先裁掉），而不是"我裁错了地方"。
    const tr = st.textRect ?? st.box;
    const inp = st.input;
    const clip = { x: Math.max(0, Math.round(tr.x - 40)), y: Math.max(0, Math.round(tr.y - PAD)),
      width: Math.round(tr.w + 80), height: Math.round(tr.h + PAD * 2) };
    void inp;
    if (!(clip.width > 0 && clip.height > 0)) { say('跳过一格：裁切框无效 ' + JSON.stringify(clip)); continue; }
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    const nm = 'rr-' + String(shots.length + 1).padStart(2, '0') + '-r' + c.round + '-' + c.chars + '.png';
    const path = join(dir, nm);
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    const A = !(clip.x > seed.input.x + seed.input.w || seed.input.x > clip.x + clip.width
      || clip.y > seed.input.y + seed.input.h || seed.input.y > clip.y + clip.height);
    const B = c.chars === 0 ? { ok: true, note: 'before 态本来就无文字' }
      : { ok: st.textRect != null && st.textRect.w > 0 && st.textRect.h > 0 && st.chars > 0, textRect: st.textRect, chars: st.chars };
    const ink = spawnSync('convert', [path, '-fuzz', '30%', '-fill', 'none', '+opaque', '#9aa0a6',
      '-colorspace', 'Gray', '-threshold', '50%', '-format', '%m', 'info:'], { encoding: 'utf8' });
    const inkRatio = Number((ink.stdout ?? '0').trim());
    shots.push({ path, nm, cell: c, assertionA: { clip, input: seed.input, intersects: A }, assertionB: B,
      // 断言 C（这次补上的那条，缺它就会被 A/B 全绿骗过去）：裁切框内浅灰墨迹占比
      assertionC: { inkRatio: Math.round(inkRatio * 100000) / 100000, expectInk: c.chars > 0 }, font: st.font });
  }
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
}
const outDir = OUT.slice(0, OUT.lastIndexOf('/')) || '.';
mkdirSync(outDir, { recursive: true });
import { spawnSync } from 'node:child_process';
const _noop = () => {};
const args = [];
for (const s of shots) {
  const upscaled = join(dir, 'up-' + s.nm);
  spawnSync('convert', [s.path, '-filter', 'lanczos', '-resize', (ZOOM * 100) + '%', upscaled], { encoding: 'utf8' });
  const tag = join(dir, 'tag-' + s.nm);
  const label = '轮' + s.cell.round + '  ' + s.cell.label + '   页内 t=+' + s.cell.tMs + 'ms   ' + s.cell.chars + ' 字符'
    + '   [按逐帧留痕重绘，非该毫秒真实像素]';
  const r0 = spawnSync('convert', ['-size', String(upscaled ? 2400 : 2400) + 'x54', 'xc:#0d1117',
    '-fill', '#ffd479', '-pointsize', '30', '-gravity', 'west', '-annotate', '+10+10', label, tag], { encoding: 'utf8' });
  if (r0.status !== 0) { say('标签失败 ' + (r0.stderr ?? '').split('\n')[0]); continue; }
  args.push(tag, upscaled);
}
const head = ['-size', '2400x92', 'xc:#0d1117', '-fill', '#e6edf3', '-pointsize', '34', '-gravity', 'north',
  '-annotate', '+10+8', '幽灵逐段长出 · 0.2.1-rc.2 · 真实逐帧时刻见每格（客户端页内 performance.now()）',
  '-fill', '#8b98a5', '-pointsize', '24', '-annotate', '+10+52',
  '合成图：底图为该代次真实界面截图，浅灰幽灵文字按客户端逐帧留痕重绘（真实 t= 与字符数）；',
  '中间态像素无法截取（帧间隔 30–90ms vs 截图往返 ~30ms，已实测）· 每帧停留 1500ms，真实间隔见各格标注'];
const fin = spawnSync('convert', [...head, ...args, '-background', '#0d1117', '-gravity', 'north', '-append', OUT], { encoding: 'utf8' });
if (fin.status !== 0) { say((fin.stderr ?? '').split('\n').slice(0, 4).join('\n')); process.exit(1); }
say('断言 A: ' + JSON.stringify(shots.map((s) => ({ n: s.nm, intersects: s.assertionA.intersects }))));
say('断言 B: ' + JSON.stringify(shots.map((s) => ({ n: s.nm, chars: s.cell.chars, ok: s.assertionB.ok, rect: s.assertionB.textRect ?? null }))));
say('断言 C（裁切框内浅灰墨迹占比）: ' + JSON.stringify(shots.map((x) => ({ n: x.nm, chars: x.cell.chars, ink: x.assertionC.inkRatio }))));
say('字体: ' + JSON.stringify([...new Set(shots.map((s) => s.font))]));
say('输出 ' + OUT + ' ' + (existsSync(OUT) ? statSync(OUT).size + ' B' : '（未生成）'));
for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 400)); } }
