/**
 * 「这条幽灵此刻按哪个键做哪件事」的**唯一判据**（纯函数，零 DOM 依赖）。
 *
 * ## 为什么必须收成一处（Gitea #167 → 本单）
 *
 * 同一个三元曾同时写在两个地方：键位提示行的文案源（`index.ts` 的 render 路径）与
 * `onKeyDown` 里的采纳匹配。两份实现读同一组输入，所以「行为」与「提示」恰好一致 ——
 * 但一致性靠的是**巧合般的复制**，不是结构。这与 `src/transcript.ts` 的 `uiPriorLanguage`
 * 是同一课（「判据只许有一处」）：判据长成第二份时，两份的分叉在界面上只表现为「说一套做一套」。
 *
 * 现在**三条**路径（提示行、`onKeyDown` 的匹配、设置页的生效键位摘要）都只经
 * {@link bindingTableFor} 这一张表，于是「屏幕上写的键 == 真按得动的键」第一次成为
 * **构造性**成立：文案不是「另外算一遍」，而是读同一张表的同一个键。
 *
 * ## 现行语义（#167 的前置条件已补齐）
 *
 * #167 当年把 `acceptKey` 的作用域收窄成「只管 `llm` 形态」，留下的话是
 * 「要扩范围必须先定『字母键在本地即时形态上是否禁用』」。那道判据现在长在
 * `keyspec.ts` 的 `isSafeActionKey`（主键不打字，或带 Alt/Ctrl/Meta 摘出去），
 * 由设置卡片的录制端把关 ⇒ 于是：
 *  - `llm` 形态的采纳键 = 设置项 `acceptKey`（不变，**一个字节都没动它的含义**）；
 *  - `history` / `inline` 形态的采纳键 = **新**设置项 `localAcceptKey`（默认 {@link DEFAULT_ACCEPT_KEY}）；
 *  - 逐词键 = 新设置项 `wordAcceptKey`，且**只在 `history` / `inline` 进表**
 *    （旧代码没有这条形态判据，`llm` 形态按 `→` 是**恰好**被 #166 同源闸挡住的，
 *    见 `docs/keybinding-settings-design.md` §1.4-2；现在把它写回结构）；
 *  - `regen` 只在 `llm` 进表（历史/续写的候选集是本地即时算出的，没有「再要一条」的语义）；
 *  - 关掉的开关（`wordAccept` / `regenEnabled`）**直接不给这一格** ⇒ 该键回原生，
 *    与「判据不过不许吞键」的既有规则同一条口径。
 *
 * @module dsh-suggest-ghost/client/accept-key
 */

import type { BindingTable, KeyAction } from './keyspec.js';

/**
 * 采纳键的兜底值，也是 `localAcceptKey` 的 schema 默认值。
 *
 * 与 `index.ts` 的 `DEFAULT_ACCEPT_KEY` 是**同一个值**（由该文件从本模块导入），
 * 不存在第二份字面量。改这里会同时改掉兜底语义与提示行上写的键。
 */
export const DEFAULT_ACCEPT_KEY = 'Tab';

/** 逐词采纳键的 schema 默认值（`keyNameOfCode('ArrowRight')` 给出的显示名就是 `Right`）。 */
export const DEFAULT_WORD_ACCEPT_KEY = 'Right';

/** 「换一条」键的 schema 默认值。 */
export const DEFAULT_REGEN_KEY = 'Alt+G';

/** 关闭幽灵键的 schema 默认值；留空 = 本插件不接管关闭动作（唯一允许空的一项）。 */
export const DEFAULT_DISMISS_KEY = 'Escape';

/** 组一张键位表所需的输入（全部来自当前生效的设置 + 幽灵形态）。 */
export interface GhostKeyInputs {
  /** 幽灵形态。 */
  kind: 'llm' | 'history' | 'inline';
  /** 设置项 `acceptKey`：仅 `llm` 形态用到。 */
  acceptKey?: string | undefined;
  /** 设置项 `localAcceptKey`：`history` / `inline` 形态用到。 */
  localAcceptKey?: string | undefined;
  /** 设置项 `wordAcceptKey`。 */
  wordAcceptKey?: string | undefined;
  /** 设置项 `regenKey`。 */
  regenKey?: string | undefined;
  /** 设置项 `dismissKey`（空串 = 不接管）。 */
  dismissKey?: string | undefined;
  /** 逐词采纳开关（关 ⇒ 表里没有 `word` 这一格）。 */
  wordAccept?: boolean;
  /** 换一条开关（关 ⇒ 表里没有 `regen` 这一格）。 */
  regenEnabled?: boolean;
}

/**
 * 当前形态下**真实生效**的键位表：动作 -> spec，缺席 = 该动作此刻不接管任何键。
 *
 * 返回值可以直接喂给 `keyspec.ts` 的 `ownerOfKey` / `bindingConflicts`，
 * 也可以喂给 `keyHintText` —— 两条路径读同一张表，界面上不可能出现「说的键按不动」。
 * spec 一律**原样透出**设置值，不在这里做净化（与旧 `acceptKeyFor` 同口径：
 * 空串/空白 = 这一格缺席 = 永不命中，那是可观测的自洽，要收窄该由 schema 层负责）。
 */
export function bindingTableFor(input: GhostKeyInputs): BindingTable {
  const table: Partial<Record<KeyAction, string>> = {};
  table.accept = (input.kind === 'llm'
    ? input.acceptKey ?? DEFAULT_ACCEPT_KEY
    : input.localAcceptKey ?? DEFAULT_ACCEPT_KEY);
  // 逐词只在本地即时形态进表：`llm` 的采纳语义是整段覆盖草稿，逐词吃半条再整段覆盖最不可解释。
  if (input.kind !== 'llm' && input.wordAccept !== false) {
    table.word = input.wordAcceptKey ?? DEFAULT_WORD_ACCEPT_KEY;
  }
  if (input.kind === 'llm' && input.regenEnabled !== false) {
    table.regen = input.regenKey ?? DEFAULT_REGEN_KEY;
  }
  if (input.dismissKey !== undefined && input.dismissKey !== '') table.dismiss = input.dismissKey;
  return table;
}

/**
 * 这条幽灵**实际生效**的采纳键（{@link bindingTableFor} 的 `accept` 那一格）。
 *
 * 保留成独立函数只为让旧调用点（`index.ts` 的 `acceptKeyOfContent` 与提示行）保持一行读法；
 * 判据本体在上面，这里不掺第二次判断。
 */
export function acceptKeyFor(input: GhostKeyInputs): string {
  return bindingTableFor(input).accept ?? DEFAULT_ACCEPT_KEY;
}

/**
 * 该形态的采纳键来自**哪个设置项**（卡片文案用它说清「这一项管到哪」）。
 *
 * 与 {@link bindingTableFor} 同一处判定，所以文案与行为不会各说各话——
 * 这正是 #167 那条「设置项文案未限定作用范围」的根因所在。
 */
export function acceptKeySettingOf(kind: GhostKeyInputs['kind']): 'acceptKey' | 'localAcceptKey' {
  return kind === 'llm' ? 'acceptKey' : 'localAcceptKey';
}
