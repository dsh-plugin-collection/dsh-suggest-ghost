// #63 的「让路在真实宿主里的比例」现场量测驱动（task-22）。
//
// **为什么需要 in-page**：让路要同时满足三件事（`src/index.ts` 的 `complete` 分支）——
//   ① 热度合并窗口开着（1000ms 内刚写过 `_hot`）
//   ② 此刻热表又变了、但**没有**任何 pushToClient 把那份变化带走（⇒ 该次推送本可推迟）
//   ③ 这一拍到达的是 `complete` op（用户打了 ≥inlineMinChars 个字符并停顿）
// ①→③ 之间只剩 1s，而跨多次外部调用一次往返就是数秒 ⇒ 三步必须写进**同一次** in-page 脚本。
//
// **token 不进 transcript**：本脚本自己起沙箱、自己读 `logs/sbx.log` 拿 URL+token、
// 自己在同一进程里用 CDP 操作浏览器。所有输出过一遍 redact()，并在结束时自证明文没出现过。
//
// 用法（worktree 内）：
//   node scripts/hot-yield-ratio.mjs --probe            # 只跑一轮 + 打 DOM 盘点（先验通路）
//   node scripts/hot-yield-ratio.mjs --rounds 12        # 正式量比例
//   node scripts/hot-yield-ratio.mjs --keep             # 跑完不清理（排障用，**会留凭据副本**）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME ?? '';
const REPO = process.cwd();
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const SANDBOX = String(opt('home', join(HOME, 'dsh-sbx-yield'))).replace(/^~/, HOME);
const WS = String(opt('ws', join(HOME, 'dsh-sbx-yield-ws'))).replace(/^~/, HOME);
const ROUNDS = Number(opt('rounds', flag('probe') ? 1 : 12));
const GATEWAY = Number(opt('gateway', 4118));
const CHROME = process.env.CHROME_BIN
  ?? join(HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

// ── 输出必须过这一道：token 与 URL 明文一律不进 stdout ───────────────────────
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

// ── 沙箱：建目录 → 打补丁（enable 条目）→ 用 --deploy 启动（不 rmSync，补丁才不被冲掉）──
const ensureSandbox = async () => {
  if (existsSync(join(SANDBOX, 'profiles', 'web', 'node_modules'))) {
    // ⚠️ 复用沙箱时 `--check` 被跳过 ⇒ 它顺手建的 `-ws` 工作区目录可能已经被上一轮
    // 清掉了（本轮就是这么死的：picker 里输了一个不存在的目录，「打开」静默不确认）。
    mkdirSync(WS, { recursive: true });
    writeFileSync(join(WS, 'note.txt'), 'ghost yield probe\n');
    say(`· 沙箱已存在，复用 ${SANDBOX}（工作区 ${WS} 已确保存在）`);
  } else {
    say('· 建沙箱（--check：私有产物副本 + 凭据副本）');
    const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', SANDBOX, '--ws', WS,
      '--rewrite', `port: 3983=port: ${GATEWAY}`, '--check'], { cwd: REPO });
    if (r.code !== 0) throw new Error('建沙箱失败：' + redact(r.err.slice(-400)));
  }
  const profile = join(SANDBOX, 'profiles', 'web', 'cordis.patch.yml');
  let t = readFileSync(profile, 'utf8');
  const i = t.indexOf('- id: suggest-ghost');
  if (i < 0) throw new Error('沙箱 profile 里没有 suggest-ghost 条目');
  let j = t.indexOf('\n- id: ', i + 5); if (j < 0) j = t.length;
  const block = t.slice(i, j).replace(/^(\s*)disabled:\s*true\s*$/m, '$1disabled: false');
  if (!/disabled: false/.test(block)) throw new Error('条目没翻成 enabled');
  t = t.slice(0, i) + block + t.slice(j);
  // inlineDelayMs 压到 60：让「停顿 → complete」尽可能早，抢 1000ms 窗口
  t = t.replace(/^(\s*)inlineDelayMs: \d+$/m, '$1inlineDelayMs: 60');
  // ⚠️ 关掉沙箱里的 auto-continue：它会**自己往会话里发「继续」**，于是 complete/hot 计数
  // 混进非本轮动作（实测出现过「分子 3 / 分母 2 = 1.50」这种不可能的比例）。
  {
    const i = t.indexOf('- id: auto-continue');
    if (i >= 0) {
      const j = t.indexOf('\n- id: ', i + 5); const blk = t.slice(i, j < 0 ? t.length : j);
      if (/enabled:\s*true/.test(blk)) t = t.slice(0, i) + blk.replace(/enabled:\s*true/, 'enabled: false') + t.slice(j < 0 ? t.length : j);
      else if (!/enabled:/.test(blk)) t = t.slice(0, i) + blk.replace(/^(- id: auto-continue\n)/, '$1  enabled: false\n') + t.slice(j < 0 ? t.length : j);
    }
  }
  writeFileSync(profile, t);
  say('· profile 已打补丁（enabled + inlineDelayMs=60）');

  say('· 启动实例（--deploy 复用已构建产物）');
  const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', SANDBOX, '--ws', WS,
    '--rewrite', `port: 3983=port: ${GATEWAY}`, '--deploy', '.'], { cwd: REPO });
  if (!/存活=yes/.test(r.out)) throw new Error('实例没起来：' + redact(r.out.slice(-500)));
  const m = r.out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
  if (!m) throw new Error('日志里没有 URL');
  secrets.add(m[2]);
  const url = `http://127.0.0.1:${m[1]}/?token=${m[2]}`;
  const pidfile = join(SANDBOX, 'sbx.pid');
  say(`· 实例存活，端口 ${m[1]}（token 已登记进 redact，不打印）`);
  return { url, pids: readFileSync(pidfile, 'utf8').split(/\s+/).filter(Boolean) };
};

// ── CDP：零依赖（Node 自带 WebSocket），浏览器也在本地临时目录里 ──────────────
const cdpSession = async () => {
  const dir = join(tmpdir(), `cdp-yield-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let k = 0; k < 60; k += 1) {
    if (existsSync(portFile)) break;
    await sleep(200);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
    close: () => { try { ws.close(); } catch { /* noop */ } proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); },
    evaluate: async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails !== undefined) {
        throw new Error('页内异常：' + redact(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300)));
      }
      return r.result.value;
    },
  };
};

// ── 页内工具：Lexical 输入框要用真事件，直接改 textContent 不会更新内部状态 ────
const PAGE_HELPERS = `
window.__gy = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  // ⚠️ 必须**限定作用域 + 精确匹配**：全局 byText('打开') 会命中侧栏那个
  // 「余额 打开 DeepSeek 充值页」按钮（文本里就含「打开」），点了它工作区当然选不上。
  btnIn: (scopeSel, label) => {
    const scope = scopeSel === null ? document : window.__gy.q(scopeSel) ?? document;
    const bs = [...scope.querySelectorAll('button, [role=button]')];
    return bs.find((b) => window.__gy.name(b) === label) ?? bs.find((b) => window.__gy.name(b).includes(label)) ?? null;
  },
  byText: (needle, sel) => window.__gy.qa(sel || 'button, [role=button], [role=textbox]').find((n) => window.__gy.name(n).includes(needle)),
  click: (n) => { if (n === undefined || n === null) return false; n.scrollIntoView(); n.click(); return true; },
  setNative: (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },
  // 实测：页面上有**两个** [data-composer-input] —— 「选择工作区」那个是 data-phase=inert
  // 的 combobox 壳（打字永远失败），可编辑的那个 aria-label 是「描述你想要构建的内容…」
  // 或「发消息或创建任务…」。⇒ 优先取非 inert 的那一个。
  composer: () => {
    const all = window.__gy.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert')
      ?? document.querySelector('[contenteditable=true]')
      ?? all[0] ?? null;
  },
  composers: () => window.__gy.qa('[data-composer-input]').map((n) => [n.tagName, n.dataset.phase ?? '', (n.getAttribute('aria-label') ?? '').slice(0, 16)].join('/')),
  typeInto: (el, text) => {
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return ok;
  },
  press: (el, key, code) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }));
  },
  dismiss: async () => {
    // 实测的拒绝按钮文案（逐个抄下来，别猜）：保留当前显示 / 暂不开启 / 保留原样 / ×
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样'];
    const closed = [];
    for (let k = 0; k < 8; k += 1) {
      let hit = false;
      for (const d of window.__gy.qa('[role=dialog]')) {
        const bs = [...d.querySelectorAll('button')];
        const b = bs.find((x) => labels.some((L) => window.__gy.name(x).includes(L)))
          ?? bs.find((x) => window.__gy.name(x).includes('关闭') || window.__gy.name(x) === '×');
        if (b !== undefined) { b.click(); closed.push((d.getAttribute('aria-label') ?? '').slice(0, 18)); hit = true; await window.__gy.wait(220); }
      }
      if (!hit) break;
    }
    return closed;
  },
  pathBox: () => {
    const d = window.__gy.q('[role=dialog]');
    if (d == null) return null;
    const cand = [...d.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true], [role=textbox]')];
    return cand.find((n) => !n.disabled && n.offsetParent !== null) ?? null;
  },
  readBox: (n) => n == null ? null : (n.value ?? n.textContent ?? ''),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__gy.wait(120); } return false; },
};
`;

// CDP 真事件输入：先 evaluate 聚焦，再 Input.insertText / dispatchKeyEvent。
// 为什么不能用页内合成事件：路径框与 composer 都是受控组件，`setNative` + dispatch 的
// `input` 事件不带 isTrusted，React/Lexical 不认（实测 typed:false、draft 永远是 0）。
const keyInfoFor = (ch) => {
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { key: ch, code: 'Key' + upper, vk: 65 + upper.charCodeAt(0) - 65 };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: 48 + Number(ch) };
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32 };
  return { key: ch, code: 'Unidentified', vk: 0 };
};

const cdpType = async (page, focusExpr, text, enter = false, readExpr = undefined) => {
  const ok = await page.evaluate(`(() => { const n = (${focusExpr})(); if (n == null) return false; n.focus(); return true; })()`);
  if (!ok) return false;
  await sleep(120);
  if (text !== '') {
    await page.send('Input.insertText', { text });
    await sleep(150);
    if (readExpr !== undefined && (await page.evaluate(readExpr)) === 0) {
      for (const ch of text) {
        const ki = keyInfoFor(ch);
        const base = { key: ki.key, code: ki.code, windowsVirtualKeyCode: ki.vk, nativeVirtualKeyCode: ki.vk };
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
        await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      }
    }
    await sleep(200);
  }

  if (enter) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  return true;
};

// ── 起会话：选工作区 + 发一条消息（真回合）⇒ 得到「有 completed 回合」的会话 ────
// 打开页面并注入页内工具（`--rounds-only` 也必须走这一步，否则 window.__gy 是 undefined）
const openPage = async (page) => {
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: ctx.url });
  // ⚠️ **先导航、后注入**：helpers 是挂在 window 上的，导航会把旧 document 的世界换掉
  //（第一版就栽在注入早于导航 ⇒ 下一次 evaluate 里 window.__gy 是 undefined）。
  await page.evaluate(`(async () => {
    const t0 = Date.now();
    while (document.readyState !== 'complete' && Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    return document.readyState;
  })()`);
  await page.evaluate(`(async () => { ${PAGE_HELPERS} return true; })()`);
  await page.evaluate(`(async () => { await window.__gy.dismiss(); return true; })()`);
};

const bootSessions = async (page) => {
  await openPage(page);
  const ok = await page.evaluate(`(async () => {
    const seen = await window.__gy.until(() => window.__gy.byText('选择工作区') != null
      || window.__gy.composer() != null, 25000);
    // 首屏有 onboarding 模态（「试试更轻巧的侧栏」「额度横条」…），它们**盖住**工作区选择
    // ⇒ 不先关掉后面每一步都空转（本轮就是这么红的）。
    const dismissed = await window.__gy.dismiss();
    const c0 = window.__gy.composer();
    return {
      ready: seen, dismissed,
      composer: c0 === null ? null : { tag: c0.tagName, role: c0.getAttribute('role'),
        ce: c0.getAttribute('contenteditable'), ds: Object.keys(c0.dataset).join(',') },
      dialogs: window.__gy.qa('[role=dialog]').map((d) => (d.getAttribute('aria-label') ?? '').slice(0, 24)),
      treeitems: window.__gy.qa('[role=treeitem]').length,
      dialogButtons: window.__gy.qa('[role=dialog]').map((d) => ({
        label: (d.getAttribute('aria-label') ?? '').slice(0, 20),
        buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 14)),
      })),
      composers: window.__gy.composers(),
      composerHTML: (window.__gy.q('[data-composer-input]')?.outerHTML ?? '').replace(/\s+/g, ' ').slice(0, 260),
    };
  })()`);
  if (flag('probe')) {
    say('· 首屏 DOM 盘点：');
    say('   dialogs   = ' + JSON.stringify(ok.dialogButtons));
    say('   composer 们 = ' + JSON.stringify(ok.composers));
    say('   composer  = ' + JSON.stringify({ html: ok.composerHTML }));
  }

  // 选工作区（若还没选）
  // 选工作区（没选过才需要）。页内合成事件对受控组件无效 ⇒ 输入走 CDP Input 域。
  {
    const opened = await page.evaluate(`(async () => {
      await window.__gy.dismiss();
      const btn = window.__gy.byText('选择工作区');
      if (btn == null) return { skipped: true, composers: window.__gy.composers() };
      btn.click();
      const hasBox = await window.__gy.until(() => window.__gy.btnIn('[role=dialog]', '编辑路径') != null
        || window.__gy.pathBox() != null, 9000);
      if (!hasBox) return { step: 'picker 没开', composers: window.__gy.composers() };
      const edit = window.__gy.btnIn('[role=dialog]', '编辑路径');
      if (edit != null) { edit.click(); await window.__gy.wait(400); }
      return { readyToType: window.__gy.pathBox() != null,
        box: window.__gy.pathBox() == null ? null : window.__gy.pathBox().tagName + '/' + (window.__gy.pathBox().getAttribute('type') ?? '') + '/' + (window.__gy.pathBox().getAttribute('aria-label') ?? '') };
    })()`);
    // 首选**直接点目录行**：picker 打开时就在主目录，工作区目录名就在列表里 ⇒ 完全不碰
    // 路径框（路径框那两条路本轮死了五次：fill/insertText/逐字符 key 都进不了 React state，
    // 「打开」一直 disabled）。点行之后「打开」才是可点的。
    const rowClicked = await page.evaluate(`(async () => {
      const name = ${JSON.stringify(WS.split('/').pop())};
      const d = window.__gy.q('[role=dialog]');
      if (d == null) return { step: 'dialog 不在' };
      const row = [...d.querySelectorAll('button, [role=button], [role=treeitem], li *')]
        .find((n) => window.__gy.name(n) === name);
      if (row == null) return { step: '列表里没有那一行', sample: [...d.querySelectorAll('button')].slice(0, 8).map((b) => window.__gy.name(b).slice(0, 16)) };
      row.click();
      await window.__gy.wait(500);
      const open = [...d.querySelectorAll('button')].filter((b) => window.__gy.name(b).includes('打开')).find((b) => !b.disabled) ?? null;
      if (open === null) return { step: '点行之后 打开 仍不可用' };
      open.click();
      const ready = await window.__gy.until(() => (window.__gy.composer()?.dataset.phase ?? 'inert') !== 'inert', 9000);
      return { viaRow: true, ready, phaseAfter: window.__gy.composer()?.dataset.phase ?? '', composers: window.__gy.composers() };
    })()`);
    if (rowClicked?.viaRow === true) {
      say('· 工作区（点行法）：' + JSON.stringify(rowClicked).slice(0, 260));
    } else if (opened?.readyToType === true) {
      await cdpType(page, `() => window.__gy.pathBox()`, WS, true);
      await sleep(600);
      const echoed = await page.evaluate(`(() => {
        const n = window.__gy.pathBox();
        return { box: n == null ? null : window.__gy.readBox(n).slice(-24), openDisabled: window.__gy.byText('打开')?.disabled ?? null };
      })()`);
      say('· 路径框回读：' + JSON.stringify(echoed));
      const picked = await page.evaluate(`(async () => {
        // 同名按钮可能有两个（列表行里的「打开」是 disabled 的那个）⇒ 取**可用**的那个
        const cands = [...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=button]')]
          .filter((b) => window.__gy.name(b).includes('打开'));
        const open = cands.find((b) => !b.disabled) ?? cands[0] ?? null;
        if (open == null) return { step: 'dialog 里没有 打开 按钮' };
        if (open.disabled) return { step: '只有 disabled 的打开', names: cands.map((b) => window.__gy.name(b) + '/' + (b.disabled ? 'disabled' : 'ok')) };
        open.click();
        const ready = await window.__gy.until(
          () => (window.__gy.composer()?.dataset.phase ?? 'inert') !== 'inert', 8000);
        if (!ready) {
          const n = window.__gy.byText('新会话') ?? window.__gy.byText('新建会话');
          if (n != null) { n.click(); await window.__gy.wait(1500); }
        }
        return {
          clicked: true,
          phaseAfter: window.__gy.composer()?.dataset.phase ?? '',
          composers: window.__gy.composers(),
          stillOpen: window.__gy.qa('[role=dialog]').map((d) => (d.getAttribute('aria-label') ?? '').slice(0, 20)),
          textboxes: window.__gy.qa('[role=textbox]').map((n) => (n.getAttribute('aria-label') ?? '').slice(0, 22) + '/' + (n.dataset.phase ?? '')),
          treeitems: window.__gy.qa('[role=treeitem]').map((n) => window.__gy.name(n).slice(0, 18)),
        };
      })()`);
      say(`· 打开工作区后：${JSON.stringify(picked).slice(0, 300)}`);
    } else {
      say(`· 工作区这步停在：${JSON.stringify({ opened, rowClicked }).slice(0, 320)}`);
    }
  }


  const logPath = join(SANDBOX, 'logs', 'sbx.log');
  const countIn = (needle) => {
    try { return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes(needle)).length; } catch { return 0; }
  };
  const waitTurns = async (want) => {
    for (let k = 0; k < 160; k += 1) {
      if (countIn('suggestion generated') >= want) return true;
      await sleep(1000);
    }
    return false;
  };

  say('· 会话 1：发第一条消息');
  say(`  ${JSON.stringify(await composerSend(page, '只回答一个字：好'))}`);
  await waitTurns(1);
  say('· 会话 2：点「新会话」再发一条（切会话才有 pull 可编排）');
  await page.evaluate(`(async () => {
    const n = window.__gy.byText('新会话') ?? window.__gy.byText('新建会话');
    window.__gy.click(n);
    await window.__gy.wait(900);
  })()`);
  say(`  ${JSON.stringify(await composerSend(page, '只回答一个字：行'))}`);
  const got = await waitTurns(2);
  say(`· 两个会话各有 completed 回合：${got ? '是' : '否（后续编排可能不成立）'}`);
  return { countIn };
};

// ── 一轮编排：pull(arm 窗口) → 改热表(造脏) → 1s 内打字停顿(complete) ─────────
const oneRound = async (page, index) => {
  // 三步压在同一个 1000ms 窗口里：①② 在页内连做（同一拍），③ 由宿主发真 key 事件。
  const first = await page.evaluate(`(async () => {
    const G = window.__gy;
    const t0 = performance.now();
    const items = G.qa('[role=treeitem]');
    if (items.length < 2) return { fail: '会话不足两个', n: items.length };
    const idx = ${index} % items.length;
    items[idx].click();                                   // ① pull ⇒ 宿主写热度 ⇒ 窗口开
    await G.wait(280);
    items[(idx + 1) % items.length].click();              // ② 再切一次 ⇒ historySessionId 变 ⇒ 热度格脏
    await G.wait(120);
    return { switched: true, ms: Math.round(performance.now() - t0), n: items.length };
  })()`);
  if (first?.fail !== undefined) return first;
  // ③ 首字符：打 ≥inlineMinChars 个字符后停顿 ⇒ 客户端发 complete
  const typed = await cdpType(page, `() => window.__gy.composer()`, 'ababab', false,
    `(() => (window.__gy.composer()?.textContent ?? '').length)`);
  const draftLen = await page.evaluate(`(() => (window.__gy.composer()?.textContent ?? '').length)`);
  return { ...first, typed, draftLen };
};

const composerSend = async (page, text) => {
  const before = await page.evaluate(`(() => {
    const c = window.__gy.composer();
    return c == null ? null : { phase: c.dataset.phase ?? '', len: (c.textContent ?? '').length };
  })()`);
  if (before === null) return { step: 'no composer' };
  const ok = await cdpType(page, `() => window.__gy.composer()`, text, false,
    `(() => (window.__gy.composer()?.textContent ?? '').length)`);
  const draftLen = await page.evaluate(`(() => (window.__gy.composer()?.textContent ?? '').length)`);
  if (draftLen === 0) return { step: '打字没进草稿', ok };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(120);
  const after = await page.evaluate(`(() => {
    const c = window.__gy.composer();
    return c == null ? null : { phase: c.dataset.phase ?? '', len: (c.textContent ?? '').length };
  })()`);
  return { ok, before, after };
};

// 读盘上 `_hot`（**只取条数/总数/末条的长度与计数，绝不取正文**）：
// 让路那次写出去的内容是不是「当前热表」，就看这份刚落地的小格子有没有把本轮新提交的那条带上。
const hotSnapshot = () => {
  try {
    const t = readFileSync(join(SANDBOX, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    const m = t.match(/^    _hot: '([\s\S]*?)'\n(?=    [a-z_-]+:|- id:|  config:)/m);
    if (m === null) return null;
    const j = JSON.parse(m[1].replace(/\n\s+/g, ' '));
    const list = Array.isArray(j.hot) ? j.hot : [];
    const last = list.length > 0 ? list[list.length - 1] : null;
    return { entries: list.length, total: j.total ?? null,
      lastLen: last === null ? null : (last.text ?? '').length, lastCount: last === null ? null : last.count };
  } catch { return null; }
};

// ── 连发模式（#63 让路的第一次现场执行）────────────────────────────────────
//
// 触发条件读码更正（重要）：让路**不要求**先有「被窗口推迟的 pending 快照」，
// 它要求的是 `windowWasOpen`（窗口开着、且这一拍本可推迟）**且这次 flush 真的带走热度格**
// （即此刻热表相对上次写是脏的）。⇒ 单轮形状：
//   改热表(卡片 add，走 _ops，宿主 applyOps 之后不 push) → 打字+停顿(complete #1：写热度、开窗口)
//   → 再改热表 → 打字+停顿(complete #2：窗口开着 + 脏 ⇒ 让路)
// 全程 ~600ms，且**不花 agent 回合**（只花两次便宜的续写调用）。
const HOT_INPUT = '手工新增一条候选短语';

const openCard = async (page) => {
  const step = await page.evaluate(`(async () => {
    const G = window.__gy;
    const found = () => [...document.querySelectorAll('input')].find((i) =>
      ((i.getAttribute('aria-label') ?? '') + (i.placeholder ?? '')).includes(${JSON.stringify(HOT_INPUT)})) ?? null;
    if (found() !== null) return { open: true, direct: true, composer: G.composer() !== null };
    // 卡片在插件详情页：先点侧栏「插件」，再点本插件那一行
    const nav = G.byText('插件');
    if (nav === null) return { open: false, step: 'no 插件 nav' };
    nav.click();
    await G.wait(700);
    const row = G.byText('ghost') ?? G.byText('Suggest') ?? G.byText('建议');
    if (row !== null) { row.click(); await G.wait(900); }
    return {
      open: found() !== null, clickedRow: row !== null, composer: G.composer() !== null,
      inputs: [...document.querySelectorAll('input')].map((i) => ((i.getAttribute('aria-label') ?? i.placeholder ?? i.type) || '').slice(0, 22)).slice(0, 14),
      buttons: [...document.querySelectorAll('button')].map((b) => G.name(b).slice(0, 14)).filter(Boolean).slice(0, 24),
    };
  })()`);
  return step;
};

const hotAdd = (page, text) => page.evaluate(`(async () => {
  const G = window.__gy;
  const input = [...document.querySelectorAll('input')].find((i) =>
    ((i.getAttribute('aria-label') ?? '') + (i.placeholder ?? '')).includes(${JSON.stringify(HOT_INPUT)})) ?? null;
  if (input === null) return { ok: false, step: '热表输入框不在' };
  input.focus();
  return { ok: true, focused: document.activeElement === input };
})()`).then(async (r) => {
  if (!r.ok) return r;
  await cdpType(page, `() => [...document.querySelectorAll('input')].find((i) => ((i.getAttribute('aria-label') ?? '') + (i.placeholder ?? '')).includes(${JSON.stringify(HOT_INPUT)}))`, text, false,
    `(() => { const i = [...document.querySelectorAll('input')].find((x) => ((x.getAttribute('aria-label') ?? '') + (x.placeholder ?? '')).includes(${JSON.stringify(HOT_INPUT)})); return (i?.value ?? '').length; })()`);
  const clicked = await page.evaluate(`(() => {
    const G = window.__gy;
    const b = G.btnIn(null, '新增') ?? G.btnIn(null, '添加') ?? G.btnIn(null, 'Add');
    if (b === null) return { ok: false, buttons: [...document.querySelectorAll('button')].map((x) => G.name(x).slice(0, 12)).filter(Boolean).slice(0, 20) };
    b.click(); return { ok: true };
  })()`);
  return { ...r, ...clicked };
});

const burstRound = async (page, index, tally) => {
  const before = tally();
  const t0 = Date.now();
  await hotAdd(page, `burst${index}ab`);
  await cdpType(page, `() => window.__gy.composer()`, 'abab', false,
    `(() => (window.__gy.composer()?.textContent ?? '').length)`);
  await sleep(260);
  await hotAdd(page, `burst${index}cd`);
  await cdpType(page, `() => window.__gy.composer()`, 'cd', false,
    `(() => (window.__gy.composer()?.textContent ?? '').length)`);
  await sleep(1400);
  const after = tally();
  return {
    ms: Date.now() - t0,
    complete: after.complete - before.complete,
    yielded: after.yielded - before.yielded,
    coalesced: after.coalesced - before.coalesced,
    hotWrites: after.hot - before.hot,
  };
};

// ── 主流程 ─────────────────────────────────────────────────────────────────
const ctx = {};
let page = null;
let cleanupDone = false;
const cleanup = async () => {
  if (cleanupDone) return;
  cleanupDone = true;
  if (page !== null) { try { page.close(); } catch { /* noop */ } }
  if (ctx.pids !== undefined) {
    for (const pid of ctx.pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* noop */ } }
    await sleep(2500);
    for (const pid of ctx.pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* noop */ } }
  }
  if (!flag('keep')) {
    rmSync(SANDBOX, { recursive: true, force: true });
    rmSync(WS, { recursive: true, force: true });
    say(`· 已删沙箱与工作区：${SANDBOX} / ${WS}`);
  } else {
    say('· --keep：沙箱目录**留着**（里面有凭据副本，别忘了手动清）');
  }
  say(`· 输出里命中并掩码过的敏感串次数 = ${leaked}；token 明文进 stdout 的次数 = 0（所有输出都过 redact）`);
};

try {
  const host = await ensureSandbox();
  ctx.url = host.url;
  ctx.pids = host.pids;
  page = await cdpSession();
  let counts = null;
  if (flag('rounds-only')) {
    await openPage(page);
    const probe = await page.evaluate(`(async () => ({ composers: window.__gy.composers(), treeitems: window.__gy.qa('[role=treeitem]').length }))()`);
    say('· rounds-only 现场：' + JSON.stringify(probe).slice(0, 200));
  } else {
    counts = await bootSessions(page);
  }
  if (flag('rounds-only')) say('· --rounds-only：跳过建会话（复用沙箱里已有的会话）');

  const logPath = join(SANDBOX, 'logs', 'sbx.log');
  const read = () => readFileSync(logPath, 'utf8').split('\n');
  const countWhere = (pred) => read().filter(pred).length;

  const tally = () => {
    const lines = read();
    return {
      complete: lines.filter((l) => l.includes('ops consumed: complete')).length,
      yielded: lines.filter((l) => l.includes('hot push yielded on input')).length,
      coalesced: lines.filter((l) => l.includes('hot push coalesced')).length,
      hot: lines.filter((l) => /ops-trace\] (hot push landed|push landed)/.test(l)).length,
      pull: lines.filter((l) => l.includes('ops consumed: pull')).length,
    };
  };
  if (flag('burst')) {
    // ⚠️ 上一轮两次 60s 超时的真因：页面被留在**插件详情页**，那里 composer 元素虽然还在
    // （phase=plain）但**没有被 attach** ⇒ 打字与回车根本进不了宿主。先把主视图拉回来，
    // 再用「提交冒烟」确认这条通道真的通，别拿超时当数据。
    const view = await page.evaluate(`(async () => {
      const G = window.__gy;
      const b = G.byText('新会话') ?? G.byText('新建会话');
      if (b != null) { b.click(); await G.wait(1300); }
      const c = G.composer();
      return { clicked: b != null, composer: c === null ? null : (c.getAttribute('aria-label') ?? '').slice(0, 18), phase: c?.dataset.phase ?? '' };
    })()`);
    say('· 主视图：' + JSON.stringify(view));
    const pullBase = tally().pull;
    const smoke = await composerSend(page, '答一个字：冒');
    let arrived = false; const t9 = Date.now();
    while (Date.now() - t9 < 25000) {
      if (tally().pull > pullBase || tally().hot > tally().hot) { arrived = true; break; }
      await sleep(200);
    }
    say(`· 提交冒烟：${arrived ? '到达宿主 ✓' : '**没到达**（这条编排在此环境下不成立，如实报）'}，结果=${JSON.stringify(smoke)}`);
    if (!arrived) { await cleanup(); process.exit(1); }
    const tallyNow = tally;
    const base = tallyNow();
    say('· 起点计数：' + JSON.stringify(base));
    const rows = [];
    for (let k = 1; k <= ROUNDS; k += 1) {
      const before = tallyNow();
      // ① 第一次提交：它的 turn/end 会把热度写出去 ⇒ 那一刻窗口被打开
      const token = `甲${k}${Date.now().toString(36).slice(-6)}`;
      await composerSend(page, `答 ${token}`);
      // 轮询等「热度写落地」这一拍，拿到它的时刻 ⇒ 后续动作全部以它为原点压进 1000ms
      let armed = false; let waitMs = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        if (tallyNow().hot > before.hot) { armed = true; break; }
        await sleep(80); waitMs = Date.now() - t0;
      }
      if (!armed) { rows.push({ round: k, fail: `等热度写超时 ${waitMs}ms` }); say(`轮 ${k}：${rows.at(-1).fail}`); continue; }
      const armAt = Date.now();
      // ② 立刻第二次提交：热表在**提交那一刻**变脏，宿主不推 ⇒ 这就是「有对象可带」
      const token2 = `乙${k}${Date.now().toString(36).slice(-6)}`;
      await composerSend(page, `答 ${token2}`);
      const commitGap = Date.now() - armAt;
      // ③ 立刻打字 + 停顿 ⇒ 客户端发 complete
      await cdpType(page, `() => window.__gy.composer()`, 'ababab', false,
        `(() => (window.__gy.composer()?.textContent ?? '').length)`);
      const typeGap = Date.now() - armAt;
      // 归因有效性：complete 必须落在 armAt 之后 1000ms 内，否则这轮的让路不能算作本编排造成的
      //（上一批 4 轮的 typeGap 全是 ~1400ms ⇒ 超窗 ⇒ 那几次 yielded 的**来源不可归因**，已如实记）
      if (typeGap > 1000) say(`   ⚠️ 本轮 complete 落在 ${typeGap}ms > 窗口 1000ms ⇒ 不可归因于本编排`);
      const hotBefore = hotSnapshot();
      await sleep(1600);
      const hotAfter = hotSnapshot();
      const after = tallyNow();
      // 「放出去的是不是当前热表」= 让路那次写的 `_hot` 里，**有没有本轮那两个独有 token**
      const cellsContainTokens = () => {
        try {
          const t = readFileSync(join(SANDBOX, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
          const m = t.match(/^    _hot: '([\s\S]*?)'\n(?=    [a-z_-]+:|- id:|  config:)/m);
          if (m === null) return { inHot: false, present: false };
          const has = (tok) => m[1].includes(tok);
          return { inHot: has(token), present: has(token2) };
        } catch { return { inHot: false, present: false }; }
      };
      const tok = cellsContainTokens();
      const landedCurrent = tok.inHot || tok.present;
      const row = {
        round: k, commitGap, typeGap, landedCurrent, hotBefore, hotAfter,
        complete: after.complete - before.complete,
        yielded: after.yielded - before.yielded,
        coalesced: after.coalesced - before.coalesced,
        hotWrites: after.hot - before.hot,
      };
      rows.push(row);
      say(`轮 ${String(k).padStart(2)}：二提交@${commitGap}ms 打字@${typeGap}ms `
        + `complete+${row.complete} 让路+${row.yielded} coalesce+${row.coalesced} 热度写+${row.hotWrites} `
        + `落地=当前热表 ${row.landedCurrent === true ? '✓' : '✗ ' + JSON.stringify({ b: row.hotBefore, a: row.hotAfter, expectedLen })}`);
      if (row.yielded > 0 && flag('firstdump')) {
        const hot = await page.evaluate(`(() => 'noop')()`); void hot;
        say('   ↑ 第一次真实触发 ⇒ 落地内容核对见汇总后的 _hot 读回');
      }
    }
    const now = tallyNow();
    const eligible = rows.filter((r) => !r.fail && r.complete > 0).length;
    const yields = rows.reduce((a, r) => a + (r.yielded ?? 0), 0);
    say('\n=== 连发汇总 ===');
    say(`轮数 N = ${rows.length}；失败/超时轮 = ${rows.filter((r) => r.fail).length}；`
      + `其中 complete 落在窗口内（可归因）的轮 = ${attributable}`);
    say(`分母 = 整段连发期间到达宿主的 complete op 总数 = ${eligible}`);
    say(`分子 = 同一期间真的打出让路（hot push yielded on input）的次数 = ${yields}`);
    say(`（每轮 complete 增量 = ${JSON.stringify(rows.map((r) => r.complete ?? '超时'))}；`
      + `每轮让路增量 = ${JSON.stringify(rows.map((r) => r.yielded ?? '超时'))}）`);
    say(`比例 = ${eligible === 0 ? 'n/a（分母 0）' : `${yields}/${eligible} = ${(yields / eligible).toFixed(2)}`}`
      + `；coalesce 增量 = ${tallyNow().coalesced - base.coalesced}`);
    say(`落地=当前热表（本轮独有 token 出现在 _hot 里）的轮数 = `
      + `${rows.filter((r) => r.landedCurrent === true).length}/${rows.filter((r) => !r.fail).length}`);
    say(`全量计数：${JSON.stringify(now)}`);
    say('性质核对（让路写次数 ≤ 待写变化数）：让路 = ' + `${yields}，热度写增量 = ${now.hot - base.hot}`
      + ` ⇒ ${yields <= now.hot - base.hot ? '成立' : '不成立（要报）'}`);
    const diskHot = (() => {
      try {
        const t = readFileSync(join(SANDBOX, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
        const m = t.match(/^    _hot: '([\s\S]*?)'\n(?=    [a-z_-]+:|- id:|  config:)/m);
        if (m === null) return null;
        const j = JSON.parse(m[1].replace(/\n\s+/g, ' '));
        return { entries: (j.hot ?? []).length, total: j.total, sample: (j.hot ?? []).slice(0, 3).map((e) => e.text.length) };
      } catch (e) { return { error: String(e).slice(0, 60) }; }
    })();
    say('落地内容核对（盘上 `_hot` 的 entries/total，长度不打印正文）：' + JSON.stringify(diskHot));
    await cleanup();
    process.exit(0);
  }

  say(`\n=== 开始编排：${ROUNDS} 轮 ===`);
  const rounds = [];
  for (let k = 1; k <= ROUNDS; k += 1) {
    const beforeYield = countWhere((l) => l.includes('hot push yielded on input'));
    const beforeComplete = countWhere((l) => l.includes('ops consumed: complete'));
    const beforeHot = countWhere((l) => /ops-trace\] (hot push landed|push landed)/.test(l));
    const r = await oneRound(page, k);
    await sleep(1200);
    const afterYield = countWhere((l) => l.includes('hot push yielded on input'));
    const afterComplete = countWhere((l) => l.includes('ops consumed: complete'));
    const afterHot = countWhere((l) => /ops-trace\] (hot push landed|push landed)/.test(l));
    const row = {
      round: k,
      failed: r.fail ?? null,
      completed: afterComplete > beforeComplete ? 1 : 0,
      yields: afterYield > beforeYield ? 1 : 0,
      hotWrites: afterHot - beforeHot,
      totalMs: r.marks?.totalMs ?? null,
    };
    rounds.push(row);
    say(`轮 ${String(k).padStart(2)}：complete=${row.completed} 让路=${row.yields} 热度写=${row.hotWrites} 页内耗时=${row.totalMs ?? '-'}ms${row.failed ? ' 失败点=' + row.failed : ''}`);
    if (row.completed === 0 && k === 1) {
      say('  （第一轮就没打出 complete ⇒ 触发面不成立，先把通路验明白再刷轮数）');
    }
  }

  const sum = (f) => rounds.reduce((a, r) => a + f(r), 0);
  const attempted = rounds.length;
  const withComplete = sum((r) => r.completed);
  const withYield = sum((r) => r.yields);
  say('\n=== 汇总 ===');
  say(`尝试轮数 N = ${attempted}`);
  say(`其中真的打出 complete 的轮数 A = ${withComplete}`);
  say(`其中触发让路的轮数 Y = ${withYield}`);
  say(`比例 Y/A = ${withComplete === 0 ? 'n/a（分母为 0：complete 一次没来，属通路问题而非「不触发」）' : (withYield / withComplete).toFixed(2)}`);
  say(`比例 Y/N = ${(withYield / attempted).toFixed(2)}`);
  say(`全程留痕累计：yielded=${countWhere((l) => l.includes('hot push yielded on input'))} `
    + `complete=${countWhere((l) => l.includes('ops consumed: complete'))} `
    + `pull=${countWhere((l) => l.includes('ops consumed: pull'))} `
    + `coalesced=${countWhere((l) => l.includes('hot push coalesced'))}`);
  say('交叉核对性质（让路写次数 ≤ 待写变化数）：真实宿主里 yielded 行数 = '
    + `${countWhere((l) => l.includes('hot push yielded on input'))}，`
    + '行内 yields= 计数是宿主自己维护的同一口径，见日志原文（本脚本不打印正文）。');
} catch (e) {
  say('!! 失败：' + redact(String((e && e.message) ?? e).slice(0, 500)));
  process.exitCode = 1;
} finally {
  await cleanup();
}
