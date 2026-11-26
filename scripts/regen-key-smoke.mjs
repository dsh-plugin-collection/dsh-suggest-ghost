#!/usr/bin/env node
/**
 * 「换一条」键在非 llm 形态下**不得吞键**（Gitea #168）的行为冒烟。
 *
 * ## 要闭合的现象
 *
 * `onKeyDown` 的 regen 支曾经是「**先吞键、再判 kind**」：非 llm 形态下用户按下
 * `Alt+G`，`preventDefault()` + `stopPropagation()` 已经执行完，之后才发现这条建议
 * 根本不支持「再要一条」，于是只留一条 debug trace —— 屏幕上什么都没发生、键也到不了
 * 输入框。而键位提示行里的「换一条」段本就**只在 llm 形态显示**（`key-hint-text.ts`），
 * 等于用户在一个没有任何界面元素声称这个键有用的形态上被吞了键。
 * 同函数的采纳支（#38 闸）早就确立了相反的做法：「此刻没有可执行动作就不要吞键」。
 *
 * ## 为什么必须跑真浏览器、真产物（而不是抽个纯函数来测）
 *
 * 本单的验收判据全是**事件栈语义**：
 *   ① `event.defaultPrevented === false`
 *   ② 事件**仍能到达其后注册的处理器**
 *   ③ 没有 regen op 写出（`writeOps` 侧）
 * ② 尤其测不到：抽一个「判 kind」的纯函数，只能证明分支顺序变了，证明不了事件真的
 * 继续传播。`cancelBubble` 不能当判据（已废弃，读不到 `stopPropagation` 的效果）——
 * 所以 ② 用**在 target 层后注册的探针监听器**来读，而不是读任何"被拦了"的字段。
 *
 * 本脚本因此与 `regen-pending-smoke.mjs` / `stream-frames-dom-e2e.mjs` 同一口径：
 * 真 Chromium 加载**构建产物** `lib/client.js`，调**真的** `apply()`（不是抠出某个
 * 函数另起作用域求值），宿主 DOM 契约与设置文档都按真实形状构造。
 *
 * ### 真到什么程度（这是本脚本最要紧的一段自述）
 *
 * - **真 `apply`**：注入点取 `module.exports`，调它导出的 `apply`。整条闭包、真实
 *   `onKeyDown`、真实的 `window.addEventListener('keydown', onKeyDown, true)` 都跑在
 *   真产物里；脚本**没有**复制一份按键逻辑。
 * - **真数据路径**：history 形态来自 `remote.settings.describe()` 返回的 `_hot.history`
 *   格 —— 与宿主推送同一条解析链（`applySettings` → `PushedPayload`/`HotPushedPayload`
 *   → `computeGhostContent`），不是往 `shown` 里塞值（那是闭包私有变量，塞不进去）。
 * - **真 writeOps 出口**：`remote.settings.mutate(ns, [{op:'set', path:['_ops']}])`，
 *   脚本记录每一次 mutate 的载荷并断言其中**没有** regen op。
 * - **假的部分**：宿主服务面（sessions / conversation / input / locale / slots）是
 *   最小假面。这是本脚本的已知边界：它证明的是**本插件在这套事件与载荷契约下的行为**，
 *   不证明真实宿主里 tab 焦点最终落到哪个元素（那条见 PR 里的真 GUI 一节，按三态记录）。
 *
 * ## 三态口径（`docs/gitea-workflow.md` §5）
 *
 * `PASS` / `FAIL` / `NOT-COVERED`。缺构建产物或缺浏览器时**明确打 NOT-COVERED 并
 * 退出 2** —— 不许静默跳过把「没跑」伪装成「跑绿了」。退出码：0 全过 / 1 有红 / 2 未覆盖。
 *
 * ## 脚本自身的两种自毁模式（§8 注入类附加纪律）
 *
 * 1. **页内注入体单独做语法检查**：每个 `page.evaluate` 的注入体都先过
 *    `new Function(体)`（`--check-injects` 可只做这一步）。模板字符串里一个多余的反引号
 *    会让注入体**提前闭合**，于是"四个方向全红"，与"脚本坏了"同形。
 * 2. **失败不得表现为"断言全红"**：浏览器起不来 / 产物缺失 / 页内异常都是
 *    NOT-COVERED 或明确的脚本错误（退出码 2 / 3），而不是把用例判成红。
 * 3. 语法检查自身也要被证明**活着**：`--self-test` 会把一个本该语法错的注入体喂给检查器，
 *    它必须报错（否则这个闸是空闸）。
 *
 * ## 注入自证（§6）
 *
 * `--inject-legacy {swallow-first|stop-prop-only|no-trace}` 会在**页内副本**上按旧写法
 * 改写注入的 bundle（磁盘上的 `lib/client.js` 一字未改），然后跑同一套断言：
 *  - `swallow-first`（历史 bug 形态：先 preventDefault+stopPropagation 再判 kind）
 *    ⇒ ①②必须红；③仍绿（它本来就不写 regen op）。**全绿即说明本脚本失效**。
 *  - `stop-prop-only`（若真 GUI 实测需要走 issue 里写的退路）
 *    ⇒ ①绿、②红。它证明「只 preventDefault 不 stopPropagation」**不满足**本单判据。
 *  - `no-trace`（把 not-llm 的留痕摘掉）⇒ 留痕断言红（证 trace 断言活着）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --check-injects
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --self-test
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --inject-legacy swallow-first
 *
 * ## 一条必须知道的未覆盖项（⑥）
 *
 * 「放行后 Alt+G 会不会落到浏览器/系统的原生动作上」在 DOM 层只能取到侧面证据
 * （见用例 ⑥）。**原生菜单不是 DOM 事件**，而合成事件 `isTrusted === false` 又永远
 * 触发不了原生动作。⑥ 用 CDP 受信任按键补这一面，但 headless Chromium 在装载真实
 * bundle 的页面上**投递不稳定**（本夹具实测：可达 → 之后为 0），所以 ⑥ 送达失败时
 * 打印 **NOT-COVERED**、不计入 ✓/✗、也不改变主判据的 PASS/FAIL，汇总行带「⑥ 未覆盖」。
 * ⇒ 本脚本的绿**不包含**「原生层无副作用」这一条，那一项仍是上线前的人工项。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const BUNDLE = join(REPO, 'lib/client.js');

const argv = process.argv.slice(2);
const MODE_INJECT = (() => {
  const i = argv.indexOf('--inject-legacy');
  return i >= 0 ? (argv[i + 1] ?? '') : null;
})();
const CHECK_ONLY = argv.includes('--check-injects');
const SELF_TEST = argv.includes('--self-test');

let passed = 0;
let failed = 0;
let notCovered = null;
/**
 * ⑥「原生动作面」的送达失败：**软未覆盖**。
 *
 * 与 `notCovered` 分开：`notCovered` 是「整个脚本没跑成」（坏构建/坏环境 ⇒ 退出 2，
 * 谁的结论都不作数）；而这里主判据（①–⑤、B 段）**已经真的跑到了并有结论**，
 * 只是 ⑥ 那一项没验到 ⇒ 打印 NOT-COVERED、不计入 ✓/✗、**也不改变主判据的 PASS/FAIL**。
 * 否则 `test:smoke` 会因为 headless 的按键投递不稳而恒红，量具就成了噪声源。
 */
let softNotCovered = null;

const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
/** 断言一条并打印读数（红的时候要看得到实测值，不是只看到"红了"）。 */
const check = (name, condition, detail) => {
  if (condition) { ok(name); return; }
  failed += 1;
  console.log(`  ✗ ${name}${detail === undefined ? '' : `\n      实测：${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 页内注入体：全部先过语法检查（§8 第 1 条）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 每个注入体都是**完整表达式**（要么是 IIFE 调用、要么是一个对象字面量），
 * 所以可以用 `new Function('return (' + body + ')')` 做纯语法检查 —— 不求值。
 */
const INJECTS = {};

/**
 * 注入真实 bundle 并取出 `module.exports`。
 *
 * 注入点选 `factory` 的 `return module.exports;` 之前：作用域**在 factory 内部**，
 * 所以拿到的 `apply` 仍是原本那套模块级常量；磁盘上的产物一字未改。
 * factory 顶层会 `require('react')` 等，用惰性 proxy 兜住（同 `regen-pending-smoke.mjs`）。
 */
INJECTS.load = (bundleText) => `(() => {
  window.__ModuleLoader__ = {
    load: (def) => {
      const lazy = () => new Proxy(function () {}, {
        get: () => lazy(), apply: () => lazy(), construct: () => ({}),
      });
      return def.factory(() => lazy());
    },
  };
  const s = document.createElement('script');
  s.textContent = ${JSON.stringify(bundleText)};
  document.head.appendChild(s);
  return Array.isArray(Object.keys(globalThis.__SG ?? {})) ? 'ok' : 'no-exports';
})()`;

/** 宿主 composer 的三层 DOM 契约（与 `regen-pending-smoke.mjs` 的 BUILD_HOST 同形）。 */
INJECTS.host = (draft = 'hel') => `(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.setAttribute('data-input-scroll', '');
  scroll.style.cssText = 'position:relative;overflow-y:auto;max-height:336px;width:640px';
  const grow = document.createElement('div');
  grow.className = 'grow';
  grow.style.cssText = 'position:relative;width:640px;min-height:96px';
  const ed = document.createElement('div');
  ed.id = 'probe-composer';
  ed.setAttribute('data-composer-input', '');
  ed.setAttribute('contenteditable', 'true');
  ed.style.cssText = 'position:relative;width:600px;padding:4px 14px;line-height:24px;font-size:14px;font-family:sans-serif;min-height:24px';
  const ph = document.createElement('div');
  ph.setAttribute('data-composer-placeholder', '');
  ph.textContent = '帮我写点什么';
  ph.style.cssText = 'position:absolute;left:14px;top:4px;line-height:24px;font-size:14px;font-family:sans-serif';
  grow.append(ed, ph);
  scroll.append(grow);
  document.body.append(scroll);
  ed.textContent = ${JSON.stringify(draft)};
  ed.focus();
  // 真选区：history 形态的 overlay 自检要读草稿末端的 rect，没有选区会 rejectAs('no-caret')。
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return { focused: document.activeElement === ed };
})()`;

/**
 * 调真 `apply()`。
 *
 * `settingsDoc` 由 Node 侧按用例传入（JSON）：history 形态来自 `_hot.history`，
 * 走的是与宿主推送同一条解析链。`__writes` 记录每一次 `mutate` 的入参，
 * 这就是「有没有写出 regen op」的判据面。
 */
INJECTS.apply = (settingsJson, draft = 'hel') => `(() => {
  const store = (v) => ({ getSnapshot: () => v, subscribe: () => () => {} });
  const value = ${JSON.stringify(settingsJson)};
  // 草稿是形态的**判据**（#129）：llm 形态只在空草稿上可达，history 形态要非空草稿。
  // 由用例传入，夹具不得自己挑一个能过的值。
  window.__draft = { draft: ${JSON.stringify(draft)}, draftRev: 1 };
  window.__setDraft = (t) => {
    window.__draft = { draft: t, draftRev: (window.__draft.draftRev ?? 0) + 1 };
    const ed = document.querySelector('#probe-composer');
    if (ed !== null) ed.textContent = t;
  };
  const inputFace = {
    state: {
      getSnapshot: () => ({ draft: window.__draft.draft, draftRev: window.__draft.draftRev }),
      subscribe: () => () => {},
    },
    setDraft: (t) => window.__setDraft(t),
  };
  const actx = { get: (n) => (n === 'conversation' ? { input: { for: () => inputFace } } : undefined) };
  const sessionFace = {
    getSnapshot: () => ({ running: false }),
    subscribe: () => () => {},
    projections: { faceOf: () => store({}) },
  };
  const slotsFace = { register: () => () => {}, inject: () => () => {} };
  window.__writes = [];
  window.__effErr = null;
  const ctx = {
    get(n) {
      if (n === 'sessions') {
        return {
          list: store({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1' } } }),
          scope: () => actx,
          sessionOf: () => sessionFace,
        };
      }
      if (n === 'remote') {
        return {
          $on: () => () => {},
          settings: {
            describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'suggest-ghost', revision: 1, value }] } }),
            mutate: async (ns, ops) => { window.__writes.push({ ns, ops }); return { ok: true }; },
          },
        };
      }
      if (n === 'locale') return store({ active: 'zh' });
      if (n === 'slots') return slotsFace;
      return undefined;
    },
    on: () => () => {},
    effect(fn) {
      try { const d = fn(); return typeof d === 'function' ? d : () => {}; }
      catch (e) { window.__effErr = String((e && e.stack) || e).slice(0, 600); return () => {}; }
    },
    inject: () => () => {},
    slots: slotsFace,
  };
  let threw = null;
  try { globalThis.__SG.apply(ctx); }
  catch (e) { threw = String((e && e.stack) || e).slice(0, 800); }
  return { threw, effectErr: window.__effErr };
})()`;

/**
 * 派发一次真 keydown 并读三条判据。
 *
 * 探针监听器**挂在 target 元素上、在 apply 之后注册** —— 这正是判据 ② 要的形状：
 * 只有 `stopPropagation()` 没被调用，它才收得到。**不读 `cancelBubble`**（已废弃，
 * 读不到 stopPropagation 的效果）。
 */
INJECTS.press = (spec) => `(async () => {
  const ed = document.querySelector('#probe-composer');
  if (ed === null) return { missingComposer: true };
  const before = window.__writes.length;
  let probeHits = 0;
  const probe = () => { probeHits += 1; };
  ed.addEventListener('keydown', probe);
  const event = new KeyboardEvent('keydown', ${JSON.stringify(spec)});
  const dispatchReturned = ed.dispatchEvent(event);
  ed.removeEventListener('keydown', probe);
  // writeOps 走 **异步写队列**（OpsWriteQueue）：同步读 __writes 会读到「还没发」，
  // 与「没发出」同形 —— 那会把 llm 的 regen op 误判成缺失。等一拍再读（队列串行，
  // 一次 tick 足够落地；给到 50ms 余量，不靠猜）。
  for (let k = 0; k < 50 && window.__writes.length === before; k += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const overlay = document.querySelector('#dsh-suggest-ghost-overlay');
  const writes = window.__writes.slice(before);
  return {
    defaultPrevented: event.defaultPrevented,
    probeHits,
    dispatchReturned,
    writes,
    ghostText: overlay === null ? null : overlay.textContent,
    ghostShown: overlay === null ? null : overlay.dataset.shown,
    regenOps: writes
      .flatMap((w) => (Array.isArray(w.ops) ? w.ops : []))
      .map((op) => JSON.parse((op && op.value) || '{}'))
      .flatMap((body) => (Array.isArray(body.ops) ? body.ops.map((o) => o && o.op) : []))
      .filter((op) => op === 'regen'),
  };
})()`;

/**
 * 装一组「旁观者」监听器，观察**放行之后**这个键还有没有别人吞。
 *
 * 这是 issue 成本段那条「某些宿主组合上 Alt+G 会落到浏览器/系统的原生动作上」在
 * **DOM 层**能取到的全部证据：
 *  - `downAtDocument` / `upAtDocument`：冒泡到 document 时还在不在传播（= 有没有
 *    下游处理器再调 `stopPropagation`）；
 *  - `preventedByOther`：除本插件外**任何**处理器在 keydown/keyup 上是否
 *    `preventDefault` 了它（本插件已证明自己不碰事件，所以这里非 0 就说明有别家）；
 *  - `menuish`：有没有冒出 `contextmenu` / `popup` 这类与"菜单"有关的事件。
 *
 * ⚠️ 它测不到的部分（**必须写清，否则就是把没验到说成验过**）：浏览器的原生菜单
 * （如 Chromium 的 Alt 唤出菜单栏、或操作系统的全局快捷键）是**浏览器的 chrome 层
 * 与操作系统**的行为，不是 DOM 事件。而且**合成事件（`dispatchEvent`）的
 * `isTrusted === false`，永远不会触发原生动作** —— 实测见 PR。所以这条断言只能
 * 证明「DOM 层没有别人再拦它」，不能证明「原生层没有副作用」。
 */
INJECTS.observePassThrough = `(() => {
  window.__watch = { downAtDocument: 0, upAtDocument: 0, preventedByOther: [], menuish: [], anyKeydown: 0, identity: [], capWindow: 0 };
  const w = window.__watch;
  // 冒泡到 document 的旁观监听器（bubble 阶段、最后才跑）：能跑到这里 ⇒ 没被下游 stopPropagation。
  document.addEventListener('keydown', (ev) => {
    w.anyKeydown += 1;
    w.identity.push(ev.code + ':trusted=' + String(ev.isTrusted));
    if (ev.code !== 'KeyG') return;
    w.downAtDocument += 1;
    if (ev.defaultPrevented) w.preventedByOther.push('keydown:prevented');
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.code !== 'KeyG') return;
    w.upAtDocument += 1;
    if (ev.defaultPrevented) w.preventedByOther.push('keyup:prevented');
  });
  // 捕获阶段也挂一份：用来区分「事件没到页面」与「到了但冒泡被拦」（§8：没输出≠成功）。
  window.addEventListener('keydown', (ev) => { w.capWindow += 1; w.identity.push('cap:' + ev.code + ':trusted=' + String(ev.isTrusted) + ':tgt=' + (ev.target && (ev.target.id || ev.target.tagName))); }, true);
  for (const t of ['contextmenu', 'popup', 'popupmenus']) {
    document.addEventListener(t, () => { w.menuish.push(t); });
  }
  return true;
})()`;

/** 读旁观者监听器的读数（不重置：多轮观察可以累加后自行取差）。 */
INJECTS.readWatch = `(() => JSON.parse(JSON.stringify(window.__watch)))()`;

/** 清空旁观者读数（每轮观察前调一次，保证读数是**这一轮**的）。 */
INJECTS.resetWatch = `(() => {
  window.__watch = { downAtDocument: 0, upAtDocument: 0, preventedByOther: [], menuish: [], anyKeydown: 0, identity: [], capWindow: 0 };
  return true;
})()`;

/**
 * 用 CDP 发一次**受信任**按键（`isTrusted === true`）。
 *
 * 与 `INJECTS.press` 的区别：`dispatchEvent` 造的事件 `isTrusted === false`，
 * **永远不会**触发原生默认动作；只有这条路径才是"用户真的按了"。它由 Node 侧
 * 组合 `Input.dispatchKeyEvent`，页内只负责读结果，所以这里只留读数的注入体。
 */
INJECTS.readTrustedProbe = `(() => {
  const ed = document.querySelector('#probe-composer');
  return {
    composerText: ed === null ? null : ed.textContent,
    watch: JSON.parse(JSON.stringify(window.__watch)),
    overlayShown: (() => {
      const o = document.querySelector('#dsh-suggest-ghost-overlay');
      return o === null ? null : o.dataset.shown;
    })(),
  };
})()`;

/** 读 trace 通道：留痕走 console.debug/warn/info，**不只挂 console.log**（§6 通道那条）。 */
INJECTS.installTraceCapture = `(() => {
  window.__traces = [];
  const tap = (orig) => function (...args) {
    try { window.__traces.push(args.map((a) => typeof a === 'string' ? a : String(a)).join(' ')); }
    catch { /* 捕获失败不影响原调用 */ }
    return orig.apply(this, args);
  };
  for (const level of ['log', 'info', 'warn', 'debug', 'error']) {
    console[level] = tap(console[level]);
  }
  return true;
})()`;

// 语法检查：把每个注入体当成一个表达式求语法（不求值）。
const syntaxErrors = [];
for (const [name, build] of Object.entries(INJECTS)) {
  const sample = build instanceof Function
    ? build(name === 'apply' ? {} : name === 'press' ? {} : '/*bundle*/')
    : build;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${sample});`);
  } catch (error) {
    syntaxErrors.push(`${name}: ${String(error && error.message)}`);
  }
}
if (syntaxErrors.length > 0) {
  console.log('✗ 页内注入体语法检查未通过（这不是"断言变红"，是脚本自己坏了）：');
  for (const line of syntaxErrors) console.log(`    ${line}`);
  process.exit(3);
}
if (CHECK_ONLY) {
  console.log(`✅ 页内注入体语法检查通过（${Object.keys(INJECTS).length} 个）`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// §8 自检：证明这道语法闸是活的（空闸会被这里抓住）
// ═══════════════════════════════════════════════════════════════════════════
if (SELF_TEST) {
  console.log('\n—— §8 自检：语法闸本身是否活着 ——');
  const brokenBodies = [
    { label: '多余的反引号（模板串提前闭合）', body: '(() => { const s = `a`b`; return s; })()' },
    { label: '括号不配对', body: '(() => { return (1; })()' },
  ];
  let detected = 0;
  for (const { label, body } of brokenBodies) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (${body});`);
      console.log(`  ✗ 没抓住：${label}（语法闸是空的）`);
      failed += 1;
    } catch {
      console.log(`  ✓ 抓住了：${label}`);
      detected += 1;
      passed += 1;
    }
  }
  // 反向：合法注入体不得被误判。
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${INJECTS.host('hel')});`);
    console.log('  ✓ 合法注入体没被误判');
    passed += 1;
  } catch {
    console.log('  ✗ 合法注入体被误判成语法错（闸太严）');
    failed += 1;
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} 自检：语法闸抓到 ${detected}/${brokenBodies.length} 个坏样本`);
  process.exit(failed === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 前置检查：缺什么就明确 NOT-COVERED（§5），不许静默跳过
// ═══════════════════════════════════════════════════════════════════════════
if (!existsSync(BUNDLE)) {
  console.log(`⚠️  NOT-COVERED：缺构建产物 ${BUNDLE}`);
  console.log('    先跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs');
  console.log('    （§3：冒烟导入的是 lib/，测 src/ 改动必须重建产物，否则测的是旧字节码）');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.log(`⚠️  NOT-COVERED：缺浏览器 ${CHROME}`);
  console.log('    用 CHROME_BIN=<chrome 可执行文件> 指定，或安装 playwright chromium。');
  process.exit(2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 最小 CDP 客户端（Node 自带 WebSocket，零依赖）
// ═══════════════════════════════════════════════════════════════════════════
const cdp = async () => {
  const dir = join(tmpdir(), `sg-regen-key-${Date.now()}`);
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
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    }
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
      throw new Error(`页内异常：${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    }
    // `send()` 已拆掉外层 {result, exceptionDetails} ⇒ 值在 r.result.value。
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const close = () => {
    try { ws.close(); } catch { /* noop */ }
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  return { evaluate, close, send, pageErrors };
};

// localStorage 需要**可信 origin**：about:blank 的 origin 是 opaque，读它直接 SecurityError
// （实测：SecurityError: Failed to read the 'localStorage' property ... Access is denied）。
const originServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head></head><body></body></html>');
});
await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve));
const originUrl = `http://127.0.0.1:${originServer.address().port}/`;

// ═══════════════════════════════════════════════════════════════════════════
// bundle 改写：--inject-legacy 在**页内副本**上还原旧写法（磁盘产物不动）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 注入锚点：**从产物里读出来的真实末项**，不是硬编码一个"应该长这样"的字符串。
 *
 * §6 那条教训：锚点写错时字符串替换是**空操作**，`git commit` 照样通过、读数照样"全绿"。
 * 所以这里三步都做：
 *  1. 锚点从 bundle 里按正则找（esbuild 产物用双引号、`void 0`，与源码形态不同）；
 *  2. 命中次数必须**恰好 1**，否则判脚本漂移并退出 3；
 *  3. 改写后必须**逐字变了**（空操作同样退出 3）。
 */
const REGEN_BLOCK = /if \(settings\.regenEnabled && specMatches\(facts, settings\.regenKey\) && content\.kind !== "llm"\) \{\s*\n\s*traceOnce\("regen-skipped", "not-llm", ` kind=\$\{content\.kind\}`\);\s*\n\s*\}/;
// ⚠️ 锚点随本单搬了位置，**判据没变**：旧实现把「形态判定 + 吞键」挤在 regen 支里，
// 现在键位归谁由 `keyspec.ts` 的 `ownerOfKey` 一次判完，非 llm 形态的 regen 键根本不在表里，
// 于是这条留痕搬到 `owner === null` 的诊断支。锚点跟着搬——
// 吞键与留痕必须**分居两支**，正是这条单要保住的东西。

const legacyInjectedBundle = (raw, mode) => {
  const matches = raw.match(new RegExp(REGEN_BLOCK.source, 'g'));
  const hits = matches === null ? 0 : matches.length;
  if (hits !== 1) {
    throw new Error(
      `bundle 里 regen 诊断支（留痕那块）命中 ${hits} 次（期望 1 次）：`
      + '产物形状已漂移，--inject-legacy 的改写会变成空操作，故拒绝继续');
  }
  const byMode = {
    // 历史 bug 形态：在**诊断支**里就吞键（什么都不做，还把键扣下）。
    // 期望红：A 段 ①（defaultPrevented）与 ②′（dispatchEvent 返回 true）。
    'swallow-first': () => raw.replace(REGEN_BLOCK, `if (settings.regenEnabled && specMatches(facts, settings.regenKey) && content.kind !== "llm") {
          event.preventDefault();
          event.stopPropagation();
          traceOnce("regen-skipped", "not-llm", \` kind=\${content.kind}\`);
        }`),
    // issue 里写的退路：只 preventDefault、不 stopPropagation ⇒ ①/②′ 红。
    'stop-prop-only': () => raw.replace(REGEN_BLOCK, `if (settings.regenEnabled && specMatches(facts, settings.regenKey) && content.kind !== "llm") {
          event.preventDefault();
          traceOnce("regen-skipped", "not-llm", \` kind=\${content.kind}\`);
        }`),
    // 只摘留痕：证 ④ 这条「唯一观测面」断言是活的（其余判据应全绿）。
    'no-trace': () => raw.replace(REGEN_BLOCK, `if (false) {
        }`),
    // 本单新增：**把形态闸从键位表里摘掉**（regen 无差别进表）。
    // 这不再是吞键问题，而是让 `regenKey=Tab` 重新挡死历史/续写的采纳。
    // 期望红：`scripts/accept-key-smoke.mjs` 的「回归（#1.4-3）」那条；本脚本 A/B 段照旧绿
    // （A/B 只按 Alt+G，两种形态下都仍然没有 regen 动作）⇒ 由 keybinding-regression 那条链跑。
    'regen-any-kind': () => raw.replace(
      'if (input.kind === "llm" && input.regenEnabled !== false)',
      'if (input.regenEnabled !== false)'),
  };
  const apply = byMode[mode];
  if (apply === undefined) {
    throw new Error(`未知的 --inject-legacy 模式：${mode}（可用 ${Object.keys(byMode).join(' / ')}）`);
  }
  return apply();
};

// ═══════════════════════════════════════════════════════════════════════════
// 用例
// ═══════════════════════════════════════════════════════════════════════════

/** 宿主设置文档：history 形态（`_hot.history` 带当前会话的历史环）。 */
const HISTORY_DOC = {
  _push: JSON.stringify({ suggestion: null, suggestionSessionId: null }),
  _hot: JSON.stringify({ history: ['hello world'], historySessionId: 'sess-1', hot: [] }),
  historyEnabled: true,
  historyMinChars: 2,
  inlineEnabled: false,
  regenEnabled: true,
  regenKey: 'Alt+G',
};

/** 宿主设置文档：llm 形态（`_push.suggestion` 有正文，空草稿 ⇒ 落 LLM 支）。 */
const LLM_DOC = {
  _push: JSON.stringify({
    suggestion: { text: 'hello world from llm', turn: 1, frame: 1, final: true },
    suggestionSessionId: 'sess-1',
    history: [],
    historySessionId: 'sess-1',
  }),
  historyEnabled: true,
  inlineEnabled: false,
  regenEnabled: true,
  regenKey: 'Alt+G',
};

const ALT_G = { key: 'g', code: 'KeyG', altKey: true, bubbles: true, cancelable: true };

const bundleRaw = readFileSync(BUNDLE, 'utf8');
const MARKER = '\t\treturn module.exports;';
const markerHits = bundleRaw.split(MARKER).length - 1;
if (markerHits !== 1) {
  console.log(`✗ bundle 的 factory 收尾标记出现 ${markerHits} 次（期望 1 次）：注入点已漂移（脚本问题，不是用例红）`);
  process.exit(3);
}

let injectedBundle = bundleRaw;
if (MODE_INJECT !== null) {
  try {
    injectedBundle = legacyInjectedBundle(bundleRaw, MODE_INJECT);
  } catch (error) {
    console.log(`✗ --inject-legacy 失败：${String(error && error.message)}`);
    process.exit(3);
  }
  // 改写后**必须真的变了**：锚点写错的字符串替换是空操作（§6 明确点过这条）。
  if (injectedBundle === bundleRaw) {
    console.log('✗ --inject-legacy 是空操作（bundle 逐字未变）：注入无效，这一轮读数没有意义');
    process.exit(3);
  }
  console.log(`\n⚠️  注入模式：--inject-legacy ${MODE_INJECT}（页内副本已改写，磁盘产物未动）`);
}

const boot = async (settingsDoc, label, draft = 'hel') => {
  const client = await cdp();
  await client.send('Page.navigate', { url: originUrl });
  for (let k = 0; k < 100; k += 1) {
    const ready = await client.evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(50);
  }
  // 在**页内副本**的 factory 收尾前插一行导出标记：注入点在 factory 作用域内部，
  // 所以 `apply` 拿到的仍是它原本那套模块级常量；磁盘上的 lib/client.js 一字未改。
  const markedBundle = injectedBundle.replace(MARKER, `\t\tglobalThis.__SG = module.exports;\n${MARKER}`);
  const loadResult = await client.evaluate(INJECTS.load(markedBundle));
  if (loadResult !== 'ok') throw new Error(`bundle 注入失败（${label}）：${loadResult}`);
  await client.evaluate(INJECTS.installTraceCapture);
  const hostResult = await client.evaluate(INJECTS.host(draft));
  if (hostResult?.focused !== true) throw new Error(`宿主 DOM 构造后编辑器未获得焦点（${label}）`);
  const applied = await client.evaluate(INJECTS.apply(settingsDoc, draft));
  if (applied?.threw) throw new Error(`apply() 抛错（${label}）：${applied.threw}`);
  if (applied?.effectErr) throw new Error(`apply() 内 effect 抛错（${label}）：${applied.effectErr}`);
  // applySettings 是异步的（describe → 解析 → render）：等幽灵真的上屏再按键。
  let shown = null;
  for (let k = 0; k < 60; k += 1) {
    shown = await client.evaluate("(() => { const o = document.querySelector('#dsh-suggest-ghost-overlay'); return o === null ? null : { text: o.textContent, shown: o.dataset.shown, display: o.style.display }; })()");
    if (shown !== null && shown.shown === '1' && shown.display === 'block') break;
    await sleep(50);
  }
  return { client, shown };
};

const main = async () => {
  console.log('\n—— A. history 形态按 `Alt+G`：不得吞键（Gitea #168 主判据）——');
  const history = await boot(HISTORY_DOC, 'history');
  try {
    // 先证明"幽灵真的在屏幕上"——否则下面的按键读到的是"shown===null 早退"，
    // 与"非 llm 分支不吞键"同形（那会是假绿）。
    check('history 幽灵已在屏（前置：否则按键被 `shown===null` 早退，判据不成立）',
      history.shown !== null && history.shown.shown === '1' && history.shown.display === 'block',
      JSON.stringify(history.shown));

    const pressed = await history.client.evaluate(INJECTS.press(ALT_G));
    check('① `event.defaultPrevented === false`（键没有被吞）',
      pressed.defaultPrevented === false, `defaultPrevented=${String(pressed.defaultPrevented)}`);
    check('② 事件仍能到达其后注册的探针监听器（>0 次）',
      pressed.probeHits > 0, `probeHits=${String(pressed.probeHits)}`);
    check('②′ `dispatchEvent` 返回 true（未被 `cancelable` 事件的 preventDefault 拦下）',
      pressed.dispatchReturned === true, `dispatchReturned=${String(pressed.dispatchReturned)}`);
    check('③ 没有 regen op 写出（writeOps 侧）',
      pressed.regenOps.length === 0,
      `regenOps=${JSON.stringify(pressed.regenOps)} writes=${JSON.stringify(pressed.writes).slice(0, 300)}`);
    check('④ `regen-skipped`/`not-llm` 留痕仍在（这一支唯一的观测面）',
      true, '（在下方 trace 断言里读）');

    const traces = await history.client.evaluate('window.__traces');
    const skipLine = (traces ?? []).find((line) => line.includes('regen-skipped') && line.includes('not-llm'));
    check('④ `regen-skipped reason=not-llm kind=history` 真的打出来了',
      skipLine !== undefined, `traces=${JSON.stringify((traces ?? []).filter((l) => l.includes('regen-skipped')))}`);
    check('⑤ 幽灵没被这一下按键弄掉（非 llm 只是放行，不改显示）',
      pressed.ghostShown === '1' && pressed.ghostText === history.shown?.text,
      `after=${JSON.stringify({ text: pressed.ghostText, shown: pressed.ghostShown })} before=${JSON.stringify(history.shown?.text)}`);

    // ── ⑥ 放行之后「原生动作面」在 DOM 层能取到的证据 ────────────────────────
    //
    // issue 成本段担心的是「放行后 Alt+G 落到浏览器 / 系统的原生动作上」。这条在
    // **这套量具里能测到多少、不能测到多少**，必须分开说，否则就是把没验到写成通过：
    //
    //  **测不到**：浏览器 chrome 层（Alt 唤出菜单栏）与操作系统全局快捷键不是 DOM 事件。
    //   而且 `dispatchEvent` 造的合成事件 `isTrusted === false`（实测），
    //   **永远不会**触发原生动作 —— 所以 ①–⑤ 那一轮证明不了原生层没副作用。
    //
    //  **测得到**（这一节）：用 CDP `Input.dispatchKeyEvent`（受信任路径，实测
    //   `isTrusted === true`）发一次真 Alt+G，读旁观者监听器：
    //     a) 按键是否真的送达页面（捕获阶段计数器）——**送达失败不是"没被拦"**；
    //     b) 送达时是否仍在传播（冒泡到 document）；
    //     c) 送达时除本插件外有没有别的 DOM 处理器 preventDefault 它；
    //     d) 有没有冒出 contextmenu / popup 这类菜单相关事件。
    //
    // ⚠️ 实测教训（写下来免得下一个人重踩）：**headless Chromium 在装载了真实 bundle
    // 的页面上，受信任 Alt+G 的投递不稳定** —— 本夹具里第一次可达、之后多次为 0；
    // 而同一套 CDP 调用在空白页上稳定可达。所以送达失败时必须报 **NOT-COVERED**
    // （退出码 2），不能报 FAIL（那会把环境问题说成缺陷），更不能报 PASS（没验到）。
    await history.client.evaluate(INJECTS.observePassThrough);
    await history.client.evaluate(INJECTS.resetWatch);
    // 真按 Alt → 按 G → 松开：比"只给 G 挂 modifiers"更接近真实键盘序列。
    await history.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 1, key: 'Alt', code: 'AltLeft',
      windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
    });
    await sleep(60);
    await history.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 1, key: 'g', code: 'KeyG',
      windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71,
    });
    await sleep(120);
    await history.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 1, key: 'g', code: 'KeyG',
      windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71,
    });
    await history.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 0, key: 'Alt', code: 'AltLeft',
      windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
    });
    await sleep(150);
    const trusted = await history.client.evaluate(INJECTS.readTrustedProbe);
    const watch = trusted?.watch ?? {};
    const delivered = (watch.capWindow ?? 0) > 0;
    const detail = `capWindow=${String(watch.capWindow)} anyKeydown=${String(watch.anyKeydown)}`
      + ` downAtDocument=${String(watch.downAtDocument)}`
      + ` identity=${JSON.stringify(watch.identity)}`;

    if (!delivered) {
      // 送达失败：这三条**不作判定**，整体记 NOT-COVERED（不污染 PASS/FAIL 计数）。
      softNotCovered = `⑥ 受信任 Alt+G 没送达到页面（${detail}）`
        + ' —— headless Chromium 在装载真实 bundle 的页面上投递不稳定，'
        + '**不是**缺陷证据；⑥ 的「原生动作面」本轮未验。';
      console.log(`  ⚠️  NOT-COVERED：⑥ 受信任 Alt+G 没送达到页面（${detail}）`);
      console.log('      这不计入 ✓/✗：送达失败既不是通过也不是失败。');
    } else {
      check('⑥ 受信任 Alt+G：keydown 冒泡到 document（没被下游 stopPropagation）',
        (watch.downAtDocument ?? 0) > 0, detail);
      check('⑥ 受信任 Alt+G：除本插件外没有别的 DOM 处理器 preventDefault 它',
        Array.isArray(watch.preventedByOther) && watch.preventedByOther.length === 0,
        `preventedByOther=${JSON.stringify(watch.preventedByOther)}`);
      check('⑥ 受信任 Alt+G：没有冒出 contextmenu / popup 这类菜单相关事件',
        Array.isArray(watch.menuish) && watch.menuish.length === 0,
        `menuish=${JSON.stringify(watch.menuish)}`);
      check('⑥ 受信任 Alt+G 之后幽灵仍在屏（放行不改显示）',
        trusted?.overlayShown === '1', `overlayShown=${String(trusted?.overlayShown)}`);
    }
  } finally {
    history.client.close();
  }

  console.log('\n—— B. llm 形态按 `Alt+G`：行为逐字不变（该吞就吞、该发就发）——');
  // llm 形态只在**空草稿**上可达（#129 的形态判据）：传空草稿，否则这条用例测的是 history。
  const llm = await boot(LLM_DOC, 'llm', '');
  try {
    check('llm 幽灵已在屏（前置）',
      llm.shown !== null && llm.shown.shown === '1', JSON.stringify(llm.shown));
    const pressed = await llm.client.evaluate(INJECTS.press(ALT_G));
    check('llm：`defaultPrevented === true`（吞键，与改动前一致）',
      pressed.defaultPrevented === true, `defaultPrevented=${String(pressed.defaultPrevented)}`);
    // ⚠️ 合并 #166 后本条改口径，**不是放宽**，是判据换了依赖：
    //
    // #168 单条时本处理器在 window **捕获**段，`stopPropagation()` 能挡住挂在
    // target 上的探针 ⇒ 「收不到」等价于「stopPropagation 生效」。
    // #166 把 keydown 迁到 window **冒泡**段后，本处理器是**最后**跑的：探针（target 段）
    // 早在本处理器之前就已经收到事件，此时再 `stopPropagation()` 也拦不住它 ——
    // 「探针收不到」不再是「本插件吞了键」的必要条件，也永远不可能成立。
    //
    // `#168` 真正要钉的两件事在合并语义下改为：
    //   ① 事件**被本插件认领了**（`defaultPrevented === true`，上面那条已经钉住）；
    //   ② 动作**真的执行了**（恰好一条 regen op，下面那条所在）。
    // 探针计数在这里只作为**事实记录**打印，不参与判定 —— 拿它判定会把 #166 的正确
    // 迁移误报成回归（本冒烟实测踩到过：合并后 probeHits 由 0 变 1，其余全绿）。
    console.log(`      · llm 支探针计数 = ${String(pressed.probeHits)}`
      + `（#166 迁移到冒泡后本处理器最后跑，探针必先收到；此数仅记录，不参与判定）`);
    check('llm：确实发出了 **一条** regen op（动作照旧）',
      pressed.regenOps.length === 1, `regenOps=${JSON.stringify(pressed.regenOps)}`);

    const traces = await llm.client.evaluate('window.__traces');
    const llmSkip = (traces ?? []).find((line) => line.includes('regen-skipped'));
    check('llm：不得出现 `regen-skipped`（那一支不该走到）',
      llmSkip === undefined, `traces=${JSON.stringify(llmSkip ?? null)}`);
    const requested = (traces ?? []).find((line) => line.includes('regen-requested'));
    check('llm：`regen-requested` 留痕照旧',
      requested !== undefined, `traces=${JSON.stringify((traces ?? []).filter((l) => l.includes('regen-'))) }`);
  } finally {
    llm.client.close();
  }
};

try {
  await main();
} catch (error) {
  // 脚本/环境问题（浏览器崩、注入失败、apply 抛错）**不算用例红**：它是 NOT-COVERED，
  // 与「断言真的不成立」必须分开（§5：没验到的不得写成通过，也不得写成失败）。
  notCovered = String((error && error.stack) || error);
} finally {
  originServer.close();
}

if (notCovered !== null) {
  console.log(`\n⚠️  NOT-COVERED：${notCovered.slice(0, 600)}`);
  if (failed > 0) {
    // 已经有用例真的红了：**红的那些是结论**，未覆盖的是另一件事，两者一起报。
    console.log(`❌ regen-key: ${passed} 项通过 / ${failed} 项红；另有 1 处 NOT-COVERED（见上）`);
  } else {
    // 全部跑到的都绿，只有一处没验到 ⇒ 整体不能算通过（§5：没验到的不得写成通过）。
    console.log(`素材结论：已跑的 ${passed} 项全绿；但**有一处未覆盖 ⇒ 本条不计为 PASS**。`);
  }
  process.exit(2);
}

const injected = MODE_INJECT === null ? '' : `（注入模式：${MODE_INJECT}）`;
if (softNotCovered !== null) {
  console.log(`\n⚠️  NOT-COVERED（不影响主判据）：${softNotCovered.slice(0, 400)}`);
  console.log('    主判据（①–⑤、B 段）的结论照常有效；仅 ⑥「原生动作面」未被验证。');
}
const tail = softNotCovered === null ? '' : '（⑥ 未覆盖）';
console.log(`\n${failed === 0 ? '✅' : '❌'} regen-key${injected}: ${passed} 项通过 / ${failed} 项红${tail}`);
process.exit(failed === 0 ? 0 : 1);
