#!/usr/bin/env node
/**
 * 流式投递的**真实提前量**测量（#108 / task-39 交付的那个数字）。
 *
 * ## 测的是什么
 *
 * 用户能感知的那一件事：**从"提交问题"到"composer 里出现第一个幽灵字符"的时间**
 * （T_first），以及"到文本不再变化"的时间（T_settled）。
 *  - 开关关：字符是一次性整块出现的 ⇒ T_first ≈ T_settled。
 *  - 开关开：字符分几批出现 ⇒ T_first 提前，提前量 = T_settled − T_first。
 * 两个数都在**同一个页面时钟**上量（CDP 轮询），不跨宿主/浏览器混时钟。
 *
 * ## 为什么不看宿主日志的时间戳
 *
 * 宿主 `push landed ... at=` 与页面 `performance.now()` 不同源，混用会把量具的
 * 抖动算进结论。这里只用页面侧观测；宿主日志只用来**核对**（增量帧是否落盘、
 * 每轮几条流），不参与时间计算。
 *
 * ## 采样密度
 *
 * 单次 `Runtime.evaluate` 往返实测 1~2ms（#38 同一台机器），所以 15ms 轮询足够
 * 分辨 60ms 的限频窗口；采样间隔写在这里并被打印出来，读数的人能自己判断分辨率。
 *
 * 用法：node scripts/stream-leadtime-measure.mjs --home ~/xk-021-stream --rounds 10 [--label on]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
if (HOME_ === '') throw new Error('必须给 --home');

/**
 * ⚠️ **硬前置：确认要连的实例确实是这个沙箱起的。**
 *
 * 来历（2026-10-28 实测事故）：为了绕开"dev-sandbox 每次把插件挂回软链"，有人手工
 * spawn 了一个实例却**忘了设 DSH_HOME** ⇒ 实例以用户真实 ~/.dsh 启动，那一轮的
 * 测量数据全部来自 live（作废），还在真实家目录里留下 16 个会话目录。
 * 技能第 1 条说的就是这个坑，而"我记得设"不是防线 ⇒ 这里直接判死：
 * pid 的 DSH_HOME 不等于 --home 就拒绝测量。
 */
const assertSandboxOwnsInstance = () => {
  const pidFile = join(HOME_, 'sbx.pid');
  if (!existsSync(pidFile)) throw new Error(`没有 ${pidFile}：实例不是 dev-sandbox 起的，拒绝测量（防误连 live）`);
  const pids = readFileSync(pidFile, 'utf8').split(/\s+/).filter(Boolean);
  const matched = pids.filter((p) => {
    try {
      return readFileSync(`/proc/${p}/environ`, 'latin1').split('\0').includes(`DSH_HOME=${HOME_}`);
    } catch { return false; }
  });
  if (matched.length === 0) {
    throw new Error(`pidfile 里没有进程以 DSH_HOME=${HOME_} 运行 ⇒ 实例已退出或不属于本沙箱，拒绝测量`);
  }
  return matched;
};
const sandboxPids = assertSandboxOwnsInstance();

/**
 * **越界自检**：真实 `~/.dsh` 里不许留下本次工作区的痕迹。
 *
 * 分两档，因为"内容里出现过我的路径"与"我在那里建了东西"是两件事：
 *  - `hard`：会话目录 / 工作区记录 —— 只有我才会造出来，出现即判失败（退出码 3）。
 *  - `soft`：**内容级**提及（例如用户活跃会话的投影缓存里存着一份工作区清单快照）——
 *    只报告不失败。实测两处就是这种，且几秒前刚被 live 改写过；去改用户的活跃缓存
 *    比留着一条陈旧路径字符串危险得多。
 *
 * @returns {{ hard: string[], soft: string[] }} 两档命中清单（路径，不含任何正文）。
 */
const assertNoBleedIntoRealHome = () => {
  const real = join(homedir(), '.dsh');
  const slug = `--${WS.replace(/^\//, '').replaceAll('/', '-') }--`;
  const hard = [];
  const soft = [];
  const sessionsRoot = join(real, 'sessions');
  if (existsSync(sessionsRoot) && existsSync(join(sessionsRoot, slug))) hard.push(`sessions/${slug}`);
  const projRoot = join(real, 'storages', 'session_projcache', 'sessions');
  if (existsSync(projRoot)) {
    for (const name of readdirSync(projRoot)) {
      const file = join(projRoot, name);
      let body = '';
      try { body = readFileSync(file, 'utf8'); } catch { continue; }
      if (!body.includes(WS)) continue;
      const id = name.replace(/^session-/, '').replace(/\.json$/, '');
      const stillExists = existsSync(join(sessionsRoot, slug))
        || readdirSync(sessionsRoot).some((ws) => existsSync(join(sessionsRoot, ws, `session-${id}`)) || existsSync(join(sessionsRoot, ws, id)));
      if (!stillExists) hard.push(`session_projcache/${name}（悬挂：会话目录已不存在）`);
      else soft.push(`session_projcache/${name}（用户活跃会话的缓存快照，未改动）`);
    }
  }
  const wsFile = join(real, 'storages', 'workspace.json');
  if (existsSync(wsFile)) {
    try {
      const doc = JSON.parse(readFileSync(wsFile, 'utf8'));
      const mine = Object.entries(doc?.tables?.workspaces ?? {}).filter(([, w]) => w?.path === WS);
      for (const [id] of mine) hard.push(`workspace.json 记录 ${id.slice(0, 8)}（path 指向本次工作区）`);
    } catch { /* 读不到就算不了，交给 hard 目录检查兜底 */ }
  }
  return { hard, soft };
};

const ROUNDS = Number(opt('rounds', 10));
const LABEL = opt('label', 'run');
const WS = opt('ws', join(homedir(), 'xk-probe-ws')).replace(/^~/, homedir());
const SAMPLE_MS = Number(opt('sampleMs', 15));
const MAX_WAIT_MS = Number(opt('maxWaitMs', 75_000));
const SETTLE_MS = Number(opt('settleMs', 700));
if (HOME_ === '') throw new Error('必须给 --home');

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
const secrets = new Set();
const redact = (s) => {
  let o = String(s);
  for (const x of secrets) if (x.length > 4) o = o.split(x).join('«redacted»');
  return o.replace(/([?&]token=)[^\s"']+/g, '$1«redacted»');
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

const HELPERS = `
window.__m = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  byText: (needle) => window.__m.qa('button, [role=button], [role=textbox]').find((n) => window.__m.name(n).includes(needle)),
  composer: () => {
    const all = window.__m.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert') ?? document.querySelector('[contenteditable=true]') ?? all[0] ?? null;
  },
  ghost: () => {
    const el = window.__m.q('#dsh-suggest-ghost-overlay');
    if (el == null) return { shown: false, text: '' };
    const cs = getComputedStyle(el);
    const visible = cs.display !== 'none' && el.offsetParent !== null;
    return { shown: visible && el.getAttribute('data-shown') === '1', text: (el.textContent ?? '') };
  },
  dismiss: async () => {
    // 「继续」是首启**「预览版说明」模态**的确认按钮（0.1.2 / 0.1.7 / 0.2.1 实测文案都是它）。
    // 缺它 ⇒ 模态一直挡着 ⇒ composer 永远 inert ⇒ 整轮测到 0 帧，而失败长得像"插件没出建议"。
    // task-42 就是靠补上它把录制跑通的（gui-round 一直有这个标签，我自己新写的两支脚本没有）。
    // ⚠️ 这里点到的「继续」只在**首屏模态**里；**工作区选择器里的「继续」绝不能点**
    //    （那条会选中别的工作区，§11 写过）—— picker 那条路在 setupWs 里单独处理，不经过本函数。
    const labels = ['继续', '同意', '我已阅读', '保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    for (let k = 0; k < 8; k += 1) {
      let hit = false;
      for (const d of [...window.__m.qa('[role=dialog]'), ...window.__m.qa('dialog[open]')]) {
        const b = [...d.querySelectorAll('button')].find((x) => labels.some((L) => window.__m.name(x).includes(L)))
          ?? d.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
        // ⚠️ 右侧是 querySelector ⇒ 找不到时是 **null** 而不是 undefined；写 "!== undefined"
        // 会放行 null，然后 null.click() 抛 TypeError（本轮实测踩过）。
        // （这段在模板字符串内部：注释里出现反引号会把模板提前结束 —— 我已经踩了四次。）
        if (b != null) { b.click(); hit = true; await window.__m.wait(200); }
      }
      if (!hit) break;
    }
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__m.wait(120); } return false; },
};
`;

const dir = join(tmpdir(), `leadtime-${Date.now()}`);
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  // 收集页内与本判据有关的留痕（帧到达、状态变化）：宿主侧看不到这些，
  // 而"帧没到"与"帧到了没显示"在 GUI 上同形。
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : String(a.description ?? ''))).join(' ');
    if (/suggest-ghost/.test(text)) pageLines.push(text.slice(0, 160));
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

const QUESTIONS = [
  'git worktree 和普通 clone 的区别是什么？一句话回答。',
  '怎么查看某个端口被哪个进程占用？给一条命令。',
  '把当前目录最近一次提交撤销，命令是什么？',
  'npm 里 package-lock 冲突一般怎么处理？一句话。',
  '怎么只看某个分支最近的提交？给一条命令。',
];

const rows = [];
/** 页内 console 里与本判据有关的行（帧到达、状态变化、归属被藏）。 */
const pageLines = [];
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  await send('Page.navigate', { url: urlOf() });
  await sleep(9000);
  await evaluate(`(async () => { ${HELPERS} await window.__m.dismiss(); return true; })()`);
  // ⚠️ 冷沙箱首屏水合**比 9s 慢**（0.2.1-rc.2 实测：9s 时 `composers: []`，等到 20s+ 才
  // `phase=plain`）。固定 sleep 会让我在"页面还没起来"时去做 picker，得到 row-missing，
  // 然后整轮测量空跑 —— 那是**工具的时机缺陷**，不是插件问题（§11 同源）。
  // 就绪判据用 composer 的 phase，不拿 [role=dialog] 计数当门。
  const hydrated = await evaluate(`window.__m.until(() => (window.__m.composer()?.dataset.phase ?? 'inert') !== 'inert', 45000)`);
  say(`· 首屏水合等到 composer 就绪 = ${JSON.stringify(hydrated)}`);
  // 工作区（首轮设一次；已设过就是 no-op）
  const wsReady = await evaluate(`(async () => {
    const c = window.__m.composer();
    if (c != null && c.dataset.phase !== 'inert') return { ready: true, phase: c.dataset.phase };
    const opener = document.querySelector('[aria-label="添加工作区"]') ?? window.__m.byText('选择工作区');
    if (opener == null) return { ready: false, why: 'no-opener' };
    opener.click();
    const opened = await window.__m.until(() => window.__m.q('[role=dialog]') != null, 12000);
    if (!opened) return { ready: false, why: 'picker-not-open' };
    const name = ${JSON.stringify(WS.split('/').pop())};
    let row = null;
    const found = await window.__m.until(() => {
      row = [...window.__m.q('[role=dialog]').querySelectorAll('button, [role=button], [role=treeitem], li, [title]')]
        .find((n) => window.__m.name(n) === name);
      return row != null;
    }, 12000);
    if (!found) return { ready: false, why: 'row-missing' };
    row.click();
    await window.__m.wait(500);
    const open = [...window.__m.q('[role=dialog]').querySelectorAll('button')].filter((b) => window.__m.name(b).includes('打开')).find((b) => !b.disabled);
    if (open == null) return { ready: false, why: 'no-open-btn' };
    open.click();
    return { ready: await window.__m.until(() => (window.__m.composer()?.dataset.phase ?? 'inert') !== 'inert', 15000) };
  })()`);
  say(`· 工作区就绪 = ${JSON.stringify(wsReady)}`);
  // 行匹配在老代次的 picker 里拿不到行（0.1.7-rc.2 实测 row-missing，而 gui-round 的
  // **路径框兜底**能成）⇒ 照它的第二条路走：聚焦路径框 → 写真路径 → 点「打开」。
  // 就绪判据仍然是 composer 的 phase，不拿 [role=dialog] 计数当门（技能 §1b：这步最易误判）。
  if (wsReady?.ready !== true && (wsReady?.why === 'row-missing' || wsReady?.why === 'picker-not-open')) {
    const focused = await evaluate(`(() => {
      const box = [...document.querySelectorAll('[role=dialog] input, [role=dialog] textarea, [role=dialog] [contenteditable="true"]')]
        .find((n) => !n.disabled && (n.getAttribute('aria-label') ?? '').match(/路径|path|目录/i))
        ?? document.querySelector('[role=dialog] input:not([type=checkbox]):not([type=radio])');
      if (box == null) return { ok: false, why: 'no-path-box' };
      box.focus();
      return { ok: true, tag: box.tagName };
    })()`);
    if (focused?.ok === true) {
      await send('Input.insertText', { text: WS });
      await sleep(400);
    }
    const opened = await evaluate(`(async () => {
      const cands = [...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=button]')]
        .filter((b) => window.__m.name(b).includes('打开') || window.__m.name(b).toLowerCase().includes('open'));
      const ok = cands.find((b) => !b.disabled) ?? cands[0] ?? null;
      if (ok == null) return { clicked: false, names: cands.map((b) => window.__m.name(b)) };
      ok.click();
      const ready = await window.__m.until(() => (window.__m.composer()?.dataset.phase ?? 'inert') !== 'inert', 20000);
      return { clicked: true, ready, phase: window.__m.composer()?.dataset.phase ?? '' };
    })()`);
    say('· 工作区兜底（路径框）= ' + JSON.stringify({ focused, opened }));
  }

  for (let round = 1; round <= ROUNDS; round += 1) {
    const q = QUESTIONS[(round - 1) % QUESTIONS.length];
    // 每轮开一条新会话（建议归属会话；看错会话必然"没有建议"）
    await evaluate(`(async () => {
      await window.__m.dismiss();
      const b = window.__m.byText('新会话') ?? window.__m.byText('新建会话') ?? window.__m.byText('New session')
        ?? [...document.querySelectorAll('[aria-label]')].find((n) => /New session|新建会话|在.*中新建会/.test(n.getAttribute('aria-label') ?? ''));
      if (b != null) { b.click(); await window.__m.wait(1300); }
      return b != null;
    })()`);
    const focus = await evaluate(`(() => { const n = window.__m.q('[role="textbox"]') ?? window.__m.composer(); if (n == null) return false; n.focus(); return true; })()`);
    if (!focus) { rows.push({ round, ok: false, why: 'no-composer' }); continue; }
    await sleep(120);
    // 采样器：在页内自己跑循环（避免每次 CDP 往返引入额外抖动）
    await send('Input.insertText', { text: q });
    await sleep(120);
    const started = Date.now();
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const sample = await evaluate(`(async () => {
      const t0 = performance.now();
      let firstMs = -1, lastChangeMs = -1, prev = '', distinct = 0;
      const lengths = [];
      while (performance.now() - t0 < ${MAX_WAIT_MS}) {
        const g = window.__m.ghost();
        if (g.shown && g.text.length > 0) {
          if (firstMs < 0) firstMs = performance.now() - t0;
          if (g.text !== prev) { distinct += 1; lengths.push(g.text.length); prev = g.text; lastChangeMs = performance.now() - t0; }
          else if (lastChangeMs >= 0 && performance.now() - t0 - lastChangeMs > ${SETTLE_MS}) break;
        }
        await window.__m.wait(${SAMPLE_MS});
      }
      const g = window.__m.ghost();
      return { firstMs, lastChangeMs, distinct, finalChars: g.shown ? g.text.length : 0, lengths, elapsed: Math.round(performance.now() - t0) };
    })()`);
    rows.push({ round, ok: sample.firstMs >= 0, question: q.slice(0, 18), ...sample, wallMs: Date.now() - started });
    say(`· 轮 ${round}: first=${sample.firstMs >= 0 ? Math.round(sample.firstMs) : '—'}ms settled=${sample.lastChangeMs >= 0 ? Math.round(sample.lastChangeMs) : '—'}ms 批次数=${sample.distinct} 终态字符=${sample.finalChars}`);
  }
} finally {
  // ⚠️ **越界自检（跑完立刻做，不等人事后查）**：真实 `~/.dsh` 里不许出现本次工作区的
  // 会话目录 / 工作区记录。2026-10-28 的事故就是"手工 spawn 忘了设 DSH_HOME"，
  // 当时靠事后 grep 才发现，所以这条断言必须在**同一支脚本里**当场响。
  const bleed = assertNoBleedIntoRealHome();
  if (bleed.hard.length > 0) {
    say(`❌ 越界：真实 ~/.dsh 里出现本次工作区的硬痕迹 ${bleed.hard.length} 处：\n  - ${bleed.hard.join('\n  - ')}`);
    process.exitCode = 3;
  } else {
    say('· 越界自检：真实 ~/.dsh 内本次工作区的会话目录 / 工作区记录 = 0 ✓');
  }
  if (bleed.soft.length > 0) {
    // 内容级提及**不判失败**：用户的活跃会话投影缓存里可能留着一份工作区清单快照
    // （实测两处就是这种，且几秒前刚被 live 改写过）。改它比留着更危险。
    say(`· 提示（不判失败）：真实 ~/.dsh 内有 ${bleed.soft.length} 处**内容级**提及本次工作区，`
      + '均属于仍存在的用户会话缓存，未改动：' + bleed.soft.slice(0, 3).join(', '));
  }
  const ok = rows.filter((r) => r.ok);
  const firsts = ok.map((r) => r.firstMs).sort((a, b) => a - b);
  const settles = ok.map((r) => r.lastChangeMs).sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]);
  const med = (arr) => pct(arr, 0.5);
  say('');
  say(`====== leadtime [${LABEL}] 轮数=${rows.length} 有效=${ok.length} 采样间隔=${SAMPLE_MS}ms ======`);
  say(`T_first  中位=${med(firsts) === null ? '—' : Math.round(med(firsts))}ms p90=${pct(firsts, 0.9) === null ? '—' : Math.round(pct(firsts, 0.9))}ms`);
  say(`T_settle 中位=${med(settles) === null ? '—' : Math.round(med(settles))}ms p90=${pct(settles, 0.9) === null ? '—' : Math.round(pct(settles, 0.9))}ms`);
  const leads = ok.map((r) => r.lastChangeMs - r.firstMs).sort((a, b) => a - b);
  say(`提前量(settle-first) 中位=${med(leads) === null ? '—' : Math.round(med(leads))}ms p90=${pct(leads, 0.9) === null ? '—' : Math.round(pct(leads, 0.9))}ms`);
  say(`每轮文本批次数 分布=${JSON.stringify(ok.map((r) => r.distinct))}`);
  const frameLines = pageLines.filter((l) => /stream frame=/.test(l));
  // 分桶要按**顺序**走，所以取全部流相关行（含 open/closed 边界），不是只取帧行。
  const frameLines0 = pageLines.filter((l) => /stream (open|closed|unavailable|frame=)/.test(l));
  const stateLines = pageLines.filter((l) => /stream (open|closed|unavailable|namespace|frame)/.test(l));
  // **真正的提前量 = 同一轮内"最后一帧"与"第一帧"的页内时刻差**（t= 由客户端逐帧打）。
  // 页外 15ms 轮询量不到它：实测两帧常挤在同一个采样间隔里。
  // 分桶只能按**页内留痕的顺序**做：帧行本身不带会话号（只有 `stream open` 带），
  // 用 `session=` 去分组会把所有轮次并进一个桶（上一版实测 22 帧挤成一桶、"提前量 289 秒"）。
  const turns = [];
  let currentTurn = null;
  for (const line of frameLines0) {
    const open = /stream open session=/.test(line);
    const fm = line.match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
    const closed = /stream (closed|unavailable)/.test(line);
    if (open) { if (currentTurn !== null && currentTurn.length > 0) turns.push(currentTurn); currentTurn = []; continue; }
    if (closed) { if (currentTurn !== null && currentTurn.length > 0) turns.push(currentTurn); currentTurn = null; continue; }
    if (fm !== null && currentTurn !== null) {
      currentTurn.push({ frame: Number(fm[1]), final: Number(fm[2]), chars: Number(fm[3]), t: Number(fm[5]) });
    }
  }
  if (currentTurn !== null && currentTurn.length > 0) turns.push(currentTurn);
  const multi = turns.filter((arr) => arr.length >= 2);
  const frameLeads = multi.map((arr) => arr.at(-1).t - arr[0].t).sort((a, b) => a - b);
  const spreadMed = frameLeads.length === 0 ? null : frameLeads[Math.floor(frameLeads.length / 2)];
  const spreadP90 = frameLeads.length === 0 ? null : frameLeads[Math.min(frameLeads.length - 1, Math.floor(frameLeads.length * 0.9))];
  say(`每轮帧数分布=${JSON.stringify(turns.map((a) => a.length))}`);
  say(`帧间提前量（同轮 首帧→终帧 页内时刻差）多帧轮数=${frameLeads.length}/${turns.length} `
    + `中位=${spreadMed ?? '—'}ms p90=${spreadP90 ?? '—'}ms 分布=${JSON.stringify(frameLeads)}`);
  say(`单帧轮数=${turns.filter((a) => a.length === 1).length}（这些轮流式无增益：模型只吐了一次正文增量）`);
  // **帧序正确性**（不是"看起来有字"）：**收过终帧**的那一条流，frame 必须从 1 起连续、
  // 终帧唯一且落在最后一帧、前缀不回退。
  // ⚠️ 判据边界（本轮实测纠正）：**一条流可以合法地没有终帧** —— 用户改草稿即撤流
  //（`stream closed ... note=draft-changed`），那是 #109 硬约束 4「中途显示的内容允许被丢弃」
  // 推到极致的样子：不是"被终帧修正"，而是"整条流提前收尾"。权威态仍来自随后那一次 `_push`。
  // 我上一版把这种桶算成"终帧数≠1"的违规（exit 4），那是**断言写错**，不是产品缺陷。
  const orderViolations = [];
  let earlyClose = 0;
  for (const arr of turns) {
    for (let k = 0; k < arr.length; k += 1) {
      if (arr[k].frame !== k + 1) orderViolations.push(`帧号不连续: ${JSON.stringify(arr.map((x) => x.frame))}`);
      if (arr[k].final && k !== arr.length - 1) orderViolations.push(`终帧不在最后一帧: ${JSON.stringify(arr.map((x) => x.final))}`);
    }
    const finals = arr.filter((x) => x.final).length;
    if (finals > 1) orderViolations.push(`终帧不唯一(${finals})`);
    if (finals === 0) earlyClose += 1;
    const chars = arr.map((x) => x.chars);
    if (chars.some((c, i) => i > 0 && c < chars[i - 1])) orderViolations.push(`前缀回退(净化前缀应单调不缩): ${JSON.stringify(chars)}`);
  }
  say(orderViolations.length === 0
    ? `帧序判定：${turns.length - earlyClose} 条收过终帧的流全部通过（帧号连续 / 终帧唯一且末帧 / 前缀不缩）✓`
    : `❌ 帧序违规 ${orderViolations.length} 处：${orderViolations.slice(0, 5).join(' | ')}`);
  say(`提前撤流的桶=${earlyClose}/${turns.length}（改草稿即撤流，无终帧属预期，不计违规）`);
  if (orderViolations.length > 0) process.exitCode = 4;
  say(`页内留痕：帧行=${frameLines.length} 状态/帧行合计=${stateLines.length}`);
  say('  状态行=' + JSON.stringify(stateLines.slice(0, 8)));
  say('明细=' + JSON.stringify(rows.map((r) => ({ round: r.round, ok: r.ok, first: r.firstMs, settle: r.lastChangeMs, distinct: r.distinct, chars: r.finalChars }))));
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(700);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  if (existsSync(dir)) say('· 临时 chrome 目录没删净（需显式清）：' + dir);
}
