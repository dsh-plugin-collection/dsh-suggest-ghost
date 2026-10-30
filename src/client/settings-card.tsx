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
import { keyEventToSpec } from './keyspec.js';
import { useGhostT, type GhostLang, type LocaleFaceLike } from './useGhostT.js';
import { injectStyles } from './styles.js';
// 图标取自官方图标集：primitives 是 Web 壳的 platform module（冻结模块表常驻），
// esbuild 标 external 后由 __ModuleLoader__ 的 require 在运行时解析（与 react 同
// 机制，参考 dsh-group-status 的用法），无需 peerDependency 或 dsh.client.inject。
import { IconChevronDownOutlineRegular, IconInfoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'key' | 'select' | 'catalog';

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
  readonly section: 'llm' | 'history' | 'inline' | 'language';
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
    key: 'acceptKey',
    label: { zh: '采纳快捷键', en: 'Accept shortcut' },
    hint: {
      zh: '采纳建议的快捷键。默认 Tab，也可以设成字母、方向键或 F1–F12。',
      en: 'Key that accepts a suggestion. Tab by default; letters, arrow keys and F1–F12 also work.',
    },
    kind: 'key',
    section: 'llm',
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
      zh: '显示建议时，按 → 一次采纳一个词；Tab 始终采纳整条。',
      en: 'With a suggestion shown, → accepts one word at a time; Tab accepts the whole thing.',
    },
    kind: 'boolean',
    section: 'history',
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
  /** 快捷键控件 */
  keyCapturing: '按下组合键…（Esc 取消）',
  keyEmpty: '点击设置快捷键',
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
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `共 ${total} 条，显示热度最高的 ${shown} 条` : `共 ${total} 条`,
} as const;

/** en 字典：映射类型约束与 zh 键集完全一致（缺键/多键均为编译期错误）。 */
const enStrings: { [K in keyof typeof zhStrings]: (typeof zhStrings)[K] } = {
  readOnly: 'Not writable in this deployment (in-memory mode)',
  configOnly: 'Strategy field: not writable from the UI — edit cordis.patch.yml',
  sectionDisplay: 'Display',
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
  keyCapturing: 'Press a key combo… (Esc to cancel)',
  keyEmpty: 'Click to set a shortcut',
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
  hotMeta: (total: number, shown: number): string =>
    total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`,
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

/** 快捷键捕获控件：点击进入录制态，按下组合键即写入规范 spec（Esc 取消）。
 * 录制经 keyspec.keyEventToSpec，产出与幽灵匹配端（parseAcceptKey）同一张表。 */
function KeyField({ id, value, disabled, t, onChange }: {
  id: string;
  value: string;
  disabled: boolean;
  t: GhostStrings;
  onChange: (spec: string) => void;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event); // 纯修饰键返回 undefined，继续等待主键
      if (spec !== undefined) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = (): void => setCapturing(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
    };
  }, [capturing, onChange]);
  return (
    <button
      type="button"
      id={id}
      className={capturing ? 'sgc-key sgc-keyCapturing' : 'sgc-key'}
      disabled={disabled}
      onClick={() => setCapturing(c => !c)}
    >
      {capturing ? t.keyCapturing : value === '' ? t.keyEmpty : value}
    </button>
  );
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
function HotnessSection({ scope, pushRaw, writable, busy, lang, t, uiLocale }: {
  scope: PluginSettingsScope<Record<string, unknown>>;
  /** 当前 `_push` 字段原始值（由卡片从 scope 快照透传）。 */
  pushRaw: unknown;
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
  let hot: readonly HotPushEntry[] = [];
  let total = 0;
  if (typeof pushRaw === 'string' && pushRaw !== '' && pushRaw !== 'null') {
    try {
      const parsed = JSON.parse(pushRaw) as { hot?: HotPushEntry[] | null; total?: number };
      if (Array.isArray(parsed.hot)) hot = parsed.hot;
      if (typeof parsed.total === 'number') total = parsed.total;
    } catch { /* 残缺推送：展示空列表，等下一次推送自愈 */ }
  }
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;

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
    </>
  );
}

/** 设置卡片：读取/编辑/保存 suggest-ghost 命名空间。
 * 裸表单 + section 分组布局（llm / history 两个 section + 可折叠的热度管理），
 * 文案跟随宿主界面语言（locale 缺失回退中文），语言切换实时重渲染。 */
export function SuggestGhostCard({ scope, locale, surface, modelCatalog, modelCatalogSubscribe }: SuggestGhostCardProps): ReactElement | null {
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
  /** 数字字段的暂存值是否非法（空或非数字）；与官方 ValueField 校验一致。 */
  const fieldInvalid = (f: (typeof GHOST_FIELDS)[number]): boolean => {
    if (f.kind !== 'number' || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === '' || Number.isNaN(Number(raw));
  };
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
  const CATALOG_PATH = '/api/suggest-ghost/options';
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
      const mark = defaultEffort === r.id ? '（默认）' : '';
      return { value: r.id, label: `${base}${desc}${mark}` };
    });;
    if (current !== '' && !out.some(o => o.value === current)) {
      out.unshift({ value: current, label: `${current}（不在当前目录里）` });
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
          if (trimmed === '') continue; // host 端 zod 要求非空，空 spec 直接丢弃
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
          ? '（跟随部署默认）'
          : (f.catalog ?? '') === 'efforts'
            ? '（不传，沿用模型默认）'
            : ((providerValue ?? '').trim() === '' ? '（先选 provider）' : '（跟随部署默认）')}</option>
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
    ) : (
      <input
        className={inputClass}
        placeholder={f.catalog === 'efforts' && effortFallback === 'stale'
          ? '（宿主未提供档位目录：重启一次后本栏会变下拉）'
          : (f.catalog === 'efforts' && effortFallback === 'empty'
            ? '（该模型未声明推理档位，可手填）'
            : '')}
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
        {invalid && <p className="sgc-invalid" role="status">{t.invalidNumber}</p>}
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

  /** Section 布局：grid = 两列并排（适合短字段），stack = 单列堆叠。 */
  const SECTION_LAYOUT: Record<string, 'grid' | 'stack'> = {
    llm: 'stack',
    history: 'stack',
    inline: 'stack',
    language: 'grid',
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
