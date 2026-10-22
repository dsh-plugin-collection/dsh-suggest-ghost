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

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cosmokit';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import {
  appendToRing,
  decidePersistedPush,
  HISTORY_PUSH_CAP,
  nextTrackedSuggestion,
  parsePersistedPush,
  seedRingFromLog,
  SUGGESTION_CACHE_CAP,
  suggestionFieldsFor,
  suggestionIsCurrent,
  userTextOfEvent,
} from './coldstart.js';
import type { PersistedPushVerdict } from './coldstart.js';
import {
  COMPLETION_DEADLINE_MS,
  completionFaultMessage,
  decideCompletionEntry,
  startBoundedCompletion,
} from './completion-gate.js';
import type { CompletionGateDecision } from './completion-gate.js';
import { SUGGEST_EVENT } from './domain.js';
import type { SuggestGhostHotEntry, SuggestGhostSuggested } from './domain.js';
import {
  DeferredWriteQueue,
  DEFERRED_PUMP_MS,
  decideClearOpsDrain,
  decidePushDrain,
  errorText,
  triageWriteFailure,
  decideHotPush,
  HOT_PUSH_WINDOW_MS,
} from './deferred-writes.js';
import type {
  DeferredItem,
  DeferredKind,
  DeferredPushItem,
} from './deferred-writes.js';
import { faultSignature } from './fault-signature.js';
import { flattenConfig, formatStreamMetrics, resolveConfig } from './generate.js';
import type { Config as GenerateConfig, FlatConfig, ResolvedPluginConfig } from './generate.js';
import { generateSuggestion, generateCompletion, sessionEvents } from './generate.js';
import { sanitizeCompletion } from './inline.js';
import { createLiveSettings } from './live-settings.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import type { ParsedOpsResult } from './hotness-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { EMPTY_PUSH, mergeLiveConfig, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostProjection } from './domain.js';

/**
 * 用户可调项：逐字段标 `.volatile()`。0.1.7 让字段出现在 WebUI 设置页的开关
 * 就是它 —— `dsh-settings` 的 `volatileForm()` 递归下探、只收 `meta.volatile`
 * 的节点（`Config` 这层对象本身不能标：标了会让整棵子树都变成表单，策略参数
 * 一并暴露；也不能把 `z.object({...}).volatile().dict` 摊平再 spread ——
 * 摊平会丢掉每个字段自己的 `meta`，实测直接导致整张表单不可见）。
 *
 * 语义与 `dsh-client-ui-theme` 的 `preference` / `fontSize` 完全一致：解析后拿到的
 * 不是裸值而是一个**引用**（cosmokit 的 `Volatile<T>`），读值必须走 `.get()`。
 * 内核写盘时用同一判据 `isVolatilePath()` 把这些字段从 profile 文档里剔除，
 * 所以它们只活在 Loader 条目的内存 config 里，不污染手改的补丁文件。
 *
 * 这些字段**取代** 0.1.5/0.1.2 时代的 `suggest-ghost` settings 命名空间：
 * 0.1.7 删除了 `ctx.settings.register()`，命名空间不再由插件注册，而是内核把
 * 插件自己的 Config schema 投影成表单（ns = Loader 条目 id = `suggest-ghost`）。
 *
 * **依赖下限是 `@deepseek-ai/schemastery@^3.18.3`，不是 `^3.18.1`。**
 * `.volatile()` 是 3.18.3 才加入 schemastery 的；3.18.1 / 3.18.2 上调用它得到
 * `TypeError: ....volatile is not a function`。这**不是运行期异常，而是模块求值
 * 期的硬失败**——整个插件条目加载不了，0.1.7 会在 Web 启动时报
 * `1 entry did not activate` 并挡住界面。所以 peer 范围必须卡在 3.18.3 起，
 * 放宽到 `^3.18.1` 会让 pnpm 解析出旧版并直接炸掉。
 */
const EditableFields = {
  /** 最终框架化用户提示的最大 UTF-8 字节数。 */
  maxInputBytes: z.natural().min(1).default(4096).volatile(),
  /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
  maxOutputTokens: z.natural().min(1).default(512).volatile(),
  /** 辅助请求端到端截止时间（毫秒）。 */
  timeoutMs: z.natural().min(1).default(60_000).volatile(),
  /** 转录尾部保留的最近完成回合数（默认 3：保留近期上下文）。 */
  maxRecentTurns: z.natural().min(1).default(3).volatile(),
  /** 转录字符预算。 */
  maxTranscriptChars: z.natural().min(1).default(12_000).volatile(),
  /** 是否启用长会话上下文摘要（默认开）：旧消息被裁剪时提取摘要保留关键信息。 */
  contextSummaryEnabled: z.boolean().default(true).volatile(),
  /** 上下文摘要最大字符数（仅 contextSummaryEnabled 时生效）。 */
  contextSummaryChars: z.natural().min(100).default(1500).volatile(),
  /** 建议可见字符上限。 */
  maxSuggestionChars: z.natural().min(1).default(240).volatile(),
  /**
   * 显式路由对；`z.string().default('')` 而非 `min(1)`：留空表示「继承主请求
   * 最近记录的路由」。若保持必填，volatile 表单会把插件逼成「不填就不能启动」，
   * 而继承语义恰恰要求它是可选的。
   */
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
  llmEnabled: z.boolean().default(true).volatile(),
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
  suggestionReasoningEffort: z.string().default('').volatile(),
  /** 是否启用历史前缀补全。 */
  historyEnabled: z.boolean().default(true).volatile(),
  /** 是否跨会话搜索历史（false = 仅当前会话）。 */
  historyCrossSession: z.boolean().default(false).volatile(),
  /** 历史补全最多参考的历史条目数（0 = 不限）。 */
  historyMaxEntries: z.natural().min(0).default(50).volatile(),
  /** 草稿至少输入多少字符才触发历史补全。 */
  historyMinChars: z.natural().min(1).default(1).volatile(),
  /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
  inlineEnabled: z.boolean().default(true).volatile(),
  /** 停顿多久后触发续写（毫秒）。 */
  inlineDelayMs: z.natural().min(100).default(100).volatile(),
  /** 草稿至少输入多少字符才触发续写。 */
  inlineMinChars: z.natural().min(1).default(4).volatile(),
  /** 续写可见字符上限。 */
  inlineMaxChars: z.natural().min(1).default(160).volatile(),
  /**
   * 停顿续写这次辅助调用的推理档位（#35）。语义与 `suggestionReasoningEffort`
   * 完全一致（**默认空串 = 不传 = 继承**，被拒则退一档重发一次），单列一项是因为
   * 续写与建议的延迟预算根本不同：续写在用户停手等待的路径上，建议藏在回合边界
   * 之后没人等。想压续写的首块延迟，先在这里填一个**该模型声明过**的档位。
   */
  completionReasoningEffort: z.string().default('').volatile(),
  /** 幽灵显示时允许 → 逐词采纳。 */
  wordAccept: z.boolean().default(true).volatile(),
  /** 采纳建议的输入框快捷键（默认 Tab）。 */
  acceptKey: z.string().min(1).default('Tab').volatile(),
  /**
   * 建议语言模式：'auto' = 自动推断（结合 UI 语言 + 用户消息文字分布）；
   * 'zh' / 'zh-TW' / 'en' / 'ja' / 'ko' / 'ru' / 'fr' / 'de' / 'es' = 强制指定语言。
   * 未知代码在 host 端回退 English（见 generate.ts 的 LANGUAGE_NAMES）。
   */
  languageMode: z.string().default('auto').volatile(),
  /**
   * UI 语言先验权重（仅 auto 模式生效）：值越大越倾向 UI 语言。
   * 默认 100 ≈ 2-3 条中等长度消息的置信度。
   */
  uiLocaleWeight: z.natural().min(0).default(100).volatile(),
  /**
   * client → host 的热度管理操作队列（JSON 字符串）。
   *
   * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
   * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
   * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
   * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
   */
  _ops: z.string().default(EMPTY_PUSH).volatile(),
  /**
   * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
   * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
   * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
   */
  _push: z.string().default(EMPTY_PUSH).volatile(),
  /**
   * host → client 的实时推送载荷·**热度格**（#36 建议 2）。
   *
   * 装 `{hot, total, history, historySessionId}`（见 settings.ts 的 `GhostHotPayload`），
   * 与 `_push`（建议格）分开的唯一理由：两者节奏不同。热表**每次用户输入**都会变，
   * 而建议每回合最多一次。挤在一格时，热度变化会逼着建议那一格一起被重写、客户端也
   * 无从分辨「变的是哪一格」。拆开之后：
   *  - 两格各自有指纹，各自决定要不要写（`src/index.ts` 的 `fingerprintOfPush` / `fingerprintOfHot`）；
   *  - **同一次 flush 里两格都脏 ⇒ 合并成一次 `settings.update`**。理由不是「省一次
   *    整档重写」——补写泵不排队（probe-hmr 第二次复核），各写各的最坏只是多等一个
   *    500ms tick——而是**客户端只被叫醒一次**：一次 `describe()` 回来的就是两格的
   *    完整当前状态，两格各写会让客户端解析两遍、第二遍里热度是新的、建议是旧的。
   *  - 热度格**不进补写队列**：它每帧都会被下一帧覆盖，丢了由下一次任何变化自愈
   *    （失败时清指纹 + 载荷留在槽里等下一次 flush）；建议格才走 #47 的三态分诊与补写。
   */
  _hot: z.string().default(EMPTY_PUSH).volatile(),
};

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
  _hot: Volatile<string>;
}

/**
 * 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。
 *
 * 标注必须写成 `z<输入, 输出>` 两参形式，不能用 `z<PluginConfigValues>` 单参：
 * `.volatile()` 字段的**输入**是裸值、**输出**是 `Volatile<T>`（见 `ObjectS` /
 * `ObjectT`），单参标注会让两侧都被当成 `Volatile<T>`，`default()` 的入参随之
 * 对不上而报 TS2322。输入形状用 `Schemastery.TypeS<typeof ConfigSchema>` 取回。
 */
const ConfigSchema = z.object({
  ...EditableFields,
});

export const Config: z<Schemastery.TypeS<typeof ConfigSchema>, PluginConfigValues> = ConfigSchema;

/** 所需服务：LLM 路由 + 会话存储 + 设置服务。 */
export const inject = ['llm', 'sessions', 'settings'];

/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export const name = 'dsh-suggest-ghost';

/** 每会话生成状态：防重入、可中止。 */
interface SessionState {
  /** 日志中已生成建议的最新回合号（重载/恢复后避免重复生成）。 */
  lastSuggestedTurn: number;
  /** 在途生成；新回合会中止旧生成。 */
  pending: { readonly turn: number; readonly controller: AbortController } | undefined;
  /** 上次建议的语言（语言惯性：短消息无足够信号时回退）。 */
  lastLanguage: string | undefined;
}

/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session: Session): number {
  let last = 0;
  // 跨代读取：0.1.2 起没有 `session.events`（见 generate.sessionEvents）。
  for (const event of sessionEvents(session)) {
    if (event.type === SUGGEST_EVENT && typeof event.data.turn === 'number') {
      last = Math.max(last, event.data.turn);
    }
  }
  return last;
}

/**
 * `generateCompletion` 的成功返回值形状。
 *
 * 之所以要在调用点显式写出来：`startBoundedCompletion<T>` 的 `T` 只由 `generate`
 * 一处提供候选，而 `deliver` 在参数对象里排在它前面，推断拿不到候选就把 `value`
 * 定成 `unknown`（实测报 TS18046）。显式类型参数比到处 `as` 干净。
 */
type CompletionValue = Awaited<ReturnType<typeof generateCompletion>>;

/**
 * 热度格被拒后由事务外 pump 补写的**次数上限**（2026-10-22 事故护栏）。
 *
 * 为什么是 3 而不是 `DEFERRED_MAX_ATTEMPTS`（8）：热度格是**整份当前快照**，不是
 * 「用户刚等的东西」——它每帧都可能被下一帧覆盖，晚 1.5s（3 × 500ms）落盘与晚 4s
 * 落盘对产品没有区别；而每次补写都占同一把 profile 锁，预算给大了只是加剧本仓与
 * 其它写者的锁竞争（`atomic-write: timed out waiting for the writer lock` 的来源）。
 * 到点丢弃后清指纹，下一次状态推送（打字/回合结束/pull 应答）会重建一份**更新**的
 * 快照，不会丢数据。
 */
export const HOT_DRAIN_MAX_ATTEMPTS = 3;

/** 热度格写合并窗口的长度在此 re-export，冒烟从 `lib/index.js` 读它更顺手。 */
export { HOT_PUSH_WINDOW_MS, decideHotPush } from './deferred-writes.js';

/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */

/**
 * `_ops` / `_push` 通道的**语义留痕**唯一落点（模块级，所以 apply() 入口也能用）。
 *
 * ⚠️ **这里必须是 `console.log`。改回 `ctx.logger` 单通道等于把留痕删掉**：
 * 宿主全局只有一个 logger exporter（`@deepseek-ai/dsh-app-boot` 的 `boot()` 内，行号见
 * `docs/internals-cordis-settings-pitfalls.md` 的代次对照表，
 * `levels:{default:2}` 挡掉 debug、回调只收 warn/error 所以 info 也丢），而它攒的
 * startupLogs 只在**启动失败**时由 `dsh/lib/bin.js:158 reportStartupFailure` 写盘
 * → 健康进程里 ctx.logger 一个字都不落任何地方。`console.log → stdout → tee
 * ~/.dsh/dsh-web.log` 是运行期唯一可见面。
 * 语义留痕（收到什么 op / 消费结果 / 被拒原因 / 写后凭证 / 本次加载的构建）
 * 不属于「可清理的调试噪声」，别把它和现场 dump 一起删。
 */
const traceOps = (message: string): void => {
  console.log(`[dsh-suggest-ghost][ops-trace] ${message}`);
};

/**
 * 本模块被加载时那份产物的 mtime（在**模块顶层**求值，所以它记的是"这次加载读到的
 * 文件"，而不是之后某个时刻盘上的最新版本）。
 *
 * 为什么值得记：本仓 `lib/` 是入库产物、宿主加载 `lib/index.js`，而 `src/` 改了不重建、
 * 或重建后进程没重载，都会让「我改完了」和「跑的是旧字节」同时成立且无法区分
 * （issue #20 记的就是这种白跑一轮）。有这一个值，任何一次 apply() 打印出来的时刻
 * 与当前盘上时刻一比就知道差了几份构建。
 */
const LOADED_ARTIFACT_MTIME = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime;
  } catch {
    return null;
  }
})();

export function apply(ctx: Context, config: GenerateConfig): void {
  // 每次挂载打一行，回答两件事：**这个进程现在跑的是哪份构建**（mtime），以及
  // 刚才那次改动有没有真的把模块换进来（hmr partialReload 会重新 apply）。
  // 只在挂载时出现，正常一次进程一到几行，不是可清理的调试噪声。
  traceOps(`apply called; artifact mtime=${LOADED_ARTIFACT_MTIME?.toISOString?.() ?? 'unknown'}`);
  const resolved = resolveConfig(config);
  const states = new WeakMap<Session, SessionState>();
  const tracked = new Set<SessionState>();
  // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
  // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
  const { hotness, persistence } = setupHotnessPersistence(ctx);

  // 读取生成配置的 live 值：状态经 `_push` volatile 字段推给 client
  // （0.1.7 移除了 settings.yaml：字段载体从 SettingsScope 换成 volatile 配置
  // 字段，载荷结构不变）。
  let settingsSvc: { update: (ns: unknown, patch: object) => Promise<void> } | null = null;
  /**
   * 事务外排水锚点的定时器句柄（`apply()` 期建立，卸载时清掉；建它的时机就是这条修复
   * 的全部依据，见 `drainDeferred` 的注释）。null = 尚未建立（settings 服务未注入）。
   */
  let deferredPump: ReturnType<typeof setInterval> | null = null;
  /**
   * **默认层**：boot 时 `resolveConfig` 产物的拍平视图。
   *
   * `resolved = resolveConfig(config)` 是**深冻结的首次解析快照**——内核每次配置
   * 写入走 `configEditor.edit → mergeLayers → 重解析`，替换 fiber 持有的新 config，
   * 旧引用不回填（issue #19 的根因）。所以这份只能当默认值 / describe() 不可用时的
   * 回退，**不能**当实时值：#19 遗留段正是 `liveSettings = flattenConfig(resolved)`
   * 与 `effective()` 的两个入参同源、都在重读这份冻结快照，导致设置页改开关在运行中
   * 不生效（boot 前改好才正常）。
   */
  const bootSettings: FlatConfig = flattenConfig(resolved);
  /**
   * **覆盖层**：用户可调项的实时视图，源自 `settings.describe()`（每次现读
   * `entry.fiber.config` 并展开 volatile，是插件内唯一可靠的实时值来源——与已修的
   * `readOps` 同一依据，只是这次用整个 `row.value`，而不只是 `_ops`）。
   *
   * 失效语义（缓存策略；热路径必读这段）：
   *  - **事件驱动为主**：`settings/document-updated(ns)` 命中本 ns 时 `invalidate()`
   *    标脏，**下一次读**才现调用 describe() 一次。事件风暴期间 N 次标脏合并成 1 次
   *    describe()，成本上界 = 读次数（每次生成 / 推送至多一次）而非事件次数。
   *  - **命中缓存零成本**：未脏且未过 TTL 时 `effective()` 返回同一个对象引用，
   *    不碰 describe()、不新建对象（`handleComplete` 每次续写、`statePushOf` 每次
   *    推送都要读，属高频）。
   *  - **TTL 兜底（默认 5s）**：万一监听没挂上 / 内核在别的 ownerContext 上 emit，
   *    最迟 5s 后自愈；代价是最多每 5s 一次 describe()。
   *  - **安全回退**：`settingsSvc` 未注入（启动早期）或 describe() 抛异常时沿用
   *    上一次权威快照（初值即 boot 默认层），永不抛——host 不能因读设置崩。两条
   *    失败路径都**清脏**（不做注定失败的重试，见 `live-settings.createLiveSettings`
   *    第 4 条），所以本回调里注入就位时**显式** `invalidate()` 一次，实时值在就位后
   *    的第一次读就到，不必等 TTL。
   *  - `_ops` / `_push` 是 volatile **传输载体**而非设置项，由 `live-settings` 的
   *    `FlatConfig` 键白名单挡在外面，不会被当配置值读进 effective()。
   */
  let liveSettingsFailed = false;
  /** 上一次已留痕的实时快照 revision（按 revision 去重，避免 TTL 刷新反复打行）。 */

  /**
   * 同类故障的累计次数（节流用）。
   *
   * 键是 **kind + 归一化后的错误签名**，不是光 kind。原因：按 kind 计数的话，
   * 「路由缺失」打了一次之后，第 2..49 次里如果混进一个**完全不同性质**的新故障
   * （锁超时、模型 4xx、投影服务缺失），它会被同一个计数器一起吞掉——那等于把
   * #17 的教训又犯一遍，而且这次是主动犯的。按签名分桶后：同类只报计数，
   * 新类立刻独立报第一条。签名里抹掉会话 id 与耗时，避免同一原因被拆成无数桶。
   */
  const faultCounts = new Map<string, number>();

  /**
   * 故障留痕：console.log（运行期可见）+ `ctx.logger.warn`（崩溃转储里也留一份）。
   * @param kind - 故障类别。同类**第一次**完整打印，之后每 `every` 次打一条带计数的——
   *   历史上 `_ops` 清空的 nested-transaction 拒绝在一个进程里刷了 372 行同样的报文，
   *   那本身就是噪声；但一次都不打就又回到「静默失败」，所以是节流而不是静音。
   */
  const traceFault = (kind: string, message: string, every = 50): void => {
    const key = `${kind}|${faultSignature(message)}`;
    const seen = (faultCounts.get(key) ?? 0) + 1;
    faultCounts.set(key, seen);
    if (seen !== 1 && seen % every !== 0) return;
    traceOps(`${message} [${kind} #${seen}]`);
    ctx.logger.warn(`dsh-suggest-ghost: ${message}`);
  };

  let lastLiveTracedRevision: number | undefined;
  const liveSettings = createLiveSettings({
    ns: SUGGEST_GHOST_NAMESPACE,
    // 必须是 getter 形态：settingsSvc 在 ctx.inject 回调里才就位。
    readDescribe: () => {
      const svc = settingsSvc as { describe?: () => unknown } | null;
      if (svc === null || typeof svc.describe !== 'function') return undefined;
      return svc.describe();
    },
    // 合并策略：默认层 = bootSettings，覆盖层 = describe() 提炼的实时值；
    // mergeLiveConfig 保留「provider/model 留空 = 继承主请求路由」的既有语义，并让
    // 「在设置页清空路由对」这一动作实时生效（boot 是旧读取结果，不是独立配置层）。
    merge: mergeLiveConfig,
    // 诊断走 ctx.logger（不新增 console.log 债务）。注意 describe() 失败的 TTL 重试
    // 是每 5s 一次，所以只在「真异常」上打一次 warn，恢复时补一条 info。
    // ⚠️ 但只有下面那条 `warn` 真的能落到任何地方（且仅当启动失败时进崩溃转储）：
    // 本宿主唯一的 logger exporter 的回调只收 warn/error，`info` / `debug` 会被丢弃——
    // 取证见 `traceOps` 上方那段。**所以 #19 的「设置页改了有没有生效」不能靠这几行
    // 判定**，要看 `[dsh-suggest-ghost][ops-trace]` 那侧的通道留痕，或另加一次性断言。
    onRefresh: (info) => {
      if (info.ok) {
        if (liveSettingsFailed) {
          liveSettingsFailed = false;
          traceOps('live settings recovered (describe() available again)');
        }
        // 只在 **revision 变化**时留痕：onRefresh 每次刷新尝试都会回调（TTL 5s 到点也
        // 触发），照抄进来就又造出一场 #21 式的洪水。#19 的验收判据恰好就是「改了有没有
        // 被重新读到」，它等价于 revision 变了，所以按 revision 过滤不丢信息。
        if (info.revision !== lastLiveTracedRevision) {
          lastLiveTracedRevision = info.revision;
          traceOps(`live settings refreshed rev=${String(info.revision)} applied=${info.applied}`);
        }
        return;
      }
      if (info.reason === 'describe-threw') {
        if (!liveSettingsFailed) {
          liveSettingsFailed = true;
          traceFault('live-settings-failed', `live settings describe() failed, falling back to boot snapshot: ${String(info.error)}`, 20);
        }
        return;
      }
      // 服务还没注入：boot 早期属预期，静默降级成 boot 视图。
    },
  });
  /**
   * 当前生效配置 = boot 默认层 + describe() 实时覆盖层（身份记忆化：未刷新时
   * 返回同一个对象，读它是免费的）。describe() 不可用时退化成 boot 视图。
   */
  const effective = (): FlatConfig => liveSettings.snapshot(bootSettings);
  /** 热度快照的 top-K 上限：同属用户可调项，必须读实时视图而不是冻结快照。 */
  const historySnapshotCap = (): number => effective().historyMaxEntries;
  /**
   * `_ops` 的最后一次已消费载荷。0.1.7 的 volatile 字段是**引用**（`Volatile<T>`），
   * 内核写入时替换引用而非改原对象；`settings/document-updated` 只带
   * (ns, revision)，故每次都重读引用比对载荷值（引用身份不可靠：同值重写也会
   * 换引用，载荷比对才是语义判重）。
   */
  let lastOpsPayload = EMPTY_PUSH;
  /**
   * client 最后一次 `_ops` 写入捎带的 UI 语言（'zh' | 'en'）。
   * host 重启后为空，client 下次 pull 会重新捎带；语言检测时作为先验加成。
   */
  let clientUiLocale: string | undefined;
  /**
   * 取当前某个传输通道的载荷字符串（`_ops` / `_push`）。
   *
   * **必须走 settings 服务的 `describe()`**：内核每次配置写入会重新解析 config
   * 并替换 fiber 持有的对象，apply 参数里捕获的 volatile 引用会冻结在失效时刻的
   * 值（实测：client 写入 complete op 后，插件内的旧引用永远停在首次 pull 的
   * 载荷）。`describe()` 同步读取 `entry.fiber.config` 的展开值，是唯一权威源。
   * settings 服务尚未注入（启动早期）时回退到 volatile 引用读取。
   *
   * `_push` 与 `_ops` 走**同一个** describe 行，所以回读残留建议不必多读一次盘。
   */
  const readChannel = (name: '_ops' | '_push' | '_hot'): string => {
    const svc = settingsSvc as { describe?: () => unknown } | null;
    if (svc !== null && typeof svc.describe === 'function') {
      try {
        const listed = svc.describe();
        const rows = Array.isArray(listed)
          ? listed
          : Array.isArray((listed as { namespaces?: unknown[] })?.namespaces)
            ? (listed as { namespaces: unknown[] }).namespaces
            : [];
        for (const row of rows as Array<{ ns?: string; revision?: number; value?: Record<string, unknown> }>) {
          if (row?.ns !== SUGGEST_GHOST_NAMESPACE) continue;
          const v = row.value?.[name];
          if (typeof v === 'string') return v;
        }
      } catch { /* describe 异常回退引用读取 */ }
    }
    const ref = (resolved as { _ops?: unknown; _push?: unknown; _hot?: unknown })[name];
    const payload = typeof ref === 'object' && ref !== null && typeof (ref as { get?: unknown }).get === 'function'
      ? (ref as { get: () => unknown }).get()
      : ref;
    return typeof payload === 'string' ? payload : EMPTY_PUSH;
  };
  /** 取当前 `_ops` 的载荷字符串（读面依据见 {@link readChannel}）。 */
  const readOps = (): string => readChannel('_ops');
  /**
   * 取当前 `_push` 的载荷字符串（启动回读用；读面依据同 {@link readChannel}）。
   *
   * **为什么要现读**：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体，宿主
   * 重启后盘上那条残留就是上一个进程写的建议——回读必须读到**当前**盘上值，否则
   * 恢复的是一份陈旧快照（apply 参数里的 volatile 引用会冻结在失效时刻）。
   */
  const readPush = (): string => readChannel('_push');
  /**
   * 取当前 `_hot`（热度格）的载荷字符串。启动回读**只为对齐指纹**：热度不是不可重建的
   * LLM 输出（热表由 storageDomain 自己恢复、环由会话日志物化），所以这里不恢复任何
   * 状态，只是「盘上那格的内容我已经知道，别再写一遍」——与 #50 的「第一次 pull 零写」
   * 同一条性质，拆成两格之后必须**两格都成立**。
   */
  const readHot = (): string => readChannel('_hot');
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const svc = (settingsCtx as { settings?: { update: (ns: unknown, patch: object) => Promise<void> } }).settings;
      if (svc === undefined) {
        ctx.logger.warn('dsh-suggest-ghost: settings service is undefined');
        return;
      }
      settingsSvc = svc;
      // **事务外排水锚点**：被拒的写入（结构性拒绝 + 可重试的竞争失败）由它补。
      //
      // 建在这里（`apply()` 的同步续体、settings 服务刚就位）是这条修复的**前提**，不是
      // 风格偏好：`setInterval` 捕获的是建它那一刻的 `AsyncLocalStorage` 上下文，而 boot
      // 期 `apply()` 不在 HMR 事务内，此刻 store 是 undefined，于是这个定时器以后每次
      // 触发都在事务外。
      //
      // ⚠️ **实测有五种上下文各写一次**（复核评论 #36 `issuecomment-37810`，实跑宿主
      // 0.2.1-rc.2；「判定」列是「写有没有进盘并 bump revision」，**不是**「耗时多少」）：
      //
      // ```
      // A（事务外建立，store=undefined）
      // A2 apply() 期建的 setTimeout(5s)      OK    191–299ms    ✓ bump
      // A3 apply() 期建的 setInterval(8s)     OK    201–283ms    ✓ bump
      // A9 回调内 await 500ms 后写            OK    1685–1893ms  ✓ bump
      // A5 回调内直接写                        FAIL  2072–2113ms  ✗ timed out waiting for the writer lock
      // B（真事务内，store=true）
      // B1 回调内直接写                        FAIL  23–31ms      ✗ HMR transactions cannot be nested
      // ```
      //
      // 两条结论：① **失败有两种互不相同的成因**——nested 由**上下文在哪儿建立**决定
      // （同步零副作用拒绝，23~31ms 即拒），锁超时由**争锁**决定（2s 硬上限，与上下文
      // 无关）；② 早先 PROBE 里 1463/1722ms 那两行「OK」其实撞的是锁窗口，**耗时不是
      // 写入耗时**。所以「事务外就能写」只是必要条件，还要**别和别人抢锁**（见
      // `drainDeferred` 里的互斥段）。
      //
      // 因此这段绝不能被挪进任何 handler 或 await 续体，也不会「随便找个地方建都行」。
      // 间隔 500ms 的依据见 `DEFERRED_PUMP_MS`；队列空时回调只做一次布尔判断就 return。
      if (deferredPump === null) deferredPump = setInterval(drainDeferred, DEFERRED_PUMP_MS);
      // 服务就位 → 标脏并立刻预热一次实时视图。#19 遗留段的旧写法是
      // `liveSettings = flattenConfig(resolved)`——重读的仍是冻结的 boot 快照，
      // 等于没刷新；现在改走 describe()，此后设置页的改动无需重启即生效。
      liveSettings.invalidate();
      effective();
      // 重启/重载对账：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体。
      //
      // ⚠️ 本函数原先在此处断言「volatile 字段不落盘，故内存里没有跨进程残留」，
      // 该断言**是错的**，两条观测都能反证：
      //  - `_ops` / `_push` 实际写在 profile 文档里（本机 `/home/wujue/.dsh/profiles/web/cordis.patch.yml`
      //    里就有 `_ops: '{"rev":28,...}'` 与 `_push: '{"rev":268,...}'` 两行）；
      //  - 用一个复制了该 profile 的新实例做隔离验证时，它在**还没有任何客户端连上来**
      //    的情况下就打印了 `ops consumed: complete ... draftChars=12`，即启动就重放了
      //    上一个进程遗留的载荷（`_ops clear failed` 紧随其后）。
      // 遗留载荷能长期留在盘上的原因是「消费后清空」在 settings 事件回调里被内核按
      // `HMR transactions cannot be nested` 结构性拒绝（实测一个进程 372/373 次失败），
      // 于是去重只剩进程内的 lastOpsPayload 守卫，而它每次启动都归零。
      //
      // `_ops` 遗留补消费：client 冷启动的 pull 若抢跑在本注入之前，那次写入
      // 已被错过，这里补一次关掉那个时序窗口。热度 ops 是幂等的；但 `complete`
      // 的补消费会**为旧草稿重新生成一次续写**，那是上面那条结构性失败带来的代价
      // （修法见 issue #16 的跟进：载荷自带 seq + 把清空挪到事务外）。
      // **启动回读**：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体 ——
      // 上面的自述写着这件事，但读回那段在 `c3b6a80`（0.1.7 volatile 适配）里随
      // `parsePersistedPush(scope.get()._push)` 一起被删掉、之后没接回来（#50）：
      // 于是「宿主重启后把盘上残留的建议恢复出来」这条语义一直是缺的——盘上残留
      // 既没被恢复、也没被清掉，随后 client 第一次 pull 用内存里的空把盘上那条
      // 盖掉（`fingerprintOf` 对「空建议」与「有建议」是两个指纹，空载荷被当成
      // 新值写下去）。
      //
      // **本段只读不写、不推**：
      //  - 不写：回读不是一次推送，无故写一次就是把 rev 顶上去一格（内容却一样）；
      //    清盘也不该在启动期做——判据还没成立（见下面「会话未进店」那条）。
      //  - 不推：启动期推一次 = client 可能收到两份内容相同、rev 不同的载荷
      //    （#18 记过的 last-wins 通道「瞬时载荷必然被跳过」那类问题）。恢复后的
      //    建议由**该会话第一次 pull** 的应答带出去（见 `restorePersistedPushForSession`），
      //    那才是 client 真正需要的入口。
      const rawPush = readPush();
      persistedPushRaw = rawPush === '' || rawPush === 'null' ? null : rawPush;
      // 两格**一起 seed**，且放在建议判定之前：热度格不参与「恢复/清盘」判断（热度不是
      // 不可重建的 LLM 输出），只负责「盘上那格我已经知道，别再写一遍」。放在 if 之外是有
      // 意的——`_push` 可能是 null 而 `_hot` 有值（上一个进程推过「建议已被作废」的状态）。
      seedPushStateFromPersisted(persistedPushRaw, readHot());
      if (persistedPushRaw !== null) {
        // rev 与指纹的对齐已在上面 `seedPushStateFromPersisted` 一并做过（两格一起做）。
        const verdict = judgePersistedPush('startup', null);
        persistedPushVerdict = verdict;
        tracePersistedPush('read', 'startup', { present: true, suggestion: verdict.suggestion });
        if (verdict.action === 'restore') {
          trackSuggestion(verdict.sessionId, verdict.suggestion);
          tracePersistedPush('restored', 'startup', { suggestion: verdict.suggestion });
        } else if (verdict.reason === 'session-unavailable') {
          // 'session-unavailable' = 会话还没进店 ⇒ **判不了**（不是「判废」），留给该
          // 会话第一次 pull 补判。此刻既不恢复、也不清盘、更不推残留。留一行 'deferred'
          // 是因为「读到了却判不了」不能只靠那行 'read' 撑着——否则它在日志里看起来
          // 像「读到了、然后什么也没发生」。
          tracePersistedPush('deferred', 'startup', { reason: verdict.reason, suggestion: verdict.suggestion });
        } else {
          tracePersistedPush('skipped', 'startup', { reason: verdict.reason, suggestion: verdict.suggestion });
        }
      } else {
        tracePersistedPush('read', 'startup', { present: false });
      }
      // ⚠️ `_ops` 遗留补消费放在本段**之后**：遗留 `_ops` 里若带 pull op，它的应答要
      // 带上刚恢复的建议（顺序反了 ⇒ 应答里是空的，又把盘上那条盖掉）。
      lastOpsPayload = readOps();
      consumeOps(parseHotnessOps(lastOpsPayload), svc);
      // 热度恢复是异步的（storageDomain.open）：恢复完成后补推一次快照，修正
      // ⚠️ 这一次**必须绕开热度合并窗口**（`hotNow`）：它是**修正**用的（恢复前推出去的是
      // 不完整的表），把它再压一个窗口等于把修正推迟 —— task-16 判据 5。
      // 恢复窗口内已推送的不完整热度。目标会话取自追踪的建议会话。
      void persistence.whenReady.then(() => {
        if (settingsSvc === null) return;
        const id = lastSuggestionSession;
        if (id !== null) pushToClient(statePushOf(id), { hotNow: true });
      });
      // `_ops` 反向通道：client 经 `ctx.remote.settings.mutate(ns, ops)` 写入，
      // 内核改 volatile 引用并 emit `settings/document-updated(ns, revision)`。
      // 该事件只带 (ns, revision)，故每次都重读引用比对载荷。
      // **关键**：cordis 事件只向父级传播、不向子级传播。该事件 emit 在 settings
      // 服务的 ownerContext 上，插件自己的 ctx 收不到——必须监听 root。
      const eventCtx = (ctx as unknown as { root?: typeof ctx }).root ?? ctx;
      eventCtx.on('settings/document-updated', (ns: string, revision?: number) => {
        if (ns !== SUGGEST_GHOST_NAMESPACE) return;
        // 事件驱动失效：下一次 effective() 现读一次 describe()（风暴期间 N 次事件
        // 合并成 1 次读，见 live-settings.createLiveSettings 的失效语义）。
        liveSettings.invalidate();
        const payload = readOps();
        if (payload === lastOpsPayload) {
          return;
        }
        lastOpsPayload = payload;
        consumeOps(parseHotnessOps(payload), svc);
      });
    } catch (error) {
      ctx.logger.warn(`dsh-suggest-ghost: settings wiring failed: ${String(error)}`);
    }
  });

  // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
  // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
  // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
  // 扫描。环是会话日志的按需物化缓存：pull 时未命中就从日志现种（日志持久化，
  // apply 时必然已在内存），「播种时机」与竞态窗口一并消失；会话活跃期间由
  // session/event 增量维护。筛选语义与 client extractHistory 对齐：只收
  // source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复只计
  // 一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
  const historyRings = new Map<string, string[]>();
  /** 取会话历史环：缓存未命中且会话存活时从日志物化（幂等，每会话至多一次）。 */
  const ringFor = (sessionId: string): string[] | undefined => {
    const cached = historyRings.get(sessionId);
    if (cached !== undefined) return cached;
    const session = ctx.sessions.get(sessionId as SessionId);
    if (session === undefined) return undefined; // 会话不存在（已销毁）：无法回答
    const seed = seedRingFromLog(session);
    historyRings.set(sessionId, seed);
    return seed;
  };
  const ringPush = (sessionId: string, text: string): void => {
    // 先物化（未命中则从日志现种）：环是日志的缓存，绝不能凭空从单条文本起建
    // ——否则该会话的历史前缀会丢掉此前的所有轮次。
    const ring = ringFor(sessionId);
    if (ring === undefined) return; // 会话不存在（已销毁）：无环可维护
    appendToRing(ring, text);
  };

  /**
   * 每会话建议表（`sessionId -> 建议`），有界保留最近 {@link SUGGESTION_CACHE_CAP}
   * 个会话。
   *
   * **为什么不能是单槽。** 早先只用 `lastSuggestion` / `lastSuggestionSession` 两个
   * 变量存「最后一个产生建议的会话」，于是同时活跃的多个会话会互相覆盖：host 推的
   * `suggestionSessionId` 永远是最后结束回合的那个，client 端的会话归属守卫
   * （index.ts 的 `stale` 判据）就把其余会话的建议全部隐藏——表现为「插件没生效」。
   * 改为按会话索引后，pull 应答能取回**所问会话**自己的建议，多开互不干扰。
   *
   * 仍然保留「最近一次建议」作为跨会话兜底（见 {@link lastSuggestionOf}），供
   * 尚未 pull 的页面显示（切回时立即可见）。
   */
  const suggestionBySession = new Map<string, SuggestGhostSuggested>();
  /** 最近一次产出的建议及其会话（跨会话兜底用；勿用于判定本会话有效性）。 */
  let lastSuggestion: SuggestGhostSuggested | null = null;
  let lastSuggestionSession: string | null = null;

  /** 取某会话当前语义有效的建议（null = 无）。判据从「时间」换成「语义」：
   * 建议对应的回合是否仍是该会话最后一个已完成回合——不是就作废（防止
   * 重启后把旧回合的建议当新建议显示）。这是 `_push` 里建议状态的唯一
   * 权威来源：启动时从盘上回读、pull 时校验后重推，都走这里。
   */
  const currentSuggestionFor = (sessionId: string): SuggestGhostSuggested | null => {
    const session = ctx.sessions.get(sessionId as SessionId);
    // 本会话自己的建议优先；没有则回落到最近一次建议（仅当它正属于本会话）。
    const own = suggestionBySession.get(sessionId)
      ?? (lastSuggestionSession === sessionId ? lastSuggestion : null);
    if (own === null) return null;
    return suggestionIsCurrent(own, session) ? own : null;
  };

  /**
   * 跨会话兜底：最近一次产出的建议（可能属于别的会话，client 会按归属隐藏）。
   */
  const lastSuggestionOf = (): { suggestion: SuggestGhostSuggested | null; sessionId: string | null } =>
    lastSuggestion === null || lastSuggestionSession === null
      ? { suggestion: null, sessionId: null }
      : { suggestion: lastSuggestion, sessionId: lastSuggestionSession };

  /**
   * 更新追踪状态——建议的产出与作废只发生在生成路径，所以追踪也
   * 只在这里更新（载荷推送不改它，见 pushToClient）。
   */
  const trackSuggestion = (sessionId: string, suggestion: SuggestGhostSuggested | null): void => {
    if (suggestion === null) suggestionBySession.delete(sessionId);
    else {
      suggestionBySession.set(sessionId, suggestion);
      // 有界：超容量时逐出最久未更新的会话（Map 保持插入序）。
      while (suggestionBySession.size > SUGGESTION_CACHE_CAP) {
        const oldest = suggestionBySession.keys().next();
        if (oldest.done === true) break;
        suggestionBySession.delete(oldest.value);
      }
    }
    // 「最近一次」槽位保持原有语义：产出即占位；清空只在本会话时清。
    const next = nextTrackedSuggestion(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      suggestion,
    );
    lastSuggestion = next.suggestion;
    lastSuggestionSession = next.sessionId;
  };

  // —— 启动回读：把盘上残留的建议接回来（#50）——
  /**
   * 盘上残留的 `_push` 载荷原文（null = 盘上没有残留）。
   *
   * **为什么留原文而不是判定结果**：启动那一刻会话常常还没进店（宿主的持久化懒恢复
   * 未发生），判不了新旧；等该会话第一次 pull 时它一定在店了，那时再判（见
   * {@link restorePersistedPushForSession}）。
   */
  let persistedPushRaw: string | null = null;
  /**
   * 回读判定结果（null = 还没判）。`reason === 'session-unavailable'` 表示「判不了，
   * 留给 pull 补判」——其余 reason 都是终判，不再重判。
   */
  let persistedPushVerdict: PersistedPushVerdict | null = null;
  /** 已记过「会话不匹配」的会话（同一会话反复 pull 不重复刷同一条留痕）。 */
  const persistedMismatchLogged = new Set<string>();
  /** 「判不了」的留痕只打一次（避免每次 pull 都刷同一条）。 */
  let persistedDeferredTraced = false;

  /**
   * 启动回读的留痕（读 / 恢复 / 未恢复各一行）。
   *
   * **不打正文、不打可回推的标识**：只带 turn / baseSeq / 字符数与原因，够对上号又
   * 不会把建议内容抄进 tee 日志（同 `ops consumed: complete … draftChars=N` 的口径）；
   * 会话 id 是可回推的标识，这里**不写**。
   */
  const tracePersistedPush = (
    line: 'read' | 'restored' | 'skipped' | 'deferred',
    source: 'startup' | 'pull',
    detail: { present?: boolean; reason?: string; suggestion?: SuggestGhostSuggested | null },
  ): void => {
    const present = detail.present === undefined ? '' : ` present=${detail.present ? 1 : 0}`;
    const reason = detail.reason === undefined ? '' : ` reason=${detail.reason}`;
    const s = detail.suggestion ?? null;
    const turn = s === null ? 'n/a' : String(s.turn);
    const baseSeq = s === null ? 'n/a' : String(s.baseSeq);
    const chars = s === null ? 'n/a' : String(s.text.length);
    traceOps(`persisted push ${line} source=${source}${present}${reason} turn=${turn} baseSeq=${baseSeq} chars=${chars}`);
  };

  /**
   * 判定盘上残留的建议能不能恢复。**不恢复时绝不动盘**（不删不清不改）。
   *
   * @param source - 判定来源（留痕用）。
   * @param forSessionId - 只判这个会话的残留（pull 时用）：残留属于别的会话就不动它
   *   （那条对**它**的会话仍然有效，清掉才是把好数据弄丢）。
   */
  const judgePersistedPush = (
    source: 'startup' | 'pull',
    forSessionId: string | null,
  ): PersistedPushVerdict => {
    const raw = persistedPushRaw;
    if (raw === null) {
      return { action: 'skip', reason: 'no-persisted-payload', suggestion: null, sessionId: null };
    }
    const verdict = decidePersistedPush(raw, {
      sessionExists: (id) => ctx.sessions.get(id as SessionId) !== undefined,
      isCurrent: (suggestion, id) => suggestionIsCurrent(suggestion, ctx.sessions.get(id as SessionId)),
    });
    if (verdict.action === 'restore' && forSessionId !== null && verdict.sessionId !== forSessionId) {
      // 残留属于别的会话：不恢复、不动盘（它对那个会话仍然有效）。
      return {
        action: 'skip',
        reason: 'session-mismatch',
        suggestion: verdict.suggestion,
        sessionId: verdict.sessionId,
      };
    }
    return verdict;
  };

  /**
   * 该会话第一次 pull 时的**补判**：启动那一刻会话常常还没进店（懒恢复），判不了
   * 新旧；此刻 client 正在问这个会话，它一定在店了 ⇒ 现在判。
   *
   * **只在判出「可恢复」时动内存**；本会话已有更新的建议时**不**接回（旧残留盖掉
   * 更新的建议是这条语义最容易犯的错）；其余情况一律不动盘。
   */
  const restorePersistedPushForSession = (sessionId: string): void => {
    if (persistedPushRaw === null) return;
    // 启动期已经终判过 ⇒ 不再判（避免每次 pull 都重判同一条）。
    const startupVerdict = persistedPushVerdict;
    if (startupVerdict !== null && startupVerdict.reason !== 'session-unavailable') return;
    const verdict = judgePersistedPush('pull', sessionId);
    if (verdict.action === 'skip') {
      if (verdict.reason === 'session-unavailable') {
        // 还不判得了 → 留给下一次 pull。这条也留一行（与启动期同一措辞），否则
        // 「会话一直不进店」这件事在日志里完全不可见。
        if (!persistedDeferredTraced) {
          persistedDeferredTraced = true;
          tracePersistedPush('deferred', 'pull', { reason: verdict.reason, suggestion: verdict.suggestion });
        }
        return;
      }
      if (verdict.reason === 'session-mismatch') {
        // 残留属于别的会话：不动盘、也不改判定状态（它对那个会话仍然有效）。
        if (!persistedMismatchLogged.has(sessionId)) {
          persistedMismatchLogged.add(sessionId);
          tracePersistedPush('skipped', 'pull', { reason: verdict.reason, suggestion: verdict.suggestion });
        }
        return;
      }
      persistedPushVerdict = verdict;
      tracePersistedPush('skipped', 'pull', { reason: verdict.reason, suggestion: verdict.suggestion });
      return;
    }
    // 可恢复，但**本会话已有更新的建议时不得接回**（旧残留不得盖掉更新的建议）。
    if (suggestionBySession.has(sessionId)) {
      persistedPushVerdict = {
        action: 'skip',
        reason: 'superseded',
        suggestion: verdict.suggestion,
        sessionId: verdict.sessionId,
      };
      tracePersistedPush('skipped', 'pull', { reason: 'superseded', suggestion: verdict.suggestion });
      return;
    }
    trackSuggestion(sessionId, verdict.suggestion);
    persistedPushVerdict = verdict;
    tracePersistedPush('restored', 'pull', { suggestion: verdict.suggestion });
  };

  // —— 停顿续写状态 ——
  /** 续写结果缓存：sessionId → {draft, text}；LRU 上限 16。 */
  const COMPLETION_CACHE_CAP = 16;
  const completionCache = new Map<string, { draft: string; text: string }>();
  /**
   * 全局最近一次续写（含所属会话）。`_push` 是单槽 last-wins 通道：续写载荷
   * 只出现一瞬间，随后其他会话的 pull 应答就会覆盖掉它——客户端 describe 是
   * 快照式读取，几乎必然错过。故 host 在此追踪最近续写，**所有**后续推送一律
   * 捎带；客户端按 completionSessionId + draft 全等自行过滤。
   */
  let lastCompletion: { sessionId: string; completion: { draft: string; text: string } } | null = null;
  /** 在途续写生成：sessionId → AbortController（单飞：同会话只保留最新一次）。 */
  const completionPending = new Map<string, AbortController>();

  const cacheCompletion = (sessionId: string, draft: string, text: string): void => {
    completionCache.delete(sessionId);
    completionCache.set(sessionId, { draft, text });
    lastCompletion = { sessionId, completion: { draft, text } };
    while (completionCache.size > COMPLETION_CACHE_CAP) {
      const oldest = completionCache.keys().next();
      if (oldest.done === true) break;
      completionCache.delete(oldest.value);
    }
  };

  /**
   * 为指定会话的当前草稿生成行内续写（停顿续写）。
   *
   * 与 handleTurnEnd 的关键差异：
   * 1. 输入是草稿文本而非回合边界
   * 2. 单飞：同会话只保留最新一次生成（新草稿到达时中止旧生成）
   * 3. 失败**不再**静默：每条出口都经 `completion-gate` 判定并留痕（续写是锦上添花，
   *    留痕走节流通道，不打扰用户，但绝不打扰到「查不到」）
   * 4. 缓存命中时直接重推（同 sessionId+draft 的缓存结果）
   *
   * 本函数只负责**接线**：读实时配置、取会话、发起有界生成、把判定结果落成留痕。
   * 「哪些分支会什么都不产出、各自该用什么 kind、多久报一次、报文能含什么」全部在
   * `src/completion-gate.ts` 里，那里是纯函数，`scripts/completion-pipeline-smoke.mjs`
   * 能在 node 里逐条断言——历史上的事故恰恰是这些判定散落在 async 闭包里，
   * 离线测不到，于是五个静默 `return` 一起把故障藏了整场。
   */
  const handleComplete = (sessionId: string, draft: string): void => {
    const cfg = effective();
    const session = ctx.sessions.get(sessionId as SessionId);
    // 报文里上报的是**未 trim** 的长度，与既有 `ops consumed: complete … draftChars=N`
    // 同口径（同一份草稿的两行要能对上号）；判定用的是 trim 后的长度，两者分开命名。
    // 无论哪个都不含正文（见 completion-gate 的隐私约束）。
    const draftChars = draft.length;
    const entry = decideCompletionEntry({
      inlineEnabled: cfg.inlineEnabled !== false,
      trimmedChars: draft.trim().length,
      inlineMinChars: cfg.inlineMinChars,
      sessionExists: session !== undefined,
    });
    // 入口三条出口的留痕通道。settle 段（被抢先 / 中止 / 超时 / 失败）的留痕在
    // `startBoundedCompletion` 内部走同一个 `traceFault`——它就是下面注入的 `deps.trace`。
    const traceEntryExit = (decision: Exclude<CompletionGateDecision, { action: 'proceed' }>): void => {
      if (decision.action === 'trace') {
        traceFault(
          decision.kind,
          completionFaultMessage(decision.reason, {
            sessionId,
            draftChars,
            inlineMinChars: cfg.inlineMinChars,
          }),
          decision.every,
        );
        return;
      }
      // `skip` 在入口段不可达（`decideCompletionEntry` 从不返回它，冒烟按整个入口输入
      // 空间枚举断言过这条）。真走到这里只可能是接线漂移，那就报一条**新**的异常串，
      // 而不是把它变成第六个静默出口——本次故障的教训正是「不可达」三个字撑不起取证。
      traceFault('completion-gate-drift', `completion gate returned skip at entry (session=${sessionId} draftChars=${draftChars})`, 1);
    };
    if (entry.action !== 'proceed') {
      // 出口 1/2/3：每一条都留痕之后再 return，不存在「什么都不打就返回」的入口分支。
      traceEntryExit(entry);
      return;
    }
    if (session === undefined) {
      // 只为类型收窄（纯函数 gate 不认识 Session 对象）；同一条判据已由上面的
      // `session-missing` 留痕，这里不可能静默走到。
      return;
    }
    // 缓存命中：同 sessionId+draft → 直接重推。这不是出口——它照样产出幽灵。
    const cached = completionCache.get(sessionId);
    if (cached !== undefined && cached.draft === draft) {
      pushToClient({
        ...statePushOf(sessionId),
        completion: cached,
        completionSessionId: sessionId,
      });
      return;
    }
    // 单飞：中止同会话的在途生成。被中止的那一次随后会在它自己的收口里落到
    // `superseded` / `aborted` 出口，各自留痕（不再静默）。
    const existing = completionPending.get(sessionId);
    if (existing !== undefined) existing.abort();
    const controller = new AbortController();
    completionPending.set(sessionId, controller);
    // 生成 + 有界超时 + 每一种收口的留痕，全在 `startBoundedCompletion` 里（纯模块，
    // 冒烟可逐条断言）。这里只注入三件事：pending 槽的归属、留痕通道、交付动作。
    startBoundedCompletion<CompletionValue>(
      {
        pending: completionPending,
        trace: traceFault,
        // 显式把上界传在这里，而不是靠模块默认值：现场读 `handleComplete` 就该看见
        // 「这条链有界、界是常量 COMPLETION_DEADLINE_MS」这件事。
        deadlineMs: COMPLETION_DEADLINE_MS,
        deliver: ({ value, elapsedMs }) => {
          // 增量画像（#39）。既有前缀与既有键**一个字不动**（package.json 的
          // sandbox.greps 与 scripts/dev-sandbox.mjs 靠它们抓行），新键一律**行尾追加**。
          const stream = formatStreamMetrics(value.metrics);
          if (value.text === undefined) {
            // 空/不合格：过去是 `return` 静默，于是「宿主生成了但被净化链丢弃」与
            // 「根本没生成」在观测上完全同形（#17 的教训正在这一支上被重新违反）。
            // outcome= 把这两种终于分开（empty → 看提示词/档位；filtered → 看净化链）。
            traceOps(`completion dropped (empty or filtered) session=${sessionId} draftChars=${draftChars} in ${elapsedMs}ms ${stream} at=${Date.now()}`);
            return;
          }
          cacheCompletion(sessionId, draft, value.text);
          pushToClient({
            ...statePushOf(sessionId),
            completion: { draft, text: value.text },
            completionSessionId: sessionId,
          });
          // 只打字符数：续写正文是模型对用户草稿的模仿，抄进 tee 日志等于把用户输入的第二份副本落到盘上。
          traceOps(`completion generated session=${sessionId} draftChars=${draftChars} chars=${value.text.length} in ${elapsedMs}ms ${stream} at=${Date.now()}`);
        },
      },
      {
        sessionId,
        controller,
        startedAt: Date.now(),
        draftChars,
        // 用融合后的信号：上游抢占/卸载中止与墙钟上界都能传到底层请求。
        generate: (signal) => generateCompletion(
          ctx,
          cfg,
          session,
          draft,
          signal,
          clientUiLocale || undefined,
          cfg.languageMode,
          cfg.uiLocaleWeight,
        ),
      },
    );
  };


  /** 推给 client 的 `_push` 载荷（结构化形态；写盘前序列化）。 */
  interface ClientPush {
    /** 最新 LLM 建议；null = 清空当前建议。 */
    readonly suggestion: SuggestGhostSuggested | null;
    /** 建议所属会话（client 据此只在同会话显示建议）。 */
    readonly suggestionSessionId: string | null;
    /** 跨会话热度快照。 */
    readonly hot: readonly SuggestGhostHotEntry[] | null;
    /** 热表总条目数（管理面板「共 N 条」展示；快照只是 top-K）。 */
    readonly total: number;
    /** 历史环推送：最近用户消息文本（时间序）；null = 不携带（保留 client 现值）。 */
    readonly history: readonly string[] | null;
    /** history 所属会话；null 同步 history 为 null。 */
    readonly historySessionId: string | null;
    /** 行内续写：null = 清空当前续写；undefined = 不携带（保留 client 现值）。 */
    readonly completion?: { readonly draft: string; readonly text: string; readonly final?: boolean } | null;
    /** completion 所属会话（归属守卫：切会话时清掉上一个会话的续写）。 */
    readonly completionSessionId?: string | null;
    /** 本次生成失败的摘要（可诊断；成功/无错误时缺省）。 */
    readonly error?: string;
  }

  /**
   * **一格一把指纹**（#36 建议 2 的实现要点，也是第 1 条收益的唯一开关）。
   *
   * 拆了两格却只算一道整体指纹的话：热度一变整体指纹就变 ⇒ 客户端照样重解析、照样重跑
   * `computeGhostContent` ⇒ 收益 1 根本没发生，而 `bytes=` 还会下降 ⇒ 数据看着像成功。
   * 所以三件事分开算、分开用：
   *  - `fingerprintOfPush`：建议格 ⇒ 决定要不要写 `_push`，也是客户端「要不要重算建议幽灵」的依据；
   *  - `fingerprintOfHot`：热度格 ⇒ 决定要不要写 `_hot`；
   *  - 两格都脏 ⇒ 同一次 flush **合并成一次** `settings.update`（piggyback，见 `flushPush`）。
   *
   * 两个 sig 函数都吃**将要序列化的载荷对象**而不是 `ClientPush`：这样「内存里算的」与
   * 「盘上那份算的」走同一段代码。#50 的「第一次 pull 零写」成立的前提就是这个同口径，
   * 拆成两格之后必须**两格都**继续成立。
   */
  type PushSig = {
    readonly suggestion: {
      readonly turn: number;
      /** 归因用（不进指纹：它不参与「这条建议要不要重写」的判定）。 */
      readonly baseSeq: number;
      readonly text: string;
      readonly truncated: boolean;
      readonly acceptKey: string;
      readonly frame?: number;
      readonly final?: boolean;
    } | null;
    readonly suggestionSessionId: string | null;
    readonly completion?: { readonly draft: string; readonly text: string; readonly final?: boolean } | null;
    readonly completionSessionId?: string | null;
    readonly error?: string;
  };
  type HotSig = {
    readonly hot: readonly { text: string; count: number; pinned?: boolean }[] | null;
    readonly total: number;
    readonly history?: readonly string[];
    readonly historySessionId?: string | null;
  };

  const pushSigOf = (o: PushSig): string => {
    const sug = o.suggestion === null
      ? '∅'
      : `${o.suggestion.turn}:${o.suggestion.text}:${o.suggestion.truncated}:${o.suggestion.acceptKey}`;
    const completionKey = o.completion === null
      ? '∅'
      : o.completion === undefined
        ? '∄' // 未携带（保留 client 现值）
        : `${o.completionSessionId ?? ''}#${o.completion.draft}=${o.completion.text}`;
    return `${sug}<CPL>${completionKey}<ERR>${o.error ?? ''}`;
  };

  const hotSigOf = (o: HotSig): string => {
    const hotKey = o.hot === null || o.hot.length === 0
      ? '∅'
      : o.hot.map(h => `${h.text}×${h.count}${h.pinned === true ? '!p' : ''}`).join('|');
    const historyKey = o.history === undefined || o.history === null || o.history.length === 0
      || o.historySessionId === null || o.historySessionId === undefined
      ? '∅'
      : `${o.historySessionId}#${o.history.length}:${o.history[o.history.length - 1] ?? ''}`;
    return `<HOT>${hotKey}<T>${o.total}<HIST>${historyKey}`;
  };

  /** 建议格的载荷（建议 / 续写 / 错误；热度与环在 `_hot` 那一格）。 */
  const buildPushPayload = (p: ClientPush, rev: number): PushSig & { readonly rev: number } => ({
    rev,
    suggestion: p.suggestion === null ? null : {
      turn: p.suggestion.turn,
      baseSeq: p.suggestion.baseSeq,
      text: p.suggestion.text,
      truncated: p.suggestion.truncated,
      acceptKey: p.suggestion.acceptKey,
      // 帧语义（#39 契约）：**这一层是载荷的唯一出口**，所以缺省在这里补齐，
      // 而不是让每个重建建议的地方（生成、重启对账、投影）都必须记得带。
      // `?? 1`/`?? true` 的落点是「旧载荷回读」：本期宿主一次生成只出终帧，
      // 盘上那一份必然是第 1 帧且是终帧。客户端的兜底是 frame=0/final=true，
      // 所以这里补 1 之后，重启前后推出去的帧号是同一个值（不会因为重启而倒退）。
      frame: p.suggestion.frame ?? 1,
      final: p.suggestion.final ?? true,
    },
    suggestionSessionId: p.suggestionSessionId,
    ...(p.completion === null
      ? { completion: null, completionSessionId: null }
      : p.completion !== undefined
        // 续写载荷**只带 final、不带 frame**：一次续写的「代次」只能靠 draft 全等
        // 判定（#33 之后草稿允许继续变长，帧号会把「同一代次 grew」误判成换代）。
        ? {
          completion: { draft: p.completion.draft, text: p.completion.text, final: true },
          completionSessionId: p.completionSessionId ?? null,
        }
        : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
  });

  /** 热度格的载荷（热度快照 / 总数 / 历史环）。 */
  const buildHotPayload = (p: ClientPush, rev: number): HotSig & { readonly rev: number } => ({
    rev,
    hot: p.hot !== null && p.hot.length > 0 ? [...p.hot] : null,
    total: p.total,
    ...(p.history !== null && p.historySessionId !== null
      ? { history: [...p.history], historySessionId: p.historySessionId }
      : {}),
  });

  /**
   * rev 不参与指纹：它每写一次就 +1，进指纹就成了「每次都不一样」，判重立刻失效。
   * 指纹认的是**内容**，rev 只是给 client 的排序/诊断标识。
   */
  const fingerprintOfPush = (p: ClientPush): string => pushSigOf(buildPushPayload(p, 0));
  const fingerprintOfHot = (p: ClientPush): string => hotSigOf(buildHotPayload(p, 0));

  /**
   * 把盘上残留的**建议格**折成 `PushSig` 算指纹（盘上内容不可信 ⇒ 逐字段类型收窄，
   * 与 `parsePersistedPush` 同一理由）。
   * @returns 指纹；载荷结构不合法时 null（⇒ 不并入判重，让第一次 push 照常写）。
   */
  const pushFingerprintOfPersisted = (payload: Record<string, unknown>): string | null => {
    const rawSuggestion = payload.suggestion;
    let suggestion: PushSig['suggestion'] = null;
    if (typeof rawSuggestion === 'object' && rawSuggestion !== null) {
      const s = rawSuggestion as Record<string, unknown>;
      if (typeof s.turn === 'number'
        && typeof s.baseSeq === 'number'
        && typeof s.text === 'string'
        && typeof s.truncated === 'boolean'
        && typeof s.acceptKey === 'string') {
        suggestion = {
          turn: s.turn,
          baseSeq: s.baseSeq,
          text: s.text,
          truncated: s.truncated,
          acceptKey: s.acceptKey,
          ...(typeof s.frame === 'number' ? { frame: s.frame } : {}),
          ...(typeof s.final === 'boolean' ? { final: s.final } : {}),
        };
      }
    }
    const completion = (() => {
      const c = payload.completion;
      if (c === null) return null;
      if (typeof c !== 'object' || c === null) return undefined;
      const row = c as { draft?: unknown; text?: unknown };
      if (typeof row.draft !== 'string' || typeof row.text !== 'string') return undefined;
      return { draft: row.draft, text: row.text };
    })();
    return pushSigOf({
      suggestion,
      suggestionSessionId: typeof payload.suggestionSessionId === 'string' ? payload.suggestionSessionId : null,
      ...(completion === undefined ? {} : { completion }),
      completionSessionId: typeof payload.completionSessionId === 'string' ? payload.completionSessionId : null,
      ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
    });
  };

  /**
   * 把盘上残留的**热度格**折成 `HotSig` 算指纹。
   *
   * 这一格不需要「恢复」任何东西（热表由 storageDomain 自己恢复、历史环由会话日志
   * 物化），读它**只为了对齐指纹**：不对齐的话，第一次 pull 会把同一份内容再写一遍
   * （内容一样、rev 顶一格），#50 刚立的「第一次 pull 零写」就从这一格漏掉。
   */
  const hotFingerprintOfPersisted = (payload: Record<string, unknown>): string | null => {
    const hot = Array.isArray(payload.hot)
      ? payload.hot.filter((entry): entry is { text: string; count: number; pinned?: boolean } =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as { text?: unknown }).text === 'string'
        && typeof (entry as { count?: unknown }).count === 'number')
      : null;
    const history = Array.isArray(payload.history)
      ? payload.history.filter((text): text is string => typeof text === 'string')
      : undefined;
    return hotSigOf({
      hot,
      total: typeof payload.total === 'number' ? payload.total : 0,
      ...(history === undefined ? {} : { history }),
      historySessionId: typeof payload.historySessionId === 'string' ? payload.historySessionId : null,
    });
  };

  /**
   * 把「盘上残留那两格」的 rev 与指纹并进本进程的推送状态。
   *
   * **为什么要并**：回读恢复之后，本进程内存里的状态与盘上那份**是同一件事**。
   *  - rev：盘上那份的 rev 更大 ⇒ 下一笔写必须比它大（rev 是单调序号，回退会让
   *    client 侧的「旧载荷丢弃」判据失灵）。
   *  - 指纹：并进去之后，第一次 pull 若算出的状态与盘上那份**一致**就**不写**
   *    （否则同一件事被写两遍：内容一样、rev 却顶上去一格）。
   *
   * **拆成两格之后这条性质必须两格都成立**，所以两格各自 seed：漏一格，那一格就会在
   * 第一次 pull 时多写一次——而多写的仍然是**一整档 profile 重写**，不是「多写一点字节」。
   * @param pushRaw - 盘上 `_push` 原文（null = 没有）。
   * @param hotRaw - 盘上 `_hot` 原文（null = 没有；旧版本从没写过这一格）。
   */
  const seedPushStateFromPersisted = (pushRaw: string | null, hotRaw: string | null): void => {
    const parse = (raw: string | null): Record<string, unknown> | null => {
      if (raw === null || raw === '' || raw === 'null') return null;
      try {
        const value: unknown = JSON.parse(raw);
        return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
      } catch {
        return null;
      }
    };
    const pushPayload = parse(pushRaw);
    if (pushPayload !== null) {
      const rev = pushPayload.rev;
      if (typeof rev === 'number' && Number.isInteger(rev) && rev > pushRev) pushRev = rev;
      const fp = pushFingerprintOfPersisted(pushPayload);
      if (fp !== null) lastPushFingerprint = fp;
    }
    const hotPayload = parse(hotRaw);
    if (hotPayload !== null) {
      const rev = hotPayload.rev;
      if (typeof rev === 'number' && Number.isInteger(rev) && rev > hotRev) hotRev = rev;
      const fp = hotFingerprintOfPersisted(hotPayload);
      if (fp !== null) lastHotFingerprint = fp;
    }
  };
  /**
   * 经 `_push` volatile 字段把最新建议+热度+历史推给 client。
   *
   * 0.1.7 里字段载体从 `SettingsScope` 换成 `SettingsForms` 的 volatile 配置
   * 字段（`ctx.settings.update(ns, patch)`），**载荷结构不变**，故 client 侧的
   * 解析与 `*SessionId` 归属守卫都无需改动。
   *
   * 幂等优化：payload 与上次完全一致时直接跳过——避免重复写 + client 端
   * JSON 解析/重渲染。`history: null` 表示本次推送不携带历史（client 保留
   * 现值）——pull/turn-end 想更新历史时才携带。
   *
   * 尾写合并：`settings.update` 是异步的；同一时刻连续多次 push 会排成多次
   * 顺序写入。这里把最新载荷挂起，在途写入完成后只补写**最新一份**。
   */
  let pushRev = 0;
  let lastPushFingerprint: string | null = null;
  /** 热度格的序号与「上一次已生效」指纹（#36 建议 2）。与建议格各自独立判重。 */
  let hotRev = 0;
  let lastHotFingerprint: string | null = null;
  let pushInFlight: Promise<void> | null = null;
  /**
   * 补写泵自己在途的那笔写（`drainDeferred` 发起）。
   *
   * **为什么要单独记一笔**：三类写（补写泵的写、即时写的 `_push`、消费后的 `_ops`
   * 清空）落的是**同一个 profile 文件**，内核在 `dsh-config-editor/lib/index.js:72`
   * 用 `withFileLock(profileDir/package.json, …)` 把它们串起来，而那个锁的等待上限是
   * `DEFAULT_LOCK_WAIT_MS = 2e3`（`dsh-atomic-write/lib/index.js:164`）——**到点报错
   * 而不是无限排队**。所以「本仓自己的两笔写撞上」就是
   * `atomic-write: timed out waiting for the writer lock` 的来源之一（复核评论 #36
   * `issuecomment-37810` 实测：事务外写一轮 191~332ms、首笔 2.2~2.5s ⇒ 补写落在
   * 即时写窗口内的概率不低）。
   *
   * 三类写必须**互斥**：谁先谁后由「前台让后台」定（续写是用户等的东西，补写是后台
   * 任务），但**绝不能**同时抢锁。
   */
  let deferredWriteInFlight: Promise<void> | null = null;
  /** 消费后 `_ops` 清空那笔写（在途）。同一把锁，同样互斥。 */
  let opsClearInFlight: Promise<void> | null = null;
  /** 有即时载荷在等锁落地（补写/清空占着锁时，即时写不抢锁，等它落地再写）。 */
  let pushWaitingForWrite = false;
  /** 此刻这把 profile 锁上有没有写（在途）。 */
  const anyWriteInFlight = (): boolean =>
    pushInFlight !== null || deferredWriteInFlight !== null || opsClearInFlight !== null;
  let pendingPushPayload: string | null = null;
  /**
   * 待写载荷对应的指纹。必须与载荷**成对**挂在缓冲上：在途写期间又排进来新载荷时，
   * `lastPushFingerprint` 已经是最新那一份的指纹，拿它当「被拒这份」的指纹会让补写
   * 判定把一份仍是最新的载荷误判成「已被取代」（见 `decidePushDrain` 的 superseded）。
   */
  let pendingPushFingerprint: string | null = null;
  /** 待写载荷里是否带续写（#15/#18 的验收对象；节流必须绕不过它）。 */
  let pendingCarriesCompletion = false;
  /** 热度格的待写载荷与指纹（与建议格同 lifecyle：在途写完前挂在槽里，最新一份覆盖旧的）。 */
  let pendingHotPayload: string | null = null;
  let pendingHotFingerprint: string | null = null;
  /**
   * 热度格「被拒 → 由事务外 pump 补写」的已尝试次数（上限 {@link HOT_DRAIN_MAX_ATTEMPTS}）。
   *
   * **这个计数器是 2026-10-22 那次事故的护栏**：热度格被 HMR 事务拒绝之后，若在
   * `.finally` 里立刻再 flush，就退化成「失败 → 重排 → 再写」的微任务紧循环——它
   * 永远不把控制权交还给事件循环（timer / I/O 全饿死），而每一圈还打一行
   * `hot write refused`，实测把 tee 日志刷到 23 GB。所以热度格的补写只能落在
   * **事务外锚点**（`drainDeferred`，apply() 期建立的 `setInterval`）上，且必须有界：
   * 到点丢弃并放开指纹，由下一次状态推送重建一份当前快照。
   */
  let hotDrainAttempts = 0;
  /**
   * 上一次热度格**写出去**的时刻（null = 从未写过 ⇒ 下一次立刻写）。
   *
   * 计时起点取「上一次写」而不是「第一次待写」，两个都有代价，取前者是因为它不会饥饿：
   * 若取后者且不断顺延，用户持续打字就把写永远推后。取「上次写」则窗口是固定刻度，
   * 每窗至多一次写，陈旧度有硬上界（≤ 窗口 + 一个泵间隔）。
   */
  let hotWindowOpenedAt: number | null = null;
  /** 本窗口内被合并掉的热度变化次数（落地时打 `coalesced=` 并归零）。 */
  let hotCoalesced = 0;
  /** 热度格写出去了：开一个新窗口（计时起点 = 此刻），归零合并计数。 */
  const armHotWindow = (): void => {
    hotWindowOpenedAt = Date.now();
    hotCoalesced = 0;
  };

  /**
   * 被拒时的处置：清空计时起点，让留在槽里的快照由泵按 #47 的**有界**重试立刻补。
   * 窗口是给「省无谓重写」用的，不该变成「把没写成功的东西再扣一会儿」。
   */
  const disarmHotWindow = (): void => {
    hotWindowOpenedAt = null;
  };
  /**
   * 最近一次**成功落盘**的 `_push` 载荷原文（不是指纹：指纹不区分「同一份字节写过」）。
   * 补写前比一下，同一份字节已在盘上就不要再推一次 revision。
   */
  let lastLandedPushPayload: string | null = null;
  /** 同上，热度格那份（补写前比字节，同一份内容不重复推一格）。 */
  let lastLandedHotPayload: string | null = null;
  /** 被事务拒绝的写入的待补写队列（排水锚点见 `deferredPump` 那段注释）。 */
  const deferred = new DeferredWriteQueue();
  /**
   * 补写泵「等在途写落地」的起始时刻（null = 没在等）。
   *
   * 这是互斥的**可观测面**：没有它，一次「补写迟迟不落地」只能靠猜（是队列空？是判定
   * 跳过？还是在等锁？）。留痕只带时长、不带任何载荷内容（口径同
   * `src/completion-gate.ts` 的节流表：按 kind 分桶、第一条必报、之后每 N 次一条带
   * 计数）。
   */
  let deferredWaitSince: number | null = null;
  /** 本次推送进入合并缓冲的时刻（被拒留痕里算出等待时长）。 */
  let pushStartedAt = 0;
  const pushToClient = (p: ClientPush, opts: { hotNow?: boolean } = {}): void => {
    if (settingsSvc === null) return;
    // **让路必须在入口生效**，不能只在 `hotDirty` 分支里做：第一版就是这样，于是
    // 「两格都没变 + 槽里还压着一份合并中的热度」这条路径（pull 恰好是最常见的触发者）
    // 只调了 flushPush，而 flushPush 仍按未解除的窗口判定「还没到期」⇒ 不带热度格，
    // pull 让路形同不存在（冒烟 3b 实测：pull 之后两笔写都只带 `_ops`）。
    if (opts.hotNow) hotWindowOpenedAt = null;
    // 本次推送进入合并缓冲的时刻：**只给被拒留痕的 `after=` 用**。必须放在函数最前面
    // （包括 no-dirty 早退分支之前）：那条分支也会借机重试槽里的热度载荷，被拒时同样要
    // 报「本次入口到失败」的时长。2026-10-22 之前的拆分重构把这条赋值整个弄丢了，日志里
    // 出现过 `after=1792631248119ms`（从 epoch 起算），等于这个字段没有信息量。
    pushStartedAt = Date.now();
    // **一格一判据**：两格分别算指纹、分别决定要不要写。整体判重（旧做法）会让
    // 「只有热度变了」也写成一次携带建议格的载荷，客户端也就无从跳过建议那一段的重算。
    const fpPush = fingerprintOfPush(p);
    const fpHot = fingerprintOfHot(p);
    const pushDirty = fpPush !== lastPushFingerprint;
    const hotDirty = fpHot !== lastHotFingerprint;
    if (!pushDirty && !hotDirty) {
      // 两格都没变 ⇒ 一次写都不发（这条判据是「任一格未变时不触发写」的另一半，
      // 有断言钉着）。但**槽里可能还压着一份上次没写进去的热度载荷**（被拒时留在
      // 槽里，由事务外 pump 补写，见 `drainDeferred` 的热度格分支）：借任何一次推送
      // 入口补一次落地，事件驱动、不引入空转定时器。
      if (pendingHotPayload !== null) flushPush();
      return;
    }
    // 注意：这里**不**改 lastSuggestion/lastSuggestionSession。载荷里的
    // `suggestion: null` 有两种含义——「本会话没有建议」（如 pull 一个没有建议
    // 的会话）与「建议被作废」。若在这里按载荷清空追踪状态，pull 一次别的会话
    // 就会把仍在有效期的那条建议弄丢。追踪状态只在真正产出/作废建议的地方更新
    // （handleTurnEnd 的生成结果与启动对账）。
    if (pushDirty) {
      lastPushFingerprint = fpPush;
      pushRev += 1;
      pendingPushPayload = JSON.stringify(buildPushPayload(p, pushRev));
      pendingPushFingerprint = fpPush;
      // 判据取入参 p，不取序列化后的 payload：payload 的类型是条件展开出来的联合，
      // 有一支根本没有 completion 键。null = 显式作废，不是「带续写」；
      // 只有真带文本的那次才值得不节流地告警。
      pendingCarriesCompletion = p.completion !== undefined && p.completion !== null;
    }
    if (hotDirty) {
      lastHotFingerprint = fpHot;
      hotRev += 1;
      pendingHotPayload = JSON.stringify(buildHotPayload(p, hotRev));
      pendingHotFingerprint = fpHot;
      // 新载荷取代旧的：补写预算从头计（旧载荷的失败次数不该吃掉新载荷的机会）。
      hotDrainAttempts = 0;
      // **task-16 的窗口**：纯热度变化按窗口合并，避免「每次用户输入一次整档重写」。
      // 三条硬规则（判据来自 task-16，写在这里是为了让下一个改这段的人看见理由）：
      //  1. **建议格永不被这里拖慢**：合并只等于「这一轮不带走热度格」，绝不等于推迟写；
      //  2. `hotNow`（pull 应答 / 热表恢复补推 / 卸载前强刷）**绕开窗口**：切会话时
      //     「先旧后新」比滞后更难看，而恢复补推本身就是修正；
      //  3. 计时起点是**窗口开启时刻**而不是「上一次写时刻」，否则连续打字会把写永远推后
      //     （饥饿），见 `deferred-writes.ts` 的 `decideHotPush`。
      if (decideHotPush(Date.now(), hotWindowOpenedAt).action === 'defer') {
        // ⚠️ 这里**不能 return**。第一版就是 return：那句把同一拍里**建议格**的写一起推迟了，
        // 而「建议格永不被热度窗口拖慢」是 task-16 的硬规则。合并的正确表达是「这一轮
        // 不取热度槽」（见 flushPush），不是「这一轮不写」。
        hotCoalesced += 1;
        traceFault(
          'hot-coalesce',
          `hot push coalesced pending=1 heldMs=${Date.now() - (hotWindowOpenedAt ?? Date.now())} windowMs=${HOT_PUSH_WINDOW_MS}`,
          20,
        );
      }
    }
    flushPush();
  };
    /**
   * 尾写合并 + **两格合并成一次写**（piggyback）。
   *
   * 为什么合并（理由不是「省一次整档重写」，那是不成立的旧口径）：
   *  - **尾延迟**：probe-hmr 第二次复核（沙箱、#50 修复后的产物）量到补写泵**不排队**——
   *    泵在事务外，每 500ms 无脑调一次 `update()`，前一笔在途时不 await、不延后，锁串行
   *    发生在内核 `withFileLock` 内部而不是这里（事务外单独写一笔 191~332ms）。
   *    所以「各写各的」最坏是**多等一个 500ms tick**，不是「一次整档重写变两次」。
   *    本函数原来的注释写的是后者，那句是错的，已按实测改掉。
   *  - 真正省下的是**客户端一次重解析**：一次 `describe()` 回来就是两格的完整当前状态，
   *    两格各写 ⇒ 客户端被叫醒两次，第二次里热度格是新的、建议格是旧的。
   *  - 写次数仍然要报：每回合一次写（4 回合 = 4 次写）是后续「要不要给 `_hot` 加节流」
   *    的输入，节流会引入客户端热度陈旧窗口，属产品取舍，不在本 PR 决定。
   *
   * ⚠️ 合并**只发生在即时写这一条路上**。补写泵（`drainDeferred`）的那一笔永远只带
   * 一格：它的 CAS/判重（`decidePushDrain`）只认 `_push` 那一份字节，一旦让它带两格，
   * 「push 判定跳过」就会把顺带的 `_hot` 一起静默丢掉，而内核没有回滚半笔写的概念。
   * 钉在 `scripts/payload-split-smoke.mjs` 的「补写永远单格」断言上。
   */
  const flushPush = (): void => {
    if (settingsSvc === null || pushInFlight !== null) return;
    // **互斥（另一半方向）**：补写泵或 `_ops` 清空正占着同一把 profile 锁时，即时写
    // 不抢锁，等它落地再写。抢锁的后果不是「慢一点」，而是
    // `atomic-write: timed out waiting for the writer lock`（2s 硬上限，调用方改不了）
    // ⇒ 那一次载荷直接丢。等待期间载荷一直挂在 pending 槽上（没被取走），
    // 所以等锁不会丢载荷，也不会丢指纹。
    if (deferredWriteInFlight !== null || opsClearInFlight !== null) {
      pushWaitingForWrite = true;
      return;
    }
    const payload = pendingPushPayload;
    const fingerprint = pendingPushFingerprint;
    const carriesCompletion = pendingCarriesCompletion;
    // **窗口在这一处生效**（不是在 pushToClient 里 return）：「不写热度」表达成
    // 「这一轮不取热度槽」，建议格该怎么写还怎么写 —— 这就是判据 1 的落点。
    const hotDue = pendingHotPayload !== null
      && decideHotPush(Date.now(), hotWindowOpenedAt).action === 'write';
    const hotPayload = hotDue ? pendingHotPayload : null;
    const hotFingerprint = hotDue ? pendingHotFingerprint : null;
    const hotCoalescedNow = hotCoalesced;
    pendingPushPayload = null;
    pendingPushFingerprint = null;
    pendingCarriesCompletion = false;
    if (hotDue) {
      pendingHotPayload = null;
      pendingHotFingerprint = null;
    }
    if (payload === null && hotPayload === null) return;
    const rev = pushRev;
    const hotRevNow = hotRev;
    const patch: Record<string, string> = {};
    if (payload !== null) patch._push = payload;
    if (hotPayload !== null) patch._hot = hotPayload;
    // 写实耗（#39 的尾延迟分解）。量在 `settings.update` 这一对上，不是量在「进入
    // pushToClient」那一对上：后者会把合并缓冲的排队也算进来，就分不出
    // 「等泵」与「写本身」——而这两个数决定的是完全不同的两件事（降泵间隔 vs 换通道）。
    const writeStartedAt = Date.now();
    pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, patch)
      .then(
        () => {
          // 成功也要留痕：#15/#18 的验收判据是「这份载荷到底落盘了没有」。历史数据里
          // 这条通道只留下 372 次 nested-transaction 拒绝、**一次成功都没记过**，
          // 于是「从没写」和「写了就失败」在日志里长得一模一样。
          if (payload !== null) lastLandedPushPayload = payload;
          if (hotPayload !== null) {
            lastLandedHotPayload = hotPayload;
            // 即时写成功了：热度格补写预算归零（失败重试路径可能已经计过数）。
            hotDrainAttempts = 0;
            armHotWindow();
          }
          const writeMs = Date.now() - writeStartedAt;
          const at = Date.now();
          if (payload !== null) {
            // 既有键（rev / bytes / withCompletion / writeMs / at）一个不动，`bytes=` 现在
            // 就是**建议格那一格**的字节数（拆分前它是整份载荷），所以它下降正是本任务要
            // 的那个数；为了不把「口径变了」伪装成「优化生效」，行尾补两个新键：
            //  `hotBytes=` 同一次写里热度格的字节数（没带就是 0）
            //  `cells=`   这一次写到底带了几格（push / both），换算总字节用
            traceOps(`push landed rev=${rev} bytes=${payload.length}${carriesCompletion ? ' withCompletion=1' : ''} writeMs=${writeMs} at=${at} hotBytes=${hotPayload === null ? 0 : hotPayload.length} cells=${hotPayload === null ? 'push' : 'both'} coalesced=${hotCoalescedNow}`);
          } else {
            // 纯热度变化：**新前缀**（`push landed` 那行的语义是「建议格落地」，复用它
            // 会让 bytes= 的含义在同一行里飘）。package.json 的 sandbox.greps 同步补一条。
            traceOps(`hot push landed rev=${hotRevNow} hotBytes=${hotPayload === null ? 0 : hotPayload.length} writeMs=${writeMs} at=${at} cells=hot coalesced=${hotCoalescedNow}`);
          }
        },
        (error: unknown) => {
          const text = errorText(error);
          // **三态分诊**（判据与处置见 `src/deferred-writes.ts` 的 `triageWriteFailure`）：
          //  - 结构性拒绝（HMR 事务嵌套）：写不进盘是**结构性的**，但可以在事务外补写；
          //  - 可重试的竞争失败（写锁等待超时）：写不进去只是**当时锁被占着**，过一会儿
          //    重试就能成 —— 终局丢弃＝载荷凭空消失、client 收不到幽灵；
          //  - 其它：保持丢弃，但留痕必须**说清是「未知」**，不许伪装成前两者。
          const triage = triageWriteFailure(error, 'push');
          // 热度格**不进 `deferred` 的槽**：它是整份当前快照、每帧都可能被下一帧覆盖，
          // 不需要 CAS，也不该和「用户刚等的东西」（续写/清空）争同一个槽。它走另一条
          // 同样事务外、但**有界**的路：留在 `pendingHotPayload` 上，由 `drainDeferred`
          // 的补写泵每 tick 至多试一次，`HOT_DRAIN_MAX_ATTEMPTS` 到点丢弃并放开指纹。
          //
          // ⚠️ **这里绝不能「失败后立刻再 flush」**（2026-10-22 事故）：HMR 事务内的拒绝
          // 是同步零副作用的 `Promise.reject`，立刻重写只会得到同一个错误；而
          // 「失败 → 重排 → `.finally` 再 flush」是一条**微任务紧循环**，不把控制权交还
          // 事件循环（timer / I/O 全饿死），每圈还打一行 `hot write refused`——实测把
          // tee 日志刷到 23 GB。所以 `.finally` 只续写**建议格**，热度格交给事务外泵。
          if (hotPayload !== null) {
            // 在途期间可能已经有**更新**的热度载荷排进来：那时不能用这份旧字节盖掉它
            // （否则读侧会倒退）。只有槽空着才放回。
            if (pendingHotPayload === null) {
              pendingHotPayload = hotPayload;
              pendingHotFingerprint = hotFingerprint;
            }
            traceFault(
              'hot-write-refused',
              `hot write refused (${triage.cls}) re-staged=${pendingHotPayload === hotPayload ? 1 : 0} after=${Date.now() - pushStartedAt}ms: ${text}`,
              20,
            );
          }
          if (payload === null) return; // 这次写只带了热度格：没有建议格可排队
          if (triage.disposition === 'queue') {
            // 带续写的丢弃**不节流**：每 50 次才记一条，而恰恰是这一次丢了用户等的东西；
            // 被 #2..#49 吞掉就等于把 #15 的结论又藏回去了。
            if (carriesCompletion) {
              traceOps(`push write refused (${triage.cls}) rev=${rev} carriedCompletion=1 after=${Date.now() - pushStartedAt}ms: ${text}`);
            }
            traceFault(triage.kind, `push write refused (${triage.label}) (rev=${rev} queued${carriesCompletion ? ' carriedCompletion=1' : ''}): ${text}`,
              carriesCompletion ? 1 : 50);
            // **主路径：排队补写**（建议格走 #47 那条硬化路径，语义未动）。
            // 排队之后**不**清指纹：载荷已经在槽里，清了指纹反而让同一内容的下一次推送
            // 再走一遍必被拒的即时写；槽项被丢弃且没有落盘时才把指纹放开。
            if (fingerprint !== null) {
              deferred.enqueuePush({ payload, fingerprint, carriesCompletion }, Date.now());
            }
            return;
          }
          traceFault(triage.kind, `push to client failed (${triage.label}) (rev=${rev} dropped): ${text}`);
        },
      )
      .finally(() => {
        pushInFlight = null;
        // 写入期间又有新载荷 → 续写最新；或这一笔是因为**别的写占着锁**才排队的
        // （见上面 flushPush 里的互斥段）—— 那种情况由占锁那笔写的 finally 唤醒。
        retryFlushAfterWrite();
        // ⚠️ **只续写建议格，不续写热度格**：热度格被拒后若在这里立刻再 flush，就是
        // 「失败 → re-stage → finally → 再失败」的微任务紧循环（2026-10-22 事故：日志
        // 23 GB + 事件循环饿死）。热度格由事务外 `drainDeferred` 有界补写；消费侧
        // `pushToClient` 的 no-dirty 分支也仍是它的一个事件驱动入口。
        if (pendingPushPayload !== null) flushPush();
      });
  };

  /**
   * 「等锁者」的唤醒出口：有一笔写占着锁时排着的即时写，等占锁那笔落地后再试一次。
   *
   * 三笔写（补写泵 / 即时写 / `_ops` 清空）共用同一把 profile 锁，所以谁在途其余都
   * 不抢锁。本函数是唯一把它们串起来的点：**每笔写的 finally 都调它**，否则等锁的
   * 即时写会永远排着（载荷还在 `pendingPushPayload` 上，没丢，但也不会落地）。
   */
  const retryFlushAfterWrite = (): void => {
    if (!pushWaitingForWrite) return;
    if (anyWriteInFlight()) return; // 还有别笔在途：等它自己的 finally 再唤醒
    pushWaitingForWrite = false;
    flushPush();
  };

  /**
   * 槽里的 push 项被丢弃且没落盘时放开指纹。
   *
   * 排队期间指纹是**留着的**（载荷已在槽里，清了指纹反而让同内容的下一次推送再走一遍
   * 注定被拒的即时写）。只有补写最终没成（淘汰 / 判定跳过）时才清掉，把旧的兜底路径
   * 「下一个非事务写点顺带把同一份载荷补出去」接回来，于是一次被拒不会变成静默的永久失败。
   * 只在「这份载荷仍是当前最新的意图」时清：已经被更新载荷取代（指纹不等）时不该动，
   * 清了会把新载荷的去重也一并弄丢。
   */
  const releaseDeferredPushFingerprint = (item: DeferredPushItem): void => {
    if (lastPushFingerprint === item.fingerprint) lastPushFingerprint = null;
  };

  /**
   * 留痕里的通道名：`push` / `_ops clear`。与成功那条（`deferred push landed` /
   * `deferred _ops cleared after consume`）保持同一前缀，「同一件事的三种结局」用
   * `grep 'deferred '` 一次看全。
   */
  const deferredLabel = (kind: DeferredKind): string => (kind === 'push' ? 'push' : '_ops clear');

  /**
   * 事务外排水锚点：把被拒的写入补出去（**结构性拒绝**与**可重试的竞争失败**两类）。
   *
   * **为什么定时器能写进去**：`setInterval` 捕获的是**建它的那一刻**的
   * `AsyncLocalStorage` 上下文（内核事务见 `@deepseek-ai/dsh-hmr` 里的
   * `executing = new AsyncLocalStorage()`、nested 拒绝判据、`executing.run(true,
   * operation)`）。⚠️ **行号按版本代次漂移，引用必须带代次锚点**：0.2.0-rc.2 是
   * :271（ALS 声明）/ :280（nested 拒绝）/ :283（`run(true)`），0.2.1-rc.2 是
   * :736 / :749 / :752 —— 两代 `runExclusive` 函数体**逐字相同**，只是整段位移。
   * 上下文沿 `await` / microtask / **事务内建的 timer** 传播，所以「排到下一个 tick」
   * 逃不出去；而 boot 期 `apply()` 不在事务内，此刻 store 是 undefined，于是这个定时器
   * 以后每次触发都在事务外。
   *
   * ⚠️ **写失败有两种模式，别只按一种分诊**（复核评论 #36 `issuecomment-37810` 在实跑
   * 宿主 0.2.1-rc.2 上的实测，节选；「判定」列是「写有没有进盘并 bump revision」）：
   *
   * ```
   * A（事务外建立，store=undefined）
   * A2 apply() 期建的 setTimeout(5s)      OK    191–299ms    ✓ bump
   * A3 apply() 期建的 setInterval(8s)     OK    201–283ms    ✓ bump
   * A9 回调内 await 500ms 后写            OK    1685–1893ms  ✓ bump
   * A5 回调内直接写                        FAIL  2072–2113ms  ✗ timed out waiting for the writer lock
   * B（真事务内，store=true）
   * B1 回调内直接写                        FAIL  23–31ms      ✗ HMR transactions cannot be nested
   * ```
   *
   * 两条结论：**「失败」有两种互不相同的成因**（上下文 in ALS vs 争锁），而**「成功」
   * 的耗时也不等于写入耗时**（早先 PROBE 里 1463/1722ms 那两行记成 OK，其实撞的是
   * 锁窗口）。所以只认一条 `/cannot be nested/` 正则的旧分诊必然漏掉一类，而漏掉的
   * 那一类（锁超时）是**可重试**的——漏判＝载荷凭空消失。
   *
   * ⚠️ **建它的位置是这条修复的前提**：只能在 `apply()` 的同步续体里（见下面
   * `ctx.inject(['settings'])` 中 `settingsSvc` 就位处）。挪进任何 handler / await 续体，
   * 捕获的上下文就变成 store=true，补写会静默退回「每次都 nested」的老行为。
   *
   * 每 tick 只补**一个**槽（两个槽最坏两个 tick 排空），热度格也占同一个「一个」的
   * 名额。队列空且没有待补热度时必须立刻 return：这个定时器常年空转，空转成本 = 两次
   * 布尔判断，**不得**每 tick 去 `describe()` / 读盘 / 构造载荷。
   */
  function drainDeferred(): void {
    // 快路径的形状是**被断言钉住的**（`scripts/deferred-writes-smoke.mjs`：pump 每 500ms
    // 跑一次且常年空转，空转成本必须是布尔判断）。2026-10-22 之后热度格也在这里补写
    // （它被 HMR 事务拒绝后只剩这条事务外路径），所以条件多一个 `pendingHotPayload`
    // 判断——仍不碰盘、不 describe、不构造载荷。
    if (deferred.isEmpty() && pendingHotPayload === null) return;
    const svc = settingsSvc;
    if (svc === null) return; // 服务未注入：没有写面，槽留着下次 tick
    const now = Date.now();
    // 先淘汰「补了也没意义」的项，再取：顺序反过来就会把陈旧载荷先写回去。
    for (const evicted of deferred.evict(now)) {
      const item = evicted.item;
      traceOps(
        `deferred ${deferredLabel(item.kind)} dropped reason=${evicted.reason} age=${evicted.ageMs}ms attempts=${evicted.attempts}`
        + `${item.kind === 'push' ? ` rev=${item.rev ?? 'n/a'} carriedCompletion=${item.carriesCompletion ? 1 : 0}` : ''}`,
      );
      if (item.kind === 'push') releaseDeferredPushFingerprint(item);
    }
    if (deferred.isEmpty()) {
      // 队列被淘汰空了 ⇒ 没有在等的项了（等的是队列里的项，不是锁），别把上一次的
      // 等待时长攒到下一次入队上（那会把两段不相干的等待并成一段）。
      deferredWaitSince = null;
      // 但热度格可能还压着一份被拒的载荷：别在这里 return 掉它。
      if (pendingHotPayload === null) return;
    }
    // **互斥**：还有写在这把 profile 锁上（在途）时，补写**不要抢锁**。
    //
    // 抢锁的后果不是「慢一点」，而是 `atomic-write: timed out waiting for the writer
    // lock`（2s 硬上限，`dsh-atomic-write/lib/index.js:164` 的
    // `DEFAULT_LOCK_WAIT_MS=2e3`，`dsh-config-editor/lib/index.js:72` 取锁不传 options
    // ⇒ 调用方改不了）⇒ 那一次补写直接失败，载荷又得再排一轮。而这把锁**很大概率是
    // 被本仓自己占着**（补写泵 500ms 一 tick 与即时写撞上）——自伤。实测事务外写一轮
    // 191~332ms、首笔 2.2~2.5s ⇒ 补写落在即时写窗口内的概率不低。
    //
    // 槽里的项**不取出来**（取出来就得放回，白折腾），留到下一 tick；等锁时长留痕见
    // 下面 `deferredWaitSince` 那段。
    if (anyWriteInFlight()) {
      if (!deferred.isEmpty() && deferredWaitSince === null) deferredWaitSince = now;
      return;
    }
    if (deferredWaitSince !== null) {
      const waitedMs = now - deferredWaitSince;
      deferredWaitSince = null;
      traceFault('deferred-wait', `deferred drain waited for the in-flight write to land before taking the lock (waitedMs=${waitedMs})`, 50);
    }
    // 热度格补写：只有建议/清空队列**空着**时才轮得到它（那两项是用户正在等的东西）。
    // 这条路是事务外锚点，也是「被 HMR 事务拒绝」唯一的合法出口——但**必须有界**：
    // 每次失败 `hotDrainAttempts+1`，到 `HOT_DRAIN_MAX_ATTEMPTS` 就丢弃并放开指纹，
    // 由下一次状态推送重建。绝不能让 500ms 的 tick 变成永久重试。
    if (deferred.isEmpty()) {
      // 窗口没到期就不写：否则这条事务外锚点会每 500ms 把合并中的快照冲出去，
      // 窗口等于不存在（`decideHotPush` 用同一个判据，两边不会漂移）。
      if (pendingHotPayload !== null
        && decideHotPush(now, hotWindowOpenedAt).action === 'write') {
        drainHotFromPump(svc);
      }
      return;
    }
    const item = deferred.take();
    if (item === null) return;
    const queuedAt = item.enqueuedAt;

    if (item.kind === 'push') {
      // 安全约束二（`_push` 那一半）：不得用陈旧载荷盖掉更新的盘上状态。
      // 草稿比对用宿主已有的最新事实：`completionCache` 里该会话上一次成功生成的那份
      // draft。拿不到（无缓存 / 载荷读不出 draft）时**不猜**，由 8s 时间上限兜底。
      const knownDraft = item.completionSessionId === null
        ? null
        : completionCache.get(item.completionSessionId)?.draft ?? null;
      const decision = decidePushDrain(item, {
        lastPushFingerprint,
        lastLandedPayload: lastLandedPushPayload,
        latestCompletionDraft: knownDraft,
      });
      if (decision.action === 'skip') {
        traceOps(
          `deferred push skipped reason=${decision.reason} rev=${item.rev ?? 'n/a'} carriedCompletion=${item.carriesCompletion ? 1 : 0} age=${Date.now() - queuedAt}ms`,
        );
        if (decision.reason !== 'already-landed') releaseDeferredPushFingerprint(item);
        return;
      }
      // 写实耗（#39 的尾延迟分解）：起点打在**这一次** `settings.update` 上，不是打在
      // 入队那一刻——否则 `writeMs` 与 `after` 就是同一个数，分不出等泵与写。
      const drainWriteStartedAt = Date.now();
      // 补写这笔写也占那把 profile 锁 ⇒ 记在途（互斥的另一半：即时写与 `_ops` 清空都
      // 要看它，见 `anyWriteInFlight`）。
      const write = svc.update(SUGGEST_GHOST_NAMESPACE, { _push: item.payload });
      const tracked = write.then(
        () => {
          lastLandedPushPayload = item.payload;
          // 验收就看这条：`deferred ` 前缀把它和正常即时写路径（`push landed rev=…`）
          // 分开，二者同时出现才说明「即时被拒 → 事务外补写成功」这条链真的走通了。
          // 行尾两个新键是 #39 的尾延迟分解：`after` 是**入队到落盘**（等泵 + 写），
          // `writeMs` 只是那一次 `settings.update` 自己。两者一减就是「等 500ms 泵」
          // 占了多少——这个差决定该降泵间隔还是该换通道，光看 after 分不出来。
          traceOps(
            `deferred push landed rev=${item.rev ?? 'n/a'} carriedCompletion=${item.carriesCompletion ? 1 : 0} after=${Date.now() - queuedAt}ms attempts=${item.attempts + 1} writeMs=${Date.now() - drainWriteStartedAt} at=${Date.now()}`,
          );
        },
        (error: unknown) => retryDeferred(item, error),
      );
      deferredWriteInFlight = tracked;
      void tracked.finally(() => {
        deferredWriteInFlight = null;
        retryFlushAfterWrite();
      });
      return;
    }

    // 安全约束二（`_ops` 那一半）：**盘上比对走 `readOps()`**，它经 settings 服务的
    // `describe()` 现读 `_ops` 的值，是插件内唯一权威源（`consumeOps` 传进来的
    // `consumedPayload` 就是同一函数的返回值，两者同口径才可比）。不相等 = 期间 client
    // 又写了新载荷 = 这次清空会吃掉未消费的 op ⇒ 放弃（不是重试）。
    const decision = decideClearOpsDrain(item, readOps());
    if (decision.action === 'skip') {
      traceOps(
        `deferred _ops clear skipped reason=${decision.reason} age=${Date.now() - queuedAt}ms attempts=${item.attempts}`
        + ' (新载荷留在盘上，由它自己的 document-updated → consumeOps 排自己的清空)',
      );
      return;
    }
    const clearWrite = svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH });
    const clearTracked = clearWrite.then(
      () => {
        traceOps(`deferred _ops cleared after consume after=${Date.now() - queuedAt}ms attempts=${item.attempts + 1}`);
      },
      (error: unknown) => retryDeferred(item, error),
    );
    deferredWriteInFlight = clearTracked;
    void clearTracked.finally(() => {
      deferredWriteInFlight = null;
      retryFlushAfterWrite();
    });
  }

  /**
   * 事务外补写**热度格**（`_hot`）的那一笔。
   *
   * 为什么热度格不走 `deferred` 的两个槽：它是**整份当前快照**（热表 + 总数 + 历史环），
   * 没有 `_push` 那种「陈旧载荷会盖掉新状态」的 CAS 语义，也不该和「用户刚等的东西」
   * （续写 / `_ops` 清空）争同一个槽。代价只是晚一个 tick 落地，而它每帧都可能被下一帧
   * 覆盖 ⇒ 它只需要**事务外 + 有界**这两条性质。
   *
   * 三次机会的依据见 {@link HOT_DRAIN_MAX_ATTEMPTS}：前两次可能是锁竞争（可重试），
   * 第三次还失败就说明这条路当前走不通（或 pump 又建在了事务内），继续重试只会烧日志。
   * 到点丢弃后必须放开 `lastHotFingerprint`——否则下一次推送会把同一份内容判成「没变」，
   * 热度/历史就永远停在客户端现值上。
   *
   * @param svc - settings 写面（与 `drainDeferred` 用的是同一个服务）。
   */
  function drainHotFromPump(svc: { update: (ns: unknown, patch: object) => Promise<void> }): void {
    const payload = pendingHotPayload;
    if (payload === null) return;
    if (payload === lastLandedHotPayload) {
      // 期间已有别的写点把同一份字节写进去了：再写一次只是白推一个 revision。
      pendingHotPayload = null;
      pendingHotFingerprint = null;
      hotDrainAttempts = 0;
      return;
    }
    const fingerprint = pendingHotFingerprint;
    const attempt = hotDrainAttempts + 1;
    // 归零前先取走合并计数（`armHotWindow` 会清 `hotCoalesced`）。
    const hotCoalescedNowPump = hotCoalesced;
    const writeStartedAt = Date.now();
    // 先离槽：写入期间若有更新载荷排进来，它应该占住槽（最后由它自己落地）。
    pendingHotPayload = null;
    pendingHotFingerprint = null;
    const tracked = svc.update(SUGGEST_GHOST_NAMESPACE, { _hot: payload }).then(
      () => {
        lastLandedHotPayload = payload;
        hotDrainAttempts = 0;
        const coalesced = hotCoalescedNowPump;
        armHotWindow(); // 泵这条路口径一致：写出去了就从此刻重新开一个窗口
        traceOps(
          `hot push landed via deferred pump bytes=${payload.length} after=${Date.now() - writeStartedAt}ms attempts=${attempt} at=${Date.now()} coalesced=${coalesced}`,
        );
      },
      (error: unknown) => {
        const text = errorText(error);
        const triage = triageWriteFailure(error, 'push');
        // 槽里已有更新载荷 ⇒ 这份已被取代：不再放回（旧字节不许盖新状态），也不消耗
        // 新载荷的补写预算（`pushToClient` 入队时已把预算清零）。
        if (pendingHotPayload !== null) {
          traceFault(
            `deferred-hot-${triage.suffix}-superseded`,
            `deferred hot push superseded while in flight (older snapshot dropped; newer one owns the slot): ${text}`,
            20,
          );
          return;
        }
        pendingHotPayload = payload;
        pendingHotFingerprint = fingerprint;
        hotDrainAttempts = attempt;
        // 被拒 ⇒ **解除窗口**（`hotWindowOpenedAt = null`）：留在槽里的这份快照该由 #47 的
        // 有界重试立刻补写，而不是再被合并窗口扣一个窗口。窗口省的是「无谓的重写」，
        // 不该变成「把没写成功的东西多扣一会儿」。
        if (attempt >= HOT_DRAIN_MAX_ATTEMPTS) {
          // 到点丢弃：同一份快照再试也只是同一类失败。放开指纹，让下一次状态推送
          // 重新判脏、重建一份**当前**快照。
          pendingHotPayload = null;
          pendingHotFingerprint = null;
          lastHotFingerprint = null;
          hotDrainAttempts = 0;
          traceFault(
            'hot-drain-exhausted',
            `deferred hot push dropped reason=attempts-exhausted attempts=${attempt} bytes=${payload.length}: ${text}`,
            20,
          );
          return;
        }
        traceFault(
          `deferred-hot-${triage.suffix}`,
          `deferred hot push refused (${triage.label}; attempts=${attempt}/${HOT_DRAIN_MAX_ATTEMPTS}): ${text}`,
          20,
        );
      },
    );
    deferredWriteInFlight = tracked;
    void tracked.finally(() => {
      deferredWriteInFlight = null;
      retryFlushAfterWrite();
    });
  }

  /**
   * 补写又被拒：按**失败类别**分别处置（放回原槽计数一次，或放弃）。
   *
   * 留痕必须与**首次被拒**不同名（`deferred-*` 而不是 `push-nested`），否则「事务外的
   * pump 也写不进」这个和根因等价的结论会被同类计数器按首次拒绝的签名一起吞掉。kind
   * 按类别分（`deferred-push-nested` / `deferred-push-lock-timeout` /
   * `deferred-push-failed`），这样「哪类失败吃掉了几次补写」可统计。
   *
   * **两类失败的性质不同，处置也不同**（复核评论 #36 `issuecomment-37810` 实测）：
   *  - 结构性拒绝（nested）是**同步零副作用**的拒绝（内核直接 `Promise.reject`，不进锁
   *    也不进 reconcile，23~31ms 即拒）：同一个上下文里再试多少次都是同一个错，8 次
   *    预算纯属浪费日志 ⇒ **至多再试一次**就放弃并留痕。
   *  - 写锁等待超时是**有希望下一轮就成**的瞬时争用 ⇒ 保留既有重试预算（8 次 / 8s）。
   *  - 未识别的失败：那一项**已经在队列里**了，丢掉＝载荷永久消失，所以仍放回（预算
   *    有上限），但 kind 与前两者分开（`deferred-*-failed`），不伪装成已知类别。
   */
  function retryDeferred(item: DeferredItem, error: unknown): void {
    const text = errorText(error);
    const triage = triageWriteFailure(error, item.kind === 'push' ? 'push' : 'clearOps');
    // 留痕里用通道名（`push` / `_ops clear`）而不是槽名，与成功那条的前缀一致，好 grep。
    const label = deferredLabel(item.kind);
    // 结构性拒绝：至多再试一次（第二次还 nested 就说明「上下文建错了」，重试没有信息量）。
    if (triage.cls === 'structural-refusal' && item.attempts >= 1) {
      traceFault(
        triage.deferredKind,
        `deferred ${label} write refused again inside a settings transaction (attempts=${item.attempts + 1} age=${Date.now() - item.enqueuedAt}ms, giving up: the same context refuses identically): ${text}`,
        10,
      );
      if (item.kind === 'push') releaseDeferredPushFingerprint(item);
      return;
    }
    const requeued = deferred.retry(item);
    if (requeued) {
      traceFault(
        triage.deferredKind,
        `deferred ${label} write refused again in the apply()-time pump (${triage.label}; attempts=${item.attempts + 1} age=${Date.now() - item.enqueuedAt}ms): ${text}`,
        10,
      );
      return;
    }
    // 在途期间同种槽已经被更新的入队占住：旧项确实被取代了，丢弃并放开指纹。
    traceOps(`deferred ${label} dropped reason=superseded-on-retry age=${Date.now() - item.enqueuedAt}ms`);
    if (item.kind === 'push') releaseDeferredPushFingerprint(item);
  }

  /**
   * 组装某会话的**当前权威状态**并推给 client：历史环按需从日志物化（ringFor，
   * 无播种时机概念）、建议经语义校验（currentSuggestionFor）、热度取热表现照。
   * 启动对账、pull 应答、热度恢复补推三条路径共用这一份组装逻辑——它们此前
   * 各写各的，是冷启动竞态的根源。
   *
   * 建议字段的跨会话语义：本会话的建议按校验结果推（有效原样 / 陈旧清掉）；
   * 其他会话的有效建议原样保留——client 端按会话归属守卫隐藏，切回时仍在
   * 有效期，推 null 反而会把切回后的建议弄丢。
   * @param sessionId - 目标会话；null 表示无特定会话（仅刷新热度，历史不携带）。
   */
  const statePushOf = (sessionId: string | null): ClientPush => {
    const ring = sessionId === null ? undefined : ringFor(sessionId);
    // 建议字段：本会话按语义校验取用；不属于本会话但仍被追踪的那条原样带上
    // （client 按会话归属守卫隐藏，切回时立即可用）。
    const fields = suggestionFieldsFor(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      sessionId === null ? null : currentSuggestionFor(sessionId),
    );
    return {
      suggestion: fields.suggestion,
      suggestionSessionId: fields.sessionId,
      hot: hotness.snapshot(historySnapshotCap()),
      total: hotness.size,
      history: ring === undefined ? null : ring.slice(-HISTORY_PUSH_CAP),
      historySessionId: ring === undefined ? null : sessionId,
      ...(sessionId !== null && completionCache.has(sessionId)
        ? { completion: completionCache.get(sessionId)!, completionSessionId: sessionId }
        : lastCompletion !== null
          ? { completion: lastCompletion.completion, completionSessionId: lastCompletion.sessionId }
          : {}),
    };
  };

  /**
   * `_ops` 消费器（watch 触发与启动遗留补消费共用）：pull 走统一的状态组装应答，
   * 其余操作交热表层应用（幂等），最后 flush 并清空队列。捎带的 locale 更新到
   * 模块变量，供后续语言检测使用。
   *
   * **留痕归这里，不归 `parseHotnessOps`**：解析函数是纯函数（无 ctx，也要被 smoke
   * 直接驱动），它把丢弃原因当数据返回；本函数是两个调用点（启动补消费 +
   * `document-updated`）唯一的汇聚处，在这里打日志意味着「新增第三个调用点也自动
   * 带留痕」。通道选择见 `traceOps` 上方那段，**不要**改回 ctx.logger 单通道。
   * @param parsed - 已解析的操作批 + 可选 locale + 可选丢弃原因。
   * @param svc - settings 写面，用于消费后清空 `_ops`。
   */
  const consumeOps = (
    parsed: ParsedOpsResult,
    svc: { update: (ns: unknown, patch: object) => Promise<void> },
  ): void => {
    // **同步**抓一份本次消费的 `_ops` 载荷原文：清空被拒时要连它一起排队，补写前拿它
    // 与盘上现值比（见 `decideClearOpsDrain`）。不能等回调里再读 `lastOpsPayload`——
    // 那时它可能已经被下一次 `document-updated` 推进成新载荷了，拿新值比新值必然相等，
    // CAS 就退化成「无条件清空」，恰好丢掉这条约束要防的那种竞态。
    const consumedPayload = lastOpsPayload;
    // 捎带的 UI 语言：有则更新（last-wins），无则保持上次值。
    if (parsed.locale !== undefined) clientUiLocale = parsed.locale;
    // 整批丢弃必须可见（#17：客户端写了、宿主没动、日志一个字都没有）。
    // 空载荷不走这条：那是消费后的正常态，每次都打就成了噪声。
    const dropped = parsed.rejected;
    if (dropped !== undefined) {
      traceFault('ops-dropped', `_ops batch dropped (${dropped.kind}, ${dropped.bytes} bytes): ${dropped.summary}`, 20);
    }
    const ops = parsed.ops;
    if (ops.length === 0) return;
    // 一批一行 + 每个「会驱动外部动作」的 op 一行：
    //  - 管理面板一次可以提交几十条 delete/pin/add，逐条打会把 tee 日志刷爆，
    //    所以纯热表操作只进 kinds 直方图（消费结果由下面那行 applied 给出）；
    //  - pull / complete 各自会驱动推送或 LLM 调用，才是 #15/#16/#18 验收要追的
    //    那一次动作，逐条打（实际每批至多一条）。
    const kinds = new Map<string, number>();
    for (const op of ops) kinds.set(op.op, (kinds.get(op.op) ?? 0) + 1);
    traceOps(
      `ops batch received: n=${ops.length} kinds=${
        [...kinds].map(([kind, count]) => (count > 1 ? `${kind}x${count}` : kind)).join(',')
      }${parsed.locale !== undefined ? ` locale=${parsed.locale}` : ''}`,
    );
    for (const op of ops) {
      if (op.op === 'pull') {
        traceOps(`ops consumed: pull session=${op.sessionId} (应答走 pushToClient)`);
        // **回读态补判**（#50）：启动那一刻会话可能还没进店（宿主的持久化懒恢复），
        // 判不了盘上残留建议的新旧；此刻 client 正在问这个会话，它一定在店了 ⇒
        // 现在判。判出可恢复就接回追踪态，于是**这次 pull 的应答自然带上它**——
        // 不需要额外推一次，也不会出现「空建议把盘上那条盖掉」。
        restorePersistedPushForSession(op.sessionId);
        // 无论历史环可不可得都应答：环缺失（会话尚未进店/已销毁）时 statePushOf
        // 会省略 history（client 保留现值），但热度与对账后的建议照常送达——
        // 静默丢弃会让 client 永远等不到这一轮对账。
        // **pull 让路**（task-16 判据 2）：切会话时「先旧后新」比滞后更难看，
        // 所以应答必须带**当前**热度，窗口未到期也立刻写。
        pushToClient(statePushOf(op.sessionId), { hotNow: true });
      } else if (op.op === 'complete') {
        // 草稿只打长度不打正文：留痕要能对上号，但不能把用户输入抄进 tee 日志。
        traceOps(`ops consumed: complete session=${op.sessionId} draftChars=${op.draft.length}`);
        handleComplete(op.sessionId, op.draft);
      }
    }
    const changed = persistence.applyOps(ops);
    traceOps(`hotness ops applied: batch=${ops.length} changed=${changed} tableSize=${hotness.size}`);
    void persistence.flush();
    // 消费完成：清空操作队列（下一次 watch 触发时 ops 为空，直接跳过）。
    //
    // ⚠️ **这次清空历史上几乎必然失败，而且失败是被静默吞掉的**（373 次里 372 次
    // `HMR transactions cannot be nested`）。机制：`SettingsForms.write()`（:501）在
    // `configEditor.edit()`（:508）的回调**内**调 `this.describe()`（:509），而
    // `describe()` 就地 `emit("settings/document-updated")`（同文件 :435）→ 本回调跑在
    // `@deepseek-ai/dsh-hmr` 的 `executing.run(true, ...)` 里 →
    // 这里的 `update` 再进 `runExclusive`，被 nested 判据
    // `if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"))`
    // 直接拒绝（`dsh-hmr` **0.2.0-rc.2** 是 :280，**0.2.1-rc.2** 是 :749 —— 行号按代次
    // 漂移，引用必须带代次锚点；`dsh-settings` 与 `dsh-config-editor` 的
    // `lib/index.js` 在两代之间逐字节相同 ⇒ 上面那三个行号两代都准）。
    // **排到下一个 tick 也逃不掉**：`executing` 是 AsyncLocalStorage，
    // 上下文沿 await/microtask/timer 继续传播（本机实测：事务内建的 setTimeout
    // 回调里 `getStore()` 仍是 true；只有事务外建立的上下文才是 undefined）。
    // 现在三层一起做：**结构性拒绝与可重试的竞争失败都排进事务外 pump 的槽**
    // （`deferred-writes.ts`），补写前按盘上现值做一次 CAS；未识别的失败仍一次一打、
    // 不排队（它们不是结构性的，载荷留在盘上等下一次 `document-updated` 就够了）。
    //
    // 这笔清空与即时写、补写共用同一把 profile 锁 ⇒ 记在途（互斥，见
    // `anyWriteInFlight`）：它在途时，补写泵不抢锁、即时写也排队等它落地。
    const clearWrite = svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH });
    const clearTracked = clearWrite.then(
      () => {
        traceOps('_ops cleared after consume');
      },
      (error: unknown) => {
        const text = errorText(error);
        // **三态分诊**（判据见 `src/deferred-writes.ts` 的 `triageWriteFailure`）：
        // 结构性拒绝与可重试的竞争失败都**进补写队列**（重试），未识别的失败保持丢弃
        // 但留痕要说清是「未知」。两类可重试的用**不同的 kind**，好统计。
        const triage = triageWriteFailure(error, 'clearOps');
        if (triage.disposition === 'queue') {
          // **主路径：排队**，由事务外 pump 补做清空（理由与 `flushPush` 的排队分支
          // 同源，见 `deferred-writes.ts` 顶部）。排进去的是**本次已消费的载荷原文**，
          // 补写前拿它与盘上现值比一次，不相等就放弃（见 `decideClearOpsDrain`）。
          // 载荷留在盘上等补清空的代价是「进程重启后可能重放一次」（index 启动对账那段
          // 已记），而在盘上有新载荷时无条件清空会把 client 刚写、还没消费的 op 直接吃掉。
          deferred.enqueueClearOps(consumedPayload, Date.now());
          traceFault(triage.kind, `_ops clear refused (${triage.label}) (queued for the apply()-time pump; payload stays on disk until then; re-consume is blocked only by the in-process payload guard): ${text}`);
          return;
        }
        traceFault(triage.kind, `_ops clear failed (${triage.label}; payload stays on disk and will be re-read on next update): ${text}`);
      },
    );
    opsClearInFlight = clearTracked;
    void clearTracked.finally(() => {
      opsClearInFlight = null;
      retryFlushAfterWrite();
    });
  };

  const handleTurnEnd = (session: Session, turn: number): void => {
    // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
    // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
    void persistence.flush();
    let state = states.get(session);
    if (state === undefined) {
      state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined, lastLanguage: undefined };
      states.set(session, state);
      tracked.add(state);
    }
    if (state.lastSuggestedTurn === turn) return;
    const pending = state.pending;
    if (pending !== undefined) {
      if (pending.turn === turn) return;
      pending.controller.abort();
    }
    // 本回合的生效配置：只读一次，保证「是否关 LLM」与「热度 top-K」出自同一
    // 快照（两次读之间若有 document-updated，会拿到跨新旧的值对）。
    const turnCfg = effective();
    // LLM 建议被用户关闭：跳过模型调用（省 token），但热度照常推进并推送，
    // 历史前缀补全不受影响；同时把残留建议清空，避免幽灵残留。
    if (turnCfg.llmEnabled === false) {
      state.pending = undefined;
      state.lastSuggestedTurn = turn;
      trackSuggestion(session.id, null); // 关闭 LLM：本会话建议作废（其他会话不受影响）
      const hot = hotness.snapshot(turnCfg.historyMaxEntries);
      pushToClient({
        suggestion: null,
        suggestionSessionId: null,
        hot,
        total: hotness.size,
        history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
        historySessionId: session.id,
      });
      return;
    }
    const controller = new AbortController();
    state.pending = { turn, controller };
    /**
     * 本次建议生成的起点。#39 之前这条路径**一个字都不打**：耗时留痕只有续写有
     * （`completion generated` / `completion dropped`），于是「建议怎么这么慢」
     * 与「这轮为什么没建议」在 tee 日志里都是零证据，只能靠猜。
     */
    const genStartedAt = Date.now();
    void Promise.resolve()
      .then(() => {
        const cfg = effective();
        return generateSuggestion(
          ctx, cfg, session, turn, controller.signal,
          clientUiLocale, cfg.languageMode, cfg.uiLocaleWeight,
          state.lastLanguage,
        );
      })
      .then(
        (result) => {
          if (state?.pending?.controller !== controller) return;
          state.pending = undefined;
          state.lastSuggestedTurn = turn;
          state.lastLanguage = result.language;
          // 经 settings 实时推给 client（不写日志）。热度快照始终附带：
          // 其频次参与历史补全打分（新近度为主、频次为辅）；「跨会话搜索」
          // 开关仅在 client 端决定是否把这些文本并作候选。历史环随推：client
          // 端补全的文本源（0.1.2 会话快照已不对插件暴露对话 nodes）。
          const hot = hotness.snapshot(historySnapshotCap());
          trackSuggestion(session.id, result.suggestion ?? null);
          pushToClient({
            suggestion: result.suggestion ?? null,
            suggestionSessionId: session.id,
            hot,
            total: hotness.size,
            history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
          });
          // 耗时留痕，与续写那两行同构：前缀自成一条（`suggestion generated` /
          // `suggestion dropped`），正文只打字符数，档位与增量在行尾。
          // 走 `traceOps` 而不是 `ctx.logger`——通道选择的依据见 `traceOps` 上方那段。
          const stream = formatStreamMetrics(result.metrics);
          if (result.suggestion === undefined) {
            traceOps(`suggestion dropped (empty or filtered) session=${session.id} turn=${turn} in ${Date.now() - genStartedAt}ms ${stream} at=${Date.now()}`);
          } else {
            traceOps(`suggestion generated session=${session.id} turn=${turn} chars=${result.suggestion.text.length} frame=${String(result.suggestion.frame ?? 1)} in ${Date.now() - genStartedAt}ms ${stream} at=${Date.now()}`);
          }
        },
        (error: unknown) => {
          if (state?.pending?.controller === controller) state.pending = undefined;
          if (controller.signal.aborted) return; // 被新回合取代，失败符合预期
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
          // 同一条事实再走一遍**运行期可见**的通道：`ctx.logger` 在健康进程里不落地
          // （唯一的 exporter 只收 warn/error，且 startupLogs 只在启动失败时写盘，
          // 见 `traceOps` 上方那段）。失败也留一行，带已知的增量画像与耗时。
          traceOps(`suggestion failed session=${session.id} turn=${turn} in ${Date.now() - genStartedAt}ms ${message.slice(0, 200)} at=${Date.now()}`);
          // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
          trackSuggestion(session.id, null);
          const hot = hotness.snapshot(historySnapshotCap());
          pushToClient({
            suggestion: null,
            suggestionSessionId: null,
            hot,
            total: hotness.size,
            history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
            error: message.slice(0, 300),
          });
        },
      );
  };

  ctx.on('session/event', (session, event) => {
    // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
    hotness.consume(event, session.id);
    const userText = userTextOfEvent(event);
    // ringPush 会先按需物化（含本事件之前的日志），无需任何「首见播种」步骤。
    if (userText !== null) ringPush(session.id, userText);
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      handleTurnEnd(session, event.data.turn);
    }
  });

  // 插件卸载时中止所有在途生成（建议 + 续写），并停掉排水定时器（它跨 apply 存活，
  // partialReload 会把旧的那份留在事件循环里，槽队列与 settingsSvc 都是旧闭包的，
  // 留着就成了无人认领的写入源）。
  ctx.effect(() => () => {
    // **卸载前把挂起的热度快照刷出去**（task-16 判据 4）：窗口是为了省无谓的整档重写，
    // 不是为了丢最后一段。不刷的话，「用户最后打的那句进了热表、但此后再没有变化」
    // 这段热度就永远留在服务端，客户端下次打开看到的是旧列表。
    // 此刻已经在卸载路径上，不指望它一定写进盘（服务可能先于我们关闭），但**不静默**：
    // 成功/失败都有落地留痕（走 flushPush 的既有分诊），实在没写面就一行告警。
    if (pendingHotPayload !== null && settingsSvc !== null) {
      pushToClient(statePushOf(lastSuggestionSession), { hotNow: true });
    }
    if (deferredPump !== null) clearInterval(deferredPump);
    deferredPump = null;
    for (const state of tracked) state.pending?.controller.abort();
    for (const controller of completionPending.values()) controller.abort();
  });

  // `suggestGhost` 投影单元：last-wins fold。仅当投影注册表已组合时激活
  // （headless 组装不受影响）。
  //
  // 跨代注册：0.1.2 改了单元形状——`schema` → `stateSchema`，顶层 `view` 挪进
  // `wire.view`（payload schema 随之改名 `wire.viewSchema`），`init` 额外接收
  // (header, inheritedEventCount)（本插件的无参 init 天然兼容）。两代形状在
  // 对方的类型里都不可见，按 0.1.2 独有的 `cachedSnapshot` 方法探测代际后
  // 分别构造；类型层以宽松结构视图对接，运行时行为两代各自验证。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: {
        register: (definition: Record<string, unknown>) => () => void;
        cachedSnapshot?: unknown;
      };
    }).sessionProjections;
    if (registry === undefined) return;
    const is02 = typeof registry.cachedSnapshot === 'function';
    const fold = {
      key: PROJECTION_KEY,
      init: initSuggestGhostProjection,
      apply: applySuggestGhostProjection,
      stateVersion: 2,
    };
    if (is02) {
      registry.register({
        ...fold,
        stateSchema: suggestGhostSchema,
        wire: {
          viewSchema: suggestGhostSchema,
          view: (state: SuggestGhostProjection) => state,
        },
      });
    } else {
      registry.register({
        ...fold,
        schema: suggestGhostSchema,
        view: (state: SuggestGhostProjection) => state,
      });
    }
  });
}
