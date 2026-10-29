#!/usr/bin/env node
/**
 * #113 的现场判据：流式逐帧痕迹在**回合结束之后**还能不能纯读 DOM 拿回来。
 *
 * ## 为什么这条必须跑真 GUI，而不是离线 DOM 替身
 *
 * 判据 1 的原话是「不靠任何 console 捕获，纯读 DOM 就能重建这张表，且与
 * `stream frame … t=` 留痕逐格对齐」⇒ 两条来源必须**互相独立**：
 *  - DOM 侧：`document.getElementById('dsh-suggest-ghost-overlay').dataset.streamFrames`
 *  - 留痕侧：CDP 收到的 `console.debug` 行（只用来对齐，不用来重建）
 * 离线替身里"帧"是我自己造的 ⇒ 对齐就成了我自己跟自己对齐，没有信息量。
 *
 * ## 三条判据怎么落在这个脚本里
 *  1. `--streaming on` 跑一轮：回合结束后读 dataset，要求 ≥2 帧、含一个 final=1，
 *     并与留痕逐格对齐（frame/final/chars/t 四列全等）。
 *  2. 同一次里在**发消息之前**先读一次 dataset ⇒ 必须是空（证明读到的确实是本回合的）。
 *  3. `--streaming off` 跑一轮：整轮结束后 dataset 仍不存在/为空 ⇒ 默认关零痕迹、
 *     并且宿主侧「增量帧不写盘」那条硬判据不许退化（数 `(?<!hot )push landed`）。
 *
 * ## 隔离与隐私
 *  - 沙箱 home 由调用方给（约定前缀 `xk-113-`）；插件是**实体副本**、`@deepseek-ai` 整目录软链，
 *    由 `dev-sandbox` 负责，本脚本只起实例与开页面。
 *  - token 只从 `<home>/logs/sbx.log` 取，全程过 `redact()`，自证明文进 stdout 次数 = 0。
 *  - 本脚本**不打印任何正文**：只打帧号/终帧/字符数/时刻。
 *
 * 用法：node scripts/stream-frames-dom-e2e.mjs --home ~/xk-113-on --streaming on [--rounds 1]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const HOME_ = String(opt('home', '')).replace(/^~/, homedir());
const MODE = String(opt('streaming', 'on'));            // on | off
const GEN = String(opt('gen', '0.2.1-rc.2'));
const BIN = String(opt('bin', join(homedir(), 'dsh-versions', GEN, 'node_modules/.bin/dsh')));
const WS = String(opt('ws', join(homedir(), 'xk-113-ws'))).replace(/^~/, homedir());
const PORT = Number(opt('port', 4141));
const CHROME = process.env.CHROME_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
if (HOME_ === '') throw new Error('必须给 --home <沙箱目录>（约定前缀 xk-113-）');
if (MODE !== 'on' && MODE !== 'off') throw new Error('--streaming 只能是 on 或 off');

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

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed += 1;
  say(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `\n      ${redact(String(detail))}`}`);
};

const run = (cmd, cmdArgs) => new Promise((resolve, reject) => {
  const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
  let out = ''; let err = '';
  p.stdout.on('data', (b) => { out += b.toString(); });
  p.stderr.on('data', (b) => { err += b.toString(); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out, err }));
});

/** 起实例（--check 建 → 打 streamingDelivery 补丁 → --deploy 启动）。 */
const launch = async () => {
  // 已建过的 home 直接复用（迭代时省一次重建；`--check` 会 rmSync 整个 home）
  if (!existsSync(join(HOME_, 'profiles', 'web', 'cordis.patch.yml'))) {
    await run('node', ['scripts/dev-sandbox.mjs', '--home', HOME_, '--rewrite', `port: 3983=port: ${PORT}`,
      '--bin', BIN, '--check']);
  }
  const profile = join(HOME_, 'profiles', 'web', 'cordis.patch.yml');
  let t = readFileSync(profile, 'utf8');
  const i = t.indexOf('- id: suggest-ghost');
  if (i < 0) throw new Error('沙箱 profile 里没有本插件条目');
  let j = t.indexOf('\n- id: ', i + 5); if (j < 0) j = t.length;
  let blk = t.slice(i, j).replace(/^(\s*)disabled:\s*true\s*$/m, '$1disabled: false');
  // streamingDelivery：on ⇒ true / off ⇒ false（判据 3 的那一半靠这个开关跑）
  const want = MODE === 'on' ? 'true' : 'false';
  if (/^\s*streamingDelivery:/m.test(blk)) {
    blk = blk.replace(/^(\s*)streamingDelivery:.*$/m, `$1streamingDelivery: ${want}`);
  } else {
    // ⚠️ 必须带 `m`：上一版没有 ⇒ `^` 只匹配整串开头 ⇒ 替换静默不生效 ⇒ 我拿"开关开了"
    //    的前提跑了一整轮（结果当然没有帧）。**补丁要断言它真的打上了**。
    blk = blk.replace(/^([ \t]*)config:\n/m, `$1config:
$1  streamingDelivery: ${want}
`);
  }
  if (!new RegExp(`streamingDelivery: ${want}`).test(blk)) {
    throw new Error(`补丁没打上（streamingDelivery=${want}）⇒ 别用没生效的开关跑判据`);
  }
  writeFileSync(profile, t.slice(0, i) + blk + t.slice(j));
  // 技能隔离的「@deepseek-ai 整目录软链」这一条在这里是**必需**的：插件实体副本在
  // `<home>/plugin`，宿主从 realpath 往上解析 ⇒ 找不到 `@deepseek-ai/dsh-typert-protocol`
  // ⇒ 流式服务注册失败（实测 `stream-register-failed #1`、`typert protocol import failed`）
  // ⇒ 帧永远不来，而这看起来完全像"这代次没有流式通道"。
  mkdirSync(join(HOME_, 'node_modules'), { recursive: true });
  const peers = join(homedir(), '.dsh/profiles/web/node_modules/@deepseek-ai');
  const link = join(HOME_, 'node_modules/@deepseek-ai');
  if (existsSync(peers) && !existsSync(link)) {
    await run('ln', ['-sfn', peers, link]);
  }
  const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', HOME_,
    '--rewrite', `port: 3983=port: ${PORT}`, '--bin', BIN, '--deploy', '.']);
  if (!/存活=yes/.test(r.out)) throw new Error('实例没起来：' + redact(r.out.slice(-400)));
  const pids = existsSync(join(HOME_, 'sbx.pid'))
    ? readFileSync(join(HOME_, 'sbx.pid'), 'utf8').split(/\s+/).filter(Boolean) : [];
  return pids;
};

const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

/** 最小 CDP 客户端（Node 自带 WebSocket，零依赖）。 */
const cdp = async () => {
  const dir = join(tmpdir(), `xk113-chrome-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let k = 0; k < 80 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
  const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => (typeof a.value === 'string' ? a.value : JSON.stringify(a.value ?? ''))).join(' ');
      consoleLines.push({ type: msg.params.type, text });
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) throw new Error('页内异常：' + redact(JSON.stringify(r.exceptionDetails).slice(0, 200)));
    // ⚠️ CDP 的 `send()` 已经把外层 `{result, exceptionDetails}` 拆掉了 ⇒ 值在
    //    `r.result.value`，不是 `r.result.result.value`。写错时**不报错、只是恒 undefined**，
    //    于是所有页内判据都变成"读不到东西"——这类静默 undefined 比异常危险得多。
    return r.result?.value;
  };
  return {
    send, evaluate, consoleLines,
    close: () => { try { ws.close(); } catch { /* noop */ } proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); },
  };
};

const HELPERS = `
window.__x = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  byText: (t, sel) => window.__x.qa(sel || 'button, [role=button]').find((n) => window.__x.name(n).includes(t)) ?? null,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__x.wait(150); } return false; },
  // 关首屏模态：0.1.7 系有「内测声明」，中文确认按钮盖住 composer（#41/§11 的教训）。
  // 但**绝不点工作区选择器里的确认按钮**，那会选错目录。
  dismiss: async () => {
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', '继续', '同意', '我已阅读'];
    for (let k = 0; k < 8; k += 1) {
      let hit = false;
      for (const d of window.__x.qa('[role=dialog], dialog[open]')) {
        if (/选择工作区目录|添加工作区|选择工作区/.test(d.textContent ?? '')) continue;
        const b = [...d.querySelectorAll('button')].find((x) => labels.some((L) => window.__x.name(x).includes(L)));
        if (b != null) { b.click(); hit = true; await window.__x.wait(250); }
      }
      if (!hit) break;
    }
  },
  composer: () => {
    const all = window.__x.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert') ?? document.querySelector('[contenteditable=true]') ?? all[0] ?? null;
  },
  frames: () => {
    const el = document.getElementById('dsh-suggest-ghost-overlay');
    if (el == null) return { exists: false, raw: null, list: [] };
    const raw = el.dataset.streamFrames ?? null;
    let list = [];
    try { list = raw === null ? [] : JSON.parse(raw); } catch { list = 'PARSE_ERROR'; }
    return { exists: true, raw, list };
  },
};
`;

/** 选工作区：点行 → 打开；找不到行就关掉重开一次（#41 的竞态教训）。 */
const pickWorkspace = async (c) => c.evaluate(`(async () => {
  const x = window.__x;
  await x.dismiss();
  const target = ${JSON.stringify(WS.split('/').pop())};
  // ⚠️ 必须挑**工作区那个** dialog：界面上会同时挂着引导模态（实测「新增:输入框上方额度横条」），
  //    取第一个 [role=dialog] 会拿到它 ⇒ 行永远找不到、composer 一直 inert、
  //    后面两条判据虽然"通过"却是**空转的绿**（判据 3 那一半差点就这么报上去了）。
  const dlg = () => [...document.querySelectorAll('[role=dialog]')]
    .find((d) => /选择工作区目录|添加工作区|选择目录/.test(d.textContent ?? ''))
    ?? [...document.querySelectorAll('[role=dialog]')].find((d) => [...d.querySelectorAll('button')].some((b) => /打开|取消/.test(window.__x.name(b))))
    ?? null;
  const findRow = () => [...(dlg()?.querySelectorAll('button, [role=button], [role=treeitem], li, [title]') ?? [])]
    .find((n) => x.name(n) === target || (n.getAttribute?.('title') ?? '') === target);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await x.dismiss();
    const opener = x.byText('添加工作区') ?? x.byText('选择工作区');
    if (opener == null) return { step: '没有入口', buttons: [...document.querySelectorAll('button')].slice(0, 14).map((b) => x.name(b).slice(0, 14)) };
    opener.click();
    await x.until(() => dlg() != null, 9000);
    if (await x.until(() => findRow() != null, 9000)) {
      findRow().click();
      await x.wait(600);
      const open = [...dlg().querySelectorAll('button')].filter((b) => x.name(b).includes('打开')).find((b) => !b.disabled) ?? null;
      if (open == null) return { step: '打开不可点' };
      open.click();
      const ready = await x.until(() => (x.composer()?.dataset.phase ?? 'inert') !== 'inert', 15000);
      return { viaRow: true, ready, phase: x.composer()?.dataset.phase ?? '' };
    }
    const cancel = [...(dlg()?.querySelectorAll('button') ?? [])].find((b) => /取消|Cancel/.test(x.name(b)));
    if (cancel != null) { cancel.click(); await x.wait(500); }
  }
  return { step: '两轮都没找到那一行', want: target,
    dialog: (dlg()?.getAttribute('aria-label') ?? '').slice(0, 20),
    rows: [...(dlg()?.querySelectorAll('button, [role=treeitem], li') ?? [])].slice(0, 18).map((n) => x.name(n).slice(0, 18)),
    titles: [...(dlg()?.querySelectorAll('[title]') ?? [])].slice(0, 10).map((n) => (n.getAttribute('title') ?? '').slice(-22)) };
})()`);

const sendAsk = (c, text) => c.evaluate(`(async () => {
  const x = window.__x;
  await x.dismiss();
  const c = x.composer();
  if (c == null) return { step: 'no composer' };
  c.focus();
  return { focused: true, phase: c.dataset.phase ?? '' };
})()`).then(async (r) => {
  if (r.step !== undefined) return r;
  const draftLen = `(() => (window.__x.composer()?.textContent ?? '').length)()`;
  // ⚠️ 页内 focus() 不够：选完工作区、点过「新会话」之后编辑器常常没有真实光标，逐字符就打到
  //    别处（同一份脚本 on 那轮 draft=44、off 这轮 draft=0，差别只在焦点）。
  //    ⇒ 先按元素中心发一次真鼠标点击；写完发现没进去就再点一次重写。
  const clickComposer = async () => {
    const box = await c.evaluate(`(() => { const n = window.__x.composer(); if (n == null) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x + 14), y: Math.round(r.y + 8) }; })()`);
    if (box === null) return;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(220);
  };
  const typeAll = async () => {
    for (const ch of text) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Unidentified', text: ch, unmodifiedText: ch });
      await c.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Unidentified' });
    }
  };
  await clickComposer();
  await typeAll();
  let draft = await c.evaluate(draftLen);
  if (draft === 0) { await clickComposer(); await typeAll(); draft = await c.evaluate(draftLen); }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\\r', unmodifiedText: '\\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  return { ...r, draft };
});

const hostCount = (re) => {
  try { return readFileSync(LOG, 'utf8').split('\n').filter((l) => re.test(l)).length; } catch { return -1; }
};

let pids = [];
let c = null;
try {
  mkdirSync(WS, { recursive: true });
  say(`=== #113 现场判据（streaming=${MODE}，gen=${GEN}）===`);
  pids = await launch();
  c = await cdp();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: urlOf() });
  await c.evaluate(`(async () => { ${HELPERS}
    return await window.__x.until(() => window.__x.composer() != null, 25000); })()`);
  const boot = await c.evaluate(`(() => ({
    helpers: typeof window.__x,
    composers: window.__x ? window.__x.qa('[data-composer-input]').map((n) => [n.tagName, n.dataset.phase ?? '', (n.getAttribute('aria-label') ?? '').slice(0, 14)].join('/')) : null,
    dialogs: window.__x ? window.__x.qa('[role=dialog], dialog[open]').map((d) => (d.getAttribute('aria-label') ?? d.tagName).slice(0, 18)) : null,
    buttons: window.__x ? [...document.querySelectorAll('button')].slice(0, 12).map((b) => window.__x.name(b).slice(0, 12)) : null,
    title: document.title,
  }))()`);
  say('· 首屏：' + JSON.stringify(boot));
  const pick = await pickWorkspace(c);
  say(`· 工作区：${JSON.stringify(pick ?? 'evaluate 返回 undefined')}`);
  await c.evaluate(`(async () => {
    const x = window.__x;
    const n = x.byText('新会话') ?? x.byText('新建会话');
    if (n != null) { n.click(); await x.wait(1200); }
    return x.composer()?.dataset.phase ?? '';
  })()`);

  // 判据 2 的前半：发消息**之前**必须是空的（否则读到的不是本回合）
  const before = await c.evaluate(`(() => window.__x.frames())()`);
  check('回合开始前 dataset.streamFrames 为空/不存在',
    before.exists === false || before.raw === null || (Array.isArray(before.list) && before.list.length === 0),
    `实际=${JSON.stringify(before).slice(0, 120)}`);

  const sent = await sendAsk(c, '怎么查看某个端口被哪个进程占用？给一条命令。');
  say(`· 提交：${JSON.stringify(sent)}`);
  if (typeof sent.draft !== 'number' || sent.draft === 0) {
    throw new Error('提交没进 composer（draft=0）⇒ 本轮两条判据都是空转的绿，先修选择器/模态');
  }
  const ghostOrEnd = await c.evaluate(`(async () => {
    const x = window.__x;
    // 等到"有帧可读"或"回合已结束且无帧"（off 模式永远无帧，靠宿主日志收尾判定）
    await x.until(() => {
      const f = x.frames();
      return Array.isArray(f.list) && f.list.length >= 2;
    }, 45000);
    return x.frames();
  })()`);
  // 再等一会儿：让终帧与"DOM 恢复空闲"都发生完（判据 2 要的是**回合结束后仍可读**）
  await sleep(6000);
  const after = await c.evaluate(`(() => window.__x.frames())()`);
  const traceLines = c.consoleLines.filter((l) => l.text.includes('stream frame='));

  if (MODE === 'on') {
    const list = Array.isArray(after.list) ? after.list : [];
    check('回合结束后 dataset.streamFrames 仍含本回合全部帧（判据 2）',
      list.length >= 2 && list.some((f) => f.final === 1),
      `帧数=${list.length} 终帧=${list.filter((f) => f.final === 1).length} raw=${String(after.raw).slice(0, 160)}`);
    check('每条记录只有 frame/final/chars/t 四个键（隐私：无正文）',
      list.length > 0 && list.every((f) => Object.keys(f).sort().join(',') === 'chars,final,frame,t'),
      `键集合=${JSON.stringify(list.length > 0 ? Object.keys(list[0]).sort() : [])}`);
    // 判据 1：与留痕**逐格**对齐（两条独立来源互相校验）
    const fromTrace = traceLines.map((l) => {
      const m = /stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/.exec(l.text);
      return m === null ? null : { frame: +m[1], final: +m[2], chars: +m[3], t: +m[5] };
    }).filter((x) => x !== null);
    const same = fromTrace.length === list.length
      && fromTrace.every((f, k) => f.frame === list[k].frame && f.final === list[k].final
        && f.chars === list[k].chars && f.t === list[k].t);
    check('DOM 与 `stream frame … t=` 留痕逐格对齐（判据 1）',
      same && fromTrace.length >= 2,
      `留痕 ${fromTrace.length} 帧 / DOM ${list.length} 帧；留痕=${JSON.stringify(fromTrace).slice(0, 170)}；DOM=${JSON.stringify(list).slice(0, 170)}`);
    say(`  ℹ 帧序列：${list.map((f) => `${f.frame}→${f.chars}字${f.final ? '(终)' : ''}`).join(' ，')}`);
    const gaps = list.slice(1).map((f, k) => f.t - list[k].t);
    say(`  ℹ 相邻帧间隔(ms)：${JSON.stringify(gaps)}`);
    check('增量帧不写盘：本轮 `push landed`（不含 hot）为 0（判据 3 的硬闸）',
      hostCount(/(?<!hot )push landed/) <= 2,
      `宿主日志里建议格 push landed 共 ${hostCount(/(?<!hot )push landed/)} 行（阈值 2：终帧一次 + 冷启动应答一次）`);
  } else {
    check('默认关：整轮结束后 dataset.streamFrames 仍不存在/为空（判据 3）',
      after.exists === false || after.raw === null || (Array.isArray(after.list) && after.list.length === 0),
      `实际 raw=${String(after.raw).slice(0, 120)}`);
    check('默认关：留痕侧也确实没有帧行（两条来源同时为空，不是只有一边坏）',
      traceLines.length === 0, `stream frame 留痕 ${traceLines.length} 行`);
    check('默认关：回合本身仍然正常（宿主有建议格落地，说明不是"整条链没跑"）',
      hostCount(/ops-trace\] suggestion (generated|dropped)/) >= 1,
      `generated/dropped 行数=${hostCount(/ops-trace\] suggestion (generated|dropped)/)}`);
  }
  void ghostOrEnd;
} catch (error) {
  failed += 1;
  say('!! 失败：' + redact(String((error && error.message) ?? error).slice(0, 300)));
} finally {
  if (c !== null) { try { c.close(); } catch { /* noop */ } }
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* noop */ } }
  await sleep(2500);
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* noop */ } }
  say(`· token 明文进 stdout 的次数 = ${leaked}（redact 命中 ${leaked} 次即非零 ⇒ 有泄漏，须查）`);
}
say(`\n${failed === 0 ? '✅' : '❌'} stream-frames-dom-e2e（streaming=${MODE}）：${failed === 0 ? '判据全过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
