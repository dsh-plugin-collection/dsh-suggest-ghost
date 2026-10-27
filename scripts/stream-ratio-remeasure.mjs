// task-30 / #41 的「可见内容落在整次生成的第几 %」重测驱动（probe-llm）。
//
// **为什么要在沙箱里跑而不是读 live**：`src/trace.ts` 的默认门槛是 warn ⇒ 常态耗时留痕
// （`suggestion generated … in Nms first_text_delta_ms=…`）走 `traceOps` = **debug 级**，
// 在 live 的 `~/.dsh/dsh-web.log` 里实测 0 条（2026-10-27 核对）。所以必须自己开档，
// 且**先证明"发生了就一定被打印"**再拿"某条没出现"当结论（#97 的那件事）。
//
// 度量对象是**生成侧**时长，与投递方式无关 ⇒ 不需要浏览器渲染判据，但仍需要**真回合**
// （headless 会在 turn/end 后立刻退程，把异步的建议生成截断，见
// `docs/real-session-harness.md` §5）⇒ 用长驻沙箱 + CDP 发真消息。
//
// 用法（worktree 内，两个阶段各跑一次）：
//   node scripts/stream-ratio-remeasure.mjs --tag default --effort ''      --rounds 14
//   node scripts/stream-ratio-remeasure.mjs --tag low     --effort low     --rounds 10
//
// 输出：stdout 是摘要（过 redact），原始样本落 `/tmp/stream-ratio-<tag>.jsonl`。
// 本脚本**不进** test:smoke / test:e2e（它花真回合与真模型调用）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 留痕门槛：本脚本靠抓 [ops-trace] 文本取数，必须在**起子进程之前**把门槛放到 debug。
// 这是测量自己开档，不改生产默认（`??=` 让外部显式设置优先，便于复跑时改档）。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

const HOME = process.env.HOME ?? '';
const REPO = process.cwd();
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const TAG = String(opt('tag', 'default'));
const EFFORT = String(opt('effort', ''));
const ROUNDS = Number(opt('rounds', 14));
const ROUND_TIMEOUT_MS = Number(opt('round-timeout', 180_000));
const SANDBOX = String(opt('home', join(HOME, 'dsh-sbx-stream'))).replace(/^~/, HOME);
const WS = String(opt('ws', '')).replace(/^~/, HOME) || join(SANDBOX, 'ws');
const GATEWAY = Number(opt('gateway', 4211));
const CHROME = process.env.CHROME_BIN
  ?? join(HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const SAMPLES = join(tmpdir(), `stream-ratio-${TAG}.jsonl`);
const LOG = join(SANDBOX, 'logs', 'sbx.log');

// 固定的提示词表（按序循环，**不做任何挑选**）：都是"无工具、短回答"的回合，
// 目的是让 turn 尽快结束、把建议生成送进观测窗；表本身与结果无关。
const PROMPTS = [
  '只回答一个字：好',
  '只回答一个字：行',
  '用一句话说明什么是 git worktree',
  '只回答两个字：收到',
];

// ── 输出必须过这道：token 与 URL 明文不进 stdout ────────────────────────────
const secrets = new Set();
let leaked = 0;
const redact = (s) => {
  let out = String(s);
  for (const sec of secrets) if (sec.length > 4) out = out.split(sec).join('«redacted»');
  out = out.replace(/([?&]token=)[^\s"']+/g, '$1«redacted»');
  if (out !== String(s)) leaked += 1;
  return out;
};
const say = (...parts) => process.stdout.write(redact(parts.join(' ')) + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, cmdArgs, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  let err = '';
  p.stdout.on('data', (b) => { out += b.toString(); });
  p.stderr.on('data', (b) => { err += b.toString(); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out, err }));
});

/** 沙箱 profile 里 suggest-ghost 条目块（`- id: suggest-ghost` 到下一个顶层条目）。 */
function ghostBlock(text) {
  const i = text.indexOf('- id: suggest-ghost');
  if (i < 0) throw new Error('沙箱 profile 里没有 suggest-ghost 条目');
  let j = text.indexOf('\n- id: ', i + 5);
  if (j < 0) j = text.length;
  return { i, j, block: text.slice(i, j) };
}

// ── 沙箱：建（--check）→ 打补丁 → 用 --deploy 启动（--deploy 不 rmSync，补丁才不被冲掉）──
const patchProfile = () => {
  const profile = join(SANDBOX, 'profiles', 'web', 'cordis.patch.yml');
  let t = readFileSync(profile, 'utf8');
  const { i, j, block } = ghostBlock(t);
  // ① 确保启用（live 是 disabled: false，但副本可能被上一轮改过 ⇒ 幂等翻一次）
  let b = /disabled:\s*true/.test(block)
    ? block.replace(/^(\s*)disabled:\s*true\s*$/m, '$1disabled: false')
    : block;
  // ② 档位键：'' ⇒ 显式写空串（= 不传，走模型默认档）；非空 ⇒ 写该档
  b = b.replace(/^    suggestionReasoningEffort:.*\n/m, '');
  b = b.replace(/^    completionReasoningEffort:.*\n/m, '');
  const effortLine = `    suggestionReasoningEffort: ${EFFORT === '' ? "''" : EFFORT}\n`;
  const cfgAt = b.indexOf('  config:\n');
  if (cfgAt < 0) throw new Error('suggest-ghost 条目没有 config: 段');
  b = b.slice(0, cfgAt + '  config:\n'.length) + effortLine + b.slice(cfgAt + '  config:\n'.length);
  t = t.slice(0, i) + b + t.slice(j);
  // ③ 关掉 auto-continue：它自己往会话里发「继续」，会造出**不是我发起**的回合与建议行
  //    （`docs/real-session-harness.md` §7、§14 的同一处置）。
  if (!t.includes('- id: auto-continue\n  disabled: true')) {
    t = t.trimEnd() + '\n- id: auto-continue\n  disabled: true\n';
  }
  writeFileSync(profile, t);
  return { effort: EFFORT === '' ? "''（不传）" : EFFORT };
};

const killRunning = async () => {
  const pidFile = join(SANDBOX, 'sbx.pid');
  if (!existsSync(pidFile)) return 0;
  const pids = readFileSync(pidFile, 'utf8').split(/\s+/).filter(Boolean);
  for (const p of pids) {
    const r = await run('kill', [p]).catch(() => ({ code: 1 }));
    if (r.code !== 0) say(`· kill ${p} 退出 ${r.code}（可能已退出）`);
  }
  await sleep(3500);
  return pids.length;
};

const startInstance = async () => {
  if (!existsSync(join(SANDBOX, 'profiles', 'web', 'node_modules'))) {
    say('· 建沙箱（--check：私有产物副本 + 凭据副本）');
    const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', SANDBOX, '--ws', WS,
      '--rewrite', `port: 3983=port: ${GATEWAY}`, '--check'], { cwd: REPO });
    if (r.code !== 0) throw new Error('建沙箱失败：' + redact(r.err.slice(-400)));
  }
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, 'note.txt'), 'stream ratio remeasure\n');
  const info = patchProfile();
  say(`· profile 已打补丁：档位键 suggestionReasoningEffort=${info.effort}，auto-continue 已关`);

  const killed = await killRunning();
  if (killed > 0) say(`· 已停掉上一轮实例（${killed} 个 pid）`);

  say('· 启动实例（--deploy 复用已构建产物，补丁不被 rmSync 冲掉）');
  const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', SANDBOX, '--ws', WS,
    '--rewrite', `port: 3983=port: ${GATEWAY}`, '--deploy', '.'], { cwd: REPO });
  const m = r.out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
  if (m === null) throw new Error('启动输出里没有 URL：' + redact(r.out.slice(-500)));
  secrets.add(m[2]);
  const port = m[1];
  // §7 坑 ④：打印的 URL 可能来自旧行 ⇒ 用 ss 按端口复核它确实在听
  const listen = await run('ss', ['-ltn', '(', 'sport', '=', `:${port}`, ')']);
  if (!/LISTEN/.test(listen.out)) throw new Error(`端口 ${port} 没在监听（URL 可能是旧行）`);
  say(`· 实例存活，GUI 端口 ${port}（token 只登记进 redact，不打印）`);
  return { url: `http://127.0.0.1:${port}/?token=${m[2]}`, port };
};

// ── CDP：零依赖（Node 自带 WebSocket）───────────────────────────────────────
const cdpSession = async () => {
  const dir = join(tmpdir(), `cdp-stream-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let k = 0; k < 60; k += 1) { if (existsSync(portFile)) break; await sleep(200); }
  if (!existsSync(portFile)) throw new Error('Chrome 没起来（CHROME_BIN 不对？）');
  const cport = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return {
    send,
    close: () => {
      try { ws.close(); } catch { /* noop */ }
      proc.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
    evaluate: async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails !== undefined) {
        throw new Error('页内异常：' + redact(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300)));
      }
      return r.result.value;
    },
  };
};

const PAGE_HELPERS = `
window.__sr = {
  qa: (s) => [...document.querySelectorAll(s)],
  q: (s) => document.querySelector(s),
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  btnIn: (scopeSel, label) => {
    const scope = scopeSel === null ? document : window.__sr.q(scopeSel) ?? document;
    const bs = [...scope.querySelectorAll('button, [role=button]')];
    return bs.find((b) => window.__sr.name(b) === label) ?? bs.find((b) => window.__sr.name(b).includes(label)) ?? null;
  },
  byText: (needle, sel) => window.__sr.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__sr.name(n).includes(needle)),
  click: (n) => { if (n === undefined || n === null) return false; n.scrollIntoView(); n.click(); return true; },
  composer: () => {
    const all = window.__sr.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert')
      ?? document.querySelector('[contenteditable=true]')
      ?? all[0] ?? null;
  },
  draftLen: () => (window.__sr.composer()?.textContent ?? '').length,
  pathBox: () => {
    const d = window.__sr.q('[role=dialog]');
    if (d == null) return null;
    const cand = [...d.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true], [role=textbox]')];
    return cand.find((n) => !n.disabled && n.offsetParent !== null) ?? null;
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__sr.wait(120); } return false; },
  // ⚠️ 必须同时覆盖**原生 dialog 元素**：实测沙箱首屏被 dsh-context × dsh-cost-meter 的
  // 「让上下文占用与费用一起可见」兼容弹窗挡住，它是 open 的原生 dialog、**没有 role=dialog**，
  // 只按 [role=dialog] 找就永远关不掉 ⇒ focus 被它锁住（activeElement=BUTTON/关闭预览）、
  // composer 中心点被覆盖 ⇒ 打字全进不去（本轮就是这么废了两轮）。按钮文案是「暂不启用」，
  // 不是既有脚本里那几个「暂不开启」。
  dismiss: async () => {
    const labels = ['保留当前显示', '暂不开启', '暂不启用', '以后再说', '知道了', '不用了', '保留原样', '关闭预览'];
    for (let k = 0; k < 10; k += 1) {
      let hit = false;
      for (const d of [...window.__sr.qa('[role=dialog]'), ...window.__sr.qa('dialog')]) {
        if (d.tagName === 'DIALOG' && !d.open) continue;
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__sr.name(x).includes(L)))
          ?? bs.find((x) => window.__sr.name(x).includes('关闭') || window.__sr.name(x) === '×');
        if (b !== undefined) { b.click(); hit = true; await window.__sr.wait(260); }
      }
      if (!hit) break;
    }
    return window.__sr.qa('dialog[open], [role=dialog]').length;
  },
  modalUp: () => window.__sr.qa('dialog[open], [role=dialog]').length,
};
`;

const keyInfoFor = (ch) => {
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { key: ch, code: 'Key' + upper, vk: 65 + upper.charCodeAt(0) - 65 };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: 48 + Number(ch) };
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32 };
  return { key: ch, code: 'Unidentified', vk: 0 };
};

// GUI 的输入框是受控组件：页内合成事件与 insertText 都进不了 Lexical 状态
// ⇒ 逐字符发 keyDown + char + keyUp，并且**每次发完回读**自证（§7 的实测结论）。
const cdpType = async (page, focusExpr, text) => {
  // 先按坐标**真点一下**目标元素：Lexical 的编辑器要 pointerdown/selection 才接得住输入，
  // 单纯 el.focus() 会被 React 把焦点挪走（实测 activeElement 变成 BUTTON/DIALOG）。
  const rect = await page.evaluate(`(() => { const n = (${focusExpr})(); if (n == null) return null; const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`);
  if (Array.isArray(rect)) {
    const cx = Math.round(rect[0] + Math.min(rect[2] / 2, 120));
    const cy = Math.round(rect[1] + rect[3] / 2);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(250);
  }
  const ok = await page.evaluate(`(() => { const n = (${focusExpr})(); if (n == null) return false; n.focus(); return true; })()`);
  if (!ok) return false;
  await sleep(120);
  await page.send('Input.insertText', { text });
  await sleep(150);
  if (await page.evaluate(`(() => window.__sr.draftLen())()`) === 0) {
    for (const ch of text) {
      const ki = keyInfoFor(ch);
      const base = { key: ki.key, code: ki.code, windowsVirtualKeyCode: ki.vk, nativeVirtualKeyCode: ki.vk };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
      await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }
  await sleep(200);
  return true;
};

const pressEnter = async (page) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
};

// ── 建议留痕行的读取与解析 ──────────────────────────────────────────────────
const SUGG_RE = /\[dsh-suggest-ghost\]\[ops-trace\] (suggestion (?:generated|dropped \(empty or filtered\)|failed)) .*?\bin (\d+)ms (.*?)\bat=(\d+)/;
const parseLine = (line) => {
  const m = SUGG_RE.exec(line);
  if (m === null) return null;
  const kv = {};
  for (const p of m[3].split(/\s+/)) {
    const e = p.indexOf('=');
    if (e > 0) kv[p.slice(0, e)] = p.slice(e + 1);
  }
  return {
    kind: m[1].startsWith('suggestion generated') ? 'generated'
      : m[1].startsWith('suggestion dropped') ? 'dropped' : 'failed',
    inMs: Number(m[2]),
    firstTextDeltaMs: kv['first_text_delta_ms'] === undefined ? null : Number(kv['first_text_delta_ms']),
    firstReasoningDeltaMs: kv['first_reasoning_delta_ms'] === undefined ? null : Number(kv['first_reasoning_delta_ms']),
    contentDeltas: kv['content_deltas'] === undefined ? null : Number(kv['content_deltas']),
    contentChars: kv['content_chars'] === undefined ? null : Number(kv['content_chars']),
    reasoningDeltas: kv['reasoning_deltas'] === undefined ? null : Number(kv['reasoning_deltas']),
    reasoningChars: kv['reasoning_chars'] === undefined ? null : Number(kv['reasoning_chars']),
    finishKind: kv['finish_kind'] ?? null,
    attemptsOuter: kv['attempts_outer'] === undefined ? null : Number(kv['attempts_outer']),
    effortRequested: kv['effort_requested'] ?? null,
    effortRejected: kv['effort_rejected'] ?? null,
    outcome: kv['outcome'] ?? null,
    at: Number(m[4]),
    raw: redact(line.trim()).slice(0, 400),
  };
};
const suggLines = () => {
  try {
    return readFileSync(LOG, 'utf8').split('\n')
      .map((l) => parseLine(l)).filter((x) => x !== null);
  } catch { return []; }
};
const countNeedle = (needle) => {
  try { return readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(needle)).length; } catch { return -1; }
};

// ── 会话起手：导航 → 关模态 → 选工作区（点行法优先）→ 确认 composer 已 attach ──
const openAndBoot = async (page, url) => {
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
  await page.evaluate(`(async () => { const t0=Date.now(); while (document.readyState!=='complete' && Date.now()-t0<20000) await new Promise(r=>setTimeout(r,120)); return document.readyState; })()`);
  await page.evaluate(`(async () => { ${PAGE_HELPERS} return true; })()`);
  await page.evaluate(`(async () => { await window.__sr.dismiss(); return true; })()`);
  const pickerState = await page.evaluate(`(async () => {
    await window.__sr.dismiss();
    const btn = window.__sr.byText('选择工作区');
    if (btn == null) return { needed: false, phase: window.__sr.composer()?.dataset.phase ?? '' };
    btn.click();
    const opened = await window.__sr.until(() => window.__sr.q('[role=dialog]') != null, 9000);
    return { needed: true, opened };
  })()`);
  say('· 点开 picker：' + JSON.stringify(pickerState).slice(0, 200));
  if (flag('dump-picker')) {
    const dump = await page.evaluate(`(() => {
      const d = window.__sr.q('[role=dialog]');
      if (d == null) return { dialog: null, bodyButtons: window.__sr.qa('button').slice(0, 20).map((b) => window.__sr.name(b).slice(0, 18)) };
      const kinds = {};
      for (const n of d.querySelectorAll('*')) { const t = n.tagName + '/' + (n.getAttribute('role') ?? ''); kinds[t] = (kinds[t] ?? 0) + 1; }
      return {
        dialog: (d.getAttribute('aria-label') ?? '').slice(0, 30),
        kinds: Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12),
        buttons: [...d.querySelectorAll('button')].slice(0, 24).map((b) => [window.__sr.name(b).slice(0, 20), b.disabled ? 'off' : 'on']),
        treeitems: [...d.querySelectorAll('[role=treeitem]')].slice(0, 24).map((n) => window.__sr.name(n).slice(0, 24)),
        inputs: [...d.querySelectorAll('input, [contenteditable=true], [role=textbox]')].map((n) => n.tagName + '/' + (n.getAttribute('aria-label') ?? '').slice(0, 14) + '/' + (n.value ?? n.textContent ?? '').slice(0, 22)),
      };
    })()`);
    say('· picker DOM 盘点（点开结果=' + JSON.stringify(pickerState) + '）：' + JSON.stringify(dump).slice(0, 1800));
    return { dumped: true };
  }
  const picked = await page.evaluate(`(async () => {
    // picker 打开时落在**主目录**（不是沙箱 cwd），所以要**逐层点进去**：
    // ~/dsh-sbx-stream/ws ⇒ 先点「dsh-sbx-stream」这一行，再点「ws」这一行，然后「打开」才可点。
    const steps = ${JSON.stringify(WS.split('/').filter((x) => x.length > 0).slice(-2))};
    const trail = [];
    // 列表是**异步**加载的：刚点开时 dialog 里只有 5 个工具条按钮（编辑路径/新建文件夹/
    // 显示隐藏文件/取消/打开），一行目录都没有 ⇒ 不等它就点行，必然「列表里没有那一行」。
    const listed = await window.__sr.until(
      () => [...(window.__sr.q('[role=dialog]') ?? document).querySelectorAll('button')].length > 6, 15000);
    trail.push({ waitForRows: listed });
    for (const name of steps) {
      const d = window.__sr.q('[role=dialog]');
      if (d == null) { trail.push({ name, step: 'dialog 不见了' }); break; }
      const row = [...d.querySelectorAll('button, [role=button], [role=treeitem], li *')]
        .find((n) => window.__sr.name(n) === name);
      if (row == null) {
        trail.push({ name, step: '列表里没有那一行',
          names: [...d.querySelectorAll('button')].slice(0, 12).map((b) => window.__sr.name(b).slice(0, 14)) });
        break;
      }
      row.click();
      await window.__sr.wait(600);
      trail.push({ name, clicked: true });
    }
    if (trail.some((x) => x.step !== undefined && !/dialog 没了|dialog 不见了/.test(String(x.step)))) return { trail, early: true };
    // 点第一行后 dialog 直接关掉 = 选择已提交（实测如此），不必再点「打开」
    const d = window.__sr.q('[role=dialog]');
    if (d == null) return { viaRows: true, dialogClosed: true, trail, phase: window.__sr.composer()?.dataset.phase ?? '' };
    const open = [...d.querySelectorAll('button')].filter((b) => window.__sr.name(b).includes('打开')).find((b) => !b.disabled) ?? null;
    if (open === null) return { trail, step: '逐层点完之后 打开 仍不可用' };
    open.click();
    const ready = await window.__sr.until(() => (window.__sr.composer()?.dataset.phase ?? 'inert') !== 'inert', 9000);
    return { viaRows: true, ready, phase: window.__sr.composer()?.dataset.phase ?? '', trail };
  })()`);
  say('· 工作区：' + JSON.stringify(picked).slice(0, 420));
  if (picked.viaRows !== true) {
    // 兜底（§7 记的那条老路）：切「编辑路径」输入绝对路径 + Enter，再点可用的「打开」
    say('· 逐层点选没成 ⇒ 走路径框兜底');
    await page.evaluate(`(async () => {
      const d = window.__sr.q('[role=dialog]') ?? document;
      const edit = window.__sr.btnIn('[role=dialog]', '编辑路径');
      if (edit != null) { edit.click(); await window.__sr.wait(500); }
    })()`);
    await cdpType(page, `() => window.__sr.pathBox()`, WS);
    await pressEnter(page);
    await sleep(700);
    const opened = await page.evaluate(`(async () => {
      const cands = [...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=button]')]
        .filter((b) => window.__sr.name(b).includes('打开'));
      const open = cands.find((b) => !b.disabled) ?? null;
      if (open === null) return { step: '没有可用的打开按钮', n: cands.length };
      open.click();
      const ready = await window.__sr.until(() => (window.__sr.composer()?.dataset.phase ?? 'inert') !== 'inert', 9000);
      return { clicked: true, ready, phase: window.__sr.composer()?.dataset.phase ?? '' };
    })()`);
    say('· 兜底结果：' + JSON.stringify(opened).slice(0, 260));
    return opened;
  }
  return picked;
};

// ── 主流程 ──────────────────────────────────────────────────────────────────
const ctx = { url: '' };
const main = async () => {
  if (existsSync(SAMPLES)) rmSync(SAMPLES);
  const started = await startInstance();
  ctx.url = started.url;

  const beforeBoot = countNeedle('apply called; artifact mtime=');
  if (beforeBoot <= 0) {
    // 正面控制第一步：debug/info 通道没落地就别开始量（否则"没采到"会被误读成"没发生"）
    await sleep(8000);
  }
  const applied = countNeedle('apply called; artifact mtime=');
  say(`· 通道自检：留痕 "apply called; artifact mtime=" 命中 ${applied} 行（>0 才证明 debug 档真的在打）`);
  if (applied <= 0) throw new Error('debug 留痕没落地：门槛没生效或日志路径不对 ⇒ 停止测量，不改口');

  const page = await cdpSession();
  try {
    await openAndBoot(page, ctx.url);
    // 把主视图拉回来：留在别的视图上 composer 不会 attach（§7 那条），点「新会话」最稳
    const ns = await page.evaluate(`(async () => {
      await window.__sr.dismiss();
      const n = window.__sr.byText('新会话') ?? window.__sr.byText('新建会话');
      if (n != null) { n.click(); await window.__sr.wait(1200); }
      await window.__sr.dismiss();
      return { clicked: n != null, modal: window.__sr.modalUp(), phase: window.__sr.composer()?.dataset.phase ?? '', draft: window.__sr.draftLen() };
    })()`);
    say('· 新会话/模态清点：' + JSON.stringify(ns));
    const rows = [];
    let lastAt = suggLines().reduce((a, r) => Math.max(a, r.at), 0);
    for (let r = 1; r <= ROUNDS; r += 1) {
      const prompt = PROMPTS[(r - 1) % PROMPTS.length];
      const modal = await page.evaluate(`(() => window.__sr.modalUp())()`);
      if (modal > 0) {
        // 别的插件的弹窗会随时再冒出来（实测 dsh-context×dsh-cost-meter 那个会重弹），
        // 它一在就锁住焦点 ⇒ 每轮开头都清一遍，并把"清过"记进样本，免得读数被污染
        await page.evaluate(`(async () => { await window.__sr.dismiss(); return true; })()`);
        say(`  轮 ${r}：开局有 ${modal} 个模态，已清`);
      }
      const typed = await cdpType(page, `() => window.__sr.composer()`, prompt);
      const draftLen = await page.evaluate(`(() => window.__sr.draftLen())()`);
      if (!typed || draftLen === 0) {
        rows.push({ round: r, kind: 'input-failed', draftLen });
        say(`  轮 ${r}：打字没进草稿（draftLen=${draftLen}）⇒ 记为废轮，不补发`);
        continue;
      }
      const tSubmit = Date.now();
      await pressEnter(page);
      // 等这一轮的建议留痕出现（生成侧的观测点就是它）
      let got = null;
      const t0 = Date.now();
      while (Date.now() - t0 < ROUND_TIMEOUT_MS) {
        await sleep(1200);
        const fresh = suggLines().filter((x) => x.at > lastAt);
        if (fresh.length > 0) { got = fresh[fresh.length - 1]; break; }
      }
      if (got === null) {
        rows.push({ round: r, kind: 'timeout', waitMs: Date.now() - tSubmit });
        say(`  轮 ${r}：${ROUND_TIMEOUT_MS / 1000}s 内没出建议留痕 ⇒ 记为 timeout（**不剔除**）`);
        continue;
      }
      lastAt = got.at;
      const usable = got.firstTextDeltaMs !== null && got.firstTextDeltaMs >= 0 && got.inMs > 0;
      const saving = usable ? (got.inMs - got.firstTextDeltaMs) / got.inMs : null;
      const row = {
        round: r, promptChars: prompt.length, waitMs: Date.now() - tSubmit,
        ...got, usable, savingRatio: saving,
      };
      delete row.raw;
      rows.push(row);
      appendFileSync(SAMPLES, JSON.stringify(row) + '\n');
      say(`  轮 ${r}: ${got.kind} in=${got.inMs}ms first_text=${got.firstTextDeltaMs} first_reason=${got.firstReasoningDeltaMs}`
        + ` content_deltas=${got.contentDeltas} reasoning_deltas=${got.reasoningDeltas}`
        + ` outcome=${got.outcome} finish=${got.finishKind} attempts=${got.attemptsOuter}`
        + ` effort_requested=${got.effortRequested} effort_rejected=${got.effortRejected}`
        + (saving === null ? ' 节省比例=n/a' : ` 节省比例=${(saving * 100).toFixed(1)}%`));
    }
    report(rows);
  } finally {
    page.close();
  }
};

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(p * s.length) - 1);
  return s[Math.max(0, idx)];
};

const report = (rows) => {
  const usable = rows.filter((r) => r.usable === true);
  const ratios = usable.map((r) => r.savingRatio);
  const abs = usable.map((r) => r.inMs - r.firstTextDeltaMs);
  const le10 = ratios.filter((x) => x <= 0.10).length;
  say('');
  say(`== tag=${TAG} effort=${EFFORT === '' ? "''（不传）" : EFFORT} 计划轮数=${ROUNDS} 实收=${rows.length} 可用=${usable.length}`);
  say(`   轮型分布：${JSON.stringify(rows.reduce((a, r) => { a[r.kind] = (a[r.kind] ?? 0) + 1; return a; }, {}))}`);
  say(`   in_ms: p50=${pct(rows.map((r) => r.inMs).filter((x) => Number.isFinite(x)), 0.5)} p90=${pct(rows.map((r) => r.inMs).filter((x) => Number.isFinite(x)), 0.9)} max=${Math.max(0, ...rows.map((r) => r.inMs ?? 0))}`);
  say(`   first_text_delta_ms: p50=${pct(usable.map((r) => r.firstTextDeltaMs), 0.5)} p90=${pct(usable.map((r) => r.firstTextDeltaMs), 0.9)}`);
  say(`   节省比例: p50=${ratios.length ? (pct(ratios, 0.5) * 100).toFixed(1) : 'n/a'}% p90=${ratios.length ? (pct(ratios, 0.9) * 100).toFixed(1) : 'n/a'}%`);
  say(`   ≤10% 的轮数: ${le10}/${ratios.length}`);
  // 严格口径：只算**真的出了建议**的那些轮（dropped/filtered 的正文用户根本没看见，
  // 把它们算进"流式能提前"是高估）。两个口径都报，免得挑一个好看的。
  const genOnly = usable.filter((r) => r.kind === 'generated');
  const genRatios = genOnly.map((r) => r.savingRatio);
  say(`   节省比例（严格：仅 kind=generated 的 ${genOnly.length} 轮）: p50=${genRatios.length ? (pct(genRatios, 0.5) * 100).toFixed(1) : 'n/a'}% p90=${genRatios.length ? (pct(genRatios, 0.9) * 100).toFixed(1) : 'n/a'}%，≤10% 轮数=${genRatios.filter((x) => x <= 0.10).length}/${genRatios.length}`);
  say(`   绝对提前量 p50=${pct(abs, 0.5)}ms p90=${pct(abs, 0.9)}ms（对照旧结论 112ms）`);
  say(`   绝对提前量（严格口径）p50=${pct(genOnly.map((r) => r.inMs - r.firstTextDeltaMs), 0.5)}ms`);
  say(`   reasoning_deltas p50=${pct(usable.map((r) => r.reasoningDeltas ?? 0), 0.5)} content_deltas p50=${pct(usable.map((r) => r.contentDeltas ?? 0), 0.5)}`);
  say(`   样本文件：${SAMPLES}`);
  say(`   redact 命中 ${leaked} 次（>0 说明输出里确有 token/URL 被掩掉）`);
};

main().catch(async (error) => {
  say('测量中止：' + redact(String((error && error.message) ?? error)).slice(0, 400));
  process.exitCode = 1;
});
