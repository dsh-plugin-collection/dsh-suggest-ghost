#!/usr/bin/env node
/**
 * 流式投递的 **composer 区域连拍录制**（#108 / task-42）。
 *
 * ## 为什么不是"整页截图 + 脚本自己的时钟"
 *
 * 两个坑都是本仓用实测换回来的：
 *  1. **整页会带进 profile 内容、会话名、URL token**（本仓已泄漏过两次）⇒ 只截
 *     composer 的包围盒（判据与尺寸照 `cross-kernel/gui-round.mjs` 的 screenshotRegion）。
 *  2. **页外轮询会把两帧读成一次变化**（§14 那条坑）⇒ 时刻一律取自**页内
 *     `performance.now()`**，而且烧进图里的时刻用的是**这一帧被绘制的那一刻**页内读的
 *     `performance.now()`（`requestAnimationFrame` 里读，不是 Node 侧的到达时间）
 *     ⇒ 不会出现"图是 A 时刻的画面、字是 B 时刻的数"这种自相矛盾。
 *
 * ## 时钟换算
 *
 * 页内 `performance.now()` 与 CDP 事件自带的时间戳在同一浏览器进程内可比，实测一次
 * `performance.timeOrigin` 就把两侧对齐；录制里所有对外报出的时刻都是**页内基准**。
 *
 * ## 每一轮产出的东西（交付要求 4/5）
 *
 * `frames: [{kind, tPage, chars, text, png}]` —— kind 是 `stream-frame` / `whole-block` /
 * `pre`；每帧的 `tPage` 是页内毫秒。时刻表与"看得出/看不出"的判据写在 stdout 的 JSON 里，
 * 由 `stream-gif-stack.mjs`（`--on/--off` 两跑目录）消费，不在这里下结论。
 *
 * 用法：node scripts/cross-kernel/stream-gif-record.mjs --home ~/xk-gif-0212 --label on \
 *         --rounds 3 --ws ~/xk-gif-ws [--mode wait-ghost]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const LABEL = opt('label', 'run');
const ROUNDS = Number(opt('rounds', 3));
const WS = opt('ws', join(homedir(), 'xk-gif-ws')).replace(/^~/, homedir());
const OUTDIR = opt('out', join('scripts', 'cross-kernel', 'out', `gif-${LABEL}`));
const MAX_WAIT_MS = Number(opt('maxWaitMs', 60_000));
const BURST_MS = Number(opt('burstMs', 2_000));
if (HOME_ === '') throw new Error('必须给 --home');
if (!existsSync(join(HOME_, 'sbx.pid'))) throw new Error('没有 sbx.pid：实例不是 dev-sandbox 起的，拒绝录制（防误连 live）');

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
const secrets = new Set();
const redact = (s) => {
  let o = String(s);
  for (const x of secrets) if (x.length > 4) o = o.split(x).join('«redacted»');
  return o.replace(/([?&]token=)[^\s"'\\]+/g, '$1«redacted»');
};
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

/** 页内公共件：查询、模态清理、工作区第二路（判据全照 gui-round，别再自己发明）。 */
const HELPERS = `
window.__g = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  byText: (needle) => window.__g.qa('button, [role=button], [role=textbox]').find((n) => window.__g.name(n).includes(needle)),
  composer: () => {
    const all = window.__g.qa('[data-composer-input]');
    // ⚠️ 必须把 phase=inert 的隐藏 composer 排掉：0.2.1 实测页上有两个 [data-composer-input]，
    //    focus 打在不渲染的那个上面 ⇒ 之后 insertText 落进 document、draft 空、回合根本没提交
    //    （task-42 实测：draft='' 而 ticks 一路涨，我一度以为"产品没出幽灵"）。
    const live = all.filter((n) => n.dataset.phase !== 'inert' && n.offsetParent !== null);
    return live[0] ?? all.find((n) => n.dataset.phase !== 'inert') ?? document.querySelector('[contenteditable=true]') ?? all[0] ?? null;
  },
  ghostText: () => {
    // 宿主可能还没创建 overlay：先戳一下插件自己的挂载入口（幂等），再读。
    // 判据不变（data-shown=1 + 可见 + 文本非空），只是去掉'元素还不存在'这一类假阴。
    try { window.__GHOST_ENSURE?.(); } catch { /* 没这个钩子就算了 */ }
    const el = window.__g.q('#dsh-suggest-ghost-overlay');
    if (el == null) return { shown: false, text: '' };
    const cs = getComputedStyle(el);
    return { shown: cs.display !== 'none' && el.offsetParent !== null && el.getAttribute('data-shown') === '1', text: (el.textContent ?? '') };
  },
  scrollBox: () => window.__g.q('[data-input-scroll]') ?? window.__g.composer(),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__g.wait(120); } return false; },
  dismiss: async () => {
    // 「继续」是首启**「预览版说明」模态**的确认按钮（gui-round 早就带着这个标签）。
    // ⚠️ 但**工作区选择器里也有一个「继续」**，点它会选中列表当前目录而不是我们的 ws
    //   （§11 那条竞态）⇒ 必须按 aria-label/textContent 把 picker **排除**在外。
    const labels = ['继续', '同意', '我已阅读', '保留当前显示', '暂不开启', '以后再说', '知道了',
      '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    const PICKER = /选择工作区目录|添加工作区|选择工作区|workspace director|Choose workspace|Select workspace/i;
    const closed = [];
    for (let k = 0; k < 10; k += 1) {
      let hit = false;
      for (const d of window.__g.qa('[role=dialog]')) {
        if (PICKER.test(d.textContent ?? '')) continue;   // picker 交给 setupWorkspace，绝不在这里点
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__g.name(x).includes(L)))
          ?? bs.find((x) => window.__g.name(x).includes('关闭') || window.__g.name(x) === '×');
        // querySelector/find 找不到给 undefined，但下面这条兜底可能给 null ⇒ 统一 != null
        if (b != null) { b.click(); closed.push((d.getAttribute('aria-label') ?? '').slice(0, 16)); hit = true; await window.__g.wait(240); }
      }
      if (!hit) break;
    }
    return { closed, dialogsLeft: window.__g.qa('[role=dialog]').length };
  },
  // ── 工作区：新工作区**不在"最近用过"列表里**（列表是目录树，按名字匹配必然找不到），
  //    可靠的一条是「编辑路径 → 打字 → 打开」。⚠️ 切换后**没有 <input>**：实测
  //    dialogs=1 / inputs=0，可编辑面是 **contenteditable** ⇒ 只能走 CDP 真实输入
  //    （insertText 对 contenteditable 有效；往 <input> 塞 .value 反而不被 React 认）。
  openWsDialog: async () => {
    await window.__g.dismiss();
    const c = window.__g.composer();
    if (c != null && c.dataset.phase !== 'inert') return { ready: true, via: 'already' };
    const o = document.querySelector('[aria-label="添加工作区"]') ?? document.querySelector('[aria-label="Add workspace"]')
      ?? window.__g.byText('选择工作区') ?? window.__g.byText('Add workspace');
    if (o == null) return { ready: false, why: 'no-opener' };
    o.click();
    const opened = await window.__g.until(() => window.__g.q('[role=dialog]') != null, 12000);
    if (!opened) return { ready: false, why: 'picker-not-open' };
    const name = window.__g.name(window.__g.q('[role=dialog]'));
    // 先试列表里的同名行（轮询 = 目录树是异步加载的；关掉重开再判一次，§11 那条竞态）
    const findRow = () => [...window.__g.q('[role=dialog]').querySelectorAll('button, [role=button], [role=treeitem], li, [title]')]
      .find((n) => window.__g.name(n) === window.__g.wsName || (n.getAttribute?.('title') ?? '') === window.__g.wsName);
    let row = null;
    let got = await window.__g.until(() => { row = findRow(); return row != null; }, 9000);
    if (!got) {
      const close = [...window.__g.q('[role=dialog]').querySelectorAll('button')].find((b) => /取消|Cancel/.test(window.__g.name(b)));
      if (close != null) { close.click(); await window.__g.wait(500); }
      o.click();
      await window.__g.until(() => window.__g.q('[role=dialog]') != null, 8000);
      got = await window.__g.until(() => { row = findRow(); return row != null; }, 9000);
    }
    if (got) {
      row.click();
      await window.__g.wait(600);
      const open = [...window.__g.q('[role=dialog]').querySelectorAll('button, [role=button]')]
        .filter((b) => /打开|Open/i.test(window.__g.name(b))).find((b) => !b.disabled) ?? null;
      if (open != null) open.click();
      const ready = await window.__g.until(() => (window.__g.composer()?.dataset.phase ?? 'inert') !== 'inert', 15000);
      return { ready, via: 'row' };
    }
    const edit = [...window.__g.q('[role=dialog]').querySelectorAll('button, [role=button]')]
      .find((b) => window.__g.name(b).includes('编辑路径'));
    if (edit == null) return { ready: false, why: 'no-edit-path', dialogName: name.slice(0, 24) };
    edit.click();
    await window.__g.wait(700);
    const focus = await window.__g.focusEditable();
    return { ready: false, why: 'need-path-typed', editPath: true, focused: focus };
  },
  focusEditable: () => {
    const d = window.__g.q('[role=dialog]');
    if (d == null) return { ok: false, why: 'no-dialog' };
    const cand = [...d.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true], [role=textbox]')];
    const c = cand.find((n) => !n.disabled && n.offsetParent !== null) ?? null;
    if (c == null) return { ok: false, why: 'no-dialog-or-input' };
    c.focus();
    return { ok: true, tag: c.tagName };
  },
  newSession: async () => {
    await window.__g.dismiss();
    const b = window.__g.byText('新会话') ?? window.__g.byText('新建会话') ?? window.__g.byText('New session')
      ?? [...document.querySelectorAll('[aria-label]')].find((n) => /New session|新建会话/.test(n.getAttribute('aria-label') ?? ''));
    if (b != null) { b.click(); await window.__g.wait(1400); }
    return b != null;
  },
  // ── 连拍器：**在 requestAnimationFrame 里读文本与 performance.now()**，
  //    这样"烧进图里的时刻"就是"这一帧被绘制的时刻"，不是 Node 侧的到达时刻。
  burst: null,
  // 时刻取自**页内 performance.now()**，不取我脚本自己的时钟：页外轮询会把两帧读成
  // 一次变化（§14 那条坑）。但⚠️ **requestAnimationFrame 会被后台/离屏页节流**
  // （task-42 实测：rAF 版每轮只抓到 1 个事件、span=0ms，而同一轮页内 console 明确
  // 收到了 stream frame ⇒ 不是产品没出帧，是**采样器被节流了**）。
  // ⇒ 改用 **setTimeout 循环 + 每拍写心跳**：心跳数就是这一轮实际采到的拍数，
  //   被节流会表现为"心跳很少"，绝不会再伪装成"文本只变了一次"。
  // 图像由 Node 侧 screencast 提供，靠 tsPage 与 tsMetadata 一次性对齐换算到页内基准。
  startBurst: (maxMs) => {
    // ⚠️ 三条实测教训，都在这段里，别再改回去：
    //  1) **只返回 true**：如果 await 一个会自己跑完的 promise，Node 侧的打字/回车会全部
    //     落在录制之后 ⇒ 每轮只抓到 1 拍、看起来像"产品从没出过幽灵"。
    //  2) **窗口必须盖住整个回合**：宿主在 turn/end 之后才开始生成建议，一次真回合实测
    //     10~20 秒；burst 开 14s 会在建议到达前就停表（同一个坑的另一种表现）。
    //  3) **时刻一律页内**：文本与 performance.now() 在同一行里成对写，
    //     与 console 的 "stream frame … t=" 同基准、可直接对账。图像不参与时间轴
    //     （headless 不推 screencast，抓图往返实测 30~45ms），装配时按时刻就近取图并记误差。
    window.__g.burst = { events: [], prev: null, t0: performance.now(), done: false };
    const b = window.__g.burst;
    const read = () => { const g = window.__g.ghostText(); return g.shown ? g.text : ''; };
    b.prev = read();
    b.events.push({ tPage: 0, chars: b.prev.length, text: b.prev });
    const tick = () => {
      const cur = window.__g.burst;
      if (cur == null || cur.done) return;
      const key = read();
      if (key !== cur.prev) {
        cur.prev = key;
        cur.events.push({
          tPage: Math.round((performance.now() - cur.t0) * 100) / 100,
          chars: key.length,
          text: key,
        });
      }
      if (performance.now() - cur.t0 > maxMs) { cur.done = true; return; }
      setTimeout(tick, 8);
    };
    setTimeout(tick, 0);
    return true;
  },
  // 只读到"读表这一刻"为止的事件：burst 比回合活得久，Node 侧再按窗口夹一次，
  // 免得把收尾时的显隐翻转当成本轮最后一帧（task-42 实测：真实 ~150ms 曾被读成 13726ms）。
  drainBurst: () => {
    const b = window.__g.burst;
    if (b == null) return { events: [], done: false, cut: 0 };
    const cut = performance.now() - b.t0;
    return { events: b.events.filter((e) => e.tPage <= cut), done: b.done, cut: Math.round(cut) };
  },
};
`;

const dir = join(tmpdir(), `xk-gif-chrome-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const cdpPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const pending = new Map();
/** 页内 console 的流式留痕（宿主侧看不到"帧到没到浏览器"）。 */
const consoleLines = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : String(a.description ?? ''))).join(' ');
    if (/suggest-ghost/.test(text)) consoleLines.push({ level: m.params.type, text: text.slice(0, 200) });
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails !== undefined) throw new Error(redact(String(r.exceptionDetails.exception?.description ?? 'page error')).slice(0, 200));
  return r.result.value;
};

mkdirSync(OUTDIR, { recursive: true });
const rounds = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  await send('Page.navigate', { url: urlOf() });
  await sleep(9000);
  await evaluate(`(async () => { ${HELPERS} await window.__g.dismiss(); return true; })()`);
  await evaluate(`window.__g.wsName = ${JSON.stringify(WS.split('/').pop())};`);
  let wsState = await evaluate('window.__g.openWsDialog()');
  say(`· 工作区 = ${JSON.stringify(wsState)}`);
  if (wsState?.why === 'need-path-typed') {
    // contenteditable（实测 inputs=0）⇒ 只能走真实输入事件；.value 塞进去宿主不认。
    await send('Input.insertText', { text: WS });
    await sleep(500);
    wsState = await evaluate(`(async () => {
      const d = window.__g.q('[role=dialog]');
      const open = d == null ? null : [...d.querySelectorAll('button, [role=button]')]
        .filter((b) => /打开|Open/i.test(window.__g.name(b))).find((b) => !b.disabled) ?? null;
      if (open != null) open.click();
      return { via: 'path-typed', ready: await window.__g.until(() => (window.__g.composer()?.dataset.phase ?? 'inert') !== 'inert', 20000) };
    })()`);
    say(`· 工作区第二路 = ${JSON.stringify(wsState)}`);
  }
  const hydrated = await evaluate(`window.__g.until(() => (window.__g.composer()?.dataset.phase ?? 'inert') !== 'inert', 30000)`);
  say(`· 首屏水合（composer 就绪）= ${JSON.stringify(hydrated)}`);
  if (hydrated !== true) {
    say('❌ composer 起不来：不录（拒绝交"空帧也说不清"的东西）。工作区状态见上一行。');
    process.exitCode = 5;
  } else {
  const clip0 = await evaluate(`(() => { const n = window.__g.scrollBox(); if (n == null) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  say(`· composer 包围盒（只截这块，不截整页）= ${JSON.stringify(clip0)}`);
  const clipRect = { x: Math.max(0, clip0.x - 26), y: Math.max(0, clip0.y - 150), width: clip0.w + 52, height: clip0.h + 196 };
  // ── screencast：图像由浏览器连续推帧（页内绘制时刻），文本/时刻由页内 rAF 循环记录；
  //    两边用一次性 tsPage <-> tsMetadata 对齐换算，**烧进图里的仍是页内时刻**。
  const cast = [];

  const onScreencast = (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    cast.push({ metadataTs: m.params.metadata.timestamp, tsPage: m.params.metadata.timestamp * 1000, data: m.params.data, deviceScaleFactor: m.params.deviceScaleFactor });
    void send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
  };
  const baseOnmessage = ws.onmessage;
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); onScreencast(m); if (baseOnmessage) baseOnmessage(ev); };
  const QUESTIONS = [
    '怎么查看某个端口被哪个进程占用？给一条命令。',
    'git worktree 和普通 clone 的区别是什么？一句话回答。',
    '把当前目录最近一次提交撤销，命令是什么？',
  ];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const q = QUESTIONS[(round - 1) % QUESTIONS.length];
    await evaluate('window.__g.newSession()');
    const focused = await evaluate(`(() => { const n = window.__g.q('[role="textbox"]') ?? window.__g.composer(); if (n == null) return false; n.focus(); return true; })()`);
    if (!focused) { rounds.push({ round, ok: false, why: 'no-composer' }); continue; }
    await sleep(150);   // focus 之后留一帧时间，否则 insertText 偶尔落不进 contenteditable
    // ⚠️ console 是**整页累积**的：上一版每轮都 slice(-8) 全局尾部，
    //   于是轮 2 装着轮 1 的帧、轮 3 装着 1+2 的帧，提前量被读成 71 秒。
    //   必须按轮切：记下起点的下标，只取本轮新增的那些行。
    const consoleFrom = consoleLines.length;
    // ⚠️ **burst 必须在"提交"之前起、且起点贴近回车**：上一版在 insertText 之前起 burst，
    //   而 insertText + 两次 keyDown/keyUp 各是一趟 CDP 往返（实测合计 ~240ms），
    //   回合又只要 ~11 秒 ⇒ burst 相对页内时钟偏后，宿主那几帧落在窗口**之前**，
    //   于是 burst 一条都没抓到（它报的"变化"其实是**下一轮**的幽灵）。
    //   现在：burst 就在回车前一刻起，t0 与回合起点贴齐；帧的绝对时刻另有 console 的 t= 可对账。
    await send('Input.insertText', { text: q });
    await sleep(120);
    await evaluate(`window.__g.startBurst(${BURST_MS})`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    // burst 由页内计时；Node 侧按墙钟等本轮窗口过去再读一次。
    // ⚠️ 不要用 until(() => burst.done) 去等：那趟往返会占住回合，把打字推到录制之外。
    await sleep(BURST_MS + 2500);
    const drained = await evaluate('window.__g.drainBurst()');
    const events = drained?.events ?? [];
    const written = [];
    for (const e of events) {
      // 图在**读完事件之后**才抓：那时画面已稳定（回合结束、文本不再变），
      // 所以这一张是"该事件所示文本"的真实 composer 画面，但**不是该时刻的像素**。
      // ⇒ 图按时序贴、内容按文本、时刻全用页内真值；不假称像素与时刻同源。
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clipRect, scale: 1 } });
      const seq = String(written.length + 1).padStart(2, '0');
      const name = 'r' + round + '-f' + seq + '-t' + Math.round(e.tPage) + 'c-' + e.chars + '.png';
      writeFileSync(join(OUTDIR, name), Buffer.from(shot.data, 'base64'));
      written.push({ tPage: e.tPage, chars: e.chars, text: e.text, png: name, shotAfterReadMs: BURST_MS + 2500 - Math.round(e.tPage) });
    }
    const rec = { round, ok: events.length > 0, question: q.slice(0, 16),
      spanMs: written.length > 1 ? Math.round(written.at(-1).tPage - written[0].tPage) : 0,
      frames: written, streamConsoleLines: consoleLines.slice(consoleFrom).filter((l) => /stream frame=/.test(l.text)).map((l) => l.text) };
    rounds.push(rec);
    say(`· 轮 ${round}: 页内变化=${written.length} 步长=${JSON.stringify(written.map((f) => f.chars))} span=${drained.spanMs}ms 时刻=${JSON.stringify(written.map((f) => Math.round(f.tPage)))}`);
  }
  writeFileSync(join(OUTDIR, 'record.json'), JSON.stringify({ label: LABEL, home: HOME_, clipRect, rounds, consoleLines: consoleLines.filter((l) => /stream /.test(l.text)).slice(-40) }, null, 2) + '\n');
  say(`· 明细落 ${OUTDIR}/record.json（帧 ${rounds.reduce((a, r) => a + (r.frames?.length ?? 0), 0)} 张）`);
  }
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(700);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  if (existsSync(dir)) say('· chrome 临时目录没删净（需显式清）：' + dir);
}
