#!/usr/bin/env node
/**
 * LLM 形态可达性冒烟（Gitea #129）。
 *
 * ## 要闭合的现象
 * `computeGhostContent`（`src/client/index.ts`）按分支顺序判三模式：续写 → 历史补全 → LLM 建议。
 * 「非空草稿不会落到 LLM 支」过去**只靠隐式顺序**兜住：历史支的进入条件是
 * `historyEnabled && 非空草稿`，且它内部每条路都 `return`。于是把设置里的「启用历史补全」
 * 关掉（默认开，一次正常点击），非空草稿直接掉进 LLM 支——而 llm 形态的锚定文本是空串
 * （`overlayShapeOf`：`anchorText: content.kind === 'llm' ? '' : content.prefix`），灰字**压在
 * 用户正打的字上**；采纳又是整段覆盖草稿（`buildFullAccept` 对 llm 就是 `return content.text`），
 * **用户输入直接消失**。CAS 救不了：这不是竞态，草稿在算与写之间没变时判据完全通过。
 *
 * ## 本冒烟台钉的判据（三条，缺一不可）
 *  1. **判据本体**：llm 形态只在「空草稿」上可达，且该结论**与 `historyEnabled` 无关**
 *     （关掉历史补全不得打开 llm 的可达性——这条耦合正是缺陷本身）；
 *  2. **同源**：「非空草稿」在续写支/历史支/LLM 支是同一份判据（`hasUserDraft`），
 *     源文本里不许出现第二种拼写——见 §0 的接线闸；
 *  3. **接线位置**：守卫加在 **LLM 支自己头上**（在历史支之后、`kind: 'llm'` 之前）。
 *     做成「非空草稿一律不出 llm」的上层分叉会改变续支/历史支的相对顺序，而
 *     「同一次生成内形态不得翻转」是已记录判据（Gitea #38，`decideInlineForm`）。
 *
 * ## 命令前缀草稿的口径（本仓今天没有定义，此处拍板并钉死）
 * `/later`、`/later +3m ` 这类「只打了命令前缀」的草稿**算非空**。理由：`stripCommandPrefix`
 * 是历史支的**匹配**判据（命令 `recordInput:false`，历史里只有内容部分，拿整行去匹配必然
 * `startsWith` 失败），不是「用户有没有输入」的判据；而 llm 形态的采纳是整段覆盖，在
 * `/later ` 上出幽灵会把用户的命令一起抹掉——那正是本条要堵的丢输入。历史支自己也是这个
 * 结论：`contentDraft.trim() === ''` 时它 `return null`（什么都不显示），与这里的裁决同形。
 *
 * 运行：`node --experimental-strip-types scripts/llm-form-guard-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFullAccept, gateAccept, LEGACY_FRAME_HINT } from '../src/client/accept-guard.ts';
import { stripCommandPrefix } from '../src/client/history.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 0. 接线闸（源文本）───────────────────────────────────────────────
// 这一节不依赖新导出，所以「改实现之前」它必红——且打的是**判据缺失**这句话，
// 不是模块加载失败（`docs/gitea-workflow.md` §6：证据要能读，退出码非 0 不算证据）。
const CLIENT_INDEX = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');

/** 抠出 `computeGhostContent` 的函数体；锚点找不到就当场红（不许静默空操作）。 */
const computeGhostBody = () => {
  const start = CLIENT_INDEX.indexOf('const computeGhostContent = (');
  assert.ok(start >= 0, '锚点失效：src/client/index.ts 里找不到 `const computeGhostContent = (`');
  const end = CLIENT_INDEX.indexOf('/** 缓存的上一次输入框查询结果', start);
  assert.ok(end > start, '锚点失效：找不到 computeGhostContent 之后的收尾锚点（函数体末尾的下一个声明）');
  // 折叠空白：判据只关心顺序与拼写，不关心换行/缩进。
  return CLIENT_INDEX.slice(start, end).replace(/\s+/g, ' ');
};

const RE_INLINE_ENTRY = /hasUserDraft\(draft\) && settings\.inlineEnabled/;
const RE_HISTORY_ENTRY = /settings\.historyEnabled && hasUserDraft\(draft\)/;
const RE_LLM_GUARD = /decideLlmForm\(\{[^)]*\}\)/;
const RE_LLM_RETURN = /return \{ kind: 'llm'/;

run('LLM 支头上有显式判据（decideLlmForm 已接线）', () => {
  const body = computeGhostBody();
  assert.match(body, RE_LLM_GUARD,
    'computeGhostContent 的 LLM 支没有显式的「空草稿」判据 ⇒ historyEnabled=false 时非空草稿会掉进 llm 形态（#129：灰字压字 + Tab 整段覆盖丢用户输入）');
});

run('守卫在 LLM 支自己头上（历史支之后、kind:\'llm\' 之前），不是上层分叉', () => {
  const body = computeGhostBody();
  const guard = body.search(RE_LLM_GUARD);
  assert.ok(guard >= 0, '先看上一条：判据还没接线');
  const historyEntry = body.search(RE_HISTORY_ENTRY);
  const llmReturn = body.search(RE_LLM_RETURN);
  assert.ok(historyEntry >= 0, '锚点失效：历史支进入条件变了（应为 `settings.historyEnabled && hasUserDraft(draft)`）');
  assert.ok(llmReturn >= 0, '锚点失效：LLM 支的返回语句变了');
  assert.ok(historyEntry < guard,
    '判据不许做成「非空草稿一律不出 llm」的上层分叉：那会改变续支/历史支的相对顺序（#38 形态不得翻转）');
  assert.ok(guard < llmReturn, '守卫必须在 LLM 支的返回之前');
});

run('拦下就 return null（不往下落、不显示任何幽灵）', () => {
  const body = computeGhostBody();
  const guard = body.search(RE_LLM_GUARD);
  assert.ok(guard >= 0, '先看第 0 节第一条');
  const after = body.slice(guard, guard + 400);
  assert.match(after, /if \(!llmForm\.allow\)[\s\S]{0,240}?return null/,
    `判据不通过时必须当场收口（return null），实际片段：${after.slice(0, 240)}`);
});

run('「非空草稿」只有一份拼写（三支同源，不许两份实现）', () => {
  const body = computeGhostBody();
  assert.doesNotMatch(body, /draft\.trim\(\) !== ''/,
    'computeGhostContent 里还留着裸的 `draft.trim() !== \'\'`：空/非空判据必须只有 hasUserDraft 这一份（#129 第 2 条）');
  assert.match(body, RE_INLINE_ENTRY, '续写支的进入条件应改用同一份 hasUserDraft');
  assert.match(body, RE_HISTORY_ENTRY, '历史支的进入条件应改用同一份 hasUserDraft');
});

// ── 1. 判据本体（纯函数）────────────────────────────────────────────
// 动态导入：源文本闸先跑完再解析模块，改实现之前这里的红是「导出缺失」而不是崩栈。
const { decideLlmForm, hasUserDraft } = await import('../src/client/completion-align.ts');
assert.equal(typeof decideLlmForm, 'function',
  'src/client/completion-align.ts 未导出 decideLlmForm（LLM 形态可达性判据）');
assert.equal(typeof hasUserDraft, 'function',
  'src/client/completion-align.ts 未导出 hasUserDraft（三支共用的「非空草稿」判据）');

/** 空草稿（llm 形态可达）——trim 后无字符。 */
const BLANK = ['', ' ', '   ', '\n', '\t', ' \n\t '];
/** 非空草稿（llm 形态必须不可达）——含「只打了命令前缀」那两类。 */
const NON_BLANK = [
  '我',
  '帮我看一下',
  'npm run build',
  '/later',
  '/later ',
  '/later +3m ',
  '/later +3m 我',
  '/schedule 明天9点 ',
  '  x',
];

run('空草稿 ⇒ llm 可达（判据唯一放行的一支）', () => {
  for (const draft of BLANK) {
    for (const historyEnabled of [true, false]) {
      const v = decideLlmForm({ draft, historyEnabled });
      assert.equal(v.allow, true, `空草稿 ${JSON.stringify(draft)}（historyEnabled=${historyEnabled}）必须可达 llm`);
    }
  }
});

run('非空草稿 ⇒ llm 不可达（含只打了命令前缀的草稿）', () => {
  for (const draft of NON_BLANK) {
    for (const historyEnabled of [true, false]) {
      const v = decideLlmForm({ draft, historyEnabled });
      assert.equal(v.allow, false,
        `非空草稿 ${JSON.stringify(draft)}（historyEnabled=${historyEnabled}）上 llm 形态可达 ⇒ 灰字压在已输入文字上、Tab 整段覆盖（#129）`);
      assert.equal(v.reason, 'draft-not-blank');
    }
  }
});

run('裁决与 historyEnabled 无关（关掉历史补全不得打开 llm 的可达性）', () => {
  for (const draft of [...BLANK, ...NON_BLANK]) {
    const on = decideLlmForm({ draft, historyEnabled: true }).allow;
    const off = decideLlmForm({ draft, historyEnabled: false }).allow;
    assert.equal(off, on, `${JSON.stringify(draft)}：llm 可达性随 historyEnabled 变了（这正是缺陷的耦合）`);
  }
});

run('判据与 hasUserDraft 同源（decideLlmForm 就是它的反面，不是第二份实现）', () => {
  for (const draft of [...BLANK, ...NON_BLANK]) {
    assert.equal(decideLlmForm({ draft, historyEnabled: false }).allow, !hasUserDraft(draft),
      `${JSON.stringify(draft)}：两支的空/非空结论相反 ⇒ 判据没同源`);
  }
});

run('命令前缀草稿算「非空」（拍板口径：strip 是匹配判据，不是空判据）', () => {
  for (const draft of ['/later', '/later ', '/later +3m ', '/schedule 明天9点 ']) {
    assert.equal(hasUserDraft(draft), true, `${JSON.stringify(draft)} 用户已键入字符，必须算非空`);
    assert.equal(decideLlmForm({ draft, historyEnabled: false }).allow, false);
  }
});

// ── 2. 分支顺序预言（与 index.ts 三段顺序同构；判据来自同一批导出）──────
// 顺序在这里是**测试预言**（oracle），不是第二份实现——两支共用的「空/非空」判据仍只有
// completion-align.ts 那一份；accept-cas-smoke.mjs 同款做法（旧实现字面拷贝当预言）。
/** 本冒烟只造「没有续写载荷」的帧：缺陷在「关历史 + 非空草稿 + 槽里有建议」这条路上最直白。 */
function reachableKind(draft, { historyEnabled, hasHistoryCandidate = true, hasLlmSuggestion = true, running = false }) {
  if (hasUserDraft(draft)) {
    if (historyEnabled) return hasHistoryCandidate ? 'history' : null; // 历史支每条路都 return（无候选也 return null）
    return null; // 关掉历史补全：非空草稿不该在任何一支拿到形态
  }
  if (!decideLlmForm({ draft, historyEnabled }).allow) return null;
  if (running || !hasLlmSuggestion) return null;
  return 'llm';
}

run('关掉历史补全 + 非空草稿 + 槽里有建议 ⇒ 形态不是 llm（工单验收的那条断言）', () => {
  for (const draft of NON_BLANK) {
    assert.notEqual(reachableKind(draft, { historyEnabled: false }), 'llm',
      `${JSON.stringify(draft)}：historyEnabled=false 时掉进了 llm 形态`);
    assert.equal(reachableKind(draft, { historyEnabled: false }), null);
  }
});

run('打开历史补全跑同一序列作对照（都不出 llm；开关只改变有没有历史补全）', () => {
  for (const draft of NON_BLANK) {
    assert.notEqual(reachableKind(draft, { historyEnabled: true }), 'llm');
  }
  for (const historyEnabled of [true, false]) {
    assert.equal(reachableKind('', { historyEnabled }), 'llm');
  }
  // 非空草稿 + 历史支无候选：历史上这里是 `return null`（不往下落），今天仍是 null。
  assert.equal(reachableKind('我', { historyEnabled: true, hasHistoryCandidate: false }), null);
});

// ── 3. 采纳面：非空草稿上 llm 形态不可采纳 ─────────────────────────
const SUGGESTION = { kind: 'llm', text: '帮我把构建产物重新部署一下', acceptKey: 'Tab', frame: LEGACY_FRAME_HINT };

/** 给非空草稿造一条**真实形状**的历史补全形态（候选 = 内容部分 + 尾巴）。 */
function historyContentOf(draft) {
  const contentDraft = stripCommandPrefix(draft);
  const full = `${contentDraft}然后把构建结果发我`;
  const common = (() => {
    let i = 0;
    while (i < Math.min(contentDraft.length, full.length) && contentDraft[i] === full[i]) i += 1;
    return i;
  })();
  return { kind: 'history', prefix: draft, suffix: full.slice(common), full };
}

run('危险面本体仍在：llm 形态的整条采纳就是整段覆盖草稿（所以才不许在非空草稿上出现）', () => {
  const draft = '我刚打到一半的那句话';
  assert.equal(gateAccept(SUGGESTION.frame).allow, true, '终帧采纳闸本来就放行');
  assert.equal(buildFullAccept(SUGGESTION, draft), SUGGESTION.text,
    'llm 形态采纳 = content.text，用户已输入的整段草稿被换掉');
});

run('非空草稿上 llm 形态不可采纳（形态生成就收口，采纳链拿不到它）', () => {
  for (const draft of NON_BLANK) {
    for (const historyEnabled of [true, false]) {
      const kind = reachableKind(draft, { historyEnabled });
      assert.notEqual(kind, 'llm', `${JSON.stringify(draft)}（historyEnabled=${historyEnabled}）：采纳链会拿到 llm 形态`);
      if (kind !== 'history') continue;
      // 对照：这一支真正给到采纳链的形态，采纳后用户已输入的字符仍在草稿里。
      const adopted = buildFullAccept(historyContentOf(draft), draft);
      const contentPart = stripCommandPrefix(draft);
      assert.ok(adopted.includes(contentPart),
        `${JSON.stringify(draft)}：history 采纳把已输入内容丢了，实际 ${JSON.stringify(adopted)}`);
      assert.ok(adopted.length >= draft.length,
        `${JSON.stringify(draft)}：history 采纳让草稿变短（等于丢输入），实际 ${JSON.stringify(adopted)}`);
      // 只打了命令前缀（内容部分为空）时，命令段一个字都不许少。
      if (contentPart === '') assert.ok(adopted.startsWith(draft.trimEnd()),
        `${JSON.stringify(draft)}：命令前缀段必须原样保留，实际 ${JSON.stringify(adopted)}`);
    }
  }
});

run('空草稿上 llm 采纳仍逐字是原行为（本条只收紧一支的进入条件）', () => {
  assert.equal(buildFullAccept(SUGGESTION, ''), SUGGESTION.text);
  assert.equal(reachableKind('', { historyEnabled: false }), 'llm');
  assert.equal(reachableKind(' ', { historyEnabled: true }), 'llm');
});

// ── 4. 行为半边：真 `lib/client.js` + 最小 DOM/宿主替身 ────────────────
// 上面第 0 节是**形状/接线**闸（`docs/gitea-workflow.md` §5：形状能严格蕴含语义，改名绕不过
// 位置约束），这一节是**语义**闸：跑产品字节码，看它真的进了哪一支。
// harness 口径照 `scripts/ghost-frame-cell-e2e.mjs`：三态 PASS / FAIL / NOT-COVERED，
// 「产物没构建」与「断言没红」分开报，不许用前者冒充后者。
const CLIENT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const CLIENT_SRC = ['index.ts', 'completion-align.ts', 'history.ts', 'accept-guard.ts', 'inline-arm-policy.ts', 'keyspec.ts', 'chunk.ts']
  .map((f) => fileURLToPath(new URL(`../src/client/${f}`, import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B_STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const behavior = [];
const record = (name, status, detail) => {
  behavior.push({ name, status, detail });
  const mark = status === B_STATUS.PASS ? '✅' : status === B_STATUS.FAIL ? '❌' : '⚪';
  console.log(`${mark} [${status}] ${name}${detail ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
};

/** 产物陈旧 = 这一节测的是旧字节码，判它 NOT-COVERED 而不是「通过」。 */
function bundleFresh() {
  if (!existsSync(CLIENT_BUNDLE)) return { ok: false, why: `缺前置：${CLIENT_BUNDLE} 不存在（先跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs）` };
  const libM = statSync(CLIENT_BUNDLE).mtimeMs;
  const stale = CLIENT_SRC.filter((f) => existsSync(f) && statSync(f).mtimeMs > libM);
  if (stale.length > 0) return { ok: false, why: `缺前置：lib/client.js 比这些源文件旧，测的是旧字节码：${stale.map((s) => s.split('/').pop()).join(', ')}（重建后再跑）` };
  return { ok: true, why: '' };
}

const SUGG_TEXT = '帮我把构建产物重新部署一下';
const DRAFT_TEXT = '我刚打到一半';
const PUSH_SUGGESTION = JSON.stringify({
  suggestion: { version: 1, turn: 1, baseSeq: 3, text: SUGG_TEXT, truncated: false, acceptKey: 'Tab', frame: 1, final: true },
  suggestionSessionId: 's1',
});
const HOT_WITH_HISTORY = JSON.stringify({
  // 对照场景 C 要真的出 history 形态 ⇒ 候选必须以测试草稿（DRAFT_TEXT）开头。
  hot: [{ text: `${DRAFT_TEXT}的日志在哪`, count: 2 }],
  history: [`${DRAFT_TEXT}的日志在哪`],
  historySessionId: 's1',
});

/** 最小 DOM：够 render() 走到 `overlay.show()` 并把文本写进 overlay 节点。 */
function makeDom() {
  const created = [];
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.dataset = {}; this.id = '';
      this.style = { cssText: '', display: 'none', setProperty() {} };
      this.textContent = '';
      this.parentElement = null; this.isConnected = false; this.isContentEditable = false;
      this.offsetParent = null; this.offsetTop = 0; this.offsetLeft = 0;
      this._closest = {}; this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      this.events = [];
    }
    appendChild(c) { this.children.push(c); c.parentElement = this; c.isConnected = this.isConnected; if (c.offsetParent === null) c.offsetParent = this; return c; }
    append(c) { return this.appendChild(c); }
    remove() { const p = this.parentElement; if (p) p.children = p.children.filter((x) => x !== this); this.parentElement = null; }
    addEventListener(t, cb) { this.events.push([t, cb]); }
    removeEventListener(t, cb) { this.events = this.events.filter((e) => !(e[0] === t && e[1] === cb)); }
    setAttribute(k, v) { this.dataset[k] = String(v); }
    removeAttribute(k) { delete this.dataset[k]; }
    closest(sel) { return this._closest[sel] ?? null; }
    matches() { return false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains(x) { let p = x; while (p !== null && p !== undefined) { if (p === this) return true; p = p.parentElement; } return false; }
    getBoundingClientRect() { return this._rect; }
    get firstElementChild() { return this.children[0] ?? null; }
    get lastChild() { return this.children[this.children.length - 1] ?? null; }
    get childNodes() { return this.children; }
  }
  // 产品代码用 `instanceof HTMLElement / Element / HTMLTextAreaElement` 认输入框。
  // Element 与 HTMLElement 指向同一桩类（桩元素两边都要认），textarea 单独一档 ⇒
  // contenteditable 分支命中，与 0.1.2 宿主一致。
  globalThis.Element = El;
  globalThis.HTMLElement = El;
  globalThis.HTMLTextAreaElement = class TextAreaEl extends El {};
  // `draftEndRect()` 用 TreeWalker 找最后一个文本节点（history/inline 形态要量草稿行尾）。
  globalThis.NodeFilter = { SHOW_TEXT: 4 };

  const scroller = new El('div');
  scroller.isConnected = true;
  const grow = new El('div');
  grow.isConnected = true;
  scroller.appendChild(grow);
  const composer = new El('div');
  composer.isConnected = true;
  composer.isContentEditable = true;
  composer._closest = { '[data-input-scroll]': scroller };
  composer._rect = { left: 114, top: 504, right: 900, bottom: 560, width: 786, height: 56 };
  grow.appendChild(composer);

  const head = new El('head');
  const body = new El('body');
  const documentStub = {
    createElement: (tag) => { const el = new El(tag); created.push(el); return el; },
    head, body,
    // 双代选择器在替身里由「输入框是否挂载」决定：挂载后恒返回 composer。
    querySelector: () => (composer.isConnected ? composer : null),
    querySelectorAll: () => [],
    getElementById: (id) => created.find((el) => el.id === id) ?? null,
    getSelection: () => null,
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ left: 114, top: 504, right: 114, bottom: 528, width: 0, height: 24 }) }),
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const windowListeners = [];
  const windowStub = {
    addEventListener: (t, cb) => { windowListeners.push([t, cb]); },
    removeEventListener: (t, cb) => { windowStobRemove(windowListeners, t, cb); },
    ResizeObserver: undefined,
  };
  const overlayEl = () => created.find((el) => el.id === 'dsh-suggest-ghost-overlay') ?? null;
  return { documentStub, windowStub, windowListeners, composer, created, overlayEl };
}
function windowStobRemove(list, t, cb) {
  const i = list.findIndex((e) => e[0] === t && e[1] === cb);
  if (i >= 0) list.splice(i, 1);
}

/** 加载真产物（`window.__ModuleLoader__.load(def)` → `def.factory(require)`）。 */
function loadClientBundle(dom) {
  let definition = null;
  const loaderWindow = { ...dom.windowStub, __ModuleLoader__: { load: (def) => { definition = def; } } };
  new Function('window', 'document', 'localStorage', 'getComputedStyle', 'ResizeObserver',
    readFileSync(CLIENT_BUNDLE, 'utf8'))(
    loaderWindow, dom.documentStub,
    { getItem: () => null, setItem() {}, removeItem() {} },
    () => ({
      getPropertyValue: () => '0px', paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px',
      borderTopWidth: '0px', borderLeftWidth: '0px', lineHeight: '24px', display: 'block',
    }),
    class { observe() {} unobserve() {} disconnect() {} },
  );
  if (definition === null) throw new Error('lib/client.js 没有调 window.__ModuleLoader__.load');
  const requireStub = () => ({ default: {}, Fragment: 'frag', jsx: () => null, jsxs: () => null });
  return definition.factory(requireStub);
}

/** 最小宿主：远程 settings 面 + 单会话 + 输入机 face（草稿可读、setDraft 记账）。 */
function makeHost(dom, initial) {
  const doc = { _push: '', _hot: '', historyEnabled: true, ...initial.doc };
  let revision = 0;
  const listeners = [];
  const wrote = [];
  const snapshot = { draft: initial.draft, draftRev: 4 };
  const rows = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
  const actx = { get: (name) => (name === 'conversation' ? conversationFace : undefined) };
  const conversationFace = {
    input: {
      for: () => ({
        state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
        setDraft: (t) => { wrote.push(t); snapshot.draft = t; snapshot.draftRev += 1; },
      }),
    },
  };
  const sessionsFace = {
    list: { getSnapshot: () => ({ byId: structuredClone(rows) }), subscribe: () => () => {} },
    scope: () => actx,
    sessionOf: () => ({
      getSnapshot: () => ({ running: false }),
      subscribe: () => () => {},
      projections: { faceOf: () => ({ getSnapshot: () => null, subscribe: () => () => {} }) },
    }),
  };
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [{ ns: 'suggest-ghost', revision, value: { ...doc } }] } }),
      mutate: async (ns, ops) => {
        for (const op of ops) if (op.op === 'set' && Array.isArray(op.path)) doc[op.path[0]] = op.value;
        revision += 1;
        return { ok: true, value: { ns: 'suggest-ghost', revision, value: { ...doc } } };
      },
    },
    $on: (event, cb) => { if (event === 'settings/document-updated') listeners.push(cb); return () => {}; },
  };
  const ctx = {
    get: (name) => (name === 'sessions' ? sessionsFace : name === 'remote' ? remote
      : name === 'conversation' ? conversationFace : undefined),
    on: () => () => {},
    // 宿主是**同步调用** effect 的（本插件用它挂事件监听与订阅、返回清理函数）；
    // 不调用就等于 keydown 监听根本没登记 ⇒ 「Tab 不改动草稿」会假绿。
    effect: (fn) => (typeof fn === 'function' ? fn(() => {}) : undefined),
    inject: () => undefined,
  };
  const emit = (patch) => { Object.assign(doc, patch); revision += 1; for (const cb of listeners) cb('suggest-ghost', revision); };
  return { ctx, emit, wrote, snapshot, dom, revision: () => revision };
}

/**
 * overlay 节点上的灰字正文。
 *
 * 两种形态写法不同（`buildText`）：llm 整段写 `textContent`，history/inline 只把**后缀**
 * 装进一个子 span。所以取文本要递归，不能只读 textContent——否则 history 形态恒为空，
 * 「不覆盖已输入内容」那条对照就成了空话。
 */
const textOfEl = (el) => (el === null || el === undefined
  ? null
  : `${el.textContent ?? ''}${(el.children ?? []).map(textOfEl).join('')}`);

/** 一个场景：独立加载一份产物（模块级计数器彼此隔离），喂到目标帧，返回观测值。 */
async function scenario({ draft, doc, tab = false }) {
  const dom = makeDom();
  const traces = [];
  const real = { debug: console.debug, log: console.log, warn: console.warn, error: console.error };
  const swallow = (line) => line.includes('[ops-trace]') || line.includes('[suggest-ghost]') || line.includes('[dsh-suggest-ghost]');
  console.debug = (...a) => { const l = a.map(String).join(' '); if (swallow(l)) traces.push(l); };
  console.log = (...a) => { const l = a.map(String).join(' '); if (swallow(l)) traces.push(l); else real.log(l); };
  console.warn = (...a) => { const l = a.map(String).join(' '); if (swallow(l)) traces.push(l); else real.warn(l); };
  console.error = (...a) => { const l = a.map(String).join(' '); if (swallow(l)) traces.push(l); else real.error(l); };
  let out;
  const harnessErrors = [];
  const onUncaught = (error) => harnessErrors.push(String(error && error.message ? error.message : error).slice(0, 200));
  process.on('uncaughtException', onUncaught);
  try {
    const client = loadClientBundle(dom);
    const host = makeHost(dom, { draft, doc });
    client.apply(host.ctx);
    await sleep(40);                                  // 首读 + 绑定
    host.emit({ _push: PUSH_SUGGESTION, _hot: HOT_WITH_HISTORY });  // 建议进槽（同帧喂历史候选）
    await sleep(60);                                  // settings 变更 → render()
    const before = host.wrote.length;
    if (tab) {
      dom.documentStub.activeElement = dom.composer;
      const handler = dom.windowListeners.find(([t]) => t === 'keydown')?.[1];
      if (typeof handler === 'function') {
        handler({
          isComposing: false, code: 'Tab', key: 'Tab', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
          preventDefault() {}, stopPropagation() {}, target: dom.composer,
        });
      } else {
        out = { noKeydownHandler: true };
      }
    }
    if (out === undefined) {
      const overlay = dom.overlayEl();
      out = {
        llmGhostOffered: client.pushCellStats.llmGhostOffered,
        ownerHidden: client.pushCellStats.ownerHidden,
        overlayText: textOfEl(overlay),
        overlayShown: overlay === null ? null : (overlay.dataset.shown ?? null),
        overlayReject: overlay === null ? null : (overlay.dataset.reject ?? null),
      harnessErrors,
        draftAfter: host.snapshot.draft,
        writes: host.wrote.slice(before),
        allWrites: host.wrote.slice(),
        traces,
      };
    } else {
      out = { ...out, traces };
    }
  } catch (error) {
    out = { loadError: String(error).slice(0, 220), traces };
  } finally {
    process.off('uncaughtException', onUncaught);
    console.debug = real.debug; console.log = real.log; console.warn = real.warn; console.error = real.error;
  }
  return out;
}

const fresh = bundleFresh();
if (!fresh.ok) {
  record('行为半边（真 lib/client.js）', B_STATUS.NC, fresh.why);
} else {
  // 场景 A（自证量具不瞎）：空草稿 + 槽里有建议 ⇒ llm 形态**必须**真的生成。
  const a = await scenario({ draft: '', doc: { historyEnabled: false } });
  if (a.loadError !== undefined) {
    record('行为半边（真 lib/client.js）', B_STATUS.FAIL, `产物在场却加载/运行失败：${a.loadError}`);
  } else {
    record('A 空草稿 + 槽里有建议 ⇒ llm 形态真的生成（量具自证）',
      a.llmGhostOffered >= 1 && a.overlayText === SUGG_TEXT && (a.harnessErrors ?? []).length === 0 ? B_STATUS.PASS : B_STATUS.FAIL,
      `llmGhostOffered=${a.llmGhostOffered} overlayText=${JSON.stringify(a.overlayText)} data-shown=${a.overlayShown} data-reject=${a.overlayReject}`
      + '（overlay 文本就是灰字正文；data-reject 只说明替身没有排版，不影响「形态已生成」这条判据）');

    // 场景 B（工单验收的行为半边）：关掉历史补全 + 非空草稿 + 同一个槽 ⇒ 不得出 llm。
    const b = await scenario({ draft: DRAFT_TEXT, doc: { historyEnabled: false }, tab: true });
    record('B 关掉历史补全 + 非空草稿 ⇒ 无 llm 幽灵、Tab 不改动草稿',
      b.llmGhostOffered === 0 && b.overlayText !== SUGG_TEXT && b.writes.length === 0 && b.draftAfter === DRAFT_TEXT
        && (b.harnessErrors ?? []).length === 0 ? B_STATUS.PASS : B_STATUS.FAIL,
        `llmGhostOffered=${b.llmGhostOffered} overlayText=${JSON.stringify(b.overlayText)} 采纳写入=${JSON.stringify(b.writes)} 草稿=${JSON.stringify(b.draftAfter)}`);
    // 场景 B2：同帧不按键，只看屏幕上有没有那行灰字（缺陷的第一层后果是**渲染**压字，
    // 采纳是第二层）。Tab 之后 overlay 会被 `hide()` 清空文本，所以「有没有幽灵」必须在
    // 按键**之前**取——这一条在变异下会显出建议正文，正是「灰字压在已输入文字上」。
    const b2 = await scenario({ draft: DRAFT_TEXT, doc: { historyEnabled: false } });
    record('B2 关掉历史补全 + 非空草稿 ⇒ 屏幕上没有那行灰字（按键之前取证）',
      b2.llmGhostOffered === 0 && b2.overlayText !== SUGG_TEXT && (b2.harnessErrors ?? []).length === 0
        ? B_STATUS.PASS : B_STATUS.FAIL,
        `llmGhostOffered=${b2.llmGhostOffered} overlayText=${JSON.stringify(b2.overlayText)} data-shown=${b2.overlayShown} data-reject=${b2.overlayReject}`);

    record('B 的留痕（llm-form-guard 槽在真产物里打出来了，走 debug 常态通道）',
      b.traces.some((l) => l.includes('llm-form-guard')) ? B_STATUS.PASS : B_STATUS.FAIL,
      b.traces.filter((l) => l.includes('llm-form-guard')).slice(0, 2).join('\n') || `捕获 ${b.traces.length} 行留痕，没有一条是 llm-form-guard`);

    // 场景 C（对照）：同一份草稿打开历史补全 ⇒ 出的是 history，采纳不丢已输入字符。
    const c = await scenario({ draft: DRAFT_TEXT, doc: { historyEnabled: true }, tab: true });
    // 对照场景必须**真的出得出** history 形态，否则「不丢输入」是空话（阈值/通道任一处
    // 让候选没生成，这条就该 FAIL 而不是安静通过）——判据：overlay 有尾巴 + Tab 写了东西。
    const cOk = c.llmGhostOffered === 0
      && typeof c.overlayText === 'string' && c.overlayText !== '' && c.overlayText !== SUGG_TEXT
      && c.writes.length === 1 && c.writes[0].startsWith(DRAFT_TEXT);
    record('C 打开历史补全跑同一序列作对照（出的是 history，采纳保留已输入内容）',
      cOk && (c.harnessErrors ?? []).length === 0 ? B_STATUS.PASS : B_STATUS.FAIL,
      `llmGhostOffered=${c.llmGhostOffered} overlayText=${JSON.stringify(c.overlayText)} 采纳写入=${JSON.stringify(c.writes)} 草稿=${JSON.stringify(c.draftAfter)}`);
  }
}

const behaviorFailed = behavior.filter((r) => r.status === B_STATUS.FAIL).length;
if (behaviorFailed > 0) console.error(`\n❌ llm-form-guard-smoke: 行为半边 ${behaviorFailed} 条 FAIL`);
if (failed > 0 || behaviorFailed > 0) console.error(`判定：${failed} 条判据未通过（另见上方三态）`);
else if (!fresh.ok) console.log('\n✅ llm-form-guard-smoke: 判据半边全绿；行为半边 NOT-COVERED（缺前置见上）');
else console.log('\n✅ llm-form-guard-smoke: LLM 形态可达性（#129）判据 + 行为全绿');
process.exit(failed === 0 && behaviorFailed === 0 ? 0 : 1);
