#!/usr/bin/env node
/**
 * 跨内核 **UI 面** 单代次驱动器（Gitea #41 / task-35）。
 *
 * 为什么需要它：`verify-across-kernels.mjs` 只覆盖装配/门禁/类型/投影，**没有覆盖 client
 * 侧、不截图**；而技能原话是「前五面全绿 ≠ 插件能用」。这一支回答的是唯一那一问：
 * **用户到底看不看见浅灰幽灵文字**。
 *
 * 判据只用**真正被用户感知的入口**（真 GUI 发真问题 → 真模型回合 → 建议 → `_push` →
 * composer 里的 overlay），不调任何内部 handler。
 *
 * 页内选择器与操作顺序抄自 `scripts/hot-yield-ratio.mjs`（同一台机器上多代次实测跑通的
 * 那条路）：先点掉首启弹窗 → 选工作区（**点目录行**，路径框那条路实测死 5 次）→
 * **轮询确认选择器真的关闭** → 点工作区行上的「新会话」→ CDP Input 真事件打字 → 回车。
 *
 * token 不进 transcript：URL 从 `<home>/logs/sbx.log` 取，所有输出过 redact()。
 *
 * 用法：
 *   node scripts/cross-kernel/gui-round.mjs --home ~/dsh-sbx-xk-0212 --gen 0.2.1-rc.2 \
 *        --shot docs/cross-kernel-shots/0.2.1-rc.2-PASS-0.7.0.png --ws ~/xk-probe-ws
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const GEN = opt('gen', '?');
const SHOT = opt('shot', `docs/cross-kernel-shots/${GEN}-round.png`);
const WS = opt('ws', join(homedir(), `xk-probe-ws`)).replace(/^~/, homedir());
const ASK = opt('ask', 'git worktree 和普通 clone 的区别是什么？一句话回答。');
const GHOST_TIMEOUT_MS = Number(opt('ghostTimeoutMs', 90_000));
const LABEL = opt('label', '');
const PREFER_EXISTING = argv.includes('--prefer-existing');
if (HOME_ === '' ) throw new Error('必须给 --home <沙箱目录>');

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

// ── 掩码闸 ──────────────────────────────────────────────────────────────────
const secrets = new Set();
let leaked = 0;
const redact = (s) => {
  let out = String(s);
  for (const sec of secrets) if (sec.length > 4) out = out.split(sec).join('«redacted»');
  out = out.replace(/([?&]token=)[^\s"'\\]+/g, '$1«redacted»');
  if (out !== String(s)) leaked += 1;
  return out;
};
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = join(HOME_, 'logs', 'sbx.log');

// ── 取完整 URL（token 含 - _ ，截断会得到 401，而 401 页面渲染正常）──────────
const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

// ── 页内工具（抄自 hot-yield-ratio.mjs 的实测形状）───────────────────────────
const PAGE_HELPERS = `
window.__gy = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  btnIn: (scopeSel, label) => {
    const scope = scopeSel === null ? document : window.__gy.q(scopeSel) ?? document;
    const bs = [...scope.querySelectorAll('button, [role=button]')];
    return bs.find((b) => window.__gy.name(b) === label) ?? bs.find((b) => window.__gy.name(b).includes(label)) ?? null;
  },
  byText: (needle, sel) => window.__gy.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__gy.name(n).includes(needle)),
  click: (n) => { if (n === undefined || n === null) return false; n.scrollIntoView(); n.click(); return true; },
  composer: () => {
    const all = window.__gy.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert') ?? document.querySelector('[contenteditable=true]') ?? all[0] ?? null;
  },
  composers: () => window.__gy.qa('[data-composer-input]').map((n) => [n.tagName, n.dataset.phase ?? '', (n.getAttribute('aria-label') ?? '').slice(0, 16)].join('/')),
  pathBox: () => {
    const d = window.__gy.q('[role=dialog]');
    if (d == null) return null;
    const cand = [...d.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true], [role=textbox]')];
    return cand.find((n) => !n.disabled && n.offsetParent !== null) ?? null;
  },
  readBox: (n) => n == null ? null : (n.value ?? n.textContent ?? ''),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__gy.wait(120); } return false; },
  dismiss: async () => {
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', 'Continue', 'Got it', '暂不启用'];
    const closed = [];
    for (let k = 0; k < 10; k += 1) {
      let hit = false;
      for (const d of window.__gy.qa('[role=dialog]')) {
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__gy.name(x).includes(L)))
          ?? bs.find((x) => window.__gy.name(x).includes('关闭') || window.__gy.name(x) === '×');
        if (b !== undefined) { b.click(); closed.push((d.getAttribute('aria-label') ?? '').slice(0, 18)); hit = true; await window.__gy.wait(220); }
      }
      // 原生 <dialog open> 不在 [role=dialog] 里（实测文案「暂不启用」）
      for (const d of window.__gy.qa('dialog[open]')) {
        const b = [...d.querySelectorAll('button')].find((x) => labels.some((L) => window.__gy.name(x).includes(L)))
          ?? d.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
        if (b !== undefined) { b.click(); closed.push('native-dialog'); hit = true; await window.__gy.wait(220); }
      }
      if (!hit) break;
    }
    return closed;
  },
  // 本插件的真 UI 判据：overlay 存在 + data-shown="1" + 未被 display:none + 文本非空
  ghost: () => {
    const el = window.__gy.q('#dsh-suggest-ghost-overlay');
    if (el == null) return { exists: false };
    const cs = getComputedStyle(el);
    const text = (el.textContent ?? '').trim();
    return {
      exists: true,
      shown: el.getAttribute('data-shown') === '1',
      display: cs.display,
      visible: cs.display !== 'none' && el.offsetParent !== null,
      chars: text.length,
      sample: text.slice(0, 40),
    };
  },
};
`;

const keyInfoFor = (ch) => {
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { key: ch, code: 'Key' + upper, vk: 65 + upper.charCodeAt(0) - 65 };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: 48 + Number(ch) };
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32 };
  return { key: ch, code: 'Unidentified', vk: 0 };
};

// ── CDP（零依赖，Node 自带 WebSocket）───────────────────────────────────────
const dir = join(tmpdir(), `xk-gui-${GEN}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const cdpPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const wsConn = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { wsConn.onopen = res; wsConn.onerror = rej; });
let mid = 0;
const pending = new Map();
/**
 * 浏览器侧的 console / 未捕获异常。
 * ⚠️ 反证（task-36）没有这条就**不成立**：client fiber 的死活只体现在浏览器里，宿主
 * `sbx.log` 一个字都不会有；而「没幽灵」至少有三种成因（client 没激活 / 模型返回空 /
 * 归属会话不符），三者 GUI 上同形。所以必须把 console 抓下来当**独立信号**。
 */
const consoleEvents = [];
const objText = (a) => (a == null ? '' : (a.value !== undefined ? String(a.value) : String(a.description ?? a.unserializableValue ?? '')));
wsConn.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleEvents.push({ kind: msg.params.type, text: msg.params.args.map(objText).join(' ').slice(0, 300) });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleEvents.push({ kind: 'exception', text: String(d.exception?.description ?? d.text ?? '').slice(0, 300) });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++mid;
  pending.set(n, { res, rej });
  wsConn.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails !== undefined) {
    return { pageError: redact(String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))).slice(0, 300) };
  }
  return r.result.value;
};
const cdpType = async (focusExpr, text, enter = false) => {
  const ok = await evaluate(`(() => { const n = (${focusExpr})(); if (n == null) return false; n.focus(); return true; })()`);
  if (!ok) return false;
  await sleep(150);
  await send('Input.insertText', { text });
  await sleep(200);
  if (enter) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  return true;
};
const screenshotRegion = async (sel, pad, padTop = pad, padBottom = pad) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)});
    if (n == null) return null; const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vx: innerWidth, vy: innerHeight, dpr: devicePixelRatio }; })()`);
  if (box == null) return { noBox: true };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - padTop);
  const clip = {
    x, y,
    width: Math.min(box.vx - x, box.w + pad * 2),
    height: Math.min(box.vy - y, box.h + padTop + padBottom),
    scale: 1,
  };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip });
  return { box, clip, data: shot.data };
};

const flagFresh = argv.includes('--fresh-log');
const out = { gen: GEN, at: new Date().toISOString(), steps: {}, verdict: 'UNDETERMINED' };
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  const url = urlOf();
  await send('Page.navigate', { url });
  await evaluate(`(async () => { const t0=Date.now(); while (document.readyState !== 'complete' && Date.now()-t0 < 25000) await new Promise(r=>setTimeout(r,120)); return document.readyState; })()`);
  await evaluate(`(async () => { ${PAGE_HELPERS} return true; })()`);

  // 1) 首启弹窗
  out.steps.dismiss1 = await evaluate(`(async () => await window.__gy.dismiss())`);

  // 2) 工作区：点目录行（路径框那条实测死 5 次），并**确认选择器真的关闭**。
  //    ⚠️ 第二轮起工作区**已经设过** ⇒ 没有「选择工作区」按钮是正常态，别当失败。
  out.steps.picker = await evaluate(`(async () => {
    await window.__gy.dismiss();
    const c0 = window.__gy.composer();
    // composer 可用（phase 非 inert）就说明工作区早就设过了 ⇒ 别再点侧栏那个「选择工作区」字样
    if (c0 != null && c0.dataset.phase !== 'inert' && window.__gy.q('[role=dialog]') == null) return { alreadySet: true, phase: c0.dataset.phase };
    // 打开工作区选择器：**按代次不同的入口逐个试**。0.1.7-rc.2 实测 composer 的
    // aria-label 就是「选择工作区」但点它**不开选择器**（点完 dialog 仍为空），
    // 真正的入口是侧栏 aria-label「添加工作区」。
    const opener = document.querySelector('[aria-label="添加工作区"]')
      ?? document.querySelector('[aria-label="选择工作区"]:not([data-composer-input])')
      ?? window.__gy.byText('选择工作区');
    if (opener == null) return { step: '没有可用入口（添加工作区/选择工作区都没有）', composers: window.__gy.composers() };
    const openerLabel = (opener.getAttribute?.('aria-label') ?? window.__gy.name(opener) ?? '').slice(0, 16);
    opener.click();
    const opened = await window.__gy.until(() => window.__gy.q('[role=dialog]') != null, 12000);
    if (!opened) return { step: 'picker 没开', opener: openerLabel };
    const name = ${JSON.stringify(WS.split('/').pop())};
    const dlg = () => window.__gy.q('[role=dialog]');
    const btnNames = () => [...dlg().querySelectorAll('button, [role=button], [role=treeitem]')].map((b) => window.__gy.name(b).slice(0, 14));
    // ⚠️ **picker 的目录列表是异步加载的**（技能原话；本轮 0.1.7-rc.2 再次命中）：
    // 打开后立刻查行必然查不到 ⇒ 先轮询，再判「列表里没有那一行」。
    const findRow = () => [...dlg().querySelectorAll('button, [role=button], [role=treeitem], li, [title]')]
      .find((n) => window.__gy.name(n) === name || (n.getAttribute?.('title') ?? '') === name);
    let row = null;
    const rowAppeared = await window.__gy.until(() => { row = findRow(); return row != null; }, 9000);
    if (!rowAppeared) {
      const edit = window.__gy.btnIn('[role=dialog]', '编辑路径');
      if (edit != null) { edit.click(); await window.__gy.wait(600); return { needPath: true, opener: openerLabel, names: btnNames() }; }
      const cont = [...dlg().querySelectorAll('button, [role=button]')]
        .find((b) => /继续|Continue|使用此目录|选择此目录/.test(window.__gy.name(b)) && !b.disabled);
      if (cont != null) {
        cont.click();
        const ready = await window.__gy.until(() => (window.__gy.composer()?.dataset.phase ?? 'inert') !== 'inert', 12000);
        return { viaContinue: true, opener: openerLabel, label: window.__gy.name(cont).slice(0, 12), ready, composers: window.__gy.composers() };
      }
      return { step: '列表里没有那一行', opener: openerLabel, hasEdit: false, names: btnNames() };
    }
    row.click();
    await window.__gy.wait(600);
    const open = [...dlg().querySelectorAll('button')].filter((b) => window.__gy.name(b).includes('打开') || window.__gy.name(b).toLowerCase().includes('open')).find((b) => !b.disabled) ?? null;
    if (open == null) return { step: '点行之后 打开 仍不可用', names: btnNames() };
    open.click();
    // ⚠️ 0.1.7-rc.2 实测：点完「打开」**dialog 仍挂着**（dialogGone=false）。dialog 不关
    // ⇒ 后面点的「新会话」不是当前会话 ⇒ client 报 bound=false / no-session、宿主
    // suggestion generated=0 —— 长得像"这代次坏了"，其实是我的步骤没走完（task-36 现场）。
    // 所以必须等到 dialog 真关掉，必要时再点一次主按钮。
    // （这段在模板字符串内部：注释里出现反引号会提前结束模板 ⇒ 我上一轮就是这么崩的。）
    let gone = await window.__gy.until(() => window.__gy.q('[role=dialog]') == null, 8000);
    let secondClick = null;
    if (!gone) {
      const again = [...(dlg()?.querySelectorAll('button') ?? [])]
        .filter((b) => /打开|确认|确定|完成|选择此目录|Use|Open/i.test(window.__gy.name(b)) && !b.disabled)[0] ?? null;
      if (again != null) { again.click(); secondClick = window.__gy.name(again).slice(0, 12); gone = await window.__gy.until(() => window.__gy.q('[role=dialog]') == null, 8000); }
    }
    return { viaRow: true, opener: openerLabel, dialogGone: gone, secondClick };
  })()`);
  // 2b) 列表法在该代次拿不到行时的兜底：路径框（0.2.x 上实测不稳，但 0.1.7 的
  //     picker 有「编辑路径」按钮 ⇒ 值得一试；成不成都会把结果写进 out.steps，不猜）。
  if (out.steps.picker?.needPath === true) {
    const typed = await cdpType('() => window.__gy.pathBox()', WS, false);
    const opened = await evaluate(`(async () => {
      const cands = [...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=button]')]
        .filter((b) => window.__gy.name(b).includes('打开') || window.__gy.name(b).toLowerCase().includes('open'));
      const ok = cands.find((b) => !b.disabled) ?? cands[0] ?? null;
      if (ok == null) return { clicked: false, names: cands.map((b) => window.__gy.name(b)) };
      ok.click();
      return { clicked: true, disabled: ok.disabled === true, box: window.__gy.readBox(window.__gy.pathBox())?.slice(-24) ?? null };
    })()`);
    out.steps.pickerPath = { typed, opened };
  }
  out.steps.pickerClosed = await evaluate(`(async () => ({
    // 判「可以用」的口径改成看 composer phase，不看「选择工作区」字样是否消失
    // （侧栏工作区行的菜单里长期带这几个字，实测会让本项假红）
    composerReady: await window.__gy.until(() => (window.__gy.composer()?.dataset.phase ?? 'inert') !== 'inert', 15000),
    dialogGone: window.__gy.q('[role=dialog]') == null,
    phase: window.__gy.composer()?.dataset.phase ?? '',
    composers: window.__gy.composers(),
  }))()`);

  // 3~5) 每一轮：在工作区行上点「新会话」（不点侧栏旧会话）→ 真问题 → 轮询 overlay。
  //      ⚠️ 模型可能返回空（`suggestion dropped (empty or filtered)`）——那是模型的锅，
  //      按技能要换一句更容易出内容的问题重试，**不要记成插件/代次缺陷**。
  const ASKS = [ASK, '怎么查看某个端口被哪个进程占用？给一条命令。', '把当前目录最近一次提交撤销，命令是什么？'];
  const rounds = [];
  let appeared = { ok: false, ghost: null };
  for (let attempt = 0; attempt < ASKS.length; attempt += 1) {
    const ns = await evaluate(`(async () => {
      await window.__gy.dismiss();
      const existing = [...document.querySelectorAll('[aria-label]')].find((n) => /^会话/.test((n.getAttribute('aria-label') ?? '').trim()) && n.offsetParent !== null);
      const b = (PREFER_EXISTING === true ? existing : null) ?? window.__gy.byText('新会话') ?? window.__gy.byText('新建会话')
        ?? [...document.querySelectorAll('[aria-label]')].find((n) => /New session|新建会话|在.*中新建会/.test(n.getAttribute('aria-label') ?? ''));
      if (b == null) return { found: false };
      b.click();
      await window.__gy.wait(1400);
      return { found: true, label: window.__gy.name(b).slice(0, 24) };
    })()`);
    const typed = await cdpType('() => window.__gy.q(\'[role="textbox"]\') ?? window.__gy.composer()', ASKS[attempt], true);
    const got = await evaluate(`(async () => {
      const ok = await window.__gy.until(() => { const g = window.__gy.ghost(); return g.exists === true && g.shown === true && g.visible === true && g.chars > 0; }, ${Math.max(20000, Math.floor(GHOST_TIMEOUT_MS / ASKS.length))});
      return { ok, ghost: window.__gy.ghost() };
    })()`);
    rounds.push({ ask: ASKS[attempt].slice(0, 24), newSession: ns, typed, ...got });
    if (got.ok === true) { appeared = got; break; }
  }
  out.steps.rounds = rounds;
  out.steps.ghost = appeared;

  // 6) 截 **composer 区域**（不是整页）：向上多带 150px，把用户那句真问题也带进画面
  const shotRes = await screenshotRegion('[data-input-scroll]', 26, 150, 46);
  if (shotRes.noBox === true) {
    out.steps.shot = { noBox: true, box: await evaluate(`(() => { const n = window.__gy.composer(); if (n == null) return null; const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`) };
  } else {
    mkdirSync(dirname(SHOT), { recursive: true });
    writeFileSync(SHOT, Buffer.from(shotRes.data, 'base64'));
    out.steps.shot = { file: SHOT, clip: { x: Math.round(shotRes.clip.x), y: Math.round(shotRes.clip.y), w: Math.round(shotRes.clip.width), h: Math.round(shotRes.clip.height) } };
  }

  // 7) 设置卡能不能打开（client 面：两个 inject 在该代次真的可用）。
  //    入口不是 `button` 文本「设置」——实测 0.2.1 上 byText('设置') 找不到；
  //    先枚举候选（aria-label / title / 任意可点元素），再点，再确认设置页里的
  //    **插件设置卡**出现（本插件 client 的产物：style 带 dataset.pluginCss）。
  out.steps.settingsCard = await evaluate(`(async () => {
    const norm = (n) => ((n.textContent || '') + ' ' + (n.getAttribute?.('aria-label') ?? '') + ' ' + (n.title ?? '')).trim();
    const cands = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [aria-label], li')]
      .map((n) => ({ n, t: norm(n) }))
      .filter((r) => /设置|Settings|Preferences|插件|Plugins/i.test(r.t) && r.t.length <= 24);
    const mine = () => [...document.querySelectorAll('style[data-plugin-css], [data-plugin-card], [data-settings-section]')]
      .filter((n) => (n.dataset?.pluginCss ?? '') === 'dsh-suggest-ghost' || n.tagName === 'STYLE').length;
    const before = mine();
    // 实测 0.2.1 的入口是侧栏 aria-label「插件」，不是「设置」按钮；统一成元素或 {n,t} 记录
    //（上一版把两种形状混进一个变量，取 .n.click() 直接 TypeError。
    //  ⚠️ 这段是**模板字符串内部**，注释里不能出现反引号——会把模板提前结束。）
    const exact = [...document.querySelectorAll('[aria-label]')]
      .find((n) => /^(插件|Plugins|设置|Settings)$/.test((n.getAttribute('aria-label') ?? '').trim()) && n.offsetParent !== null);
    const loose = cands.find((r) => /插件|Plugins/i.test(r.t) && r.n.offsetParent !== null);
    const target = exact ?? loose?.n ?? null;
    if (target == null) {
      return { found: false, candidates: cands.map((r) => r.t.slice(0, 20)).slice(0, 10),
        ariaSample: [...document.querySelectorAll('[aria-label]')].map((n) => (n.getAttribute('aria-label') ?? '').slice(0, 18)).slice(0, 24) };
    }
    target.click();
    // 插件页里再找本插件那张卡（判据：页面文本里出现插件名/幽灵字样）
    const cardShown = await window.__gy.until(() => /dsh-suggest-ghost|幽灵|补全建议|Suggest Ghost/i.test(document.body.innerText ?? ''), 18000);
    const body = document.body.innerText ?? '';
    const at = body.search(/dsh-suggest-ghost|幽灵/i);
    return { found: true, clicked: (exact?.getAttribute?.('aria-label') ?? loose?.t ?? '').slice(0, 20), cardShown,
      snippet: at < 0 ? null : body.slice(at, at + 90).replace(/\\s+/g, ' ') };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});

  out.steps.console = (() => {
    const rel = consoleEvents.filter((e) => /suggest-ghost|remote\.settings|without inject|failed|Cannot get|cannot get|fiber/i.test(e.text));
    return { total: consoleEvents.length, relevant: rel.length, samples: rel.slice(0, 8) };
  })();
  out.verdict = appeared?.ok === true ? 'PASS' : 'FAIL';
} finally {
  say(`====== gui-round ${GEN}${LABEL === '' ? '' : ' [' + LABEL + ']'}` + ' ======');
  out.label = LABEL;
  say(JSON.stringify(out, null, 1));
  say(`· 宿主日志判据行：`);
  const logText = readFileSync(LOG, 'utf8');
  const log = flagFresh ? logText.split('=== dev-sandbox 新启动 ===').pop() : logText;
  // ⚠️ 计数必须带**前缀边界**：`push landed` 是 `hot push landed` 的子串，裸 grep 会把
  // 热度帧一起算进去（FINDINGS §9 那条坑）。这里分开数。
  const count = (re) => (log.match(re) ?? []).length;
  const counters = [
    ['apply called（宿主挂载）', /apply called/g],
    ['建议格 push landed（不含 hot）', /(?<!hot )push landed/g],
    ['hot push landed', /hot push landed/g],
    ['suggestion generated', /suggestion generated/g],
    ['suggestion dropped（模型空，不是缺陷）', /suggestion dropped/g],
    ['suggestion failed', /suggestion failed/g],
    ['hotness restored', /hotness restored/g],
    ['hotness restore FAILED', /hotness restore FAILED/g],
    ['hotness persistence absent', /hotness persistence absent/g],
    ['dirty cap cleared', /dirty cap cleared/g],
  ];
  for (const [k, re] of counters) say(`    ${k.padEnd(34)} = ${count(re)}`);
  say(`· 浏览器侧 console：共 ${consoleEvents.length} 条，与本判据相关的 ${out.steps?.console?.relevant ?? 0} 条`);
  for (const s of (out.steps?.console?.samples ?? []).slice(0, 6)) say(`    [${s.kind}] ${s.text.slice(0, 150)}`);
  say(`· redact 命中 ${leaked} 次；token 明文进 stdout 次数 = 0（所有输出过 redact）`);
  try { wsConn.close(); } catch { /* noop */ }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  // chrome 被 SIGKILL 后仍在写 user-data-dir ⇒ 立刻 rmSync 会 ENOTEMPTY（实测 0.2.0 那轮退出码 1 就是这个，
  // 判据本身已经拿到了）。等一下再删，删不掉就留路径给人工看，不影响结论。
  await sleep(700);
  for (let k = 0; k < 6; k += 1) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); }
  }
  if (existsSync(dir)) say('· 临时 chrome 目录没删净（不影响判据）：' + dir);
}
