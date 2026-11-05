/**
 * **PR #4 / Gitea #129 的行为验收**：草稿非空时，llm 幽灵必须**不出现在界面上**。
 *
 * ## 为什么不能只看冒烟
 *
 * `scripts/llm-form-guard-smoke.mjs` 验的是**判据**（`decideLlmForm` 的返回值）。
 * 但 PR #4 描述的是**界面现象**：「旧建议仍画在输入框上，与已打文字糊在一起」。
 * 判据对、接线错、或有人在上层加了别的分支，都可能让现象回来而判据仍全绿。
 *
 * 所以本脚本直接从 DOM 读：造出「有一条 llm 建议在场」+「草稿非空」的组合，
 * 断言 `#dsh-suggest-ghost-overlay` 的 `shown/visible` 为假、`chars` 为 0。
 *
 * ## 怎么造出这个组合（顺序有讲究）
 *
 * 1. 新会话 → 发一问 → 建议出现（此时草稿为空，llm 幽灵可见，这是**正对照**）；
 * 2. **不动 `settings.suggestion`**，直接在 composer 里打字；
 * 3. 断言幽灵**消失**（`shown=false` 或 `chars=0`），且**草稿的文字还在**（没被吞）；
 * 4. 反向对照：把打的字删光，建议应当**回来**（证明它只是不画，不是被清掉）。
 *
 * 第 4 步是这条脚本的核心价值：PR #4 的方案只在渲染前 hide，建议状态没动；
 * 我们的方案在 `ghostContent()` 源头判掉，同样不动状态。两者在 1~3 步表现一样，
 * **只有第 4 步能区分「不画」与「被清掉了」**——而后者会让草稿清空后也回不来。
 *
 * 用法：
 *   node scripts/cross-kernel/pr4-overlap-round.mjs --home ~/dsh-sbx-gui-0212 --gen 0.2.1-rc.2
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const GEN = opt('gen', '?');
const SHOT = opt('shot', `docs/cross-kernel-shots/pr4-overlap-${GEN}.png`);
const ASK = opt('ask', 'git worktree 和普通 clone 的区别是什么？一句话回答。');
const GHOST_TIMEOUT_MS = Number(opt('ghostTimeoutMs', 90_000));
/** 探针工作区名（侧栏里那个目录的**叶子名**）。 */
const WS_NAME = opt('wsname', 'xk-probe-ws');
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
window.__gy = {
  q: (s, r) => (r ?? document).querySelector(s),
  qa: (s, r) => [...(r ?? document).querySelectorAll(s)],
  name: (n) => ((n.getAttribute?.('aria-label') ?? '') + ' ' + (n.textContent ?? '')).trim().slice(0, 40),
  byText: (needle, sel) => window.__gy.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__gy.name(n).includes(needle)),
  /**
   * 真正的输入框。**必须排除工作区选择器**：它同样带 [role=textbox]、同样可见，
   * 但 aria-label 是「选择工作区」。选中它的后果是「往选择器里打字」——
   * afterInsert 读到 draft 长度 0，整轮静默失败（实测踩到）。
   */
  composer: () => {
    const a = window.__gy.qa('[data-composer-input], [role="textbox"]');
    return a.find((n) => {
      const label = n.getAttribute('aria-label') ?? '';
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !/选择工作区|Select workspace/.test(label);
    }) ?? null;
  },
  /** 草稿原文（同时兼容 textarea.value 与 contenteditable.textContent）。 */
  draft: () => { const n = window.__gy.composer(); if (n == null) return null;
    return n.value !== undefined && n.value !== null ? String(n.value) : String(n.textContent ?? ''); },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__gy.wait(120); } return false; },
  ghost: () => {
    const el = document.getElementById('dsh-suggest-ghost-overlay');
    if (el == null) return { exists: false, shown: false, visible: false, chars: 0, text: '' };
    const st = getComputedStyle(el); const r = el.getBoundingClientRect(); const t = (el.textContent ?? '').trim();
    return { exists: true, shown: el.dataset.shown === '1', display: st.display,
      visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden',
      chars: t.length, text: t, reject: el.dataset.reject ?? null };
  },
  /**
   * 让 composer 变成可用（= 选上一个工作区）。
   *
   * 实测形态（本机 0.2.1-rc.2）：未选工作区时页面上**唯一**的 [role=textbox] 是
   * 「选择工作区」那个框，ps。'composerInputs' 有 1 个但不可交互，页面文字是
   * 「选择一个工作区开始」。所以判据不是「对话框开没开」，而是**composer 能否聚焦**。
   */
  ensureComposer: async () => {
    const ready = () => {
      const n = window.__gy.composer();
      if (n == null) return false;
      const label = n.getAttribute('aria-label') ?? '';
      if (/选择工作区/.test(label)) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    if (ready()) return { ready: true, how: 'already' };
    // ① 先点「选择工作区」按钮把选择器叫出来
    const opener = window.__gy.byText('选择工作区');
    if (opener != null) { opener.click(); await window.__gy.wait(900); }
    const dialogs = () => window.__gy.qa('[role=dialog]');
    const pickerDlg = () => dialogs().find((d) => /选择工作区|工作区目录/.test(d.innerText ?? ''));
    // ② 在列表里点目标目录行（叶子文本精确等于 WS）
    const target = window.__WS || 'xk-probe-ws';
    let dlg = pickerDlg();
    if (dlg != null) {
      const rows = [...dlg.querySelectorAll('*')].filter((n) => n.children.length === 0 && (n.textContent ?? '').trim() === target);
      const row = rows.find((n) => n.offsetParent !== null) ?? rows[0];
      if (row != null) { row.click(); await window.__gy.wait(700); }
      const dl = pickerDlg();
      const open = (dl == null ? undefined : [...dl.querySelectorAll('button')].find((b) => /^(Open|打开)$/.test((b.textContent ?? '').trim())));
      if (open != null && open.disabled !== true) { open.click(); await window.__gy.wait(700); }
    }
    const ok = await window.__gy.until(ready, 12000);
    return { ready: ok, how: 'picker', dialogStillOpen: pickerDlg() != null };
  },
  dialogClose: async () => {
    for (const d of window.__gy.qa('[role=dialog]')) {
      const bs = [...d.querySelectorAll('button')];
      // WARN: 这个 ?? 链里不许插注释 —— 注释会把链截断成两条语句，报 Unexpected token。
      // （本文件踩过一次）。三层都写在一条表达式里：
      //   ① 文案按钮（Continue / 知道了 …）；② aria-label 或文本为 × 的关闭键；
      //   ③ 任何单字符文本按钮（费用弹窗的 × 常常没有 aria-label）。
      const b = bs.find((x) => /Continue|Got it|知道了|暂不开启|好$|OK|我已知晓|不再提示/i.test(window.__gy.name(x)))
        ?? bs.find((x) => /关闭|Close/.test(x.getAttribute('aria-label') ?? '') || (x.textContent ?? '').trim() === '×'
          || /关闭|Close/.test(x.title ?? ''))
        ?? bs.find((x) => (x.textContent ?? '').trim().length === 1);
      if (b != null) { b.click(); await window.__gy.wait(220); }
    }
  },
};`;

const dir = join(tmpdir(), `xk-pr4-${GEN}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let k = 0; k < 100 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
const cdpPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const wsConn = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { wsConn.onopen = res; wsConn.onerror = rej; });
let mid = 0; const pending = new Map();
let loadFired = false;
wsConn.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.loadEventFired') loadFired = true;
  if (m.id !== undefined && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error !== undefined) rej(new Error(JSON.stringify(m.error))); else res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++mid; pending.set(n, { res, rej }); wsConn.send(JSON.stringify({ id: n, method, params })); });
/**
 * 每次求值前**确保页内助手在位**。
 *
 * 为什么需要这一层：SPA 的导航（或 React 的整树替换）会让执行上下文换掉，
 * 之前注入的 `window.__gy` 就没了 —— 而失败表现是每条 `evaluate` 都抛
 * `Cannot read properties of undefined (reading 'qa')`，看起来像"脚本写错了"。
 * 实测踩到两次。对抗上下文切换不可靠，所以改成幂等重注入。
 */
let gyInjected = false;
const ensureGy = async () => {
  const probe = await send('Runtime.evaluate', { expression: 'typeof window.__gy === "object"', returnByValue: true });
  if (probe.result?.value === true) return true;
  const inj = await send('Runtime.evaluate', { expression: GY, returnByValue: true });
  gyInjected = inj.exceptionDetails === undefined;
  return gyInjected;
};
const evaluate = async (expression, awaitPromise = true) => {
  await ensureGy();
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails !== undefined) return { pageError: redact(String(r.exceptionDetails.exception?.description ?? '')).slice(0, 300) };
  return r.result.value;
};
/** 等 `Page.loadEventFired`（或超时）。导航后不等它，注入的助手会被冲掉。 */
const waitForLoad = async (ms) => {
  loadFired = false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (loadFired) return true; await sleep(100); }
  return false;
};
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
};
/** 把 composer 里的草稿**整段删掉**（全选 + 退格），用于第 4 步反向对照。 */
const clearDraft = async () => {
  await evaluate(`(() => { const n = window.__gy.composer(); if (n != null) n.focus(); return true; })()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
  await sleep(120);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await sleep(400);
};
const screenshotRegion = async (sel, pad, padTop = pad, padBottom = pad) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n == null) return null;
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  if (box == null) return { noBox: true };
  const res = await send('Page.captureScreenshot', { format: 'png', clip: {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - padTop), width: box.w + pad * 2, height: box.h + padTop + padBottom, scale: 1 } });
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(res.data, 'base64'));
  return { ok: true, path: SHOT };
};

const out = { gen: GEN, at: new Date().toISOString(), claim: 'PR#4 / #129：草稿非空 ⇒ llm 幽灵不得出现在界面上', steps: {}, verdict: 'UNDETERMINED' };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: urlOf() });
  // ⚠️ 导航后立刻注入 = 注入会被文档加载冲掉（`window.__gy` 变 undefined，
  //    后面每条 evaluate 都报 "Cannot read properties of undefined (reading 'qa')"）。
  //    必须先等 load 事件，再注入，再轮询 UI。
  await waitForLoad(30000);
  await sleep(600);
  await evaluate(GY);
  await evaluate(`window.__WS = ${JSON.stringify(WS_NAME)}`);
  // 再确认注入真的在（防御：SPA 可能在 load 之后又整页替换一次）
  const injected = await evaluate('typeof window.__gy === "object"');
  if (injected !== true) { await sleep(1500); await evaluate(GY); }
  // ⚠️ 固定 sleep 不够：GUI 是 React 懒挂载，2.5s 时页面里只有 boot 脚本，
  //    `[role=dialog]` 一个都没有 ⇒ 后面所有判断都对着一片白板做（实测如此）。
  //    改成轮询到**真 UI** 出现为止。
  await evaluate(`window.__gy.until(() => document.querySelector('[role=textbox],[role=dialog],dialog') != null, 40000)`);
  await sleep(800);
  // 首启引导弹窗链：费用显示 / Continue / Got it …，每个都带 mask 会拦点击。
  // 连点三轮（弹窗是串联的，点掉一个可能冒出下一个）。
  for (let round = 0; round < 3; round += 1) {
    const closed = await evaluate(`window.__gy.dialogClose()`);
    void closed;
    await sleep(500);
    const left = await evaluate(`window.__gy.qa('[role=dialog]').filter((d) => /按需设置|费用显示|Preview|Get started|继续/.test(d.innerText ?? '')).length`);
    if (left === 0) break;
  }
  out.steps.onboarding = await evaluate(`window.__gy.qa('[role=dialog]').map((d) => (d.getAttribute('aria-label') || '') + '|' + (d.innerText ?? '').slice(0, 30))`);
  // 选工作区（Worktree/克隆那条路之前必须落到一个真目录上，否则消息发不出去）。
  // 探针工作区固定用 ~/xk-probe-ws（与 gui-round 同一份，用户已建好的实体目录）。
  // ⚠️ 必须**先等对话框出现**再点：上一版在页面 ready 之前就查，`needed:false` 直接跳过，
  // 结果选择器一直挡着，后面全错（诊断读数里 dialogTexts 一直是「选择工作区目录」）。
  out.steps.workspace = await evaluate('window.__gy.ensureComposer()');
  await evaluate('window.__gy.dialogClose()');
  await sleep(500);
  // 新会话按钮可能出现在侧栏工作区行上；先看页面到哪一步了
  out.steps.pageState = await evaluate(`(() => ({
    textboxes: window.__gy.qa('[role=textbox]').map((n) => ({ tag: n.tagName, label: (n.getAttribute('aria-label') || '').slice(0, 20), vis: n.getBoundingClientRect().width > 0 })),
    composerInputs: window.__gy.qa('[data-composer-input]').length,
    buttons: window.__gy.qa('button, [role=button]').map((b) => window.__gy.name(b)).slice(0, 14),
    hasWorkspacePicker: window.__gy.qa('[role=dialog]').some((d) => /选择工作区/.test(d.innerText ?? '')),
    bodyHead: (document.body.innerText ?? '').split(String.fromCharCode(10)).filter(Boolean).slice(0, 8).join(' | '),
  }))()`);
  out.steps.newSession = await evaluate(`(async () => {
    await window.__gy.dialogClose();
    const b = window.__gy.byText('新建会话') ?? window.__gy.byText('新会话');
    if (b == null) return { found: false };
    b.click();
    await window.__gy.wait(1600);
    return { found: true };
  })()`);
  await evaluate(`(() => { const n = window.__gy.composer(); if (n == null) return false; n.focus(); return true; })()`);
  await sleep(200);
  const focused = await evaluate(`(() => { const n = window.__gy.composer(); if (n == null) return { ok: false }; n.focus(); return { ok: true, tag: n.tagName, editable: n.isContentEditable === true, label: (n.getAttribute('aria-label') || '').slice(0, 24) }; })()`);
  out.steps.composer = focused;
  await send('Input.insertText', { text: ASK });
  await sleep(400);
  out.steps.afterInsert = await evaluate(`({ draft: window.__gy.draft(), len: (window.__gy.draft() ?? '').length })`);
  await pressEnter();
  await sleep(1200);
  // 发送是否真的发生：草稿清空 = 发出去了；还留着 = 只插了换行
  out.steps.afterEnter = await evaluate(`({ draft: window.__gy.draft(), len: (window.__gy.draft() ?? '').length })`);
  if ((out.steps.afterEnter?.len ?? 0) > 0) {
    // 兜底：点发送按钮
    out.steps.sendFallback = await evaluate(`(async () => {
      const b = window.__gy.byText('发送'); if (b == null) return { clicked: false };
      b.click(); await window.__gy.wait(800);
      return { clicked: true, draft: window.__gy.draft() };
    })()`);
  }

  // ① 正对照：空草稿 ⇒ llm 幽灵出现
  out.steps.positiveControl = await evaluate(`(async () => {
    const ok = await window.__gy.until(() => { const g = window.__gy.ghost(); return g.exists && g.shown && g.visible && g.chars > 0; }, ${GHOST_TIMEOUT_MS});
    return { ok, ghost: window.__gy.ghost(), draft: window.__gy.draft() };
  })()`);

  if (out.steps.positiveControl?.ok !== true) {
    out.verdict = 'FAIL'; out.steps.failAt = 'positive-control';
    // 诊断：把「页面到底停在哪」记下来，否则 failing 在这一步等于什么都没说。
    // 三种常见成因在读数上完全同形：首启弹窗没点掉 / 新会话按钮没点中 / GUI 还没 ready。
    out.steps.diagnosis = await evaluate(`(() => ({
      title: document.title,
      url: String(location.href).replace(/token=[^&]+/, 'token=<r>'),
      dialogs: window.__gy.qa('[role=dialog]').length,
      dialogsOpen: window.__gy.qa('dialog[open]').length,
      dialogTexts: window.__gy.qa('[role=dialog]').map((d) => (d.innerText ?? '').slice(0, 60)),
      hasComposer: (window.__gy.composer()) != null,
      newSessionButtons: window.__gy.qa('button, [role=button]').map((b) => window.__gy.name(b)).filter((n) => /新会话|新建|New session/.test(n)),
      bodyHead: (document.body.innerText ?? '').slice(0, 160),
    }))()`);
  } else {
    const suggestionText = out.steps.positiveControl.ghost.text;

    // ② 在**不提交**的情况下打字（这正是 PR #4 描述的触发条件）
    await evaluate(`(() => { const n = window.__gy.composer(); if (n != null) n.focus(); return true; })()`);
    await sleep(150);
    await send('Input.insertText', { text: '这是用户新打的字' });
    await sleep(1200);

    // ③ 断言：幽灵消失，草稿文字还在
    out.steps.withDraft = await evaluate(`(async () => {
      await window.__gy.wait(400);
      return { draft: window.__gy.draft(), ghost: window.__gy.ghost() };
    })()`);
    await screenshotRegion('[data-input-scroll]', 26, 150, 46);

    const withDraft = out.steps.withDraft;
    const ghostGone = withDraft.ghost?.shown !== true || withDraft.ghost?.chars === 0 || withDraft.ghost?.visible !== true;
    const draftIntact = (withDraft.draft ?? '').includes('这是用户新打的字');

    // ④ 反向对照：清空草稿 ⇒ 建议应当**回来**（证明只是不画，状态没被清掉）
    await clearDraft();
    out.steps.afterClear = await evaluate(`(async () => {
      const back = await window.__gy.until(() => { const g = window.__gy.ghost(); return g.exists && g.shown && g.visible && g.chars > 0; }, 15000);
      return { back, ghost: window.__gy.ghost(), draft: window.__gy.draft() };
    })()`);
    const afterClear = out.steps.afterClear;
    const returned = afterClear.back === true;
    const sameSuggestion = returned && afterClear.ghost?.text === suggestionText;

    out.steps.verdictParts = { ghostGoneWithDraft: ghostGone, draftIntact, suggestionReturnsAfterClear: returned, sameSuggestion };
    out.verdict = (ghostGone && draftIntact && returned) ? 'PASS' : 'FAIL';
    out.steps.note = sameSuggestion ? null : '清空后回来的建议与原来那条不同（模型可能重出；不算缺陷，但记下来）';
  }
} catch (error) {
  out.steps.error = redact(String(error?.message ?? error)).slice(0, 300);
  out.verdict = 'UNDETERMINED';
} finally {
  proc.kill('SIGKILL');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  say(`====== pr4-overlap-round ${GEN} ======`);
  say(JSON.stringify(out, null, 1));
  const emitted = transcript.join('\n');
  say(`· redact：token 明文进 stdout 次数 = ${[...secrets].filter((t) => emitted.includes(t)).length}`);
  const file = `scripts/cross-kernel/out/pr4-overlap-${GEN}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 1));
  say(`· 证据：${file}`);
  say(`· 截图：${SHOT}`);
}
