#!/usr/bin/env node
/**
 * overlay 挂载契约 + 「换一条」的在途呈现判据（Gitea #127 / #139 / #152）。
 *
 * ## 这个脚本有**两段**，职责不同，都必须绿
 *
 * ### A. 行为对照（真 DOM，跑真实构建产物）
 *
 * 旧版本前半段全是源码正则。按 `CONTRIBUTING.md:49`，「只有源码文本匹配、没有行为
 * 对照的形状断言不算修好了一个 bug —— 它和实现共享同一套假设」。所以本文件现在
 * **真的跑**：把 esbuild 打的真实浏览器产物 `lib/client.js` 加载进真实 Chromium，
 * 截获 `__ModuleLoader__.load` 的 factory 拿到 `GhostOverlay` 类（模块私有，不导出），
 * 构造宿主的真实三层 DOM 契约，然后调真方法、读真 DOM：
 *
 *   div[data-input-scroll]
 *   └─ div.grow (position:relative，overlay 的 offsetParent)
 *      ├─ div[data-composer-input] (contenteditable)
 *      └─ div[data-composer-placeholder]
 *
 * 钉住两条**性质**（不是某条触发路径）：
 *
 *  1. **挂载可自愈**：overlay 节点被摘走之后，下一次 `attach()+show()` 必须把它
 *     重新挂回去。旧实现的 `if (this.composer === composer) return;` 用 composer
 *     引用做短路，引用没变就永不 `appendChild` ⇒ 节点再也不回来。**摘节点本身是
 *     人为构造的**：真实宿主在什么操作下会"保 composer 引用但换掉 `.grow` 内容"
 *     尚未定位，所以这里钉的是「一旦发生就**不会自愈**」这个性质。
 *  2. **指示状态落在可观测载体上**：`syncPendingStyle()` 写 `this.el.dataset`，而
 *     `el` 只在 attach() 里 append。冷启动未 attach 期间写入的是**游离节点** ⇒
 *     `document.querySelector` 查不到、`body:has()` 规则不命中，指示零可观测。
 *
 * ### B. 形状守卫（源码正则）
 *
 * 后半段钉「载荷从哪个函数派生」这类结构问题——真宿主里跑一百次也区分不出「现算」
 * 与「写了一次还没被抹掉」。它防的是退化到已知的坑，**不是**证据。
 *
 * ## 环境
 *
 * 浏览器与仓库其它 DOM 脚本同一口径（`scripts/stream-frames-dom-e2e.mjs:45`）：
 * `CHROME_BIN`，否则 `<home>/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`。
 * A 段跑的是**构建产物**，所以需要先 `npm run build`；`lib/client.js` 或浏览器缺失时
 * A 段明确报红（不静默跳过——静默跳过会让"没跑"伪装成"跑绿了"）。
 *
 * 用法：node --experimental-strip-types scripts/regen-pending-smoke.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const host = readFileSync(join(REPO, 'src/index.ts'), 'utf8');
const settings = readFileSync(join(REPO, 'src/settings.ts'), 'utf8');
const client = readFileSync(join(REPO, 'src/client/index.ts'), 'utf8');

let passed = 0;
let failed = 0;

/** 断言一条并打印读数。 */
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
  }
};

/** 关系式断言：把实测读数一起打出来（红的时候要看得到"多少"）。 */
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : `\n      实测：${detail}`}`);
  }
};

/** 取某个函数体（从签名到下一个顶格 `};` 或 `}`），用于「在这段里找某串」。 */
const bodyOf = (source, signature, endMarker = '\n  };') => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `源码里找不到签名：${signature}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `签名之后找不到结束标记 ${JSON.stringify(endMarker)}`);
  return source.slice(start, end);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 最小 CDP 客户端（Node 自带 WebSocket，零依赖）
// 与 scripts/stream-frames-dom-e2e.mjs:132 同一套做法。
// ═══════════════════════════════════════════════════════════════════════════
const CHROME = process.env.CHROME_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

const cdp = async () => {
  const dir = join(tmpdir(), `sg-overlay-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let k = 0; k < 120 && !existsSync(portFile); k += 1) await sleep(100);
  if (!existsSync(portFile)) {
    proc.kill('SIGKILL');
    throw new Error(`Chromium 没起来（等不到 DevToolsActivePort）：${CHROME}`);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页内异常：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    }
    // ⚠️ `send()` 已经把外层 `{result, exceptionDetails}` 拆掉了 ⇒ 值在 `r.result.value`。
    // 写错不报错、只是恒 undefined，所有页内判据都会"读不到东西"。
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  // 留一个干净空白页（about:blank 的 origin 不可 fetch，用 document.write 造同文档）。
  await evaluate('document.open();document.write("<html><head></head><body></body></html>");document.close();');
  const close = () => {
    try { ws.close(); } catch { /* noop */ }
    proc.kill('SIGKILL');
    // Chrome 被杀时仍在往 user-data-dir 里写：立刻 rm 会撞 ENOTEMPTY，而它抛在
    // `finally` 里就会被上层记成「行为对照未能运行」——一条与判据无关的假红（实测）。
    // 重试是清理临时目录的标准做法，不影响任何被测判据。
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 留给系统清理 */ }
  };
  return { evaluate, close };
};

/**
 * 注入真实 bundle 并取得 `GhostOverlay`（模块私有，未导出）。
 *
 * ## 为什么不是「把类声明抠出来 `new Function` 求值」
 *
 * 试过，**不可行**：类体引用了同一模块作用域里的 `OVERLAY_ID` / `TEXT_LAYOUT_PROPS` /
 * `ANCHOR_REDRAW_TOLERANCE_PX` / `CARET_GLOW_RULE` / `BOX_GLOW_RULE` /
 * `PENDING_STYLE_ID` 等常量，换个作用域求值就会 `ReferenceError: OVERLAY_ID is
 * not defined`。把它们一起抠出来是在手工重建模块作用域——那正是最容易与真实产物
 * 脱节的地方。
 *
 * ## 实际做法：给**一份副本**追加一行导出
 *
 * 在被测 bundle 的文本里，往 factory 的 `return module.exports;` 之前插一行
 * `globalThis.__GhostOverlay = GhostOverlay;`。注入点**在 factory 作用域内部**，
 * 所以类拿到的仍是它原本的那套模块级常量；而磁盘上的 `lib/client.js` 一字未改。
 *
 * factory 顶层会 `require('react')` / `'react/jsx-runtime'` /
 * `'@deepseek-ai/dsh-client-ui-primitives'`（bundle 第 905-1040 行）。本用例只用
 * overlay 类本体、不碰设置卡片，所以给一个**惰性 proxy** 兜住：取任何属性或调用都
 * 返回自身，永不求值真实模块。让它抛错的话整个 bundle 在顶层就炸。
 */
const MARKER = '\t\treturn module.exports;';

const injectBundle = (bundle) => {
  const occurrences = bundle.split(MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`bundle 里 factory 收尾标记出现 ${occurrences} 次（期望 1 次）：注入点已漂移`);
  }
  const patched = bundle.replace(MARKER, `\t\tglobalThis.__GhostOverlay = GhostOverlay;\n${MARKER}`);
  return `(() => {
  window.__ModuleLoader__ = {
    load: (def) => {
      // 惰性 proxy：见上方注释，只为让 factory 顶层的 require 不炸。
      const lazy = () => new Proxy(function () {}, {
        get: () => lazy(), apply: () => lazy(), construct: () => ({}),
      });
      const mod = def.factory(() => lazy());
      return mod;
    },
  };
  const s = document.createElement('script');
  s.textContent = ${JSON.stringify(patched)};
  document.head.appendChild(s);
  return typeof globalThis.__GhostOverlay === 'function' ? 'ok' : 'not-a-class';
})()`;
};

/**
 * 构造宿主真实三层 DOM 契约（几何取自 `ghost-geom-smoke.mjs` 实测的 0.2.x 结构）。
 *
 * `.grow` 必须 `position:relative`——它是 overlay 的 offsetParent，`verify()` 会
 * 对它做 `instanceof HTMLElement` 检查，static 定位会让自检直接失败。
 */
const BUILD_HOST = `(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.setAttribute('data-input-scroll', '');
  scroll.style.cssText = 'position:relative;overflow-y:auto;max-height:336px;width:640px';
  const grow = document.createElement('div');
  grow.className = 'grow';
  grow.style.cssText = 'position:relative;width:640px;min-height:96px';
  const editor = document.createElement('div');
  editor.setAttribute('data-composer-input', '');
  editor.setAttribute('contenteditable', 'true');
  editor.style.cssText = 'position:relative;width:600px;padding:4px 14px;line-height:24px;font-size:14px;font-family:sans-serif;min-height:24px';
  const ph = document.createElement('div');
  ph.setAttribute('data-composer-placeholder', '');
  ph.textContent = '帮我写点什么';
  ph.style.cssText = 'position:absolute;left:14px;top:4px;line-height:24px;font-size:14px;font-family:sans-serif';
  grow.append(editor, ph);
  scroll.append(grow);
  document.body.append(scroll);
  return true;
})()`;

/** 页内只读探针。全部通过 computed style / querySelector 判定，不猜内部字段。 */
const HELPERS = `(() => {
  window.__g = {
    ID: 'dsh-suggest-ghost-overlay',
    /** 真实地往 contenteditable 里写文本（不用 execCommand：Lexical 下会静默失败）。 */
    type(text) { const ed = document.querySelector('[data-composer-input]'); ed.textContent = text; return ed; },
    count: () => document.querySelectorAll('#dsh-suggest-ghost-overlay').length,
    inGrow() {
      const g = document.querySelector('.grow');
      return g !== null && Array.from(g.children).some((c) => c.id === 'dsh-suggest-ghost-overlay');
    },
    /** placeholder 是否让位（口语判据：computed display）。 */
    phDisplay: () => getComputedStyle(document.querySelector('[data-composer-placeholder]')).display,
    /** 指示状态是否"纯读 DOM 可取证"。 */
    caretHits: () => document.querySelectorAll('#dsh-suggest-ghost-overlay[data-caret-glow="1"]').length,
    shownHits: () => document.querySelectorAll('#dsh-suggest-ghost-overlay[data-shown="1"]').length,
    llm(text) { return { kind: 'llm', text, acceptKey: 'Tab', frame: null, pending: false }; },
  };
  return true;
})()`;

// ═══════════════════════════════════════════════════════════════════════════
// A. 行为对照
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n—— A. 行为对照：真实 Chromium + 真实 lib/client.js ——');

const behavioral = async () => {
  const bundlePath = join(REPO, 'lib/client.js');
  if (!existsSync(bundlePath)) throw new Error('lib/client.js 不存在：本段跑的是构建产物，先 npm run build');
  if (!existsSync(CHROME)) throw new Error(`找不到 Chromium 可执行文件：${CHROME}（可用 CHROME_BIN 指定）`);
  console.log(`  （引擎：${CHROME}）`);

  const b = await cdp();
  try {
    const injected = await b.evaluate(injectBundle(readFileSync(bundlePath, 'utf8')));
    check('截获真实 bundle 里的 GhostOverlay（零改动被测对象）', injected === 'ok', injected);
    if (injected !== 'ok') return;

    await b.evaluate(BUILD_HOST);
    await b.evaluate(HELPERS);

    // ── 1) 问题 A：挂载可自愈 ────────────────────────────────────────────────
    const mount = await b.evaluate(`(() => {
      const o = new globalThis.__GhostOverlay();
      const ed = document.querySelector('[data-composer-input]');
      const id = window.__g.ID;
      o.attach(ed);
      o.show(window.__g.llm('第一段建议'));
      const before = { count: window.__g.count(), inGrow: window.__g.inGrow(), connected: o.el.isConnected };
      // 人为摘走节点（构造"宿主换掉 .grow 内容"这类会丢失插件节点的事）。
      document.getElementById(id).remove();
      const detached = { count: window.__g.count(), inGrow: window.__g.inGrow(), connected: o.el.isConnected };
      // 用户继续真实输入 ⇒ 宿主下次 render() 带新内容重新调 attach()+show()。
      window.__g.type('帮我写点什么');
      o.attach(ed);
      o.show(window.__g.llm('第二段建议'));
      const after = {
        count: window.__g.count(),
        inGrow: window.__g.inGrow(),
        connected: o.el.isConnected,
        text: o.el.textContent,
        display: getComputedStyle(o.el).display,
      };
      return { before, detached, after };
    })()`);

    check('（前提）摘节点前：节点在 .grow 里且已连接',
      mount.before.count === 1 && mount.before.inGrow && mount.before.connected, JSON.stringify(mount.before));
    check('（前提）摘走后确实游离（本用例的构造前提）',
      mount.detached.count === 0 && !mount.detached.inGrow && !mount.detached.connected, JSON.stringify(mount.detached));
    check('【问题 A】再次 attach+show 后节点回到 .grow（旧实现此处恒为 0）',
      mount.after.count === 1 && mount.after.inGrow && mount.after.connected,
      JSON.stringify(mount.after));

    // ── 2) 问题 B：指示状态必须可观测，且不能提前让位 ────────────────────────
    // 与 render() 逐字同序：帧首 attach（绑定 + 挂载），再写指示状态，再显示。
    const pend = await b.evaluate(`(() => {
      document.querySelectorAll('#dsh-suggest-ghost-overlay').forEach((n) => n.remove());
      const o = new globalThis.__GhostOverlay();
      const ed = document.querySelector('[data-composer-input]');
      o.attach(ed);                                 // render() 帧首
      o.syncPendingStyle({ caretGlow: true, boxGlow: true }, true);   // 冷启动：无幽灵内容，只在途
      const cold = {
        caretHits: window.__g.caretHits(),
        count: window.__g.count(),
        connected: o.el.isConnected,
        display: getComputedStyle(o.el).display,
        shown: o.el.dataset.shown ?? '0',
        phDisplay: window.__g.phDisplay(),
      };
      // 之后真的显示出幽灵：常驻节点被 show 复用，不重复 append。
      o.show(window.__g.llm('建议'));
      const lit = {
        count: window.__g.count(),
        display: getComputedStyle(o.el).display,
        shownHits: window.__g.shownHits(),
        phDisplay: window.__g.phDisplay(),
      };
      // 收口：不在途 ⇒ 属性摘掉，但节点仍可观测（不是"随之消失"）。
      o.syncPendingStyle({ caretGlow: true, boxGlow: true }, false);
      const off = { caretHits: window.__g.caretHits(), count: window.__g.count(), connected: o.el.isConnected };
      // 再加一轮：显示期间节点被摘走，此时只调 syncPendingStyle（没有 attach / show），
      // 它也必须自己把节点挂回来 —— 这是"零可观测"那条问题的独立自愈路径。
      o.show(window.__g.llm('又一建议'));
      o.el.remove();
      const stolen = { count: window.__g.count(), connected: o.el.isConnected };
      o.syncPendingStyle({ caretGlow: true, boxGlow: true }, true);
      const recovered = { count: window.__g.count(), connected: o.el.isConnected, caretHits: window.__g.caretHits(),
                          phDisplay: window.__g.phDisplay() };
      return { cold, lit, off, stolen, recovered };
    })()`);

    check('【问题 B】冷启动未显示时，指示状态仍可被 querySelector 查到（旧实现 caretHits 恒 0）',
      pend.cold.caretHits === 1 && pend.cold.connected && pend.cold.count === 1, JSON.stringify(pend.cold));
    check('【让位规则】常驻但未显示：overlay 是 display:none 且无 data-shown="1"，placeholder 不让位',
      pend.cold.display === 'none' && pend.cold.shown !== '1' && pend.cold.phDisplay !== 'none',
      JSON.stringify(pend.cold));
    check('【让位规则】真的显示时才让位，且节点没有重复 append',
      pend.lit.count === 1 && pend.lit.display === 'block' && pend.lit.shownHits === 1 && pend.lit.phDisplay === 'none',
      JSON.stringify(pend.lit));
    check('【问题 B】收口后属性摘掉，节点仍可观测',
      pend.off.caretHits === 0 && pend.off.connected && pend.off.count === 1, JSON.stringify(pend.off));
    check('【问题 B】只调 syncPendingStyle 也能把被摘走的节点挂回来（独立自愈路径）',
      pend.stolen.count === 0 && !pend.stolen.connected
        && pend.recovered.count === 1 && pend.recovered.connected && pend.recovered.caretHits === 1,
      JSON.stringify({ stolen: pend.stolen, recovered: pend.recovered }));

    // ── 3) 不变量：常驻化不许变成"卸不掉" ───────────────────────────────────
    // 先打个快照：前面用例留下的实例可能还在 head 里留着同类标签，所以只比**本实例**
    // 造成的增减（构造 +1，dispose -1），不比绝对值。
    const dispose = await b.evaluate(`(() => {
      document.querySelectorAll('#dsh-suggest-ghost-overlay').forEach((n) => n.remove());
      const own = () => document.querySelectorAll(
        'style[data-plugin-css="dsh-suggest-ghost"]').length;
      const before = own();
      const o = new globalThis.__GhostOverlay();
      const ed = document.querySelector('[data-composer-input]');
      o.attach(ed);
      o.show(window.__g.llm('建议'));
      const withNode = document.querySelectorAll('#dsh-suggest-ghost-overlay').length;
      const whileLive = own();
      o.dispose();
      return { withNode,
               after: document.querySelectorAll('#dsh-suggest-ghost-overlay').length,
               before, whileLive, afterTags: own() };
    })()`);
    check('【不变量】dispose() 之后节点离开 DOM、自身样式标签正好收回本实例那一张',
      dispose.withNode === 1 && dispose.after === 0
        && dispose.whileLive === dispose.before + 1 && dispose.afterTags === dispose.before,
      JSON.stringify(dispose));

    // ── 4) 不变量：显示中的幽灵仍然"真的画出来了"（不是只有属性对）──────────
    const painted = await b.evaluate(`(() => {
      document.querySelectorAll('#dsh-suggest-ghost-overlay').forEach((n) => n.remove());
      const o = new globalThis.__GhostOverlay();
      const ed = document.querySelector('[data-composer-input]');
      o.attach(ed);
      o.show(window.__g.llm('帮我写点什么，然后再补一套冒烟'));
      const r = o.el.getBoundingClientRect();
      return { painted: o.isPainted, text: o.el.textContent, w: r.width, h: r.height,
               reject: o.el.dataset.reject ?? null };
    })()`);
    check('【不变量】LLM 幽灵过自检并真的占据版面（文本 + 非零矩形）',
      painted.painted === true && painted.text.length > 0 && painted.w > 0 && painted.h > 0,
      JSON.stringify(painted));
  } finally {
    b.close();
  }
};

try {
  await behavioral();
} catch (error) {
  failed += 1;
  console.log(`  ✗ 行为对照未能运行\n      ${error?.message ?? error}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 形状守卫
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n—— B. 载荷派生（现算，不是一次性写）——');

run('statePushOf 里 regenPending 由 regenPendingFor(...) 现算', () => {
  const body = bodyOf(host, 'const statePushOf = (');
  assert.match(
    body,
    /regenPendingFor\(sessionId\)/,
    'statePushOf 没有调 regenPendingFor：那意味着 pending 是别处一次性写进去的（会被下一次无关推送抹掉）',
  );
});

run('regenPendingFor 读的是宿主在途集合，不是某个可被抹掉的变量', () => {
  const start = host.indexOf('const regenPendingFor = (');
  assert.ok(start >= 0, '找不到 regenPendingFor');
  const snippet = host.slice(start, start + 400);
  assert.match(snippet, /regenInFlight\.has\(/, 'regenPendingFor 没读在途集合');
});

run('序列化出口只在 true 时写键（不在途 ⇒ 零额外字节）', () => {
  const body = bodyOf(host, 'const buildPushPayload = (');
  assert.match(body, /regenPending === true \? \{ regenPending: true \}/, '序列化不是「只在 true 时写」的形状');
  assert.ok(!/regenPending:\s*false/.test(body), '序列化里出现了显式 false：那会让每次推送都携带这个键（指纹每格都变）');
});

console.log('\n—— B. 客户端读取 ——');

run('客户端读 `pushed?.regenPending === true`（缺省即不在途，旧宿主无害）', () => {
  assert.match(client, /regenPending: pushed\?\.regenPending === true/);
});

run('在途位进 content key（否则边沿不触发重绘）', () => {
  assert.match(client, /llm:\$\{result\.pending \? 'pending:' : ''\}/);
});

run('在途位标在自己节点上（纯读 DOM 可取证）', () => {
  assert.match(client, /this\.el\.dataset\.regenPending = '1'/);
  assert.match(client, /delete this\.el\.dataset\.regenPending/);
});

console.log('\n—— B. 挂载契约（形状守卫，只防退化；行为证据见 A 段）——');

run('attach() 短路必须同时要求 composer 未变**且**节点仍在 DOM 里', () => {
  const body = bodyOf(client, 'private attach(composer: HTMLElement): void {');
  assert.match(
    body,
    /if \(this\.composer === composer && this\.el\.isConnected\) return;/,
    'attach 的短路没带存活判据：composer 引用不变而节点被摘走时会永久不重挂',
  );
  assert.doesNotMatch(body, /if \(this\.composer === composer\) return;/,
    'attach 仍存在「只看 composer 引用」的短路');
});

run('syncPendingStyle 的每一次写入都在「确保已挂载」之后（否则属性写在游离节点上）', () => {
  // 契约只有一条：**写属性之前节点必须在场**。两条等价实现都接受——
  //  (a) syncPendingStyle 自己先调 ensureMounted()；或
  //  (b) render() 在调用它之前先 attach/ensureMounted。
  // 判据从"某个写法"改成"这条契约"，是因为把位置钉死会让换个等价写法就误红
  // （变异实验里复现过：只在 render 前置、syncPendingStyle 不自愈时，那条独立自愈
  //  行为断言就红了，形状守卫却仍是绿的——守卫锚错了对象）。
  const start = client.indexOf('syncPendingStyle(style: PendingStyleSettings, pending: boolean): void {');
  assert.ok(start > 0, '找不到 syncPendingStyle 的方法声明');
  const bodyEnd = client.indexOf('\n  dispose(): void {', start);
  assert.ok(bodyEnd > start, 'syncPendingStyle 之后找不到 dispose');
  const body = client.slice(start, bodyEnd);
  const writeAt = body.indexOf('.dataset.caretGlow');
  assert.ok(writeAt > 0, 'syncPendingStyle 里找不到写 caretGlow 的地方');
  const selfMounted = /this\.ensureMounted\(\)/.test(body.slice(0, writeAt));

  const callAt = client.indexOf('overlay.syncPendingStyle(');
  assert.ok(callAt > 0, '找不到 syncPendingStyle 的调用点');
  const renderAt = client.lastIndexOf('const render = (): void => {', callAt);
  assert.ok(renderAt > 0 && renderAt < callAt, '找不到调用点所在的 render 函数');
  const callerMounted = /overlay\.(ensureMounted|attach)\(/.test(client.slice(renderAt, callAt));

  assert.ok(selfMounted || callerMounted,
    '写指示状态之前没有任何挂载动作：冷启动期间属性会写在游离节点上（querySelector 查不到、body:has 不命中）');
});

console.log('\n—— B. 形状声明 ——');

run('载荷形状里 regenPending 是可选布尔（旧载荷兼容）', () => {
  assert.match(settings, /readonly regenPending\?: boolean/);
  assert.match(client, /regenPending\?: unknown/);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} regen-pending: ${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
