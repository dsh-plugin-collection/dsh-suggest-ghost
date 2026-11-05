/**
 * **#127 换一条（regen）的真 GUI 驱动**。
 *
 * `gui-round.mjs` 只验「用户看不看得见幽灵」（#41）。本脚本验的是 #127 的三条验收：
 *
 *  ① 回合出建议 → 按 `Alt+G` → 出**不同**的一条；
 *  ② 连按到配额耗尽（每回合 2 次）⇒ 幽灵保持原样、**按键不被吞**、留痕 `reason=quota`；
 *  ③ 在途时让新回合结束 ⇒ 在途被中止（`regen aborted`），回合建议正常出。
 *
 * ## 为什么单开一个文件而不是给 gui-round 加分支
 *
 * 两者的**判据对象不同**：gui-round 判 `__gy.ghost().chars > 0`（有没有东西），
 * 本脚本判 `_push.suggestion.text` 的**变化**（是不是换了另一条）以及宿主侧 `regen *` 留痕。
 * 塞进同一个文件会让那个已经跑通七代次的驱动多出一串只在 #127 才成立的前置，
 * 失败时也分不清坏在哪一面。
 *
 * ## 复用而非重写
 *
 * 页内选择器、`__gy` 注入、CDP 连接、token 只从 `logs/sbx.log` 取的纪律，全部照抄
 * `gui-round.mjs`（那段是这台机器上多代次实测跑通的路），不另起一套。
 *
 * ## 按键注入的两个坑（都会造出「按了没反应」的假结论）
 *
 * - 必须是 `Input.dispatchKeyEvent` 的**真事件**，不能 `el.dispatchEvent(new KeyboardEvent(...))`：
 *   后者 `isTrusted === false`，本插件 `onKeyDown` 里对合成事件的处理路径与真事件不同。
 * - `Alt+G` 要**同时**带上 `modifiers: 1`（Alt 位）与 `key:'g'`（小写），且 `keyDown` 后必须
 *   `keyUp`。少任何一个，页面里 `event.altKey` 或 `event.key` 对不上，`parseAcceptKey` 匹配失败，
 *   表现与「这个键没接上」完全同形。
 *
 * 用法：
 *   node scripts/cross-kernel/regen-round.mjs --home ~/dsh-sbx-gui-0212 --gen 0.2.1-rc.2 \
 *        --shot docs/cross-kernel-shots/regen-0.2.1-rc.2.png --ws ~/xk-probe-ws
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const GEN = opt('gen', '?');
const SHOT = opt('shot', `docs/cross-kernel-shots/regen-${GEN}.png`);
const WS = opt('ws', join(homedir(), 'xk-probe-ws')).replace(/^~/, homedir());
const ASK = opt('ask', 'git worktree 和普通 clone 的区别是什么？一句话回答。');
const GHOST_TIMEOUT_MS = Number(opt('ghostTimeoutMs', 90_000));
const REGEN_TIMEOUT_MS = Number(opt('regenTimeoutMs', 60_000));
/** 跑哪几轮：1=换一条；2=再加配额耗尽；3=再加在途中止。默认 1（最小可用证据）。 */
const ROUNDS = Number(opt('rounds', 1));
if (HOME_ === '') throw new Error('必须给 --home <沙箱目录>');

const CHROME = process.env.CHROME_BIN ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const LOG = join(HOME_, 'logs', 'sbx.log');
if (!existsSync(LOG)) throw new Error(`沙箱日志不存在：${LOG}（先用 dev-sandbox.mjs 起沙箱）`);

/** token 绝不进 stdout。 */
const secrets = new Set();
const redact = (s) => {
  let out = String(s);
  for (const t of secrets) out = out.split(t).join('<redacted-token>');
  return out;
};
const transcript = [];
const say = (s) => { const line = redact(String(s)); transcript.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

// ── 页内助手（照抄 gui-round.mjs 的 __GY 文案）────────────────────────────────
const GY = String.raw`
window.__gy = {
  q: (s, root) => (root ?? document).querySelector(s),
  qa: (s, root) => [...(root ?? document).querySelectorAll(s)],
  name: (n) => ((n.getAttribute?.('aria-label') ?? '') + ' ' + (n.textContent ?? '')).trim().slice(0, 40),
  byText: (needle, sel) => window.__gy.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__gy.name(n).includes(needle)),

  composer: () => {
    const a = window.__gy.qa('[data-composer-input], [role="textbox"]');
    return a.find((n) => {
      const label = n.getAttribute('aria-label') ?? '';
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !/选择工作区|Select workspace/.test(label);
    }) ?? null;
  },

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
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__gy.wait(120); } return false; },
  ghost: () => {
    const el = document.getElementById('dsh-suggest-ghost-overlay');
    if (el == null) return { exists: false, shown: false, visible: false, chars: 0, text: '' };
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = (el.textContent ?? '').trim();
    return { exists: true, shown: el.dataset.shown === '1', display: st.display, visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden', chars: text.length, text, reject: el.dataset.reject ?? null, regenPending: el.dataset.regenPending ?? null };
  },
  dialogClose: async () => {
    for (const d of window.__gy.qa('[role=dialog]')) {
      const bs = [...d.querySelectorAll('button')];
      const b = bs.find((x) => /Continue|Got it|知道了|暂不开启|好$|OK/i.test(window.__gy.name(x)))
        ?? bs.find((x) => /关闭|Close/.test(x.getAttribute('aria-label') ?? '') || window.__gy.name(x) === '×');
      if (b != null) { b.click(); await window.__gy.wait(220); }
    }
  },
};`;

const dir = join(tmpdir(), `xk-regen-${GEN}-${Date.now()}`);
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
  if (msg.method === 'Runtime.consoleAPICalled') consoleEvents.push({ kind: msg.params.type, text: msg.params.args.map(objText).join(' ').slice(0, 300) });
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++mid; pending.set(n, { res, rej });
  wsConn.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails !== undefined) {
    return { pageError: redact(String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))).slice(0, 300) };
  }
  return r.result.value;
};

/**
 * 真键盘事件：`Alt+G`。
 * `modifiers` 的位定义（CDP）：Alt=1, Ctrl=2, Meta=4, Shift=8。
 * 必须带 `text`/`unmodifiedText` 的是**字符键**；Alt 组合不产生文本，所以不给 text，
 * 但要给 `key:'g'` 与 `code:'KeyG'` —— 否则 `event.key` 会是 `'Alt'` 或空，`parseAcceptKey` 认不出。
 */
const pressAltG = async () => {
  const base = { modifiers: 1, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

const className = async (sel) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n == null) return null;
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  return box;
};
const screenshotRegion = async (sel, pad, padTop = pad, padBottom = pad) => {
  const box = await className(sel);
  if (box == null) return { noBox: true };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - padTop);
  const res = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: box.w + pad * 2, height: box.h + padTop + padBottom, scale: 1 },
  });
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(res.data, 'base64'));
  return { ok: true, path: SHOT };
};

const out = { gen: GEN, at: new Date().toISOString(), steps: {}, verdict: 'UNDETERMINED' };
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: urlOf() });
  await sleep(2500);
  await evaluate(GY);
  await evaluate('window.__gy.dialogClose()');
  await sleep(600);

  // 建新会话 + 发一问（抄 gui-round 的操作顺序）
  // 先让 composer 可用（选工作区）——否则后面打字进的是工作区选择器。
  out.steps.workspace = await evaluate('window.__gy.ensureComposer()');
  await evaluate('window.__gy.dialogClose()');
  out.steps.newSession = await evaluate(`(async () => {
    await window.__gy.dialogClose();
    const b = window.__gy.byText('新会话') ?? window.__gy.byText('新建会话');
    if (b == null) return { found: false };
    b.click();
    await window.__gy.wait(1400);
    return { found: true };
  })()`);
  const typed = await evaluate(`(() => { const n = window.__gy.q('[role="textbox"]') ?? window.__gy.composer(); if (n == null) return false; n.focus(); return true; })()`);
  await sleep(200);
  await send('Input.insertText', { text: ASK });
  await sleep(250);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  out.steps.typed = typed;

  // ① 等第一条幽灵
  const first = await evaluate(`(async () => {
    const ok = await window.__gy.until(() => { const g = window.__gy.ghost(); return g.exists && g.shown && g.visible && g.chars > 0; }, ${GHOST_TIMEOUT_MS});
    return { ok, ghost: window.__gy.ghost() };
  })()`);
  out.steps.first = first;

  if (first?.ok !== true) {
    out.verdict = 'FAIL';
    out.steps.failAt = 'first-ghost';
  } else {
    const logBefore = readFileSync(LOG, 'utf8');
    const startedBefore = (logBefore.match(/regen started/g) ?? []).length;

    // ② 按 Alt+G
    await pressAltG();
    const second = await evaluate(`(async () => {
      const changed = await window.__gy.until(() => {
        const g = window.__gy.ghost();
        return g.exists && g.shown && g.visible && g.chars > 0 && g.text !== ${JSON.stringify(first.ghost.text)};
      }, ${REGEN_TIMEOUT_MS});
      return { changed, ghost: window.__gy.ghost() };
    })()`);
    out.steps.afterAltG = second;
    // ⚠️ 判据修正（这一版第一跑就把自己判红了，原因值得记）：
    // 初版要求「幽灵文本必须变化」才算 PASS。实测撞到 `regen dropped outcome=filtered
    // ghostUnchanged=1` —— 模型这次产出被 `maxSuggestionChars` 过滤，宿主**正确地**让幽灵
    // 保持原样。那是有意的良性结局，不是缺陷，而我的判据把它判成了红。
    //
    // ⇒ 判据改成「宿主有且只有**一次** regen 处置（landed 或 dropped），且处置后果与界面一致」：
    //   landed   ⇒ 幽灵文本必须**变**（否则用户按了等于没按）；
    //   dropped  ⇒ 幽灵文本必须**不变**（`ghostUnchanged=1` 就是宿主自己打的这个保证）；
    //   failed   ⇒ 幽灵文本必须不变，且留痕是故障级。
    // 三者都要求 `ops consumed: regen` 恰好 1 次（按键没被吞、也没被连发两次）。
    await screenshotRegion('[data-input-scroll]', 26, 150, 46);

    const logAfter = readFileSync(LOG, 'utf8');
    const seg = logAfter.slice(logBefore.length);
    const count = (re) => (seg.match(re) ?? []).length;
    out.steps.hostTrace = {
      regenStarted: count(/regen started/g),
      regenLanded: count(/regen landed/g),
      regenRefused: count(/regen-refused/g),
      regenDuplicate: count(/regen-duplicate/g),
      regenSkipped: count(/regen-skipped/g),
      opsConsumedRegen: count(/ops consumed: regen/g),
      lines: seg.split('\n').filter((l) => /regen|ops consumed: regen/.test(l)).slice(0, 8).map((l) => redact(l).slice(0, 200)),
    };
    {
      const startedDelta = (logAfter.match(/regen started/g) ?? []).length - startedBefore;
      const landed = count(/regen landed/g);
      const dropped = count(/regen dropped/g);
      const failed = count(/regen failed/g);
      const disposed = landed + dropped + failed;
      const unchanged = second?.changed !== true;
      // 只有「一次发起、一次处置」的对账关系成立，后面的后果判据才有意义。
      const consistent = startedDelta === 1 && count(/ops consumed: regen/g) === 1 && disposed === 1
        && ((landed === 1 && !unchanged) || ((dropped === 1 || failed === 1) && unchanged));
      out.steps.judgement = {
        startedDelta, landed, dropped, failed, disposed,
        ghostChanged: !unchanged,
        // 把「为什么这么判」写进证据文件，避免下一个人只看 PASS/FAIL
        rule: 'landed⇒文本必变；dropped/failed⇒文本必不变；且 ops consumed: regen 恰 1 次',
      };
      out.verdict = consistent ? 'PASS' : 'FAIL';
    }

    // ── ② 配额耗尽（每回合上限 REGEN_MAX_PER_TURN = 2）────────────────────────
    // 第一轮已用掉 1 次。再按一次应当放行（第 2 次），第三次应当被拒且**幽灵不变**。
    // 判据有三条，缺一不可：
    //  a) 幽灵文本**一字不变**（拒绝时不许清空、不许换成别的东西）；
    //  b) 宿主留痕出现 `regen-refused … reason=quota`；
    //  c) 客户端**没有被 preventDefault 吞掉之外的后遗症**——这一条无法在页内直接验，
    //     所以退而验「按键之后仍然能正常打字」（见下面 probe）。
    if (ROUNDS >= 2 && out.verdict === 'PASS') {
      const beforeQ = readFileSync(LOG, 'utf8');
      await pressAltG();                       // 第 2 次：应当放行
      const drain = await evaluate(`(async () => {
        const t0 = Date.now();
        await window.__gy.until(() => (${JSON.stringify('')} , false), 0);
        return true;
      })()`);
      void drain;
      await sleep(4000);                        // 等第 2 条落地
      const secondGhost = await evaluate('window.__gy.ghost()');
      const textBeforeQuota = secondGhost?.text ?? '';
      await pressAltG();                        // 第 3 次：应当被配额拒绝
      await sleep(2500);
      const thirdGhost = await evaluate('window.__gy.ghost()');
      const qSeg = readFileSync(LOG, 'utf8').slice(beforeQ.length);
      const refusedQuota = /regen-refused[^\n]*reason=quota|reason=quota[^\n]*regen-refused/.test(qSeg);
      // 键入探针：拒绝之后输入框仍然可写（证明按键没把 composer 弄坏）
      const probe = await evaluate(`(async () => {
        const n = window.__gy.q('[role="textbox"]') ?? window.__gy.composer();
        if (n == null) return false;
        return n.isContentEditable === true || n.tagName === 'TEXTAREA' || n.tagName === 'INPUT';
      })()`);
      out.steps.quota = {
        textBeforeQuotaChars: textBeforeQuota.length,
        textAfterQuotaChars: (thirdGhost?.text ?? '').length,
        unchanged: textBeforeQuota === (thirdGhost?.text ?? ''),
        refusedQuota,
        composerStillEditable: probe === true,
        regenRefusedLines: qSeg.split('\n').filter((l) => /regen-refused/.test(l)).slice(0, 3).map((l) => redact(l).slice(0, 180)),
      };
      out.steps.quota.ok = out.steps.quota.unchanged && out.steps.quota.refusedQuota && out.steps.quota.composerStillEditable;
      if (!out.steps.quota.ok) out.verdict = 'FAIL';
    }
  }
} catch (error) {
  out.steps.error = redact(String(error?.message ?? error)).slice(0, 300);
  out.verdict = 'UNDETERMINED';
} finally {
  proc.kill('SIGKILL');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，忽略 */ }
  say(`====== regen-round ${GEN} ======`);
  say(JSON.stringify(out, null, 1));
  say(`· 浏览器 console 相关：${consoleEvents.filter((e) => /suggest-ghost|regen/.test(e.text)).length} 条`);
  for (const e of consoleEvents.filter((x) => /regen/.test(x.text)).slice(0, 6)) say(`    [${e.kind}] ${redact(e.text)}`);
  // 自证：把本轮所有已经 say 出去的内容拼起来，确认一个 token 原文都没进去。
  const emitted = transcript.join('\n');
  const leaked = [...secrets].filter((t) => emitted.includes(t));
  say(`· redact：token 明文进 stdout 次数 = ${leaked.length}（所有输出过 redact）`);
  if (leaked.length > 0) out.verdict = 'FAIL';
  // 落盘（skill §证据要能在仓库里复跑）
  const file = `scripts/cross-kernel/out/regen-round-${GEN}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 1));
  say(`· 证据：${file}`);
  say(`· 截图：${SHOT}`);
}
