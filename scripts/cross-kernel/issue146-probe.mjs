/**
 * **#146 复现与形态判定**（只读：不发按键写状态、不改设置，只在输入框里造草稿）。
 *
 * 上一次我在 #146 上错在「先认定根因、再写断言」，所以这次**只做观测**：
 * 造出「命令 + 灰字在屏」的场景，把能决定方向的读数全部打出来：
 *
 *  1. **形态**（源码 `buildText` 的客观差别）：`llm` ⇒ `el.textContent = text`（裸文本）；
 *     `inline`/`history` ⇒ 包一层 `<span>` 只放后缀。这是最硬的一条，不依赖日志档位。
 *  2. **几何**：灰字 `left` vs 命令 chip 的 `right` / 最后一段文本的 `right`。
 *  3. **自检**：`data-reject`（被几何自检拒了吗）、`data-shown`、`display`。
 *  4. **草稿温度**：chips 数、草稿原文。
 *
 * 覆盖四种造法（因为截图里到底是哪一种，我没法从静态截图判断）：
 *
 *  - `cmd-only`      ：`/later `
 *  - `cmd-then-text` ：`/later 提醒我`
 *  - `cmd-in-middle` ：`abc /later 提醒我`（chip 在行中）
 *  - `cmd-tight`     ：`/later`（**不带尾空格**——命令可能还没被识别成 chip）
 *
 * 用法：
 *   node scripts/cross-kernel/issue146-probe.mjs --home ~/dsh-sbx-146 --gen 0.2.1-rc.2
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const GEN = opt('gen', '?');
const WS_NAME = opt('wsname', 'xk-probe-ws');
const SHOT = opt('shot', `docs/cross-kernel-shots/issue146-${GEN}.png`);
if (HOME_ === '') throw new Error('必须给 --home <沙箱目录>');

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
if (!existsSync(LOG)) throw new Error(`沙箱日志不存在：${LOG}`);

const secrets = new Set();
const transcript = [];
const redact = (s) => { let o = String(s); for (const t of secrets) o = o.split(t).join('<redacted-token>'); return o; };
const say = (s) => { const l = redact(String(s)); transcript.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1]; secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

const GY = String.raw`
window.__p = {
  q: (s, r) => (r ?? document).querySelector(s),
  qa: (s, r) => [...(r ?? document).querySelectorAll(s)],
  name: (n) => ((n.getAttribute?.('aria-label') ?? '') + ' ' + (n.textContent ?? '')).trim().slice(0, 40),
  byText: (needle, sel) => window.__p.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__p.name(n).includes(needle)),
  composer: () => {
    const a = window.__p.qa('[data-composer-input], [role="textbox"]');
    return a.find((n) => {
      const label = n.getAttribute('aria-label') ?? '';
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !/选择工作区|Select workspace/.test(label);
    }) ?? null;
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__p.wait(120); } return false; },
  dialogClose: async () => {
    for (const d of window.__p.qa('[role=dialog]')) {
      const bs = [...d.querySelectorAll('button')];
      const b = bs.find((x) => /Continue|Got it|知道了|暂不开启|好$|OK|我已知晓|不再提示/i.test(window.__p.name(x)))
        ?? bs.find((x) => /关闭|Close/.test(x.getAttribute('aria-label') ?? '') || (x.textContent ?? '').trim() === '×'
          || /关闭|Close/.test(x.title ?? ''))
        ?? bs.find((x) => (x.textContent ?? '').trim().length === 1);
      if (b != null) { b.click(); await window.__p.wait(220); }
    }
  },
  ensureComposer: async () => {
    const ready = () => window.__p.composer() != null;
    if (ready()) return { ready: true, how: 'already' };
    const opener = window.__p.byText('选择工作区');
    if (opener != null) { opener.click(); await window.__p.wait(900); }
    const pickerDlg = () => window.__p.qa('[role=dialog]').find((d) => /选择工作区|工作区目录/.test(d.innerText ?? ''));
    const target = window.__WS || 'xk-probe-ws';
    const dl = pickerDlg();
    if (dl != null) {
      const rows = [...dl.querySelectorAll('*')].filter((n) => n.children.length === 0 && (n.textContent ?? '').trim() === target);
      const row = rows.find((n) => n.offsetParent !== null) ?? rows[0];
      if (row != null) { row.click(); await window.__p.wait(700); }
      const dl2 = pickerDlg();
      const open = (dl2 == null ? undefined : [...dl2.querySelectorAll('button')].find((b) => /^(Open|打开)$/.test((b.textContent ?? '').trim())));
      if (open != null && open.disabled !== true) { open.click(); await window.__p.wait(700); }
    }
    const ok = await window.__p.until(ready, 12000);
    return { ready: ok, how: 'picker' };
  },
  /** 一次完整的现场快照：形态 + 几何 + 自检 + 草稿。 */
  snapshot: () => {
    const el = document.getElementById('dsh-suggest-ghost-overlay');
    const ta = window.__p.composer();
    const draft = ta == null ? null : (ta.value !== undefined && ta.value !== null ? String(ta.value) : String(ta.textContent || ''));
    const out = { draft, chips: ta == null ? 0 : ta.querySelectorAll('[data-composer-command]').length };
    if (ta != null) {
      const chips = [...ta.querySelectorAll('[data-composer-command]')].map((c) => {
        const r = c.getBoundingClientRect();
        return { text: (c.textContent ?? '').trim().slice(0, 14), left: Math.round(r.left), right: Math.round(r.right) };
      });
      out.chipRects = chips;
      const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
      let lastText = null;
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) { if ((n.nodeValue ?? '').length > 0) lastText = n; }
      if (lastText !== null) {
        const rg = document.createRange(); const e = (lastText.nodeValue ?? '').length;
        rg.setStart(lastText, Math.max(0, e - 1)); rg.setEnd(lastText, e);
        out.lastTextRight = Math.round(rg.getBoundingClientRect().right);
      }
      const tRect = ta.getBoundingClientRect();
      out.editor = { left: Math.round(tRect.left), right: Math.round(tRect.right), top: Math.round(tRect.top) };
    }
    if (el == null) { out.ghost = { exists: false }; return out; }
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    const wrapped = el.firstElementChild != null && el.firstElementChild.tagName === 'SPAN' && el.childNodes.length === 1;
    out.ghost = {
      exists: true,
      shown: el.dataset.shown === '1',
      display: st.display,
      visible: r.width > 0 && r.height > 0 && st.display !== 'none',
      form: wrapped ? 'inline/history(span-wrapped)' : 'llm(bare-text)',
      firstChildTag: el.firstElementChild == null ? null : el.firstElementChild.tagName,
      childNodes: el.childNodes.length,
      chars: (el.textContent ?? '').trim().length,
      text: (el.textContent ?? '').trim().slice(0, 36),
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
      reject: el.dataset.reject ?? null,
    };
    return out;
  },
};`;

const dir = join(tmpdir(), `i146-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const cdpPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const wsConn = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { wsConn.onopen = res; wsConn.onerror = rej; });
let mid = 0; const pending = new Map(); let loadFired = false;
wsConn.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.loadEventFired') loadFired = true;
  if (m.id !== undefined && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error !== undefined) rej(new Error(JSON.stringify(m.error))); else res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++mid; pending.set(n, { res, rej }); wsConn.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression, awaitPromise = true) => {
  const probe = await send('Runtime.evaluate', { expression: 'typeof window.__p === "object"', returnByValue: true });
  if (probe.result?.value !== true) await send('Runtime.evaluate', { expression: GY, returnByValue: true });
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails !== undefined) return { pageError: redact(String(r.exceptionDetails.exception?.description ?? '')).slice(0, 300) };
  return r.result.value;
};
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
};
const clearAll = async () => {
  await evaluate('(() => { const n = window.__p.composer(); if (n != null) n.focus(); return true; })()');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
  await sleep(120);
  for (let i = 0; i < 3; i += 1) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await sleep(90);
  }
  await sleep(300);
};
const typeChars = async (text) => {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(55);
  }
};
const shot = async (sel, pad, padTop = pad, padBottom = pad) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n == null) return null;
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  if (box == null) return { noBox: true };
  const res = await send('Page.captureScreenshot', { format: 'png', clip: {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - padTop), width: box.w + pad * 2, height: box.h + padTop + padBottom, scale: 1 } });
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(res.data, 'base64'));
  return { ok: true, path: SHOT };
};

const out = { gen: GEN, at: new Date().toISOString(), note: '只观测，不下结论', cases: {} };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: urlOf() });
  let t0 = Date.now();
  while (!loadFired && Date.now() - t0 < 30000) await sleep(100);
  await sleep(800);
  await evaluate(GY);
  await evaluate(`window.__WS = ${JSON.stringify(WS_NAME)}`);
  await evaluate('window.__p.until(() => document.querySelector("[role=textbox],[role=dialog]") != null, 40000)');
  await sleep(600);
  for (let i = 0; i < 3; i += 1) { await evaluate('window.__p.dialogClose()'); await sleep(400); }
  out.workspace = await evaluate('window.__p.ensureComposer()');
  await evaluate('window.__p.dialogClose()');
  await evaluate(`(async () => { const b = window.__p.byText('新建会话') ?? window.__p.byText('新会话'); if (b != null) { b.click(); await window.__p.wait(1600); } return true; })()`);

  // 先发一个回合，让宿主-side 有东西可续写（inline 载荷来自上一轮草稿）。
  await evaluate('(() => { const n = window.__p.composer(); if (n != null) n.focus(); return true; })()');
  await sleep(200);
  const WARM = 'git worktree 和普通 clone 的区别是什么？一句话回答。';
  await send('Input.insertText', { text: WARM });
  await sleep(300);
  await pressEnter();
  // ⚠️ 暖机的判据是「回合已经发出去、宿主有机会产出续写载荷」，**不是**「幽灵已出现」。
  // 第一版等的是后者：回合刚发、建议还没生成 ⇒ 90s 后 `ok=false`，而后面四条用例其实
  // 全都拿到了正确读数（12 例 dx=0）。那个 false 只是探针在错的时刻问了错的问题。
  // 真正要看的是**页面里出现了一个回合**（用户消息气泡 + 助手回复开始），用 composer 清空
  // 且会话列表里出现新条目来判。
  out.warmup = await evaluate(`(async () => {
    const before = window.__p.qa('[data-message-id], [data-turn], .dsh-message').length;
    const grown = await window.__p.until(() => window.__p.qa('[data-message-id], [data-turn], .dsh-message').length > before, 90000);
    // 再给宿主一点时间把 completion 载荷推进来（本地生成，实测 1.3~2.1s）
    await window.__p.wait(2500);
    return { ok: grown, messageCount: window.__p.qa('[data-message-id], [data-turn], .dsh-message').length, snap: window.__p.snapshot() };
  })()`);
  await evaluate('window.__p.dialogClose()');
  await sleep(600);

  const cases = [
    ['cmd-only', '/later '],
    ['cmd-then-text', '/later 提醒我'],
    ['cmd-in-middle', 'abc /later 提醒我'],
    ['cmd-tight', '/later'],
  ];
  for (const [name, draftText] of cases) {
    await evaluate('(() => { const n = window.__p.composer(); if (n != null) n.focus(); return true; })()');
    await sleep(150);
    await clearAll();
    await typeChars(draftText);
    // 轮询到幽灵出现（续写是本地载荷，但宿主推送有延迟）
    await evaluate(`window.__p.until(() => { const s = window.__p.snapshot(); return s.ghost && s.ghost.exists === true && s.ghost.chars > 0; }, 15000)`);
    await sleep(400);
    out.cases[name] = { typed: draftText, snap: await evaluate('window.__p.snapshot()') };
    await shot('[data-input-scroll]', 26, 150, 46);
    await sleep(300);
  }

  // 附：沙箱日志里这一段的形态证据（宿主侧）—— 只数行，不解析
  const logText = readFileSync(LOG, 'utf8');
  const tail = logText.slice(Math.max(0, logText.length - 40000));
  out.hostTrace = {
    completionGenerated: (tail.match(/completion generated/g) ?? []).length,
    suggestionGenerated: (tail.match(/suggestion generated/g) ?? []).length,
    completionNotShown: (tail.match(/completion not shown/g) ?? []).length,
    rejectLines: tail.split('\n').filter((l) => /reject|anchor-drift|no-caret|caret-outside/.test(l)).slice(-4).map((l) => redact(l).slice(0, 160)),
  };
} catch (error) {
  out.error = redact(String(error?.message ?? error)).slice(0, 300);
} finally {
  proc.kill('SIGKILL');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  say(`====== issue146-probe ${GEN} ======`);
  say(JSON.stringify(out, null, 1));
  const emitted = transcript.join('\n');
  say(`· redact：token 明文进 stdout 次数 = ${[...secrets].filter((t) => emitted.includes(t)).length}`);
  const file = `scripts/cross-kernel/out/issue146-probe-${GEN}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 1));
  say(`· 证据：${file}`);
}
