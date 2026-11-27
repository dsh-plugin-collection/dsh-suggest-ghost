/**
 * SuggestGhost 设置卡片：渲染到 WebUI 设置 → 设置页槽位（`settings.section`），
 * 编辑 `suggest-ghost` settings 命名空间。React 组件，运行时从宿主解析 react
 * （esbuild external）。
 *
 * 视觉对齐官方 SettingsForm（dsh-client-ui-primitives，参考 dsh-later 的
 * SchedulerSettingsCard 同款实现）——**裸表单 + section 分组布局**，无卡片
 * chrome（无可折叠头部、无边框、无背景）：
 * - section：`padding 16px 0`，标题 13px/600（llm / history 两个 section）；
 * - 字段：`padding 12px 0`，label 13px/500 在上、控件在下、无字段分隔线；
 * - 布尔字段：官方 toggle 行（label 左 + switch 右，36×20 圆角滑块）；
 * - 帮助按钮：24×24、8px 圆角、官方 ConfigField 同款 IconInfoOutlineRegular（12px），
 *   点击展开字段说明；
 * - footer：保存/放弃按钮靠右（无顶部分隔线）。
 * 样式经 <style> 注入（styles.ts，sgc- 前缀类名），与官方 CSS 注入方式相同。
 *
 * 文案双语：字段 label/hint 直接存 { zh, en } 双值，chrome 微文案由
 * zh 源字典 + en 映射类型约束键集一致；语言经 useGhostT 跟随宿主 DSH
 * 界面语言（locale 服务），切换无刷新重渲染，服务缺失回退中文。
 * @module dsh-suggest-ghost/client/settings-card
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
// 0.1.7 移除了内核 settingsScope 服务；卡片依赖的 scope 最小面在 client 侧
// 本地声明，由 index.ts 的 remoteSettingsScope() 适配器实现。
import type { PluginSettingsScope } from './settings-scope.js';
import type { ScopeSnapshot } from './index.js';
import type { HotnessOp } from '../domain.js';
// 提示词上限的**唯一出处**（宿主 schema 引的是同一个常量）。卡片需要它来在保存前
// 挡住超长：内核 zod 拒绝时 `save()` 读不到结论，界面只表现为「点了保存、值没变」。
import { PROMPT_MAX_CHARS } from '../prompt-override.js';
import { MODEL_OPTIONS_PATH } from '../model-catalog.js';
import {
  bindingConflicts,
  factsOfSpec,
  isSafeActionKey,
  isSendCollisionKey,
  keyEventToSpec,
  ownerOfKey,
  sameSpec,
  specKeycap,
  type KeyAction,
} from './keyspec.js';
// 「当前生效」摘要读的是仲裁端那张表 ⇒ 必须 import 判据本体，不许在卡片里复刻一遍。
// ⚠️ 这一行曾经**漏了**：`.tsx` 不在 `tsc` 的 include 里，esbuild 也不查未定义标识符，
// 于是构建全绿、冒烟全绿，真浏览器里一打开插件详情页就 `ReferenceError: bindingTableFor
// is not defined` 把整个 slot 炸掉。现已由 `scripts/client-name-check-smoke.mjs` 拦住
// （跑 `tsc --jsx` 只筛 TS2304/TS2552；实测 origin/main 基线该类为 0，所以这条闸不抖）。
import { bindingTableFor } from './accept-key.js';
import { useGhostT, type GhostLang, type LocaleFaceLike } from './useGhostT.js';
import { injectStyles } from './styles.js';
// 图标取自官方图标集：primitives 是 Web 壳的 platform module（冻结模块表常驻），
// esbuild 标 external 后由 __ModuleLoader__ 的 require 在运行时解析（与 react 同
// 机制，参考 dsh-group-status 的用法），无需 peerDependency 或 dsh.client.inject。
import { IconChevronDownOutlineRegular, IconInfoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'key' | 'select' | 'catalog' | 'textarea';

/** 双语文案值（zh 为源语言）。 */
export interface Bilingual {
  readonly zh: string;
  readonly en: string;
}

/** 配置字段定义（key / 显示名 / 提示 / 输入形态 / 所属分组）。
 * label/hint 为 { zh, en } 双值，按 useGhostT 解析出的语言取用。
 *
 * `writable: false` = **策略字段**，host 端刻意没标 `.volatile()`，因此写不进去
 * （内核的 `SettingsForms.write()` 只接受 volatile 路径，非 volatile 直接抛错）。
 * 这类字段在卡片里以只读呈现并标注来源，避免用户改了「保存」却静默无效——
 * 这正是 0.1.7 把策略参数与用户可调项分开之后必须显式表达的区别。 */
export const GHOST_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly label: Bilingual;
  readonly hint: Bilingual;
  readonly kind: FieldKind;
  /**
   * 设置卡片分区。
   *
   * ⚠️ 这里曾经写着 `'display'` 而**没有任何字段用它**（三个视觉开关实际写的是
   * `'appearance'`）。之所以两边都不报错：`tsconfig.client.json` 的 include 是
   * 「`src/client/` 下所有 `.ts`」，本文件（`.tsx`）**不在类型检查范围内**（开 `jsx` 会照出
   * 上百条存量问题，见该文件头部注释与 Gitea #87）。⇒ 改这个联合时**不要指望编译器**，
   * 靠 `scripts/keybinding-registration-smoke.mjs` 的集合比对与真机渲染。
   */
  readonly section: 'llm' | 'history' | 'inline' | 'language' | 'appearance' | 'keybinds';
  /** 是否可经设置页写回（false = 只能改配置文件）。 */
  readonly writable: boolean;
  /**
   * 目录型下拉框取哪一份宿主目录（仅 kind='catalog'）：
   *  - `providers`：宿主 llm 的 provider 列表（卡片打开时拉一次）
   *  - `models`：**按 provider 懒加载** —— 只有当前选中的 provider 才发一次请求，
   *    不一次拉全部（gitea-dispatch 同款口径）
   */
  readonly catalog?: 'providers' | 'models' | 'efforts';
  /**
   * 并排分组（`renderFieldRun` 用）：连续的同类分组合进一个网格容器。
   *
   * - `'route'`：provider | model | 档位 三栏（档位合法集由 model 决定 ⇒ 必须同栏）
   * - `'pair'`：两个短字段并排（数字/下拉）；**带长 hint 的开关不分组**，整行更好读
   */
  readonly group?: 'route' | 'pair';
  /** select 控件的选项列表（仅 kind='select' 时使用）。 */
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: Bilingual }>;
}> = [
  // —— 显示：生成中的指示 ——
  //
  // 两个选项**刻意独立**（用户要求互不影响、可同时开启）：文案里各自只说自己的效果，
  // 不提对方，也不写"同时开启更明显"这类暗示——那会把两个开关读成一档/两档的渐进关系。
  {
    key: 'boxGlowEnabled',
    label: { zh: '生成时输入框发光', en: 'Glow around the input box' },
    hint: {
      zh: '生成期间让输入框边缘有一圈呼吸的微光，用来提示还在生成。实验性功能，默认关闭。',
      en: 'Pulse a soft glow around the input box while a suggestion is being generated. Experimental, off by default.',
    },
    kind: 'boolean',
    section: 'appearance',
    writable: true,
  },
  {
    key: 'caretGlowEnabled',
    label: { zh: '生成时光标呼吸', en: 'Pulse the text cursor' },
    hint: {
      zh: '生成期间让输入光标在两种颜色之间缓慢变化。实验性功能，默认关闭。',
      en: 'Slowly shift the text cursor between two colors while generating. Experimental, off by default.',
    },
    kind: 'boolean',
    section: 'appearance',
    writable: true,
  },
  // —— LLM 下一条建议 ——
  {
    key: 'maxInputBytes',
    group: 'pair',
    label: { zh: '输入字节上限', en: 'Input byte cap' },
    hint: {
      zh: '生成建议时最多取用多少上下文（字节）。调大更准，但更慢也更费 token。',
      en: 'How much context (in bytes) suggestions may use. Larger is more accurate but slower and costs more.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxOutputTokens',
    group: 'pair',
    label: { zh: '输出令牌上限', en: 'Output token cap' },
    hint: {
      zh: '单条建议最多生成多少 token。推理模型要给足余量，太小会生成不出内容。',
      en: 'Max tokens per suggestion. Give reasoning models headroom, or they may return nothing.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxSuggestionChars',
    group: 'pair',
    label: { zh: '建议字符上限', en: 'Suggestion character cap' },
    hint: { zh: '幽灵文本可见字符数上限', en: 'Max visible characters of the ghost text' },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxRecentTurns',
    group: 'pair',
    label: { zh: '参考回合数', en: 'Recent turns referenced' },
    hint: {
      zh: '参考最近多少个回合的对话。调大上下文更完整，调小更快。',
      en: 'How many recent turns are used as context. More is richer, fewer is faster.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'maxTranscriptChars',
    label: { zh: '转录字符预算', en: 'Transcript character budget' },
    hint: {
      zh: '送进模型的对话记录最多多长（字符），超出会被裁掉。',
      en: 'Max characters of conversation history sent to the model; the rest is trimmed.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'contextSummaryEnabled',
    label: { zh: '长会话摘要', en: 'Long session summary' },
    hint: {
      zh: '老旧对话被裁掉时，先把要点压成摘要保留下来（不额外调用模型）。',
      en: 'When old messages are trimmed, keep their gist as a summary (no extra model calls).',
    },
    kind: 'boolean',
    section: 'llm',
    writable: true,
  },
  {
    key: 'contextSummaryChars',
    group: 'pair',
    label: { zh: '摘要字符预算', en: 'Summary character budget' },
    hint: {
      zh: '摘要最多保留多少字符。太小会丢要点，太大会挤占正式对话。',
      en: 'Max summary length. Too small loses details; too large crowds out the conversation.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'timeoutMs',
    group: 'pair',
    label: { zh: '超时（毫秒）', en: 'Timeout (ms)' },
    hint: {
      zh: '一次建议最多等多久（毫秒）。网络慢可以调大。',
      en: 'How long a suggestion request may take (ms). Raise it on slow networks.',
    },
    kind: 'number',
    section: 'llm',
    writable: true,
  },
  {
    key: 'regenKey',
    label: { zh: '换一条快捷键', en: 'Regenerate shortcut' },
    hint: {
      zh: '建议不满意时换一条的快捷键（只在幽灵显示时生效）。默认 Alt+G。',
      en: 'Shortcut to ask for another suggestion (only while the ghost is visible). Alt+G by default.',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'regenEnabled',
    label: { zh: '允许换一条', en: 'Allow regenerate' },
    hint: {
      zh: '打开后可以按上面的快捷键再要一条建议；每回合有次数上限，避免误触时连续调用模型。',
      en: 'Lets you ask for another suggestion with the shortcut above. Capped per turn so a stray keypress cannot keep calling the model.',
    },
    kind: 'boolean',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'acceptKey',
    label: { zh: '采纳快捷键（下一条建议）', en: 'Accept shortcut (next suggestion)' },
    hint: {
      zh: '只作用于「下一条建议」那条幽灵。字母键也能设，但它会吃掉你打的第一个字符，建议用 Tab、方向键或 F1–F12。',
      en: 'Applies to the next-suggestion ghost only. Letters work too, but one swallows your first keystroke — Tab, arrow keys or F1–F12 are safer.',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'localAcceptKey',
    label: { zh: '采纳快捷键（历史补全 / 停顿续写）', en: 'Accept shortcut (history / pause completion)' },
    hint: {
      zh: '这两类补全是边打字边出现的，所以只能设成不打字的键：Tab、方向键、Enter、F1–F12，或带 Alt / Ctrl 的组合。',
      en: 'These two appear while you type, so only non-typing keys are allowed: Tab, arrows, Enter, F1–F12, or a combo with Alt / Ctrl.',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'wordAcceptKey',
    label: { zh: '逐词采纳快捷键', en: 'Word-by-word accept shortcut' },
    hint: {
      zh: '一次吃一个词。默认 →，只作用于历史补全与停顿续写（下一条建议是整条覆盖，没有逐词这说）。',
      en: 'Takes one chunk at a time. → by default; applies to history and pause completion (the next suggestion is replaced whole).',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'forgetKey',
    label: { zh: '「别再补这句」快捷键', en: 'Forget-this-suggestion shortcut' },
    hint: {
      zh: '看到不想再被补全的那句时按下它：这句会从候选里永久移除，之后打字不会再补出来，也不会再计入热度。留空 = 不接管这个动作。改错了可以在下面的「已忽略」里恢复。',
      en: 'Press it on a ghost you are done with: that line leaves the candidate pool for good and stops counting toward hotness. Empty = no key. Restore it under Ignored below.',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'dismissKey',
    label: { zh: '关闭幽灵快捷键', en: 'Dismiss shortcut' },
    hint: {
      zh: '收起当前这条幽灵，不改你已输入的内容。留空 = 不接管这个动作，输入框上方那行提示也会跟着去掉这一句。',
      en: 'Hides the current ghost without touching what you typed. Leave it empty to give the action up — the hint line drops it too.',
    },
    kind: 'key',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'llmEnabled',
    label: { zh: '启用 LLM 建议', en: 'Enable LLM suggestions' },
    hint: {
      zh: '用模型生成「下一句话」的建议。关掉可省 token，历史补全与热度统计照常工作。',
      en: 'Generate the next-prompt suggestion with the model. Turning it off saves tokens; history completion and hotness still work.',
    },
    kind: 'boolean',
    section: 'llm',
    writable: true,
  },
  {
    key: 'streamingDelivery',
    label: { zh: '流式投递建议', en: 'Stream suggestion frames' },
    hint: {
      zh: '让建议文字逐步浮现，而不是一次性整段出现。只影响观感，不改变生成速度。',
      en: 'Show suggestions appearing gradually instead of all at once. Affects appearance only, not speed.',
    },
    kind: 'boolean',
    section: 'llm',
    writable: true,
  },

  // ⚠️ 这两条 hint 原文写的是「留空继承主请求路由」—— 那正是 #47 的故障语义（主会话换到
  // 一条 401 的路由，建议与补全全部跟着漂过去）。留空现在的含义是**跟随部署默认**
  // （GUI 头部选的那条），要旧行为得显式打开下面那个开关。文案跟着语义走，不然界面在骗人。
  {
    key: 'provider',
    group: 'route',
    label: { zh: 'Provider', en: 'Provider' },
    hint: {
      zh: '建议用哪个模型服务。留空 = 跟随系统默认，但不跟随当前会话。',
      en: 'Which provider suggestions use. Leave empty to follow the system default (not the current session).',
    },
    kind: 'catalog',
    catalog: 'providers',
    section: 'llm',
    writable: true,
  },
  {
    key: 'model',
    group: 'route',
    label: { zh: 'Model', en: 'Model' },
    hint: {
      zh: '建议用哪个模型。要和上一项成对填写；两项都留空 = 跟随系统默认。',
      en: 'Which model suggestions use. Fill it together with the provider; leave both empty to follow the system default.',
    },
    kind: 'catalog',
    catalog: 'models',
    section: 'llm',
    writable: true,
  },
  {
    key: 'suggestionReasoningEffort',
    group: 'route',
    label: { zh: '建议推理档位', en: 'Suggestion reasoning effort' },
    hint: {
      zh: '生成建议时的思考强度。留空 = 用模型自己的默认。不同模型可选档位不同，列表里没有可以直接填。',
      en: 'Thinking effort for suggestions. Empty uses the model default. Available levels differ per model; you can type one if it is not listed.',
    },
    // 目录驱动（#50）：选项来自宿主 llm.resolveModel(provider, model).reasoning.efforts
    // —— 合法集合随模型变，所以不能硬编码；拿不到就退化成文本框（见 renderField）。
    kind: 'catalog',
    catalog: 'efforts',
    section: 'llm',
    writable: true,
  },
  {
    key: 'inheritSessionRoute',
    label: { zh: '允许继承会话路由', en: 'Allow inheriting the session route' },
    hint: {
      zh: '关闭时，没有单独指定模型的建议跟随系统默认。一般保持关闭。',
      en: 'When off, suggestions without their own provider/model follow the system default. Usually keep it off.',
    },
    kind: 'boolean',
    section: 'llm',
    writable: true,
  },
  // —— 自定义提示词（Gitea #182）——
  //
  // 放在各自分组的最末：它替代的是整条生成指令，不是某个阈值，排在一堆数字中间
  // 会让人以为它也是其中之一。占位符语义写在说明里——不填就永远用内置模板，
  // 所以默认形态下它只是一行安静的说明。
  // 上限 `PROMPT_MAX_CHARS` 从 `src/prompt-override.ts` 引，不在这里抄一份数字：
  // 抄来的数字与 schema 的 `.max()` 一旦分叉，界面挡住的就是另一个长度。
  {
    key: 'suggestionPrompt',
    label: { zh: '下一条建议的提示词', en: 'Suggestion prompt' },
    hint: {
      zh: '留空使用内置提示词。填了则整段替换，可写 {{builtin}} 保留内置原文、{{language}} 取本轮判定语言、{{maxChars}} 取字数上限。',
      en: 'Empty uses the built-in prompt. Your text replaces it: {{builtin}} keeps the built-in one, {{language}} the detected language, {{maxChars}} the character limit.',
    },
    kind: 'textarea',
    section: 'llm',
    writable: true,
  },
  // —— 历史前缀补全 ——
  {
    key: 'historyEnabled',
    label: { zh: '启用历史补全', en: 'Enable history completion' },
    hint: {
      zh: '输入时用你以前说过的话补全后半句。',
      en: 'Complete what you are typing using things you said before.',
    },
    kind: 'boolean',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyCrossSession',
    label: { zh: '跨会话搜索', en: 'Cross-session search' },
    hint: {
      zh: '也参考其他会话的历史。关掉则只用当前会话。',
      en: 'Also draw on your other sessions. Off limits it to the current session.',
    },
    kind: 'boolean',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyMaxEntries',
    group: 'pair',
    label: { zh: '最大历史条目', en: 'Max history entries' },
    hint: {
      zh: '最多参考多少条历史记录（0 = 不限）。',
      en: 'How many history entries to draw on (0 = no limit).',
    },
    kind: 'number',
    section: 'history',
    writable: true,
  },
  {
    key: 'historyMinChars',
    group: 'pair',
    // label 必须带模式名：卡片里 `historyMinChars` 与 `inlineMinChars` 曾共用
    // 「最少输入字符」，两个 section 各出现一次——用户改了「历史」那个（存成 3），
    // 以为续写阈值也是 3，实际续写仍按默认 4 判定（2026-10-23 现场）。
    label: { zh: '最少输入字符（历史补全）', en: 'Min typed characters (history)' },
    hint: {
      zh: '输入几个字之后才开始补全，避免频繁打扰。',
      en: 'How many characters to type before completion starts.',
    },
    kind: 'number',
    section: 'history',
    writable: true,
  },
  {
    key: 'wordAccept',
    label: { zh: '逐词采纳', en: 'Word-by-word accept' },
    hint: {
      zh: '关掉后不再逐词吃进建议，那个键回到它原本的作用。用哪个键逐词在「键位」里改。',
      en: 'Off = no chunk-by-chunk take-in; that key goes back to its normal job. The key itself is set under Shortcuts.',
    },
    kind: 'boolean',
    section: 'keybinds',
    writable: true,
  },
  {
    key: 'showKeyHint',
    label: { zh: '键位提示', en: 'Key hint' },
    hint: {
      zh: '建议出现时显示一行当前键位，内容跟随你在「键位」里改过的每一个键。关掉后说明只在这个页面。',
      en: 'While a suggestion is shown, one line lists the live keys — it follows every change you make under Shortcuts. Off = the explanation lives only here.',
    },
    kind: 'boolean',
    // 从「外观」移进「键位」：它是键位的**展示开关**，用户改完键顺手要关的就是它，
    // 留在外观区等于让人在两个分区之间来回找（#157 的实机反馈原本是反过来找的）。
    section: 'keybinds',
    writable: true,
  },
  // —— 停顿续写 ——
  {
    key: 'inlineEnabled',
    label: { zh: '停顿续写', en: 'Pause completion' },
    hint: {
      zh: '你停下来时，由模型接着往下写。',
      en: 'Let the model continue your draft when you pause.',
    },
    kind: 'boolean',
    section: 'inline',
    writable: true,
  },
  {
    key: 'inlineDelayMs',
    group: 'pair',
    label: { zh: '停顿时长', en: 'Pause duration' },
    hint: {
      zh: '停下多久之后才开始续写（毫秒）。',
      en: 'How long to pause before continuation starts (ms).',
    },
    kind: 'number',
    section: 'inline',
    writable: true,
  },
  {
    key: 'inlineMinChars',
    group: 'pair',
    label: { zh: '最少输入字符（停顿续写）', en: 'Min typed characters (pause)' },
    hint: {
      zh: '至少输入几个字才会触发续写。',
      en: 'Minimum characters before continuation can trigger.',
    },
    kind: 'number',
    section: 'inline',
    writable: true,
  },
  {
    key: 'inlineMaxChars',
    group: 'pair',
    label: { zh: '续写长度上限', en: 'Completion length cap' },
    hint: {
      zh: '续写最多显示多少字，超出按词截断。',
      en: 'Max length of the continuation; longer output is cut at a word boundary.',
    },
    kind: 'number',
    section: 'inline',
    writable: true,
  },
  {
    key: 'completionReasoningEffort',
    group: 'pair',
    label: { zh: '续写推理档位', en: 'Completion reasoning effort' },
    hint: {
      zh: '续写时的思考强度。留空 = 用模型默认。这里通常选低档，等待更短。',
      en: 'Thinking effort for continuation. Empty uses the model default; a low level usually feels snappier.',
    },
    // 目录驱动（#50）：选项来自宿主 resolveModel 的该模型合法档位；拿不到退化文本框
    kind: 'catalog',
    catalog: 'efforts',
    section: 'inline',
    writable: true,
  },
  {
    key: 'completionPrompt',
    label: { zh: '续写的提示词', en: 'Completion prompt' },
    hint: {
      zh: '留空使用内置提示词。{{builtin}} / {{language}} / {{maxChars}} 的含义与「下一条建议的提示词」一致。',
      en: 'Empty uses the built-in prompt. {{builtin}}, {{language}} and {{maxChars}} mean the same as in the suggestion prompt.',
    },
    kind: 'textarea',
    section: 'inline',
    writable: true,
  },
  // —— 语言设置 ——
  {
    key: 'languageMode',
    label: { zh: '建议语言', en: 'Suggestion language' },
    hint: {
      zh: '自动：根据界面语言和你的输入判断；指定：固定使用所选语言。',
      en: 'Auto follows the interface language and what you type; a fixed choice always uses that language.',
    },
    kind: 'select',
    section: 'language',
    writable: true,
    options: [
      { value: 'auto', label: { zh: '自动', en: 'Auto' } },
      { value: 'zh', label: { zh: '简体中文', en: 'Simplified Chinese' } },
      { value: 'zh-TW', label: { zh: '繁體中文', en: 'Traditional Chinese' } },
      { value: 'en', label: { zh: 'English', en: 'English' } },
      { value: 'ja', label: { zh: '日本語', en: 'Japanese' } },
      { value: 'ko', label: { zh: '한국어', en: 'Korean' } },
      { value: 'ru', label: { zh: 'Русский', en: 'Russian' } },
      { value: 'fr', label: { zh: 'Français', en: 'French' } },
      { value: 'de', label: { zh: 'Deutsch', en: 'German' } },
      { value: 'es', label: { zh: 'Español', en: 'Spanish' } },
    ],
  },
  {
    key: 'uiLocaleWeight',
    label: { zh: '界面语言权重', en: 'UI language weight' },
    hint: {
      zh: '「自动」时界面语言的分量（0–500）。越大越贴近界面语言，0 = 完全不看界面。',
      en: 'In Auto mode, how much the interface language counts (0–500). 0 ignores it entirely.',
    },
    kind: 'number',
    section: 'language',
    writable: true,
  },
];

/** 卡片 chrome 微文案源字典（zh）：键集为唯一事实来源。 */
const zhStrings = {
  /** 只读提示 */
  readOnly: '当前部署不可写（内存模式）',
  /** 策略字段（非 volatile）只能改配置文件 */
  configOnly: '策略字段：host 端未开放写入，请改 cordis.patch.yml',
  /** 显示设置 section（仅详情页显示） */
  sectionDisplay: '显示设置',
  /** 「外观」分组：纯视觉开关（两个光效 + 键位提示）。 */
  sectionAppearance: '外观',
  /** 实验性徽章（与 dsh-later 的「高级语法」同一口径：默认关 + 标题挂徽章）。 */
  betaBadge: '实验性',
  betaBadgeAria: '实验性功能，行为可能随版本调整',
  showInSettings: '在设置中显示',
  showInSettingsHint: '在设置对话框中显示本插件的设置页（刷新页面后生效）',
  /** 分组标题 */
  sectionLlm: 'LLM 下一条建议',
  sectionHistory: '历史前缀补全',
  sectionInline: '停顿续写',
  sectionLanguage: '语言设置',
  /** 帮助按钮无障碍标签（label 为字段名） */
  helpFor: (label: string): string => `${label}说明`,
  /** footer 状态与按钮 */
  saved: '已保存',
  discard: '放弃修改',
  saving: '保存中…',
  save: '保存',
  /** 数字字段校验错误 */
  invalidNumber: '请输入数字',
  /** 多行提示词字段：占位符与超长说明（超长必须在保存前挡住，理由见 fieldInvalid）。 */
  promptPlaceholder: '留空 = 使用内置提示词',
  promptTooLong: (max: number, current: number): string =>
    `提示词最长 ${max} 字，当前 ${current} 字，请精简后再保存`,
  /** 快捷键控件 */
  keyCapturing: '按下组合键…（Esc 取消）',
  keyEmpty: '点击设置快捷键',
  keyReset: '恢复默认',
  // —— 键位分区 ——
  sectionKeybinds: '键位',
  keybindNote: '这里列的键只在幽灵出现时生效；改完保存，输入框上方那行提示会跟着变。',
  keyUnsafe: (label: string): string => `这个键会吃掉你正在打的字，${label}换一个`,
  keySendCollision: '用 Enter 采纳会顶掉「发送」，改用组合键更稳',
  keyConflict: (other: string, winner: string): string =>
    `与「${other}」用了同一个键；同时按下时由「${winner}」先拿走`,
  keyEffective: '当前生效：',
  keyScopeLlm: '下一条建议',
  keyScopeLocal: '历史 / 续写',
  keybindJoin: '；',
  // —— 热度管理 ——
  sectionHotness: '热度管理（跨会话高频短语）',
  hotHint: '即时生效，无需保存。删除只清当前统计（再次输入会重新计入）；固定后不参与淘汰、跨会话候选恒置顶。',
  hotSearch: '在下方列表中过滤…',
  hotEmpty: '暂无热度条目——正常使用几个回合后自动累积。',
  hotNoMatch: '没有匹配的条目（仅过滤当前显示的 top-K）。',
  hotAdd: '添加',
  hotAddPlaceholder: '手工新增一条候选短语…',
  hotPin: '固定',
  hotUnpin: '取消固定',
  hotPinnedBadge: '已固定',
  hotDelete: '删除',
  hotClear: '清空全部',
  hotClearConfirm: '确认清空？',
  // —— 已忽略（本单）——
  sectionIgnored: '已忽略（不会再被补全）',
  ignoredHint: '这些句子被「别再补这句」键移出了候选池，也停止计入热度。点「恢复」让它们重新参与补全；恢复不补回频次（频次是观测值，被忽略期间本来就没再记过账）。',
  ignoredEmpty: '还没有忽略任何句子。用幽灵提示的「别再补这句」快捷键即可加入这里。',
  ignoredRestore: '恢复',
  ignoredClear: '全部恢复',
  ignoredMeta: (total: number): string => `共忽略 ${total} 条`,
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `共 ${total} 条，显示热度最高的 ${shown} 条` : `共 ${total} 条`,
  // —— 目录型下拉框的占位项与档位诊断 ——
  // 这七条此前是**硬编码中文写在渲染路径里**的，没走字典：英文界面下卡片其余部分
  // 都是英文，唯独这几个下拉项/占位符露出中文。宿主注册了 ja 等六门之后，
  // 回退方向改成英文（`ghost-lang.ts`）把这类残留放大成肉眼可见的破洞，故一并收编。
  catalogDeployDefault: '（跟随部署默认）',
  catalogEffortOmit: '（不传，沿用模型默认）',
  catalogPickProvider: '（先选 provider）',
  effortDefaultMark: '（默认）',
  effortNotInCatalog: '（不在当前目录里）',
  effortCatalogStale: '（宿主未提供档位目录：重启一次后本栏会变下拉）',
  effortCatalogEmpty: '（该模型未声明推理档位，可手填）',
  catalogDiagTail: (diag: string): string => `｜目录 ${diag}`,
} as const;

/** en 字典：映射类型约束与 zh 键集完全一致（缺键/多键均为编译期错误）。 */
const enStrings: { [K in keyof typeof zhStrings]: (typeof zhStrings)[K] } = {
  readOnly: 'Not writable in this deployment (in-memory mode)',
  configOnly: 'Strategy field: not writable from the UI — edit cordis.patch.yml',
  sectionDisplay: 'Display',
  sectionAppearance: 'Appearance',
  betaBadge: 'Beta',
  betaBadgeAria: 'Beta feature; behaviour may change between versions',
  showInSettings: 'Show in settings',
  showInSettingsHint: 'Show this plugin\'s settings page in the settings dialog (refresh to take effect)',
  sectionLlm: 'LLM next suggestion',
  sectionHistory: 'History prefix completion',
  sectionInline: 'Pause completion',
  sectionLanguage: 'Language settings',
  helpFor: (label: string): string => `About ${label}`,
  saved: 'Saved',
  discard: 'Discard changes',
  saving: 'Saving…',
  save: 'Save',
  invalidNumber: 'Enter a number',
  promptPlaceholder: 'Leave empty to use the built-in prompt',
  promptTooLong: (max: number, current: number): string =>
    `Prompts are limited to ${max} characters; this one has ${current}. Shorten it before saving`,
  keyCapturing: 'Press a key combo… (Esc to cancel)',
  keyEmpty: 'Click to set a shortcut',
  keyReset: 'Reset',
  sectionKeybinds: 'Shortcuts',
  keybindNote: 'These keys only apply while a suggestion is on screen. Save, and the hint line above the composer follows.',
  keyUnsafe: (label: string): string => `That key would eat what you are typing — pick another for ${label}`,
  keySendCollision: 'Using Enter to accept takes over Send — a combo is safer',
  keyConflict: (other: string, winner: string): string =>
    `Same key as “${other}”; on that press “${winner}” takes it first`,
  keyEffective: 'In effect: ',
  keyScopeLlm: 'Next suggestion',
  keyScopeLocal: 'History / pause',
  keybindJoin: ' — ',
  // —— Hotness management ——
  sectionHotness: 'Hotness management (frequent cross-session phrases)',
  hotHint: 'Takes effect immediately, no save needed. Delete only clears the current tally (typing it again re-counts); pinned entries are exempt from eviction and always lead cross-session candidates.',
  hotSearch: 'Filter the list below…',
  hotEmpty: 'No entries yet — they accumulate automatically after a few turns of normal use.',
  hotNoMatch: 'No matching entries (filters the displayed top-K only).',
  hotAdd: 'Add',
  hotAddPlaceholder: 'Manually add a candidate phrase…',
  hotPin: 'Pin',
  hotUnpin: 'Unpin',
  hotPinnedBadge: 'Pinned',
  hotDelete: 'Delete',
  hotClear: 'Clear all',
  hotClearConfirm: 'Confirm clear?',
  // —— Ignored (this change) ——
  sectionIgnored: 'Ignored (no longer completed)',
  ignoredHint: 'These lines were removed from the candidate pool by the forget shortcut, and stop counting toward hotness. Restore puts them back into completion; it does not restore the tally, since nothing was counted while they were ignored.',
  ignoredEmpty: 'Nothing ignored yet. Use the forget shortcut on a ghost to add entries here.',
  ignoredRestore: 'Restore',
  ignoredClear: 'Restore all',
  ignoredMeta: (total: number): string => `${total} ignored`,
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`,
  catalogDeployDefault: '(follow the deployment default)',
  catalogEffortOmit: '(omit; use the model default)',
  catalogPickProvider: '(pick a provider first)',
  effortDefaultMark: '(default)',
  effortNotInCatalog: '(not in the current catalog)',
  effortCatalogStale: '(no effort catalog from the host — this field becomes a dropdown after a restart)',
  effortCatalogEmpty: '(this model declares no reasoning efforts; you can type one)',
  catalogDiagTail: (diag: string): string => ` | catalog ${diag}`,
};

/** 单语言 chrome 文案字典类型（zh/en 通用；值随 zh 源字典，含函数成员）。 */
export type GhostStrings = { [K in keyof typeof zhStrings]: (typeof zhStrings)[K] };

/** 全部语言字典（键集一致，由 enStrings 的映射类型保证）。 */
const GHOST_STRINGS: Record<GhostLang, GhostStrings> = { zh: zhStrings, en: enStrings };

/** 卡片组件 props：由槽位注册的 inject 提供。 */
/**
 * 官方同源模型目录的一行（来自客户端服务 `ctx.modelDirectories`）。
 *
 * 与设置页的模型选择器**同一份数据**：`groups[].id` 就是 provider 路由 id、
 * `models[].id` 就是 model id（已核实官方代码里 `group.id === selection.provider`），
 * `models[].reasoning` 带每个模型的 `efforts` / `defaultEffort`。
 */
export interface OfficialModelGroup {
  readonly id: string;
  readonly name: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly reasoning?: {
      readonly efforts?: ReadonlyArray<{ id: string; name: string; description?: string }>;
      readonly defaultEffort?: string;
    };
  }>;
}

export interface SuggestGhostCardProps {
  scope: PluginSettingsScope<ScopeSnapshot>;
  /** 宿主 locale 服务 face（可选增强；缺失或旧宿主回退中文）。 */
  locale?: LocaleFaceLike;
  /** 卡片所在表面：详情页（detail）或设置对话框（settings）。
   *  详情页显示「在设置中显示」开关；设置页不显示。 */
  surface?: 'detail' | 'settings';
  /**
   * 官方模型目录读取器（`ctx.modelDirectories` 适配）。**优先于**自建 HTTP 目录：
   * 与设置页同一份数据、含每模型 efforts、且不需要那条不经鉴权的路由。
   * 返回 null / 抛错 ⇒ 退回 HTTP 目录；HTTP 也拿不到 ⇒ 退回文本框。
   */
  modelCatalog?: () => readonly OfficialModelGroup[] | null;
  /** 目录规模诊断（宿主返回了多少组/模型/带档位的），退化时直接显示给用户看。 */
  modelCatalogDiag?: () => string | null;
  /** 官方目录加载/刷新后的通知（订阅后卡片据此重渲染）。 */
  modelCatalogSubscribe?: (listener: () => void) => () => void;
}

/** 会话状态快照的值类型。 */
type Value = Record<string, unknown>;
/** 未改动项的原始值 -> 显示用字符串。 */
function displayValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 快捷键捕获控件：点击进入录制态，按下组合键即写入规范 spec（Esc 取消录制）。
 *
 * 录制经 `keyspec.keyEventToSpec`，写入值与匹配端（`specMatches`）同一张主键表，
 * 所以「卡片里录进去的键」必然「幽灵那边命中得了」——这条同表关系是本控件存在的理由,
 * 否则又是一处「设置说一套、按键做一套」（Gitea #167 的病根）。
 *
 * 三件新增的事，都由 `keyspec.ts` 的判据驱动，卡片自己**不拼任何键名规则**：
 *  - `validate`：录到不安全的键（会吃掉正在打的字）⇒ **不写入**，就地说明为什么。
 *  - `notes`：只警告不禁止（裸 Enter 顶掉发送、与其它动作同键），因为「一个键做两件事」
 *    是用户的表达，禁止它会把「键盘不舒服」变成「保存不了」。
 *  - `resetTo`：恢复默认。它不只是便利——`Escape` **录不进来**（录制态里 Esc 的语义是
 *    「取消录制」，这是键盘控件的通用约定），所以「把关闭键从别的键改回 Esc」只能走这里。
 *    没有这颗按钮，`dismissKey` 改掉之后就再也回不到默认，那是不可逆的一次误操作。
 */
function KeyField({ id, value, disabled, t, onChange, validate, notes, resetTo }: {
  id: string;
  value: string;
  disabled: boolean;
  t: GhostStrings;
  onChange: (spec: string) => void;
  /** 录到一个 spec 时是否接受；返回字符串 = 拒绝并把这句话显示给用户。 */
  validate?: (spec: string) => string | undefined;
  /** 常驻在按钮下方的警告行（已解析好的文案）。 */
  notes?: readonly string[];
  /** 默认值；与当前值不同时显示「恢复默认」。空串也是合法默认（= 不接管）。 */
  resetTo?: string;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        setRejected(null);
        return;
      }
      const spec = keyEventToSpec(event); // 纯修饰键返回 undefined，继续等待主键
      if (spec === undefined) return;
      const refusal = validate?.(spec);
      if (refusal !== undefined) {
        // 拒绝时**留在录制态**：用户下一步就是再按一个键，不该逼他再点一次按钮。
        setRejected(refusal);
        return;
      }
      onChange(spec);
      setCapturing(false);
      setRejected(null);
    };
    const cancel = (): void => setCapturing(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
    };
  }, [capturing, onChange, validate]);
  const canReset = resetTo !== undefined && resetTo !== value;
  return (
    <>
      <div className="sgc-keyRow">
        <button
          type="button"
          id={id}
          className={capturing ? 'sgc-key sgc-keyCapturing' : 'sgc-key'}
          disabled={disabled}
          onClick={() => { setCapturing(c => !c); setRejected(null); }}
        >
          {capturing ? t.keyCapturing : value === '' ? t.keyEmpty : value}
        </button>
        {canReset && (
          <button type="button" className="sgc-keyReset" disabled={disabled} onClick={() => onChange(resetTo)}>
            {t.keyReset}
          </button>
        )}
      </div>
      {rejected !== null && <p className="sgc-keyReject">{rejected}</p>}
      {(notes ?? []).map((note) => (
        <p key={note} className="sgc-keyWarn">{note}</p>
      ))}
    </>
  );
}

/**
 * 键位字段 → 角色元数据。
 *
 * `safety` 取 `block` 还是 `warn` 不是审美：
 *  - `block`（新加的三个字段）：这些形态**边打字边出幽灵**，配成打字键会吃掉用户
 *    正在输入的内容，而且旧存档里不可能已经有这种值（字段是新的），所以拦下来不会
 *    让任何人的既有配置变成「打开设置就报错」。
 *  - `warn`（`acceptKey` / `regenKey`）：字段早就允许字母键，用户可能就是这么存的。
 *    此刻把判据升级成禁止，等于让用户保存过的一份配置**当场写不回去**；
 *    所以这里只警告，不改写、也不拦保存（Gitea #167 拍板的是范围，不是键面）。
 */
const KEY_BINDINGS: Record<string, { action: KeyAction; resetTo: string; safety: 'block' | 'warn' }> = {
  acceptKey: { action: 'accept', resetTo: 'Tab', safety: 'warn' },
  localAcceptKey: { action: 'accept', resetTo: 'Tab', safety: 'block' },
  wordAcceptKey: { action: 'word', resetTo: 'Right', safety: 'block' },
  regenKey: { action: 'regen', resetTo: 'Alt+G', safety: 'warn' },
  dismissKey: { action: 'dismiss', resetTo: 'Escape', safety: 'block' },
  // 忽略键：`safety: 'block'` —— 它是**三形态都生效**的动作，配成裸字母键就等于
  // 在用户每次打那个字母时都删掉一条候选（不可逆，且用户看不出是自己配的）。
  // 与 `localAcceptKey` / `wordAcceptKey` 同一条理由。
  forgetKey: { action: 'forget', resetTo: 'Alt+X', safety: 'block' },
};

/** 动作名（摘要行用）。与提示行的措辞同源同义，只是那边写「Tab 采纳」这边写「采纳：Tab」。 */
const ACTION_WORD: Record<KeyAction, { zh: string; en: string }> = {
  accept: { zh: '采纳', en: 'accept' },
  word: { zh: '逐词', en: 'word' },
  regen: { zh: '换一条', en: 'another' },
  dismiss: { zh: '关闭', en: 'dismiss' },
  forget: { zh: '别再补', en: 'forget' },
};

/**
 * 每个键位字段**参与哪张仲裁表**。
 *
 * 这是本条判据的全部要点：`acceptKey`（下一条建议）与 `localAcceptKey`（历史 / 续写）
 * 默认都是 `Tab`，而它们**永远不会在同一次按键上相遇**——一个只在 `llm` 形态生效，
 * 另一个只在 `history` / `inline` 生效。把它们放进同一个集合里比撞键，
 * 结果是默认设置一打开就报两条警告（本单第一版真就这么写了，在沙箱里看到才发现）。
 * 真正的竞争单位是 `ownerOfKey` 读的那张表，所以这里也按表分：
 *  - `llm` 表：`acceptKey` / `regenKey` / `dismissKey`
 *  - 本地表：`localAcceptKey` / `wordAcceptKey` / `dismissKey`
 * `dismissKey` 两边都在 ⇒ 它跟任一边撞都算撞。
 */
/** 动作 -> 承载它的设置字段（`keyConflict` 要说清「跟谁撞了、谁赢」）。 */
const KEY_FIELD_OF: Partial<Record<KeyAction, string>> = {
  accept: 'acceptKey',
  word: 'wordAcceptKey',
  regen: 'regenKey',
  dismiss: 'dismissKey',
  forget: 'forgetKey',
};

const KEY_TABLES: Record<string, readonly ('llm' | 'local')[]> = {
  acceptKey: ['llm'],
  regenKey: ['llm'],
  localAcceptKey: ['local'],
  wordAcceptKey: ['local'],
  dismissKey: ['llm', 'local'],
  // 忽略键三形态都接管（与 dismiss 同一圈）：`llm` 的建议文本同样进热表，
  // 用户对它的「别再补这句」意图一致。
  forgetKey: ['llm', 'local'],
};

/** 一张表里各字段的 spec（`switches` 提供两个开关的当前值）。 */
const tableOf = (which: 'llm' | 'local', read: (k: string) => string, switches: { word: boolean; regen: boolean }) =>
  bindingTableFor(which === 'llm'
    ? {
      kind: 'llm',
      acceptKey: read('acceptKey'),
      regenKey: read('regenKey'),
      regenEnabled: switches.regen,
      dismissKey: read('dismissKey'),
      forgetKey: read('forgetKey'),
    }
    : {
      kind: 'history',
      localAcceptKey: read('localAcceptKey'),
      wordAcceptKey: read('wordAcceptKey'),
      wordAccept: switches.word,
      dismissKey: read('dismissKey'),
      forgetKey: read('forgetKey'),
    });

/**
 * 一个键位字段当前的警告行（可能为空）。
 *
 * 三条判据全部来自 `keyspec.ts`（`isSafeActionKey` / `isSendCollisionKey` / `ownerOfKey`），
 * 卡片只负责翻成人话——**这里不许出现任何键名比较**，否则运行时判据与界面判据
 * 又会分叉成两份（#167 那一课）。「谁赢」也不是文案编的：拿 `ownerOfKey` 判出来的
 * 优先级胜者写进句子，改优先级表时这句话会自己跟着变。
 */
function keyNotes(
  key: string,
  value: string,
  lang: GhostLang,
  t: GhostStrings,
  read: (key: string) => string,
  switches: { word: boolean; regen: boolean },
): string[] {
  const meta = KEY_BINDINGS[key];
  if (meta === undefined || value === '') return [];
  const notes: string[] = [];
  // 值不安全就警告，**与 safety 是 block 还是 warn 无关**：`block` 只拦录制端，
  // 而配置文件（`cordis.patch.yml`）可以直接写进一个裸字母键位——那种值今天照样生效，
  // 不警告就等于把「会吃掉你打的字」这个后果藏起来。
  if (!isSafeActionKey(value)) {
    notes.push(t.keyUnsafe(GHOST_FIELDS.find(f => f.key === key)?.label[lang] ?? key));
  }
  // 裸 Enter：不禁止（§7.2 拍板），但它确实顶掉「发送」，必须让用户看见这一层。
  if (isSendCollisionKey(value)) notes.push(t.keySendCollision);
  for (const which of KEY_TABLES[key] ?? []) {
    const table = tableOf(which, read, switches);
    // 撞键判定直接调 `bindingConflicts`（与运行时同一份 `specIndex` 口径），
    // 不在卡片里手写「找另一个同键的动作」——手写那份就是第二份判据（#167 那一课）。
    const clashes = bindingConflicts(table, meta.action);
    if (clashes.length === 0) continue;
    const loser = clashes[0]!;
    // 胜者由 `ownerOfKey` 判出来（`factsOfSpec` 造一次「按对了」的事实），
    // 不在文案里写死「采纳优先」——改优先级表时这句话会自己跟着变。
    const facts = factsOfSpec(value);
    const winner = facts === undefined ? meta.action : ownerOfKey({ ...table, [meta.action]: value, [loser]: value }, facts);
    // `accept` 这个动作在 llm 表里由 `acceptKey` 承载、在本地表里由 `localAcceptKey` 承载，
    // 所以按「正在比对哪张表」取字段，不能只查一张静态表。
    const fieldOf = (a: KeyAction): string =>
      (a === 'accept' && which === 'local' ? 'localAcceptKey' : KEY_FIELD_OF[a]) ?? '';
    const labelOf = (k: string): string => String(GHOST_FIELDS.find(f => f.key === k)?.label[lang] ?? k);
    notes.push(t.keyConflict(labelOf(fieldOf(loser)), labelOf(fieldOf(winner ?? meta.action))));
    break;
  }
  return notes;
}

/** `_push` 载荷里的热度条目（管理面板消费）。 */
interface HotPushEntry {
  readonly text: string;
  readonly count: number;
  readonly pinned?: boolean;
}

/** 热度管理分组：列表（固定/删除）、新增、清空。操作经 `_ops` 通道**即时生效**
 * （scope.set 直接写入，不进卡片的暂存/保存流程）；列表数据来自 `_push`
 * 实时推送，host 消费后回推最新状态，本组件随订阅无刷新重渲染。 */
function HotnessSection({ scope, pushRaw, hotRaw, writable, busy, lang, t, uiLocale }: {
  scope: PluginSettingsScope<Record<string, unknown>>;
  /** 当前 `_push` 字段原始值（由卡片从 scope 快照透传）。 */
  pushRaw: unknown;
  /** 热度假设：`#36` 起热度住在独立的 `_hot` 格（旧宿主塞在 `_push.hot` 里，作为回退）。 */
  hotRaw: unknown;
  writable: boolean;
  busy: boolean;
  lang: GhostLang;
  t: GhostStrings;
  /** UI 语言（'zh' | 'en'），捎带给 host 做语言先验。 */
  uiLocale?: string;
}): ReactElement {
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const opsRev = useRef(0);
  // 清空按钮的双击确认：3 秒未确认自动复位。
  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const disabled = !writable || busy;
  /**
   * 解析一格载荷（`{hot, total}`）。残缺/非字符串一律返回 null。
   *
   * ⚠️ 这里曾经只读 `_push`：`#36` 把热度拆到独立 `_hot` 格之后，卡片仍然盯着
   * `_push.hot` ⇒ **永远读到空**，界面上表现为"共 0 条"，且刷新/重启都救不回来
   * （宿主明明一直在写 `_hot`）。所以顺序必须是：**先 `_hot`，再 `_push`（旧宿主）**。
   */
  const parseHotCell = (raw: unknown): { hot?: HotPushEntry[]; total?: number; ignored?: unknown } | null => {
    if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
    try {
      return JSON.parse(raw) as { hot?: HotPushEntry[]; total?: number };
    } catch {
      return null;
    }
  };
  const hotCell = parseHotCell(hotRaw);
  const pushCell = parseHotCell(pushRaw);
  const hotSource = hotCell ?? pushCell;
  let hot: readonly HotPushEntry[] = Array.isArray(hotSource?.hot) ? hotSource.hot : [];
  let total = typeof hotSource?.total === 'number' ? hotSource.total : 0;
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;
  // 已忽略（本单）：与 `hot` 同格、同一条「先 `_hot`，再 `_push`」的读取顺序。
  // 残缺项直接过滤（载荷来自宿主，但演示/旧宿主可能缺字段，不能让一处畸形打死整张卡片）。
  const ignored: readonly { norm: string; text: string }[] = Array.isArray(hotSource?.ignored)
    ? (hotSource.ignored as unknown[]).filter(
      (e): e is { norm: string; text: string } =>
        typeof e === 'object' && e !== null
        && typeof (e as { norm?: unknown }).norm === 'string'
        && typeof (e as { text?: unknown }).text === 'string')
    : [];

  /** 发送一批管理操作（幂等协议；rev 仅用于 client 侧递增）。 */
  const sendOps = (ops: readonly HotnessOp[]): void => {
    if (!writable) return;
    opsRev.current += 1;
    const payload: Record<string, unknown> = { rev: opsRev.current, ops };
    if (uiLocale) payload.locale = uiLocale;
    void scope.set('_ops', JSON.stringify(payload));
  };

  const needle = search.trim().toLowerCase();
  const visible = needle === ''
    ? hot
    : hot.filter((entry) => entry.text.toLowerCase().includes(needle));

  return (
    <>
      <p className="sgc-hint">{t.hotHint}</p>
      <input
        className="sgc-input"
        type="text"
        aria-label={t.hotSearch}
        placeholder={t.hotSearch}
        value={search}
        disabled={disabled}
        onChange={e => setSearch(e.target.value)}
      />
      {hot.length === 0 ? (
        <p className="sgc-hint">{t.hotEmpty}</p>
      ) : visible.length === 0 ? (
        <p className="sgc-hint">{t.hotNoMatch}</p>
      ) : (
        <div className="sgc-hotList" role="list">
          {visible.map((entry) => (
            <div className="sgc-hotRow" role="listitem" key={entry.text}>
              {entry.pinned === true && <span className="sgc-hotPinFlag">{t.hotPinnedBadge}</span>}
              <span className="sgc-hotText" title={entry.text}>{entry.text}</span>
              <span className="sgc-hotCount">×{entry.count}</span>
              <button
                type="button"
                className="sgc-hotBtn"
                disabled={disabled}
                onClick={() => sendOps([{ op: 'pin', text: entry.text, pinned: entry.pinned !== true }])}
              >
                {entry.pinned === true ? t.hotUnpin : t.hotPin}
              </button>
              <button
                type="button"
                className="sgc-hotBtn sgc-hotBtnDanger"
                disabled={disabled}
                onClick={() => sendOps([{ op: 'delete', text: entry.text }])}
              >
                {t.hotDelete}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="sgc-hotAdd">
        <input
          className="sgc-input"
          type="text"
          aria-label={t.hotAddPlaceholder}
          placeholder={t.hotAddPlaceholder}
          value={adding}
          disabled={disabled}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && adding.trim() !== '' && !disabled) {
              // 手工新增默认固定：意图是「让它成为候选」，未固定的新条目频次 1
              // 会被真实高频挤到 top-K 之外，用户会以为添加失败。
              sendOps([{ op: 'add', text: adding.trim(), pinned: true }]);
              setAdding('');
            }
          }}
        />
        <button
          type="button"
          className="sgc-hotBtn"
          disabled={disabled || adding.trim() === ''}
          onClick={() => {
            sendOps([{ op: 'add', text: adding.trim(), pinned: true }]);
            setAdding('');
          }}
        >
          {t.hotAdd}
        </button>
      </div>
      <div className="sgc-hotMeta">
        <span className="sgc-hint">{t.hotMeta(total, hot.length)}</span>
        <button
          type="button"
          className={`sgc-hotBtn sgc-hotBtnDanger${confirmClear ? ' sgc-hotConfirming' : ''}`}
          disabled={disabled || hot.length === 0}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            sendOps([{ op: 'clear' }]);
          }}
        >
          {confirmClear ? t.hotClearConfirm : t.hotClear}
        </button>
      </div>

      {/* ── 已忽略（本单）───────────────────────────────────────────────────
          为什么它必须在这里、而不是只做成一个快捷键：
          「别再补这句」是一条**要用户去别处才能撤销**的持久写。没有恢复入口，
          一次误按就等于永久删掉一句常用话 —— 那种设计没人敢用第二次。
          列表读的是与候选过滤**同一个** `ignored` 载荷字段（不是另建一条管理通道），
          所以「按忽略键看到的变化」与「这里列出的条目」不可能分叉。 */}
      <h4 className="sgc-section-heading sgc-ignoredHeading">{t.sectionIgnored}</h4>
      <p className="sgc-hint">{t.ignoredHint}</p>
      {ignored.length === 0 ? (
        <p className="sgc-hint">{t.ignoredEmpty}</p>
      ) : (
        <div className="sgc-hotList" role="list">
          {ignored.map(entry => (
            <div className="sgc-hotRow" role="listitem" key={entry.norm}>
              <span className="sgc-hotText" title={entry.text}>{entry.text}</span>
              <button
                type="button"
                className="sgc-hotBtn"
                disabled={disabled}
                // `restore` 的载荷是**原文**（宿主自己做归一化，与 `forget` 对称）：
                // 客户端送 `norm` 也能命中（宿主对两者都跑一次归一化），但原文更可读，
                // 且留痕里能看出「恢复的是哪一句」。
                onClick={() => sendOps([{ op: 'restore', text: entry.text }])}
              >
                {t.ignoredRestore}
              </button>
            </div>
          ))}
        </div>
      )}
      {ignored.length > 0 && (
        <div className="sgc-hotMeta">
          <span className="sgc-hint">{t.ignoredMeta(ignored.length)}</span>
          <button
            type="button"
            className="sgc-hotBtn"
            disabled={disabled}
            // 全部恢复**不做二次确认**：它与「清空全部热度」不同 —— 这个动作只是把
            // 候选池恢复原样，代价是「那些句子又会出现了」，而不是丢数据。
            // 一次误点的后果可忽略，加确认反而是麻烦。
            onClick={() => {
              for (const entry of ignored) sendOps([{ op: 'restore', text: entry.text }]);
            }}
          >
            {t.ignoredClear}
          </button>
        </div>
      )}
    </>
  );
}

/** 设置卡片：读取/编辑/保存 suggest-ghost 命名空间。
 * 裸表单 + section 分组布局（llm / history 两个 section + 可折叠的热度管理），
 * 文案跟随宿主界面语言（locale 缺失回退中文），语言切换实时重渲染。 */
export function SuggestGhostCard({ scope, locale, surface, modelCatalog, modelCatalogDiag, modelCatalogSubscribe }: SuggestGhostCardProps): ReactElement | null {
  // 样式注入（幂等；卸载时随组件清理）。
  useEffect(() => injectStyles(), []);
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = useState(scope.getSnapshot());
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = useState<Record<string, string | boolean | number>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 帮助按钮展开态（对齐官方 _helpButton_：aria-expanded 切换）。 */
  const [helpOpen, setHelpOpen] = useState<Record<string, boolean>>({});
  // 热度管理分组折叠：默认收起（管理列表较长，配置区保持紧凑）。
  const [hotOpen, setHotOpen] = useState(false);
  /**
   * 「外观」分组默认**折叠**。
   *
   * 这三个开关（两个光效 + 键位提示）都是"调一次就不再管"的视觉偏好，
   * 常开会让设置页一上来就被它们占掉三行；折叠与「热度管理」那一节同款形态
   * （`sgc-sectionBtn` + chevron + aria-expanded）。
   */
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // 「在设置中显示」开关：仅详情页显示，控制 settings.section 是否注册。
  // localStorage 非响应式，切换后需刷新页面生效。
  const SHOW_SETTINGS_KEY = 'dsh-suggest-ghost:show-settings-section';
  const [showSettings, setShowSettings] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';
  });
  const toggleShowSettings = (): void => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, 'true');
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };

  if (snap.status === 'unavailable') return null; // 命名空间未暴露时不显示卡片
  const value = (snap.value ?? {}) as Value;
  const writable = snap.writable && snap.status === 'ready';
  const isDirty = Object.keys(edits).some(k => GHOST_FIELDS.find(f => f.key === k)?.writable === true);

  const fieldValue = (key: string): string => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };

  /**
   * 「当前生效」摘要文本 —— **读仲裁端那张表，不读设置项原值**。
   *
   * 这是 #167 那条不变量（屏幕上写的键 == 真按得动的键）在设置页的出口：
   * 值来自 `bindingTableFor()`，而 `onKeyDown` 读的也是它，所以这块摘要不可能承诺一个
   * 按下去没反应的键。分两行是因为两类形态的采纳键**确实是两个键**
   * （`acceptKey` 管「下一条建议」，`localAcceptKey` 管历史补全与停顿续写）——
   * 写成一行「采纳：Tab」就是在撒谎。关掉的动作（逐词 / 换一条）不出现；
   * `dismissKey` 留空时整段消失，与提示行同一判据。
   */
  const effectiveKeySummary = (): string => {
    // 一律走 `fieldValue`：它已经做了「未保存的编辑优先于快照」的合并（`edits` 兜底
    // `displayValue(value[key])`），再套一层 `edits[k] ??` 是多余的第二份口径。
    // 布尔项在这里是 'true' / 'false' 串（`displayValue` 的产物），所以下面写成
    // `!== 'false'`；早先一版这里按 `KEY_BINDINGS` 白名单过滤，把两个**开关**读成了
    // 空串 ⇒ `'' !== 'false'` 恒真 ⇒ 摘要永远显示「逐词 / 换一条」在生效，
    // 哪怕用户已经把它们关掉。开关不在白名单里，值却一定要读得到。
    const read = (k: string): string => fieldValue(k).trim();
    const parts: string[] = [];
    const switches = {
      word: read('wordAccept') !== 'false',
      regen: read('regenEnabled') !== 'false',
    };
    // 两张表都走 `tableOf`——与警告行读的是同一个组装函数，摘要不可能跟警告各说各话。
    const llm = tableOf('llm', read, switches);
    const local = tableOf('local', read, switches);
    const fmt = (table: ReturnType<typeof bindingTableFor>, prefix: string): string => {
      const seg = Object.entries(table).map(([action, spec]) => {
        const cap = specKeycap(spec);
        if (cap === undefined) return null;
        return `${cap} ${ACTION_WORD[action as KeyAction][lang]}`;
      }).filter((x): x is string => x !== null);
      return seg.length === 0 ? '' : `${prefix} ${seg.join(' · ')}`;
    };
    const a = fmt(llm, t.keyScopeLlm);
    const b = fmt(local, t.keyScopeLocal);
    if (a !== '') parts.push(a);
    if (b !== '') parts.push(b);
    return parts.join(t.keybindJoin);
  };
  /** 数字字段的暂存值是否非法（空或非数字）；与官方 ValueField 校验一致。
   * 多行提示词字段另一条判据：超过 `PROMPT_MAX_CHARS` 直接挡住保存 —— 写进内核会被
   * schema 的 `.max()` 拒，而 `save()` 读不到那次拒绝，界面表现是「点了保存、值没变」。 */
  const fieldInvalid = (f: (typeof GHOST_FIELDS)[number]): boolean => {
    if (!(f.key in edits)) return false;
    if (f.kind === 'number') {
      const raw = String(edits[f.key]).trim();
      return raw === '' || Number.isNaN(Number(raw));
    }
    if (f.kind === 'textarea') return String(edits[f.key]).length > PROMPT_MAX_CHARS;
    return false;
  };
  /** 非法时的说明（两种非法形态的原因不同，不能共用「请输入数字」）。 */
  const invalidMessage = (f: (typeof GHOST_FIELDS)[number]): string => f.kind === 'textarea'
    ? t.promptTooLong(PROMPT_MAX_CHARS, String(edits[f.key] ?? '').length)
    : t.invalidNumber;
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key: string, raw: string | boolean | number): void => {
    setEdits(prev => ({ ...prev, [key]: raw }));
  };
  // ── 模型目录（#116）：provider 列表 + 按 provider 懒加载的 model 列表 ─────────
  //
  // 三条硬规矩，都是这个仓里踩过坑的形状：
  //  1. **拿不到目录就退回自由文本输入框**（老代次可能没有 webServer / 路由注册失败 /
  //     宿主没接 llm）。设置项绝不能因为目录不可用而不可用，更不能让卡片抛。
  //  2. **当前值不在目录里也必须保留成选项**。静默把用户已配的值丢掉，比下拉框少一项严重得多
  //     （gitea-dispatch 同款处理）。
  //  3. **model 列表按 provider 懒加载**：只有当前选中的 provider 才发一次请求，
  //     切过的 provider 缓存复用；不一次拉全部。
  const CATALOG_PATH = MODEL_OPTIONS_PATH;
  const [catalogProviders, setCatalogProviders] = useState<readonly { id: string; name: string }[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, readonly { id: string; name: string }[]>>({});
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  /**
   * 档位为何退化（只在**已选定 provider+model** 时有意义）：
   * - `stale`：宿主答的是 providers 载荷 ⇒ 这台宿主还没有档位分支（需重启，#120）
   * - `empty`：宿主明确说该模型没有可选档位
   * 两者都保持文本框，但**把原因写在框里**，别让人以为坏了。
   */
  const [effortFallback, setEffortFallback] = useState<'stale' | 'empty' | null>(null);
  /** 档位目录：键 `${provider}|${model}`（换模型必须重解析，不跨模型复用）。 */
  const [catalogEfforts, setCatalogEfforts] = useState<Record<string, {
    efforts: readonly { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  }>>({});
  // 官方目录是**异步加载**的（服务构造时 load，完成后 store 才变）⇒ 订阅它，变化就重渲染。
  const [, bumpCatalog] = useState(0);
  useEffect(() => {
    if (typeof modelCatalogSubscribe !== 'function') return undefined;
    return modelCatalogSubscribe(() => bumpCatalog((n) => n + 1));
  }, [modelCatalogSubscribe]);
  const providerValue = fieldValue('provider');
  /**
   * 官方同源目录（`ctx.modelDirectories`）。三个目录查询**都优先用它**：
   * provider 列表、model 列表、每个模型的 efforts —— 一处数据源，三处复用。
   * 读不到（老内核 / 服务未挂）时全部退回自建 HTTP 目录。
   */
  const officialGroups: readonly OfficialModelGroup[] = (() => {
    try {
      const groups = typeof modelCatalog === 'function' ? modelCatalog() : null;
      return Array.isArray(groups) && groups.length > 0 ? groups : [];
    } catch { return []; }
  })();
  const officialProviders = officialGroups.map((g) => ({ id: g.id, name: g.name }));
  const officialModelsOf = (provider: string): readonly { id: string; name: string }[] =>
    (officialGroups.find((g) => g.id === provider)?.models ?? []).map((m) => ({ id: m.id, name: m.name }));
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (officialProviders.length > 0) { setCatalogProviders(officialProviders); return; }
      try {
        const res = await fetch(CATALOG_PATH, { method: 'GET' });
        if (!res.ok) { setCatalogUnavailable(true); return; }
        const body = await res.json() as { providers?: unknown };
        const rows = Array.isArray(body.providers) ? body.providers as { id: string; name: string }[] : [];
        if (cancelled) return;
        // 空目录按"不可用"处理：没有可选项的下拉框只会让人以为"这个部署没有模型"，
        // 而事实更可能是宿主侧没接上 —— 退化成文本框至少不撒谎。
        setCatalogProviders(rows);
        setCatalogUnavailable(rows.length === 0);
      } catch {
        if (!cancelled) setCatalogUnavailable(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const provider = (providerValue ?? '').trim();
    if (provider === '' || catalogUnavailable || catalogModels[provider] !== undefined) return;
    const fromOfficial = officialModelsOf(provider);
    if (fromOfficial.length > 0) { setCatalogModels(prev => ({ ...prev, [provider]: [...fromOfficial] })); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${CATALOG_PATH}?models=${encodeURIComponent(provider)}`, { method: 'GET' });
        if (!res.ok) return;
        const body = await res.json() as { models?: unknown };
        if (cancelled) return;
        setCatalogModels(prev => ({
          ...prev,
          [provider]: Array.isArray(body.models) ? body.models as { id: string; name: string }[] : [],
        }));
      } catch { /* 拉不到：该 provider 下只剩"当前值"可选项，不阻塞保存 */ }
    })();
    return () => { cancelled = true; };
  }, [providerValue, catalogUnavailable]);
  const modelValue = fieldValue('model');
  // 档位：provider 与 model 都选定才拉一次（懒加载）；拿不到 ⇒ 该字段退化成文本框。
  useEffect(() => {
    const provider = (providerValue ?? '').trim();
    const model = (modelValue ?? '').trim();
    if (provider === '' || model === '' || catalogUnavailable) return;
    const key = `${provider}|${model}`;
    if (catalogEfforts[key] !== undefined) return;
    const officialReasoning = officialGroups
      .find((g) => g.id === provider)?.models.find((m) => m.id === model)?.reasoning;
    if (officialReasoning !== undefined) {
      const list = Array.isArray(officialReasoning.efforts) ? officialReasoning.efforts : [];
      setEffortFallback(list.length === 0 ? 'empty' : null);
      if (list.length > 0) {
        setCatalogEfforts(prev => ({ ...prev, [key]: {
          efforts: list.map((e) => ({ id: e.id, name: e.name, description: e.description })),
          defaultEffort: typeof officialReasoning.defaultEffort === 'string' ? officialReasoning.defaultEffort : undefined,
        } }));
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${CATALOG_PATH}?efforts=${encodeURIComponent(key)}`, { method: 'GET' });
        if (!res.ok) return;
        const body = await res.json() as { efforts?: unknown; defaultEffort?: unknown; providers?: unknown };
        if (cancelled) return;
        // 旧宿主会把未知参数当没传 ⇒ 回 providers 载荷。这跟"模型没档位"是两件事，
        // 混在一起用户只能猜；分开记，下面写进 placeholder。
        if (Array.isArray(body.providers)) { setEffortFallback('stale'); return; }
        if (!Array.isArray(body.efforts) || body.efforts.length === 0) { setEffortFallback('empty'); return; }
        setEffortFallback(null);
        setCatalogEfforts(prev => ({
          ...prev,
          [key]: {
            efforts: Array.isArray(body.efforts)
              ? body.efforts as { id: string; name: string; description?: string }[]
              : [],
            defaultEffort: typeof body.defaultEffort === 'string' ? body.defaultEffort : undefined,
          },
        }));
      } catch { /* 拉不到：保持文本框 */ }
    })();
    return () => { cancelled = true; };
  }, [providerValue, modelValue, catalogUnavailable, catalogEfforts]);
  /** 目录型下拉框的选项：目录 + 当前值（不在目录里时补一条，绝不静默丢）。 */
  const catalogOptions = (
    which: 'providers' | 'models' | 'efforts',
    currentValue: string,
  ): { value: string; label: string }[] => {
    const provider = (providerValue ?? '').trim();
    const model = (modelValue ?? '').trim();
    const effortKey = `${provider}|${model}`;
    const rows: readonly { id: string; name: string; description?: string }[] = which === 'providers'
      ? catalogProviders
      : which === 'models'
        ? (catalogModels[provider] ?? [])
        : (catalogEfforts[effortKey]?.efforts ?? []);
    const current = currentValue;
    const defaultEffort = which === 'efforts' ? catalogEfforts[effortKey]?.defaultEffort : undefined;
    const out = rows.map((r) => {
      const base = r.name === r.id ? r.id : `${r.id} — ${r.name}`;
      const desc = typeof r.description === 'string' ? ` · ${r.description}` : '';
      const mark = defaultEffort === r.id ? t.effortDefaultMark : '';
      return { value: r.id, label: `${base}${desc}${mark}` };
    });;
    if (current !== '' && !out.some(o => o.value === current)) {
      out.unshift({ value: current, label: `${current}${t.effortNotInCatalog}` });
    }
    return out;
  };

  const save = async (): Promise<void> => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find(f => f.key === key)!;
        // 策略字段（非 volatile）host 端拒绝写入，跳过以免整批保存被它带崩。
        if (!def.writable) continue;
        let final: string | number | boolean = raw;
        if (def.kind === 'number') final = Number(raw);
        else if (def.kind === 'boolean') final = raw === true || raw === 'true';
        else if (def.kind === 'key') {
          const trimmed = String(raw).trim();
          // 空串丢弃只对**必填**的键位成立：host 端那些字段是 `z.string().min(1)`，
          // 写空串会在 `SettingsForms` 那一步整笔事务失败（不是静默无效，是保存不了）。
          // `dismissKey` / `forgetKey` 是允许留空的（空 = 不接管该动作，见 index.ts 的
          // 字段注释）；把它们一起丢掉的话，「关掉这个动作」就永远写不进去
          // ——用户只能看见值弹回默认。
          if (trimmed === '' && key !== 'dismissKey' && key !== 'forgetKey') continue;
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const renderField = (f: (typeof GHOST_FIELDS)[number]): ReactElement => {
    const invalid = fieldInvalid(f);
    // 策略字段（非 volatile）写不进 host：只读呈现，并说明来源，避免「改了没反应」。
    const editable = writable && f.writable;
    const fieldId = `sgc-field-${f.key}`;
    const helpId = `sgc-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const helpAria = t.helpFor(f.label[lang]);

    /** 布尔字段：官方 toggle 行（label 左 + switch 右，说明常驻在下）。
     * 语义与旧 select 完全一致：仅显式 'true' 视为开（未设置显示为关）。 */
    if (f.kind === 'boolean') {
      const checked = fieldValue(f.key) === 'true';
      return (
        <div key={f.key} className="sgc-field">
          <div className="sgc-toggle-row">
            <div className="sgc-label-group">
              <label className="sgc-toggle-label" htmlFor={fieldId}>{f.label[lang]}</label>
            </div>
            <button
              type="button"
              id={fieldId}
              role="switch"
              aria-checked={checked}
              aria-label={f.label[lang]}
              className="sgc-toggle-switch"
              disabled={!editable || busy}
              onClick={() => setField(f.key, !checked)}
            />
          </div>
          <p className={invalid ? 'sgc-invalid' : 'sgc-toggle-description'}>
            {invalid ? t.invalidNumber : f.hint[lang]}
          </p>
          {!f.writable && <p className="sgc-configOnly">{t.configOnly}</p>}
        </div>
      );
    }

    const inputClass = [
      invalid ? 'sgc-input sgc-inputInvalid' : 'sgc-input',
      f.writable ? '' : 'sgc-inputReadOnly',
    ].filter(Boolean).join(' ');
    const control = f.kind === 'key' ? (
      <KeyField
        id={fieldId}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        t={t}
        onChange={spec => setField(f.key, spec)}
        resetTo={KEY_BINDINGS[f.key]?.resetTo}
        validate={KEY_BINDINGS[f.key]?.safety === 'block'
          ? (spec => (isSafeActionKey(spec) ? undefined : t.keyUnsafe(f.label[lang])))
          : undefined}
        notes={keyNotes(f.key, fieldValue(f.key), lang, t, fieldValue,
          { word: fieldValue('wordAccept') !== 'false', regen: fieldValue('regenEnabled') !== 'false' })}
      />
    ) : f.kind === 'catalog' && !catalogUnavailable
      && (f.catalog !== 'efforts' || catalogOptions('efforts', fieldValue(f.key)).length > 0) ? (
      <select
        className={inputClass}
        id={fieldId}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      >
        <option value="">{(f.catalog ?? 'providers') === 'providers'
          ? t.catalogDeployDefault
          : (f.catalog ?? '') === 'efforts'
            ? t.catalogEffortOmit
            : ((providerValue ?? '').trim() === '' ? t.catalogPickProvider : t.catalogDeployDefault)}</option>
        {catalogOptions(f.catalog ?? 'providers', fieldValue(f.key)).map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    ) : f.kind === 'select' ? (
      <select
        className={inputClass}
        id={fieldId}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      >
        {(f.options ?? []).map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label[lang]}</option>
        ))}
      </select>
    ) : f.kind === 'textarea' ? (
      // 提示词这类多行文本：单行 `<input>` 装不下，也看不出自己写了多少行。
      // `rows` 固定 5 行 + `resize:vertical`（见 styles.ts 的 `.sgc-textarea`），
      // 关掉拼写检查——这是发给模型的指令，不是散文，波浪线只会误导。
      <textarea
        className={invalid ? `${inputClass} sgc-textarea sgc-inputInvalid` : `${inputClass} sgc-textarea`}
        id={fieldId}
        rows={5}
        spellCheck={false}
        placeholder={t.promptPlaceholder}
        aria-invalid={invalid || undefined}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      />
    ) : (
      <input
        className={inputClass}
        placeholder={(() => {
          if (f.catalog !== 'efforts') return '';
          const diag = typeof modelCatalogDiag === 'function' ? modelCatalogDiag() : null;
          const tail = diag === null || diag === undefined ? '' : t.catalogDiagTail(diag);
          if (effortFallback === 'stale') return `${t.effortCatalogStale}${tail}`;
          if (effortFallback === 'empty') return `${t.effortCatalogEmpty}${tail}`;
          return '';
        })()}
        id={fieldId}
        type="text"
        {...(f.kind === 'number' ? { inputMode: 'numeric' as const } : {})}
        {...(invalid ? { 'aria-invalid': true } : {})}
        value={fieldValue(f.key)}
        disabled={!editable || busy}
        onChange={e => setField(f.key, e.target.value)}
      />
    );
    return (
      <div key={f.key} className="sgc-field">
        <div className="sgc-fieldHead">
          <div className="sgc-label-group">
            <label className="sgc-label" htmlFor={fieldId}>{f.label[lang]}</label>
            <button
              type="button"
              className={helpOpenNow ? 'sgc-help-btn sgc-help-btnOpen' : 'sgc-help-btn'}
              aria-label={helpAria}
              aria-expanded={helpOpenNow}
              aria-controls={helpId}
              onClick={() => setHelpOpen(prev => ({ ...prev, [f.key]: !helpOpenNow }))}
            >
              <IconInfoOutlineRegular size={12} />
            </button>
          </div>
        </div>
        {control}
        {invalid && <p className="sgc-invalid" role="status">{invalidMessage(f)}</p>}
        {helpOpenNow && (
          <div id={helpId} role="region" aria-label={helpAria} className="sgc-help">
            <p>{f.hint[lang]}</p>
          </div>
        )}
        {!f.writable && <p className="sgc-configOnly">{t.configOnly}</p>}
      </div>
    );
  };

  /**
   * 按 `group` 把**连续**字段合进一个网格容器；未分组的字段照旧独自一行。
   *
   * 分组是"排版"决策，不是"语义"决策：字段的读写、校验、懒加载全都不受影响。
   * 规则：短控件（数字/下拉）成对；**带长 hint 的开关不分组**（两栏会把说明挤成窄条）。
   */
  const renderFieldRun = (fields: ReadonlyArray<(typeof GHOST_FIELDS)[number]>): ReactElement[] => {
    const out: ReactElement[] = [];
    let i = 0;
    while (i < fields.length) {
      const head = fields[i]!;
      if (head.group === undefined) { out.push(renderField(head)); i += 1; continue; }
      const run = [head];
      while (i + run.length < fields.length && fields[i + run.length]?.group === head.group) {
        run.push(fields[i + run.length]!);
      }
      out.push(
        <div key={`sgc-group-${head.group}-${head.key}`}
          className={head.group === 'route' ? 'sgc-routePair' : 'sgc-pair'}>
          {run.map((f) => renderField(f))}
        </div>,
      );
      i += run.length;
    }
    return out;
  };

  const llmFields = GHOST_FIELDS.filter(f => f.section === 'llm');
  const historyFields = GHOST_FIELDS.filter(f => f.section === 'history');
  const inlineFields = GHOST_FIELDS.filter(f => f.section === 'inline');
  const languageFields = GHOST_FIELDS.filter(f => f.section === 'language');
  /**
   * 「外观」分组：**所有纯视觉开关**。
   *
   * 之前这些字段分散在两处且标题对不上：两个光效的 `section` 值是 `'display'`，
   * 但渲染出来的标题叫「生成中的提示」；键位提示躲在「历史前缀补全」下。
   * 用户找不到（#157 实机反馈）⇒ 统一成 appearance，标题「外观」。
   */
  const appearanceFields = GHOST_FIELDS.filter(f => f.section === 'appearance');
  const keybindFields = GHOST_FIELDS.filter(f => f.section === 'keybinds');

  /** Section 布局：grid = 两列并排（适合短字段），stack = 单列堆叠。 */
  const SECTION_LAYOUT: Record<string, 'grid' | 'stack'> = {
    llm: 'stack',
    history: 'stack',
    inline: 'stack',
    language: 'grid',
    // 外观组的开关都带一句话说明 ⇒ 单列堆叠，别挤成两栏（挤了说明会折成三行）。
    appearance: 'stack',
    // 键位组每一项都要放得下一条录制按钮 + 一到两行警告 ⇒ 同样单列。
    keybinds: 'stack',
  };

  return (
    <div className="sgc-settings-form">
      {!writable && <p className="sgc-readOnly" role="status">{t.readOnly}</p>}
      {/* 仅详情页显示：控制设置对话框中是否出现本插件的设置页。
       *  localStorage 非响应式，切换后需刷新页面生效。 */}
      {surface === 'detail' && (
        <section className="sgc-section" aria-labelledby="sgc-section-display">
          <h3 className="sgc-section-heading" id="sgc-section-display">{t.sectionDisplay}</h3>
          <div className="sgc-section-fields">
            <div className="sgc-field">
              <div className="sgc-toggle-row">
                <div className="sgc-label-group">
                  <label className="sgc-toggle-label" htmlFor="sgc-show-settings">{t.showInSettings}</label>
                </div>
                <button
                  type="button"
                  id="sgc-show-settings"
                  role="switch"
                  aria-checked={showSettings}
                  aria-label={t.showInSettings}
                  className="sgc-toggle-switch"
                  onClick={toggleShowSettings}
                />
              </div>
              <p className="sgc-toggle-description">{t.showInSettingsHint}</p>
            </div>
          </div>
        </section>
      )}
      <section className="sgc-section" aria-labelledby="sgc-section-llm">
        <h3 className="sgc-section-heading" id="sgc-section-llm">{t.sectionLlm}</h3>
        <div className={SECTION_LAYOUT.llm === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(llmFields)}
        </div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-history">
        <h3 className="sgc-section-heading" id="sgc-section-history">{t.sectionHistory}</h3>
        <div className={SECTION_LAYOUT.history === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(historyFields)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-inline">
        <h3 className="sgc-section-heading" id="sgc-section-inline">{t.sectionInline}</h3>
        <div className={SECTION_LAYOUT.inline === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(inlineFields)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-keybinds">
        <h3 className="sgc-section-heading" id="sgc-section-keybinds">{t.sectionKeybinds}</h3>
        <p className="sgc-section-note">{t.keybindNote}</p>
        <p className="sgc-keyEffective"><span className="sgc-keyEffectiveLabel">{t.keyEffective}</span>{effectiveKeySummary()}
        </p>
        <div className={SECTION_LAYOUT.keybinds === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(keybindFields)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-appearance">
        <button
          type="button"
          id="sgc-section-appearance"
          className="sgc-sectionBtn"
          aria-expanded={appearanceOpen}
          aria-controls="sgc-appearance-body"
          onClick={() => setAppearanceOpen(o => !o)}
        >
          <span className="sgc-sectionBtnText">{t.sectionAppearance}</span>
          <IconChevronDownOutlineRegular size={14} className={appearanceOpen ? 'sgc-chevron sgc-chevronOpen' : 'sgc-chevron'} />
        </button>
        {appearanceOpen && (
          <div id="sgc-appearance-body">
            <div className={SECTION_LAYOUT.appearance === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(appearanceFields)}</div>
          </div>
        )}
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-language">
        <h3 className="sgc-section-heading" id="sgc-section-language">{t.sectionLanguage}</h3>
        <div className={SECTION_LAYOUT.language === 'grid' ? 'sgc-section-fields sgc-section-fieldsGrid' : 'sgc-section-fields'}>{renderFieldRun(languageFields)}</div>
      </section>
      <section className="sgc-section" aria-labelledby="sgc-section-hotness">
        <button
          type="button"
          id="sgc-section-hotness"
          className="sgc-sectionBtn"
          aria-expanded={hotOpen}
          aria-controls="sgc-hotness-body"
          onClick={() => setHotOpen(o => !o)}
        >
          <span className="sgc-sectionBtnText">{t.sectionHotness}</span>
          <IconChevronDownOutlineRegular size={14} className={hotOpen ? 'sgc-chevron sgc-chevronOpen' : 'sgc-chevron'} />
        </button>
        {hotOpen && (
          <div id="sgc-hotness-body">
            <HotnessSection
              scope={scope}
              pushRaw={value._push}
              hotRaw={value._hot}
              writable={writable}
              busy={busy}
              lang={lang}
              t={t}
              uiLocale={locale?.getSnapshot?.()?.active}
            />
          </div>
        )}
      </section>
      <div className="sgc-footer">
      {/* 底部操作栏：**照官方 SettingsForm 的排布** —— 按钮靠左、状态文字推到最右。
          官方只有一个「保存」（`onDiscard` 在卸载时自动触发，界面上没有"放弃修改"按钮）；
          我们保留放弃修改（本卡在详情页里，用户未必会"离开页面"），但排在保存之后、同一条左对齐队里。 */}
        <button className="sgc-save" disabled={!writable || busy || !isDirty || anyInvalid} onClick={() => void save()}>
          {busy ? t.saving : t.save}
        </button>
        {saved && <span className="sgc-status" role="status">{t.saved}</span>}
      </div>
    </div>
  );
}
