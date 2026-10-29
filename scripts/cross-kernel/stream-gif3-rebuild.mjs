#!/usr/bin/env node
/**
 * 幽灵逐段变长的**重建图**（task-44）。
 *
 * ## 与上一版的唯一关键差别：**画之前先把产品 overlay 置空**
 * §16 查明的失败真因是"注入的灰字与真实 overlay 同位同色同字体 ⇒ 被同一份真实文字盖住"。
 * 所以这里：
 *   1) 真沙箱真回合跑到终态（真实幽灵在场）；
 *   2) 截一张**含真实幽灵**的图（这也是"真实像素含幽灵"的正面证据）；
 *   3) 把产品 overlay 置空（visibility:hidden，保留布局），再截一张 ⇒ 断言 B 的底；
 *   4) 在同一位置、用产品 overlay **自己的 computed style**（不是抄的常量）逐帧重建，每帧一截。
 * 置空之后，画面里那一行灰字**只能是我画的** ⇒ 变化必然可见，断言才有意义。
 *
 * ## 断言全部落在**真实截图**上，且一律用 PIL 逐像素
 * 不解析 ImageMagick compare 的 stdout —— §16 那次"A≡B、AE=0"就是解析 bug 造出来的假负结果。
 *   A clip 与文字行 bbox 相交
 *   B 置空后 clip 内浅灰墨迹 ≈ 0
 *   C 重建后墨迹 > 阈值且逐帧单调不减
 *   D 文字像素水平跨度与 chars 成正比
 * 脚本只打印每格的 PNG 路径与页内测量值；墨迹/跨度由同目录的 measure 步骤用 PIL 算。
 *
 * 用法：node scripts/cross-kernel/stream-gif3-rebuild.mjs --home ~/xk-gif3-0212 \
 *         --ws ~/xk-gif3-ws --rounds 3 --out scripts/cross-kernel/out/gif3-rebuild
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const WS = opt('ws', join(homedir(), 'xk-gif3-ws')).replace(/^~/, homedir());
const ROUNDS = Number(opt('rounds', 3));
const TURN_MS = Number(opt('turnMs', 170000));
const PAD = Number(opt('pad', 24));
const SCALE = Number(opt('scale', 4));
const OUT = opt('out', 'scripts/cross-kernel/out/gif3-rebuild');
if (HOME_ === '') throw new Error('必须给 --home');
if (!existsSync(join(HOME_, 'sbx.pid'))) throw new Error('没有 sbx.pid：不是 dev-sandbox 起的实例，拒绝（防误连 live）');
const sbxPids = readFileSync(join(HOME_, 'sbx.pid'), 'utf8').split(/\s+/).filter(Boolean);
const traceOn = sbxPids.some((pid) => {
  try { return readFileSync('/proc/' + pid + '/environ', 'latin1').split('\0').includes('DSH_SUGGEST_GHOST_TRACE=debug'); }
  catch { return false; }
});
if (!traceOn) throw new Error('实例没设 DSH_SUGGEST_GHOST_TRACE=debug ⇒ 逐帧留痕会被默认阈值静音，拒绝录制');
mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
const secrets = new Set();
const redact = (s) => {
  let o = String(s);
  for (const x of secrets) if (x.length > 4) o = o.split(x).join('«r»');
  return o.replace(/([?&]token=)[^\s"'\\]+/g, '$1token=«r»');
};
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return 'http://127.0.0.1:' + last[1] + '/?token=' + last[2];
};

/** 页内件。注释与字符串里一律不出现反引号（模板字符串内出现反引号会把模板提前结束）。 */
const HELPERS = `
window.__r = {
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  input: () => window.__r.qa('[role=textbox]').find((n) => n.offsetParent !== null) ?? null,
  overlay: () => document.querySelector('#dsh-suggest-ghost-overlay'),
  box: (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  // 量**文字本身**的盒子（容器有 pre-wrap 会撑满整行，量容器等于什么都没证明）
  textRect: (el) => {
    const tn = el == null ? null : el.firstChild;
    if (tn == null) return null;
    const rg = document.createRange();
    rg.selectNodeContents(tn);
    const q = rg.getBoundingClientRect();
    return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) };
  },
  dismiss: async () => {
    const labels = ['继续', '同意', '我已阅读', '保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    const PICKER = /选择工作区目录|添加工作区|选择工作区|Choose workspace|Select workspace/i;
    for (let k = 0; k < 10; k += 1) {
      let hit = false;
      for (const d of window.__r.qa('[role=dialog]')) {
        if (PICKER.test(d.textContent ?? '')) continue;
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__r.name(x).includes(L))) ?? bs.find((x) => window.__r.name(x).includes('关闭'));
        if (b != null) { b.click(); hit = true; await window.__r.wait(240); }
      }
      if (!hit) break;
    }
    return { dialogsLeft: window.__r.qa('[role=dialog]').length };
  },
  ensureWs: async (wsName) => {
    await window.__r.dismiss();
    const i0 = window.__r.input();
    if (i0 != null && i0.dataset?.phase !== 'inert') return { ready: true, via: 'already' };
    const o = document.querySelector('[aria-label="添加工作区"]') ?? document.querySelector('[aria-label="Add workspace"]');
    if (o == null) return { ready: false, why: 'no-opener' };
    o.click();
    if (!await window.__r.until(() => window.__r.qa('[role=dialog]').length > 0, 12000)) return { ready: false, why: 'picker-not-open' };
    const findRow = () => [...window.__r.qa('[role=dialog]')[0].querySelectorAll('button, [role=button], [role=treeitem], li, [title]')]
      .find((n) => window.__r.name(n) === wsName || (n.getAttribute?.('title') ?? '') === wsName);
    let row = null;
    let got = await window.__r.until(() => { row = findRow(); return row != null; }, 9000);
    if (!got) {
      const close = [...window.__r.qa('[role=dialog]')[0].querySelectorAll('button')].find((b) => /取消|Cancel/.test(window.__r.name(b)));
      if (close != null) { close.click(); await window.__r.wait(500); }
      o.click();
      await window.__r.until(() => window.__r.qa('[role=dialog]').length > 0, 8000);
      got = await window.__r.until(() => { row = findRow(); return row != null; }, 9000);
    }
    if (!got) return { ready: false, why: 'row-missing' };
    row.click();
    await window.__r.wait(600);
    const dd = window.__r.qa('[role=dialog]')[0];
    const open = dd == null ? null : [...dd.querySelectorAll('button, [role=button]')].filter((b) => /打开|Open/i.test(window.__r.name(b))).find((b) => !b.disabled) ?? null;
    if (open != null) open.click();
    return { ready: await window.__r.until(() => (window.__r.input()?.dataset?.phase ?? 'inert') !== 'inert', 20000), via: 'row' };
  },
  newSession: async () => {
    await window.__r.dismiss();
    const b = window.__r.qa('button, [role=button], [aria-label]').find((n) => /新会话|新建会话|New session/i.test(window.__r.name(n)));
    if (b != null) { b.click(); await window.__r.wait(1400); }
    return b != null;
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__r.wait(150); } return false; },
  // 采样：文本变化处盖页内时刻（与客户端 console 的 stream frame t= 同基准）
  rec: null,
  startRec: (maxMs) => {
    window.__r.rec = { events: [], prev: null, t0: performance.now(), done: false };
    const tick = () => {
      const cur = window.__r.rec;
      if (cur == null || cur.done) return;
      const ov = window.__r.overlay();
      const key = ov != null && getComputedStyle(ov).display !== 'none' ? (ov.textContent ?? '') : '';
      if (key !== cur.prev) cur.events.push({ tPage: Math.round((performance.now() - cur.t0) * 100) / 100, chars: key.length, text: key });
      if (performance.now() - cur.t0 > maxMs) { cur.done = true; return; }
      setTimeout(tick, 8);
    };
    setTimeout(tick, 0);
    return true;
  },
};
`;

const dir = join(tmpdir(), 'xk-gif3-' + Date.now());
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const cdpPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const page = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : String(a.description ?? ''))).join(' ');
    if (/suggest-ghost/.test(text)) consoleLines.push(text.slice(0, 200));
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error !== undefined) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++mid;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails !== undefined) throw new Error(redact(String(r.exceptionDetails.exception?.description ?? 'page error')).slice(0, 200));
  return r.result.value;
};
const shot = async (clip, name) => {
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64'));
  return name;
};

const ASKS = [
  '怎么用 ss 或 lsof 查看某个端口被哪个进程占用？请列出常用命令并解释每个参数的作用。',
  'git worktree 和普通 clone 有什么区别？请分别说明适用场景、常用命令与注意事项。',
  '如何安全地撤销最近一次 git 提交？请把 reset、revert、amend 三种做法的差别与风险讲清楚。',
];
const rounds = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 880, deviceScaleFactor: SCALE, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  await send('Page.navigate', { url: urlOf() });
  await sleep(12000);
  await ev(`(async () => { ${HELPERS} await window.__r.dismiss(); return true; })()`);
  const wsState = await ev(`window.__r.ensureWs(${JSON.stringify(WS.split('/').pop())})`);
  say('· 工作区 = ' + JSON.stringify(wsState));
  if (wsState?.ready !== true) { process.exitCode = 5; throw new Error('工作区没设上，拒绝出图'); }

  for (let round = 1; round <= ROUNDS; round += 1) {
    const q = ASKS[(round - 1) % ASKS.length];
    await ev('window.__r.newSession()');
    const f0 = await ev('(() => { const n = window.__r.input(); if (n == null) return false; n.focus(); return true; })()');
    if (!f0) { rounds.push({ round, ok: false, why: 'no-input' }); continue; }
    await sleep(200);
    const consoleFrom = consoleLines.length;
    await ev(`window.__r.startRec(${TURN_MS})`);
    await send('Input.insertText', { text: q });
    await sleep(120);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const deadline = Date.now() + TURN_MS;
    while (Date.now() < deadline) {
      if (consoleLines.slice(consoleFrom).some((l) => /stream frame=.*final=1/.test(l))) break;
      await sleep(250);
    }
    await sleep(700);
    await ev('(() => { const r = window.__r.rec; if (r != null) r.done = true; return true; })()');
    const frames = consoleLines.slice(consoleFrom).filter((l) => /stream frame=/.test(l)).map((l) => {
      const m = l.match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
      return m === null ? null : { frame: Number(m[1]), final: m[2] === '1', chars: Number(m[3]), pageT: Number(m[5]) };
    }).filter(Boolean);
    const rec = await ev('window.__r.rec');
    if (frames.length === 0) { rounds.push({ round, ok: false, why: 'no-frames' }); continue; }
    const finalChars = frames.at(-1).chars;
    const finalText = (rec?.events ?? []).map((e) => e.text).filter((x) => x.length > 0).pop() ?? '';

    // ① 含真实幽灵的一格（置空前）
    const pre = await ev(`(() => {
      const ov = window.__r.overlay(); const tb = window.__r.input();
      if (ov == null || tb == null) return null;
      const ir = tb.getBoundingClientRect();
      return { chars: (ov.textContent ?? '').length, box: window.__r.box(ov), textRect: window.__r.textRect(ov),
        input: { x: ir.x, y: ir.y, w: ir.width, h: ir.height },
        style: { font: getComputedStyle(ov).font, color: getComputedStyle(ov).color, shadow: getComputedStyle(ov).textShadow } };
    })()`);
    if (pre == null) { rounds.push({ round, ok: false, why: 'no-overlay-after-turn' }); continue; }
    const clip = { x: Math.max(0, Math.round(pre.textRect.x - 12)), y: Math.max(0, Math.round(pre.textRect.y - PAD)),
      width: Math.round(Math.max(pre.input.w, pre.textRect.w) + 24), height: Math.round(pre.textRect.h + PAD * 2) };
    const pngReal = await shot(clip, `r${round}-00-real.png`);
    // ② 置空产品 overlay（visibility:hidden 保留布局，不引起回流），再截一张
    const blanked = await ev(`(() => {
      const ov = window.__r.overlay(); if (ov == null) return { ok: false };
      ov.style.visibility = 'hidden';
      const r = ov.getBoundingClientRect();
      return { ok: true, stillThere: true, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        vis: getComputedStyle(ov).visibility };
    })()`);
    const pngBlank = await shot(clip, `r${round}-01-blank.png`);
    // ③ 逐帧重建：同一位置、同一 computed style，文本 = 终态文本的前 N 个字符（前缀式增长，
    //    与真实流式语义一致：净化前缀永远是终态的前缀）
    const cells = [{ kind: 'blank', png: pngBlank, chars: 0 }];
    for (const [i, f] of frames.entries()) {
      const st = await ev(`(() => {
        const tb = window.__r.input(); const ir = tb.getBoundingClientRect();
        let g = document.querySelector('#xk-gif3-rebuilt');
        if (g == null) { g = document.createElement('div'); g.id = 'xk-gif3-rebuilt'; document.body.appendChild(g); }
        const ov = window.__r.overlay();
        const cs = ov == null ? null : getComputedStyle(ov);
        g.style.cssText = ['position:fixed', 'pointer-events:none', 'white-space:pre-wrap', 'word-break:break-word',
          'z-index:2147483646', 'background:transparent',
          'left:' + Math.round(ir.left) + 'px', 'top:' + Math.round(ir.bottom + 2) + 'px',
          'width:' + Math.round(ir.width) + 'px',
          'font:' + (cs ? cs.font : '14px -apple-system'),
          'color:' + (cs ? cs.color : '#9aa0a6'),
          'text-shadow:' + (cs ? cs.textShadow : '0 0 1px #9aa0a6, 0 0 8px #9aa0a6')].join(';');
        g.textContent = ${JSON.stringify(finalText)}.slice(0, ${f.chars});
        const tr = window.__r.textRect(g);
        return { chars: g.textContent.length, textRect: tr };
      })()`);
      const png = await shot(clip, `r${round}-${String(i + 2).padStart(2, '0')}-f${f.frame}c${f.chars}.png`);
      cells.push({ kind: 'frame', png, chars: f.chars, frame: f.frame, final: f.final, tMs: f.pageT - frames[0].pageT, measuredRect: st?.textRect ?? null });
    }
    await ev('(() => { const g = document.querySelector("#xk-gif3-rebuilt"); if (g != null) g.remove(); const ov = window.__r.overlay(); if (ov != null) ov.style.visibility = ""; return true; })()');
    rounds.push({
      round, ok: true, ask: q.slice(0, 20), frames, finalChars, finalTextLen: finalText.length,
      clip, assertionA: { clipIntersectsInput: !(clip.x > pre.input.x + pre.input.w || pre.input.x > clip.x + clip.width
        || clip.y > pre.input.y + pre.input.h || pre.input.y > clip.y + clip.height) },
      pngReal, blanked, cells,
      productStyle: pre.style,
    });
    say(`· 轮 ${round}: 帧=${JSON.stringify(frames.map((x) => [x.chars, x.final ? 'F' : '-']))} 终态文本长=${finalText.length} A=${rounds.at(-1).assertionA.clipIntersectsInput}`);
  }
  writeFileSync(join(OUT, 'record.json'), JSON.stringify({ home: HOME_, scale: SCALE, pad: PAD, rounds }, null, 2) + '\n');
  say('· 落盘 ' + join(OUT, 'record.json'));
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(600);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(400); } }
  if (existsSync(dir)) say('· chrome 临时目录没删净：' + dir);
}
