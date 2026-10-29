#!/usr/bin/env node
/**
 * **真实像素版**逐帧截图（task-46）：回填后由**产品自己的 overlay 元素**渲染。
 *
 * 与上一版（§17 手绘重绘版）的本质差别：
 *   §17 = overlay 置空 + 我另画的 div（样式复刻自产品源码）
 *   本版 = 把**产品 overlay 元素的 textContent 逐帧回填**成实测内容 ⇒ 渲染者是产品代码
 *
 * 两条独立来源必须对齐（断言 F）：
 *   ① `data-stream-frames`（#114 落在 overlay 上的 DOM 属性：frame/final/chars/t，零正文）
 *   ② 测试侧 MutationObserver 记录的 `{t, text}`（回合进行中就地采集）
 *   ⇒ 逐格比 `chars` 与 `t`（容差 ±5ms）。不一致就报不一致，**不许挑好看的那条用**。
 *
 * 裁切：贴 overlay 自身 bbox + 上下 24px；视口 1100（矮视口时字形下沿会被**文档边缘**切掉，§17.8）。
 * 绝不截整页。
 *
 * 用法：node scripts/cross-kernel/stream-replay-record.mjs --home ~/xk-replay-0212 \
 *         --ws ~/xk-replay-ws --rounds 3 --out scripts/cross-kernel/out/replay
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const WS = opt('ws', join(homedir(), 'xk-replay-ws')).replace(/^~/, homedir());
const ROUNDS = Number(opt('rounds', 3));
const TURN_MS = Number(opt('turnMs', 170000));
const PAD = Number(opt('pad', 24));
const SCALE = Number(opt('scale', 4));
const OUT = opt('out', 'scripts/cross-kernel/out/replay');
if (HOME_ === '') throw new Error('必须给 --home');
if (!existsSync(join(HOME_, 'sbx.pid'))) throw new Error('没有 sbx.pid：不是 dev-sandbox 起的实例，拒绝（防误连 live）');
const sbxPids = readFileSync(join(HOME_, 'sbx.pid'), 'utf8').split(/\s+/).filter(Boolean);
const traceOn = sbxPids.some((pid) => {
  try { return readFileSync('/proc/' + pid + '/environ', 'latin1').split('\0').includes('DSH_SUGGEST_GHOST_TRACE=debug'); }
  catch { return false; }
});
if (!traceOn) throw new Error('实例没设 DSH_SUGGEST_GHOST_TRACE=debug ⇒ 逐帧留痕被默认阈值静音，拒绝开工');
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

/** 页内件。⚠️ 注释与字符串里一律不出现反引号（本仓栽过六次：模板字符串会被提前结束）。 */
const HELPERS = `
window.__y = {
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  input: () => window.__y.qa('[role=textbox]').find((n) => n.offsetParent !== null) ?? null,
  overlay: () => document.querySelector('#dsh-suggest-ghost-overlay'),
  box: (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  textRect: (el) => {
    const tn = el == null ? null : el.firstChild;
    if (tn == null) return null;
    const rg = document.createRange();
    rg.selectNodeContents(tn);
    const q = rg.getBoundingClientRect();
    return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) };
  },
  domFrames: () => {
    const el = window.__y.overlay();
    if (el == null) return null;
    const raw = el.dataset.streamFrames;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return 'parse-error'; }
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__y.wait(150); } return false; },
  dismiss: async () => {
    const labels = ['继续', '同意', '我已阅读', '保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    const PICKER = /选择工作区目录|添加工作区|选择工作区|Choose workspace|Select workspace/i;
    for (let k = 0; k < 10; k += 1) {
      let hit = false;
      for (const d of window.__y.qa('[role=dialog]')) {
        if (PICKER.test(d.textContent ?? '')) continue;
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__y.name(x).includes(L))) ?? bs.find((x) => window.__y.name(x).includes('关闭'));
        if (b != null) { b.click(); hit = true; await window.__y.wait(240); }
      }
      if (!hit) break;
    }
    return { dialogsLeft: window.__y.qa('[role=dialog]').length };
  },
  ensureWs: async (wsName) => {
    await window.__y.dismiss();
    const i0 = window.__y.input();
    if (i0 != null && i0.dataset?.phase !== 'inert') return { ready: true, via: 'already' };
    const o = document.querySelector('[aria-label="添加工作区"]') ?? document.querySelector('[aria-label="Add workspace"]');
    if (o == null) return { ready: false, why: 'no-opener' };
    o.click();
    if (!await window.__y.until(() => window.__y.qa('[role=dialog]').length > 0, 12000)) return { ready: false, why: 'picker-not-open' };
    const findRow = () => [...window.__y.qa('[role=dialog]')[0].querySelectorAll('button, [role=button], [role=treeitem], li, [title]')]
      .find((n) => window.__y.name(n) === wsName || (n.getAttribute?.('title') ?? '') === wsName);
    let row = null;
    let got = await window.__y.until(() => { row = findRow(); return row != null; }, 9000);
    if (!got) {
      const close = [...window.__y.qa('[role=dialog]')[0].querySelectorAll('button')].find((b) => /取消|Cancel/.test(window.__y.name(b)));
      if (close != null) { close.click(); await window.__y.wait(500); }
      o.click();
      await window.__y.until(() => window.__y.qa('[role=dialog]').length > 0, 8000);
      got = await window.__y.until(() => { row = findRow(); return row != null; }, 9000);
    }
    if (!got) return { ready: false, why: 'row-missing' };
    row.click();
    await window.__y.wait(600);
    const dd = window.__y.qa('[role=dialog]')[0];
    const open = dd == null ? null : [...dd.querySelectorAll('button, [role=button]')].filter((b) => /打开|Open/i.test(window.__y.name(b))).find((b) => !b.disabled) ?? null;
    if (open != null) open.click();
    return { ready: await window.__y.until(() => (window.__y.input()?.dataset?.phase ?? 'inert') !== 'inert', 20000), via: 'row' };
  },
  newSession: async () => {
    await window.__y.dismiss();
    const b = window.__y.qa('button, [role=button], [aria-label]').find((n) => /新会话|新建会话|New session/i.test(window.__y.name(n)));
    if (b != null) { b.click(); await window.__y.wait(1400); }
    return b != null;
  },
  // ── 测试侧记录器：MutationObserver 盯 overlay，每次变化记 {t, text} ──────────
  mo: null,
  moLog: [],
  moInstall: () => {
    const el = window.__y.overlay();
    window.__y.moLog = [{ t: Math.round(performance.now()), text: el == null ? '' : (el.textContent ?? '') }];
    if (el == null) return { installed: false, why: 'no-overlay-yet' };
    window.__y.mo = new MutationObserver(() => {
      const cur = window.__y.overlay();
      const text = cur == null ? '' : (cur.textContent ?? '');
      const last = window.__y.moLog[window.__y.moLog.length - 1];
      if (last == null || last.text !== text) {
        window.__y.moLog.push({ t: Math.round(performance.now()), text });
      }
    });
    window.__y.mo.observe(el, { childList: true, subtree: true, characterData: true });
    return { installed: true };
  },
  moInstallLate: () => {
    // overlay 是**首次绘制时才创建**的 ⇒ 开局 el 为 null。
    // ⚠️ 上一版这里"等它出现再装"，但**整段观察从未真正生效**（观察者记录恒为 1 = 初始空态），
    //   于是回填循环拿不到中间文本、把中间帧回填成空串 —— 截图里只有终帧有字。
    //   现在：body 级观察者盯到 overlay 出现后，**挂到 overlay 上并继续记录**，
    //   同时把"终态文本"作为兜底来源（净化前缀恒为终态的前缀，这是产品语义）。
    const el = window.__y.overlay();
    if (el != null) return window.__y.moInstall();
    window.__y.mo = new MutationObserver(() => {
      const now = window.__y.overlay();
      if (now != null) {
        try { window.__y.mo.disconnect(); } catch { /* noop */ }
        window.__y.mo = null;
        window.__y.moInstall();
      }
    });
    window.__y.mo.observe(document.body, { childList: true, subtree: true });
    return { installed: 'waiting-for-overlay' };
  },
  finalText: () => {
    const el = window.__y.overlay();
    return el == null ? '' : (el.textContent ?? '');
  },
  moStop: () => { if (window.__y.mo != null) { try { window.__y.mo.disconnect(); } catch { /* noop */ } window.__y.mo = null; } return window.__y.moLog.length; },
  // 回填：**产品自己的 overlay 元素**的文本，不是我画的 div
  backfill: (text) => {
    const el = window.__y.overlay();
    if (el == null) return null;
    el.textContent = text;
    const tr = window.__y.textRect(el);
    return { chars: (el.textContent ?? '').length, box: window.__y.box(el), textRect: tr,
      font: getComputedStyle(el).fontFamily.split(',')[0], size: getComputedStyle(el).fontSize };
  },
};
`;

const dir = join(tmpdir(), 'xk-replay-' + Date.now());
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

const ASKS = [
  '怎么用 ss 或 lsof 查看某个端口被哪个进程占用？请列出常用命令并解释每个参数的作用。',
  'git worktree 和普通 clone 有什么区别？请分别说明适用场景、常用命令与注意事项。',
  '如何安全地撤销最近一次 git 提交？请把 reset、revert、amend 三种做法的差别与风险讲清楚。',
];
const rounds = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  // 视口 1100：矮视口时幽灵贴在输入框下沿，会被**文档边缘**切掉字形下沿（§17.8 实测）
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1100, deviceScaleFactor: SCALE, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  await send('Page.navigate', { url: urlOf() });
  await sleep(13000);
  await ev(`(async () => { ${HELPERS} await window.__y.dismiss(); return true; })()`);
  const wsState = await ev(`window.__y.ensureWs(${JSON.stringify(WS.split('/').pop())})`);
  say('· 工作区 = ' + JSON.stringify(wsState));
  if (wsState?.ready !== true) { process.exitCode = 5; throw new Error('工作区没设上，拒绝出图'); }

  for (let round = 1; round <= ROUNDS; round += 1) {
    const q = ASKS[(round - 1) % ASKS.length];
    await ev('window.__y.newSession()');
    await ev('(() => { const n = window.__y.input(); if (n != null) n.focus(); return true; })()');
    await sleep(200);
    const consoleFrom = consoleLines.length;
    // overlay 首次绘制才创建 ⇒ 装不上就挂 body 级观察者等它
    const installed = await ev('window.__y.moInstallLate()');
    await send('Input.insertText', { text: q });
    await sleep(120);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const deadline = Date.now() + TURN_MS;
    while (Date.now() < deadline) {
      if (consoleLines.slice(consoleFrom).some((l) => /stream frame=.*final=1/.test(l))) break;
      await sleep(250);
    }
    await sleep(900);
    const logLen = await ev('window.__y.moStop()');
    const moLog = await ev('window.__y.moLog');
    const domFrames = await ev('window.__y.domFrames()');
    const finalText = await ev('window.__y.finalText()');
    const traceFrames = consoleLines.slice(consoleFrom).filter((l) => /stream frame=/.test(l)).map((l) => {
      const m = l.match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
      return m === null ? null : { frame: Number(m[1]), final: m[2] === '1', chars: Number(m[3]), t: Number(m[5]) };
    }).filter(Boolean);
    if (domFrames == null || traceFrames.length === 0) {
      rounds.push({ round, ok: false, why: domFrames == null ? 'no-data-stream-frames' : 'no-trace-frames', moLen: logLen });
      say(`· 轮 ${round}: 跳过 —— DOM=${JSON.stringify(domFrames)} 留痕帧=${traceFrames.length}`);
      continue;
    }
    // 起点格：清空**产品 overlay** 自身（断言 B 的底）
    await ev('(() => { const el = window.__y.overlay(); if (el != null) el.textContent = ""; return true; })()');
    await sleep(120);
    const geo = await ev(`(() => {
      const el = window.__y.overlay(); const tb = window.__y.input();
      if (el == null || tb == null) return null;
      const r = el.getBoundingClientRect(); const ir = tb.getBoundingClientRect();
      return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, input: { x: ir.x, y: ir.y, w: ir.width, h: ir.height } };
    })()`);
    if (geo == null) { rounds.push({ round, ok: false, why: 'no-geometry' }); continue; }
    // 裁切贴 overlay 自身 bbox + 24px（§17.8 的教训：不要盲目放大 clip）
    const clip = { x: Math.max(0, Math.round(geo.box.x - 12)), y: Math.max(0, Math.round(geo.box.y - PAD)),
      width: Math.round(geo.box.w + 24), height: Math.round(geo.box.h + PAD * 2) };
    const shots = [];
    const s0 = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    writeFileSync(join(OUT, `r${round}-00-blank.png`), Buffer.from(s0.data, 'base64'));
    shots.push({ png: `r${round}-00-blank.png`, chars: 0, source: 'blank' });
    // 逐帧回填：**内容来自测试侧 MutationObserver 记录的真实文本**，渲染者是产品 overlay 元素
    for (const [i, f] of domFrames.entries()) {
      // 内容优先级：① 观察者抓到的**该长度真实文本**（最可信，逐帧实测）
      //             ② 终态文本的前缀（产品语义：净化前缀恒为终态前缀）—— 来源在 record.json 里标出来
      const observed = (moLog ?? []).find((x) => x.text.length === f.chars) ?? null;
      const useText = observed != null ? observed.text : finalText.slice(0, f.chars);
      const srcKind = observed != null ? 'observer' : 'final-prefix';
      const st = await ev(`window.__y.backfill(${JSON.stringify(useText)})`);
      await sleep(120);
      const nm = `r${round}-${String(i + 1).padStart(2, '0')}-f${f.frame}c${f.chars}.png`;
      const sh = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      writeFileSync(join(OUT, nm), Buffer.from(sh.data, 'base64'));
      shots.push({ png: nm, chars: f.chars, frame: f.frame, final: !!f.final, tDom: f.t,
        tObserver: observed == null ? null : observed.t, textSource: srcKind,
        rendered: st?.chars ?? 0, font: st ? st.size + ' ' + st.font : null });
    }
    // 断言 F：两条独立来源逐格对齐（chars 与 t，容差 ±5ms）
    const align = domFrames.map((f, i) => ({
      frame: f.frame, charsDom: f.chars, charsTrace: traceFrames[i]?.chars ?? null,
      tDom: f.t, tTrace: traceFrames[i]?.t ?? null,
      charsMatch: traceFrames[i]?.chars === f.chars,
      tMatch: traceFrames[i] != null && Math.abs(traceFrames[i].t - f.t) <= 5,
    }));
    const F = { countDom: domFrames.length, countTrace: traceFrames.length, countObserver: moLog.length,
      rows: align, charsAllMatch: align.every((x) => x.charsMatch), tAllMatch: align.every((x) => x.tMatch) };
    rounds.push({ round, ok: true, ask: q.slice(0, 18), clip, geo, shots, F,
      domFrames, traceFrames, observerLen: moLog.length });
    say(`· 轮 ${round}: DOM帧=${domFrames.length} 留痕帧=${traceFrames.length} 观察者记录=${moLog.length}`);
    say(`  F) chars 全等=${F.charsAllMatch} t(±5ms) 全等=${F.tAllMatch} 逐格=${JSON.stringify(align.map((x) => [x.charsDom, x.charsTrace, x.tDom, x.tTrace]))}`);
    say(`  回填=${JSON.stringify(shots.map((s) => [s.chars, s.rendered]))} 字体=${JSON.stringify([...new Set(shots.map((s) => s.font).filter(Boolean))])}`);
  }
  writeFileSync(join(OUT, 'record.json'), JSON.stringify({ home: HOME_, scale: SCALE, pad: PAD, rounds }, null, 2) + '\n');
  say('· 落盘 ' + join(OUT, 'record.json'));
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(700);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  if (existsSync(dir)) say('· chrome 临时目录没删净：' + dir);
}
