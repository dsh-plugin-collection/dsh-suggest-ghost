#!/usr/bin/env node
/**
 * 键位判据的冒烟：**「屏幕上显示的键 == 按下后实际生效的键」**，覆盖全部五个动作。
 *
 * ## 它挡的是哪几类事故
 *
 * 1. **说一套做一套**（Gitea #167 的原始命题）：提示行写着 `F2 采纳`，按下去什么都没发生。
 * 2. **设置项越界**（#167 的结论）：`acceptKey` 只能管「下一条建议」，
 *    历史补全 / 停顿续写归 `localAcceptKey`。今天两者都有独立设置项 ⇒ 两个方向都要钉：
 *    改 A 不许动 B。
 * 3. **同键歧义**（本单新增）：五个键位共用一张优先级表，同键时必须有一个确定答案。
 *    旧实现里 regen 写在采纳之前，注释却声称「采纳优先」——那道反话今天第一次有断言看着。
 * 4. **承诺不存在的键**（本单新增）：`dismissKey` 留空时提示行不许再写「Esc 关闭」。
 *
 * ## 与上一版的差别：**判据不再抄副本**
 *
 * 旧版必须复制一份 `parseAcceptKey`，因为那个匹配器埋在 `src/client/index.ts` 里、
 * 纯 Node 载不动（复制的漂移风险由一条 `checkMatcherParity` 形状闸盯着）。
 * 本单把匹配与仲裁收进 `src/client/keyspec.ts` 的 `specMatches` / `ownerOfKey` 之后，
 * 这里**直接 import 真函数** —— 于是「测试说它同构」升级成「测试用的就是它」。
 * 副本没了，`checkMatcherParity` 那类「防副本写歪」的闸也就不需要了；
 * 取而代之的是下面 `index.ts` 只许有一处调用 `ownerOfKey` 的形状闸。
 *
 * ## 三态
 * 全部输入离线可控 ⇒ 只有 PASS / FAIL。真宿主两代（textarea / contenteditable）不在本脚本覆盖面。
 *
 * 用法：`node --experimental-strip-types scripts/accept-key-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  acceptKeyFor,
  bindingTableFor,
  DEFAULT_ACCEPT_KEY,
  DEFAULT_DISMISS_KEY,
  DEFAULT_REGEN_KEY,
  DEFAULT_WORD_ACCEPT_KEY,
  acceptKeySettingOf,
} from '../src/client/accept-key.ts';
import { keyHintText } from '../src/client/key-hint-text.ts';
import {
  bindingConflicts,
  factsOfSpec,
  hintSegments,
  keyCodeOf,
  ownerOfKey,
  specMatches,
  keyFactsOf,
} from '../src/client/keyspec.ts';

let failed = 0;
const check = (name, fn, detail) => {
  let ok = false;
  let why = '';
  try { ok = fn(); } catch (error) { ok = false; why = ` 抛错: ${String(error?.message ?? error)}`; }
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      实际: ${why || (detail ? detail() : '')}`}`);
};

const CLIENT_INDEX = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');

/** 造一个最小的 KeyboardEvent 替身（`keyFactsOf` 只读这 5 个字段）。 */
const keyEvent = (code, mods = {}) => ({
  code,
  altKey: mods.alt === true,
  ctrlKey: mods.ctrl === true,
  metaKey: mods.meta === true,
  shiftKey: mods.shift === true,
});

/** 照 spec 的字面意思造一次「按对了」的事件（修饰键状态与 spec 一致）。 */
const eventForSpec = (spec) => {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return keyEvent(keyCodeOf(spec), {
    alt: mods.has('alt'), ctrl: mods.has('ctrl'), meta: mods.has('meta'), shift: mods.has('shift'),
  });
};

/** 用户照设置页写的键去按，这张表把它判给了谁（`null` = 没人认领）。 */
const ownerWhenPressed = (table, spec) => ownerOfKey(table, keyFactsOf(eventForSpec(spec)));

/** 默认设置下的一整套键位（各形态）。 */
const DEFAULTS = {
  acceptKey: DEFAULT_ACCEPT_KEY,
  localAcceptKey: DEFAULT_ACCEPT_KEY,
  wordAcceptKey: DEFAULT_WORD_ACCEPT_KEY,
  regenKey: DEFAULT_REGEN_KEY,
  dismissKey: DEFAULT_DISMISS_KEY,
  wordAccept: true,
  regenEnabled: true,
};

console.log('【键位判据：显示 == 生效，五个动作全覆盖】\n');

// ─── 1. 采纳键的作用域（#167 的结论，两向都要钉）───────────────────────
check('llm 形态的采纳键读 acceptKey',
  () => acceptKeyFor({ ...DEFAULTS, kind: 'llm', acceptKey: 'F2' }) === 'F2');

check('history / inline 形态的采纳键读 localAcceptKey，不读 acceptKey',
  () => acceptKeyFor({ ...DEFAULTS, kind: 'history', acceptKey: 'F2', localAcceptKey: 'F3' }) === 'F3'
    && acceptKeyFor({ ...DEFAULTS, kind: 'inline', acceptKey: 'F2', localAcceptKey: 'F3' }) === 'F3',
  () => JSON.stringify([
    acceptKeyFor({ ...DEFAULTS, kind: 'history', acceptKey: 'F2', localAcceptKey: 'F3' }),
    acceptKeyFor({ ...DEFAULTS, kind: 'inline', acceptKey: 'F2', localAcceptKey: 'F3' }),
  ]));

check('反过来：改 localAcceptKey 不许动 llm 形态（旧配置的含义一字未变）',
  () => acceptKeyFor({ ...DEFAULTS, kind: 'llm', acceptKey: 'F2', localAcceptKey: 'F3' }) === 'F2');

check('默认值口径：不传任何键位时三形态的采纳键都是 Tab',
  () => ['llm', 'history', 'inline'].every((kind) => acceptKeyFor({ kind }) === 'Tab'));

check('acceptKeySettingOf：文案口径与判据口径同表（llm→acceptKey，其余→localAcceptKey）',
  () => acceptKeySettingOf('llm') === 'acceptKey'
    && acceptKeySettingOf('history') === 'localAcceptKey'
    && acceptKeySettingOf('inline') === 'localAcceptKey');

// 空串/空白**不做兜底**（与 #167 同口径：显示什么就是不生效什么，可观测的自洽）。
check('空串原样透出，不回落默认',
  () => acceptKeyFor({ ...DEFAULTS, kind: 'llm', acceptKey: '' }) === ''
    && acceptKeyFor({ ...DEFAULTS, kind: 'llm', acceptKey: '   ' }) === '   ');

// ─── 2. 逐词 / 换一条的形态归属 ──────────────────────────────────────
check('逐词只进 history / inline 表，llm 表里没有 word 这一格',
  () => bindingTableFor({ ...DEFAULTS, kind: 'llm' }).word === undefined
    && bindingTableFor({ ...DEFAULTS, kind: 'history' }).word === DEFAULT_WORD_ACCEPT_KEY,
  () => JSON.stringify([bindingTableFor({ ...DEFAULTS, kind: 'llm' }),
    bindingTableFor({ ...DEFAULTS, kind: 'history' })]));

check('换一条只进 llm 表',
  () => bindingTableFor({ ...DEFAULTS, kind: 'llm' }).regen === DEFAULT_REGEN_KEY
    && bindingTableFor({ ...DEFAULTS, kind: 'inline' }).regen === undefined);

check('wordAccept=false ⇒ 表里没有 word（那一键回原生，不是「按了没反应」）',
  () => bindingTableFor({ ...DEFAULTS, kind: 'history', wordAccept: false }).word === undefined);

check('regenEnabled=false ⇒ 表里没有 regen',
  () => bindingTableFor({ ...DEFAULTS, kind: 'llm', regenEnabled: false }).regen === undefined);

check('wordAcceptKey 改名后表与提示行一起跟着改',
  () => {
    const table = bindingTableFor({ ...DEFAULTS, kind: 'history', wordAcceptKey: 'Up' });
    return table.word === 'Up' && keyHintText({ kind: 'history', segments: hintSegments(table), lang: 'zh' }).includes('↑ 逐词');
  },
  () => keyHintText({ kind: 'history', segments: hintSegments(bindingTableFor({ ...DEFAULTS, kind: 'history', wordAcceptKey: 'Up' })), lang: 'zh' }));

// ─── 3. dismiss：留空不许再承诺 ──────────────────────────────────────
check('dismissKey 默认 Escape ⇒ 表里有，且提示行写「Esc 关闭」',
  () => {
    const table = bindingTableFor({ ...DEFAULTS, kind: 'llm' });
    return table.dismiss === 'Escape'
      && keyHintText({ kind: 'llm', segments: hintSegments(table), lang: 'zh' }).includes('Esc 关闭');
  });

check('dismissKey 留空 ⇒ 表里没有这一格，提示行也不再出现「关闭」',
  () => {
    const table = bindingTableFor({ ...DEFAULTS, kind: 'llm', dismissKey: '' });
    const hint = keyHintText({ kind: 'llm', segments: hintSegments(table), lang: 'zh' });
    return table.dismiss === undefined && !hint.includes('关闭') && !hint.includes('Esc');
  },
  () => keyHintText({ kind: 'llm', segments: hintSegments(bindingTableFor({ ...DEFAULTS, kind: 'llm', dismissKey: '' })), lang: 'zh' }));

// ─── 4. 同键仲裁（本单修的正是「注释与代码相反」那条）───────────────────
check('accept 与 regen 同键 ⇒ 采纳赢（`Tab 永远采纳`第一次成为事实）',
  () => ownerWhenPressed({ accept: 'Tab', regen: 'Tab', word: 'Right' }, 'Tab') === 'accept');

check('accept 与 dismiss 同键 ⇒ 采纳赢（关闭优先级最低：它什么都不写）',
  () => ownerWhenPressed({ accept: 'Tab', dismiss: 'Tab' }, 'Tab') === 'accept');

check('word 与 dismiss 同键 ⇒ 逐词赢',
  () => ownerWhenPressed({ word: 'Up', dismiss: 'Up', accept: 'Tab' }, 'Up') === 'word');

check('无人认领的键 ⇒ ownerOfKey 返回 null（调用方据此**不吞键**）',
  () => ownerWhenPressed(bindingTableFor({ ...DEFAULTS, kind: 'llm' }), 'F5') === null);

check('回归（#1.4-3）：regenKey=Tab 时 history 形态按 Tab 仍然采纳',
  () => {
    const table = bindingTableFor({ ...DEFAULTS, kind: 'history', regenKey: 'Tab' });
    // 旧实现：先命中 regen 支 → 非 llm 直接 return → 采纳支永远拿不到这一次按键。
    // 新实现：表里根本没有 regen（形态闸），Tab 判给 accept。
    return table.regen === undefined && ownerWhenPressed(table, 'Tab') === 'accept';
  },
  () => JSON.stringify(bindingTableFor({ ...DEFAULTS, kind: 'history', regenKey: 'Tab' })));

// ─── 5. 修饰键必须逐一相等（裸键与组合键不是同一个键）───────────────────
check('spec 写了 Alt 而用户没按 Alt ⇒ 不命中（裸 `G` 不会误触 `Alt+G`）',
  () => specMatches(keyFactsOf(keyEvent('KeyG')), 'Alt+G') === false
    && specMatches(keyFactsOf(keyEvent('KeyG', { alt: true })), 'Alt+G') === true);

check('spec 没写 Shift 而用户按了 Shift ⇒ 不命中（`Tab` ≠ `Shift+Tab`）',
  () => specMatches(keyFactsOf(keyEvent('Tab', { shift: true })), 'Tab') === false);

check('认不出的主键 ⇒ 永不命中（配置错误必须表现为「没反应」而不是「乱命中」）',
  () => specMatches(keyFactsOf(keyEvent('Delete')), 'Delete') === false
    && specMatches(keyFactsOf(keyEvent('Tab')), '') === false);

// ─── 6. 界面自洽：每段显示的键，按下确实判给那个动作 ────────────────────
const KINDS = ['llm', 'history', 'inline'];
const VARIANTS = [
  {},
  { acceptKey: 'F2', localAcceptKey: 'F4', wordAcceptKey: 'Up', regenKey: 'Alt+J', dismissKey: 'Alt+Backspace' },
  { wordAccept: false },
  { regenEnabled: false },
  { dismissKey: '' },
];

for (const kind of KINDS) {
  for (const [i, variant] of VARIANTS.entries()) {
    const settings = { ...DEFAULTS, ...variant };
    const table = bindingTableFor({ ...settings, kind });
    const segs = hintSegments(table);
    const hint = keyHintText({ kind, segments: segs, lang: 'zh' });
    check(`${kind}/变体${i}：提示行每一段按下去都判给同名动作`,
      () => segs.length > 0 && segs.every((seg) => ownerWhenPressed(table, table[seg.action]) === seg.action),
      () => `hint=${hint} segs=${JSON.stringify(segs)}`);
    // 采纳键必须是第一段（顺序即优先级，界面读数不能漂）。
    check(`${kind}/变体${i}：采纳段恒为第一段`,
      () => hint.split(' · ')[0]?.endsWith(' 采纳') === true,
      () => hint);
  }
}

// ─── 6.5 卡片侧的撞键判定必须与运行时同一口径（bindingConflicts 的表分组）────
// 卡片比较的是「同一次按键上的竞争」，也就是**每张表内部**；把五个字段扁平地两两相比
// 会让默认设置一打开就报两条警告（`acceptKey` 与 `localAcceptKey` 都是 Tab，
// 但它们分别只在 llm / 本地形态生效，永远撞不上）。本段把这条口径钉成断言。
check('默认设置下：两张表内部都没有撞键（acceptKey 与 localAcceptKey 同值不算撞）',
  () => {
    const llm = bindingTableFor({ ...DEFAULTS, kind: 'llm' });
    const local = bindingTableFor({ ...DEFAULTS, kind: 'history' });
    return ['accept', 'word', 'regen', 'dismiss'].every(
      (a) => bindingConflicts(llm, a).length === 0 && bindingConflicts(local, a).length === 0);
  },
  () => JSON.stringify([bindingTableFor({ ...DEFAULTS, kind: 'llm' }), bindingTableFor({ ...DEFAULTS, kind: 'history' })]));

check('把 regenKey 配成 Tab ⇒ llm 表内部报出 accept，且胜者按优先级是 accept',
  () => {
    const table = bindingTableFor({ ...DEFAULTS, kind: 'llm', regenKey: 'Tab' });
    const clashes = bindingConflicts(table, 'regen');
    const facts = factsOfSpec('Tab');
    return clashes.includes('accept') && facts !== undefined && ownerOfKey(table, facts) === 'accept';
  },
  () => JSON.stringify(bindingConflicts(bindingTableFor({ ...DEFAULTS, kind: 'llm', regenKey: 'Tab' }), 'regen')));

// ─── 7. 形状闸：index.ts 只许有一处仲裁调用 ──────────────────────────
const code = CLIENT_INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('★ index.ts 里 ownerOfKey 只被调用一次（键位归谁只有一处答案）',
  () => (code.match(/ownerOfKey\(/g) ?? []).length === 1,
  () => String((code.match(/ownerOfKey\(/g) ?? []).length));

check('★ 旧的第二份匹配器没有复活（index.ts 里不得再出现 keyCodeOf / 自写 spec 拆分）',
  () => !/keyCodeOf\(/.test(code) && !/event\.code === 'ArrowRight'/.test(code),
  () => 'index.ts 又长出了自己的键位判据');

console.log(`\n${failed === 0 ? '✅' : '❌'} accept-key-smoke: ${failed === 0 ? '键位判据与界面自洽' : `${failed} 条不合格`}`);
process.exit(failed === 0 ? 0 : 1);
