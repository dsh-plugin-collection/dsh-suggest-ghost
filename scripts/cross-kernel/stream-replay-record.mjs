#!/usr/bin/env node
/**
 * **真实像素版**逐帧截图（task-46 起，§19 增强）：回填后由**产品自己的 overlay 元素**渲染。
 *
 * 与上一版（§17 手绘重绘版）的本质差别：
 *   §17 = overlay 置空 + 我另画的 div（样式复刻自产品源码）
 *   本版 = 把**产品 overlay 元素的 textContent 逐帧回填**成实测内容 ⇒ 渲染者是产品代码
 *
 * ## §19 修的那件事（dsh-ox 2026-10-29 15:45 指出的已知限制）
 *
 * §18 只挂了一个 MutationObserver，而且挂在 overlay 自己身上、等它出现才装：
 * overlay 是**首绘时才有文本**，写 `textContent` 与改 `display` 在同一个任务里，而观察者
 * 回调是异步的 ⇒ 回调读到的常已是下一帧 / 回合结束后的空态；等它出现那个窗口里的变化也
 * 必然丢（而节奏只有 60–120ms）⇒ 中间帧文本一个都没抓到，只能退回 `final-prefix`（终态前缀）。
 * 于是"中间那格当时是不是这几个字"只是**假设**，不是观测 —— §18.5 已如实标注。
 *
 * 本版改成**两条独立通道同时记**，都在发问之前就开、都不依赖"回调里读到的时机"：
 *   ① tick：`setInterval` 8ms 读一次 `textContent` + `display`/`data-shown` + t
 *   ② mo：`MutationObserver` 挂 `documentElement`（childList / subtree / characterData）
 * 回填优先用**观测到的真实文本**（该帧 chars 与 t 都对得上的样本），取不到才退回终态前缀，
 * 每格标 `textSource=observed|final-prefix`（不冒充实测）。
 *
 * 三源的职责（断言 F / F2 / G）：
 *   F  `data-stream-frames`（#114，overlay 上的 DOM 属性：frame/final/chars/t，零正文）
 *      × console 留痕（`stream frame=… chars=… t=…`）—— 逐格比 chars 与 t（±5ms）
 *   F2 DOM 帧 × **观测样本**（tick / mo 两通道）—— chars 相等、t 差 ≤250ms（8ms 采样分辨率）
 *   G  "中间帧 = 终态前缀"这条假设本身 —— 用观测样本逐条判定，**可被推翻**
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
// 同一个会话连续发问（不每轮新建会话）：用来隔离"每轮新建会话 → overlay 被 detach →
// 首绘靠错峰补渲染（60/300/900ms）才发生"这条竞态。REUSE=1 时第 1 轮之后不再点 New session。
const REUSE = opt('reuse', '0') === '1';
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
  // ── 测试侧观测（§19 第三源）：**按 8ms 采样** + documentElement 上的观察者 ─────────
  //
  // 两条通道各自独立记样本，逐样本带 src，回填时按 src 分开报：
  //   ① tick：定时读当前状态（不关心"谁在什么时候发事件"）
  //   ② mo  ：documentElement 上的 childList/subtree/characterData（抓 overlay 被创建 + 每次文本变化）
  // 只按 text+display 去重，**不猜**哪次变化对应哪一帧 —— 帧归属由 DOM 帧的 {chars,t} 事后配对。
  obsSamples: [],
  obsTimer: null,
  obsMo: null,
  obsRunning: false,
  obsRead: (src) => {
    const el = window.__y.overlay();
    const text = el == null ? '' : (el.textContent ?? '');
    const disp = el == null ? 'absent' : (getComputedStyle(el).display + '/' + (el.dataset.shown ?? '-'));
    const last = window.__y.obsSamples[window.__y.obsSamples.length - 1];
    if (last != null && last.text === text && last.disp === disp) return;
    window.__y.obsSamples.push({ t: Math.round(performance.now()), text, disp, src });
  },
  obsStart: () => {
    if (window.__y.obsRunning) { window.__y.obsRead('restart'); return { already: true, samples: window.__y.obsSamples.length }; }
    window.__y.obsRunning = true;
    window.__y.obsRead('start');
    window.__y.obsTimer = setInterval(() => window.__y.obsRead('tick'), 8);
    window.__y.obsMo = new MutationObserver(() => window.__y.obsRead('mo'));
    window.__y.obsMo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return { already: false, samples: window.__y.obsSamples.length };
  },
  obsStop: () => {
    window.__y.obsRunning = false;
    if (window.__y.obsTimer != null) { clearInterval(window.__y.obsTimer); window.__y.obsTimer = null; }
    if (window.__y.obsMo != null) { try { window.__y.obsMo.disconnect(); } catch (e) { /* noop */ } window.__y.obsMo = null; }
    return { samples: window.__y.obsSamples.length };
  },
  finalText: () => {
    const el = window.__y.overlay();
    return el == null ? '' : (el.textContent ?? '');
  },
  // 回填：**产品自己的 overlay 元素**的文本，不是我画的 div
  backfill: (text) => {
    const el = window.__y.overlay();
    if (el == null) return null;
    // ⚠️ **终帧落地后产品会把 overlay 收起来**（hide() 走 display:none，源码注释写明
    //   "用 display 而非 visibility"）⇒ 只写 textContent 是**不可见**的：
    //   实测 B 精确=0 而 C 也全 0，就是这个形状（置空对、回填不显示）。
    //   重放必须把它重新显形。这是**测试侧的显形**，不是产品当时的画面 ⇒ 口径照旧写"重放图"。
    el.style.display = 'block';
    el.setAttribute('data-shown', '1');
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
  // 追加三句：建议被过滤（问句/助手口吻/过长）整轮就白跑，多备几句以提高"有帧可截"的命中率
  '我在写一个插件的跨内核回归脚本，想让它同时支持新旧两代内核，应该先验证哪些面？请按顺序讲。',
  '给一个本地仓库补 CI：要跑类型检查、单测和打包，用 Gitea Actions 该怎么写这个 workflow？',
  '怎么判断一个前端插件在某个内核版本上"只是没注册"还是"真的不支持"？请说明取证顺序。',
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
    if (!(REUSE && round > 1)) await ev('window.__y.newSession()');
    await ev('(() => { const n = window.__y.input(); if (n != null) n.focus(); return true; })()');
    await sleep(200);
    const consoleFrom = consoleLines.length;
    // 观测在**发问之前**就开：overlay 的首绘、每次文本变化、回合结束后的清空都要进来
    const obsFrom = await ev('window.__y.obsSamples.length');
    const obsStarted = await ev('window.__y.obsStart()');
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
    await ev('window.__y.obsStop()');
    const obsSamples = await ev(`window.__y.obsSamples.slice(${obsFrom})`);
    const domFrames = await ev('window.__y.domFrames()');
    const finalText = await ev('window.__y.finalText()');
    const traceFrames = consoleLines.slice(consoleFrom).filter((l) => /stream frame=/.test(l)).map((l) => {
      const m = l.match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
      return m === null ? null : { frame: Number(m[1]), final: m[2] === '1', chars: Number(m[3]), t: Number(m[5]) };
    }).filter(Boolean);
    // 诊断：DOM=null 有两种完全不同的成因 —— ①overlay 不在文档里（没 attach 到 composer）
    // ②在文档里但没写 data-stream-frames（#114 的写入口没跑到）。不分开就只能猜。
    const probe = await ev(`(() => {
      const el = window.__y.overlay();
      const all = window.__y.qa('#dsh-suggest-ghost-overlay');
      const tb = window.__y.input();
      return { overlays: all.length, inDoc: el != null,
        connected: all.map((x) => x.isConnected),
        hasDataset: el == null ? null : (el.dataset.streamFrames != null),
        datasetLen: el == null || el.dataset.streamFrames == null ? null : el.dataset.streamFrames.length,
        overlayTextLen: el == null ? null : (el.textContent ?? '').length,
        overlayDisp: el == null ? null : getComputedStyle(el).display,
        inputPhase: tb == null ? null : (tb.dataset.phase ?? '-') };
    })()`);
    if (domFrames == null || traceFrames.length === 0) {
      rounds.push({ round, ok: false, why: domFrames == null ? 'no-data-stream-frames' : 'no-trace-frames',
        obsLen: (obsSamples ?? []).length, probe,
        console: consoleLines.slice(consoleFrom),
        obsSeq: (obsSamples ?? []).map((x) => ({ dt: x.t, chars: x.text.length, disp: x.disp, src: x.src })) });
      say(`· 轮 ${round}: 跳过 —— DOM=${JSON.stringify(domFrames)} 留痕帧=${traceFrames.length} 诊断=${JSON.stringify(probe)}`);
      continue;
    }
    // ⚠️ **顺序**：必须**先量几何、再清空 overlay**。
    //   上一版在清空之后才量 bbox ⇒ 空 overlay 的盒子塌成 0 高，clip 是个退化矩形，
    //   于是每张截图都是"什么都没有的那块"，断言 C/D 全读成 0 ——
    //   而渲染本身是好的（rendered=6/20/20 与 chars 一致）。**测量几何错，不是被测对象错。**
    const geo = await ev(`(() => {
      const el = window.__y.overlay(); const tb = window.__y.input();
      if (el == null || tb == null) return null;
      const r = el.getBoundingClientRect(); const ir = tb.getBoundingClientRect();
      return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, input: { x: ir.x, y: ir.y, w: ir.width, h: ir.height },
        charsNow: (el.textContent ?? '').length };
    })()`);
    if (geo == null || !(geo.box.h > 0 && geo.box.w > 0)) {
      rounds.push({ round, ok: false, why: geo == null ? 'no-geometry' : 'collapsed-box' });
      continue;
    }
    // 裁切贴 overlay 自身 bbox + 24px（§17.8：不要盲目放大 clip，会圈进工具条）
    const clip = { x: Math.max(0, Math.round(geo.box.x - 12)), y: Math.max(0, Math.round(geo.box.y - PAD)),
      width: Math.round(geo.box.w + 24), height: Math.round(geo.box.h + PAD * 2) };
    const shots = [];
    // 文字行窗口：回填第一帧后量它的**文字矩形 y 范围**，之后所有格子都只在这几行里数墨迹。
    // 为什么必须这样：overlay 的 bbox 覆盖整个输入区，把**圆角边框**（实测每行 80–86 像素）
    // 和光标都圈进去了 ⇒ 置空格"墨迹 953"看着像失败，其实那格完全正确（只有输入框与光标）。
    // ⇒ 判据要量"那一行字"，不是"那个盒子"。
    let textRowWin = null;
    // 起点格：清空**产品 overlay** 自身（断言 B 的底），用**同一块**裁切框
    await ev('(() => { const el = window.__y.overlay(); if (el != null) el.textContent = ""; return true; })()');
    await sleep(150);
    const s0 = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    writeFileSync(join(OUT, `r${round}-00-blank.png`), Buffer.from(s0.data, 'base64'));
    shots.push({ png: `r${round}-00-blank.png`, chars: 0, source: 'blank' });
    // 逐帧回填：内容 = ① **观测到**的该长度真实文本（t 对得上、优先显示中的那条）；
    // ② 取不到才用**终态文本的前缀**。渲染者是**产品 overlay 元素自己**。
    // ⚠️ 观测已在本步之前停止（obsStop）⇒ 回填写的 `display:block` 与 textContent
    //    不会被记成"观测"，textSource 与观测两列因此互不污染。
    const pickObserved = (chars, tDom) => {
      const cand = (obsSamples ?? []).filter((s) => s.text.length === chars);
      if (cand.length === 0) return null;
      // 窗口 600ms：本轮实测"首绘落后终帧"最晚 375ms，250ms 会把**真的观测到的那次上屏**
      // 判成没观测到（§19 第一版就踩了：轮1 的终态文本 +375ms 被窗口挡掉，退回前缀兜底），
      // 那等于把更弱的证据当成更强的说法。用 600ms 覆盖它，配对仍要求 chars 严格相等。
      const near = cand
        .filter((s) => Math.abs(s.t - tDom) <= 600)
        .sort((a, b) => {
          const ab = a.disp.startsWith('block') ? 0 : 1;
          const bb = b.disp.startsWith('block') ? 0 : 1;
          if (ab !== bb) return ab - bb;
          return Math.abs(a.t - tDom) - Math.abs(b.t - tDom);
        });
      return near[0] ?? null;
    };
    for (const [i, f] of domFrames.entries()) {
      const observed = pickObserved(f.chars, f.t);
      const useText = observed != null ? observed.text : finalText.slice(0, f.chars);
      const srcKind = observed != null ? 'observed' : 'final-prefix';
      const st = await ev(`window.__y.backfill(${JSON.stringify(useText)})`);
      if (textRowWin == null && st?.textRect != null) textRowWin = [st.textRect.y, st.textRect.y + st.textRect.h];
      await sleep(150);
      const nm = `r${round}-${String(i + 1).padStart(2, '0')}-f${f.frame}c${f.chars}.png`;
      const sh = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      writeFileSync(join(OUT, nm), Buffer.from(sh.data, 'base64'));
      shots.push({ png: nm, chars: f.chars, frame: f.frame, final: !!f.final, tDom: f.t,
        tObserver: observed == null ? null : observed.t, textSource: srcKind,
        obsSrc: observed == null ? null : observed.src,
        obsDeltaMs: observed == null ? null : observed.t - f.t,
        textIsFinalPrefix: finalText.startsWith(useText),
        rendered: st?.chars ?? 0, font: st ? st.size + ' ' + st.font : null, measureRect: st?.textRect ?? null });
    }
    // 断言 F：两条独立来源逐格对齐（chars 与 t，容差 ±5ms）
    const align = domFrames.map((f, i) => ({
      frame: f.frame, charsDom: f.chars, charsTrace: traceFrames[i]?.chars ?? null,
      tDom: f.t, tTrace: traceFrames[i]?.t ?? null,
      charsMatch: traceFrames[i]?.chars === f.chars,
      tMatch: traceFrames[i] != null && Math.abs(traceFrames[i].t - f.t) <= 5,
    }));
    const F = { countDom: domFrames.length, countTrace: traceFrames.length,
      countObserver: (obsSamples ?? []).length,
      rows: align, charsAllMatch: align.every((x) => x.charsMatch), tAllMatch: align.every((x) => x.tMatch) };
    // 断言 F2（§19）：**观测到的中间帧文本**逐格对得上 DOM 帧 —— 这正是 dsh-ox 指出
    // 「任务书设想的 DOM × 观察者那一列」在 §18 没成立的那一列。
    const align2 = domFrames.map((f) => {
      const o = pickObserved(f.chars, f.t);
      return { frame: f.frame, charsDom: f.chars, tDom: f.t,
        obsChars: o == null ? null : o.text.length, obsT: o == null ? null : o.t,
        obsDeltaMs: o == null ? null : o.t - f.t, obsSrc: o == null ? null : o.src,
        obsIsFinalPrefix: o == null ? null : finalText.startsWith(o.text) };
    });
    const F2 = { rows: align2, allObserved: align2.every((r) => r.obsChars === r.charsDom) };
    // 断言 G（§19）：**"中间帧 = 终态前缀"这条假设本身**，现在第一次可判定（也可被推翻）。
    // 只存数字与布尔，不存正文（与 #113 的"零正文"同口径）。
    const distinct = [];
    for (const s of obsSamples ?? []) {
      if (s.text === '') continue;
      if (!distinct.some((d) => d.chars === s.text.length && d.t === s.t)) {
        distinct.push({ chars: s.text.length, t: s.t, src: s.src, disp: s.disp,
          isFinalPrefix: finalText.startsWith(s.text) });
      }
    }
    const G = { distinctNonEmpty: distinct.length,
      allObservedAreFinalPrefix: distinct.every((d) => d.isFinalPrefix),
      rows: distinct };
    // 原始样本序列（相对首帧时刻；只有 t/chars/disp/src，**没有正文**）。
    // 它回答的是"那一刻屏幕上到底有没有字"：absent = overlay 还没进文档，
    // 空串 + display:none/0 = 进了文档但没画，非空 = 真的画了这么多字。
    const t0 = domFrames[0].t;
    const obsSeq = (obsSamples ?? []).map((x) => ({ dt: x.t - t0, chars: x.text.length, disp: x.disp, src: x.src }));
    const firstNonEmpty = obsSeq.find((x) => x.chars > 0) ?? null;
    rounds.push({ round, ok: true, ask: q.slice(0, 18), clip, geo, shots, F, F2, G, textRowWin,
      domFrames, traceFrames, obsLen: (obsSamples ?? []).length, obsStarted, probe,
      obsSeq, firstNonEmpty, console: consoleLines.slice(consoleFrom) });
    say(`· 轮 ${round}: DOM帧=${domFrames.length} 留痕帧=${traceFrames.length} 观测样本=${F.countObserver}（tick+mo）`);
    say(`  F) chars 全等=${F.charsAllMatch} t(±5ms) 全等=${F.tAllMatch} 逐格=${JSON.stringify(align.map((x) => [x.charsDom, x.charsTrace, x.tDom, x.tTrace]))}`);
    say(`  F2) 观测逐格=${JSON.stringify(align2.map((x) => [x.charsDom, x.obsChars, x.obsDeltaMs, x.obsSrc]))} 全观测=${F2.allObserved}`);
    say(`  G) 观测到的非空文本 ${distinct.length} 种：${JSON.stringify(distinct.map((d) => [d.chars, d.t, d.isFinalPrefix ? 'prefix' : 'NOT-prefix']))}`);
    const tFirst = domFrames[0].t; const tLast = domFrames[domFrames.length - 1].t;
    say(`  首绘=${firstNonEmpty == null ? 'none' : `+${firstNonEmpty.dt}ms（终帧 ${tLast - tFirst}ms 之后 ${firstNonEmpty.dt - (tLast - tFirst)}ms）chars=${firstNonEmpty.chars}`}`
      + ` 样本=${JSON.stringify(obsSeq.map((x) => [x.dt, x.chars, x.disp]))}`);
    say(`  回填=${JSON.stringify(shots.map((s) => [s.chars, s.rendered]))} 字体=${JSON.stringify([...new Set(shots.map((s) => s.font).filter(Boolean))])}`);
  }
  writeFileSync(join(OUT, 'record.json'), JSON.stringify({
    home: HOME_, scale: SCALE, pad: PAD,
    // §19 重跑覆盖了 §18 的同一份记录：写明取代关系，别让旧结论无声消失
    supersedes: 'scripts/cross-kernel/out/replay/record.json（§18 @963d824：中间帧文本走 final-prefix 兜底）',
    rounds,
  }, null, 2) + '\n');
  say('· 落盘 ' + join(OUT, 'record.json'));
} finally {
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(700);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  if (existsSync(dir)) say('· chrome 临时目录没删净：' + dir);
}
