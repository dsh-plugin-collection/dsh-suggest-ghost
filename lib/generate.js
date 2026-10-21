/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { BlockAssembler, createUserMessage, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { PROJECTION_KEY } from './domain.js';
import { cleanSuggestion, redactSecrets, sanitizeSuggestion, shouldFilterSuggestion, } from './sanitize.js';
import { inlinePrompt, sanitizeCompletion } from './inline.js';
import { extractContextSummary, frameTranscript, isRealUserMessage, suggestionLanguage, trimTranscript, } from './transcript.js';
// 日志读取助手与冷启动语义同源（纯函数、无运行时依赖），此处转发保持既有公开面。
import { sessionEvents } from './coldstart.js';
export { sessionEvents } from './coldstart.js';
/** 本能力所属的辅助请求超时错误码。 */
export const SUGGEST_TIMEOUT_CODE = 'SUGGEST_GHOST_TIMEOUT';
/**
 * `languageMode` 代码 → 提示词里的语言名映射。键与设置页下拉的 option value
 * 一一对应；未知代码回退 English（schema 不限定枚举，用户手改 patch 文件时
 * 传任意字符串都能安全落地，而不是把原文透传给模型）。
 */
const LANGUAGE_NAMES = Object.freeze({
    zh: '简体中文',
    'zh-TW': '繁體中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    ru: 'Russian',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
});
/**
 * 就地深冻结：迭代遍历，循环引用安全，不受调用栈深度限制。
 * 本地实现而非从内核导入——DSH 0.1.1 由 dsh-llm 导出该 helper，0.1.2 把它搬到新增的
 * dsh-util-values 并停止转发，而 dsh-util-values 在 0.1.1 内核里不存在，两个导入源在
 * 对方那一代都会让整个模块链接失败。跳过 AbortSignal 是必须的：它是请求的实时取消
 * 通道，冻结会让 abort 失效。
 */
function deepFreeze(value) {
    const seen = new WeakSet();
    const pending = [value];
    while (pending.length > 0) {
        const node = pending.pop();
        if (node === null || typeof node !== 'object')
            continue;
        if (node instanceof AbortSignal || seen.has(node))
            continue;
        seen.add(node);
        Object.freeze(node);
        for (const key of Object.keys(node)) {
            pending.push(node[key]);
        }
    }
    return value;
}
/**
 * 读取一个可能缺失的可调字段：先问引用（0.1.7 的 `Volatile<T>`），再回落到
 * 裸值（0.1.5/0.1.2 时代 Config 里的普通字段），最后用 schema 默认值。
 *
 * 这样上层（index.ts / client）拿到的永远是裸值，不必关心当前内核代次。
 */
function readVolatile(value, fallback) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === 'object' && typeof value.get === 'function') {
        const inner = value.get();
        return (inner === undefined || inner === null ? fallback : inner);
    }
    return value;
}
/**
 * 把插件配置拍平成「策略 + 可调」的裸值视图。0.1.7 的可调项是引用，其余代码
 * （effective()、client 渲染、热度快照上限）都按裸值读，不必知道代次差异。
 */
export function flattenConfig(config) {
    return {
        ...config,
        llmEnabled: readVolatile(config.llmEnabled, true),
        acceptKey: readVolatile(config.acceptKey, 'Tab'),
        historyEnabled: readVolatile(config.historyEnabled, true),
        historyCrossSession: readVolatile(config.historyCrossSession, false),
        historyMaxEntries: readVolatile(config.historyMaxEntries, 50),
        historyMinChars: readVolatile(config.historyMinChars, 1),
        wordAccept: readVolatile(config.wordAccept, true),
        languageMode: readVolatile(config.languageMode, 'auto'),
        uiLocaleWeight: readVolatile(config.uiLocaleWeight, 100),
        inlineEnabled: readVolatile(config.inlineEnabled, true),
        inlineDelayMs: readVolatile(config.inlineDelayMs, 100),
        inlineMinChars: readVolatile(config.inlineMinChars, 4),
        inlineMaxChars: readVolatile(config.inlineMaxChars, 160),
        contextSummaryEnabled: readVolatile(config.contextSummaryEnabled, true),
        contextSummaryChars: readVolatile(config.contextSummaryChars, 1500),
        // 档位默认**空串 = 不传**（#35 的实测结论：档位按 provider/model 声明，
        // 带一个模型没有的档位会让整次调用在发请求前就失败）。与 index.ts 的 schema
        // `.default('')` 同值，五处登记点由 scripts/reasoning-effort-smoke.mjs 逐处核对。
        // 空串在这里是**合法值**而不是缺失——它表达的就是「继承路由自己的默认档位」。
        suggestionReasoningEffort: readVolatile(config.suggestionReasoningEffort, ''),
        completionReasoningEffort: readVolatile(config.completionReasoningEffort, ''),
    };
}
/** 校验并返回不可变配置。 */
export function resolveConfig(config) {
    if (config === null || typeof config !== 'object') {
        throw new Error('dsh-suggest-ghost: configuration is required');
    }
    const raw = config;
    // 0.1.7 的 Loader 把 volatile 字段解析成 cosmokit 引用（`{ get() }`），
    // 而不是裸值；0.1.5/0.1.2 是裸值。校验一律针对**裸值**，否则 `acceptKey`
    // 这类字符串字段会因为拿到对象而误判成「非法」。`readVolatile` 同时认两种形态。
    const value = {
        ...raw,
        provider: readVolatile(raw.provider, ''),
        model: readVolatile(raw.model, ''),
        acceptKey: readVolatile(raw.acceptKey, 'Tab'),
        llmEnabled: readVolatile(raw.llmEnabled, true),
        inlineEnabled: readVolatile(raw.inlineEnabled, true),
        inlineDelayMs: readVolatile(raw.inlineDelayMs, 100),
        inlineMinChars: readVolatile(raw.inlineMinChars, 4),
        inlineMaxChars: readVolatile(raw.inlineMaxChars, 160),
        maxInputBytes: readVolatile(raw.maxInputBytes, 4096),
        maxOutputTokens: readVolatile(raw.maxOutputTokens, 512),
        timeoutMs: readVolatile(raw.timeoutMs, 60_000),
        maxRecentTurns: readVolatile(raw.maxRecentTurns, 3),
        maxTranscriptChars: readVolatile(raw.maxTranscriptChars, 12_000),
        maxSuggestionChars: readVolatile(raw.maxSuggestionChars, 240),
        contextSummaryEnabled: readVolatile(raw.contextSummaryEnabled, true),
        contextSummaryChars: readVolatile(raw.contextSummaryChars, 1500),
        historyEnabled: readVolatile(raw.historyEnabled, true),
        historyCrossSession: readVolatile(raw.historyCrossSession, false),
        historyMaxEntries: readVolatile(raw.historyMaxEntries, 50),
        historyMinChars: readVolatile(raw.historyMinChars, 1),
        wordAccept: readVolatile(raw.wordAccept, true),
        languageMode: readVolatile(raw.languageMode, 'auto'),
        uiLocaleWeight: readVolatile(raw.uiLocaleWeight, 100),
        suggestionReasoningEffort: readVolatile(raw.suggestionReasoningEffort, ''),
        completionReasoningEffort: readVolatile(raw.completionReasoningEffort, ''),
    };
    const int = (name) => {
        const n = readVolatile(value[name], undefined);
        if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
            throw new Error(`dsh-suggest-ghost: ${name} must be a positive integer`);
        }
        return n;
    };
    int('maxInputBytes');
    int('maxOutputTokens');
    int('timeoutMs');
    if (value.maxRecentTurns !== undefined)
        int('maxRecentTurns');
    int('maxTranscriptChars');
    int('maxSuggestionChars');
    if (typeof value.timeoutMs === 'number' && value.timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`dsh-suggest-ghost: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
    }
    // provider/model 允许留空 = 继承会话最近一次请求的路由（见 routeOf）。
    // 因此这里只校验**成对**：两者要么都空（继承），要么都非空（覆盖）；
    // 一个空一个非空才是配置错误。空串本身合法，不能当成「非法覆盖」拒绝。
    const provider = value.provider;
    const model = value.model;
    if ((provider === undefined) !== (model === undefined)) {
        throw new Error('dsh-suggest-ghost: provider and model must be supplied together');
    }
    if (provider !== undefined && (typeof provider !== 'string' || typeof model !== 'string')) {
        throw new Error('dsh-suggest-ghost: provider and model must be strings');
    }
    const providerGiven = typeof provider === 'string' && provider.length > 0;
    const modelGiven = typeof model === 'string' && model.length > 0;
    if (providerGiven !== modelGiven) {
        throw new Error('dsh-suggest-ghost: provider and model must be supplied together');
    }
    if (value.acceptKey !== undefined
        && (typeof value.acceptKey !== 'string' || value.acceptKey.trim().length === 0)) {
        throw new Error('dsh-suggest-ghost: acceptKey must be a non-empty shortcut string');
    }
    if (value.llmEnabled !== undefined && typeof value.llmEnabled !== 'boolean') {
        throw new Error('dsh-suggest-ghost: llmEnabled must be a boolean');
    }
    if (value.inlineEnabled !== undefined && typeof value.inlineEnabled !== 'boolean') {
        throw new Error('dsh-suggest-ghost: inlineEnabled must be a boolean');
    }
    if (value.inlineMaxChars !== undefined
        && (typeof value.inlineMaxChars !== 'number' || !Number.isInteger(value.inlineMaxChars) || value.inlineMaxChars <= 0)) {
        throw new Error('dsh-suggest-ghost: inlineMaxChars must be a positive integer');
    }
    // 推理档位：**空串合法**（= 不传，继承路由默认档位），与 provider/model 同一套
    // 「留空即继承」的判据。这里只挡类型错误——具体档位 id 由适配器自己校验
    // （dsh-llm 在不支持的档位上抛 UNSUPPORTED_REASONING_EFFORT，见 effortOf 的注释）。
    for (const name of ['suggestionReasoningEffort', 'completionReasoningEffort']) {
        if (value[name] !== undefined && typeof value[name] !== 'string') {
            throw new Error(`dsh-suggest-ghost: ${name} must be a string (empty = inherit)`);
        }
    }
    return deepFreeze(Object.assign({}, value));
}
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
export function effortOf(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    // 品牌化只是给 string 打类型标记、不做校验（dsh-llm 的 brandString），校验在适配器那一侧。
    return trimmed.length === 0 ? undefined : ReasoningEffortId(trimmed);
}
/**
 * 请求档位的留痕写法。参数是**当前这次尝试实际要发的档位**（不是配置原文）：
 * 档位被拒后退一档重发，那一次尝试的请求里根本没有这个键，留痕就该显示 `inherit`。
 */
export function effortLabel(effort) {
    return effort === undefined ? 'inherit' : String(effort);
}
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
export function isUnsupportedEffort(error) {
    const box = error;
    if (typeof box?.code === 'string' && box.code === UNSUPPORTED_EFFORT_CODE)
        return true;
    const message = typeof box?.message === 'string' ? box.message : '';
    if (message.includes(UNSUPPORTED_EFFORT_CODE))
        return true;
    return EFFORT_HINT.test(message) && UNSUPPORTED_HINT.test(message);
}
/** `dsh-llm` 对不受支持的推理档位使用的错误码。 */
const UNSUPPORTED_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT';
/** 要素一：这条错误说的是**档位**。实测报文形态：`does not support reasoning effort "low"`。 */
const EFFORT_HINT = /reasoning[ _-]?effort|effort\s*["']/i;
/** 要素二：说的是「不支持」而不是别的失败。 */
const UNSUPPORTED_HINT = /unsupported|not support|does not support|no such|invalid effort/i;
/** 建一份增量画像（每次尝试一份；重试不复用，见各生成函数的循环体）。 */
export function createStreamMetrics(effortRequested) {
    return {
        firstTextDeltaMs: -1,
        firstReasoningDeltaMs: -1,
        contentDeltas: 0,
        contentChars: 0,
        reasoningDeltas: 0,
        reasoningChars: 0,
        finishKind: 'none',
        attempts: 1,
        effortRequested,
        effortRejected: false,
        outcome: 'empty',
    };
}
/**
 * 把一个流式增量块记进画像。**纯函数**（除入参外不碰任何东西），这样
 * `scripts/stream-metrics-smoke.mjs` 能离线逐块喂假数据断言计数，
 * 不需要真 LLM——历史上这几条判据散在 async 闭包里，离线一条都测不到。
 * @param metrics - 目标画像（就地累加）。
 * @param chunk - dsh-llm 的原始流块。
 * @param startedAtMs - 本次尝试的起点（`Date.now()` 量纲）。
 * @param nowMs - 当前时刻（由调用方给，测试里是假时钟）。
 */
export function observeChunk(metrics, chunk, startedAtMs, nowMs) {
    switch (chunk.type) {
        case 'text-delta':
            if (metrics.firstTextDeltaMs < 0)
                metrics.firstTextDeltaMs = nowMs - startedAtMs;
            metrics.contentDeltas += 1;
            metrics.contentChars += chunk.text.length;
            break;
        case 'reasoning-delta':
            // 单独记：推理增量到得早、正文到得晚，两者之差就是「用户在盯着一行字等」。
            if (metrics.firstReasoningDeltaMs < 0)
                metrics.firstReasoningDeltaMs = nowMs - startedAtMs;
            metrics.reasoningDeltas += 1;
            metrics.reasoningChars += chunk.text.length;
            break;
        case 'finish':
            metrics.finishKind = chunk.reason.kind;
            break;
        default:
            break;
    }
}
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
export function formatStreamMetrics(m) {
    return `first_text_delta_ms=${m.firstTextDeltaMs} first_reasoning_delta_ms=${m.firstReasoningDeltaMs}`
        + ` content_deltas=${m.contentDeltas} content_chars=${m.contentChars}`
        + ` reasoning_deltas=${m.reasoningDeltas} reasoning_chars=${m.reasoningChars}`
        + ` finish_kind=${m.finishKind} attempts=${m.attempts}`
        + ` effort_requested=${m.effortRequested} effort_rejected=${m.effortRejected ? 1 : 0}`
        + ` outcome=${m.outcome}`;
}
/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export function systemPrompt(maxSuggestionChars, language) {
    return [
        'You are a prompt suggestion generator. Your ONLY purpose is to predict the user\'s next prompt in a coding-assistant chat — never to generate content.',
        '',
        `OUTPUT LANGUAGE: ${language}. Every word of your suggestion MUST be in ${language}. Do NOT mix languages.`,
        '',
        'Your job:',
        '1. Read the user\'s most recent message and the assistant\'s final answer.',
        '2. Predict what the USER would naturally type next — not what the assistant should do.',
        '',
        'CRITICAL CONSTRAINTS:',
        '- You are NOT a code generator, writer, or task executor.',
        '- You MUST respond with ONLY the suggestion text, on a single line.',
        '- NEVER generate, implement, code, or produce any content.',
        '- NEVER provide explanations, reasoning, or extra text.',
        '- NEVER use quotes, labels, Markdown, XML, or formatting.',
        '- Be specific when you can — name files, functions, or actions.',
        '- If the next step is not obvious, reply with nothing at all.',
        '',
        'THE TEST: would the user think "I was just about to type that"?',
        '',
        'EXAMPLES:',
        'User asked "fix the bug and run tests", bug is fixed -> "run the tests"',
        'After code written -> "try it out"',
        'Assistant offers options -> pick the one the user would choose',
        'Assistant asks to continue -> "yes" or "go ahead"',
        'Task complete, obvious follow-up -> "commit this" or "push it"',
        'After an error or misunderstanding -> reply with nothing',
        '',
        'NEVER SUGGEST:',
        '- Evaluative feedback ("looks good", "thanks")',
        '- Questions ("what about...?")',
        '- Assistant-voice phrasing ("Let me...", "I\'ll...", "Here\'s...")',
        '- New ideas the user did not ask about',
        '- Multiple sentences',
        '',
        'Reply with ONLY the suggestion, 3-12 words, no quotes or explanation. If the next step is not obvious, reply with nothing.',
        '',
        `At most ${maxSuggestionChars} visible characters.`,
    ].join('\n');
}
/** 提取消息文本块。 */
function renderMessageText(message) {
    let out = '';
    for (const block of message.content) {
        if (block.type === 'text')
            out += block.text;
    }
    return out;
}
/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 3），脱敏，依次按字符预算
 * （`maxTranscriptChars`）与 UTF-8 字节预算（`maxInputBytes`）截尾。
 *
 * 长会话上下文摘要（`contextSummaryEnabled` 开启时）：被裁剪掉的旧消息会
 * 被提取摘要（取每条用户消息的第一句），作为特殊对 prepend 到转录头部，
 * 让模型看到早期已确认的目标、偏好、约束，避免长会话建议质量随长度下降。
 */
export function buildTranscript(session, maxRecentTurns, maxTranscriptChars, maxInputBytes, contextSummaryEnabled = true, contextSummaryChars = 1500) {
    const events = sessionEvents(session);
    let lastTurn = 0;
    const turnStarts = [];
    for (const event of events) {
        if (event.type === 'turn/start')
            turnStarts.push({ turn: event.data.turn, seq: event.seq });
        else if (event.type === 'turn/end')
            lastTurn = event.data.turn;
    }
    if (lastTurn === 0)
        return undefined;
    // 收集所有消息对（不限制回合数），用于摘要提取
    const allPairs = [];
    const allSeqs = [];
    for (const event of events) {
        if (event.type !== 'user/message' && event.type !== 'assistant/message')
            continue;
        // Skip injected user messages (time-context, skill-catalog, runtime-context, etc.)
        // Only keep real user messages where source.kind === 'user'
        if (event.type === 'user/message' && !isRealUserMessage(event))
            continue;
        const message = deriveEventMessage(event);
        if (message === null)
            continue;
        const text = renderMessageText(message).trim();
        if (text.length === 0)
            continue;
        allPairs.push({ role: message.role === 'user' ? 'user' : 'assistant', text: redactSecrets(text) });
        allSeqs.push(event.seq);
    }
    if (allPairs.length === 0)
        return undefined;
    // 计算近期回合的 cutoff
    const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1);
    const cutoffSeq = turnStarts.find(entry => entry.turn === cutoffTurn)?.seq ?? 0;
    // 分离旧对和近期对
    const oldPairs = [];
    const recentPairs = [];
    const recentSeqs = [];
    let baseSeq = 0;
    for (let i = 0; i < allPairs.length; i++) {
        const seq = allSeqs[i];
        if (seq < cutoffSeq) {
            oldPairs.push(allPairs[i]);
        }
        else {
            recentPairs.push(allPairs[i]);
            recentSeqs.push(seq);
            baseSeq = seq;
        }
    }
    // 如果启用摘要且有旧对，提取摘要并 prepend
    const pairs = [];
    const sourceMessageSeqs = [];
    if (contextSummaryEnabled && oldPairs.length > 0) {
        const summary = extractContextSummary(oldPairs, contextSummaryChars);
        if (summary.length > 0) {
            pairs.push({ role: 'user', text: summary });
            sourceMessageSeqs.push(0); // 摘要不对应真实事件，seq 设为 0
        }
    }
    pairs.push(...recentPairs);
    sourceMessageSeqs.push(...recentSeqs);
    if (pairs.length === 0)
        return undefined;
    // 双预算裁剪（字符 + UTF-8 字节）：中文长回复不再因突破 maxInputBytes
    // 而整轮失败——裁剪逻辑见 trimTranscript（纯函数，可单测）。
    const trimmed = trimTranscript(pairs, sourceMessageSeqs, maxTranscriptChars, maxInputBytes);
    return {
        pairs: trimmed.pairs,
        sourceMessageSeqs: trimmed.sourceMessageSeqs,
        baseSeq,
        // 语言证据用未经裁剪的窗口对：裁剪会从最老的对开始丢，短用户消息（「我合并了」、
        // 一条纯 URL）最先出局，一旦只剩助手文本，语言判定就会被代码里的拉丁字母带跑。
        // 合成的摘要对排除在外——它是 `[Earlier context summary]` 这个英文前缀开头的伪 user 消息。
        evidencePairs: recentPairs,
    };
}
/** 解析路由：显式配置优先，否则继承会话最近一次请求的路由。 */
function routeOf(session, config) {
    // 空串是「未配置」而非「显式覆盖」：schema 用 `.default('')` 表达「继承」
    // （volatile 表单不接受必填项，留空即继承）。所以这里必须连同长度一起判断，
    // 只看 `!== undefined` 会把 `''` 当成覆盖，解析出空路由并让插件启动失败。
    if (config.provider !== undefined && config.provider.length > 0
        && config.model !== undefined && config.model.length > 0) {
        return { provider: config.provider, model: config.model };
    }
    const route = session.requestHeader()?.config;
    if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
        return { provider: route.provider, model: route.model };
    }
    throw new Error('dsh-suggest-ghost: no logged request route is available; configure provider and model together');
}
/** 终止原因 → 失败信息。 */
function finishError(finish) {
    switch (finish.kind) {
        case 'stop':
            return undefined;
        case 'error':
        case 'aborted': {
            const error = new Error(finish.failure.message);
            error.code = finish.failure.code;
            return error;
        }
        case 'max-tokens':
            return new Error('dsh-suggest-ghost: suggestion output reached maxOutputTokens');
        case 'tool-calls':
            return new Error('dsh-suggest-ghost: suggestion model unexpectedly requested a tool');
        /* v8 ignore next 2 -- FinishReason 是封闭五元联合，默认分支不可达 */
        default:
            return new Error(`dsh-suggest-ghost: unsupported finish reason "${String(finish.kind)}"`);
    }
}
/** 可中止的退避等待；到点或被中止即返回（由调用方 throwIfAborted 兜底）。 */
async function backoff(signal, ms) {
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
    signal.throwIfAborted();
}
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
export async function generateSuggestion(ctx, config, session, turn, signal, uiLocale, languageMode, uiLocaleWeight, lastLanguage) {
    signal.throwIfAborted();
    const startedAt = Date.now();
    // buildTranscript 已按 maxInputBytes 做 UTF-8 字节兜底截断，这里不再需要
    // 硬抛错：超预算的中文长回复会被优雅裁剪而非整轮静默失败。
    const transcript = buildTranscript(session, config.maxRecentTurns ?? 3, config.maxTranscriptChars, config.maxInputBytes, config.contextSummaryEnabled ?? true, config.contextSummaryChars ?? 1500);
    if (transcript === undefined) {
        throw new Error('dsh-suggest-ghost: session has no model-visible transcript to suggest from');
    }
    const route = routeOf(session, config);
    // 语言判定：指定模式直接使用用户选择的语言；自动模式才走加权推断。
    // 证据取 evidencePairs（未经输入预算裁剪），不取 transcript.pairs——见其注释。
    let language;
    if (languageMode && languageMode !== 'auto') {
        language = LANGUAGE_NAMES[languageMode] ?? 'English';
    }
    else {
        language = suggestionLanguage(transcript.evidencePairs, uiLocale, uiLocaleWeight, lastLanguage);
    }
    const system = systemPrompt(config.maxSuggestionChars, language);
    const framed = frameTranscript(transcript.pairs);
    // source：0.1.7 删除了 `plugin` kind（0.1.5 有、0.1.7 无），且 0.1.7 新增的
    // `schedule` kind 在 0.1.5 不存在 —— 两代**无交集**，故取两代都有的 `user`。
    //
    // 这里 source 只用于构造一次性 LLM 请求载荷（见下方注释：请求细节不落会话日志），
    // 不参与持久化与投影，因此 `user` 的语义差异不影响任何读者。
    const messages = [createUserMessage({
            content: [{ type: 'text', text: framed }],
            source: { kind: 'user' },
        })];
    // 请求细节（turn/seq/provider/model/maxTokens）不再写入会话日志：
    // rc.7 禁止未标记 ignorable 的自定义事件落日志，且建议经 settings `_push` 实时送达 client。
    const maxAttempts = 3;
    // #35 请求档位。`undefined` = 配置留空 = **不往请求上写 `reasoningEffort`**
    // （继承语义，判据与 {@link routeOf} 的 provider/model 同套）。
    //
    // **默认必须是留空**：档位是**按 provider 按 model** 声明的，实测 qoder-route 的
    // 18 个模型里 9 个没有 `reasoningEfforts`（efficient :456 / fast :468 / lite :427，
    // probe-llm 2026-10-21）。给这类模型带任何档位，适配器在**发请求之前**就返回
    // UNSUPPORTED_REASONING_EFFORT（实测 0-20ms 失败），而终止帧的 error 会被下面当成
    // 真实失败抛出 —— 一个非空默认值等于把整条建议路径配成「白等三轮退避、必然失败」。
    // 同理也不实现「传 off/none 关思考」：qfmodel 连 off 都被拒（profile 只声明
    // low/medium/xhigh，:487-490），只有显式声明了 off 的路由才行（如 :270 的 atria）。
    let effort = effortOf(config.suggestionReasoningEffort);
    /** 本次生成里档位是否被拒过（拒过 = 已退一档、不带档位重发）。 */
    let effortRejected = false;
    // 用 while 而不是 for：档位被拒后的那次重发**不占用常规重试预算**（下面那处
    // `attempt -= 1`），它不是瞬时故障的再一次尝试，而是同一次调用的退一档重发。
    let attempt = 0;
    while (attempt < maxAttempts) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            attempt += 1;
            // 每次尝试独立截止时间：timeoutMs 是「单次调用」预算而非三次总和。
            const callDeadline = __addDisposableResource(env_1, deadline(signal, config.timeoutMs, SUGGEST_TIMEOUT_CODE), false);
            const options = deepFreeze({
                provider: route.provider,
                model: route.model,
                messages,
                system,
                maxTokens: config.maxOutputTokens,
                sessionId: session.id,
                signal: callDeadline.signal,
                // 条件展开而不是写 `reasoningEffort: effort`：不传时这个键必须**不存在**。
                // 留一个 `undefined` 在对象上，下游 `callConfigEquals` 与适配器看到的仍是「带档位」。
                ...(effort === undefined ? {} : { reasoningEffort: effort }),
            });
            // 每次尝试一份新画像：首块延迟的起点是**本次尝试**，重试不把第一次的慢首块
            // 记到第二次头上；`attempts` 记的是第几次**外层**尝试收的口（路由内部自己重放
            // 的那一次观测不到，也不算在这里）。
            const metrics = createStreamMetrics(effortLabel(effort));
            metrics.attempts = attempt;
            metrics.effortRejected = effortRejected;
            const attemptStartedAt = Date.now();
            try {
                callDeadline.signal.throwIfAborted();
                const assembler = new BlockAssembler();
                for await (const chunk of ctx.llm.stream(options)) {
                    callDeadline.signal.throwIfAborted();
                    observeChunk(metrics, chunk, attemptStartedAt, Date.now());
                    assembler.push(chunk);
                }
                callDeadline.signal.throwIfAborted();
                const terminalError = finishError(assembler.finish);
                if (terminalError !== undefined)
                    throw terminalError;
                const blocks = assembler.blocks();
                if (blocks.some(block => block.type === 'tool-call')) {
                    throw new Error('dsh-suggest-ghost: suggestion output must contain text only');
                }
                const text = blocks
                    .filter((block) => block.type === 'text')
                    .map(block => block.text)
                    .join(' ');
                const cleaned = cleanSuggestion(text);
                if (cleaned.length === 0 || shouldFilterSuggestion(cleaned)) {
                    // 无建议 = 正常态，不是失败（所以不走 traceFault，走常规耗时行的 outcome）。
                    // 归因就在这里分叉：模型一个字没吐 = `empty`（指向提示词/档位/路由）；
                    // 吐了但净化/过滤链丢掉 = `filtered`（指向 sanitize 那一侧）。原注释声称
                    // 这里有「归因日志」而代码里一个字都没有，#39 就是把它兑现。
                    metrics.outcome = text.trim().length === 0 ? 'empty' : 'filtered';
                    return { suggestion: undefined, language, metrics };
                }
                const { text: suggestion, truncated } = sanitizeSuggestion(cleaned, config.maxSuggestionChars);
                const suggested = {
                    version: 1,
                    turn,
                    baseSeq: transcript.baseSeq,
                    text: suggestion,
                    truncated,
                    acceptKey: config.acceptKey ?? 'Tab',
                    // 帧语义：本期宿主一次生成只出一帧，即终帧（frame 从 1 起，见 domain.ts）。
                    frame: 1,
                    final: true,
                };
                metrics.outcome = 'ok';
                return { suggestion: suggested, language, metrics };
            }
            catch (error) {
                // 外部中止（新回合取代 / 卸载）不重试。
                if (signal.aborted)
                    throw error;
                // **失败即降级一次**（lead 在 #35 上定的判据）：档位不被这个模型支持时，
                // 当场撤掉档位、立刻重发一次不带档位的请求，不退避、不进常规重试链
                // （`attempt -= 1` 把刚才那次还回去）。插件无法预知模型声明了哪些档位，
                // 所以这条路只能靠「试了再说」，但只试一档、只多一次请求。
                if (isUnsupportedEffort(error) && effort !== undefined) {
                    effort = undefined;
                    effortRejected = true;
                    attempt -= 1;
                    continue;
                }
                // 最后一次尝试失败则原样抛出。
                if (attempt >= maxAttempts)
                    throw error;
                await backoff(signal, 1200 * attempt);
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    /* v8 ignore next 2 -- 循环内必然 return 或 throw，此处仅满足类型收窄 */
    throw new Error('dsh-suggest-ghost: suggestion generation exhausted retries');
}
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
export async function generateCompletion(ctx, config, session, draft, signal, uiLocale, languageMode, uiLocaleWeight, lastLanguage) {
    signal.throwIfAborted();
    const startedAt = Date.now();
    const route = routeOf(session, config);
    // 语言判定：指定模式直接使用用户选择的语言；自动模式才走加权推断。
    // 注意：草稿目前**没有**参与语言推断（只传历史证据对）——「中文会话里打英文草稿
    // 被判成中文续写」是已知缺口，另开条目修，不在本改动里混做。
    const transcript = buildTranscript(session, config.maxRecentTurns ?? 3, Math.min(config.maxTranscriptChars, 2000), config.maxInputBytes, config.contextSummaryEnabled ?? true, config.contextSummaryChars ?? 1500);
    const pairs = transcript?.pairs ?? [];
    let language;
    if (languageMode && languageMode !== 'auto') {
        language = LANGUAGE_NAMES[languageMode] ?? 'English';
    }
    else {
        // 与 suggest 路径同源：语言证据取未经输入预算裁剪的窗口对。
        language = suggestionLanguage(transcript?.evidencePairs ?? [], uiLocale, uiLocaleWeight, lastLanguage);
    }
    const inlineMaxChars = config.inlineMaxChars ?? 160;
    const system = inlinePrompt(inlineMaxChars, language);
    // 用户消息：先附少量上下文（若有），再附草稿。
    const contextBlock = pairs.length > 0
        ? `Recent conversation context:\n${frameTranscript(pairs)}\n\n`
        : '';
    const userText = `${contextBlock}Current draft (in-progress text):\n${redactSecrets(draft)}`;
    const messages = [createUserMessage({
            content: [{ type: 'text', text: userText }],
            source: { kind: 'user' },
        })];
    const maxAttempts = 2;
    // 档位通路同 generateSuggestion（默认留空 = 不传；被拒则退一档重发、不占重试预算），
    // 只是读的是 completionReasoningEffort——续写在用户停手等待的路径上，更慢不起。
    let effort = effortOf(config.completionReasoningEffort);
    let effortRejected = false;
    let attempt = 0;
    while (attempt < maxAttempts) {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            attempt += 1;
            const callDeadline = __addDisposableResource(env_2, deadline(signal, config.timeoutMs, SUGGEST_TIMEOUT_CODE), false);
            const options = deepFreeze({
                provider: route.provider,
                model: route.model,
                messages,
                system,
                maxTokens: config.maxOutputTokens,
                sessionId: session.id,
                signal: callDeadline.signal,
                ...(effort === undefined ? {} : { reasoningEffort: effort }),
            });
            const metrics = createStreamMetrics(effortLabel(effort));
            metrics.attempts = attempt;
            metrics.effortRejected = effortRejected;
            const attemptStartedAt = Date.now();
            try {
                callDeadline.signal.throwIfAborted();
                const assembler = new BlockAssembler();
                for await (const chunk of ctx.llm.stream(options)) {
                    callDeadline.signal.throwIfAborted();
                    observeChunk(metrics, chunk, attemptStartedAt, Date.now());
                    assembler.push(chunk);
                }
                callDeadline.signal.throwIfAborted();
                const terminalError = finishError(assembler.finish);
                if (terminalError !== undefined)
                    throw terminalError;
                const blocks = assembler.blocks();
                if (blocks.some(block => block.type === 'tool-call')) {
                    throw new Error('dsh-suggest-ghost: completion output must contain text only');
                }
                const raw = blocks
                    .filter((block) => block.type === 'text')
                    .map(block => block.text)
                    .join(' ');
                const text = sanitizeCompletion(raw, draft, inlineMaxChars);
                if (text === undefined) {
                    // 同 generateSuggestion：空回复与「被净化链丢掉」必须分成两种 outcome。
                    // 判据是**送进净化链之前的原文**：原文就没有字 = empty；有字而净化后没了
                    // （stripDraftEcho 裁空、形态兜底拦下）= filtered。`sanitizeCompletion` 本身
                    // 不区分这两者，也不该区分——区分它是留痕层的职责。
                    metrics.outcome = raw.trim().length === 0 ? 'empty' : 'filtered';
                    return { text: undefined, language, metrics };
                }
                metrics.outcome = 'ok';
                return { text, language, metrics };
            }
            catch (error) {
                if (signal.aborted)
                    throw error;
                // 失败即降级一次：撤档位、立刻重发，不退避、不占重试预算。
                if (isUnsupportedEffort(error) && effort !== undefined) {
                    effort = undefined;
                    effortRejected = true;
                    attempt -= 1;
                    continue;
                }
                if (attempt >= maxAttempts)
                    throw error;
                await backoff(signal, 800 * attempt);
            }
        }
        catch (e_2) {
            env_2.error = e_2;
            env_2.hasError = true;
        }
        finally {
            __disposeResources(env_2);
        }
    }
    /* v8 ignore next 2 -- 循环内必然 return 或 throw，此处仅满足类型收窄 */
    throw new Error('dsh-suggest-ghost: completion generation exhausted retries');
}
export { PROJECTION_KEY };
