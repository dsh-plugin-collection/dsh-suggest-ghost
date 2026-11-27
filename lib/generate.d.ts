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
import type { PromptSource } from './prompt-override.js';
import type { Transcript } from './transcript.js';
export { sessionEvents } from './coldstart.js';
/** 本能力所属的辅助请求超时错误码。 */
export declare const SUGGEST_TIMEOUT_CODE = "SUGGEST_GHOST_TIMEOUT";
/**
 * 续写上下文的默认上限（字符），Gitea #190。
 *
 * 这个数**一直存在**，只是过去是 `Math.min(config.maxTranscriptChars, 2000)` 里的裸魔数：
 * 它绑住的 `maxTranscriptChars` 是设置页公开暴露的那一项，而卡片文案写的是
 * 「送进模型的对话记录最多多长（字符）」—— 对续写不成立。实测（#190 正文）：预算调到
 * 12000 / 50000 / 200000 三档，续写侧恒 1488 字符 / 3 条消息，纹丝不动。
 *
 * **为什么这道上限该留着**：续写跑在用户停手等待的路径上（`inlineDelayMs` 默认 100ms），
 * 上下文越长首块延迟越高，与 `COMPLETION_DEADLINE_MS`、`completionReasoningEffort` 同族。
 *
 * **为什么它和 `COMPLETION_DEADLINE_MS` 的处置相反**（那边注释明确"刻意不做成 volatile 配置项"）：
 * 超时值没有出现在任何用户文案里，硬编码不会说谎；而这一项**已经在对用户说谎**。
 * 所以这里改的是"把天花板变成看得见的默认值"，不是"取消保护"。默认 2000 ⇒ 与今天逐字节相同。
 *
 * 单点定义：schema 的 `.default()` 与两处 `readVolatile` 兜底都引这一个常量，
 * 不抄四份数字（抄来的默认值会分叉，判据见 `scripts/completion-context-smoke.mjs` 第 1 组）。
 */
export declare const DEFAULT_COMPLETION_CONTEXT_CHARS = 2000;
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
    /**
     * #108/#47：**显式开关**，默认 `false`。开启时才允许继承「本会话最近一次请求的路由」。
     *
     * 为什么默认必须关：不关就是这次的故障形状 —— 用户把主会话切到一条 401 的路由上，
     * 建议与停顿补全**全部跟着漂过去**，全线哑掉而界面上看不出来。会话路由属于主会话，
     * 不该是辅助调用的默认来源。
     */
    inheritSessionRoute?: boolean;
    acceptKey?: string;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled?: boolean;
    /** 流式投递（#108，默认关）：开=建议逐帧走 typert stream，关=与今天逐字一致。 */
    streamingDelivery?: boolean;
    /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
    inlineEnabled?: boolean;
    /** 续写可见字符上限。 */
    inlineMaxChars?: number;
    /**
     * 续写上下文的字符上限（Gitea #190）。生效值是
     * `min(maxTranscriptChars, completionContextChars)`，默认 2000 ⇒ 与今天的裸魔数逐字节相同。
     * 保留 `min` 而不是直接换成新键，是为了不悄悄改变"预算调到 2000 以下"那批既有配置的行为。
     */
    completionContextChars?: number;
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
    /**
     * 「下一条建议」的 system 提示词模板。空串 = 用内置模板（`systemPrompt()` 逐字不变）。
     *
     * 与 `suggestionReasoningEffort` 同一套「空串是合法值」的判据：这一项的**默认形态就是空**，
     * 用 `min(1)` 会把它变成必填，等于把插件逼成「不抄一份提示词就不能启动」。
     * 展开规则（`{{builtin}}` / `{{language}}` / `{{maxChars}}`）在 `prompt-override.ts`，
     * 与续写路径共用同一份实现。
     */
    suggestionPrompt?: string;
    /** 停顿续写的 system 提示词模板，语义同 `suggestionPrompt`（读的是内置 `inlinePrompt()`）。 */
    completionPrompt?: string;
    /**
     * 重出「换一条」开关（#127，默认开）。关掉之后 `regen` op 仍会被消费，
     * 但一律判 `regen-refused reason=disabled` 并留痕——不是静默 return。
     */
    regenEnabled?: boolean;
    /** 触发重出的快捷键 spec（#127，默认 `Alt+G`）。空/空白 = 回落默认值，见 `resolveConfig`。 */
    regenKey?: string;
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
    streamingDelivery?: Volatile<boolean> | boolean;
    /** 生成中的光标呼吸（C1，默认关）。 */
    caretGlowEnabled?: Volatile<boolean> | boolean;
    /** 生成中的输入框呼吸光（V4，默认开）。 */
    boxGlowEnabled?: Volatile<boolean> | boolean;
    /** #157：幽灵显示时浮一行键位提示（默认开）。纯客户端展示开关。 */
    showKeyHint?: Volatile<boolean> | boolean;
    /** 重出开关（#127）。volatile：设置页要能改，且改了不必重启。 */
    regenEnabled?: Volatile<boolean> | boolean;
    /** 重出快捷键 spec（#127）。volatile，判据与 `acceptKey` 同套（空串丢弃回落默认）。 */
    regenKey?: Volatile<string> | string;
    historyEnabled?: Volatile<boolean> | boolean;
    historyCrossSession?: Volatile<boolean> | boolean;
    historyMaxEntries?: Volatile<number> | number;
    historyMinChars?: Volatile<number> | number;
    wordAccept?: Volatile<boolean> | boolean;
    acceptKey?: Volatile<string> | string;
    /** 历史补全 / 停顿续写的采纳键 spec。纯客户端判据，host 只负责把它带到 describe() 里。 */
    localAcceptKey?: Volatile<string> | string;
    /** 逐词采纳键 spec（默认 `Right`）。 */
    wordAcceptKey?: Volatile<string> | string;
    /** 关闭幽灵键 spec；空串 = 不接管（唯一允许空的一项）。 */
    dismissKey?: Volatile<string> | string;
    /** 忽略键 spec（本单）；空串 = 不接管（与 `dismissKey` 同一条判据）。 */
    forgetKey?: Volatile<string> | string;
    languageMode?: Volatile<string> | string;
    uiLocaleWeight?: Volatile<number> | number;
    inlineEnabled?: Volatile<boolean> | boolean;
    inlineDelayMs?: Volatile<number> | number;
    inlineMinChars?: Volatile<number> | number;
    inlineMaxChars?: Volatile<number> | number;
    /** 续写上下文字符上限；默认 2000 = 今天那道裸魔数，见 `Config.completionContextChars`。 */
    completionContextChars?: Volatile<number> | number;
    /** 建议调用的推理档位（#35）；空串 = 继承，见 Config 的同名注释。 */
    suggestionReasoningEffort?: Volatile<string> | string;
    /** 续写调用的推理档位（#35）；空串 = 继承。 */
    completionReasoningEffort?: Volatile<string> | string;
    /** 建议的提示词模板；空串 = 内置模板，见 `Config.suggestionPrompt`。 */
    suggestionPrompt?: Volatile<string> | string;
    /** 续写的提示词模板；空串 = 内置模板。 */
    completionPrompt?: Volatile<string> | string;
}
/** 内核解析后的插件配置：策略字段是裸值，可调字段是引用。 */
export type ResolvedPluginConfig = Config & EditableConfig;
/** 拍平后的配置：策略字段 + 可调字段，全部是裸值。 */
export type FlatConfig = Config & {
    llmEnabled: boolean;
    streamingDelivery: boolean;
    /** 生成中的光标呼吸（C1，默认关）。 */
    caretGlowEnabled: boolean;
    /** 生成中的输入框呼吸光（V4，默认开）。 */
    boxGlowEnabled: boolean;
    /** #157：幽灵显示时浮一行键位提示（默认开）。 */
    showKeyHint: boolean;
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    wordAccept: boolean;
    acceptKey: string;
    localAcceptKey: string;
    wordAcceptKey: string;
    dismissKey: string;
    /** 本单：忽略键（空串 = 不接管）。 */
    forgetKey: string;
    languageMode: string;
    uiLocaleWeight: number;
    inlineEnabled: boolean;
    inlineDelayMs: number;
    inlineMinChars: number;
    inlineMaxChars: number;
    completionContextChars: number;
    contextSummaryEnabled: boolean;
    contextSummaryChars: number;
    suggestionReasoningEffort: string;
    completionReasoningEffort: string;
    suggestionPrompt: string;
    completionPrompt: string;
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
    /**
     * #165：本次生成里**输出预算是否因撞顶被放大过一次**。
     *
     * 与 `effortRejected` 同族但**不是**同一件事，也不并进 `attempts`：
     * `attempts` 记的是常规尝试序号，而撞顶放大是「同一次调用的降级重发」，
     * 它不占常规预算。两笔账分开记，才能区分「放大了一次仍失败」与
     * 「放大后常规重试也失败」。
     *
     * ⚠️ **不进 `formatStreamMetrics`**：那行是建议成功路径的留痕，Gitea #165
     * 的验收要求「成功路径的 trace 逐字不变」⇒ 新键只作为画像字段存在，
     * 由冒烟与后续诊断读它，不改既有行。
     */
    maxTokensEscalated: boolean;
    /**
     * #165：放大**发生过的次数**（0/1/2/3…；默认 512 最多 3 次到 ceiling）。
     *
     * 与 `maxTokensEscalated`（布尔，只回答"放大过没有"）并存：布尔量是既有的
     * 观测契约（冒烟与外部诊断读它，**不许改语义**），计数是新增的诊断面。
     * 「只放大一次」改成「连续放大到 ceiling」之后，光看布尔量已经分不出
     * 「一跳就够」和「连跳三次才够」——而这正是判断定价是否合理要看的东西。
     */
    maxTokensEscalationCount: number;
    /** #165：**本次尝试实际请求的**输出预算（用于把两笔账分开，同样不进留痕行）。 */
    maxTokens: number;
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
 * 解析这次辅助调用该用哪条模型路由（#47，照 `dsh-gitea-dispatch` 的语义重做）。
 *
 * ## 优先级（从高到低，只有第 3 条是"跟随"）
 *  1. **显式配置**：`provider` 与 `model` 都非空 ⇒ 用它。
 *  2. **半配置 = 抛错**（不静默降级）：只给一个说明是有人填了一半，猜哪一半都会错。
 *  3. `inheritSessionRoute: true` ⇒ **先**试会话路由（开关开着就得真的生效，否则它是死键），
 *     试不到再退部署默认。
 *  4. **部署默认**（`agentDefaultModel`）⇒ 默认关继承时，"跟随"指的就是它。
 *     ⚠️ 任务书原话是"没配 ⇒ 不传 provider/model"，**这条在本插件不可实现**：
 *     `GenerateOptions.provider` / `.model` 都是必填（`dsh-llm/lib/types/types.d.ts:491-492`），
 *     而 gitea-dispatch 之所以能"不传"，是因为它走**建会话**（`request.model = route` 可选），
 *     我们走的是直接 `llm.generate`。⇒ 同一个语义在这里必须翻译成"取部署默认"，
 *     而不是"少传两个字段"。
 *  4. **会话路由**：只有 `inheritSessionRoute: true` 才读 —— 这次的故障正是它默认为真。
 *  5. 全都没有 ⇒ 抛错，且**错误里写清两条出路**（配置 provider/model，或打开继承开关）。
 *
 * 空串一律算"未配置"：schema 用 `.default('')` 表达可选（volatile 表单不接受必填项）。
 *
 * 导出给单测（`scripts/model-route-smoke.mjs`）：四条判据都是纯函数断言，
 * 不该为了测它而起了真宿主。
 */
export declare function routeOf(session: Session, config: Config, deployment?: {
    readonly provider: string;
    readonly model: string;
} | undefined, 
/** `#141`：`deployment` 为 undefined 时，为什么拿不到（由 {@link probeDeploymentRoute} 给出）。 */
missReason?: DeploymentRouteMissReason): {
    readonly provider: string;
    readonly model: string;
};
/**
 * 读宿主 `agentDefaultModel` 拿「部署默认路由」（#47 判据 ② 的来源）。
 *
 * 写得这么防御是因为这条服务不是各代次都有（0.1.x 的组合里可能没有），而拿不到它就是
 * "没有部署默认" —— 不能因为探测本身抛错。形状按 `{ get(): {provider, model} }` 读，
 * 不符就当没有，后面的报错会告诉用户该配什么。
 */
/** `deploymentRoute` 取不到部署默认时的**原因分类**（#141：不许再吞成 `undefined`）。 */
export type DeploymentRouteMissReason = 
/** 宿主没提供 `agentDefaultModel` 服务（组合里没装）。 */
'service-absent'
/** 服务在，但两种已知读法都不存在（宿主换了 API 形状）。 */
 | 'method-absent'
/** 方法抛错（服务内部故障）。 */
 | 'call-threw'
/** 方法返回了，但形状不对或 provider/model 为空。 */
 | 'value-unusable';
export type DeploymentRouteProbe = {
    readonly route: {
        readonly provider: string;
        readonly model: string;
    };
    readonly reason: null;
    readonly via: 'currentSelection' | 'get';
} | {
    readonly route: undefined;
    readonly reason: DeploymentRouteMissReason;
    readonly via: null;
};
/**
 * 读宿主的**部署默认路由**（`agentDefaultModel`）。
 *
 * ## 为什么这条要留两种读法（#141 的现场）
 *
 * 宿主服务 `@deepseek-ai/dsh-agent-default-model` 的公开方法是 **`currentSelection()`**，
 * 而本函数此前只试了 `get()` —— 七代次（0.1.2-rc.1 → 0.2.2-alpha.2）`grep` 实测**都只有
 * `currentSelection`、都没有 `get`**。后果：凡是不显式配 provider/model 的部署（即
 * 「跟随部署默认」这条路）**从来没通**，一律落到 `routeOf` 最后那个
 * 「no model route available」的 throw；而显式配置那条绕开本分支，所以这个 bug 能活很久。
 *
 * 两种读法都留：`currentSelection` 是当代表，`get` 是历史/其它宿主形态的兜底。
 *
 * ## 为什么不再 `catch {}` 吞掉
 *
 * 旧实现把「服务不存在 / 方法不存在 / 抛错 / 值形状不对」四种原因统一压成 `undefined`，
 * 于是排障时**分不清「宿主没给」和「我们读错了」**——这次就是后者的现场。
 * 现在原因作为数据返回，由调用方写进失败报文的尾巴（`#97` 那族教训：静默降级最贵）。
 */
export declare function probeDeploymentRoute(ctx: {
    get?: (name: string) => unknown;
}): DeploymentRouteProbe;
/**
 * 部署默认路由的**读取入口**（只关心「有没有」的调用方用它）。
 * 需要原因时用 {@link probeDeploymentRoute}。
 */
export declare function deploymentRoute(ctx: {
    get?: (name: string) => unknown;
}): {
    readonly provider: string;
    readonly model: string;
} | undefined;
/**
 * #165：`finish.kind === 'max-tokens'` 的稳定错误码。
 *
 * 与 `UNSUPPORTED_EFFORT_CODE` 同一套纪律：**分派只认 code，不认报文**
 * （本仓口径见 {@link isUnsupportedEffort} 上方那段）。
 */
export declare const MAX_TOKENS_STOP_CODE = "SUGGEST_GHOST_MAX_TOKENS";
/**
 * 放大后的**硬上限**（任何一跳的落点都不超过它）。
 *
 * 为什么有上限：`maxOutputTokens` 是用户可配项，计费与它直接挂钩。没有上限时
 * 连续放大会让**自动触发的、用户看不见的**这条路无限烧 token。4096 是
 * 「一条 240 字的建议 + 充足的思考预算」的宽松上界（建议正文按 `maxSuggestionChars`
 * 默认 240 字符算不到 100 字 token）。
 *
 * 实测（盒子上 `deepseek-v4.1-flash` + `high`，见 `escalateMaxTokens` 上方那段）：
 * 512/1024/2048 全部 `choices: []`，**只有 4096 能出结果**。这个上限正好是它的落点。
 *
 * ⚠️ 上限只压**放大后的落点**，不压用户自己配的基数（配了 8_000 就跑 8_000）——
 * 本改动不改任何默认值语义（issue 方案 1「预算随能力」明确另议）。
 */
export declare const MAX_TOKENS_ESCALATION_CEILING = 4096;
/**
 * 这个错误是不是「输出预算撞顶」（#165）。
 *
 * 判据只认 {@link MAX_TOKENS_STOP_CODE}：撞顶是 `FinishReason.kind` 的**直接转写**，
 * 报文里没有任何需要解析的信息。**不要**在这里加报文匹配——那会把措辞当契约，
 * 改一句文案就让降级静默失效（失效形态是「用户又回到装了没反应」，没有断言会红）。
 */
export declare function isMaxTokensStop(error: unknown): boolean;
/**
 * 算出撞顶后要放大的预算；`undefined` = **不放**（这次就按失败处理）。
 *
 * ## 为什么不再「只放大一次」（#165 方案 (a)）
 *
 * 原实现把幂等性写在**布尔闸门**上：放大过一次就 `undefined`，于是默认
 * 512 只会走到 1024。实测（盒子真推理模型 `deepseek-v4.1-flash` +
 * `reasoningEffort: high`，直连 provider 只改 `max_tokens`）：
 *
 * ```
 * max_tokens= 512 → choices=0  completion=512   content 0 字
 * max_tokens=1024 → choices=0  completion=1024  content 0 字
 * max_tokens=2048 → choices=0  completion=2048  content 0 字
 * max_tokens=4096 → choices=1  completion=3615  content 3924 字
 * ```
 *
 * 即 **1024 这一跳救不回来**：推理把预算吃光时连一个 choice 都拼不出来。
 * 而 {@link MAX_TOKENS_ESCALATION_CEILING}（4096）恰好是它能出结果的档位，
 * 却因为「只放大一次」永远走不到。所以改成**几何递增直到 ceiling**。
 *
 * ## 停止条件（两条，缺一不可）
 *
 *  1. 当前预算已是（或超过）{@link MAX_TOKENS_ESCALATION_CEILING} ⇒ 放大也不涨；
 *  2. 放大后的值**必须严格大于**当前值 ⇒ 否则等于原地重放同一份预算。
 *
 * **为什么这已经足够防死循环**（不需要再加一个「最多放大 N 次」的常数闸门）：
 * 预算是整数，每次放大至少 +1（`Math.floor(current * 2) ≥ current + 1` 对任意
 * 正整数成立），且被 ceiling 封顶。所以从任意起点出发，放大步数是
 * `log2(ceiling / current)` 的整数上界 —— 从默认 512 起**恰好 3 步**
 * （512 → 1024 → 2048 → 4096）。这条上界由结构给出，不是靠次数算术碰巧对上。
 *
 * 纯函数（可离线驱动，见 `scripts/max-tokens-smoke.mjs`）。
 */
export declare function escalateMaxTokens(current: number): number | undefined;
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
export declare function generateSuggestion(ctx: Context, config: Config, session: Session, turn: number, signal: AbortSignal, uiLocale?: string, languageMode?: string, uiLocaleWeight?: number, lastLanguage?: string, 
/**
 * 每个正文增量回调一次，参数是**本次尝试内已收到的原始文本**（未净化）。
 *
 * 只有流式投递开启且该会话有活订阅时才传（`GhostStreamHub.beginTurn` 返回 false 时
 * 调用方**不传**）⇒ 开关关着时这条路径一个字节都不多走。净化由调用方做
 * （`prefixSafeClean`）："哪一帧可以显示"是投递侧的判断，不是模型的。
 */
onTextDelta?: (rawCumulative: string) => void, 
/**
 * 追加到 system prompt **尾部**的负向约束块（#127 重出：把本回合已产出/已被拒的
 * 至多 3 条正文以「MUST NOT repeat any of these」压回去）。
 *
 * ⚠️ **当前这个形参没有被函数体引用**（2026-11-26 复核：`grep -n avoidBlock` 在本文件
 * 只命中形参声明与这段注释；`awk` 取函数体区间再 `grep -c` = 0）。
 * `src/index.ts` 那边确实算好了并从调用点传进来，所以现象是「重出的避开块从未发给模型」
 * —— 一条已登记的既有缺陷，本注释只负责把现状说准，**不在这里修**。
 *
 * 原注释曾写「只在调用处拼接，`systemPrompt()` 本体一字不改」，那次拼接从未写出来；
 * 它还引用 `scripts/regen-smoke.mjs`，**该脚本不存在**（现存的是 `regen-policy` /
 * `regen-pending` / `regen-key` 三条）。这条静默缺陷当时没有任何断言挡着。
 *
 * 现在钉住它的是 `scripts/prompt-override-smoke.mjs` 第 10 组：它断言**今天仍然不拼接**，
 * 并把"接上拼接时这条必红"写进判据 —— 红的时候要求连同 Gitea #182 与设计文档 §6
 * 一起更新，而不是删断言。`systemPrompt()` 本体一字不改这条纪律继续有效
 * （README 的 42 次实测口径建立在它之上）。
 *
 * 块的构造在 `src/regen.ts` 的 `buildAvoidBlock`（判同口径同源，去重与截尾也在那里）。
 */
avoidBlock?: string): Promise<{
    suggestion: SuggestGhostSuggested | undefined;
    language: string;
    metrics: StreamMetrics;
    /**
     * 本轮**实际发给模型的**是哪份提示词（`custom` = 用户填的模板，`builtin` = 内置）。
     *
     * 为什么从生成侧返回而不是让调用方读配置：留痕要回答的是「这一轮用的哪条」，
     * 而调用方手上的快照与生成时用的那份可能不同（#137 的 `uiLocale` 同一课——
     * 收口时再读进程级值，可能已被下一次写入推进）。判据单点在 `prompt-override.ts`。
     */
    promptSource: PromptSource;
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
    /** 本轮发给模型的提示词是哪份，语义同 `generateSuggestion` 的同名返回字段。 */
    promptSource: PromptSource;
}>;
export { PROJECTION_KEY };
