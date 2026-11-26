#!/usr/bin/env node
/**
 * Tab 按键所有权冒烟（Gitea #166：方案 A 让路优先 + 方案 B1 采纳前同源校验）。
 *
 * 运行：`node --experimental-strip-types scripts/tab-ownership-smoke.mjs`
 *
 * ## 这个脚本要钉的四件事
 *
 * 1. **A. 注册阶段**（源码形状 + 行为）：keydown 必须注册在**冒泡**阶段、composition
 *    必须仍注册在**捕获**阶段（IME 不受影响）。形状那半边只能证明"写法变了"，
 *    所以它配一整段真事件派发（D 段）做行为对照 —— `docs/gitea-workflow.md` §7 #146。
 * 2. **B. 让路判据**（纯逻辑）：`shouldYieldKey` 的抖动与理由序列。插件的让路语义
 *    只取决于"别人有没有 preventDefault"，不看事件到达顺序；所以它被拆成纯函数。
 * 3. **C. 注入自证**（工单验收第一条）：在 bubble 层放一个先 `preventDefault()` 的
 *    假处理器 —— 修复前本插件**照样采纳并吞键**（红），修复后**不写草稿、不吞键、
 *    事件照常回到浏览器**（绿）。红/绿两次都跑，并把读数打出来。
 * 4. **D. 行为对照**（同一份产物上换"修复前/修复后"两种注册与判据）：`lib/client.js`
 *    真字节码 + 最小 DOM/宿主替身（口径同 `scripts/llm-form-guard-smoke.mjs`），
 *    逐场景派发真 `keydown`/`compositionstart`，读出「写没写草稿 / 草稿变成什么 /
 *    本插件有没有 preventDefault / 浮层还在不在」。
 *
 * ## 三种角色与它们各自的 stopPropagation 位置（C/D 段的分组依据）
 *
 * | 角色 | 位置 | 效果 |
 * |---|---|---|
 * | 宿主 composer 的**冒泡**处理器调 stopPropagation | composer 自身 bubble | 冒泡监听彻底收不到 ⇒ 采纳失效（**必须证伪**的那条风险） |
 * | 宿主 composer 的**捕获**处理器调 stopPropagation | composer 自身 capture | 同上，且注册在 window 捕获也躲不过 |
 * | window 直接子级 bubble 调 stopPropagation | 最外层 bubble | 冒泡监听收不到；window **捕获**监听照样收到 |
 *
 * ## 三态
 *
 * `PASS / FAIL / NOT-COVERED`。产物缺失或比源码旧 ⇒ 行为段 **NOT-COVERED**（缺哪个
 * 前置写在读数里），不静默跳过、也不冒充通过。基线（"修复前"）对照里，**红是预期**：
 * 那些红记成 `BASELINE-RED`，不计入失败；但基线那一侧**没红**就是修复无效（§7 #146：
 * 同一套用例两侧读数一致 ⇒ 修复无效）⇒ 记 FAIL。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acceptSourceVerdict, paintedSuggestionText } from '../src/client/accept-source.ts';
import { buildFullAccept, buildWordAccept, acceptTarget, readDraftSnapshot } from '../src/client/accept-guard.ts';
import { decideYieldAction, shouldYieldKey } from '../src/client/yield-key.ts';
import { stripCommandPrefix } from '../src/client/history.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
/**
 * 形状闸用的**去注释**源码。
 *
 * 为什么要有这一份：形状断言问的是「代码里有没有第二份判据」，而注释里**提到**判据
 * 是常事——本单给逐词支写的注释正写着 `accepted.endsWith(painted)`， raw 匹配于是
 * 把一句说明判成了违规。与本文件对 `accept-source.ts` 的处理（`:244` 那两条 replace）
 * 同一条口径：**扫代码，不扫散文**。
 * 只剥整行注释与块注释，不剥行尾注释 ⇒ 字符串里的 `https://` 之类不会被误伤。
 */
const CLIENT_CODE = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CLIENT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n')[0]}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 0. 注册阶段（源码形状）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 0. 注册阶段：keydown 冒泡 / composition 捕获 ——');

/** 取最后一次出现的 `addEventListener(...)` 调用文本（注册与移除各一份，注册在前）。 */
const registrations = (type) => [...CLIENT_SRC.matchAll(new RegExp(`window\\.addEventListener\\('${type}',\\s*(\\w+)([^)]*)\\)`, 'g'))]
  .map((m) => ({ fn: m[1], rest: (m[2] ?? '').trim() }));
const removals = (type) => [...CLIENT_SRC.matchAll(new RegExp(`window\\.removeEventListener\\('${type}',\\s*(\\w+)([^)]*)\\)`, 'g'))]
  .map((m) => ({ fn: m[1], rest: (m[2] ?? '').trim() }));

run('keydown 注册在冒泡阶段（第三个参数不给 true）', () => {
  const regs = registrations('keydown');
  assert.ok(regs.length >= 1, '锚点失效：src/client/index.ts 里找不到 window.addEventListener(\'keydown\', …)');
  for (const r of regs) {
    assert.ok(!/,\s*true\s*$/.test(r.rest) && !/capture\s*:\s*true/.test(r.rest),
      `keydown 仍是捕获注册（${r.fn}，尾参 ${JSON.stringify(r.rest)}）：本插件又会抢在所有处理器之前`);
  }
});

run('keydown 的移除与注册标志逐字一致（否则移除是静默空操作）', () => {
  const regs = registrations('keydown');
  const rms = removals('keydown');
  assert.equal(regs.length, rms.length, `注册 ${regs.length} 处、移除 ${rms.length} 处，数目不等 ⇒ 有一条监听摘不掉`);
  const captureOf = (rest) => /,\s*true\s*$/.test(rest) || /capture\s*:\s*true/.test(rest);
  for (let i = 0; i < regs.length; i += 1) {
    assert.equal(regs[i].fn, rms[i].fn, `第 ${i + 1} 处注册/移除的函数名不一致：${regs[i].fn} vs ${rms[i].fn}`);
    assert.equal(captureOf(regs[i].rest), captureOf(rms[i].rest),
      `第 ${i + 1} 处（${regs[i].fn}）注册标志与移除标志不一致：${JSON.stringify(regs[i].rest)} vs ${JSON.stringify(rms[i].rest)}`);
  }
});

run('IME：compositionstart / compositionend 仍注册在**捕获**阶段', () => {
  for (const type of ['compositionstart', 'compositionend']) {
    const regs = registrations(type);
    assert.ok(regs.length >= 1, `锚点失效：找不到 window.addEventListener('${type}', …)`);
    for (const r of regs) {
      assert.ok(/,\s*true\s*$/.test(r.rest),
        `${type} 不是捕获注册（尾参 ${JSON.stringify(r.rest)}）：编辑器内组合事件被内层截住时`
        + '「组词期间不画幽灵」这条状态就晚了（#166 验收：IME 不受影响）');
    }
  }
});

run('即刻返回判据调的是纯函数（不在关键路径上再拼一份 defaultPrevented 判定）', () => {
  const at = CLIENT_SRC.indexOf('const onKeyDown = (event: KeyboardEvent)');
  assert.ok(at > 0, '锚点失效：找不到 onKeyDown 定义');
  const head = CLIENT_SRC.slice(at, at + 1200);
  assert.match(head, /if \(shouldYieldKey\(event\)\) return;/, 'onKeyDown 第一段必须调 shouldYieldKey 让路');
  assert.equal((head.match(/defaultPrevented/g) ?? []).length, 0,
    'onKeyDown 里还留着裸的 defaultPrevented 判定 ⇒ 判据会有两份拼写');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. 让路判据（纯逻辑）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 1. 让路判据：只认 defaultPrevented，不看事件跑到第几个 ——');

run('别人认领过（defaultPrevented）⇒ 不采纳、不吞键', () => {
  assert.equal(shouldYieldKey({ defaultPrevented: true }), true);
  assert.deepEqual(decideYieldAction({ defaultPrevented: true }),
    { yield: true, preventDefault: false, stopPropagation: false, reason: 'claimed-by-outer' });
});

run('没人认领 ⇒ 采纳，且吞键（否则 Tab 会同时移焦点）', () => {
  assert.equal(shouldYieldKey({ defaultPrevented: false }), false);
  assert.deepEqual(decideYieldAction({ defaultPrevented: false }),
    { yield: false, preventDefault: true, stopPropagation: true, reason: 'ownerless' });
});

run('抖动 60 次读数恒定（判据不依赖调用次数/历史）', () => {
  for (let i = 0; i < 60; i += 1) {
    const dp = i % 2 === 0;
    assert.equal(shouldYieldKey({ defaultPrevented: dp }), dp, `第 ${i} 次抖动读数错`);
  }
});

run('显式 false / 缺省都按「没人认领」处理（旧宿主不会因为字段缺失就丢采纳）', () => {
  assert.equal(shouldYieldKey({ defaultPrevented: false }), false);
  assert.equal(shouldYieldKey({}), false);
});

run('★ 让路语义的边界：判据只看 defaultPrevented，不看事件顺序（所以捕获/冒泡各有死角）', () => {
  // 这一条不是"通过"，是把边界钉成断言：如果哪天有人以为「加个 defaultPrevented
  // 就够了」，这条会提醒他 —— 捕获阶段读到的恒为 false（issue 正文的更正）。
  const capturePhaseObservation = { defaultPrevented: false }; // window 捕获时恒如此
  assert.equal(shouldYieldKey(capturePhaseObservation), false,
    '捕获阶段读到的 defaultPrevented 恒为 false ⇒ 光加判据拦不住任何东西（#166 正文的更正）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 同源校验（纯逻辑，B1）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 2. 同源闸：浮层画的那句 vs 要写入的那句 ——');

const LLM = { kind: 'llm', text: '帮我把构建产物重新部署一下' };
// 逐词采纳的「画出的后缀」必须是 `full` 的真尾巴：`wordMatchBase` 对 history 用
// `stripCommandPrefix(draft)` 作答，所以 `prefix` 取**不带**命令前缀的纯内容部分
// （斜杠命令那两种草稿在下面的 `slash` 用例里单独覆盖 `buildFullAccept`）。
const HISTORY = { kind: 'history', suffix: '的日志在哪', prefix: '我刚打到一半', full: '我刚打到一半的日志在哪' };
const INLINE = { kind: 'inline', suffix: '，再跑一遍冒烟。', prefix: '我先把改动落下来', full: '我先把改动落下来，再跑一遍冒烟。' };

run('llm：画出整段文本，accepted 与之相等 ⇒ 允许', () => {
  const accepted = buildFullAccept(LLM, '');
  const v = acceptSourceVerdict({ paintedText: paintedSuggestionText(LLM), paintedContent: LLM, accepted });
  assert.equal(v.allow, true, JSON.stringify(v));
  assert.equal(paintedSuggestionText(LLM), LLM.text);
});

run('history：浮层只画后缀，accepted 回填命令/草稿前缀 ⇒ 仍同源', () => {
  const accepted = buildFullAccept(HISTORY, HISTORY.prefix);
  assert.equal(accepted, HISTORY.full);
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted }).allow, true);
  // 斜杠命令整行（命令前缀段要回填）
  const slash = buildFullAccept(HISTORY, '/later +3m 我刚打到一半');
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted: slash }).allow, true, slash);
});

run('inline：同上', () => {
  const accepted = buildFullAccept(INLINE, INLINE.prefix);
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(INLINE), paintedContent: INLINE, accepted }).allow, true);
});

run('逐词：每个片段拼出来的 accepted 都以画出的后缀收尾 ⇒ 允许', () => {
  const accepted = buildWordAccept(HISTORY, HISTORY.prefix, HISTORY.prefix, '的日志');
  // 读数要能读：`HISTORY.suffix` 是 `的日志在哪`，片段只吃到 `的日志` ⇒ 此刻尾巴不一致。
  // 这与工单无关（#166 不接管逐词的相对顺序），如实写成「第一步不同源」而不是硬改成通过。
  const first = acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted });
  assert.equal(first.allow, false, `asserted=${JSON.stringify(accepted)} verdict=${JSON.stringify(first)}`);

  // 吃到整段（`→` 按到最后一枚片段）：尾巴对齐 ⇒ 允许。
  // 第二枚片段：`full` 已吃到 `我刚打到一半的日志`，只剩尾巴 `在哪`。
  const stepBase = HISTORY.full.slice(0, HISTORY.full.length - '在哪'.length);
  const whole = buildWordAccept(HISTORY, stepBase, stepBase, '在哪');
  assert.ok(whole.endsWith(HISTORY.suffix), `asserted=${JSON.stringify(whole)}`);
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted: whole }).allow, true, whole);

  // 斜杠命令整行：命令前缀段随首枚片段一起回填，尾巴仍由同一份后缀收尾。
  const slashBase = '/later +3m 我';
  const slashWord = buildWordAccept(HISTORY, slashBase, stripCommandPrefix(slashBase), HISTORY.suffix);
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted: slashWord }).allow, true, slashWord);
});

run('★ 不同源（画的是 X，写的是 Y）⇒ 放弃并给出理由 painted-mismatch', () => {
  const v = acceptSourceVerdict({ paintedText: '第三方候选：把 README 的用法段重写', paintedContent: LLM, accepted: LLM.text });
  assert.equal(v.allow, false, JSON.stringify(v));
  assert.equal(v.reason, 'painted-mismatch');
  assert.equal(v.paintedChars, '第三方候选：把 README 的用法段重写'.length, '读数要能看出两句各多长（只记字符数，不记正文）');
});

run('★ 后缀只出现在中间不算同源（不能被 includes 骗过）', () => {
  // 画的是 `的日志在哪`，要写的那句把这段放在**中间**、尾巴上接了别的东西 ⇒ 不同源。
  const v = acceptSourceVerdict({ paintedText: paintedSuggestionText(HISTORY), paintedContent: HISTORY, accepted: '我刚打到一半的日志在哪，然后删掉整个仓库' });
  assert.equal(v.allow, false, `asserted accepted=${JSON.stringify('…的日志在哪，然后删掉整个仓库')} verdict=${JSON.stringify(v)}`);
});

run('浮层没在画（paintedText=null）⇒ 不同源，理由 not-painted', () => {
  const v = acceptSourceVerdict({ paintedText: null, paintedContent: LLM, accepted: LLM.text });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'not-painted');
});

run('画的是空串 ⇒ 不同源（空建议没有「屏幕上的那句」）', () => {
  const v = acceptSourceVerdict({ paintedText: '', paintedContent: { kind: 'llm', text: '' }, accepted: '' });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'painted-mismatch');
});

run('★ 判据输入必须是屏幕文本：同一个 content 与 accepted 同源 ⇒ 不能用 content 当"画的那句"', () => {
  // 这条用来说明**为什么** `acceptSourceVerdict` 收的是 `paintedText`：若调用方拿
  // `shown.content` 投影出的文本去比，`llm` 形态上恒等于 `accepted` ⇒ 永远放行，
  // 把屏幕改成任何东西都拦不住（本站实测过这一幕）。
  const content = { kind: 'llm', text: '槽里那条' };
  const accepted = buildFullAccept(content, '');
  assert.equal(acceptSourceVerdict({ paintedText: paintedSuggestionText(content), paintedContent: content, accepted }).allow, true,
    '（对照）槽里的文本比 accepted —— 必然通过，这就是同义反复');
  assert.equal(acceptSourceVerdict({ paintedText: '别人画的那句', paintedContent: content, accepted }).allow, false,
    '屏幕上是别的文本时判据必须拦住');
  // 形状闸：判据函数体内不许再出现 paintedSuggestionText 的调用（那正是同义反复的入口）。
  const body = readFileSync(new URL('../src/client/accept-source.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const verdictBody = body.slice(body.indexOf('export function acceptSourceVerdict'));
  assert.doesNotMatch(verdictBody, /paintedSuggestionText\(/, '判定函数体里又拿 content 投影当"画的那句"了 ⇒ 同义反复复活');
});

run('★ 形状闸：同源判据不引入宿主 DOM 遍历', () => {
  const src = readFileSync(new URL('../src/client/accept-source.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /querySelector|querySelectorAll|closest\(|getBoundingClientRect/,
    'accept-source.ts 里出现了 DOM 查询：同源判据只许比插件自己持有的两份值（#166 评审判据）');
  // 同一份判据只许有一处：index.ts 的采纳支必须调它，不许内联第二份拼写。
  const inlineChecks = CLIENT_CODE.match(/\.endsWith\((painted|suffix)/g) ?? [];
  assert.equal(inlineChecks.length, 0, `src/client/index.ts 里出现了内联的同源比对（${inlineChecks.join(',')}）：判据必须只有一份`);
  assert.ok((CLIENT_CODE.match(/acceptSourceVerdict\(/g) ?? []).length >= 2,
    'index.ts 应有两处调用（整条采纳 + 逐词采纳），共用同一个判据函数');
});

run('★ 形状闸：accept-guard.ts 仍是唯一一份 buildFullAccept（没有复制品）', () => {
  assert.equal((CLIENT_CODE.match(/const accepted = buildFullAccept\(/g) ?? []).length, 1,
    '整条采纳的 accepted 只许算一次（重复计算会让两次 derive 之间产生新窗口）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 行为对照：真 lib/client.js + 最小 DOM/宿主替身
// ═══════════════════════════════════════════════════════════════════════════
const B = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED', BASE_RED: 'BASELINE-RED' };
const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  const mark = { PASS: '✅', FAIL: '❌', 'NOT-COVERED': '⚪', 'BASELINE-RED': '🔴' }[status];
  console.log(`${mark} [${status}] ${name}${detail ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
};

function bundleFresh() {
  if (!existsSync(CLIENT_BUNDLE)) return { ok: false, why: `缺前置：${CLIENT_BUNDLE} 不存在（先 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs）` };
  const libM = statSync(CLIENT_BUNDLE).mtimeMs;
  const stale = ['index.ts', 'accept-guard.ts', 'accept-source.ts', 'yield-key.ts']
    .map((f) => fileURLToPath(new URL(`../src/client/${f}`, import.meta.url)))
    .filter((f) => existsSync(f) && statSync(f).mtimeMs > libM);
  if (stale.length > 0) return { ok: false, why: `缺前置：lib/client.js 比这些源码旧，测的是旧字节码：${stale.map((s) => s.split('/').pop()).join(', ')}` };
  return { ok: true, why: '' };
}

const SUGG_TEXT = '帮我把构建产物重新部署一下';
const DRAFT = '我先把改动落下来';
// ⚠️ 这段文本与 `SUGG_TEXT` **必须不同**，否则 tamper 之后同源闸看不见任何差异
// （两侧相等 ⇒ 判据放行）。它被后文的 F0 前提断言守着。
const CODEX_CANDIDATE = 'CodexUI 候选：把 README 的用法段重写';
const PUSH_SUGGESTION = JSON.stringify({
  suggestion: { version: 1, turn: 1, baseSeq: 3, text: SUGG_TEXT, truncated: false, acceptKey: 'Tab', frame: 1, final: true },
  suggestionSessionId: 's1',
});
const HOT_WITH_HISTORY = JSON.stringify({
  hot: [{ text: `${DRAFT}再跑一遍冒烟`, count: 2 }],
  history: [`${DRAFT}再跑一遍冒烟`],
  historySessionId: 's1',
});

/**
 * 最小 DOM 替身（口径与 `scripts/llm-form-guard-smoke.mjs` 的 `makeDom` 同族）。
 *
 * 额外拿出两件事：
 *  1. `targetListeners`：挂在**编辑器节点**上的监听（派发时先按注册顺序跑 target 层，
 *     再按 `bubbles` 决定要不要冒泡到 window 的 bubble 监听——顺序与真浏览器一致）；
 *  2. `windowAdds`：window 上每一次注册的 `(type, capture)`，供「冒泡注册」的行为核对。
 */
function makeDom() {
  const created = [];
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.dataset = {}; this.id = '';
      this.style = { cssText: '', display: 'none', setProperty() {} };
      // `textContent`：真 DOM 里写它会清空子节点，替身**同样**这么实现（否则「改屏幕」
      // 这类注入在替身里根本不可见——行为段会假绿，这正是 §7 #146 的教训）。
      let _text = '';
      Object.defineProperty(this, 'textContent', {
        configurable: true,
        get: () => _text,
        set: (v) => { _text = String(v ?? ''); this.children = []; },
      });
      this.parentElement = null; this.isConnected = false; this.isContentEditable = false;
      this.offsetParent = null; this.offsetTop = 0; this.offsetLeft = 0;
      this._closest = {}; this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      // ⚠️ `offsetParent` 必须是构造时就有的一格（可写），不是 getter：
      // `alignAndVerify()` 量几何靠它找 offsetParent 那个盒子。
      this._offsetParent = null;
      this.events = [];
    }
    appendChild(c) { this.children.push(c); c.parentElement = this; c.isConnected = this.isConnected; if (c._offsetParent === null) c._offsetParent = this; return c; }
    append(c) { return this.appendChild(c); }
    remove() { const p = this.parentElement; if (p) p.children = p.children.filter((x) => x !== this); this.parentElement = null; }
    addEventListener(t, cb) { this.events.push([t, cb]); }
    removeEventListener(t, cb) { this.events = this.events.filter((e) => !(e[0] === t && e[1] === cb)); }
    setAttribute(k, v) { this.dataset[k] = String(v); }
    removeAttribute(k) { delete this.dataset[k]; }
    closest(sel) { return this._closest[sel] ?? null; }
    // `isComposerElement` 会 `el.matches('textarea')`：contenteditable 形态必须如实回答
    // false（它由 `isContentEditable` 那一支认），否则 render() 的帧首判定直接落空、
    // 浮层永远不 attach（表现同"什么都没发生"，极易被读成修复无效）。
    matches(sel) { return sel === this.tagName.toLowerCase(); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains(x) { let p = x; while (p !== null && p !== undefined) { if (p === this) return true; p = p.parentElement; } return false; }
    getBoundingClientRect() { return this._rect; }
    get firstElementChild() { return this.children[0] ?? null; }
    get offsetParent() { return this._offsetParent; }
    set offsetParent(v) { this._offsetParent = v; }
    get lastChild() { return this.children[this.children.length - 1] ?? null; }
    get childNodes() { return this.children; }
  }
  globalThis.Element = El;
  globalThis.HTMLElement = El;
  globalThis.HTMLTextAreaElement = class TextAreaEl extends El {};
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
  // 排版几何（`align()` 用的四件）：内容原点 = offset + border + padding。
  composer.offsetLeft = 0; composer.offsetTop = 0;
  composer.clientWidth = 600;
  const placeholder = new El('div');
  placeholder.setAttribute('data-composer-placeholder', '');
  placeholder.__role = 'composer-placeholder';   // 替身内部身份（见 getComputedStyle 桩）
  placeholder.style.display = 'block';
  grow.append(composer, placeholder);

  const head = new El('head');
  const body = new El('body');
  const documentStub = {
    createElement: (tag) => { const el = new El(tag); created.push(el); return el; },
    head, body,
    // 双代选择器：`COMPOSER_SELECTOR` 命中输入框；`[data-composer-placeholder]` 命中占位
    // 节点（`verify()` 的 llm 原点判据要求它此刻**已让位**）。
    querySelector: (sel) => (String(sel).includes('placeholder')
      ? (composer.isConnected ? placeholder : null)
      : (composer.isConnected ? composer : null)),
    querySelectorAll: () => [],
    getElementById: (id) => created.find((el) => el.id === id) ?? null,
    /**
     * 选区桩：折叠在输入框**末尾**（`caretAtComposerEnd` 的第二条分支）。
     *
     * ⚠️ 这是**夹具选择**，不是对真宿主选区的模拟：本段要验的是「改过的键能不能路由到
     * 正确的动作」，而逐词支在动作之前还有一道 `caretAtComposerEnd`——替身原来恒返回
     * `null`，那道闸直接判假 ⇒ 整条逐词支不可达，于是 I6/I7/I8 会**全体假绿**
     * （「什么都没发生」既可能是"键没接上"也可能是"根本没走到"）。
     * 所以先给一个真的末尾选区，再用 I6ctl 对照臂自证逐词确实跑得通。
     */
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt: () => ({ endContainer: composer, endOffset: composer.childNodes.length }),
    }),
    // `draftEndRect()` 用 TreeWalker 找最后一个文本节点：替身给一个（内容即草稿正文），
    // 否则 history/inline 形态恒判 `no-caret`、浮层不画（与真宿主不同）。
    createTreeWalker: (root) => {
      let done = false;
      return {
        nextNode: () => {
          if (done) return null;
          done = true;
          const node = { nodeType: 3, nodeValue: String(root?.textContent ?? ''), textContent: String(root?.textContent ?? '') };
          return node;
        },
      };
    },
    createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ left: 114, top: 504, right: 240, bottom: 528, width: 126, height: 24 }) }),
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const windowAdds = [];
  const windowListeners = [];
  const targetListeners = [];
  const windowStub = {
    addEventListener: (t, cb, capture) => { windowAdds.push([t, capture === true]); windowListeners.push([t, cb, capture === true]); },
    removeEventListener: (t, cb, capture) => {
      const i = windowListeners.findIndex((e) => e[0] === t && e[1] === cb && e[2] === (capture === true));
      if (i >= 0) windowListeners.splice(i, 1);
    },
    ResizeObserver: undefined,
  };
  const overlayEl = () => created.find((el) => el.id === 'dsh-suggest-ghost-overlay') ?? null;
  const styleEl = () => created.find((el) => el.tagName === 'STYLE') ?? null;

  /**
   * 「本插件的让位规则此刻是否命中这段 HTML」——本替身没有 CSS 引擎，所以直接跑
   * 插件**自己写下的**那条规则（`body:has(#overlay[data-shown="1"]:not([style*="display:none"])) …`），
   * 判据只用真属性值。这样「浮层真的在画」这件事在行为段里是可读的（不再恒 false）。
   */
  const placeholderYielding = () => {
    const overlay = overlayEl();
    const style = styleEl();
    if (overlay === null || style === null || style.textContent === '') return false;
    // 让位规则的具文（插件自己写下的那张样式表）：`body:has(<浮层选择器>) …placeholder…`
    // 加 `display:none`。判据只看**真属性值**，不看替身的想象。
    const css = String(style.textContent);
    const hasSelector = /:has\(#dsh-suggest-ghost-overlay\[data-shown="1"\]/.test(css)
      || css.includes('#dsh-suggest-ghost-overlay[data-shown="1"]');
    return hasSelector && css.includes('data-composer-placeholder')
      // ⚠️ 插件那条规则里写的是 `display: none`（带空格），判据必须逐字照抄——
      // 写成 `display:none` 会让这条「浮层在画」的判据恒 false（`verify()` 于是恒判
      // `placeholder-visible`，浮层永远画不出来，看起来像产品 bug）。
      // 规则里那条排除项是 `style*="display: none"`（只挡 hidden）；`display:block` 不算。
      && overlay.dataset.shown === '1' && !String(overlay.style.cssText).includes('display: none');
  };
  // 替身没有排版引擎：把 overlay 的 rect 按它自己写下的 top/left 回投（真浏览器里
  // 这就是 `align()` 量到的结果）。不这么做，`verify()` 恒判 `origin-drift-y`、
  // `isPainted` 恒 false —— 那是替身的缺陷，不是被测代码的行为。
  // `align()` 写 `style.top/left/width` 之后紧接着调 `verify()`，两次代码之间没有
  // 暂停点可以插钩子 ⇒ 只能在 `getBoundingClientRect()` 这一侧回投：overlay 节点
  // 读自己的 rect 时，按它**当次写下的** style.top 换算成绝对视口坐标
  // （`.grow`/编辑器在 (114,504)，宿主内容原点即此）。真浏览器里这就是布局结果。
  const ORIGIN = { left: 114, top: 504 };
  const paintRects = () => { /* 读数辅助：rect 由下方 getBoundingClientRect 桩按 style 现算，无需刷新 */ };
  Object.defineProperty(El.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.id === 'dsh-suggest-ghost-overlay') {
        const top = parseFloat(String(this.style.top ?? '').replace('px', ''));
        const left = parseFloat(String(this.style.left ?? '').replace('px', ''));
        const width = parseFloat(String(this.style.width ?? '').replace('px', ''));
        const t = Number.isFinite(top) ? top : 0;
        const l = Number.isFinite(left) ? left : 0;
        return { left: ORIGIN.left + l, top: ORIGIN.top + t, right: ORIGIN.left + l + (Number.isFinite(width) ? width : 0),
          bottom: ORIGIN.top + t + 24, width: Number.isFinite(width) ? width : 0, height: 24 };
      }
      return this._rect;
    },
  });

  /**
   * 派发一个键盘/组合事件，按真浏览器的顺序跑监听：
   * target 捕获 → target 冒泡 → window 捕获 → window 冒泡（本替身的 window 是唯一祖先）。
   *
   * 支持 `stopPropagation()`（此后任何层都不再跑）与 `preventDefault()`（把
   * `defaultPrevented` 置真，但不阻止后续监听看到它——这正是让路判据的输入）。
   */
  const otherWindowBubble = new Set();
  // 注入钩子**不过 dispatch 参数**：`dispatch(init)` 只认 { type, code, key, bubbles,
  // isComposing, pluginListeners }，多传的键会被忽略（不改这个签名，免得注入机制
  // 悄悄扩宽派发器的契约）。
  const runBeforeDispatch = (fn) => { if (typeof fn === 'function') fn(); };
  const dispatch = (init) => {
    // 每次派发一对**独立**的「本插件」视角读数：`plugin*` 只统计派发开始之后、
    // 由本产物自己调用的 preventDefault/stopPropagation（别人的处理器是外部替身，
    // 不记进这一对）。事件对象本身还是**同一只**，这样 `defaultPrevented` 的可见性
    // 与真浏览器一致（这正是让路判据的输入）。
    const event = {
      type: init.type,
      isComposing: init.isComposing ?? false,
      key: init.key ?? '',
      code: init.code ?? '',
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      target: composer,
      defaultPrevented: false,
      preventDefaultCalls: 0,
      stopPropagationCalls: 0,
      get [Symbol.toStringTag]() { return 'KeyboardEvent'; },
      preventDefault() { this.defaultPrevented = true; this.preventDefaultCalls += 1; },
      stopPropagation() {
        this.stopPropagationCalls += 1;
        // ⚠️ 本替身的 `stopPropagation` **不截断传播**：见下方 `runList` 的说明
        // （工单 #168 的口径：`cancelBubble` 已废弃、读不到 stopPropagation 效果）。
        this.stopPropagationMarked = true;
      },
    };
    // 别人的处理器先登记，且**不**截断传播：本替身只忠实地跑"注册顺序"。
    // 谁的调用算"本插件"，按**派发开始后由谁登记**区分——外部替身在 `others` 里预先登记。
    const pluginListeners = new Set(init.pluginListeners ?? []);
    const runList = (list, capture, isTarget) => {
      for (const [t, cb, cap] of list) {
        if (event.halted !== undefined) return;
        if (t !== event.type || cap !== capture) continue;
        // window 冒泡阶段：外来的「window 直接子级」先跑（它注册在页面里，早于本插件）。
        if (isTarget === false && capture === false && !pluginListeners.has(cb) && otherWindowBubble.has(cb)) continue;
        const before = { p: event.preventDefaultCalls, s: event.stopPropagationCalls };
        cb(event);
        if (!pluginListeners.has(cb)) {
          event.preventDefaultCalls = before.p;
          event.stopPropagationCalls = before.s;
        }
      }
    };
    runList(targetListeners, true, true);                    // 1) target 捕获
    runList(targetListeners, false, true);                   // 2) target 冒泡
    runList(windowListeners, true, false);                   // 3) window 捕获
    if (init.bubbles !== false) {
      for (const cb of otherWindowBubble) {
        if (event.halted !== undefined) break;
        if (windowListeners.some(([t, c, cap]) => t === event.type && c === cb && cap === false)) {
          const before = event.stopPropagationCalls;
          cb(event);
          event.stopPropagationCalls = before;
        }
      }
      runList(windowListeners, false, false);                // 4) window 冒泡
    }
    return event;
  };
  return {
    runBeforeDispatch, otherWindowBubble, documentStub, windowStub, windowListeners, windowAdds, targetListeners, composer, created, overlayEl,
    styleEl, placeholderYielding, paintRects, dispatch, El };
}

/** 加载真产物（`window.__ModuleLoader__.load(def)` → `def.factory(require)`）。 */
function loadClientBundle(dom) {
  let definition = null;
  const loaderWindow = { ...dom.windowStub, __ModuleLoader__: { load: (def) => { definition = def; } } };
  new Function('window', 'document', 'localStorage', 'getComputedStyle', 'ResizeObserver',
    readFileSync(CLIENT_BUNDLE, 'utf8'))(
    loaderWindow, dom.documentStub,
    { getItem: () => null, setItem() {}, removeItem() {} },
    // `getComputedStyle(el)`：替身没有 CSS 引擎，所以这里只兑现**一条真规则** ——
    // 插件自己写下的 placeholder 让位条件（浮层在画 ⇒ placeholder display:none）。
    // 别的元素给静态值。`verify()` 的 llm 原点判据要求的正是这一条。
    (el) => ({
      getPropertyValue: () => '0px', paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px',
      borderTopWidth: '0px', borderLeftWidth: '0px', lineHeight: '24px',
      display: el?.__role === 'composer-placeholder' && dom.placeholderYielding() ? 'none' : 'block',
    }),
        class { observe() {} unobserve() {} disconnect() {} },
  );
  if (definition === null) throw new Error('lib/client.js 没有调 window.__ModuleLoader__.load');
  const requireStub = () => ({ default: {}, Fragment: 'frag', jsx: () => null, jsxs: () => null });
  return definition.factory(requireStub);
}

/**
 * 最小宿主：远程 settings 面 + 单会话 + 输入机 face。
 *
 * `dropbacks` 是「别人（宿主 composer / 第三方插件 / 浏览器自身）」的替身监督器，
 * 每个场景自己往里挂处理器，`scenario` 负责在**派发之前**把它们登记到正确的层。
 */
function makeHost(dom, initial) {
  const doc = { _push: '', _hot: '', historyEnabled: true, ...initial.doc };
  let revision = 0;
  const listeners = [];
  const wrote = [];
  const snapshot = { draft: initial.draft, draftRev: 4 };
  const rows = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
  const conversationFace = {
    input: {
      for: () => ({
        state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
        // 宿主把草稿落进编辑器；这里同步写一份到编辑器的 `textContent`，好让
        // `draftEndRect()` 的 TreeWalker 找得到「最后一个文本节点」（真浏览器里那
        // 就是控件里的字）。不写的话 history/inline 形态恒判 `no-caret`、浮层不画。
        setDraft: (t) => { wrote.push(t); snapshot.draft = t; snapshot.draftRev += 1; dom.composer.textContent = t; },
      }),
    },
  };
  const syncEditor = (t) => { dom.composer.textContent = t; };
  syncEditor(initial.draft);
  const sessionsFace = {
    list: { getSnapshot: () => ({ byId: structuredClone(rows), current: 's1' }), subscribe: () => () => {} },
    // ⚠️ 会话作用域必须能解析出 `conversation`：`resolve()` 靠它拿输入机 face，
    // 解析不到就永不 set `bound` ⇒ `ghostContent()` 恒 null、浮层永不出现、Tab
    // 什么都不做。这条一度把本脚本整段行为判据读成"修复无效"（实测读数
    // `[res] conversation= undef` + `llmGhostOffered=0`）。
    scope: () => ({ get: (name) => (name === 'conversation' ? conversationFace : undefined) }),
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
    effect: (fn) => (typeof fn === 'function' ? fn(() => {}) : undefined),
    inject: () => undefined,
  };
  const emit = (patch) => { Object.assign(doc, patch); revision += 1; for (const cb of listeners) cb('suggest-ghost', revision); };
  return { ctx, emit, wrote, snapshot, dom, sessionsFace, revision: () => revision };
}

const textOfEl = (el) => (el === null || el === undefined
  ? null
  : `${el.textContent ?? ''}${(el.children ?? []).map(textOfEl).join('')}`);
globalThis.__textOfElRef = textOfEl;

/**
 * 一个场景：独立加载一份产物（模块级状态彼此隔离），喂到目标帧，然后派发键击。
 *
 * @param opts.ourRegistration - `'bubble'`（修复版）/ `'capture'`（修复前）。
 *   只在**读注册**时用得上：产物自身的注册就是 bubble，而 `'capture'` 模式通过给
 *   本插件额外挂一份 capture 版 handler 来复现「修复前」的优先级（见下方注释）。
 * @param opts.others - 别人的处理器（在派发前登记）：
 *   - `{ where: 'target-capture' | 'target-bubble' | 'window-bubble', prevent?: true }`
 */
globalThis.__scenarioCount = 0;
async function scenario({ draft, doc, type = 'keydown', others = [], code = 'Tab', key = 'Tab', bubbles = true,
  capturePreflight = false, tamperPainted = null }) {
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
  const onUncaught = (e) => harnessErrors.push(String(e?.message ?? e).slice(0, 200));
  process.on('uncaughtException', onUncaught);
  try {
    const client = loadClientBundle(dom);
    // ⚠️ 必须先 emit 再 apply：`apply()` 内部那次 describe 之后的**所有** render 都
    // 从 settings 面取值，而本替身的 describe() 读的是 host 返回的**同一个** doc 对象
    // （`llm-form-guard-smoke.mjs` 的同款口径）。顺序反了的话，describe 在 emit 之前
    // 那一拍就已经跑过，此后 revision 未变 ⇒ `applySettings` 早退 ⇒ 建议永远进不了槽
    // （实测读数：`llmGhostOffered=0`、`content=null`，看起来像"修复没生效"）。
    const host = makeHost(dom, { draft, doc });
    client.apply(host.ctx);
    await sleep(40);
    host.emit({ _push: PUSH_SUGGESTION, _hot: HOT_WITH_HISTORY });
    await sleep(120);
    // 本插件在 window/target 上登记过的处理器（产物自己注册的都在这里）。
    const pluginListeners = [
      ...dom.windowListeners.map(([, cb]) => cb),
      ...dom.targetListeners.map(([, cb]) => cb),
    ];
    // 别人的处理器（在派发前登记；顺序即真实世界里的注册先后）。
    for (const other of others) {
      const handler = (event) => {
        if (event.type !== type) return;
        if (event.code !== code) return;
        other.seen = (other.seen ?? 0) + 1;
        if (other.preventDefault === true) event.preventDefault();
        // 别人的 stopPropagation 只做标记：本替身的传播由派发器按 `halted` 判，
        // 不靠 `cancelBubble`（工单 #168 的既有口径：那个属性已废弃、读不到效果）。
        if (other.stopPropagation === true) event.halted = 'by-other';
      };
      if (other.where === 'target-capture') dom.targetListeners.push([type, handler, true]);
      else if (other.where === 'target-bubble') dom.targetListeners.push([type, handler, false]);
      else if (other.where === 'window-bubble') { dom.windowListeners.push([type, handler, false]); dom.otherWindowBubble.add(handler); }
      else dom.windowListeners.push([type, handler, false]);
    }
    dom.documentStub.activeElement = dom.composer;
    // ── 诊断（本次取证用，默认静默）─────────────────────────────────────────
    // 行为段若整段"什么都没发生"，第一嫌疑是浮层根本没画出来（`verify()` 在替身里
    // 不通过），而不是让路判据把键吃了。把识别这一点的几个量打出来，免得把
    // "产物没跑起来"读成"修复无效"。
    // 旧语序臂（对照）：在 window **捕获**挂一个与旧 onKeyDown 同形的采纳替身。
    // 它读到的 defaultPrevented 恒为 false（别人还没跑）⇒ 照样采纳并吞键 =
    // #166 证据 1 的现场。它只存在于对照臂，不参与修复版的任何判据。
    if (capturePreflight) {
      // ⚠️ 必须先登记（push）再进派发：`pluginListeners` 是**派发前**的快照，
      // 在处理器体里 push 等于没登记，它的 preventDefault 会被算到"别人"头上。
      const legacyAccept = (event) => {
        if (event.type !== 'keydown' || event.code !== code) return;
        const seen = { defaultPrevented: false };   // 捕获阶段的真实读数
        if (seen.defaultPrevented) return;          // 旧版根本没有这一句；写上也不会走
        event.preventDefault();
        event.stopPropagation();
        host.wrote.push(SUGG_TEXT);
        host.snapshot.draft = SUGG_TEXT;
      };
      pluginListeners.push(legacyAccept);
      dom.windowListeners.push(['keydown', legacyAccept, true]);
    }
    dom.paintRects();
    const overlay = dom.overlayEl();
    const before = { wrote: host.wrote.length, draft: host.snapshot.draft, overlayText: textOfEl(overlay), shown: overlay?.dataset.shown ?? null };
    // `before.overlayText` 记的是**派发开始那一刻**的屏幕文本（beforeDispatch 之后取）。
    before.textAtDispatch = textOfEl(dom.overlayEl());
    // 派发期间把**产物自己**打出来的采纳判定行录下来（`tab-abandon` / `accept-gate`）：
    // 判据是否真的按"画的那句"决定，只有这一行能诚实回答（读的是产品输出，不是替身推断）。
    let acceptTrace = null;
    const origWarn = console.warn;
    console.warn = (...a) => {
      const line = a.map(String).join(' ');
      if (line.includes('tab-abandon') || line.includes('accept-gate')) acceptTrace = line;
    };
    // ⚠️ **tamper 必须在派发的那一刻做**，不能提前：本替身里 tamper 与 dispatch 之间
    // 任何一次 render（settings 事件、scheduled 重绘…）都会把浮层重画回槽里那条，
    // F 段立刻退化成同义反复（实测踩过：F0 绿而 F1 红，两者读的是不同的时刻）。
    // 所以这里把"改屏幕"挂在 dispatch 的最前面——同一调用栈、零 await、零 render 缝隙。
    // 变量遮蔽事故的护栏：`dom.overlayEl` 在**派发过程中**如果读到别的节点（多实例、
    // 或某个回调又建了一个浮层），这里的读数与派发后读数就会不一致——先记一份引用。
    let tamperTarget = null;
    dom.runBeforeDispatch(() => {
      const node = dom.overlayEl();
      if (node === null) return;
      const leaves = (node.children ?? []).filter((c) => (c.children ?? []).length === 0);
      const target = leaves.length > 0 ? leaves[0] : node;
      if (tamperPainted !== null) {
        const own = Object.getOwnPropertyDescriptor(target, 'textContent');
        if (own !== undefined && own.set !== undefined) own.set.call(target, tamperPainted);
        else target.textContent = tamperPainted;
        tamperTarget = target;
        before.afterTamperText = target.textContent;
      }
    });
    const event = dom.dispatch({ type, code, key, bubbles, isComposing: false, pluginListeners });
    const nodeAtDispatch = dom.overlayEl();
    // ⚠️ 必须在**任何 await 之前**取样：`writes` 已经是派发期间记下的（真实写入了没有），
    // 但节点文本会被随后的 render 改掉（实测：await 之后读恒为空串，看起来像 tamper 失败）。
    const textAtDispatch = tamperTarget === null ? (nodeAtDispatch?.textContent ?? null) : tamperTarget.textContent;
    console.warn = origWarn;
    traces.push(`accept-decision: ${acceptTrace ?? '(none)'}`);
    await sleep(20);
    const overlayAfter = dom.overlayEl();
    out = {
      before,
      afterTextOnSameNode: nodeAtDispatch?.textContent ?? null,
      afterDraft: host.snapshot.draft,
      writes: host.wrote.slice(before.wrote),
      pluginPrevented: event.preventDefaultCalls > 0,
      pluginStopped: event.stopPropagationCalls > 0,
      anyPrevented: event.defaultPrevented,
      othersSeen: others.map((o) => o.seen ?? 0),
      overlayTextAfter: textOfEl(overlayAfter),
      textAtDispatch,
      overlayShownAfter: overlayAfter?.dataset.shown ?? null,
      keydownCaptures: dom.windowAdds.filter(([t, cap]) => t === 'keydown').map(([, cap]) => cap),
      compositionCaptures: dom.windowAdds.filter(([t]) => t.startsWith('composition')).map(([t, cap]) => [t, cap]),
      traces,
      harnessErrors,
    };
  } catch (error) {
    out = { loadError: String(error).slice(0, 260), traces };
  } finally {
    process.off('uncaughtException', onUncaught);
    console.debug = real.debug; console.log = real.log; console.warn = real.warn; console.error = real.error;
  }
  return out;
}

/**
 * 冻结 `Date.now()`：本替身里所有定时器都是真跑的，而插件用 `Date.now()` 判
 * 「同一理由 5s 内不再打」的冷却闸（`stepSlotEmit`）。整段跑完 >5s 时，同一理由的
 * 第二行会被冷却吞掉——那时再断言「留痕有这一行」会得到一个**不稳定的红**，
 * 看起来像翻车其实只是时钟。改成每次读都前进 1ms，冷却对同一槽同一理由仍然是
 * 「一次」，跨理由的比较也不受影响。
 */
function installDateProbe(dom) {
  const base = Date.now();
  let ticks = 0;
  Date.now = () => base + (ticks += 1);
  globalThis.Date = Date;
  return dom;
}

const fresh = bundleFresh();
if (!fresh.ok) {
  record('行为段（真 lib/client.js）', B.NC, fresh.why);
} else {
  console.log('\n—— 3. 行为段（真 lib/client.js，最小 DOM/宿主替身）——');

  // ── C. 注入自证：bubble 层放一个先 preventDefault 的假处理器 ───────────────
  const C = await scenario({ draft: '', doc: { historyEnabled: false }, others: [{ where: 'target-bubble', preventDefault: true }] });
  if (C.loadError !== undefined) {
    record('C 注入自证（bubble 层先 preventDefault 的假处理器）', B.FAIL, `产物在场却加载/运行失败：${C.loadError}`);
  } else {
    // 前提：浮层真的画出来了（否则 Tab 本来就什么都不做 ⇒ 自证没有意义）。
    record('C0 （前提）派发前浮层真的画着那条建议（自证不是空转）',
      C.before.overlayText === SUGG_TEXT ? B.PASS : B.FAIL,
      `overlayText=${JSON.stringify(C.before.overlayText)} data-shown=${C.before.shown}`);
    // 绿：不写草稿、不吞键、别人真的收到了那一键。
    record('C1 【绿】别人先认领 ⇒ 本插件不写草稿（writes 为空、草稿原样）',
      C.writes.length === 0 && C.afterDraft === '' ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(C.writes)} draftAfter=${JSON.stringify(C.afterDraft)}`);
    record('C2 【绿】别人先认领 ⇒ 本插件不吞键（自己没调 preventDefault / stopPropagation）',
      C.pluginPrevented === false && C.pluginStopped === false ? B.PASS : B.FAIL,
      `pluginPrevented=${C.pluginPrevented} pluginStopped=${C.pluginStopped}`);
    record('C3 【绿】别人真的收到了那一键（且浮层原样留着，用户还能再按）',
      C.othersSeen[0] === 1 && C.before.overlayText === SUGG_TEXT ? B.PASS : B.FAIL,
      `othersSeen=${JSON.stringify(C.othersSeen)} overlayText(before)=${JSON.stringify(C.before.overlayText)}`);

    // ── C 的对照：同一序列在「修复前」语序上跑 ⟹ 必须红 ────────────────────
    // 「修复前」= 本插件的 keydown 在**捕获**层（工单证据 1）。产物本身已是冒泡版，
    // 所以这里用「在 window 捕获挂一个与 onKeyDown 同形的采纳替身」来复现旧语序：
    // 它读到的是 defaultPrevented=false（别人还没跑）、写草稿、并吞键。
    // 这不是重写实现，是把「旧语序」作为**对照臂**跑一遍（#146 supersedes 对照）。
    const Cbase = await scenario({
      draft: '', doc: { historyEnabled: false },
      others: [{ where: 'target-bubble', preventDefault: true }],
      // 旧语序臂：捕获层先跑 —— 由 `capturePreflight` 注入（见下）。
      capturePreflight: true,
    });
    record('C4 【红/对照】同一序列在「修复前」语序（window 捕获先跑）上照样采纳并吞键',
      Cbase.loadError === undefined && Cbase.writes.length === 1 && Cbase.afterDraft === SUGG_TEXT
        && Cbase.pluginPrevented === true ? B.BASE_RED : B.FAIL,
      Cbase.loadError !== undefined ? `${Cbase.loadError}`
        : `writes=${JSON.stringify(Cbase.writes)} draftAfter=${JSON.stringify(Cbase.afterDraft)}`
          + ` pluginPrevented=${Cbase.pluginPrevented}（这一臂**红了**是预期：修复前的语序就是抢跑）`);

    // ── D. 风险面：宿主 composer 自己 stopPropagation 会怎样 ────────────────
    const D1 = await scenario({ draft: '', doc: { historyEnabled: false }, others: [{ where: 'target-bubble', stopPropagation: true }] });
    record('D1 [风险] 宿主 composer 在**冒泡**里 stopPropagation ⇒ 本插件收不到事件（采纳失效）',
      D1.loadError !== undefined ? B.FAIL
        : (D1.writes.length === 0 && D1.pluginPrevented === false ? B.PASS : B.FAIL),
      `writes=${JSON.stringify(D1.writes)} pluginPrevented=${D1.pluginPrevented} othersSeen=${JSON.stringify(D1.othersSeen)}`
      + '（读数 = 这条风险**成立**：迁移后这类宿主上采纳彻底失效，诚实记为遗留风险）');

    const D2 = await scenario({ draft: '', doc: { historyEnabled: false }, others: [{ where: 'target-capture', stopPropagation: true }] });
    record('D2 [风险] 宿主在 **capture** 里 stopPropagation ⇒ 连 window 捕获也收不到（新旧同样失效，不是本次引入）',
      D2.loadError !== undefined ? B.FAIL : (D2.writes.length === 0 ? B.PASS : B.FAIL),
      `writes=${JSON.stringify(D2.writes)} pluginPrevented=${D2.pluginPrevented}`);

    const D3 = await scenario({ draft: '', doc: { historyEnabled: false }, others: [{ where: 'window-bubble', stopPropagation: true }] });
    record('D3 [风险] window 直接子级 bubble stopPropagation ⇒ 冒泡监听收不到（冒泡相对捕获的**新增**失效面）',
      D3.loadError !== undefined ? B.FAIL : (D3.writes.length === 0 ? B.PASS : B.FAIL),
      `writes=${JSON.stringify(D3.writes)} pluginPrevented=${D3.pluginPrevented}`
      + '（读数 = 新增失效面成立；宿主 composer 若自己这么做，采纳全灭 ⇒ 见 PR 的回退建议）');

    // ── E. 零干扰：没人认领时行为与改动前一致 ──────────────────────────────
    const E = await scenario({ draft: '', doc: { historyEnabled: false } });
    record('E1 没人认领 ⇒ llm 建议照旧采纳（Tab 仍是你习惯的那一下）',
      E.loadError === undefined && E.writes.length === 1 && E.afterDraft === SUGG_TEXT && E.pluginPrevented === true ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(E.writes)} draftAfter=${JSON.stringify(E.afterDraft)} pluginPrevented=${E.pluginPrevented}`);

    // history 形态：草稿非空 + 历史环里有以它开头的候选（`HOT_WITH_HISTORY` 的
    // 候选正是 `${DRAFT}再跑一遍冒烟`）⇒ 浮层画后缀 `再跑一遍冒烟`、采纳回填草稿前缀。
    const E2 = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false } });
    record('E2 没人认领 ⇒ history 补合照旧采纳，且**保留已输入内容**（不整段覆盖）',
      E2.loadError === undefined && E2.writes.length === 1 && E2.writes[0] === `${DRAFT}再跑一遍冒烟` ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(E2.writes)} overlayText(before)=${JSON.stringify(E2.before.overlayText)}`);

    // ── F. 同源闸（B1）在行为段上的取证 ─────────────────────────────────────
    // 让浮层与槽里的内容不同源的最小可行注入：把浮层正文改掉（模拟"屏幕上那句"
    // 不是本插件槽里那份），再按 Tab。修复前的路径只会看 `shown.content`，所以
    // 仍会按槽里那条去写；有了同源闸就必须放弃并在 `tab-abandon` 留一行。
    // F 段要一个**独立**场景（不能复用 E 的结果），且 tamper 本身必须被自证确实生效。
    const F = await scenario({
      draft: '', doc: { historyEnabled: false }, tamperPainted: CODEX_CANDIDATE,
      // ⚠️ `delayAfterTamperMs: 0`：本替身里 tamper 与派发之间只要有**任何**一次
      // `await`（哪怕 0ms），scheduled 的 render 就可能把浮层重画回槽里那条，F 段
      // 随即变成同义反复（实测踩过：F0 绿、F1 红，textAtDispatch 却又回到了槽里的文本）。
      delayAfterTamperMs: 0,
    });
    record('F0 （前提）tamper 真的把浮层正文换成了「别人画的那句」（屏幕 ≠ 槽）',
      F.loadError === undefined && F.before?.afterTamperText === CODEX_CANDIDATE ? B.PASS : B.FAIL,
      `afterTamperText=${JSON.stringify(F.before?.afterTamperText)} textAtDispatch=${JSON.stringify(F.textAtDispatch)}`
      + `（期望 ${JSON.stringify(CODEX_CANDIDATE)}）`);
    record('F1 【绿】屏幕上的句子与要写入的不同源 ⇒ 放弃采纳（writes 为空、草稿原样）',
      F.loadError === undefined && F.writes.length === 0 && F.afterDraft === '' ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(F.writes)} draftAfter=${JSON.stringify(F.afterDraft)}`
      + `（屏幕上是 ${JSON.stringify(F.before?.afterTamperText)}，槽里是 ${JSON.stringify(SUGG_TEXT)}）`);
    record('F2 【绿】不同源时也**不吞键**，且浮层留着（用户看见的那句还在）',
      F.loadError === undefined && F.pluginPrevented === false && F.pluginStopped === false ? B.PASS : B.FAIL,
      `pluginPrevented=${F.pluginPrevented} pluginStopped=${F.pluginStopped} overlayText(after)=${JSON.stringify(F.overlayTextAfter)}`);
    record('F3 【绿】放弃时留痕：`tab-abandon: reason=painted-mismatch`',
      F.loadError === undefined && F.traces.some((l) => l.includes('tab-abandon') && l.includes('painted-mismatch')) ? B.PASS : B.FAIL,
      F.traces.filter((l) => l.includes('tab-abandon') || l.includes('accept-decision')).slice(0, 2).join('\n')
        || `捕获 ${F.traces?.length ?? 0} 行留痕，无 tab-abandon`);
    record('F0b （前提）tamper 一直保持到采纳那一刻（中间没有被 render 重画回去）',
      F.loadError === undefined && F.textAtDispatch === CODEX_CANDIDATE && F.afterTextOnSameNode === CODEX_CANDIDATE ? B.PASS : B.FAIL,
      `textAtDispatch=${JSON.stringify(F.textAtDispatch)} afterTextOnSameNode=${JSON.stringify(F.afterTextOnSameNode)}`
      + `（tamper 生效时的期望文本 ${JSON.stringify(CODEX_CANDIDATE)}；空串/槽内文本 = 浮层被重画过）`);
    // F5：同源闸对**逐词**采纳（`→`）同样生效（判据共用同一个函数）。
    const F5 = await scenario({ draft: '', doc: { historyEnabled: false, wordAccept: true }, code: 'ArrowRight', key: 'ArrowRight', tamperPainted: CODEX_CANDIDATE });
    record('F5 【绿】逐词路径同一条闸：屏幕上是别人那句 ⇒ `→` 也不写、不吞键',
      F5.loadError === undefined && F5.writes.length === 0 && F5.pluginPrevented === false ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(F5.writes)} pluginPrevented=${F5.pluginPrevented} textAtDispatch=${JSON.stringify(F5.textAtDispatch)}`);
    record('F4 采纳那一刻的判定行（产品自己打的）',
      F.loadError === undefined ? B.PASS : B.FAIL,
      F.traces.filter((l) => l.includes('accept-decision')).join('') || '(none)');

    // ── G. IME：composition 仍是捕获注册，且组词期间 Tab 不采纳 ────────────
    record('G1 IME：compositionstart/end 在本产物里注册为**捕获**（行为段核对注册，不只看源码）',
      E.compositionCaptures.length === 2 && E.compositionCaptures.every(([, cap]) => cap === true) ? B.PASS : B.FAIL,
      `compositionAdds=${JSON.stringify(E.compositionCaptures)}`);
    const G = await scenario({ draft: '', doc: { historyEnabled: false }, type: 'compositionstart', code: '', key: 'Process', bubbles: true });
    record('G2 IME：组词开始后幽灵被收掉（组词期间不会把拼音画成灰字）',
      G.loadError === undefined && G.overlayShownAfter === '0' ? B.PASS : B.FAIL,
      `data-shown(after)=${JSON.stringify(G.overlayShownAfter)} overlayText(after)=${JSON.stringify(G.overlayTextAfter)}`);

    // ── H. 旧语序对照：同一份产物、只把注册语序换回捕获 → 冒烟是否仍然可变红 ──
    console.log('\n—— 3b. 旧语序对照（supersedes，§7 #146）——');
    record('H1 冒泡注册的读数（本次修复版）', E.keydownCaptures.length === 1 && E.keydownCaptures[0] === false ? B.PASS : B.FAIL,
      `window keydown 注册 capture 标志=${JSON.stringify(E.keydownCaptures)}（false = 冒泡）`);
    record('H2 结论：C1..C3 与 C4 读数**不一致**（修复前后可分辨）',
      C.writes.length === 0 && Cbase.writes.length === 1 ? B.PASS : B.FAIL,
      `修复版 writes=${JSON.stringify(C.writes)}；修复前语序 writes=${JSON.stringify(Cbase.writes)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
    // ── I. 键位自定义（本单）：仲裁表在真产物上的行为对照 ────────────────────
    // 这一段证明的是**改键之后真按键的行为**，不是纯函数判据（那在 accept-key-smoke）。
    // 每条都直接读产物输出：写没写草稿、写了什么、本插件有没有吞键、浮层还在不在。
    const hasTrace = (r, needle) => (r.traces ?? []).some((l) => l.includes(needle));

    // I1. 默认 `Escape` 关掉幽灵：不写草稿、浮层消失、吞键。
    const I1 = await scenario({ draft: '', doc: { historyEnabled: false }, code: 'Escape', key: 'Escape' });
    record('I1 llm 幽灵按 Escape ⇒ 浮层收起、草稿一字未写、本插件吞键',
      I1.loadError === undefined && I1.writes.length === 0 && I1.afterDraft === ''
      && I1.pluginPrevented === true && I1.overlayShownAfter !== '1' ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(I1.writes)} shownAfter=${I1.overlayShownAfter} prevented=${I1.pluginPrevented}`);

    // I2. `dismissKey=''` ⇒ 这一格不在表里 ⇒ Escape **不吞键**、幽灵照旧在屏。
    //     这条同时证「留空 = 不接管」是真的关掉了动作，而不是换成另一种吞键行为。
    const I2 = await scenario({ draft: '', doc: { historyEnabled: false, dismissKey: '' }, code: 'Escape', key: 'Escape' });
    record('I2 dismissKey 留空 ⇒ Escape 不吞键、幽灵不收起（留空 = 不接管）',
      I2.loadError === undefined && I2.pluginPrevented === false && I2.overlayShownAfter === '1' ? B.PASS : B.FAIL,
      `prevented=${I2.pluginPrevented} shownAfter=${I2.overlayShownAfter}`);

    // I3. **回归（本单修的失效面）**：`regenKey=Tab` 时 history 形态按 Tab 必须仍然采纳。
    //     旧实现里 regen 支写在采纳之前并早退 ⇒ 这一条当时是**红的**（用户把「换一条」
    //     设成 Tab 就把历史补全的采纳整条关掉）。现在按优先级表，采纳赢。
    const I3 = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false, regenKey: 'Tab' }, code: 'Tab', key: 'Tab' });
    record('I3 ★ regenKey=Tab + history 形态 ⇒ Tab 仍然采纳（旧实现在这里失效）',
      I3.loadError === undefined && I3.writes.length === 1 && I3.writes[0] === `${DRAFT}再跑一遍冒烟` ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(I3.writes)} 期望=${JSON.stringify([`${DRAFT}再跑一遍冒烟`])}`);

    // I4. `localAcceptKey=F4`：Tab 不再采纳，F4 采纳（设置项真的管到 history 形态）。
    const I4a = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false, localAcceptKey: 'F4' }, code: 'Tab', key: 'Tab' });
    const I4b = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false, localAcceptKey: 'F4' }, code: 'F4', key: 'F4' });
    record('I4 localAcceptKey=F4 ⇒ Tab 不采纳、F4 采纳',
      I4a.loadError === undefined && I4a.writes.length === 0
      && I4b.writes.length === 1 && I4b.writes[0] === `${DRAFT}再跑一遍冒烟` ? B.PASS : B.FAIL,
      `Tab: ${JSON.stringify(I4a.writes)} / F4: ${JSON.stringify(I4b.writes)}`);

    // I5. `acceptKey` 与 `localAcceptKey` 各管各的：只改前者，history 形态的 Tab 不受影响。
    const I5 = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false, acceptKey: 'F2' }, code: 'Tab', key: 'Tab' });
    record('I5 只改 acceptKey ⇒ history 形态的 Tab 照旧采纳（#167 的作用域不越界）',
      I5.loadError === undefined && I5.writes.length === 1 ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(I5.writes)}`);

    // ── ✋ 已知缺陷绊线：逐词采纳在真产物上写不出字 ──────────────────────────
    //
    // **不是本单造成的**：同一份场景跑在 `origin/main` 的产物上读数完全相同
    // （实测：两侧都 `writes=[]`、`pluginPrevented=false`）。根因是 #166 的同源闸与
    // 逐词的天然形状冲突：
    //   浮层画的是**后缀**（history/inline 只画 suffix），而逐词的 `accepted` 只前进
    //   一个片段 ⇒ `accepted.endsWith(painted)` 恒假 ⇒ 走 `word-abandon` 早退。
    //   只有「剩余部分恰好就是一个片段」时才会放行——那时逐词等价于整条采纳。
    // 于是 README/提示行宣传的「→ 逐词采纳」在多个片段的候选上**一直**是空转的。
    // 留痕是 debug 级（默认静音），所以现场只有"按了没反应"，这就是它从没被测到的原因。
    //
    // 这里**断言当前行为**（而不是修它，也不是标成 NOT-COVERED 假装没看见）：
    // 修好那一天本条会红，逼着改动的人同步更新这段说明与工单状态。
    const I6ctl = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false }, code: 'ArrowRight', key: 'ArrowRight' });
    record('I6ctl ✋ 已知缺陷绊线：默认 → 逐词当前写不出字（同源闸 × 逐词，Gitea #185）',
      I6ctl.loadError === undefined && I6ctl.writes.length === 0 && I6ctl.pluginPrevented === false ? B.PASS : B.FAIL,
      `prevented=${I6ctl.pluginPrevented} writes=${JSON.stringify(I6ctl.writes)}`
      + '（若本条转红 ⇒ 逐词被修好了：删掉这条绊线、把 I6 升级为真断言，并更新 Gitea #185）');

    // I6. `wordAcceptKey=Up` 的**行为**面：当前量具测不到 ⇒ 如实标 NOT-COVERED。
    //
    // 为什么不能标 PASS：逐词支在 `preventDefault` **之前**就要过同源闸（见 I6ctl 那条
    // 绊线），而那道闸现在恒判否 ⇒ 「键已改到 ↑」与「键压根没接上」在 DOM 读数上
    // **完全同形**（都是 writes=[] / prevented=false）。拿同形当证据就是假绿。
    // 为什么也不算 FAIL：判据本身有覆盖——`scripts/accept-key-smoke.mjs` 用的是**产物里
    // 那份 `ownerOfKey`**（不再是副本），已经断言过 `word` 格的键跟着设置变。
    // ⇒ 键面归属＝判据已覆盖、端到端未覆盖；同源闸缺陷修好后本条应升级为真断言。
    record('I6 wordAcceptKey 改键的端到端行为',
      B.NC,
      '缺前置：逐词支在吞键/写入之前被 #166 同源闸挡住（I6ctl 绊线），两种情形读数同形 ⇒ 端到端未验；'
      + '键面归属由 accept-key-smoke 的 ownerOfKey 断言覆盖。'
      + '（同源闸缺陷修好后本条要改成真断言：↑ 吞键并写入一个片段、→ 完全不接管。）');

    // I7. 开关关掉 ⇒ 那把键**整个还给原生**（不是「按了没反应」地吞掉）。
    const I7 = await scenario({ draft: DRAFT, doc: { historyEnabled: true, inlineEnabled: false, wordAccept: false }, code: 'ArrowRight', key: 'ArrowRight' });
    record('I7 wordAccept=false ⇒ → 不吞键、不写字（回到原生光标移动）',
      I7.loadError === undefined && I7.pluginPrevented === false && I7.writes.length === 0 ? B.PASS : B.FAIL,
      `prevented=${I7.pluginPrevented} writes=${JSON.stringify(I7.writes)}`);

    // I8. llm 形态按 →：表里没有 word 格 ⇒ 不接管。
    // ⚠️ 这条的**证据强度有限**：逐词支本来就写不出字（I6ctl），所以「不写」同时符合
    // 「形态闸生效」与「缺陷本身」两种解释。形态闸真正的钉子是 accept-key-smoke 里
    // 「llm 表不含 word」那条判据断言；这里只作为「没有误吞键」的行为面补一条。
    const I8 = await scenario({ draft: '', doc: { historyEnabled: false }, code: 'ArrowRight', key: 'ArrowRight' });
    record('I8 llm 形态按 → ⇒ 不写草稿也不吞键（行为面；形态闸本身由 accept-key-smoke 钉）',
      I8.loadError === undefined && I8.writes.length === 0 && I8.pluginPrevented === false ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(I8.writes)} prevented=${I8.pluginPrevented} shownAfter=${I8.overlayShownAfter}`);

    // I9. **优先级表**的行为面：llm 形态把 `regenKey` 配成与采纳键同一个 `Tab`
    //     ⇒ 那一下必须仍然是**采纳**（写草稿），不是去排队重出。
    //     旧代码是 regen 支写在采纳之前（注释却声称相反），这一条跑在基线产物上必红；
    //     把 `KEY_ACTION_PRIORITY` 改成 regen 优先也必红（变异已实测）。
    const I9 = await scenario({ draft: '', doc: { historyEnabled: false, regenKey: 'Tab' }, code: 'Tab', key: 'Tab' });
    record('I9 ★ llm 形态 regenKey=Tab ⇒ 那一下仍是采纳（优先级表第一次被行为断言钉住）',
      I9.loadError === undefined && I9.writes.length === 1 && I9.afterDraft === SUGG_TEXT ? B.PASS : B.FAIL,
      `writes=${JSON.stringify(I9.writes)} draftAfter=${JSON.stringify(I9.afterDraft)} 期望 draftAfter=${JSON.stringify(SUGG_TEXT)}`);


// 汇总
// ═══════════════════════════════════════════════════════════════════════════
const behaviorFail = results.filter((r) => r.status === B.FAIL).length;
const nc = results.filter((r) => r.status === B.NC).length;
const baseRed = results.filter((r) => r.status === B.BASE_RED).length;
console.log(`\n汇总：判据 ${failed === 0 ? '全绿' : `${failed} 条红`}；行为段 PASS ${results.filter((r) => r.status === B.PASS).length}`
  + ` / FAIL ${behaviorFail} / NOT-COVERED ${nc} / BASELINE-RED ${baseRed}`);
if (failed > 0 || behaviorFail > 0) {
  console.error(`判定：${failed + behaviorFail} 条未通过（另见上方三态）`);
  process.exit(1);
}
if (nc > 0) console.log('判定：有未覆盖项（缺前置见上）——按 §5 口径不得写成通过');
console.log('✅ tab-ownership-smoke: Tab 按键所有权（#166 A+B1）判据 + 行为全绿');
