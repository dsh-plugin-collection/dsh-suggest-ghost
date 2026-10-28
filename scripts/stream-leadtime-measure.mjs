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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
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
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    for (let k = 0; k < 8; k += 1) {
      let hit = false;
      for (const d of [...window.__m.qa('[role=dialog]'), ...window.__m.qa('dialog[open]')]) {
        const b = [...d.querySelectorAll('button')].find((x) => labels.some((L) => window.__m.name(x).includes(L)))
          ?? d.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
        if (b !== undefined) { b.click(); hit = true; await window.__m.wait(200); }
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
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  await send('Page.navigate', { url: urlOf() });
  await sleep(9000);
  await evaluate(`(async () => { ${HELPERS} await window.__m.dismiss(); return true; })()`);
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

  for (let round = 1; round <= ROUNDS; round += 1) {
    const q = QUESTIONS[(round - 1) % QUESTIONS.length];
    // 每轮开一条新会话（建议归属会话；看错会话必然"没有建议"）
    await evaluate(`(async () => {
      await window.__m.dismiss();
      const b = window.__m.byText('新会话') ?? window.__m.byText('新建会话')
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
  say('明细=' + JSON.stringify(rows.map((r) => ({ round: r.round, ok: r.ok, first: r.firstMs, settle: r.lastChangeMs, distinct: r.distinct, chars: r.finalChars }))));
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(700);
  for (let k = 0; k < 6; k += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  if (existsSync(dir)) say('· 临时 chrome 目录没删净（需显式清）：' + dir);
}
