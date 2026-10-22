#!/usr/bin/env node
/**
 * 建议格读侧证伪（Gitea #54 的行为半边；task-15 的重点）。
 *
 * ## 要证伪的那句话
 *
 * 「一次**纯热度**变化不该让建议格重新解析、重跑帧判据、动帧台账、换建议对象引用。」
 * #36 建议 2 把 `_push` 拆成建议格 + `_hot` 之后，这是唯一还没被**行为侧**证过的收益。
 * 之前所有证据都是静态的（读代码、比字节数），静态证据能证明「代码长这样」，
 * 证明不了「跑起来真的走到那一支」。
 *
 * ## 为什么这套 harness 值得单独一个文件
 *
 * 它跑的是**真客户端**：`lib/client.js`（esbuild 打进 `window.__ModuleLoader__.load`
 * 的那份产物）在 node 里被加载，配上够用的最小 DOM/宿主替身，然后按 `settings/document-updated`
 * 的事件节律喂三格变更。所以它证伪的是产品字节码的行为，不是脚本里抄的一份逻辑。
 * 与 `ghost-frame-e2e.mjs`（纯函数 + 静态在场）互不替代：那一条测「值对不对、点还在不在」，
 * 这一条测「跑起来进的是哪个分支」。
 *
 * ## 不许用 `renderHits` 当证据（口径更正）
 *
 * 幽灵内容缓存的条件是 `(draft, settingsEpoch, composing, running, currentId)` 全等，
 * 而热度列表与历史环**本来就参与**候选排序（`computeGhostContent` 的 history 分支与打分），
 * 所以热度一变 ⇒ `configValuesEqual` 为假 ⇒ `settingsEpoch++` ⇒ 缓存失效 ⇒ 幽灵重算。
 * **那是语义上正确的行为**，不是缺陷。用它计数就会把「正确的重算」和「不该发生的重复解析」
 * 混成一团（lead 已在 #41 与 CHANGELOG 公开更正过那句高估）。
 * 因此本脚本只读 `pushCellStats`：四个计数器分别打在 `applySettings` 的四个**决策分支**上，
 * 想「顺手把计数加对」就必须改判据本身——这正是可证伪性的来源。
 *
 * ## 三档口径沿用（PASS / FAIL / NOT-COVERED）
 *
 * 「产物没构建」「客户端加载不起来」「场景喂不出真实差异」是三件不同的事，分开报，
 * 不许混成「捕获 0 行所以大概没实现」。
 *
 * 用法：`node scripts/ghost-frame-cell-e2e.mjs [--repo <dir>]`
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const i = argv.indexOf('--repo');
const repo = resolve(i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dirname(dirname(fileURLToPath(import.meta.url))));
const clientBundle = join(repo, 'lib', 'client.js');

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === STATUS.PASS ? '✅' : status === STATUS.FAIL ? '❌' : '⚪';
  console.log(`${mark} [${status}] ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 插件留痕捕获：`[ops-trace]` / `[suggest-ghost]` 两类行收进数组、**不再打到 stdout**
 * （否则报告里混着宿主噪声，看不出哪条是断言）。其它行照常输出。
 */
const traceLines = [];
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
/**
 * 两个通道都要接：`traceOps` 走 `console.log`（`src/index.ts:323`，宿主只有一个
 * logger exporter，info/debug 会被丢），而**客户端**的 `traceOnce` 走 `console.warn`
 * （`src/client/index.ts` 的留痕口径——浏览器控制台默认级别会滤掉 log）。
 * 第一版只接了 log，于是 `push-cell` 那行原样打到 stdout、`traceLines` 里一行没有，
 * 下面的隐私断言当场报 FAIL——这条断言真的抓到了 harness 自己的错，正是它该有的行为。
 */
const swallows = (line) => line.includes('[ops-trace]') || line.includes('[suggest-ghost]')
  || line.includes('[dsh-suggest-ghost]');
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (swallows(line)) traceLines.push(line); else realLog(line);
};
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (swallows(line)) traceLines.push(line); else realWarn(line);
};

console.log(`ghost-frame-cell-e2e：客户端产物 ${clientBundle}`);

// ── 0. 产物必须在场；不在就是 NOT-COVERED，不是 FAIL ───────────────────────
if (!existsSync(clientBundle)) {
  record('客户端产物就位（lib/client.js）', STATUS.NC,
    `缺前置：${clientBundle} 不存在。先在那棵树上跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`
    + '（worktree 里别用 pnpm：node_modules 是软链，pnpm 会报依赖错）');
  console.log('');
  console.log('汇总：NOT-COVERED 1（客户端产物没构建）');
  process.exit(0);
}

// ── 1. 最小宿主/浏览器替身：只实现客户端**真的会碰**的那几个成员 ──────────────
//
// 刻意不引 jsdom（任务约束「不许加依赖」），也刻意不做全：替身越薄，「客户端在跑」
// 这个结论越可信——因为一旦客户端想碰我没实现的东西，它会抛错而不是静默通过。
function makeElement() {
  const el = {
    style: { cssText: '', setProperty() {}, },
    dataset: {},
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    append(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    closest: () => null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    isContentEditable: false,
    textContent: '',
    firstElementChild: null,
    offsetParent: null,
    offsetTop: 0,
    offsetLeft: 0,
    clientWidth: 0,
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}

const documentStub = {
  createElement: () => makeElement(),
  head: makeElement(),
  body: makeElement(),
  // 输入框尚未挂载 → render() 会在这里早退。建议格的读侧计数发生在那之前，
  // 所以这不影响被验的东西（刻意保留这个「不做全」，而不是伪造一个 composer）。
  querySelector: () => null,
  querySelectorAll: () => [],
  getSelection: () => null,
  createTreeWalker: () => ({ nextNode: () => null }),
  createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) }),
  activeElement: null,
};
const windowStub = { addEventListener() {}, removeEventListener() {}, ResizeObserver: undefined };
const localStorageStub = { getItem: () => null, setItem() {}, removeItem() {} };

/** 加载真产物：`window.__ModuleLoader__.load(def)` → `def.factory(require)`。 */
function loadClient() {
  let definition = null;
  const loaderWindow = { ...windowStub, __ModuleLoader__: { load: (def) => { definition = def; } } };
  // 浏览器里这段代码由宿主 eval；这里给同样的顶层作用域（window/document/localStorage/…）。
  new Function('window', 'document', 'localStorage', 'getComputedStyle', 'ResizeObserver',
    readFileSync(clientBundle, 'utf8'))(
    loaderWindow, documentStub, localStorageStub,
    () => ({ getPropertyValue: () => '0px', paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px', borderTopWidth: '0px', borderLeftWidth: '0px', lineHeight: '20px' }),
    class { observe() {} disconnect() {} },
  );
  if (definition === null) throw new Error('lib/client.js 没有调 window.__ModuleLoader__.load');
  // 外部包（react / jsx-runtime / dsh-client-ui-primitives）只被设置卡片用，
  // 本 harness 刻意不注册卡片（ctx.get('slots') 给 undefined），所以这些替身不会被真读。
  const requireStub = (id) => ({ default: {}, Fragment: 'frag', jsx: () => null, jsxs: () => null });
  return { exports: definition.factory(requireStub), id: definition.id };
}

// ── 2. 假宿主 ctx：远程 settings 面（describe + $on + mutate）与最薄会话面 ────
function makeFakeHost() {
  /** 介质：suggest-ghost 那一节的 volatile 值，`_push` / `_hot` 各是一格。 */
  const doc = { _push: '', _hot: '', historyEnabled: true };
  let revision = 0;
  const listeners = [];
  const snapshot = { draft: '', draftRev: 4 };
  const sessionRow = { id: 's1', retainedBy: { mainView: 1 } };
  const sessionStore = {
    getSnapshot: () => ({ byId: { s1: sessionRow } }),
    subscribe: () => () => {},
  };
  const actx = { get: (name) => (name === 'conversation' ? conversationFace : undefined) };
  const conversationFace = {
    input: {
      for: () => ({
        state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
        setDraft: (t) => { snapshot.draft = t; snapshot.draftRev += 1; },
      }),
    },
  };
  const sessionsFace = {
    list: sessionStore,
    scope: () => actx,
    sessionOf: () => ({
      getSnapshot: () => ({ running: false }),
      subscribe: () => () => {},
      projections: { faceOf: () => ({ getSnapshot: () => null, subscribe: () => () => {} }) },
    }),
  };
  const remote = {
    settings: {
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [{ ns: 'suggest-ghost', revision, value: { ...doc } }],
        },
      }),
      mutate: async (ns, ops) => {
        // 落 `_ops`（客户端反向通道），revision 前进，返回**写后视图**当凭证
        // （`settleWriteVerdict` 认「载荷仍在盘上 / revision 已动」二者之一）。
        for (const op of ops) {
          if (op.op === 'set' && Array.isArray(op.path)) doc[op.path[0]] = op.value;
        }
        revision += 1;
        return { ok: true, value: { ns: 'suggest-ghost', revision, value: { ...doc } } };
      },
    },
    $on: (event, cb) => { if (event === 'settings/document-updated') listeners.push(cb); return () => {}; },
  };
  const ctx = {
    get: (name) => (name === 'sessions' ? sessionsFace : name === 'remote' ? remote
      : name === 'conversation' ? conversationFace : undefined),
    // `slots` 刻意不给 → 设置卡片不注册，本 harness 只跑幽灵那条链。
    on: () => () => {},
    effect: (fn) => (typeof fn === 'function' ? undefined : undefined),
    inject: () => {},
  };
  /** 喂一次格变更：写介质 → 推进 revision → 按内核节律 emit。 */
  const emit = (patch) => {
    Object.assign(doc, patch);
    revision += 1;
    for (const cb of listeners) cb('suggest-ghost', revision);
  };
  return { ctx, emit, getRevision: () => revision, doc };
}

const snapshotOf = (stats) => ({
  applies: stats.applies, parses: stats.parses, frameRuns: stats.frameRuns,
  cellSkips: stats.cellSkips, suggestionRefSwaps: stats.suggestionRefSwaps,
});
const delta = (before, after) => Object.fromEntries(
  Object.keys(after).map((k) => [k, after[k] - before[k]]));

// ── 3. 跑三场景 ───────────────────────────────────────────────────────────
const SUGGESTION_A = JSON.stringify({ suggestion: { version: 1, turn: 1, baseSeq: 3, text: '跑一下冒烟', truncated: false, acceptKey: 'Tab', frame: 1, final: true }, suggestionSessionId: 's1' });
const SUGGESTION_B = JSON.stringify({ suggestion: { version: 1, turn: 2, baseSeq: 9, text: '把构建脚本改一下', truncated: false, acceptKey: 'Tab', frame: 1, final: true }, suggestionSessionId: 's1' });
const HOT_1 = JSON.stringify({ hot: [{ text: '跑一下冒烟', count: 1 }], history: ['跑一下冒烟'], historySessionId: 's1' });
const HOT_2 = JSON.stringify({ hot: [{ text: '跑一下冒烟', count: 2 }, { text: '把构建脚本改一下', count: 1 }], history: ['跑一下冒烟', '把构建脚本改一下'], historySessionId: 's1' });
// 场景 4 用的第三份热度载荷：必须与 HOT_2 **不同**（否则 `_hot` 那格也没变，
// 就成了「什么都没变」而不是「只有热度变了」），但建议格仍逐字不动。
const HOT_3 = JSON.stringify({ hot: [{ text: '把构建脚本改一下', count: 3 }], history: ['跑一下冒烟', '把构建脚本改一下', '再来一轮'], historySessionId: 's1' });

let loaded = null;
try {
  loaded = loadClient();
} catch (error) {
  record('客户端产物可被加载（lib/client.js）', STATUS.FAIL,
    `加载抛错：${String(error).slice(0, 220)}\n`
    + '（这条不是 NOT-COVERED：产物在场却加载不起来，是这条链真的断了）');
}

if (loaded === null) {
  record('三个场景', STATUS.NC, '缺前置：客户端没能加载成功');
} else if (typeof loaded.exports.pushCellStats !== 'object' || loaded.exports.pushCellStats === null) {
  record('读侧计数器已导出（pushCellStats）', STATUS.NC,
    `缺前置：lib/client.js 的导出面=[${Object.keys(loaded.exports).join(', ')}]，`
    + '没有 pushCellStats。这条是**本任务要加的计数**，说明 --repo 指的树还没有它。');
} else {
  record('读侧计数器已导出（pushCellStats）', STATUS.PASS,
    `导出面=[${Object.keys(loaded.exports).join(', ')}]；插件 id=${loaded.id}\n`
    + '计数只增不减、没有「归零」口，因此下面每一场比的都是**差值**（before/after），'
    + '这样「自哪一次以来涨了多少」在调用方一侧永远是明确的。');

  const stats = loaded.exports.pushCellStats;
  const host = makeFakeHost();
  loaded.exports.apply(host.ctx);
  await sleep(30);  // 首读一次 applySettings（客户端启动即读）

  const scenarios = [
    {
      name: '场景 1 纯建议格变化（_push 变、_hot 不动）',
      patch: { _push: SUGGESTION_A },
      expect: { parses: 1, frameRuns: 1, cellSkips: 0, suggestionRefSwaps: 1 },
      why: '建议格原文变了 ⇒ 必须重新 parse、必须重跑帧判据、建议对象引用必须换',
    },
    {
      name: '场景 2 纯热度变化（_push 原文逐字不动、只有 _hot 变）',
      patch: { _hot: HOT_1 },
      expect: { parses: 0, frameRuns: 0, cellSkips: 1, suggestionRefSwaps: 0 },
      why: '这就是 #54 要证伪的那句话：热度变了但建议格没变 ⇒ 建议格**一行都不该重做**',
    },
    {
      name: '场景 3 两格都变（_push 与 _hot 同时换）',
      patch: { _push: SUGGESTION_B, _hot: HOT_2 },
      expect: { parses: 1, frameRuns: 1, cellSkips: 0, suggestionRefSwaps: 1 },
      why: '建议格又变了 ⇒ 计数必须重新动起来（证明场景 2 的「不动」不是计数器坏了）',
    },
    {
      name: '场景 4 热度再变一次（_hot 又换、_push 仍逐字不动）',
      patch: { _hot: HOT_3 },
      expect: { parses: 0, frameRuns: 0, cellSkips: 1, suggestionRefSwaps: 0 },
      why: '场景 2 的重复确认：第一次「不动」可能是巧合，第二次仍不动才叫行为',
    },
  ];
  for (const scenario of scenarios) {
    const before = snapshotOf(stats);
    host.emit(scenario.patch);
    await sleep(30);  // applySettings 是 async：describe() 一拍、render 一拍
    const after = snapshotOf(stats);
    const got = delta(before, after);
    const bad = Object.entries(scenario.expect).filter(([k]) => got[k] !== scenario.expect[k])
      .map(([k, e]) => `${k}=${String(got[k])}（期望 ${e}）`);
    record(scenario.name, bad.length === 0 ? STATUS.PASS : STATUS.FAIL,
      `期望增量 ${JSON.stringify(scenario.expect)}\n`
      + `实际增量 ${JSON.stringify(got)}\n`
      + `累计计数 ${JSON.stringify(after)}\n`
      + `判据依据：${scenario.why}`
      + (bad.length > 0 ? `\n     不符：${bad.join('; ')}` : ''));
  }

  // 场景 2/4 的「不增加」只有在**建议格确实还带着建议**时才有意义：
  // 如果建议格从头就是空的，跳过解析等于什么都没跳过。
  // ── 场景 5：高频**纯热度**变化（连打 20 次）—— 计数不线性疯涨 + 事件循环不饿死 ──
  //
  // ## 覆盖边界（必须与断言一起读，别只读标题）
  //  **本场景 5b 覆盖的是「客户端读侧」**：喂的是内存 settings 面、假 `mutate` 刻意不 emit，
  //  所以宿主写侧那条 `.finally` 微任务链结构上照不到它。「写被拒 ⇒ 立刻重排 ⇒ 微任务紧循环」
  //  那一类回归由 `scripts/hmr-write-loop-smoke.mjs` 覆盖（事故见 88ee440：一拍 398 次、
  //  tee 日志 23 GB）。两条合起来才叫「读侧不疯涨 + 写侧不饿死」。
  //
  // 为什么单独加这一场（lead 提醒，来自主仓那条已落地热修的实况）：护栏注释写着
  // 「热度格被拒 → 在 `.finally` 里立刻再 flush → 退化成『失败→重排→再写』的微任务紧循环
  // → 永远不把控制权交还事件循环」。也就是说这条路径**确实存在**，而且它落在 `_hot` 那一格上。
  // 于是这一场同时要证两件事：
  //  1. **计数与输入次数成线性但斜率落在 cellSkips 上**：`parses` / `frameRuns` /
  //     `suggestionRefSwaps` 必须**一个都不涨**。它们若涨，说明「跳过建议格」那条判据
  //     在某条高频路径上失效了——那是重复解析，不是节流没生效。
  //  2. **事件循环还活着**：整个连打过程中，宏任务探针必须照常按时回来。微任务紧循环
  //     的典型表现就是「同步代码一直交还不了控制权 ⇒ 定时器排不上」。这一条把
  //     「疯涨」与「饿死」分开报：前者是计数问题，后者是循环问题。
  const BURST = 20;
  // 交替两份**互不相同**的热度载荷：每次都让 `_hot` 真的变，否则就成了「什么都没变」
  // 而不是「只有热度变了」，那场就没意义了。
  const HOT_ALT = [HOT_3, JSON.stringify({ hot: [{ text: '换个说法', count: 1 }], history: ['跑一下冒烟'], historySessionId: 's1' })];
  const beforeBurst = snapshotOf(stats);
  const probeDelays = [];
  let probeFired = 0;
  for (let n = 0; n < BURST; n += 1) {
    host.emit({ _hot: HOT_ALT[n % 2] });
    // 宏任务探针：`setTimeout(0)` 排在事件队列上，微任务紧循环会把它一直挤在后面。
    const started = Date.now();
    await new Promise((r) => setTimeout(() => { probeFired += 1; r(); }, 0));
    probeDelays.push(Date.now() - started);
  }
  await sleep(30);
  const burstDelta = delta(beforeBurst, snapshotOf(stats));
  const worstProbe = probeDelays.length > 0 ? Math.max(...probeDelays) : -1;
  const burstBad = [];
  if (burstDelta.parses !== 0) burstBad.push(`parses=${burstDelta.parses}（期望 0）`);
  if (burstDelta.frameRuns !== 0) burstBad.push(`frameRuns=${burstDelta.frameRuns}（期望 0）`);
  if (burstDelta.suggestionRefSwaps !== 0) burstBad.push(`suggestionRefSwaps=${burstDelta.suggestionRefSwaps}（期望 0）`);
  if (burstDelta.applies !== BURST) burstBad.push(`applies=${burstDelta.applies}（期望 ${BURST}：每发一次都要真的被处理一次）`);
  record(`场景 5 高频纯热度变化 ×${BURST}：建议格计数不涨（读侧没被高频路径打穿）`,
    burstBad.length === 0 ? STATUS.PASS : STATUS.FAIL,
    `期望增量 {applies:${BURST}, parses:0, frameRuns:0, suggestionRefSwaps:0}\n`
    + `实际增量 ${JSON.stringify(burstDelta)}\n`
    + `累计计数 ${JSON.stringify(snapshotOf(stats))}\n`
    + (burstBad.length === 0 ? '' : `不符：${burstBad.join('; ')}`));

  record(`场景 5b 事件循环未被饿死（${BURST} 个 setTimeout(0) 宏任务探针全部按时回来）`,
    probeFired === BURST && worstProbe <= 200 ? STATUS.PASS : STATUS.FAIL,
    `探针回来 ${probeFired}/${BURST} 个；最迟一个等了 ${worstProbe}ms（阈值 200ms）\n`
    + '判据依据：微任务紧循环（`.finally` 里立刻重排写）的表现就是定时器排不上队；'
    + '探针全数按时回来 ⇒ 每一发热度变更都把控制权交还了事件循环。\n'
    + '（这条只证「本次连打过程中**客户端读侧**循环没被挤死」，不证所有路径都不紧循环——'
    + '宿主写侧那条 `.finally` 微任务链由 scripts/hmr-write-loop-smoke.mjs 覆盖，'
    + '本 harness 喂内存 settings 面、假 mutate 不 emit，结构上照不到它。）');

  const sanity = stats.applies >= 5 + BURST;
  record(`前置自检：客户端真的收到并处理了每一次格变更（applies ≥ ${5 + BURST}）`,
    sanity ? STATUS.PASS : STATUS.FAIL,
    `实际 applies=${String(stats.applies)}（首读 1 次 + 四个场景各 1 次 + 高频 20 次）；`
    + '若这一条不成立，上面四场的「不增加」就只是「事件没送到」的同义词');

  // 留痕口径自检：新加的那行**按理由变化才打**，且只打次数与理由、不打正文。
  const cellLines = traceLines.filter((l) => l.includes(' push-cell:'));
  const reasons = [...new Set(cellLines.map((l) => (/reason=([a-z-]+)/.exec(l) ?? [, ''])[1]))];
  const leaked = [SUGGESTION_A, SUGGESTION_B].some((payload) => {
    const text = JSON.parse(payload).suggestion.text;
    return cellLines.some((l) => l.includes(text));
  });
  const countsOnly = cellLines.every((l) => /parses=\d+ frameRuns=\d+ cellSkips=\d+ applies=\d+/.test(l));
  if (cellLines.length === 0) {
    record('留痕口径：push-cell 那行的字面（按理由变化 + 只打次数）', STATUS.FAIL,
      '一行都没打，但计数器动了 ⇒ 说明接线漏了留痕（不是「没跑到」，因为 applies/parses 增量已验证分支被执行）');
  } else {
    record('留痕口径：push-cell 那行的字面（按理由变化 + 只打次数）',
      reasons.length === 2 && !leaked && countsOnly ? STATUS.PASS : STATUS.FAIL,
      `捕获 ${cellLines.length} 行：${cellLines.join(' | ')}`
      + `\n期望：reason 恰好两种（suggestion-cell-changed / hot-cell-only）、不含任何建议正文、字段只有四个计数`
      + `\n实际：reasons=[${reasons.join(', ')}] 含正文=${leaked} 计数格式对=${countsOnly}`
      + `\n（行数少于场景数是**对的**：闸门按理由变化才打，两个 hot-only 场景共用一行）`);
  }
}

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
console.log('');
console.log(`汇总：PASS ${counts[STATUS.PASS] ?? 0} · FAIL ${counts[STATUS.FAIL] ?? 0} · NOT-COVERED ${counts[STATUS.NC] ?? 0}`);
for (const r of results) console.log(`  ${r.status.padEnd(11)} ${r.name}`);
console.log('');
console.log('退出码只看 FAIL：NOT-COVERED 是「没验到」，不是「验到了不通过」。');
process.exit(results.some((r) => r.status === STATUS.FAIL) ? 1 : 0);
