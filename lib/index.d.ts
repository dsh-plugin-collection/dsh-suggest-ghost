/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议，经
 * `suggest-ghost/state` 会话事件 + `suggestGhost` 投影实时推给 client。
 * 零核心改动，纯插件挂载。
 *
 * 0.1.7 适配：内核移除了 `settings.yaml` 体系，本插件的
 *  - **用户可调项** → `Config` 里的 `.volatile()` 字段（内核把插件 Config 投影成
 *    WebUI 表单，ns = Loader 条目 id = `suggest-ghost`）；
 *  - **热数据（建议/热度/历史环）** → ignorable 会话事件 + 投影 fold
 *    （取代已不存在的 settings `_push`）。
 *
 * 冷启动语义见 ./coldstart.ts：历史环按需从会话日志物化、建议按「回合是否仍是
 * 最后一个已完成回合」语义校验，因此重启后打开页面即可用，无需等新回合。
 * @module dsh-suggest-ghost
 */
import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cosmokit';
import type { Context } from '@deepseek-ai/cordis';
import type { Config as GenerateConfig } from './generate.js';
/**
 * `Config` 解析后的取值形状。
 *
 * 显式标注的原因：两个字段组用 spread 组合时，TS 推断出的类型引用了
 * `.pnpm/...` 下的具体路径，`.d.ts` 产物无法命名（TS2742 要求可命名的标注）。
 * 标注成这个接口既让产物可命名，也让 Config 的输入/输出类型对上层可见。
 *
 * **可调项的类型是 `Volatile<T>` 而不是裸值。** `.volatile()` 把 schema 的
 * Mode 提升为 `'volatile'`，`SchemaOutput` 随之把输出映射成 `Volatile<T | undefined>`
 * （`@deepseek-ai/schemastery` 的 `SchemaOutput` / `SetRequired`）。所以这里必须
 * 逐字段写 `Volatile<...>`——否则 `z<PluginConfigValues>` 的标注与实际推断不符，
 * 报 `Type 'Volatile<boolean>' is not assignable to type 'boolean'`。
 * 读值一律走 `flattenConfig()` 的 `readVolatile()`，拿到的才是裸值。
 */
export interface PluginConfigValues {
    maxInputBytes: Volatile<number>;
    maxOutputTokens: Volatile<number>;
    timeoutMs: Volatile<number>;
    maxRecentTurns: Volatile<number>;
    maxTranscriptChars: Volatile<number>;
    contextSummaryEnabled: Volatile<boolean>;
    contextSummaryChars: Volatile<number>;
    maxSuggestionChars: Volatile<number>;
    provider: Volatile<string>;
    model: Volatile<string>;
    llmEnabled: Volatile<boolean>;
    suggestionReasoningEffort: Volatile<string>;
    historyEnabled: Volatile<boolean>;
    historyCrossSession: Volatile<boolean>;
    historyMaxEntries: Volatile<number>;
    historyMinChars: Volatile<number>;
    inlineEnabled: Volatile<boolean>;
    inlineDelayMs: Volatile<number>;
    inlineMinChars: Volatile<number>;
    inlineMaxChars: Volatile<number>;
    completionReasoningEffort: Volatile<string>;
    wordAccept: Volatile<boolean>;
    acceptKey: Volatile<string>;
    languageMode: Volatile<string>;
    uiLocaleWeight: Volatile<number>;
    _ops: Volatile<string>;
    _push: Volatile<string>;
}
/**
 * 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。
 *
 * 标注必须写成 `z<输入, 输出>` 两参形式，不能用 `z<PluginConfigValues>` 单参：
 * `.volatile()` 字段的**输入**是裸值、**输出**是 `Volatile<T>`（见 `ObjectS` /
 * `ObjectT`），单参标注会让两侧都被当成 `Volatile<T>`，`default()` 的入参随之
 * 对不上而报 TS2322。输入形状用 `Schemastery.TypeS<typeof ConfigSchema>` 取回。
 */
declare const ConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    /** 最终框架化用户提示的最大 UTF-8 字节数。 */
    maxInputBytes: z<number, number, "volatile-defined">;
    /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
    maxOutputTokens: z<number, number, "volatile-defined">;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number, "volatile-defined">;
    /** 转录尾部保留的最近完成回合数（默认 3：保留近期上下文）。 */
    maxRecentTurns: z<number, number, "volatile-defined">;
    /** 转录字符预算。 */
    maxTranscriptChars: z<number, number, "volatile-defined">;
    /** 是否启用长会话上下文摘要（默认开）：旧消息被裁剪时提取摘要保留关键信息。 */
    contextSummaryEnabled: z<boolean, boolean, "volatile-defined">;
    /** 上下文摘要最大字符数（仅 contextSummaryEnabled 时生效）。 */
    contextSummaryChars: z<number, number, "volatile-defined">;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number, "volatile-defined">;
    /**
     * 显式路由对；`z.string().default('')` 而非 `min(1)`：留空表示「继承主请求
     * 最近记录的路由」。若保持必填，volatile 表单会把插件逼成「不填就不能启动」，
     * 而继承语义恰恰要求它是可选的。
     */
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled: z<boolean, boolean, "volatile-defined">;
    /**
     * 「下一条建议」这次辅助调用的推理档位（#35）。
     *
     * **默认空串 = 不传 = 沿用路由自己的默认档位**，不是 `low`。理由实测过：
     * 档位是**按 provider 按 model** 声明的，本机 qoder-route 的 18 个模型里有 9 个
     * 根本没有 `reasoningEfforts` 段（efficient / fast / lite …）——给它们带任何档位，
     * 适配器在发请求之前就返回 UNSUPPORTED_REASONING_EFFORT（0-20ms 失败），
     * 一个非空默认值等于把整条建议路径配成必然失败。
     * 判据与 provider/model 同套（见 generate.ts 的 `effortOf`），所以这里同样不能用
     * `min(1)`；档位 id 由适配器定义，本插件不校验，被拒时生成侧**退一档重发一次**
     * 并在留痕里打 `effort_rejected=1`。
     * 也别拿它当「关思考」的开关：qfmodel 连 `off` 都拒（profile 只声明
     * low/medium/xhigh），只有显式声明了 off 的路由才接受。
     */
    suggestionReasoningEffort: z<string, string, "volatile-defined">;
    /** 是否启用历史前缀补全。 */
    historyEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否跨会话搜索历史（false = 仅当前会话）。 */
    historyCrossSession: z<boolean, boolean, "volatile-defined">;
    /** 历史补全最多参考的历史条目数（0 = 不限）。 */
    historyMaxEntries: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发历史补全。 */
    historyMinChars: z<number, number, "volatile-defined">;
    /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
    inlineEnabled: z<boolean, boolean, "volatile-defined">;
    /** 停顿多久后触发续写（毫秒）。 */
    inlineDelayMs: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发续写。 */
    inlineMinChars: z<number, number, "volatile-defined">;
    /** 续写可见字符上限。 */
    inlineMaxChars: z<number, number, "volatile-defined">;
    /**
     * 停顿续写这次辅助调用的推理档位（#35）。语义与 `suggestionReasoningEffort`
     * 完全一致（**默认空串 = 不传 = 继承**，被拒则退一档重发一次），单列一项是因为
     * 续写与建议的延迟预算根本不同：续写在用户停手等待的路径上，建议藏在回合边界
     * 之后没人等。想压续写的首块延迟，先在这里填一个**该模型声明过**的档位。
     */
    completionReasoningEffort: z<string, string, "volatile-defined">;
    /** 幽灵显示时允许 → 逐词采纳。 */
    wordAccept: z<boolean, boolean, "volatile-defined">;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string, "volatile-defined">;
    /**
     * 建议语言模式：'auto' = 自动推断（结合 UI 语言 + 用户消息文字分布）；
     * 'zh' / 'zh-TW' / 'en' / 'ja' / 'ko' / 'ru' / 'fr' / 'de' / 'es' = 强制指定语言。
     * 未知代码在 host 端回退 English（见 generate.ts 的 LANGUAGE_NAMES）。
     */
    languageMode: z<string, string, "volatile-defined">;
    /**
     * UI 语言先验权重（仅 auto 模式生效）：值越大越倾向 UI 语言。
     * 默认 100 ≈ 2-3 条中等长度消息的置信度。
     */
    uiLocaleWeight: z<number, number, "volatile-defined">;
    /**
     * client → host 的热度管理操作队列（JSON 字符串）。
     *
     * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
     * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
     * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
     * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
     */
    _ops: z<string, string, "volatile-defined">;
    /**
     * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
     * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
     * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
     */
    _push: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** 最终框架化用户提示的最大 UTF-8 字节数。 */
    maxInputBytes: z<number, number, "volatile-defined">;
    /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
    maxOutputTokens: z<number, number, "volatile-defined">;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number, "volatile-defined">;
    /** 转录尾部保留的最近完成回合数（默认 3：保留近期上下文）。 */
    maxRecentTurns: z<number, number, "volatile-defined">;
    /** 转录字符预算。 */
    maxTranscriptChars: z<number, number, "volatile-defined">;
    /** 是否启用长会话上下文摘要（默认开）：旧消息被裁剪时提取摘要保留关键信息。 */
    contextSummaryEnabled: z<boolean, boolean, "volatile-defined">;
    /** 上下文摘要最大字符数（仅 contextSummaryEnabled 时生效）。 */
    contextSummaryChars: z<number, number, "volatile-defined">;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number, "volatile-defined">;
    /**
     * 显式路由对；`z.string().default('')` 而非 `min(1)`：留空表示「继承主请求
     * 最近记录的路由」。若保持必填，volatile 表单会把插件逼成「不填就不能启动」，
     * 而继承语义恰恰要求它是可选的。
     */
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled: z<boolean, boolean, "volatile-defined">;
    /**
     * 「下一条建议」这次辅助调用的推理档位（#35）。
     *
     * **默认空串 = 不传 = 沿用路由自己的默认档位**，不是 `low`。理由实测过：
     * 档位是**按 provider 按 model** 声明的，本机 qoder-route 的 18 个模型里有 9 个
     * 根本没有 `reasoningEfforts` 段（efficient / fast / lite …）——给它们带任何档位，
     * 适配器在发请求之前就返回 UNSUPPORTED_REASONING_EFFORT（0-20ms 失败），
     * 一个非空默认值等于把整条建议路径配成必然失败。
     * 判据与 provider/model 同套（见 generate.ts 的 `effortOf`），所以这里同样不能用
     * `min(1)`；档位 id 由适配器定义，本插件不校验，被拒时生成侧**退一档重发一次**
     * 并在留痕里打 `effort_rejected=1`。
     * 也别拿它当「关思考」的开关：qfmodel 连 `off` 都拒（profile 只声明
     * low/medium/xhigh），只有显式声明了 off 的路由才接受。
     */
    suggestionReasoningEffort: z<string, string, "volatile-defined">;
    /** 是否启用历史前缀补全。 */
    historyEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否跨会话搜索历史（false = 仅当前会话）。 */
    historyCrossSession: z<boolean, boolean, "volatile-defined">;
    /** 历史补全最多参考的历史条目数（0 = 不限）。 */
    historyMaxEntries: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发历史补全。 */
    historyMinChars: z<number, number, "volatile-defined">;
    /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
    inlineEnabled: z<boolean, boolean, "volatile-defined">;
    /** 停顿多久后触发续写（毫秒）。 */
    inlineDelayMs: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发续写。 */
    inlineMinChars: z<number, number, "volatile-defined">;
    /** 续写可见字符上限。 */
    inlineMaxChars: z<number, number, "volatile-defined">;
    /**
     * 停顿续写这次辅助调用的推理档位（#35）。语义与 `suggestionReasoningEffort`
     * 完全一致（**默认空串 = 不传 = 继承**，被拒则退一档重发一次），单列一项是因为
     * 续写与建议的延迟预算根本不同：续写在用户停手等待的路径上，建议藏在回合边界
     * 之后没人等。想压续写的首块延迟，先在这里填一个**该模型声明过**的档位。
     */
    completionReasoningEffort: z<string, string, "volatile-defined">;
    /** 幽灵显示时允许 → 逐词采纳。 */
    wordAccept: z<boolean, boolean, "volatile-defined">;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string, "volatile-defined">;
    /**
     * 建议语言模式：'auto' = 自动推断（结合 UI 语言 + 用户消息文字分布）；
     * 'zh' / 'zh-TW' / 'en' / 'ja' / 'ko' / 'ru' / 'fr' / 'de' / 'es' = 强制指定语言。
     * 未知代码在 host 端回退 English（见 generate.ts 的 LANGUAGE_NAMES）。
     */
    languageMode: z<string, string, "volatile-defined">;
    /**
     * UI 语言先验权重（仅 auto 模式生效）：值越大越倾向 UI 语言。
     * 默认 100 ≈ 2-3 条中等长度消息的置信度。
     */
    uiLocaleWeight: z<number, number, "volatile-defined">;
    /**
     * client → host 的热度管理操作队列（JSON 字符串）。
     *
     * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
     * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
     * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
     * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
     */
    _ops: z<string, string, "volatile-defined">;
    /**
     * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
     * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
     * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
     */
    _push: z<string, string, "volatile-defined">;
}>>, "plain">;
export declare const Config: z<Schemastery.TypeS<typeof ConfigSchema>, PluginConfigValues>;
/** 所需服务：LLM 路由 + 会话存储 + 设置服务。 */
export declare const inject: string[];
/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export declare const name = "dsh-suggest-ghost";
export declare function apply(ctx: Context, config: GenerateConfig): void;
export {};
