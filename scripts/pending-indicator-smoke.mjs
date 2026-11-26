#!/usr/bin/env node
/**
 * 生成中指示（C1 光标呼吸 / V4 输入框呼吸光）的冒烟测试。
 *
 * ## 它保什么
 *
 * 这块功能的价值全在三个**不变量**上，而三个都不是"能跑就行"能测出来的：
 *
 *  1. **两个选项互不影响**：用户明确要求「两个选项互不影响、可以同时开启」。
 *     四种开关组合 × 在途/不在途 必须逐格对上，任何一格错都意味着"开了一个把另一个
 *     关了"或"两个都开时只剩一个"。默认值还必须恰好是 C1 关 / V4 开。
 *  2. **灯与权威在途位同生共死**：在途位（`completionPending` Map）清了就熄灯。
 *     这一条只能测结构：四种收口（交付 / 超时 / 被抢先 / 失败）都经过同一个
 *     `settle`，熄灯必须挂在那里，而不是挂在某个具体出口上——挂在出口上就一定有
 *     某条出口忘了熄，表现为"一盏永远亮着的光"，那比没有指示更糟（它在撒谎）。
 *  3. **在途位是现算派生**，不是"写一次等它自己消失"：`_push` 是省略式拼装，
 *     任何一次无关推送都会把写过的 true 抹掉（#136 在 `error` 键上实测过）。
 *
 * 后半段是**静态守卫**：宿主与客户的接线处必须是这个形状，改名绕不过位置约束。
 *
 * 用法：node --experimental-strip-types scripts/pending-indicator-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BOX_GLOW_RULE,
  CARET_GLOW_RULE,
  DEFAULT_PENDING_STYLE,
  pendingDeclarations,
  shouldShowPending,
} from '../src/client/pending-indicator.ts';

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const gate = readFileSync(fileURLToPath(new URL('../src/completion-gate.ts', import.meta.url)), 'utf8');
const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8');
const card = readFileSync(fileURLToPath(new URL('../src/client/settings-card.tsx', import.meta.url)), 'utf8');
const flat = readFileSync(fileURLToPath(new URL('../src/generate.ts', import.meta.url)), 'utf8');
const live = readFileSync(fileURLToPath(new URL('../src/live-settings.ts', import.meta.url)), 'utf8');

console.log('\n—— 默认值（2026-11-09 起两项都关，按实验性发布）——');

run('纯模块的缺省是两项都关', () => {
  // 与 dsh-later 的「高级语法」同一口径：默认关、设置里标「实验性」、想用的人自己开。
  // 理由不是"没做完"，而是观感与干扰程度要用真实使用观察（本环境在途 19~28 秒）。
  assert.equal(DEFAULT_PENDING_STYLE.caretGlow, false);
  assert.equal(DEFAULT_PENDING_STYLE.boxGlow, false);
});

run('宿主 schema 的默认值与纯模块逐字一致', () => {
  // schema 里写的是 z.boolean().default(...)：取出现的那一行，逐条对。
  assert.match(host, /caretGlowEnabled:\s*z\.boolean\(\)\.default\(false\)/,
    'caretGlowEnabled 的 schema 默认值不是 false（应关）');
  assert.match(host, /boxGlowEnabled:\s*z\.boolean\(\)\.default\(false\)/,
    'boxGlowEnabled 的 schema 默认值不是 false（实验性，应关）');
});

run('flattenConfig 的回落值与 schema 同值', () => {
  assert.match(flat, /caretGlowEnabled:\s*readVolatile\(config\.caretGlowEnabled,\s*false\)/);
  assert.match(flat, /boxGlowEnabled:\s*readVolatile\(config\.boxGlowEnabled,\s*false\)/);
});

run('客户端的缺省与宿主同值（旧宿主 / 载荷缺失时行为一致）', () => {
  assert.match(client, /caretGlowEnabled:\s*false,/);
  assert.match(client, /boxGlowEnabled:\s*false,/);
});

console.log('\n—— 两个选项互不影响（四种组合 × 在途）——');

run('都不在途 ⇒ 一个声明都不产出', () => {
  for (const caretGlow of [true, false]) {
    for (const boxGlow of [true, false]) {
      const d = pendingDeclarations({ caretGlow, boxGlow }, false);
      assert.equal(d.caret, null, `不在途却产出了光标声明（caretGlow=${caretGlow}）`);
      assert.equal(d.box, null, `不在途却产出了框声明（boxGlow=${boxGlow}）`);
      assert.equal(shouldShowPending({ caretGlow, boxGlow }, false), false);
    }
  }
});

run('两个都开 ⇒ 两条声明都在，且互不吞掉', () => {
  const d = pendingDeclarations({ caretGlow: true, boxGlow: true }, true);
  assert.equal(d.caret, CARET_GLOW_RULE);
  assert.equal(d.box, BOX_GLOW_RULE);
  assert.notEqual(d.caret, d.box, '两条声明必须是两段不同的 CSS，不能是同一段');
});

run('只开 V4 ⇒ 只有框声明（不许因为 C1 关着把框也关了）', () => {
  const d = pendingDeclarations({ caretGlow: false, boxGlow: true }, true);
  assert.equal(d.box, BOX_GLOW_RULE);
  assert.equal(d.caret, null);
});

run('只开 C1 ⇒ 只有光标声明（对称地，不许被框开关连坐）', () => {
  const d = pendingDeclarations({ caretGlow: true, boxGlow: false }, true);
  assert.equal(d.caret, CARET_GLOW_RULE);
  assert.equal(d.box, null);
});

run('两个都关 ⇒ 即使在途也一个声明都没有', () => {
  const d = pendingDeclarations({ caretGlow: false, boxGlow: false }, true);
  assert.equal(d.caret, null);
  assert.equal(d.box, null);
  assert.equal(shouldShowPending({ caretGlow: false, boxGlow: false }, true), false);
});

console.log('\n—— 两条声明本身的行为约束 ——');

run('V4 不碰宿主的 box-shadow / 不改布局', () => {
  // 宿主的 composer 卡片自带 `box-shadow: var(--dsw-elevation-soft)`。我们若写
  // `box-shadow:...`（不带 inset、不带伪元素）就会把它整条盖掉，卡片视觉"塌平"。
  assert.match(BOX_GLOW_RULE, /\[data-composer-card\]::after/, 'V4 必须画在 ::after 上，不能改卡片自身的 box-shadow');
  assert.match(BOX_GLOW_RULE, /inset 0 0 0 /, 'V4 必须是 inset 内描边（不撑开布局、不外溢）');
  assert.match(BOX_GLOW_RULE, /pointer-events:none/, 'V4 不能吃掉点击');
  assert.doesNotMatch(BOX_GLOW_RULE, /(^|[;{])\s*box-shadow:\s*var\(--dsw-elevation/, 'V4 不许覆盖宿主的层次阴影');
});

run('V4 的呼吸低谷不归零（指示在这半个周期里不能消失）', () => {
  const m = BOX_GLOW_RULE.match(/0%,100%\{opacity:([\d.]+)\}/);
  assert.ok(m !== null, '找不到 V4 的关键帧起点');
  const low = Number(m[1]);
  assert.ok(low > 0, `V4 的低谷 opacity 是 ${low}：那会让指示在每个周期里闪断一次`);
});

run('C1 只换 caret-color，不抢宿主的 chip 隐藏语义', () => {
  assert.match(CARET_GLOW_RULE, /caret-color:/);
  assert.doesNotMatch(CARET_GLOW_RULE, /!important/,
    'C1 用了 !important：宿主的 [data-composer-chip-selected]{caret-color:#0000}（选中引用时隐藏光标）会被我们压住');
});

run('C1 在减动效偏好下退化为静态色', () => {
  assert.match(CARET_GLOW_RULE, /prefers-reduced-motion/);
});

run('两条规则的宿主选择器都走 body:has(插件自己的节点)', () => {
  for (const [name, rule] of [['C1', CARET_GLOW_RULE], ['V4', BOX_GLOW_RULE]]) {
    assert.match(rule, new RegExp(`body:has\\(#dsh-suggest-ghost-overlay\\[data-${name === 'C1' ? 'caret' : 'box'}-glow="1"\\]\\)`),
      `${name} 的选择器没有经插件自己的 overlay 节点去命中（会被 React 重渲染剥掉）`);
  }
});

console.log('\n—— 灯与权威在途位同生共死（结构守卫）——');

run('熄灯挂在 settle 里与 pending.delete 同一处，而不是某个具体出口', () => {
  // 取 `settle` 函数体：从它自己的签名到它之后第一个 `const bound =`。
  // （不能直接 indexOf('function settle(') 之后不加偏移——文件里 `startBoundedCompletion`
  //  的文档注释里也出现了这几个字，早先那一版就是这样取到了错位置。）
  const settleStart = gate.indexOf('  function settle(outcome: CompletionOutcome<T>): void {');
  assert.ok(settleStart > 0, '找不到 settle 的函数声明');
  const settleEnd = gate.indexOf('const bound =', settleStart);
  assert.ok(settleEnd > settleStart, 'settle 之后找不到 const bound');
  const settleBody = gate.slice(settleStart, settleEnd);
  const delAt = settleBody.indexOf('pending.delete(sessionId)');
  const settleAt = settleBody.indexOf('deps.onSettle?.()');
  assert.ok(delAt > 0, 'settle 里找不到 pending.delete');
  assert.ok(settleAt > delAt, 'onSettle 没有紧跟在 pending.delete 之后：那意味着它可能挂在某条出口上');
  // 两者必须在同一个 if (ownsSlot) 块里：槽被别人接管时不该由本次熄灯。
  const ownsIdx = settleBody.indexOf('if (ownsSlot) {');
  assert.ok(ownsIdx > 0, 'settle 里找不到 if (ownsSlot) 块');
  assert.ok(ownsIdx < delAt && settleAt < settleBody.indexOf('if (decision.action ===', ownsIdx),
    'onSettle 不在 if (ownsSlot) 块内');
});

run('宿主把 onSettle 接到「推一次状态」上', () => {
  assert.match(host, /onSettle:\s*\(\)\s*=>\s*\{\s*pushToClient\(statePushOf\(sessionId\)\);?\s*\}/,
    'onSettle 没有接线到 pushToClient(statePushOf(...))：熄灯不会推出去，客户端永远收不到');
});

run('开跑即推一次（否则「开始生成」这个边沿没有任何写入）', () => {
  assert.match(host, /completionInflightDraft\.set\(sessionId, draft\);[\s\S]{0,400}?pushToClient\(statePushOf\(sessionId\)\)/,
    'handleComplete 在占槽之后没有立即推送：指示只能等下一次无关推送才亮');
});

console.log('\n—— 在途位是现算派生（不是写一次等它消失）——');

run('statePushOf 里 completionPending 由 completionPendingFor(...) 现算', () => {
  const body = host.slice(host.indexOf('const statePushOf = ('), host.indexOf('const statePushOf = (') + 2000);
  assert.match(body, /completionPendingFor\(sessionId\)/,
    'statePushOf 没有现算在途位：写一次会被下一次无关推送抹掉');
});

run('completionPendingFor 读的是权威 Map，且按会话判定', () => {
  const start = host.indexOf('const completionPendingFor = (');
  assert.ok(start > 0, '找不到 completionPendingFor');
  const body = host.slice(start, start + 300);
  assert.match(body, /completionPending\.has\(sessionId\)/, '没有读 completionPending 这个权威 Map');
  assert.match(body, /sessionId !== null/, '没有排除 null 会话（会把任意会话的在途算到别人头上）');
});

run('在途位进指纹，两个样式位**不进**（进了会把 #36 拆两格的收益还回去）', () => {
  // 取 `pushSigOf` 的**函数体**（到它的收尾 `};` 为止）。早先这一版只截前 1200 字符，
  // 把后面 `pushFingerprintOfPersisted` 里构造载荷的那几行也算进来了 —— 于是
  // 「caretGlow 出现在源码里」被误当成「它进了指纹」，让这条断言守住了**错的行为**。
  const sigAt = host.indexOf('const pushSigOf = (');
  assert.ok(sigAt > 0, '找不到 pushSigOf');
  const sigEnd = host.indexOf('\n  };', sigAt);
  assert.ok(sigEnd > sigAt, 'pushSigOf 的收尾定位失败');
  // 先剥掉注释再断言：`pushSigOf` 的注释里**故意**逐字写了这两个键名（解释它们为什么
  // 不进指纹），不剥离的话这条断言会被自己的说明文字绊红 —— 那正是本次已经踩过一次的
  // 「断言查的是散文而不是代码」。
  const body = host.slice(sigAt, sigEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /completionPending/, '在途位没进指纹：开始生成那一次写入会被载荷去重掉（指示永远不亮）');
  assert.doesNotMatch(body, /caretGlow|boxGlow/,
    '样式位进了建议格指纹：任何一次推送都可能把建议格判脏（实测 cells=both），#36 拆两格的收益被还回去');
});

console.log('\n—— 设置页（两个开关都要能被用户改到）——');

run('两个键都在 live-settings 的登记表里', () => {
  // 漏登记 = #19 那一类：设置页改了、describe 读了、pickLiveSettings 丢弃、永远停在 boot 快照。
  assert.match(live, /caretGlowEnabled:\s*BOOL/);
  assert.match(live, /boxGlowEnabled:\s*BOOL/);
});

run('两个键都有卡片字段且可写，并各自独立成条', () => {
  for (const key of ['caretGlowEnabled', 'boxGlowEnabled']) {
    const at = card.indexOf(`key: '${key}'`);
    assert.ok(at > 0, `设置卡片里没有 ${key}`);
    const block = card.slice(at, at + 600);
    assert.match(block, /kind: 'boolean'/, `${key} 不是开关`);
    assert.match(block, /writable: true/, `${key} 不可写（用户改了保存会静默无效）`);
  }
});

run('两个光效进了「外观」分组，且各自文案里仍写着实验性', () => {
  // ⚠️ 第三次改这里的判据（#157 → 本单），原因同样记录在原地：
  // 本单把 `showKeyHint` 从 appearance 移进了新的 **keybinds（键位）** 分组——
  // 它是「键位要不要显示」的开关，跟着键位走才找得到；留在外观区的话，
  // 用户改完键还得去另一个分区把它关掉。⇒ 下面第 1 条「同属 appearance」只剩两个光效，
  // 键位提示改由第 3 条单独钉它的新归属。
  // 顺带一条**未做的**事如实记下：appearance 分组现在只剩实验性的两个光效，
  // 理论上「实验性」徽章可以整节挂回去（见下面 244-253 行那段历史），本单**没挂**，
  // 因为改徽章不在键位单的范围里，且会把「外观=实验性」这个等式重新固化。
  // ⚠️ 判据在 #157 之后改过一次，原因记录在此，免得下次有人"改回去"：
  //
  // 旧判据钉的是「C1/V4 在 `section: 'display'`，且那一节标题挂 `sgc-beta` 徽章」。
  // 但 `section: 'display'` 那一节渲染出来的标题是「生成中的提示」，**不是外观**，
  // 而键位提示（纯视觉、非实验性）也被塞进了「历史前缀补全」⇒ 用户按「显示/外观」
  // 根本找不到它。改成 appearance 分组后，那一节同时装了非实验性的键位提示，
  // **整节挂「实验性」徽章就不成立了**（会把键位提示也标成实验性）。
  //
  // ⇒ 现在断的是两件事：
  //   1. 结构：两个光效与键位提示同属 appearance 分组；
  //   2. 口径：两个光效的 hint 文案里**仍然逐字写着「实验性」**（默认关这一点也另有断言）。
  // 徽章本身没删（betaBadge / betaBadgeAria 文案仍在，供别的实验性分组复用）。
  assert.match(card, /key: 'caretGlowEnabled'[\s\S]{0,400}?section: 'appearance'/, 'C1 不在 appearance 分组');
  assert.match(card, /key: 'boxGlowEnabled'[\s\S]{0,400}?section: 'appearance'/, 'V4 不在 appearance 分组');
  assert.match(card, /key: 'showKeyHint'[\s\S]{0,600}?section: 'keybinds'/, '键位提示没跟着键位进 keybinds 分组');
  const c1 = card.slice(card.indexOf("key: 'caretGlowEnabled'"), card.indexOf("key: 'caretGlowEnabled'") + 500);
  const v4 = card.slice(card.indexOf("key: 'boxGlowEnabled'"), card.indexOf("key: 'boxGlowEnabled'") + 500);
  assert.match(c1, /实验性/, 'C1 文案里没写「实验性」⇒ 用户不知道这是实验性功能');
  assert.match(v4, /实验性/, 'V4 文案里没写「实验性」⇒ 用户不知道这是实验性功能');
  assert.match(card, /betaBadge:\s*'实验性'/, 'zh 文案里没有「实验性」（徽章仍要可供其它分组复用）');
  assert.match(card, /betaBadgeAria:/, '徽章缺 aria-label（读屏用户只听到一个孤立的词）');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}\n`);
