/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Volatile } from '@deepseek-ai/cosmokit';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostSuggested } from './domain.js';
import type { Transcript } from './transcript.js';
export { sessionEvents } from './coldstart.js';
/** 本能力所属的辅助请求超时错误码。 */
export declare const SUGGEST_TIMEOUT_CODE = "SUGGEST_GHOST_TIMEOUT";
/** host 插件配置（未校验版本）。 */
export interface Config {
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    maxRecentTurns?: number;
    maxTranscriptChars: number;
    maxSuggestionChars: number;
    provider?: string;
    model?: string;
    acceptKey?: string;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled?: boolean;
    /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
    inlineEnabled?: boolean;
    /** 续写可见字符上限。 */
    inlineMaxChars?: number;
    /** 是否启用长会话上下文摘要（默认开）。 */
    contextSummaryEnabled?: boolean;
    /** 上下文摘要最大字符数。 */
    contextSummaryChars?: number;
    /**
     * 「下一条建议」那次辅助调用的推理档位（#35）。空串 = **不传**
     * `GenerateOptions.reasoningEffort`，保持继承语义（判据与 provider/model 同套，
     * 见 `effortOf`）；非空 = 按适配器注册的档位 id 原样透传。
     */
    suggestionReasoningEffort?: string;
    /** 停顿续写那次辅助调用的推理档位（#35），语义同 `suggestionReasoningEffort`。 */
    completionReasoningEffort?: string;
}
/**
 * 0.1.7 的用户可调项。
 *
 * 取 `Volatile<T> | T` 联合类型而非只取 `Volatile<T>`：0.1.7 把这些字段解析成
 * cosmokit 引用（读值走 `.get()`），而 0.1.5/0.1.2 时代它们是裸值。`readVolatile`
 * 同时认得两种形态，故类型层也必须同时容纳。
 */
export interface EditableConfig {
    llmEnabled?: Volatile<boolean> | boolean;
    historyEnabled?: Volatile<boolean> | boolean;
    historyCrossSession?: Volatile<boolean> | boolean;
    historyMaxEntries?: Volatile<number> | number;
    historyMinChars?: Volatile<number> | number;
    wordAccept?: Volatile<boolean> | boolean;
    acceptKey?: Volatile<string> | string;
    languageMode?: Volatile<string> | string;
    uiLocaleWeight?: Volatile<number> | number;
    inlineEnabled?: Volatile<boolean> | boolean;
    inlineDelayMs?: Volatile<number> | number;
    inlineMinChars?: Volatile<number> | number;
    inlineMaxChars?: Volatile<number> | number;
    /** 建议调用的推理档位（#35）；空串 = 继承，见 Config 的同名注释。 */
    suggestionReasoningEffort?: Volatile<string> | string;
    /** 续写调用的推理档位（#35）；空串 = 继承。 */
    completionReasoningEffort?: Volatile<string> | string;
}
/** 内核解析后的插件配置：策略字段是裸值，可调字段是引用。 */
export type ResolvedPluginConfig = Config & EditableConfig;
/** 拍平后的配置：策略字段 + 可调字段，全部是裸值。 */
export type FlatConfig = Config & {
    llmEnabled: boolean;
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    wordAccept: boolean;
    acceptKey: string;
    languageMode: string;
    uiLocaleWeight: number;
    inlineEnabled: boolean;
    inlineDelayMs: number;
    inlineMinChars: number;
    inlineMaxChars: number;
    contextSummaryEnabled: boolean;
    contextSummaryChars: number;
    suggestionReasoningEffort: string;
    completionReasoningEffort: string;
};
/**
 * 把插件配置拍平成「策略 + 可调」的裸值视图。0.1.7 的可调项是引用，其余代码
 * （effective()、client 渲染、热度快照上限）都按裸值读，不必知道代次差异。
 */
export declare function flattenConfig(config: ResolvedPluginConfig): FlatConfig;
/** 校验并返回不可变配置。 */
export declare function resolveConfig(config: Config): Config;
/**
 * 配置的档位值 → 该不该往 `GenerateOptions` 上写 `reasoningEffort`。
 *
 * 判据与 {@link routeOf} 的 provider/model 完全同套：**空串（含纯空白）= 不传**，
 * 让内核沿用路由自己的默认档位；非空才品牌化成 `ReasoningEffortId` 传下去。
 * 之所以不能「传了再说」：dsh-llm 的 `resolveCallWithInfo` 对**不支持**的显式档位
 * 直接抛 `UNSUPPORTED_REASONING_EFFORT`（`@deepseek-ai/dsh-llm/lib/index.js:2178`），
 * 一次都不重试就整轮失败——把 `low` 硬塞给一个不支持推理档位的模型，代价是
 * 「这条会话彻底没有建议」，而不是「档位被忽略」。
 * @returns 品牌化后的档位；空配置返回 undefined（= 调用方不写这个键）。
 */
export declare function effortOf(raw: string | undefined): ReasoningEffortId | undefined;
/**
 * 请求档位的留痕写法。参数是**当前这次尝试实际要发的档位**（不是配置原文）：
 * 档位被拒后退一档重发，那一次尝试的请求里根本没有这个键，留痕就该显示 `inherit`。
 */
export declare function effortLabel(effort: ReasoningEffortId | undefined): string;
/**
 * 这个错误是不是「档位不受该模型支持」。
 *
 * 判据要**同时**命中「档位」与「不支持」两个要素，两个方向都会出错：
 *  - 只匹配「不支持」→ 把 `provider/model must be supplied together` 那种真配置错
 *    误判成档位问题，悄悄退一档、把该暴露的问题盖掉；
 *  - 只匹配「档位」→ 把「档位格式非法」之类的真错误也吞成降级。
 * 所以先认权威的错误码（dsh-llm 用 `HarnessError.code` 分派，见
 * `lib/types/error.d.ts` 里 `errorChain` 的注释：**never parse the result; route on code**），
 * 没有 code 时再要求报文里两个要素同时出现——档位校验有两条来路：`prepareCall` 直接抛，
 * 或者被 `finishError` 从终止帧的 `failure.code/message` 还原成 Error。
 */
export declare function isUnsupportedEffort(error: unknown): boolean;
/**
 * 一次流式读取的增量画像（#39 的观测面）。
 *
 * 存在的理由：过去留痕只有一个端到端 `in Nms`，于是「慢在首块」与「慢在收尾」、
 * 「模型根本没输出」与「输出了但被净化链丢掉」在观测上同形。档位（#35）一上来
 * 就要靠这几个数判断有没有用，所以先把它们取回来。
 *
 * TS 字段用 camelCase（本仓惯例），**留痕里的键用 lead 指定的 snake_case**
 * （`first_text_delta_ms` / `effort_requested` / `effort_rejected`），映射只发生在
 * `formatStreamMetrics` 一处；两边名字不同是有意的，改留痕键名要动 sandbox.greps。
 */
export interface StreamMetrics {
    /**
     * 首个**正文**增量（`text-delta`）距本次尝试起点的毫秒数；-1 = 一个字都没等到。
     * 这是「用户还要干等多久才看见东西」。
     */
    firstTextDeltaMs: number;
    /**
     * 首个**推理**增量（`reasoning-delta`）距本次尝试起点的毫秒数；-1 = 没有推理增量
     * （非推理模型本来就是 -1）。
     *
     * 必须与 `firstTextDeltaMs` **分开报**：推理模型先出 reasoning、很久之后才出正文。
     * 沙箱实测 qfmodel 缺省档 first-reasoning 806ms 而 first-text 1410ms，efficient
     * 更夸张（首块 6147ms）。合成一个「首块」就会把「用户在干等」记成正常。
     */
    firstReasoningDeltaMs: number;
    /** 正文增量（`text-delta`）条数。 */
    contentDeltas: number;
    /** 正文增量累计字符数。 */
    contentChars: number;
    /** 推理增量（`reasoning-delta`）条数；非推理模型恒 0。 */
    reasoningDeltas: number;
    /** 推理增量累计字符数。 */
    reasoningChars: number;
    /** 终止原因（`BlockAssembler.finish.kind`）；`none` = 没收到 finish 帧。 */
    finishKind: string;
    /**
     * **外层**尝试序号（1 起）。
     * 路由内部的自我重放不算在这里（opencode2dsh 在「只出 reasoning 且 max-tokens
     * 收尾」时会改用 off 重打一遍并合并 usage，见 @opencode2dsh/dsh-plugin/lib/index.js:1437-1446），
     * 插件观测不到它，报出来就是假数。
     */
    attempts: number;
    /**
     * 插件**请求**的档位；`inherit` = 没配置或配置为空串（不传）。
     * 叫「请求的」而不是「生效的」：终值由宿主 `resolveCallWithInfo` 决定，插件侧不可观测。
     */
    effortRequested: string;
    /** 本次生成里档位是否被适配器拒过（拒过 = 退一档、不带档位重发了一次）。 */
    effortRejected: boolean;
    /** 本次调用的收口分类，用于区分「空回复」与「被过滤」。 */
    outcome: StreamOutcome;
}
/**
 * 收口分类：
 *  - `ok` 有可用产出；
 *  - `empty` 模型**一个字都没吐**（正文块拼起来 trim 后为空）；
 *  - `filtered` 模型吐了东西，但净化/过滤链把它丢掉了。
 * 这一分别是 #39 要的第 3 条：`empty` 指向提示词/档位/路由，`filtered` 指向净化链。
 */
export type StreamOutcome = 'ok' | 'empty' | 'filtered';
/** 建一份增量画像（每次尝试一份；重试不复用，见各生成函数的循环体）。 */
export declare function createStreamMetrics(effortRequested: string): StreamMetrics;
/**
 * 把一个流式增量块记进画像。**纯函数**（除入参外不碰任何东西），这样
 * `scripts/stream-metrics-smoke.mjs` 能离线逐块喂假数据断言计数，
 * 不需要真 LLM——历史上这几条判据散在 async 闭包里，离线一条都测不到。
 * @param metrics - 目标画像（就地累加）。
 * @param chunk - dsh-llm 的原始流块。
 * @param startedAtMs - 本次尝试的起点（`Date.now()` 量纲）。
 * @param nowMs - 当前时刻（由调用方给，测试里是假时钟）。
 */
export declare function observeChunk(metrics: StreamMetrics, chunk: StreamChunk, startedAtMs: number, nowMs: number): void;
/**
 * 把画像渲染成留痕后缀（`k=v` 串）。
 *
 * 键名是 lead 在 #39 上指定的 snake_case（`first_text_delta_ms` /
 * `effort_requested` / `effort_rejected`），与 TS 字段名不同——映射只在这里发生一次。
 * `effort_rejected` **恒打印** 0/1（不是「有才打」），因为它的用途是「这类失败有多少」
 * 的计数，缺省写法会让 grep 出来的样本自选择成失败样本。
 *
 * 只打计数与耗时，**不打任何正文**：续写正文是模型对用户草稿的模仿，抄进 tee 日志
 * 等于把用户输入的第二份副本落到盘上（这条约束见 `src/index.ts` 的续写留痕）。
 */
export declare function formatStreamMetrics(m: StreamMetrics): string;
/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export declare function systemPrompt(maxSuggestionChars: number, language: string): string;
/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 3），脱敏，依次按字符预算
 * （`maxTranscriptChars`）与 UTF-8 字节预算（`maxInputBytes`）截尾。
 *
 * 长会话上下文摘要（`contextSummaryEnabled` 开启时）：被裁剪掉的旧消息会
 * 被提取摘要（取每条用户消息的第一句），作为特殊对 prepend 到转录头部，
 * 让模型看到早期已确认的目标、偏好、约束，避免长会话建议质量随长度下降。
 */
export declare function buildTranscript(session: Session, maxRecentTurns: number, maxTranscriptChars: number, maxInputBytes: number, contextSummaryEnabled?: boolean, contextSummaryChars?: number): Transcript | undefined;
/**
 * 为一个已完成回合生成建议。模型产出空或不合格回复 = 无建议（静默返回
 * undefined），真实失败抛错。
 *
 * 辅助调用带**有界重试**（默认共 3 次尝试，1.2s/2.4s 退避）：主循环对
 * EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 类瞬时错误有 5 次重试，
 * 而建议调用是单发——不稳定窗口里会整轮静默失败（实测发生过）。被外部
 * 中止（新回合取代/卸载）时不重试。
 *
 * 返回的 `metrics` 只用于留痕（#39），不参与任何判据：调用方拿到它就打一行
 * `suggestion generated/dropped …`。
 */
export declare function generateSuggestion(ctx: Context, config: Config, session: Session, turn: number, signal: AbortSignal, uiLocale?: string, languageMode?: string, uiLocaleWeight?: number, lastLanguage?: string): Promise<{
    suggestion: SuggestGhostSuggested | undefined;
    language: string;
    metrics: StreamMetrics;
}>;
/**
 * 为草稿停顿生成行内续写。模型产出空或不合格回复 = 无续写（静默返回 undefined），
 * 真实失败抛错。
 *
 * 与 `generateSuggestion` 的关键差异：
 * 1. 输入是草稿文本（非会话转录），可选附带少量上下文（最近 2 轮）
 * 2. 重试更少（maxAttempts 2，退避 800ms）——续写是低延迟交互，不值得长时间重试
 * 3. 过滤更轻（`shouldFilterCompletion` 不过滤问句/助手口吻——续写语境下合理）
 * 4. 剥除草稿回声（模型有时会复述草稿再续写）
 */
export declare function generateCompletion(ctx: Context, config: Config, session: Session, draft: string, signal: AbortSignal, uiLocale?: string, languageMode?: string, uiLocaleWeight?: number, lastLanguage?: string): Promise<{
    text: string | undefined;
    language: string;
    metrics: StreamMetrics;
}>;
export { PROJECTION_KEY };
