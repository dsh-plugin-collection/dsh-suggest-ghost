/**
 * dsh-suggest-ghost client 端：双模式幽灵输入——
 * 1. 历史补全（草稿非空）：从当前会话历史找前缀匹配，幽灵显示剩余部分，Tab 采纳；
 * 2. LLM 预测（草稿为空）：读取 `suggestGhost` 会话投影，幽灵显示下一条建议，Tab 采纳。
 * 纯 DOM overlay 渲染（不依赖官方 setGhost 能力），零核心改动。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（所有 @deepseek-ai 引用均为 type-only）。
 *
 * rc.7 兼容性说明：DSH rc.7 的 client runner 把插件 apply 包进
 * `dynamicCordisContext` 严格门控 Proxy——`ctx` 只暴露 `ctx.on / ctx.provide /
 * ctx.effect` 等 verbs 与 `inject` 数组声明的服务，**不再提供 `ctx.inject(...)`
 * 延迟注入方法**（rc.6 遗留写法；rc.7 下访问未声明的 `ctx.inject` 会触发
 * rejectGuard 抛错、导致整个 client 插件加载失败）。本文件已改为 rc.7 写法：
 * 所需服务通过模块级 `inject` 数组声明（fiber 激活门控），apply 内直接用
 * `ctx.get(name)` 读取；设置卡片依赖的 `slots` / `settingsScope` 为可选服务，
 * 用 `ctx.get()` 可选读取，缺失时不注册卡片、不阻塞幽灵逻辑。
 *
 * 0.1.7 兼容性：`settingsScope` 服务已随 settings.yaml 体系移除。取数改为
 * `ctx.get('remote')?.settings.describe()`，写入改为 `mutate(ns, ops)`，变更通知
 * 订阅内核转发的 `settings/document-updated` 事件（**无轮询**）；设置卡片所需的
 * scope 最小面由本文件的 `remoteSettingsScope()` 适配器提供，卡片本体无需改动。
 *
 * **注意：remote 一律经 `ctx.get('remote')` 取，绝不读 `ctx.remote` 属性**，且
 * `inject` 必须同时声明 `remote.settings`（cordis reflect 把嵌套属性读拼成
 * `remote.settings` 子服务名）。详见下方 `remoteOf()`。
 * @module dsh-suggest-ghost/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation';
import type { Context } from '@deepseek-ai/cordis';
import type { SuggestGhostProjection, SuggestGhostSuggested } from '../domain.js';
import { clearNormalizeCache, commonPrefixLength, extractHistory, historySuggestion, normalizeForMatch, stripCommandPrefix } from './history.js';
import {
  acceptTarget,
  buildFullAccept,
  buildWordAccept,
  commitDraftIfPristine,
  emptyFrameLedger,
  resolvePayloadFrames,
  frameHintFields,
  gateAccept,
  LEGACY_FRAME_HINT,
  readDraftSnapshot,
  wordAcceptSettled,
  wordMatchBase,
  type DraftSnapshot,
  type FrameHint,
  type FrameLedger,
} from './accept-guard.js';
import { alignCompletion, decideInlineForm } from './completion-align.js';
import { buildOpsPayload, createSeqSource } from './ops-envelope.js';
import { nextAcceptChunk } from './chunk.js';
import {
  anchorMovedBeyond,
  configValuesEqual,
  decideInlineArm,
  decideOverlayPaint,
  initialInlineArmState,
  initialTallyState,
  OPS_TRACE_PREFIX,
  settleInlineTimer,
  shouldSkipDeferredRepaint,
  stepReasonGate,
  stepSlotEmit,
  initialSlotEmitGate,
  stepTally,
  type AnchorPoint,
  type InlineArmGhostKind,
  type InlineArmState,
  type OverlayShape,
  type SlotEmitGate,
  type TallyState,
} from './inline-arm-policy.js';
import { keyCodeOf } from './keyspec.js';
/**
 * 远程 `mutate` 兑现值的分类与写后判定（纯函数模块）。#16 的实质就落在「兑现 ≠ 落盘」
 * 这一层判定上，所以它必须能离线驱动测试（`scripts/ops-write-verify-smoke.mjs`），
 * 而不是等宿主重启后现场看日志。内核/远程层的取证清单写在 `settings-result.ts` 头注释。
 */
import {
  isConflictRefusal,
  opsConflictBackoffMs,
  opsConflictRetryAllowed,
  readRejection,
  settleWriteVerdict,
  unwrapMutateResult,
  verdictFromView,
  type WriteVerdict,
} from './settings-result.js';
import {
  createGhostStreamChannel,
  ghostStreamContribution,
  GHOST_STREAM_NAMESPACE,
} from './stream-ghost.js';
import { OpsWriteQueue, type OpsWriteKind } from './ops-write-queue.js';
import { SuggestGhostCard, type OfficialModelGroup } from './settings-card.js';

/** 官方模型目录读取器（`ctx.modelDirectories` 适配）；未挂上时为 null。 */
let officialCatalogReader: (() => readonly OfficialModelGroup[] | null) | null = null;
import type { PluginSettingsScope } from './settings-scope.js';
import type { LocaleFaceLike } from './useGhostT.js';

/**
 * 宿主可观察快照的最小结构视图。不从 @deepseek-ai/dsh-client-runtime 导入：
 * 该包是 0.1.1 内核特有，0.1.2 已把快照存储拆到 dsh-client-store，这里只用到
 * getSnapshot / subscribe 两个成员，本地声明即可切断这条跨代漂移的类型依赖。
 */
interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * 宿主输入机在本插件用到的最小面。
 *
 * `draftRev` 是 0.2.0-rc.2 起 `InputState` 对外发布的单调编辑器修订号
 * （仅草稿投影变化时自增，纯光标移动不推进），采纳写入拿它做 CAS（#4）。
 * 声明为可选：face 较旧或非 conversation 实现时读不到，accept-guard 会
 * 退化为内容等值比对。
 */
interface InputFaceLike {
  state: ObservableSnapshot<{ draft: string; draftRev?: number | undefined }>;
  setDraft: (text: string) => void;
}

/**
 * 宿主会话列表快照的最小结构视图（只用到 `byId`）。
 *
 * 0.2.x 的 `SessionListState` 顶层只有 `ids` / `byId` / `phase` /
 * `projectionsBySession`，**没有 `current`**：当前会话建模为被 `mainView` 源
 * 保有的那一行，host 的 workspace / layout / session 包都用该判据推导 main。
 * `retainedBy` 只记正数计数，无引用的源键缺席，故必须 `?? 0`。
 */
interface SessionListSnapshotLike {
  byId: Record<string, { id: string; retainedBy?: Record<string, number | undefined> }>;
  /**
   * 当前打开的会话 id（0.1.2 / 0.1.5 的客户端快照带这个字段）。
   * 较新代次没有它——那时靠 `retainedBy.mainView` 推导，见 `currentSessionIdOf`。
   */
  current?: string | null;
}

/**
 * 宿主**客户端** sessions 服务的最小面（#81：只补类型面，不动任何判据逻辑）。
 *
 * ## 为什么在插件侧声明，而不是直接吃宿主的类型
 * `ctx.get('sessions')` 在类型上被解析成 `@deepseek-ai/dsh-session` 的**服务端**
 * `SessionStore`——那里 `list()` 是个方法、且没有 `scope`/`sessionOf`。而浏览器里运行时
 * 拿到的是宿主**客户端**服务（`@deepseek-ai/dsh-api-session-controller` 的 client sessions
 * service）。该包**不在本仓 devDeps**（实测 `require.resolve` 三个宿主客户端包全部失败），
 * 而客户端必须保持**零内核导入**（本文件头注释；`lib/client.js` 实测不含任何
 * `@deepseek-ai/*` 运行时引用）⇒ 出路只有像既有的 `RemoteLike` / `InputFaceLike` /
 * `SessionListSnapshotLike` 一样声明本地最小面。
 *
 * ## 成员出处（能实证的都给行号）
 *  - `list`        ← `…/dsh-api-session-controller/lib/types/client/sessions/service.d.ts:99`
 *                     `readonly list: SnapshotStore<SessionListState>`
 *  - `scope(id)`   ← 同文件 `:213` `scope(id: SessionId): AgentContext | undefined`
 *  - `sessionOf`   ← 同文件 `:238` `sessionOf(ctx: Context): SessionFace | undefined`
 *  - `faceOf(key)` ← `…/client/sessions/projection-store.d.ts:70`
 *                     `faceOf(key: string): ObservableSnapshot<unknown>`
 *    最后这条是关键：宿主返回的类型名**就叫 `ObservableSnapshot`**，与本文件上方那个本地
 *    接口同名同形 ⇒ 不是我把形状安到宿主头上。
 *
 * ## **推断**的部分（写明，不混进上面）
 * `SnapshotStore` / `ObservableSnapshot` 的**成员形状**（`getSnapshot()` + `subscribe(listener)`
 * 返回退订函数）读不到源：`@deepseek-ai/dsh-client-store` 在本机宿主目录与主仓
 * node_modules 里**均未找到**（查过 `.pnpm` 顶层与 `@deepseek-ai/` 目录）。两条独立佐证
 * 支撑该形状：① `bound.projectionFace` 早就是本地 `ObservableSnapshot<unknown>`，且
 * `resolve()` 里的生产路径真的对它 `.subscribe()`；② `list.subscribe` 的返回值被当退订函数
 * 成对使用（`unList()`）。⇒ 哪天宿主改了形状，这里会以**编译期报错**而不是运行时
 * `undefined` 暴露 —— 这正是本块想要的失效方向。
 *
 * **刻意只声明用到的成员**：以后要碰 `ids` / `phase` 等未声明成员会在编译期红，而不是
 * 悄悄拿到 `undefined`。
 */
interface ClientSessionsSurface {
  readonly list: ObservableSnapshot<SessionListSnapshotLike>;
  scope(id: string): ClientAgentContextLike | undefined;
  sessionOf(ctx: ClientAgentContextLike): ClientSessionFaceLike | undefined;
}

/** 会话级 fiber 上下文；本插件只用到它的 `get('conversation')`。 */
interface ClientAgentContextLike {
  get(name: 'conversation'): ClientConversationLike | undefined;
}

/** 宿主输入机所在服务；只用到 `input.for(ctx)`（返回值下游本就有 `as unknown as` 收口）。 */
interface ClientConversationLike {
  readonly input: { for(ctx: ClientAgentContextLike): unknown };
}

/** 只用到 `projections.faceOf(key)`，返回类型直接照抄宿主声明。 */
interface ClientSessionFaceLike {
  readonly projections: { faceOf(key: string): ObservableSnapshot<unknown> };
}

/**
 * 客户端连接代际事件（#81）。宿主在 `dsh-client-connection/lib/types/client/index.d.ts:12-19`
 * 就是用下面这个形状声明它的（本块与之**同形同义**，不是自创），运行时由
 * `dsh-api-gateway/lib/client.browser.js:1640` 在连接建立后 emit，宿主自家客户端包也有
 * 三处同款监听。**因此 `ctx.on('connection/reset')` 一直是合法写法** —— 它报 TS2345 只是因为
 * 那个包不在本仓 devDeps、augmentation 进不来（`require.resolve` 实测失败）。
 *
 * ⚠️ 若将来把 `@deepseek-ai/dsh-client-connection` 加进 devDeps，**删掉本块**改用宿主声明：
 * 事件表这种面一旦有两份真相，就会把「谁改了事件名」变成查不出的问题。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 一个新的连接代际建立： wire 派生的缓存必须重拉（长生命周期流自理恢复）。 */
    'connection/reset'(): void;
  }
}

/**
 * 当前（主视图）会话 id；没有会话打开时为 undefined。
 *
 * ## 两个来源，按可用性取（2026-10-26 真 GUI 实测）
 *
 * 1. **`snapshot.current`** —— 0.1.2 / 0.1.5 的客户端会话快照直接带这个字段
 *    （实测 0.1.5 的 `getSnapshot()`：`snapKeys=ids,byId,current,phase,subagentsByParent,
 *    jobsBySession,currentAddress`，`current="session-…"`，而每行**没有** `retainedBy`）。
 * 2. **`retainedBy.mainView > 0`** —— 较新代次没有 `current`，用「被主视图持有的行」
 *    表达同一个事实（本函数原先只认这条）。
 *
 * ⚠️ 只认第 2 条时，老代次上它**恒返回 undefined**：`bound` 建不起来、幽灵永不显示，
 * 而服务端一切正常（`push landed`、客户端 `parses=1 applies=1`）。现象只有一行
 * `inline-arm-cancel: reason=no-session - bound=false`，从日志几乎看不出所以然。
 */
const currentSessionIdOf = (snapshot: SessionListSnapshotLike): string | undefined => {
  const current = snapshot.current;
  if (typeof current === 'string' && current !== '') return current;
  return Object.values(snapshot.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
};

/**
 * 宿主 `ctx.remote` 的最小结构视图（只用到 `settings.describe` / `settings.mutate`）。
 *
 * 不从 `@deepseek-ai/dsh-client-runtime` 导入：0.1.1 内核特有、0.1.2 已拆走，
 * 0.1.7 换成了 `dsh-api-remotes`。声明本地最小面，让 client 端保持零内核导入
 * （lib/client.js 实测不 import 任何内核包），跨代无关。
 */
interface RemoteLike {
  /**
   * 订阅内核转发到 client 的宿主事件（返回 disposer）。
   * `settings/document-updated` 在 dsh-api-remotes 的转发白名单内（mode: 'emit'），
   * 内核设置页即用它驱动 `SettingsDescribeMirror` 重载。0.1.7+ 可用；更早的代次
   * 没有该服务，故按可选读取（旧宿主退化为首读一次 + 渲染兜底）。
   */
  $on?(event: string, listener: (...args: unknown[]) => void): () => void;
  settings?: {
    /**
     * 读设置文档。返回的是 **RPC 信封** `{ ok, value }`，真正的
     * `{ writable, hasDocument, namespaces }` 在 `value` 里——不是顶层。
     */
    describe(options?: { redactSecrets?: boolean }): Promise<unknown>;
    /**
     * 写设置。第三个参数 `expectedRevision` 是乐观并发控制（不匹配则整批失败，
     * 避免覆盖他人改动）：0.2.0-rc.2 的远程 schema 把它声明成
     * `undefined | number`（`dsh-api-settings-controller/lib/typert.remote-client.js:67`），
     * 但更早的代次因参数元数检查直接拒绝缺参（插件实测：
     * `settings/mutate expected 3 argument(s), got 2`，见 `dsh-api-gateway/lib/client.js:1821-1823`），
     * 故一律**显式传现值**，两种代次都安全。
     *
     * ⚠️ **兑现值不是「写成功」的凭证**：远程面把远程失败折进
     * `{ ok: false, error }` 后**照样兑现**，只有装配故障才 reject（见下方
     * `readMutateResult`）。成功时 `value` 是写后的 `SettingsNamespaceView`
     * （带 `revision` 与整份 `value`），它就是现成的写后读回凭证。
     */
    mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision: number): Promise<unknown>;
  };
  /**
   * 挂载一份手写的 Remote 贡献（#108 流式投递），返回 disposer。
   *
   * ⚠️ **必须可选**：老代次的宿主没有这个成员 ⇒ 取不到就是"这代没有流式通道"，
   * 功能退化成整块到达，不是失败。形状与出处：
   * `dsh-typert-protocol/lib/types/types.d.ts:525`（`$mount(contribution): Promise<TypertDisposer>`）。
   */
  $mount?(contribution: unknown): Promise<() => void>;
}

/** `remote.settings.mutate` 的路径操作（与内核 `SettingsPathOp` 同构）。 */
type SettingsPathOpLike =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

/** 设置文档：一个命名空间条目（`writable` 是文档级字段，不在条目上）。 */
interface SettingsDoc {
  writable?: boolean;
  hasDocument?: boolean;
  namespaces?: Array<{ ns: string; value?: unknown; revision?: number }>;
}

/**
 * 解包 `describe()` 的返回值，**不假设层数**。
 *
 * 实测踩过的坑：typert 的 RPC 响应形如
 * `{ type:'server-response', result:{ ok:true, value:{ writable, namespaces } } }`，
 * 而 client 侧的 `remote.settings.describe()` 到底返回「已解一层的文档」还是
 * 「完整 RPC 信封」取决于调用侧是否已被 transport 解包——两种都见过。按固定
 * 层数写（`described.value.namespaces` 或 `described.result.value.namespaces`）
 * 都会在另一种形状下恒为 undefined，且**静默失败**：入口直接 return，`settings`
 * 永远停在初值，表现为「插件加载了但幽灵文本从不出���」。
 *
 * 故这里逐层下探到真正带 `namespaces` 的那一层为止，两种形状都能用。
 */
function unwrapSettingsDoc(response: unknown): SettingsDoc | undefined {
let node: unknown = response;
  // 上限 4 层：足以覆盖 {doc} / {value:doc} / {result:{value:doc}} 三种形态，
  // 又不至于在异常结构里自旋。
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== 'object' || node === null) return undefined;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.namespaces)) return record as SettingsDoc;
    if (record.ok === true) { node = record.value; continue; } // RPC 信封（成功）
    if ('result' in record) { node = record.result; continue; } // server-response
    if ('value' in record) { node = record.value; continue; }
    return undefined;
  }
  return undefined;
}

/**
 * `_push` 载荷解析出的结构（#38 后新增 `frame`/`final` 两个可选帧字段）。
 *
 * 必须写成**具名类型**：原先这里是 `let pushed: {…} | null = null` 配
 * `JSON.parse(...) as typeof pushed`，而 `typeof pushed` 取到的是该处**已窄化**的
 * 类型（`= null` 的初始化把它的值类型收成了 `null`），于是 `pushed` 在整个 `next`
 * 字面量里都是 `never`，每一个 `pushed?.x` 都报 TS2339——#34 那 41 条里有 18 条
 * 就是这一处派生的（诊断配置没接进构建，所以长期没人看见）。
 */
type PushedPayload = {
  suggestion?: { turn?: unknown; frame?: unknown; final?: unknown } | null;
  /**
   * `hot` / `history` / `historySessionId` 自 #36 建议 2 起住在**另一格** `_hot`
   * 里（见 {@link HotPushedPayload}）。这里仍留着这三个键只为一个理由：滚动升级期间
   * 新客户端可能连着旧宿主（旧宿主的 `_push` 里带着它们）。读到就照用，读不到就走
   * 「保留现值」——两格都不在时决不能把热度清空。
   */
  hot?: unknown;
  history?: unknown;
  historySessionId?: unknown;
  suggestionSessionId?: unknown;
  /** 建议帧字段的兜底载体（宿主若把帧号打在信封顶层）。 */
  frame?: unknown;
  final?: unknown;
  completion?: { draft?: unknown; text?: unknown; final?: unknown } | null;
  completionSessionId?: unknown;
};

/**
 * `_hot` 载荷解析出的结构（#36 建议 2 拆出的**热度格**）。
 *
 * 缺省语义与建议格同规，但**按格成立**：整格缺省（旧宿主从没写过 `_hot`）= 这一格
 * 没说话 = 保留现值，绝不是「热度清空」。这一条是拆分不伤人的前提——否则旧宿主 +
 * 新客户端会因为读不到 `_hot` 而把热度列表与历史环一起清掉。
 */
type HotPushedPayload = {
  hot?: unknown;
  total?: unknown;
  history?: unknown;
  historySessionId?: unknown;
};

/** 投影键（与 host 端 PROJECTION_KEY 一致）。 */
const PROJECTION_KEY = 'suggestGhost';
/** 幽灵文本的 DOM 标记，用于定位/清理。 */
const OVERLAY_ID = 'dsh-suggest-ghost-overlay';
/** 默认采纳快捷键（与 host 默认一致）。 */
const DEFAULT_ACCEPT_KEY = 'Tab';
/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'suggest-ghost';
/**
 * `settings.section` 的 section id（导航标识）。
 *
 * 必须用**宿主没有的 id**：新 id 会在设置导航里并排新增一页；复用宿主已用的
 * id（如 `general` / `models` / `plugins`）会顶掉那一页。取 `suggest-ghost`
 * 与本插件命名空间一致，便于排查。
 */
const SETTINGS_SECTION_ID = 'suggest-ghost';
/** 设置页导航文案（跟随宿主界面语言；无 locale 服务时回退中文）。 */
const SECTION_LABELS = { zh: '输入预测', en: 'Input prediction' } as const;
/** 未获应答的 pull 最多重试次数（host 可能回一份不含历史的载荷；上限防自旋）。 */
const PULL_MAX_ATTEMPTS = 4;
/**
 * pull 重试的基础退避（毫秒），第 n 次退避 = 基础值 × 2^n ⇒ 600/1200/2400/4800。
 *
 * 2026-10-22 从 200 提到 600 的依据（live 实测的应答路径）：pull 落在 settings 事件
 * 回调里 ⇒ 应答的即时写**必然**被 HMR 事务拒绝 ⇒ 排进泵 ⇒ 下一个 500ms tick 才开写 ⇒
 * 单次写实测 writeMs 0.2~1.6s。也就是说**最早的一拍应答 ≈ 0.7~2.1s 后**，旧值 200ms 的
 * 头两次重试必然打空——而每次打空都是「客户端一次写 + 宿主一轮消费 + 应答/clear 至多
 * 两笔写」，revision 被自己人的重试顶高，反过来把同页/同 ns 的 complete 写撞成
 * `conflict retries exhausted`。重试不是免费的，第一次也要等得起。
 */
const PULL_RETRY_BASE_MS = 600;

/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-suggest-ghost';
/** 所需服务：会话 face + 输入机 face（幽灵必需，rc.7 fiber 激活门控）。
 *
 * `remote` 与 `remote.settings` **都必须声明**，且 `remote.settings` 才是关键：
 * 0.1.7 的 cordis reflect 在读嵌套属性时把键拼成 `` `${associate}.${prop}` ``（见
 * cordis `lib/index.js` 的 `internal/get` 路径），也就是 `ctx.get('remote').settings`
 * 实际查询的是名为 `remote.settings` 的子服务。未声明就读会抛
 * `cannot get property "remote.settings" without inject`，整个 client fiber 失败，
 * Web 启动报 `dsh-suggest-ghost: failed` 并挡住界面。内核
 * `@deepseek-ai/dsh-client-ui-settings` 的 provider 用的正是
 * `inject = ["remote", "remote.settings"]`，本插件照同一写法。
 *
 * `slots` 现在**必须**声明：设置页以 `settings.section` 槽位注册，而 section 的
 * 宿主（`@deepseek-ai/dsh-client-ui-settings-plugins` 等）自己就是
 * `inject = ["slots", "locale"]` —— `slots` 是它们提供的服务，不声明就读不到。
 * `locale` 同样需要（注册本插件的字典 + 解析 nav 文案）。二者都由
 * `package.json` 的 `dsh.client.inject` 声明了对应宿主模块，故实际可达。
 * 缺失时的后果已由「不声明 → `ctx.get('slots')` 为 undefined → 跳过设置页」
 * 退化为「声明 → 宿主若不提供则 park 整个插件」，二者不可兼得；因为
 * `dsh-client-ui-settings` 已是 manifest 依赖，park 风险为零，故选择声明。 */
const inject = ['conversation', 'sessions', 'remote', 'remote.settings', 'slots', 'locale'];

/** composer 的双代选择器：≤0.1.1 是 textarea，0.1.2 起是 Lexical contenteditable
 * （`data-composer-input` 标记，属 data-input-scroll 容器）。 */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]';

/** 元素是否为会话输入框（textarea 或 composer contenteditable，均须位于 data-input-scroll 内）。 */
function isComposerElement(el: Element | null): boolean {
  if (el === null) return false;
  const composer = el.closest('[data-input-scroll]') !== null
    && (el.matches('textarea') || (el instanceof HTMLElement && el.isContentEditable));
  return composer;
}

/** 事件目标是否为会话输入框。 */
function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isComposerElement(target);
}

/** 光标是否位于输入框文本末尾：textarea 用 selectionStart/End，contenteditable 用 Selection API。 */
function caretAtComposerEnd(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === '') return true; // 空编辑器：光标必然在末尾（LLM 模式场景）
  const range = selection.getRangeAt(0);
  // 编辑器最后一个文本节点末尾
  let last: Node | null = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  // 或光标落在编辑器最后一个子节点之后（Lexical 常见形态）
  return range.endContainer === el && range.endOffset === el.childNodes.length;
}

/** 快捷键匹配：修饰键 + 主键（主键表见 keyspec.ts），如 Tab、Alt+S、Ctrl+Enter。
 * 修复：字母/数字主键此前按 event.code === 'S' 匹配，实际 code 是 'KeyS'，
 * 导致单字符 spec 永远无法命中；现统一经 keyCodeOf 映射。 */
function parseAcceptKey(spec: string): ((event: KeyboardEvent) => boolean) | undefined {
  const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === undefined) return undefined;
  return (event) => event.code === keyCode
    && event.altKey === mods.has('alt')
    && event.ctrlKey === mods.has('ctrl')
    && event.metaKey === mods.has('meta')
    && event.shiftKey === mods.has('shift');
}

/**
 * 当前应显示的幽灵内容：LLM 建议（完整文本）或历史补全（已输入前缀 + 剩余后缀）。
 *
 * 每个形态都带一份 **归一化后的帧提示** `frame`（#38）：
 *  - `llm` ← `_push.suggestion` 的 `frame`/`final`；
 *  - `inline` ← `_push.completion` 的 `final`（本期宿主不给续写出帧号，见 accept-guard.ts 末段帧判据）；
 *  - `history` ← 本地候选，不是一次「生成」，恒为 {@link LEGACY_FRAME_HINT}。
 * 采纳链（Tab / `→`）据此拒绝 provisional 帧；缺省即旧载荷行为不变。
 */
type GhostContent =
  | { kind: 'llm'; text: string; acceptKey: string; frame: FrameHint }
  | { kind: 'history'; prefix: string; suffix: string; full: string; frame: FrameHint }
  /** 停顿续写：LLM 生成的草稿延续（prefix=当时草稿，suffix=续写文本，full=prefix+suffix）。 */
  | { kind: 'inline'; prefix: string; suffix: string; full: string; frame: FrameHint };

/**
 * overlay 绘制所需的最小形状（{@link decideOverlayPaint} 的入参）。
 *
 * `anchorText` 是**几何**意义上的锚定文本（尾巴从哪起画），与形态判据无关：
 * 它相同只代表「尾巴的起点没变」，因而行尾坐标在没有滚动/尺寸事件时不可能移动。
 */
const overlayShapeOf = (content: GhostContent): OverlayShape => ({
  kind: content.kind,
  anchorText: content.kind === 'llm' ? '' : content.prefix,
  suffixText: content.kind === 'llm' ? content.text : content.suffix,
});

/**
 * 幽灵文本 overlay 管理器：在输入框（textarea / Lexical contenteditable）上
 * 创建/更新/移除灰色覆盖层。
 *
 * ## 定位契约（实测结论，勿凭直觉改符号）
 *
 * 宿主 composer 的 DOM 是**两层**，滚动发生在编辑器**外面**：
 *
 * ```
 * div[data-input-scroll]   .scroll  overflow-y:auto; max-height:336px  ← 滚动容器
 * └─ div .grow             position:relative                            ← offsetParent
 *    ├─ div[data-composer-input]                                        ← 编辑器，overflow:visible，scrollTop 恒 0
 *    └─ div[data-composer-placeholder]
 * ```
 *
 * overlay 被追加到 `.grow` 内，而 `.grow` 是滚动容器的**子节点**——也就是说
 * overlay 处在「被滚动的内容」坐标系中，滚动时与正文**一起**位移。因此
 * **不需要、也不能做滚动补偿**（这是最容易写错的一处）：
 *
 * 实测（`.grow` 上放探针，`max-height:336px`，草稿 30 行）：
 * | scrollTop | 正文 top | `offsetTop+pad` 公式 | 再减 scrollTop |
 * |---|---|---|---|
 * | 0   | 304 | 304 ✅ | 304 ✅ |
 * | 120 | 184 | 184 ✅ | 64 ❌  |
 * | 384 | -80 | -80 ✅ | -464 ❌ |
 *
 * 结论：**只用 `offsetTop + padding`**（`offsetTop` 相对 offsetParent，与滚动
 * 无关）。幽灵已随内容滚动，再减一次是**双重补偿**，会产生 `-scrollTop` 的漂移
 * ——草稿越长越明显，正是「滚动后幽灵压在别的文字上」的成因。
 * 回归测试见 `scripts/ghost-geom-smoke.mjs`。
 *
 * ## 重叠防护
 *
 * 显示前做一次几何自检（见 {@link verify}）：幽灵若未落在编辑器内容原点上
 * （宿主 DOM 结构变化导致坐标系假设失效），宁可不显示，也不糊在正文上。
 */
/**
 * #113：一条帧痕迹记录。**只有四个数字，没有任何正文** —— 与 `stream frame … chars=`
 * 那条留痕完全同一口径（隐私红线：DOM 侧也不许把用户可见文本抄进属性）。
 * `final` 用 1/0 而不是 boolean：判据 1 要求与留痕**逐格对齐**，同一套字面量最省事。
 */
interface StreamFrameRecord {
  readonly frame: number;
  readonly final: 0 | 1;
  readonly chars: number;
  readonly t: number;
}

class GhostOverlay {
  private readonly el: HTMLDivElement;
  private composer: HTMLElement | null = null;
  /**
   * 滚动容器（`[data-input-scroll]`）。
   *
   * 定位**不用**它（overlay 随内容自动滚动），保留它只为了挂 `scroll` 监听：
   * 滚动会使内容相对视口位移，需要触发一次重对齐与自检。
   */
  private scroller: HTMLElement | null = null;
  private readonly onScroll: () => void;
  private readonly onResize: () => void;
  private readonly styleTag: HTMLStyleElement;
  /** 尺寸变化观察者：composer 自动增高/附件行出现/字体回流都会改变内容起点。 */
  private resizeObserver: ResizeObserver | null = null;
  /** 正在显示的内容（供 ResizeObserver 回调重对齐后重新自检）。 */
  private current: GhostContent | null = null;
  /**
   * 上一次**成功绘制**的形状（#38 快路径的输入）。与 `current` 同步更新，
   * 但 `hide()` / 自检被拦时一并清空——快路径只能在「屏幕上真有幽灵」时走。
   */
  private shape: OverlayShape | null = null;
  /** overlay 当前是否真的在绘制（`display:block` 且 `verify()` 通过、`data-shown="1"`）。 */
  private painted = false;
  /**
   * 锚点脏标记：自上次全量对齐后发生过滚动 / 尺寸变化 / 重新挂载，则行尾坐标**可能**
   * 已移动，增长帧最多只能轻量重测一次，不能零测量。
   */
  private anchorDirty = true;
  /** 上次全量对齐量到的行尾锚点（null = 没量过 / llm 形态没有行尾锚点）。 */
  private anchor: AnchorPoint | null = null;
  /** 最近一次绘制是否走了增长快路径（错峰补渲染据此跳过重复重画）。 */
  private lastPaintWasGrowth = false;
  /** 绘制计数（留痕与冒烟外部可观测；只有数字，没有正文）。 */
  private paintStats = { growth: 0, remeasure: 0, rebuild: 0 };

  /**
   * #113：把本回合的逐帧痕迹写到**既有 overlay 节点**的 dataset 上，让"回合结束之后
   * 还能不能重建这张表"有答案 —— 判据是纯读 DOM，不依赖任何 console 捕获。
   *
   * 为什么落在 overlay 而不是新开一个全局对象：全局对象要自己管生命周期，而本插件
   * 一个页面里可能有多条 fiber（热重载/多实例），全局会打架；overlay 节点随 fiber 的
   * `destroy()` 一起消失，天然对齐。
   *
   * ⚠️ 与取证脚本的约定：本属性**只由本方法写**。外部若只是清空 `textContent` /
   * 改 `display` / 重新绘制，属性不受影响（已核：`scripts/cross-kernel` 那边没有
   * 替换节点的动作）；但若谁**替换/重建 overlay 节点**，痕迹会随之消失 —— 那属于
   * 换了载体，不是本条要保的性质，别在这里偷偷兜。
   */
  setStreamFrames(list: readonly StreamFrameRecord[]): void {
    if (list.length === 0) {
      delete this.el.dataset.streamFrames;
      return;
    }
    this.el.dataset.streamFrames = JSON.stringify(list);
  }

  constructor() {
    this.el = document.createElement('div');
    this.el.id = OVERLAY_ID;
    this.el.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'white-space:pre-wrap',
      'word-break:break-word',
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 对齐官方 composer placeholder 的色阶（label-caption，全透明度），
      // 而非更重的 label-secondary：保证「幽灵」比正文明显更淡。
      'color:var(--dsw-alias-label-caption, #9aa0a6)',
      // 轻微同色泛光（贴身 1px + 8px 柔光晕）：与原生 placeholder 区分，
      // 提示这是「可采纳的建议」而非占位文案；同色晕不改变色相、暗/亮主题通用。
      'text-shadow:0 0 1px var(--dsw-alias-label-caption, #9aa0a6), 0 0 8px var(--dsw-alias-label-caption, #9aa0a6)',
      'z-index:1',
      // 初值：不绘制。用 display（而非旧版的 visibility）——见下方 show()/hide()
      // 与类注释，display 让节点彻底退出渲染，避免任何过渡期双绘。
      'display:none',
    ].join(';');
    this.onScroll = () => { this.anchorDirty = true; this.alignAndVerify(); };
    this.onResize = () => { this.anchorDirty = true; this.alignAndVerify(); };
    // 幽灵激活时隐藏原生 placeholder（二者同位置，避免重叠）。
    // 状态标记打在**我们自己的 overlay 节点**上（data-shown），经 body:has() 关联
    // 占位元素——React/Lexical 重渲染会剥掉编辑器上的外来类（实测发生过），而
    // overlay 是插件私有节点不受影响，且与 DOM 顺序、textarea/contenteditable
    // 形态无关。规则覆盖两代 composer：
    //  - textarea：原生 ::placeholder 伪元素；
    //  - contenteditable（0.1.2 Lexical）：placeholder 是 `.grow` 内的兄弟节点，
    //    带 `data-composer-placeholder` 稳定属性钩子。
    //
    // 实测要点：宿主的 placeholder 节点**仅在 `showPlaceholder` 为真时渲染**
    // （草稿非空时不渲染，实测 `querySelectorAll` 计数为 0），所以选择器在
    // 「草稿非空」这一历史补全场景下本就无处命中；真正需要它的是 LLM 建议场景
    // （草稿为空、占位文案在场）。因此三条规则都给上，任一条命中即可：
    //
    // **用 display:none / visibility:hidden，而不是旧版的 opacity:0**：opacity
    // 虽不脱离布局、但仍是绘制的一部分，且过渡期里占位与幽灵会同帧可见。旧实现
    // 只在 `[data-composer-placeholder]` 上写 opacity:0，一旦该节点尚未挂载或
    // 结构变化，规则就静默空转——这正是「幽灵叠在占位文案上」的第二个来源。
    // `[data-composer-input]` 的 `data-placeholder` 属性是宿主渲染即带的（与本
    // 插件无关），作为兜底钩子，不依赖节点的增删时机。
    this.styleTag = document.createElement('style');
    this.styleTag.dataset.pluginCss = 'dsh-suggest-ghost';
    this.styleTag.textContent = [
      // ── 让位规则：幽灵**正在显示**时，placeholder 必须让位 ──
      //
      // 判据同时要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏。
      // 只写 `data-shown` 不够：`hide()` / 自检失败路径会把 display 置回 none，
      // 若此时仍据 `data-shown` 或「节点存在」去隐藏 placeholder，就会出现
      // 「幽灵没显示、占位文案也没了」——草稿清空后输入框一片空白（实测过）。
      // 反过来只据「节点存在」同样错：节点在首次 show 后就常驻 DOM 不移除。
      //
      // `:not([style*="display: none"])` 读的是内联 style（本插件唯一写 display
      // 的地方），故与自身写入的状态严格同步，无属性时序竞态。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-placeholder]{display:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) textarea::placeholder{visibility:hidden!important}',
      // 兜底：编辑器自带 data-placeholder 属性的伪元素（部分宿主形态）以及
      // 依赖 `[data-placeholder]` 出文案的 ::before/::after 实现。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::before{content:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::after{content:none!important}',
    ].join('\n');
    if (typeof document !== 'undefined') document.head.appendChild(this.styleTag);
  }

  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea(): HTMLElement | null {
    return this.composer;
  }

  /** 绑定到当前输入框（若变化则重建对齐）。 */
  private attach(composer: HTMLElement): void {
    if (this.composer === composer) return;
    this.detach();
    this.composer = composer;
    // 滚动容器：只为挂 scroll 监听（定位不用它，见类注释的实测表格）。
    this.scroller = composer.closest<HTMLElement>('[data-input-scroll]');
    // 挂载点：`.grow` 是宿主显式 `position:relative` 的 offsetParent，且位于滚动
    // 容器内部——overlay 放这里才能随内容一起滚动。**不再改写宿主样式**（旧实现
    // 在 static 时强写 relative，会污染宿主布局，且对已经是 relative 的 .grow
    // 毫无作用）。
    const parent = composer.parentElement;
    if (parent !== null) parent.appendChild(this.el);
    composer.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroller?.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);
    // 尺寸变化（自动增高、附件行、字体回流）也会移动内容起点，必须重对齐。
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(composer);
      if (this.scroller !== null) this.resizeObserver.observe(this.scroller);
      if (parent !== null) this.resizeObserver.observe(parent);
    }
    // 换了挂载点，坐标系整个变了：锚点必须重测，快路径在此之前不得命中。
    this.anchorDirty = true;
    this.alignAndVerify();
  }

  /**
   * 复位绘制状态（hide / detach / 自检被拦都走这里）。
   *
   * 快路径的前提是「屏幕上已经有一枚自检通过的幽灵」，所以任何让 overlay 退出绘制的
   * 动作都必须把 `painted`/`shape` 一起摘掉，否则下一帧会在没画出来的节点上只改文本。
   */
  private resetPaintState(): void {
    this.painted = false;
    this.shape = null;
    this.anchor = null;
    this.anchorDirty = true;
    this.lastPaintWasGrowth = false;
  }

  private detach(): void {
    if (this.composer !== null) {
      this.composer.removeEventListener('scroll', this.onScroll);
      this.composer = null;
    }
    if (this.scroller !== null) {
      this.scroller.removeEventListener('scroll', this.onScroll);
      this.scroller = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.current = null;
    this.resetPaintState();
    this.el.dataset.shown = '0';
    this.el.style.display = 'none';
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }

  /**
   * 对齐 overlay 到输入框内容区（含 padding 起点）。
   *
   * ## 为什么**不做**滚动补偿（实测结论，勿回退）
   *
   * overlay 挂在 `.grow` 上，而 `.grow` 是滚动容器 `[data-input-scroll]` 的**子
   * 节点**——即 overlay 位于「被滚动的内容」坐标系里。滚动容器滚动时 `.grow`
   * 整体一起位移（实测 `scrollTop=120` 时 `.grow` 的 rect.top 同步上移 120），
   * 因此 overlay **自动跟随内容滚动，无需任何 scrollTop 项**。
   *
   * 实测反证（`.grow` 上的探针元素，`scrollTop=120`）：
   *  - `rect 差 - scrollTop` → 幽灵落在 `64`，正文在 `184`：**漂移 `-scrollTop`**；
   *  - `rect 差 + scrollTop` → 幽灵恒定不动，漂移 `+scrollTop`；
   *  - `offsetTop + paddingTop`（**本实现**）→ 与正文逐像素重合（5 个滚动位置全对）。
   *
   * 另注：rect 差在这里恒为 0（`.grow` 与编辑器一起移动、同点），用它会把真实的
   * 内容偏移丢掉；`offsetTop/offsetLeft` 相对 `offsetParent`，与滚动无关，才是
   * 「内容坐标系」里的正确坐标。
   */
  private align(): void {
    const ta = this.composer;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    // 内容起点 = 编辑器在 offsetParent（.grow）内的偏移 + border + padding。
    // offsetTop/offsetLeft 与滚动无关，正是「内容坐标系」里的正确坐标。
    const originLeft = ta.offsetLeft + borderLeft + padLeft;
    const originTop = ta.offsetTop + borderTop + padTop;
    // 宽度：编辑器内容宽 = clientWidth - 左右 padding（border-box 下 clientWidth
    // 已含 padding、不含 border）。
    const fullWidth = ta.clientWidth - padLeft - padRight;
    let left = originLeft;
    let top = originTop;
    let width = fullWidth > 0 ? fullWidth : ta.clientWidth;

    // ── 历史补全：锚定到「DOM 量出的草稿行尾」，而非靠隐形 prefix 撑位 ─────────
    // 视口坐标下的内容原点，与 originLeft/originTop 是同一位置的不同坐标系；
    // 两者之差把 caret 的视口位置换算成 offsetParent 坐标系里的位移。
    const taRect = ta.getBoundingClientRect();
    const originViewportX = taRect.left + borderLeft + padLeft;
    const originViewportY = taRect.top + borderTop + padTop;
    const end = this.current !== null && this.current.kind !== 'llm'
      ? this.draftEndRect()
      : null;
    // 全量对齐即「锚点已知」：记下这次量到的行尾，并清掉脏标记。
    // 增长快路径据此决定要不要再测（{@link anchorMovedBeyond}）。
    this.anchor = end === null ? null : { right: end.right, top: end.top };
    this.anchorDirty = false;
    if (end !== null) {
      left = originLeft + (end.right - originViewportX);
      // `end` 是末字符矩形：其 top 是**文本顶部**（字形墨迹上缘），不是行框顶部。
      // overlay 的 top 定位的是行框顶部，而 overlay 内文本会在 line-height 行框里
      // 垂直居中——若直接用 end.top 对齐行框顶，幽灵文本会比正文低
      // (lineHeight - 字高)/2（本例 ≈2px，正是用户报的"高度不一致"）。
      // 所以要把这段行内偏移扣掉，让 overlay 的**文本**与正文的**文本**同高。
      const lineHeight = parseFloat(style.lineHeight);
      const lineOffset = Number.isFinite(lineHeight) && lineHeight > 0 && end.height > 0
        ? Math.max(0, (lineHeight - end.height) / 2)
        : 0;
      top = originTop + (end.top - originViewportY) - lineOffset;
      // 后缀只能在「行尾到行末」这段空间里换行，与编辑器继续输入时的行为一致。
      width = Math.max(0, fullWidth - (left - originLeft));
    }
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.width = `${width}px`;
    // ── 文本排版属性整组照搬 ───────────────────────────────────────────────
    // 位置已不依赖排版，但后缀**自身**的换行仍需与编辑器一致（否则长建议会溢出
    // 到错误的位置）。宿主 `overflow-wrap: anywhere` 可在拉丁词内断行，逐项复制
    // 比逐项猜测可靠。
    const TEXT_LAYOUT_PROPS = [
      'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'font-stretch',
      'font-feature-settings', 'font-kerning',
      'font-variant-ligatures', 'font-variant-east-asian',
      'font-variant-caps', 'font-variant-numeric', 'font-variant-alternates', 'font-variant-position',
      'font-size-adjust', 'font-synthesis', 'font-optical-sizing',
      'line-height', 'letter-spacing', 'word-spacing',
      'white-space', 'overflow-wrap', 'word-break', 'tab-size', 'text-indent',
      'direction', 'writing-mode',
      'text-rendering', 'text-size-adjust', '-webkit-text-size-adjust',
      '-webkit-font-smoothing', '-moz-osx-font-smoothing',
    ] as const;
    for (const prop of TEXT_LAYOUT_PROPS) {
      this.el.style.setProperty(prop, style.getPropertyValue(prop));
    }
    this.el.style.boxSizing = 'border-box';
  }

  /**
   * 对齐后做几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 判据（依据实测，不是推测）
   *
   * overlay 是 `.grow` 的子节点，随内容一起滚动——所以「幽灵跑到滚动视口外」是
   * **正常且正确**的（正文也一起滚出去了，被滚动容器裁掉）。因此**不能**用
   * 「必须落在滚动视口内」当判据：实测 `scrollTop=384` 时幽灵与正文同在
   * `top=-80`，两者都被裁掉，这是正确的。
   *
   * 真正要防的是**定位失真**：overlay 没有落在编辑器内容原点上（例如宿主要
   * 在 `.grow` 与编辑器之间插入带 padding/border 的新层，或 `.grow` 不再是
   * offsetParent）。此时幽灵会浮在别的内容上——就是用户报告的重叠。
   *
   * 判据：幽灵左上角与「编辑器在 offsetParent 内的内容原点」之差必须在一个
   * 行高量级内。偏差超过一行，说明坐标系假设已被宿主破坏，放弃显示。
   */
  /**
   * 量出草稿在编辑器里的**真实行尾**（最后一行最后一个字符之后的位置）。
   *
   * 必须逐文本节点取、且只取**最后一个非空文本节点的末字符**矩形：
   * `range.selectNodeContents(editor)` 返回的是**块级 `<p>` 的整行矩形**，
   * 多行时其 `right` 是第一行的行尾——拿它当"草稿末尾"会算出几百像素的假重叠
   * （本仓库实测踩过两次）。
   */
  private draftEndRect(): DOMRect | null {
    const ta = this.composer;
    if (ta === null) return null;
    const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text;
      if (text.nodeValue && text.nodeValue.length > 0) last = text;
    }
    if (last === null) return null;
    const end = last.nodeValue.length;
    const range = document.createRange();
    range.setStart(last, Math.max(0, end - 1));
    range.setEnd(last, end);
    const rect = range.getBoundingClientRect();
    // 行尾是空白字符时矩形宽度可能为 0，但 left/right 仍有位置意义。
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  /** 记录一次自检失败的原因（留在 `data-reject` 上供现场取证）并判为不显示。 */
  private rejectAs(reason: string): false {
    this.el.dataset.reject = reason;
    return false;
  }

  /**
   * 几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 两种形态判据不同（历史补全已改为锚定，不再检查原点）
   *
   *  - **历史补全**：幽灵的左上角必须正好落在 DOM 量出的草稿行尾（±4px）。
   *    另外要求 caret 本身落在编辑器自己的盒子里——这是为了拦住「量到游离/陈旧
   *    节点」的情形：游离节点的矩形是**全 0**，若不拦，锚点会被算到屏幕左上角。
   *  - **LLM 建议**（草稿为空、整段从内容原点起）：仍按原点判据，并额外确认
   *    占位文字**确实已让位**——否则幽灵就是叠在占位文案上（用户第一张截图）。
   *
   * 失败原因写进 `data-reject`：把「偶发重叠」变成「偶发没幽灵 + 一条可读证据」。
   */
  private verify(): boolean {
    const ta = this.composer;
    if (ta === null) return false;
    const host = this.el.offsetParent;
    if (!(host instanceof HTMLElement)) return false;
    // 调用方已保证此刻元素是 `display:block`（见 alignAndVerify），此处 rect 可信。
    const ghostRect = this.el.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const lineHeight = parseFloat(style.lineHeight);
    const tolerance = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;

    if (this.current !== null && this.current.kind !== 'llm') {
      const end = this.draftEndRect();
      if (end === null) return this.rejectAs('no-caret');
      if (end.right < taRect.left || end.right > taRect.right + 1
        || end.top < taRect.top - 1 || end.top > taRect.bottom + 1) {
        return this.rejectAs('caret-outside-editor');
      }
      const dx = Math.round(ghostRect.left - end.right);
      // overlay 顶被刻意上移了行内偏移（让 overlay 内文本与正文字形同高），
      // 所以 overlay.top ≈ end.top - lineOffset，dy 会是一个约 -2px 的负值——
      // 允许 [-(lineHeight-end.height)/2 - 4, +4] 区间，仍拦住真正的坐标系错位。
      const lineOff = Number.isFinite(lineHeight) && lineHeight > 0 && end.height > 0
        ? Math.max(0, (lineHeight - end.height) / 2) : 0;
      const dy = Math.round(ghostRect.top - end.top);
      if (Math.abs(dx) > 4 || dy > 4 || dy < -(lineOff + 4)) {
        return this.rejectAs(`anchor-drift dx=${dx} dy=${dy}`);
      }
    } else {
      if (Math.abs(ghostRect.top - (taRect.top + borderTop + padTop)) > tolerance) return this.rejectAs('origin-drift-y');
      if (Math.abs(ghostRect.left - (taRect.left + borderLeft + padLeft)) > tolerance) return this.rejectAs('origin-drift-x');
      const placeholder = document.querySelector('[data-composer-placeholder]');
      if (placeholder !== null && getComputedStyle(placeholder).display !== 'none') {
        return this.rejectAs('placeholder-visible');
      }
    }
    // host 必须仍包含编辑器（否则 overlay 挂在了不相干的层上）。
    if (!(host.contains(ta) || host === ta.parentElement)) return this.rejectAs('host-mismatch');
    delete this.el.dataset.reject;
    return true;
  }

  /**
   * 对齐 + 自检；自检失败则隐藏（保持 current 以便下次事件重试）。
   *
   * ## 两条顺序约束（都踩过坑，勿调换）
   *
   * 1. **必须先 `display:block` 再测量**：`getBoundingClientRect()` 对
   *    `display:none` 的元素恒返回全 0，先测量会把每次首帧都判为「空矩形 →
   *    不可显示」，`display` 永远停在 `none`——表现为幽灵彻底不出现。
   *
   * 2. **必须在显示之前就 `data-shown="1"`**：placeholder 的隐藏规则
   *    （`body:has(#…[data-shown="1"]) [data-composer-placeholder]{display:none}`）
   *    挂在 `data-shown` 上。若先 `display:block` 再标 `data-shown`，中间就存在
   *    一个「幽灵已可见、placeholder 还没隐藏」的窗口——两者同原点，直接重叠
   *    （实测：该窗口内 placeholder 的 computed display 仍是 block）。
   *
   * 注意两者是**不同元素上的两个开关**，互不冲突：
   *  - `data-shown` 打在 overlay 自身（控制 placeholder 是否让位）；
   *  - `display` 打在 overlay 自身（控制幽灵是否绘制）。
   * 因此正确顺序是：**先标 `data-shown` 让位 → 再 `display:block` → 测量自检
   * → 不合格则把两者一起回退**。
   */
  private alignAndVerify(): void {
    if (this.current === null) return;
    this.align();
    // ① 先让 placeholder 让位（此时幽灵尚未绘制，不会出现双绘窗口）。
    this.el.dataset.shown = '1';
    // ② 再让它参与布局，否则下一步的 rect 测量恒为 0。
    this.el.style.display = 'block';
    if (!this.verify()) {
      // ③ 自检不合格：两个开关一起回退，避免「幽灵不画但 placeholder 已让位」
      //    造成占位文案凭空消失。绘制状态同步摘掉——**增长快路径的前提就是这一位**，
      //    不摘就会在没有真的画出来的节点上只改文本（verify 的语义不许改）。
      this.painted = false;
      this.el.style.display = 'none';
      this.el.dataset.shown = '0';
      return;
    }
    this.painted = true;
  }

  /**
   * 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。
   *
   * ## 两条路径（#38 第 2 条）
   *
   *  - **全量**（现状）：`textContent=''` 重建后缀 span → `align()` → `verify()`，
   *    两轮强制同步布局。形态变化、首次显示、自检被拦后的重试都走它。
   *  - **增长快路径**：同一次生成的文本变长（形态与锚定文本都没变、新后缀以旧后缀
   *    开头）**只改后缀 span 的文本**：
   *     - 锚点未脏（其间没有滚动/尺寸/重挂载事件）→ 一次测量都不做；
   *     - 锚点脏了 → 只量一次行尾，位移不超过 {@link ANCHOR_REDRAW_TOLERANCE_PX}
   *       就不重排，超了才落回全量。
   *    快路径**不碰** `display` / `data-shown`：进入它的前提是两者已一致且自检刚通过，
   *    因此上面那两条顺序约束与「verify 失败即不绘制」都原样保持。
   *
   * @param content - 本帧要显示的幽灵内容。
   */
  show(content: GhostContent): void {
    const next = overlayShapeOf(content);
    const action = decideOverlayPaint({
      prev: this.shape,
      next,
      painted: this.painted,
      anchorDirty: this.anchorDirty,
    });
    if (action !== 'rebuild' && this.applyGrowthText(content, next)) {
      this.current = content;
      this.shape = next;
      this.lastPaintWasGrowth = true;
      if (action === 'grow-only') {
        this.paintStats.growth += 1;
        return;
      }
      // 锚点脏：轻量量一次行尾（一次 Range 测量），没超阈值就不重排。
      this.paintStats.remeasure += 1;
      const rect = this.draftEndRect();
      const point: AnchorPoint | null = rect === null ? null : { right: rect.right, top: rect.top };
      if (point !== null && !anchorMovedBeyond(this.anchor, point)) {
        this.anchor = point;
        this.anchorDirty = false;
        return;
      }
      // 行尾真的移动了（或量不到）：落回全量重排。
    }
    this.rebuild(content, next);
  }

  /** 全量重建 + 对齐 + 自检（现状路径）。 */
  private rebuild(content: GhostContent, next: OverlayShape): void {
    this.el.textContent = '';
    this.buildText(content);
    this.current = content;
    this.shape = next;
    this.lastPaintWasGrowth = false;
    this.paintStats.rebuild += 1;
    // 先按当前几何定位，再由自检决定是否真的绘制（防止第一帧就糊在正文上）。
    this.alignAndVerify();
  }

  /** 全量建文本节点：llm 整段文本；其余只渲染后缀（锚定由 align() 负责）。 */
  private buildText(content: GhostContent): void {
    if (content.kind === 'llm') {
      this.el.textContent = content.text;
      return;
    }
    // 只渲染后缀。**不再**用「隐形 prefix 撑出草稿宽度」定位——那要求 overlay
    // 自己的排版与编辑器逐像素一致，一旦某帧不成立（实测：prefix 撑出 0 宽），
    // 后缀就从内容原点起画，直接压在用户草稿上。位置改由 align() 用 DOM 量出的
    // 草稿行尾锚定，与本元素的排版完全解耦。
    const suffix = document.createElement('span');
    suffix.textContent = content.suffix;
    this.el.append(suffix);
  }

  /**
   * 增长帧的文本写入：后缀 span **只改文本**，不重建节点。
   *
   * @returns false = 结构对不上（节点被外来者摘走 / 形态与节点形状不符），调用方落回全量。
   */
  private applyGrowthText(content: GhostContent, next: OverlayShape): boolean {
    if (content.kind === 'llm') {
      // llm 形态是裸文本，没有 span 结构可依赖；只要节点仍是 overlay 自己即可整段替换。
      this.el.textContent = next.suffixText;
      return true;
    }
    const holder = this.el.firstElementChild;
    if (holder === null || holder.textContent === undefined) return false;
    // 长度单调已由判据保证（同一次生成的文本只会长），这里直接改尾巴那一个节点。
    holder.textContent = next.suffixText;
    return true;
  }

  /** 屏幕上是否正有一枚「靠增长快路径维持」的幽灵（错峰补渲染据此让路）。 */
  get growing(): boolean {
    return this.painted && this.lastPaintWasGrowth;
  }

  /** 是否已绘制（自检通过）。 */
  get isPainted(): boolean {
    return this.painted;
  }

  /** 绘制计数（只有数字；留痕用，见 `renderTraced` 的 tally 出口）。 */
  get paints(): Readonly<{ growth: number; remeasure: number; rebuild: number }> {
    return this.paintStats;
  }

  hide(): void {
    this.current = null;
    this.resetPaintState();
    this.el.style.display = 'none';
    this.el.textContent = '';
    this.el.dataset.shown = '0';
    delete this.el.dataset.reject;
  }

  dispose(): void {
    this.detach();
    this.styleTag.remove();
  }
}

/** 浏览器插件主体。 */
/**
 * 取 `remote` 服务（读 `remote.settings` 用）。
 *
 * **必须走 `ctx.get('remote')`，不能读 `ctx.remote` 属性。** 0.1.7 的 client runner
 * 用 `dynamicCordisContext` 把插件 ctx 换成严格门控 Proxy：任何非动词属性读取都走
 * `readService(prop, true)`，未在插件 `inject` 里声明就抛
 * `cannot get property "remote" without inject`，整个 client fiber 失败。
 *
 * 且 `inject` 里**必须同时声明 `remote.settings`**：cordis reflect 读嵌套属性时把键
 * 拼成 `remote.settings` 这个独立子服务名，未声明即抛
 * `cannot get property "remote.settings" without inject`（这正是本插件此前
 * `dsh-suggest-ghost: failed` 的真实原因）。
 */
const remoteOf = (ctx: Context): RemoteLike | undefined => ctx.get('remote') as RemoteLike | undefined;

/**
 * 设置 scope 的快照**信封**（卡片按此形状读取：`snap.status` / `snap.value` /
 * `snap.writable`）。见 `remoteSettingsScope()` 的说明。
 */
export interface ScopeSnapshot {
  /** `loading` = 尚未从 host 取到；`ready` = 已取到；`unavailable` = 命名空间缺失。 */
  readonly status: 'loading' | 'ready' | 'unavailable';
  /** 命名空间当前解析值（含 `_push` / `_ops` 两个 JSON 字段）。 */
  readonly value: Record<string, unknown>;
  /** host 是否允许写入（旧宿主缺省视为可写）。 */
  readonly writable: boolean;
}

/**
 * 设置页的导航文案。
 *
 * 宿主每次投影 `settings.section` 的 `label` 时都会重读这个 thunk，所以语言
 * 切换后无需重新注册 section。locale 服务缺失（旧宿主组合）时回退中文，与
 * useGhostT 的降级行为一致。
 * @param locale - 宿主 locale 服务；可为 undefined。
 */
const sectionLabel = (locale: LocaleFaceLike | undefined): string => {
  const active = locale === undefined ? 'zh' : locale.getSnapshot().active;
  return active === 'en' ? SECTION_LABELS.en : SECTION_LABELS.zh;
};

function applyInner(ctx: Context): void {
  // rc.7：所需核心服务已由 `inject` 声明，fiber 激活门控保证可用；ctx.get 可选读取。
  applyBody(ctx);
}

/** applyInner 的主体（原函数体）。 */
function applyBody(ctx: Context): void {
  /**
   * `as unknown as ClientSessionsSurface` 是**类型面**修正，不是逻辑修正（#81）：
   * 拿到的对象运行时一直是宿主客户端服务，只是 tsc 顺着内核服务映射把它读成了服务端
   * `SessionStore`。断言写在**取得这一处**而不是每个调用点，是为了让「面接错」只剩一个
   * 可审的落点；`undefined` 分支保持原样，早退判据一字未动。
   */
  const sessions = ctx.get('sessions') as unknown as ClientSessionsSurface | undefined;
  if (sessions === undefined) return;
  const overlay = new GhostOverlay();
  let lastSessionId: string | undefined;

  // ── localStorage 持久化：冷启动立即恢复历史/热度/建议，避免等待 host RPC ──
  const CACHE_KEY = 'dsh-suggest-ghost:cache';
  type CachedData = {
    hot?: readonly { text: string; count: number }[] | null;
    history?: readonly string[];
    historySessionId?: string | null;
    suggestion?: typeof settings.suggestion;
    /** 帧提示（#38）。旧缓存没有这一项 → 读回时按 {@link LEGACY_FRAME_HINT} 兜底。 */
    suggestionFrame?: FrameHint;
    suggestionSessionId?: string | null;
  };
  const loadFromCache = (): CachedData => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw === null) return {};
      return JSON.parse(raw) as CachedData;
    } catch { return {}; }
  };
  const saveToCache = (data: CachedData): void => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* quota exceeded */ }
  };
  // 启动时立即从缓存恢复，让插件在 host RPC 完成前就有数据可用。
  const cached = loadFromCache();
  let bound: {
    session: ObservableSnapshot<unknown>;
    input: InputFaceLike;
    projectionFace: ObservableSnapshot<unknown>;
  } | null = null;
  /**
   * 当前显示的幽灵。`base` 是**算出这份 content 时**所用的草稿快照
   * （draft 文本 + 宿主 draftRev），两条采纳路径都以它为 CAS 基线：写入前
   * 重读快照，与 base 不一致就说明用户在此期间又打了字，本次采纳放弃（#4）。
   */
  let shown: { key: string; content: GhostContent; base: DraftSnapshot } | null = null;
  /** IME 组词进行中（compositionstart~end 之间）：组合预览文本与幽灵后缀
   * 会叠在同一位置，必须抑制幽灵显示（Cursor/VSCode 同款处理）。 */
  /** 上一次「续写不显示」的理由，用于把每帧都要跑的判定压成状态变化时一行。 */
  let lastCompletionSkip = '';
  /**
   * 帧台账（#38）：按 `(会话, turn)` 记下已见过的最大帧号，比它小的载荷整条丢弃。
   * 只在 `applySettings` 解析 `_push` 时读写，页面级、不持久化（重开页面由宿主
   * 对账推送重建，同帧重发本来就必须放行）。
   */
  let frameLedger: FrameLedger = emptyFrameLedger();
  /**
   * #39：各处「判据在跑」的留痕闸口——**按理由变化才打**。
   *
   * 每帧都跑判定是这些分支的共同点（`scheduleInlineTrigger` 由 render 首行调用、
   * 采纳闸在每次按键上评估），逐次记录就又造出 #21 那 1127 行。键名即分支名，
   * 值是该分支上一次打印过的理由（null = 闸门已重新打开）。
   */
  const traceGates: Record<string, string | null> = {
    'inline-arm-cancel': null,
    'tab-abandon': null,
    'word-abandon': null,
    'accept-gate-tab': null,
    'accept-gate-word': null,
    'stale-frame': null,
    'form-hold': null,
    'deferred-repaint': null,
    'push-cell': null,
  };
  /**
   * 槽级冷却状态（与 `traceGates` 正交：理由闸管「同理由连打」，冷却闸管「换理由连打」）。
   * 2026-10-22 现场：`push-cell` 的 hot-cell-only ↔ suggestion-cell-changed 交替把理由闸
   * 每次都被骗过，控制台又成组刷。判据本体是 `stepSlotEmit`（纯函数，trace-gate 冒烟驱动）。
   */
  const traceSlotGates: Record<string, SlotEmitGate> = {};
  /**
   * **常态证据槽**：这些行是「判据在跑、优化在场」的工作量证据（push-cell 的
   * parses/cellSkips、inline 计时器的取消理由、延迟重绘），**不是故障**。
   * 2026-10-22 二次校准：冷却闸（5s/行）钉住后它们仍在正常使用的页签里按事件节奏
   * 持续出现——对「控制台该是安静的」这个预期仍然太吵。降级到 `console.log`：
   * Chrome 默认级别含 Info ⇒ log 仍可见；只有 Verbose 档（console.debug）默认隐藏（devtools 勾 Verbose 即可见，诊断能力不删只改门），
   * 冷却闸照旧（Verbose 级别下也不至于刷屏）。#39 的「摘空输出」教训针对的是
   * **故障路径不可见**，常态证据不在其列。
   */
  const ROUTINE_TRACE_SLOTS: ReadonlySet<string> = new Set([
    'push-cell',
    'inline-arm-cancel',
    'deferred-repaint',
  ]);
  /**
   * 打一行留痕（同一理由连续到达只打第一行；**不同理由也每 slot 每 5s 至多一行**，
   * 冷却期内最新一份攒成 pending、冷却结束后放行——新理由不丢，只迟到）。
   * 通道按槽分：故障槽 warn（默认可见），常态证据槽 debug（默认隐藏，见
   * {@link ROUTINE_TRACE_SLOTS}）。
   *
   * 隐私口径与 `completion not shown` 那行一致（index.ts 里既有的写法）：
   * **只打字符数与原因，不打正文**，故调用方传进来的 `fields` 不得含草稿/建议文本。
   */
  const traceOnce = (slot: string, reason: string, fields: string): void => {
    const step = stepReasonGate(traceGates[slot] ?? null, reason);
    traceGates[slot] = step.last;
    const out = stepSlotEmit(traceSlotGates[slot] ?? initialSlotEmitGate(), Date.now(), step.print, reason, fields);
    traceSlotGates[slot] = out.gate;
    if (out.emit === null) return;
    const line = `${OPS_TRACE_PREFIX} ${slot}: reason=${out.emit.reason}${out.emit.fields === '' ? '' : ` ${out.emit.fields}`}`;
    if (ROUTINE_TRACE_SLOTS.has(slot)) console.debug(line);
    else console.warn(line);
  };
  /** 判据通过 / 状态解除时重新开门（静默；攒着的 pending 一并作废——问题已解除就不该再迟到地打它）。 */
  const traceClear = (slot: string, reason: string | null): void => {
    traceGates[slot] = stepReasonGate(traceGates[slot] ?? null, reason).last;
    traceSlotGates[slot] = initialSlotEmitGate();
  };
  let composing = false;

  /** live 设置值（来自 suggest-ghost 命名空间；缺失时用默认）。 */
  let settings: {
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    /** 停顿续写开关。 */
    inlineEnabled: boolean;
    /** 流式投递开关（#108，默认关）：开=在回合结束边沿上开一条短流收增量帧。 */
    streamingDelivery: boolean;
    /** 停顿多久后触发续写（毫秒）。 */
    inlineDelayMs: number;
    /** 草稿至少输入多少字符才触发续写。 */
    inlineMinChars: number;
    /** 幽灵显示时允许 → 逐词采纳（Tab 始终整条采纳）。 */
    wordAccept: boolean;
    /** host 实时推送：最新 LLM 建议（rev 递增识别新值）。 */
    suggestion: {
      turn: number;
      baseSeq: number;
      text: string;
      truncated: boolean;
      acceptKey: string;
    } | null;
    /**
     * `suggestion` 的归一化帧提示（#38）。**不**挂在 suggestion 对象上，因为
     * 冷启动缓存里那份旧 suggestion 没有这两个字段，混在一个对象里会让「缺省」与
     * 「显式 false」难以区分。缺省 = {@link LEGACY_FRAME_HINT}。
     */
    suggestionFrame: FrameHint;
    /** host 实时推送：停顿续写结果（draft=生成时的草稿，文本不符则不显示）。 */
    completion: { draft: string; text: string } | null;
    /** `completion` 的归一化帧提示（本期宿主不出帧号，只可能带 `final`）。 */
    completionFrame: FrameHint;
    /** completion 所属会话；与当前会话不符时不显示。 */
    completionSessionId: string | null;
    /** host 实时推送：跨会话热度快照。 */
    hot: readonly { text: string; count: number }[] | null;
    /** host 实时推送：当前会话的最近用户输入文本（时间序，历史补全文本源）。 */
    history: readonly string[];
    /** history 所属会话；与当前会话不符时不做会话内补全（退化为纯热度候选）。 */
    historySessionId: string | null;
    /** 建议所属会话；与当前会话不符时隐藏 LLM 建议。 */
    suggestionSessionId: string | null;
  } = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    inlineEnabled: true,
    streamingDelivery: false,
    inlineDelayMs: 100,
    inlineMinChars: 4,
    wordAccept: true,
    suggestion: cached.suggestion ?? null,
    // 缓存里的建议可能来自上一进程；帧提示一起持久化，避免把 provisional 帧的
    // 建议冷启动后当成终帧采纳（读不到时按旧载荷兜底）。
    suggestionFrame: cached.suggestionFrame ?? LEGACY_FRAME_HINT,
    completion: null,
    completionFrame: LEGACY_FRAME_HINT,
    completionSessionId: null,
    hot: cached.hot ?? null,
    history: cached.history ?? [],
    historySessionId: cached.historySessionId ?? null,
    suggestionSessionId: cached.suggestionSessionId ?? null,
  };

  /**
   * 设置版本号：每次 applySettings 实际替换 settings 时递增。
   * 用于 ghostContent 缓存失效——避免把"草稿未变但 settings 已换"误判为命中。
   */
  let settingsEpoch = 0;

  /** hotCounts Map 缓存：按 hot 数组引用失效，避免每次按键重建 2000 条归一化。 */
  let hotCountsCache: { src: readonly { text: string; count: number }[] | null; map: Map<string, number> | undefined } | null = null;

  /** ghostContent 结果缓存：按 (draft, settingsEpoch, composing, running, currentId) 失效。 */
  let ghostContentCache: {
    draft: string;
    settingsEpoch: number;
    composing: boolean;
    running: boolean;
    currentId: string | undefined;
    result: GhostContent | null;
    key: string | null;
  } | null = null;

  /** 解析当前会话绑定（会话切换时重建）。 */
  const resolve = (currentId: string | undefined): void => {
    const id = currentId;
    if (id === undefined) {
      bound = null;
      lastSessionId = undefined;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === undefined) return; // 会话未就绪：不推进 lastSessionId，下次列表事件重试
    const session = sessions.sessionOf(actx);
    if (session === undefined) return;
    const conversation = actx.get('conversation');
    if (conversation === undefined) return;
    const input = conversation.input.for(actx);
    if (input === undefined) return;
    lastSessionId = id;
    bound = {
      session: session as unknown as ObservableSnapshot<unknown>,
      input: input as unknown as InputFaceLike,
      projectionFace: session.projections.faceOf(PROJECTION_KEY),
    };
    // 换绑即刻重订阅：`unsubs` 归渲染 effect 所有，这里通过钩子回调，避免旧会话的
    // 三条 store 订阅在「由 render 触发的换绑」上长期滞留（详见 resubscribeBound）。
    resubscribeBound?.();
    // 绑定成功即拉取该会话的权威状态（历史环 + 建议）：这是「会话就绪」的
    // 唯一出口，冷启动、切会话、会话晚就绪三条路径在这里汇合成一次请求，
    // 不再依赖 effect 初始化的那一拍（那时会话常常尚未就绪，请求会落空）。
    pullHistory(id);
  };

  /**
   * 计算当前应显示的幽灵内容（null = 不显示）。结果按 (draft, settingsEpoch, composing, running, currentId) 缓存。
   *
   * 返回值里的 `base` 是**本次 content 所用**的草稿快照（与 `draft` 同源于
   * 一次 `getSnapshot()`），采纳写入拿它做 CAS 基线（#4）。`content === null`
   * 或输入机未绑定时为 null——那种形态下没有采纳可言。
   */
  const ghostContent = (currentId: string | undefined): {
    content: GhostContent | null;
    key: string | null;
    base: DraftSnapshot | null;
  } => {
    // 双模式禁用：直接返回，跳过快照读取（续写开启且有载荷时不能早退）
    if (!settings.historyEnabled && settings.suggestion === null
      && (!settings.inlineEnabled || settings.completion === null)) return { content: null, key: null, base: null };
    if (bound === null) return { content: null, key: null, base: null };
    if (composing) return { content: null, key: null, base: null }; // IME 组词中：组合预览与幽灵后缀重叠，抑制显示
    // 0.1.2 会话快照只余 lifecycle 字段；本插件用到的仅剩 `running`。
    const snapshot = bound.session.getSnapshot() as { running: boolean };
    // 一次读取同时取 draft 与 draftRev：CAS 的两个量必须来自同一帧快照，
    // 分两次读会让「文本」与「版本」错配。
    const base = readDraftSnapshot(bound.input.state.getSnapshot());
    const draft = base.draft;

    // 缓存命中：所有输入维度未变 → 直接返回上次结果，跳过全部归一化与打分。
    // 命中的前提是 draft 逐字相同，故缓存结果与新鲜 base 仍指同一份草稿。
    if (ghostContentCache !== null
      && ghostContentCache.draft === draft
      && ghostContentCache.settingsEpoch === settingsEpoch
      && ghostContentCache.composing === composing
      && ghostContentCache.running === snapshot.running
      && ghostContentCache.currentId === currentId) {
      return { content: ghostContentCache.result, key: ghostContentCache.key, base };
    }

    const result = computeGhostContent(draft, snapshot, currentId);

    // 计算 content key 并与结果一起缓存，避免 render() 重复拼接字符串。
    let key: string | null = null;
    if (result !== null) {
      key = result.kind === 'llm'
        ? `llm:${result.text}`
        : `${result.kind}:${result.prefix}|${result.suffix}`;
    }

    // 写入缓存（composing 已在函数入口早退，此处必为 false）。
    ghostContentCache = { draft, settingsEpoch, composing: false, running: snapshot.running, currentId, result, key };
    return { content: result, key, base };
  };

  /** ghostContent 的实际计算（无缓存层）。 */
  const computeGhostContent = (
    draft: string,
    snapshot: { running: boolean },
    currentId: string | undefined,
  ): GhostContent | null => {
    // 模式 1：草稿非空 → 停顿续写优先（host 推送的 LLM 续写，须与当时草稿
    // 逐字相符且属于当前会话），其次历史前缀补全（即时、无网络）。
    if (draft.trim() !== '' && settings.inlineEnabled) {
      const completion = settings.completion;
      // 「宿主推了续写但本帧不显示」是 #15 验收的关键分叉：载荷没到（通道问题）、
      // 到了但归属别的会话、还是到了且属于本会话却与当前草稿不逐字相符（用户在
      // 生成期间又打了字）。三者过去在观测上完全同形 —— `6dfcd78` 删掉了那条
      // `completion not shown` 日志，只留下一个空 if 块（删输出没删判定）。
      // 本函数每帧都跑（实测一次输入会话列表就刷上百次），所以只在**理由变化时**
      // 打一行，避免又造出一个 #21。
      // 判定与显示共用同一次对齐结果 —— 早先这里把判据写了两遍（skipReason 一套、
      // 显示条件一套），改动时极易只改一处（本仓库在别处踩过"两份真相互不约束"）。
      const aligned = completion === null || completion === undefined
        || settings.completionSessionId === null
        || settings.completionSessionId !== currentId
        ? null
        : alignCompletion(draft, completion.draft, completion.text);
      const skipReason = completion === null || completion === undefined
        ? 'none'
        : settings.completionSessionId !== currentId
          ? 'other-session'
          : aligned !== null && !aligned.ok
            ? aligned.reason
            : null;
      if (skipReason !== null) {
        if (skipReason !== lastCompletionSkip) {
          lastCompletionSkip = skipReason;
          // 只按**理由变化**打（本函数每帧都跑，一次输入能刷上百次；不这么做就是重造 #21）。
          // 通道（2026-10-22 三次校准）：整行走 `console.debug`（默认隐藏，Verbose 全量
          // 可见）。上一版按「草稿够不够长」分 warn/log 被实测驳回：`draftChars=521
          // reason=none` 也刷屏——「载荷还没到」在生成耗时 1.1~17s 的现实里是**瞬态**，
          // 单条事件分不出「还没到」与「永不到」，把它标成故障级别就是噪声源。#39 的
          // 验收要的是**这行存在**（排查"停顿后没东西"时把"没到 / 别的会话 / 对不齐 /
          // 空文本"分开），不是它默认可见；理由变化闸照旧。
          // 只打字符数，不打草稿正文（与宿主侧同款隐私约束）。
          // 通道回到 warn（2026-10-23：上一轮整体降 debug 是降过头了）。判据：这条正是
          // 「幽灵为什么不出」的**第一诊断行**，且天然低频——只在理由**变化**时打一条
          // （`lastCompletionSkip` 闸），不是 push-cell 那种事件节奏刷屏。常态证据降
          // Verbose、诊断主行留 warn，两类的边界以「用户来报障时先看哪行」为准。
          const sink = console.warn;
          sink(
            `[dsh-suggest-ghost][ops-trace] completion not shown: reason=${skipReason}`
            + ` draftChars=${draft.length} payloadDraftChars=${completion?.draft?.length ?? -1}`
            + ` completionChars=${completion?.text?.length ?? -1}`
            + ` payloadSessionMatches=${String(settings.completionSessionId === currentId)}`,
          );
        }
      } else {
        lastCompletionSkip = '';
      }
      if (aligned !== null && aligned.ok) {
        return { kind: 'inline', prefix: draft, suffix: aligned.suffix, full: aligned.full, frame: settings.completionFrame };
      }
      // #38 第 4 条：**同一次生成内形态不得翻转**。`alignCompletion` 的裁空一支
      // （载荷仍然拥有这份草稿，只是你已经把整段续写打完了，completion-align.ts:87）
      // 本身不是错误，但按本函数的分支顺序会让这一帧继续往下落到历史补全——用户看到的
      // 是「灰色尾巴无声换成另一段不相干的文字」。判据见 completion-align.ts 末段 `decideInlineForm`：它靠
      // `alignCompletion` 的归属前缀关系（#33 的「边打边等」主路径因此不受影响），
      // 不靠草稿逐字相同。
      const form = decideInlineForm({
        inlineEnabled: settings.inlineEnabled,
        draft,
        payload: completion,
        payloadBelongsToCurrentSession: settings.completionSessionId !== null
          && settings.completionSessionId === currentId,
        alignedOk: false, // 上面已就地的 `aligned.ok` 分支返回，能走到这里必然没显示成
        alignedReason: aligned === null || aligned.ok ? null : aligned.reason,
      });
      if (form.hold !== null) {
        traceOnce('form-hold', form.hold,
          ` draftChars=${draft.length} payloadDraftChars=${completion?.draft?.length ?? -1}`
          + ` completionChars=${completion?.text?.length ?? -1} wouldBe=history`
          + ` ${frameHintFields(settings.completionFrame)}`);
        // 宁可不显示，也不在这一帧换成 history：下一次宿主出新载荷、或用户把草稿改成
        // 「不再拥有」（删字/改中间），历史补全自然回来。
        return null;
      }
      traceClear('form-hold', null);
    }
    // 模式 1：草稿非空 → 历史前缀补全（打分制：新近度为主、频次/热度为辅）。
    if (settings.historyEnabled && draft.trim() !== '') {
      // 能落到这里说明「续写这一路」没有把形态扣住（见上面的 form.hold），闸门重新打开。
      traceClear('form-hold', null);
      // 草稿是斜杠命令整行时（如 `/later +3m 我重新部署了…`），用命令名之后
      // 的「内容」部分去匹配历史。`/later` `recordInput:false`，历史里只有
      // 到点注入的内容部分；保留时间参数只会让所有候选 startsWith 失败。
      // 非命令整行（普通用户消息）时 stripCommandPrefix 原样返回 draft。
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === '') return null;
      // 数据源：host 经 `_push` 推送的当前会话历史环（0.1.2 会话快照已不对
      // 插件暴露对话 nodes）。会话不符时退化为纯热度候选（跨会话模式仍有
      // 完整体验）。
      const history = settings.historySessionId !== null && settings.historySessionId === currentId
        ? settings.history
        : [];
      // C：全局热度频次始终参与打分（host 无条件推送）；「跨会话搜索」开关
      // 只决定是否把其他会话的高频文本并入候选列表。
      const hot = settings.hot;
      // hotCounts Map 缓存：按 hot 数组引用失效，避免每次按键重建 2000 条归一化。
      if (hotCountsCache === null || hotCountsCache.src !== hot) {
        const map = hot !== null && hot.length > 0
          ? new Map(hot.map(h => [normalizeForMatch(h.text), h.count] as const))
          : undefined;
        hotCountsCache = { src: hot, map };
      }
      const hotCounts = hotCountsCache.map;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? undefined : undefined,
      });
      if (full === undefined) return null; // 无候选（前缀超限/低于阈值等），本帧不显示
      // 渲染按「原始草稿 + 候选」公共前缀对齐（宽度/空白差异时仍正确）；
      // 对斜杠命令场景，prefix=draft 让幽灵对齐到已输入字符（含命令前缀），
      // suffix 从 contentDraft 与 full 的归一化匹配段截尾——见 historySuggestion。
      const common = commonPrefixLength(contentDraft, full);
      // 历史补全是**本地即时**算出的候选，不是一次「生成」，没有帧的概念：
      // 恒按终帧处理（采纳闸因此对这一形态逐字保持现状）。
      return { kind: 'history', prefix: draft, suffix: full.slice(common), full, frame: LEGACY_FRAME_HINT };
    }

    // 模式 2：草稿为空 → LLM 建议（host 实时推送）。过期判据（0.1.2 形态）：
    // agent 运行中隐藏；建议属于其他会话时隐藏（host 推送按会话标记；运行中
    // 的会话由 running 隐藏，回合结束的推送要么更新建议要么清空，无需再比
    // 对会话快照里已移除的 turnEnds）。
    // 流式增量帧优先（#108，默认关）：帧比 `_push` 早到，这就是这条任务的全部意义。
    // **只用于视觉增长**：帧自带的 frame/final 原样交给采纳链，provisional 帧在
    // accept-guard 里本来就被拒（硬约束 3），所以这里不加任何额外闸门。
    // 终帧之后 `_push` 落地会把它清掉——权威态仍然来自 settings 面。
    const streamed = streamFrameFor(currentId);
    if (streamed !== null) {
      pushCellStats.llmGhostOffered += 1;
      return {
        kind: 'llm',
        text: streamed.text,
        acceptKey: settings.suggestion?.acceptKey ?? 'Tab',
        frame: { frame: streamed.frame, final: streamed.final },
      };
    }
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === undefined) return null;
    const ownerMismatch = settings.suggestionSessionId !== null
      && settings.suggestionSessionId !== currentId;
    const stale = snapshot.running || ownerMismatch;
    if (stale) {
      // 只在「因归属被藏」这一支计数：running 那一支是另一回事（回合还在跑）。
      // 纯观测，判据本身一字未改。
      if (!snapshot.running && ownerMismatch) pushCellStats.ownerHidden += 1;
      return null;
    }
    pushCellStats.llmGhostOffered += 1;
    // 帧提示随内容一起交给采纳链（#38）：provisional 帧可以显示，但不许采纳。
    return { kind: 'llm', text: suggestion.text, acceptKey: suggestion.acceptKey, frame: settings.suggestionFrame };
  };

  /** 缓存的上一次输入框查询结果（React 可能重建节点；isConnected 校验兜底）。 */
  let cachedComposer: HTMLElement | null = null;
  /** 上次通过 isComposerElement 验证的输入框（composer 未变时跳过重复 DOM 属性检查）。 */
  let validatedComposer: HTMLElement | null = null;

  /** 渲染幽灵 overlay。 */
  const render = (): void => {
    const currentId = currentSessionIdOf(sessions.list.getSnapshot());
    resolve(currentId);
    // 幽灵内容先于续写调度计算：调度策略需要「当前幽灵形态」作为入参（`inline`
    // 意味着这份草稿的续写已经显示在屏幕上，不必再问一次）。ghostContent() 是
    // 纯读取 + 结果缓存，挪到前面没有副作用，也让下面的分支复用同一份结果。
    const { content, key, base } = ghostContent(currentId);
    // 停顿续写调度：判据是「草稿/会话/形态/配置有没有变」，不是 render 次数
    // （debounce 语义见 scheduleInlineTrigger 与 inline-arm-policy.ts）。
    scheduleInlineTrigger(currentId, content === null ? null : content.kind);
    retryPendingPull();
    // base 与 content 同源：content 非 null 时 base 必非 null（同一帧快照读出）。
    // base 是采纳写入的 CAS 基线（#4），拿不到就不出幽灵。
    if (content === null || base === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    // key 与 content 同步计算：content 非 null 时 key 必非 null。
    if (key === null) return;
    if (shown !== null && shown.key === key) return; // 无变化
    // 复用已绑定的输入框；仅当缓存失效（React 重建/首次）时才查询 DOM。
    // 双代选择器：textarea（≤0.1.1）或 contenteditable（0.1.2 Lexical）。
    const attached = overlay.currentTextarea;
    let composer = attached !== null && attached.isConnected
      ? attached
      : cachedComposer !== null && cachedComposer.isConnected
        ? cachedComposer
        : document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (composer === null) return; // 输入框尚未挂载，等待下次通知
    // ── 非编辑器形态一律不出幽灵 ────────────────────────────────────────────
    // 宿主在无工作区/会话不可写时会把 composer 换成「选择一个工作区开始」这类
    // **触发器按钮**：源码里 `editor: workspaceTrigger ? null : editor`，编辑器
    // 根本不挂载，而 placeholder 文案（"选择一个工作区开始"）是该控件**唯一的
    // 可见文字**。COMPOSER_SELECTOR 只看 `[data-composer-input]` 属性、不看可编辑
    // 性，所以裸查询会在这种形态上照样命中；若此时出幽灵，我的让位规则就会把那句
    // 提示藏掉 → 输入框变成一块没有文字的空框，表现为「输入框消失了」。
    // 复用事件路径已有的 `isComposerElement` 判据（textarea 或 isContentEditable），
    // 两条路径对「什么算输入框」的定义必须一致，否则又会出现「事件侧不认、渲染侧
    // 却挂」的错配。
    // 如果 composer 与上次验证通过的相同，跳过 isComposerElement 检查
    // （DOM 属性读取：closest/matches/isContentEditable）。
    if (composer !== validatedComposer) {
      if (!isComposerElement(composer)) {
        // 已经显示中的要收掉，并把指纹清空，否则回到可编辑形态时会被
        // 「key 未变化」早退挡住，幽灵再也不出现。
        if (shown !== null) {
          overlay.hide();
          shown = null;
        }
        return;
      }
      validatedComposer = composer;
    }
    cachedComposer = composer;
    overlay.attach(composer);
    overlay.show(content);
    shown = { key, content, base };
  };

  // 读取/订阅设置命名空间（可选服务；缺失时保持默认并继续幽灵逻辑）。
  // 注意：必须放在 render 等函数定义之后，否则同步调用 applySettings 会触发
  // const 函数声明前的 TDZ（原 rc.6 版靠 ctx.inject 的异步延迟规避，rc.7 下
  // 需要显式保证顺序）。

  // UI 语言服务（可选）：每次写 _ops 时捎带给 host，供语言检测做先验加成。
  const locale = ctx.get('locale') as LocaleFaceLike | undefined;

  /** `_ops` 载荷的单调序号源（页面级，刷新后从 1 重来，理由见 ops-envelope.ts）。 */
  const opsSeq = createSeqSource();

  /**
   * `_ops` 反向通道的写面（经 `remote.settings.mutate` 请求 host 推送历史环）。
   *
   * 0.1.7 里 `settingsScope.set` 已随 settings.yaml 体系退役；改写 volatile
   * 配置字段走 `remote.settings.mutate(ns, [{op:'set', path:['_ops'], value}])`。
   *
   * **返回 true 的含义是「有证据表明载荷落进了文档」，不是「RPC 调用没抛错」**（#16）。
   * 远程面把内核的冲突拒绝折成 `{ok:false, error}` 后照样兑现（见
   * `unwrapMutateResult`），所以兑现状态本身没有信息量；`settleWrite` 拿写后视图的
   * `revision` 推进 / `_ops` 值匹配当凭证。拿不到凭证、或远程明确拒绝时返回 false，
   * 并各打一条 console.warn 区分「被拒」与「没落盘」——调用方按未送达处理（pull 有
   * 退避重试兜着）。
   *
   * 每次写入自动捎带当前 UI 语言（`locale` 字段），host 据此做语言先验加成。
   */
  const writeOpsNow = (payload: string): Promise<boolean> => {
    const svc = remoteOf(ctx)?.settings;
    if (svc === undefined) return Promise.resolve(false);
    // 信封：注入进程内单调 seq，并在有值时捎带 locale。
    // 为什么必须有 seq：宿主按载荷全等给 `_ops` 去重，而「消费后清空 `_ops`」在
    // settings 事件回调里是结构性不可能的（内核 HMR 事务拒绝嵌套写），没有序号时
    // 「改走别的草稿再删回来」这类合法重发会被当成回声静默吞掉。见 ops-envelope.ts。
    const enriched = buildOpsPayload(payload, locale?.getSnapshot?.()?.active, opsSeq.next());
    // 写 CAS：先 describe 拿当前 revision，再按该 revision 提交 mutate。
    // **不能传常量 0**——文档 revision 一旦 >0，expected=0 的写入会被内核按
    // 版本冲突拒绝；若远程层不抛错则表现为「mutate OK 但值从未落盘」的假成功。
    const doWrite = (attempt: number): Promise<boolean> =>
      svc
        .describe()
        .then(
          (described) => {
            const list = unwrapSettingsDoc(described)?.namespaces ?? [];
            const row = list.find((r) => r.ns === SETTINGS_NAMESPACE) as { revision?: number } | undefined;
            const rev = typeof row?.revision === 'number' ? row.revision : 0;
            return svc
              .mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: ['_ops'], value: enriched }], rev)
              .then(
                // 兑现 ≠ 落盘：远程面把冲突折成 `{ok:false,error}` 后照样兑现
                // （见 unwrapMutateResult 的源码取证）。
                (mutated: unknown) => settleWrite(mutated, rev, enriched, attempt),
                // reject 只可能是装配故障（参数元数 / 方法未挂载 / 缺 Context 适配器）。
                (error: unknown) => {
                  const rejection = readRejection(error);
                  if (opsConflictRetryAllowed(attempt) && isConflictRefusal(rejection.code, rejection.message)) {
                    return retryAfterOpsConflict(attempt);
                  }
                  console.warn(`[suggest-ghost] _ops write rejected by client api: code=${String(rejection.code)}, message=${String(rejection.message)}`);
                  return false;
                },
              );
          },
          // describe 自己失败（后端未就绪 / 连接断开）：**必须就地收住**。调用点是
          // `void writeOps(...)`，让它 reject 出去就成了 unhandled rejection；改结构前
          // 这一支由外层 onRejected 兜着，重构时很容易漏。
          (error: unknown) => {
            console.warn(`[suggest-ghost] _ops write skipped: describe() failed, ${String(error)}`);
            return false;
          },
        );

    /**
     * 写后确认（#16 的闭环）。判定本身是纯函数（`settings-result.ts` 的
     * `settleWriteVerdict`，可被 `scripts/ops-write-verify-smoke.mjs` 离线驱动），
     * 这里只按结论接线：重试 / 留痕 / 兜底读回。
     *
     * 热路径成本：常规形态**零额外往返**——凭证就是 `mutate` 成功时带回的写后视图；
     * 只有这一代的返回值认不出凭证时才补**一次** describe() 读回。没有轮询、没有定时器。
     * 判据的依据（载荷仍在盘上 / revision 已动 / 两者皆无 = #16 签名）写在
     * `settings-result.ts` 的 `verdictFromView` 里，那边有单测。
     */
    const settleWrite = (mutated: unknown, rev: number, sent: string, attempt: number): Promise<boolean> => {
      const verdict = settleWriteVerdict(mutated, rev, sent);
      switch (verdict) {
        case 'landed':
          return Promise.resolve(true);
        case 'refused-conflict':
          // 版本冲突（host 自写 `_push` 会频繁推进 revision）：重取 revision 重试。
          // 注意：修复前这条分支**从来没触发过**——冲突当时被当成成功兑现了。
          if (opsConflictRetryAllowed(attempt)) return retryAfterOpsConflict(attempt);
          return reportWrite(mutated, rev, 'conflict retries exhausted');
        case 'refused-other':
          return reportWrite(mutated, rev, verdict);
        case 'unsettled':
          return reportWrite(mutated, rev, verdict);
        case 'unreadable':
          // 这一代的返回值读不出凭证：补**一次** describe() 读回（不轮询、不排定时器，
          // 0.2.x 的远程面带写后视图，常规形态根本走不到这里）。
          return readBackOnce(rev, sent).then((settled) => {
            if (settled === true) return Promise.resolve(true);
            return reportWrite(mutated, rev, verdict);
          });
      }
    };

    /**
     * 冲突重试前的退避。`settings-result.ts` 的 `opsConflictBackoffMs` 只给毫秒数
     * （纯函数、可离线断言），真等待在这里。
     *
     * **两条冲突分支共用它**（mutate reject 里 `isConflictRefusal` 命中的装配故障路径，
     * 与 `settleWrite` 的 `refused-conflict`），边界由 `opsConflictRetryAllowed` 统一判。
     * 为什么必须退避而不是立刻重试：冲突的另一方是宿主侧写入（`_push`/`_hot` 更新、
     * 宿主消费 `_ops` 后写回空值），通常就在同一个事件循环回合内完成；立即重试会拿着
     * 同一个刚被拒的 revision 再撞一次，把预算瞬间烧光（这就是用户 console 里成组
     * `conflict retries exhausted` 的直接成因）。25/50/100/200ms 的递增间隔给宿主侧
     * 写入留出落盘窗口。
     */
    const retryAfterOpsConflict = async (attempt: number): Promise<boolean> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, opsConflictBackoffMs(attempt));
      });
      return doWrite(attempt + 1);
    };

    /**
     * 兜底的一次性读回：只服务 `unreadable` 这一分支（老代次/异常形态没带回可判别的
     * 写后视图）。**一次**，不重试、不排定时器——热路径上常规形态根本走不到这里。
     * @returns true = 拿到落盘证据；undefined = 读回也拿不到（交给调用方留痕）。
     */
    const readBackOnce = (rev: number, sent: string): Promise<boolean | undefined> =>
      svc
        .describe()
        .then((described) => {
          const row = (unwrapSettingsDoc(described)?.namespaces ?? []).find((r) => r.ns === SETTINGS_NAMESPACE);
          const verdict = verdictFromView(row, rev, sent);
          return verdict === 'landed' ? true : undefined;
        })
        .catch(() => { return undefined; });

    /**
     * 写没落地的留痕。**每条分支都至多一行，且只在失败路径上打**（成功静默），
     * 所以它不会进 render/事件高频路径。区分开「被拒」「重试耗尽」「没落盘证据」
     * 三种形态——#16 排查的第一步就是要分清「被拒」与「没到达内核」，
     * 见 docs/internals-cordis-settings-pitfalls.md 陷阱 1「尚未闭环」段。
     *
     * 通道：浏览器侧没有可用的 ctx.logger（client fiber 的 ctx 是严格门控 Proxy，
     * 未 inject 的属性读取直接抛），控制台是唯一落点，故用 console.warn——
     * 它是失败路径专用，与 main 清理掉的 console.log 调试噪声不是一类。
     */
    const preview = (value: unknown, max: number): string => {
      const s = JSON.stringify(value);
      return (s === undefined ? 'undefined' : s).slice(0, max);
    };

    const reportWrite = (mutated: unknown, rev: number, verdict: WriteVerdict | string): Promise<false> => {
      const outcome = unwrapMutateResult(mutated);
      const view = outcome.view;
      console.warn(
        `[suggest-ghost] _ops write ${String(verdict)}: expectedRevision=${rev}, `
        + `code=${String(outcome.code)}, message=${String(outcome.message).slice(0, 120)}, `
        + `revisionAfter=${String(view?.revision)}, _opsAfter=${preview(view?.value, 40)}`,
      );
      return Promise.resolve(false);
    };

    return doWrite(0);
  };

  /**
   * `_ops` 写入口（**唯一入口**）：把 {@link writeOpsNow} 包进串行队列
   * （`ops-write-queue.ts`）。本页有两个互不知情的写入源——输入停顿的 `complete`
   * 与会话对账的 `pull`——它们各自「describe 取 revision → mutate(expected)」。
   * 并发时互相把 revision 顶掉，而宿主每次消费还会把 `_ops` 写回空值（revision 再
   * +1），于是 CAS 预算被自己人烧光、`complete` 丢掉（用户 console 的成组
   * `conflict retries exhausted` + `completion not shown`）。串行化后页面内部不再
   * 互抢，剩下的冲突只来自宿主侧写入，由 {@link retryAfterOpsConflict} 的退避吸收。
   *
   * `kind` 只影响合并语义：`complete` 在**排队中** last-wins（更旧的草稿已被新的
   * 取代，未发送项兑现 false）；`pull` 不合并（每条都是独立的对账请求）。
   * 现有调用点都不依赖兑现值（`void` / 不 await），被合并掉的 `false` 不会被读成
   * 「写失败」而去重发或报错。
   */
  const opsWriteQueue = new OpsWriteQueue(writeOpsNow);
  const writeOps = (payload: string, kind: OpsWriteKind = 'pull'): Promise<boolean> =>
    opsWriteQueue.enqueue(payload, kind);
  /** 停顿续写的计时器句柄（`arm`/`reset` 建立，`skip` 绝不清动）。 */
  let inlineTriggerTimer: ReturnType<typeof setTimeout> | null = null;
  const clearInlineTimer = (): void => {
    if (inlineTriggerTimer !== null) {
      clearTimeout(inlineTriggerTimer);
      inlineTriggerTimer = null;
    }
  };
  /** armed 策略状态（纯函数状态机的当前值，见 inline-arm-policy.ts）。 */
  let armState: InlineArmState = initialInlineArmState();
  /**
   * #21 待查项 1 的定位探针：按**来源**统计 render 被调用的次数。
   *
   * 风暴的直接成因已确认是「每个来源都调 render × 每次 render 都重置计时器」，前半句
   * 到底是哪个来源在刷还需要运行时计数才能定论，故这里按来源分别累加。
   * `other` = 会话列表 / 设置事件 / IME 组合等零散来源（错峰补渲染现在被增长快路径
   * 让路，跳过次数单独计数）。
   *
   * ⚠️ 这组计数此前**只累加、从不打印**——注释里写的「只在 armed 那一行汇总打印」指的
   * 是早已摘空的日志（#39 的典型形态：判据在跑、留痕被摘空）。现在由
   * {@link stepTally} 给一个**按归因理由变化才打**的出口：占大头的来源变了、
   * 且距上次打印已累计 ≥ {@link TALLY_MIN_INTERVAL_RENDERS} 次 render，才出一行。
   */
  const renderHits = { session: 0, input: 0, face: 0, other: 0 };
  /** tally 打印状态（理由 + 上次打印时的总数）。 */
  let tallyState: TallyState = initialTallyState();
  /** 被增长快路径让路、没有执行的错峰补渲染次数。 */
  let deferredRepaintSkips = 0;
  /** 计一次来源、必要时打一行 tally，然后渲染（所有 render 调用都走这里）。 */
  const renderTraced = (source: keyof typeof renderHits): void => {
    renderHits[source] += 1;
    const tally = stepTally(tallyState, renderHits);
    if (tally.print) {
      tallyState = tally.state;
      // 常态证据走 debug（Chrome 默认级别含 Info，log 仍可见；debug 才是默认隐藏的档）——与 `ROUTINE_TRACE_SLOTS` 同一
      // 判据：render 归因 tally 是「工作量在场」的证据，不是故障（2026-10-22 校准）。
      console.debug(`${OPS_TRACE_PREFIX} render-source: reason=${tally.state.reason ?? 'none'}`
        + ` ${tally.line.replace('render tally: ', '')} deferredSkipped=${deferredRepaintSkips}`);
    }
    render();
  };
  /**
   * `bound` 换绑之后的重订阅钩子，由渲染 effect 注入（effect 卸载时置回 null）。
   *
   * #21 待查项 1 的**订阅泄漏点**：`resolve()` 也会被 `render()` 调用，而它能就地
   * 把 `bound` 换成另一条会话（晚就绪的会话走的正是这条路，见 resolve 末尾注释）。
   * 三个 store 订阅句柄存在 effect 的局部变量里，只有 `rebind()` 会退订它们；于是
   * 经由 render 换绑时，**旧会话的那三条订阅一直挂着**（旧会话若仍在跑，它每推一次
   * 快照就多打一次 render），直到下一次真正的会话切换才被顺手清掉。换绑即重订阅。
   */
  let resubscribeBound: (() => void) | null = null;

  /**
   * 停顿续写调度：草稿非空且达到阈值时，停止输入 inlineDelayMs 后向 host 发送
   * `complete` op（携带当时草稿），host 生成续写并经 `_push` 推回 completion。
   *
   * **0.5.2 起 debounce 的判据从「render 次数」换成「观察值变化」**（issue #21）：
   * 本函数由 `render()` 首行调用，而 render 的来源远不止按键（三个 store 订阅、
   * 会话列表、设置事件、错峰补渲染……）。旧实现每次都 `clearTimeout` + 重新
   * `setTimeout`，等价于「距上一次 render 多久」，于是一次 40 字符输入实测打出
   * 1127 次 armed，停顿计时器被永远推倒重来。现在「该不该重新计时」全部交给纯函数
   * {@link decideInlineArm}（见 inline-arm-policy.ts），本处只执行它的决策：
   * `skip` 完全不动计时器（到期时刻保持不变）、`cancel` 清表不重排、`arm`/`reset`
   * 才真的建定时器。
   *
   * @param currentId - 本次 render 认定的当前会话 id（无 bound 时策略视为未绑定）。
   * @param ghostKind - 本次 render 算出的幽灵形态；`inline` 表示该草稿的续写已在
   *                    屏幕上，没有再问一次的必要（也是写→推→render→再写的回环出口）。
   */
  const scheduleInlineTrigger = (currentId: string | undefined, ghostKind: InlineArmGhostKind): void => {
    const sessionId = bound === null ? null : currentId ?? null;
    const obs = {
      now: Date.now(),
      draft: bound === null ? '' : bound.input.state.getSnapshot().draft,
      sessionId,
      ghostKind,
      enabled: settings.inlineEnabled,
      minChars: settings.inlineMinChars,
      delayMs: settings.inlineDelayMs,
      composing,
    };
    const outcome = decideInlineArm(armState, obs);
    armState = outcome.state;
    const { decision } = outcome;
    if (decision.action === 'skip') return; // 同一次观察的重复送达：计时器一律不动
    clearInlineTimer();
    // 旧实现在这里的四道串行早退（开关/绑定/阈值/会话）已全部下沉为
    // decideInlineArm 的 cancel 理由，由策略统一判定（#21）。
    if (decision.action === 'cancel') {
      // 不合格形态（开关关闭 / 无会话 / 未达阈值 / 组词中 / 已有续写）：清表不重排。
      // 两条既有的 `inline skip` 诊断保留，但**只在形态变化时**打印：它们在风暴里会
      // 长期成立，逐次记录就又变成 #21 的那 1127 行。`below-min-chars` 等旧实现本就静默，
      // 继续静默。
      // #39：这两支曾经「判据在跑、留痕被摘空」——只剩两个空 if 块，于是「续写开关被
      // 关了」与「没有绑定会话」与「一切正常只是没到阈值」在观测上完全同形。
      // 现在补回一行，走统一的 reason-change 闸门（`lastSkipReason` 那套手写门因此退役，
      // 判定本身没动，只是留痕有了出口）。
      if (decision.reason === 'disabled' || decision.reason === 'no-session') {
        traceOnce('inline-arm-cancel', decision.reason,
          ` draftChars=${obs.draft.length} minChars=${obs.minChars}`
          + ` bound=${String(bound !== null)} enabled=${String(obs.enabled)}`);
      } else {
        // `below-min-chars` / `composing` / `already-inline` 旧实现本就静默，继续静默。
        traceClear('inline-arm-cancel', null);
      }
      return;
    }
    traceClear('inline-arm-cancel', null);
    const armedSessionId = decision.sessionId as string;

    inlineTriggerTimer = setTimeout(() => {
      inlineTriggerTimer = null;
      // 到期时再校验一次：草稿可能在 armed 之后被别的路径改掉（改掉会另起一张表，
      // 这张表随之被清掉，所以走到这里通常仍是同一份草稿）。
      const draftNow = bound?.input.state.getSnapshot().draft ?? '';
      if (bound === null || draftNow.trim().length < settings.inlineMinChars) {
        // 没发出去 → 不记去重键，草稿之后的变化仍可重新计时。
        armState = settleInlineTimer(armState, null);
        return;
      }
      armState = settleInlineTimer(armState, { sessionId: armedSessionId, draft: draftNow });

      // `'complete'` 参与队列的「排队中 last-wins」：用户继续打字后，这条尚未发出的
      // 旧草稿会被下一条 complete 取代（兑现 false = 未发送，不是写失败）。
      void writeOps(
        JSON.stringify({ rev: 0, ops: [{ op: 'complete', sessionId: armedSessionId, draft: draftNow }] }),
        'complete',
      );
    }, Math.max(0, decision.dueAt! - obs.now));
  };
  let pullRev = 0;
  let lastPulledSessionId: string | undefined;
  /** 尚未确认收到应答的 pull（见 retryPendingPull）；null = 无待确认请求。 */
  let pendingPull: { sessionId: string; attempts: number } | null = null;
  /** 待确认 pull 的退避定时器（仅在有 pendingPull 时存在）。 */
  let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 请求 host 推送某会话的权威状态（历史环 + 建议 + 热度）——这也是 host 侧的
   * **对账请求**：本页打开后该会话收到过什么，只有 host 说了算。
   *
   * 因此判据是「本次页面生命周期内是否已为本会话请求过」（lastPulledSessionId），
   * 而**不能**拿本地残留的 `settings.historySessionId` 当「已经有了」的证据：
   * 那份数据可能来自上一个进程，而 host 这次可能因为「会话尚未进店」而整个跳过
   * 了启动对账推送（见 index.ts），此时若据此跳过请求，就再也没有对账机会了。
   *
   * 若写入抢跑在 host 的 `_ops` 监听注册之前，host 启动对账会补消费这条遗留
   * 请求（consumeOps 的遗留补跑），不会丢。
   */
  const pullHistory = (sessionId: string): void => {
    if (sessionId === lastPulledSessionId) return;
    lastPulledSessionId = sessionId;
    pendingPull = { sessionId, attempts: 0 };
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: 'pull', sessionId }] }));
    schedulePullRetry(); // 未被应答时按退避重试（见 retryPendingPull）
  };

  /**
   * 未得到应答的 pull 重试：host 可能因「会话尚未进店 / 环尚不可得」而只回了一
   * 份不含历史的载荷，而请求本身已被消费（`_ops` 被清空）——没有重试就再没有
   * 对账机会。用退避定时器驱动（render 不保证还会被触发），上限
   * {@link PULL_MAX_ATTEMPTS} 次后放弃，避免会话真的不存在时自旋。
   */
  const retryPendingPull = (): void => {
    const pending = pendingPull;
    if (pending === null) return;
    // 只有当前仍绑定该会话时才值得重试（切走后由新会话的 pull 接管）。
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null; // 已收到该会话的权威状态，对账完成
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: 'pull', sessionId: pending.sessionId }] }));
    schedulePullRetry();
  };

  /** 为待确认的 pull 排下一次退避重试（已存在定时器时不重复排）。 */
  const schedulePullRetry = (): void => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  /**
   * 读取本插件的 settings 命名空间并订阅变更。
   *
   * 0.1.7 变更：`settingsScope` 服务已从内核移除（随 settings.yaml 体系一起
   * 退役），本插件的命名空间改由 `ctx.remote.settings` 读写：
   *  - 读：`remote.settings.describe()` → 解包 RPC 信封 → 按 ns 找 `namespaces[]`；
   *  - 变更：`remote.$on('settings/document-updated')` —— 该事件在内核的转发
   *    白名单里（dsh-api-remotes 的 `API_REMOTE_FORWARDED_EVENTS`，mode: 'emit'），
   *    内核自己的设置页也是这么订阅的（见 dsh-client-ui-settings 的
   *    `SettingsDescribeMirror`）。**无轮询**：host 推 `_push` 必然改 revision，
   *    于是事件只在真实推送时到达。
   *
   * 载荷结构与 0.1.5 时代完全一致（`_push` / `_ops` 仍是 JSON 字符串），故下面
   * 的解析与 `*SessionId` 归属守卫逐字保留。
   */
  // ── 流式投递（#108 决策 ①，默认关）───────────────────────────────────────
  // 增量帧**只在内存里走这条通道**：不写 settings、不落盘（验收硬判据：增量帧的
  // `push landed` 计数恒为 0）。终帧之后那次 `_push` 照旧发生，那才是权威态。
  const GHOST_STREAM_INJECT_KEY = `remote.${GHOST_STREAM_NAMESPACE}`;
  /**
   * #113：本回合的帧痕迹（DOM 侧可读的副本）。
   *  - 上限钉死：正常一回合的帧数由宿主限频窗口决定，远到不了 64；钉上限是为了
   *    "无界增长"这种错法不可能发生，而不是为了省内存。
   *  - 换**会话或换回合**都清空（键里带 sessionId：只看 turn 的话，切到一个 turn 号
   *    相同的会话会把上一会话的痕迹当成同回合续下去）。
   */
  const STREAM_FRAMES_MAX = 64;
  let streamFramesLog: StreamFrameRecord[] = [];
  let streamFramesKey = '';
  /** 当前在显示的增量帧（null = 没有；换会话/改草稿/终帧落地都会清）。 */
  let streamedFrame: { sessionId: string; text: string; frame: number; final: boolean; turn: number } | null = null;
  /** 上一次看到的会话 running 值（抓 true→false 那个边沿用）。 */
  let lastRunning = false;
  /** 懒注入完成后回填的命名服务对象；未回填前一切按"通道不可用"处理。 */
  let ghostStreamNamespace: { suggest?: (id: string, signal: AbortSignal) => AsyncIterable<never> & { dispose?: () => void } } | undefined;
  /** 低频诊断行（每回合几条）：走 console.debug，默认阈值下不刷屏，TRACE=debug 可见。 */
  const streamTrace = (msg: string): void => {
    console.debug(`[dsh-suggest-ghost][ops-trace] ${msg}`);
  };
  const ghostStream = createGhostStreamChannel({
    // **必须是 getter**：命名空间要等懒注入完成后才回填，静态取值会永远拿到 undefined。
    get namespace() {
      return ghostStreamNamespace as never;
    },
    onFrame: (frame, sessionId) => {
      // 每帧一行（带页内时刻 t=）：这是"帧到没到、彼此隔多久"的唯一直接证据。宿主侧只能
      // 看到 subs>0；而 15ms 的页外轮询会把挤在一起的两帧读成"一次变化"，所以提前量必须
      // 由这些 t= 值算，不能靠采样。
      streamTrace(`stream frame=${frame.frame} final=${frame.final ? 1 : 0} chars=${frame.text.length} turn=${frame.turn} t=${Math.round(performance.now())}`);
      // #113：DOM 侧痕迹。**必须紧跟在 streamTrace 之后、下面两道防御过滤之前** ——
      // 判据 1 要的是"与 `stream frame … t=` 逐格对齐"，放到过滤之后就变成两套真相
      //（被丢的乱序旧帧留痕里有、DOM 里没有，两条来源就互相校验不起来了）。
      const framesKey = `${sessionId}|${frame.turn}`;
      if (streamFramesKey !== framesKey) {
        streamFramesKey = framesKey;
        streamFramesLog = [];
      }
      streamFramesLog.push({
        frame: frame.frame, final: frame.final ? 1 : 0,
        chars: frame.text.length, t: Math.round(performance.now()),
      });
      if (streamFramesLog.length > STREAM_FRAMES_MAX) {
        streamFramesLog.splice(0, streamFramesLog.length - STREAM_FRAMES_MAX);
      }
      overlay.setStreamFrames(streamFramesLog);
      if (streamedFrame !== null && streamedFrame.sessionId !== sessionId) return;
      // 帧号单调：乱序或重放的旧帧直接丢（宿主限频窗口已保证单调，这里是防御）。
      if (streamedFrame !== null && streamedFrame.turn === frame.turn && frame.frame < streamedFrame.frame) return;
      streamedFrame = { sessionId, text: frame.text, frame: frame.frame, final: frame.final, turn: frame.turn };
      render();
    },
    onState: (state, sessionId, note) => {
      streamTrace(`stream ${state} session=${sessionId.slice(0, 12)}${note === '' ? '' : ' note=' + note}`);
      if ((state === 'closed' || state === 'unavailable') && streamedFrame?.sessionId === sessionId) {
        streamedFrame = null;
      }
    },
  });
  /** 取当前会话可显示的增量帧（开关关 / 归属不符 / 没有 = null）。 */
  const streamFrameFor = (currentId: string | undefined) => (
    settings.streamingDelivery && streamedFrame !== null && streamedFrame.sessionId === currentId
      ? streamedFrame
      : null
  );
  const remote = remoteOf(ctx);
  if (remote?.settings !== undefined) {
    let lastRevision = -1;
    let describeInFlight = false;
    /**
     * 上一次**解析过的 `_push` 原文**与它的解析产物（#36 建议 2 的读侧收益）。
     *
     * 为什么存原文而不是对象：宿主拆格之后，一次纯热度变化只动 `_hot`，`_push` 那串
     * 字节**逐字不变**。拿原文当判据就能整段跳过建议格的重复工作——重复 `JSON.parse`、
     * 重复走一遍帧判据（`resolvePayloadFrames` 会读写台账），以及由此产生的
     * 「建议对象换了一个新引用」。三者都是一次纯热度变化**不该**触发的。
     *
     * 陈旧帧被拒时同样先把原文记下来：处理它 = 丢弃它，重复投递不该再处理一遍。
     */
    let lastPushRaw = '\u0000'; // 哨兵：保证第一次必然解析
    let lastPushed: PushedPayload | null = null;
    let lastFrames: ReturnType<typeof resolvePayloadFrames> | null = null;
    const applySettings = (): void => {
      void (async () => {
        if (describeInFlight) return;
        describeInFlight = true;
        try {
          const described = await remote.settings!.describe();
          const list = unwrapSettingsDoc(described)?.namespaces ?? [];
          const entry = list.find((row) => row.ns === SETTINGS_NAMESPACE);
          if (entry === undefined) return;
          // revision 未变说明没人改过（事件可能因其他命名空间的写入而到达）。
          const rev = typeof entry.revision === 'number' ? entry.revision : 0;
          if (rev === lastRevision) return;
          lastRevision = rev;
          pushCellStats.applies += 1;
          const v = (entry.value ?? {}) as Record<string, unknown>;
          const pushRaw = typeof v._push === 'string' ? v._push : '';
          const pushCellChanged = pushRaw !== lastPushRaw;
          let pushed: PushedPayload | null;
          if (pushCellChanged) {
            pushCellStats.parses += 1;
            lastPushRaw = pushRaw;
            pushed = null;
            if (pushRaw !== '') {
              try {
                pushed = JSON.parse(pushRaw) as PushedPayload;
              } catch {
                pushed = null;
              }
            }
            lastPushed = pushed;
          } else {
            // 建议格逐字未变 ⇒ 连 parse 都不做，直接沿用上次的产物（对象引用也不换）。
            pushCellStats.cellSkips += 1;
            pushed = lastPushed;
          }
          // 热度格（`_hot`）：与 `_push` **各自解析、各自判变**。解析失败/整格缺省都
          // 按「这一格没说话」处理（下面每个字段都回落到 `settings.x` 现值），
          // 绝不落到「清空」——那是把宿主的读失败放大成用户数据丢失。
          let hotPushed: HotPushedPayload | null = null;
          if (typeof v._hot === 'string' && v._hot !== '') {
            try {
              hotPushed = JSON.parse(v._hot) as HotPushedPayload;
            } catch {
              hotPushed = null;
            }
          }
          // 一格一个来源：新宿主写 `_hot`，旧宿主把热度塞在 `_push` 里。两处的键
          // 都读，优先用新格（新宿主两格都写时不会互相覆盖）。
          const hotSource: HotPushedPayload = hotPushed ?? pushed ?? {};
          // ── #38：帧号与终态判据（载荷解析处，越靠前越好：陈旧帧根本不该进入状态）──
          //
          // 判据本体在 `accept-guard.ts` 的 {@link resolvePayloadFrames}（纯函数，可被
          // `scripts/frame-monotonic-smoke.mjs` / `scripts/legacy-payload-smoke.mjs` 离线
          // 驱动）。这里只接线，三条结论：
          //  - `accept === false` → 陈旧帧，整条载荷作废（不改 settings、不刷缓存、不 render）；
          //  - `suggestionFrame` → 交给采纳链（Tab / `→` 只认终帧）；
          //  - `completionFrame` → 省略=保留现值、显式 null=归回缺省，与 completion 本体同款。
          //
          // 台账 `frameLedger` **独立于文档 revision**：上面 `rev === lastRevision` 是文档级
          // 相等早退（载荷自带的 `rev` 客户端从不读），两者不共用判据，否则宿主一次自写就会
          // 把终帧判成「没变化」而丢掉。
          let frames: ReturnType<typeof resolvePayloadFrames>;
          if (pushCellChanged || lastFrames === null) {
            pushCellStats.frameRuns += 1;
            frames = resolvePayloadFrames({
              ledger: frameLedger,
              pushed,
              prevCompletionFrame: settings.completionFrame,
            });
            frameLedger = frames.ledger;
            lastFrames = frames;
          } else {
            // 建议格没变 ⇒ 帧判据一行都不重跑（台账不动、对象引用不换、`traceClear` 不触发）。
            frames = lastFrames;
          }
          // 读侧工作量的现场证据：只在**理由变化**时打一行，且只打次数（无正文）。
          traceOnce('push-cell', pushCellChanged ? 'suggestion-cell-changed' : 'hot-cell-only',
            ` parses=${pushCellStats.parses} frameRuns=${pushCellStats.frameRuns}`
            + ` cellSkips=${pushCellStats.cellSkips} applies=${pushCellStats.applies}`);
          if (!frames.accept) {
            traceOnce('stale-frame', frames.outcome,
              ` bucket=${String(frames.bucket)} ${frameHintFields(frames.suggestionFrame)}`
              + ` seen=${String(frames.seen)} dropped=${frames.ledger.dropped}`);
            return;
          }
          // 建议在场且不是旧载荷、或建议被显式作废：都是「判据在正常跑」的证据，闸门重新开门。
          if (frames.outcome !== 'legacy') traceClear('stale-frame', null);
          const next: typeof settings = {
            historyEnabled: typeof v.historyEnabled === 'boolean' ? v.historyEnabled : true,
            historyCrossSession: typeof v.historyCrossSession === 'boolean' ? v.historyCrossSession : false,
            historyMaxEntries: typeof v.historyMaxEntries === 'number' ? v.historyMaxEntries : 50,
            historyMinChars: typeof v.historyMinChars === 'number' ? v.historyMinChars : 1,
            inlineEnabled: typeof v.inlineEnabled === 'boolean' ? v.inlineEnabled : true,
            streamingDelivery: typeof v.streamingDelivery === 'boolean' ? v.streamingDelivery : false,
            inlineDelayMs: typeof v.inlineDelayMs === 'number' ? v.inlineDelayMs : 100,
            inlineMinChars: typeof v.inlineMinChars === 'number' ? v.inlineMinChars : 4,
            wordAccept: typeof v.wordAccept === 'boolean' ? v.wordAccept : true,
            suggestion: pushed?.suggestion === null || pushed?.suggestion === undefined
              ? null
              : (pushed.suggestion as typeof settings.suggestion),
            // 归一化后的帧提示（#38）：作废/缺省都由判据本身回 {@link LEGACY_FRAME_HINT}。
            suggestionFrame: frames.suggestionFrame,
            // 热度快照：显式 null = 宿主说「没有热度」；缺省 = 这一格没说话 ⇒ 保留现值。
            // （旧实现里缺省会被判成 null，两格拆开之后这个区别第一次变得可观测。）
            hot: hotSource.hot === null || hotSource.hot === undefined
              ? (hotPushed === null && pushed?.hot === undefined ? settings.hot : null)
              : (hotSource.hot as typeof settings.hot),
            // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
            // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
            // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
            history: Array.isArray(hotSource.history)
              ? (hotSource.history as unknown[]).filter((t): t is string => typeof t === 'string')
              : settings.history,
            historySessionId: Array.isArray(hotSource.history)
              ? (typeof hotSource.historySessionId === 'string' ? hotSource.historySessionId : null)
              : settings.historySessionId,
            suggestionSessionId: typeof pushed?.suggestionSessionId === 'string' ? pushed.suggestionSessionId : null,
            // 续写：载荷省略 = host 未更新（保留现值，显示时仍以 draft 全等校验兜底）；
            // 显式 null = host 作废（切会话/回合结束清理）。
            completion: pushed?.completion === undefined
              ? settings.completion
              : (pushed.completion as typeof settings.completion),
            // 续写的帧提示（#38）：本期宿主不出帧号，这里只可能带 `final`。
            completionFrame: frames.completionFrame,
            completionSessionId: pushed?.completion === undefined
              ? settings.completionSessionId
              : (typeof pushed.completionSessionId === 'string' ? pushed.completionSessionId : null),
          };
          // **值未变则整条链路止步**（#21 待查项 2 的读侧放大）：内核事件只带
          // `(ns, revision)`，revision 推进不代表本插件关心的东西变了——host 每分钟
          // 数十次的 `_push` 里大部分字段常年不变，而旧代码无条件替换 `settings` 对象
          // 引用，于是 settingsEpoch++ → 归一化/打分/幽灵三处缓存全废 → render() →
          // 又一次 armed。深比较用 configValuesEqual（先比引用再递归，`history` 省略时
          // 保留的就是同一个数组引用，一次比较即命中）。
          if (configValuesEqual(next, settings)) return;
          // settings 实际变更 → 失效所有归一化/打分缓存，避免返回陈旧结果。
          // 纯读比较：新对象里的建议是不是同一个引用（不动任何判据分支）。
          if (next.suggestion !== settings.suggestion) pushCellStats.suggestionRefSwaps += 1;
          settingsEpoch++;
          clearNormalizeCache();
          hotCountsCache = null;
          ghostContentCache = null;
          settings = next;
          // 收到 host 新鲜数据后立即持久化，下次冷启动可立即恢复。
          saveToCache({
            hot: settings.hot,
            history: settings.history,
            historySessionId: settings.historySessionId,
            suggestion: settings.suggestion,
            // 帧提示一起持久化：冷启动恢复出的建议不能是「provisional 却被当成终帧采纳」。
            suggestionFrame: settings.suggestionFrame,
            suggestionSessionId: settings.suggestionSessionId,
          });
          renderTraced('other');
        } catch {
          // describe 失败（网络抖动/后端未就绪）时保留现值，等下一个事件或重连。
        } finally {
          describeInFlight = false;
        }
      })();
    };
    // 首读一次（事件只推增量），此后由内核的事件驱动——无轮询。
    // `connection/reset` 后需重新首读：那之前的订阅与缓存都可能已失效。
    //
    // **按命名空间过滤**（#21 待查项 2）。内核事件签名是
    // `settings/document-updated(ns, revision)`，任何插件条目自己的表单值/schema/页面
    // 策略变化都会广播这一条；旧 handler 忽略入参，于是别的命名空间每写一次，本插件
    // 就多一次 describe 往返。这不只是浪费：内核的 `describe()` 自身会在 raw 发生变化的
    // 条目上 emit 本事件（@deepseek-ai/dsh-settings `lib/index.js` 的 describe 体内
    // `emit("settings/document-updated", …)`，同文件 `write()` 又反过来调 `describe()`），
    // 即「一次读可能再喂出一条事件」。读↔事件互相喂火的环要靠这个闸口切断。
    // 载荷不带 ns 的宿主（签名变化/远端信封剥掉了参数）退化成原样处理，由下游的
    // revision 相等早退 + 值深比较兜底，不会因此漏更新。
    const onDocumentUpdated = (...args: unknown[]): void => {
      const ns = typeof args[0] === 'string' ? args[0] : undefined;
      if (ns !== undefined && ns !== SETTINGS_NAMESPACE) return;
      applySettings();
    };
    const offUpdated = remote.$on?.('settings/document-updated', onDocumentUpdated);
    // 流式通道挂载。**先 $mount 再懒 ctx.inject**：`remote.<ns>` 是子服务键，直接
    // 属性访问会抛 cannot get property "remote.ghostStream" without inject（与本文件
    // 上方 remote.settings 那条是同一条 cordis reflect 规则）；而把它写进模块级 inject
    // 又会在挂载之前就把整条 fiber park 死 —— 两种错法都要避开。
    // 形状照官方先例 dsh-experimental-client-ui-cot-translation/lib/client.js:1027-1029。
    if (typeof remote.$mount === 'function') {
      void Promise.resolve()
        .then(async () => {
          const unmount = await remote.$mount!(ghostStreamContribution());
          void ctx.inject([GHOST_STREAM_INJECT_KEY], (child: Context) => {
            // 注入回来的 child 是宿主 Context；本插件保持零内核导入，所以这里一次性
            // 走 unknown 收口，形状由 stream-ghost.ts 的本地最小面负责。
            const childRemote = (child as unknown as { remote?: Record<string, unknown> }).remote;
            ghostStreamNamespace = childRemote?.[GHOST_STREAM_NAMESPACE] as typeof ghostStreamNamespace;
            streamTrace('stream namespace bound');
            return () => undefined;
          });
          return unmount;
        })
        .then((unmount) => { ctx.effect(() => unmount, 'suggest-ghost: stream mount'); })
        .catch((error: unknown) => {
          // 挂不上 = 这代次没有这条通道：留一行 warn（用户来报障时先看的那行），
          // 功能自动退化成"整块到达"，不影响任何既有判据。
          console.warn(`[dsh-suggest-ghost][ops-trace] stream unavailable, falling back to whole-block push: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
        });
    }
    const offReset = ctx.on('connection/reset', () => applySettings());
    ctx.effect(() => () => {
      offUpdated?.();
      offReset();
    });
    applySettings();
  }

  /** Tab（或配置键）整条采纳；幽灵显示时裸 → 逐词采纳。 */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (shown === null) return;
    // 焦点必须在会话输入框内（textarea 或 0.1.2 contenteditable composer）。
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement)
      && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
    const content = shown.content;
    // CAS 基线：这份 content **计算时**所用的草稿快照（文本 + 宿主 draftRev）。
    const base = shown.base;
    const acceptKey = content.kind === 'llm' ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (matcher !== undefined && matcher(event)) {
      // ── #38 采纳闸（整条）：只认终帧 ─────────────────────────────────────────
      // provisional 帧（宿主显式带 `final: false`）上**直接放弃**：不写一个字符。
      // 也**不吞按键**（不 preventDefault）——这一支等价于「此刻没有可采纳的幽灵」，
      // Tab 就此回到浏览器原生行为（插入制表符/移焦点），比「按了没反应」诚实。
      // 缺字段一律视为终帧（旧载荷行为逐字不变），判据见 accept-guard.ts 的 `gateAccept`。
      const gate = gateAccept(content.frame);
      if (!gate.allow) {
        traceOnce('accept-gate-tab', gate.reason,
          ` kind=${content.kind} ${frameHintFields(content.frame)}`
          + ` ghostChars=${acceptTarget(content).length} draftChars=${base.draft.length}`);
        return;
      }
      traceClear('accept-gate-tab', null);
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        // LLM 下一条建议：直接覆盖草稿（用户空草稿时按 Tab，本就无前缀）。
        // 历史补全：若草稿是斜杠命令整行（如 `/later +3m 我`），`full` 是历史
        // 里的「内容」部分（命令 `recordInput:false`，不含命令名+参数）。
        // 此时采纳必须把命令前缀一并回填，否则用户命令意图被破坏——只剩
        // 内容部分，需要重新键入 `/later +3m ` 才能执行。
        //
        // 读-改-写竞态（Gitea #4）：accepted 完全由 base.draft 推导，故写入前
        // 重读宿主快照并与 base 比对（有 draftRev 按版本号，没有则退化为内容
        // 等值，判据见 accept-guard.ts）。一旦漂移，说明用户在这两步之间又打
        // 了字——本次采纳**整段放弃**，一个字符都不写，新输入原样留在草稿里；
        // 幽灵照旧收掉（下一次 render 会按新草稿重新出建议）。
        const accepted = buildFullAccept(content, base.draft);
        const input = bound.input;
        const outcome = commitDraftIfPristine(
          base,
          readDraftSnapshot(input.state.getSnapshot()),
          () => { input.setDraft(accepted); },
        );
        if (!outcome.committed) {
          // #39：这条分支「判据在跑、留痕被摘空」了很久——CAS 放弃与采纳成功在观测上
          // 同形，用户报「按了 Tab 我打的字没了/没反应」时客户端无从分辨。补回一行，
          // 依旧**按理由变化才打**（同一次风暴里 rev 反复漂移不会刷屏）。
          // 只打字符数：采纳目标文本、草稿正文都不进日志。
          traceOnce('tab-abandon', outcome.reason ?? 'unknown',
            ` kind=${content.kind} acceptedChars=${accepted.length}`
            + ` baseDraftChars=${base.draft.length} baseRev=${String(base.rev)}`
            + ` ${frameHintFields(content.frame)}`);
        } else {
          traceClear('tab-abandon', null);
        }
      }
      overlay.hide();
      shown = null;
      return;
    }
    // 逐词采纳：裸右方向键、光标位于草稿末尾时每次前进一个分词片段。
    // 其余情况一律不拦截（保留浏览器光标移动/焦点行为）；草稿与建议原文
    // 字面分歧（归一化等价但字符不同）时也不劫持，避免拼接出重复片段。
    // 历史补全下若草稿是斜杠命令整行（如 `/later +3m 我`），命令名+参数段
    // 不在候选 `full` 里，要用剥前缀后的 contentDraft 做前缀匹配；采纳后
    // 把命令前缀段（含时间参数）一并保留，避免命令意图被破坏。
    if (settings.wordAccept
      && event.code === 'ArrowRight'
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = focused;
      const full = acceptTarget(content);
      // ── #38 采纳闸（逐词）：只认终帧 ─────────────────────────────────────────
      // 与整条采纳同一条判据，放在所有会吞按键的动作**之前**：provisional 帧上
      // `→` 回到原生的光标移动，一个字符都不写。
      const wordGate = gateAccept(content.frame);
      if (!wordGate.allow) {
        traceOnce('accept-gate-word', wordGate.reason,
          ` kind=${content.kind} ${frameHintFields(content.frame)}`
          + ` ghostChars=${full.length} draftChars=${base.draft.length}`);
        return;
      }
      traceClear('accept-gate-word', null);
      // 光标必须在草稿末尾：textarea 用 selectionStart/End，contenteditable
      // 用 Selection API（caretAtComposerEnd 统一两代）。
      if (!caretAtComposerEnd(ta)) return;
      const matchBase = wordMatchBase(content, base.draft);
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === '') return;
      event.preventDefault();
      event.stopPropagation();
      const accepted = buildWordAccept(content, base.draft, matchBase, chunk);
      if (bound !== null) {
        // 与整条采纳同一条 CAS 判据（#4）：草稿在计算与写入之间被改过就放弃，
        // 不写任何字符，并收掉幽灵。
        const input = bound.input;
        const outcome = commitDraftIfPristine(
          base,
          readDraftSnapshot(input.state.getSnapshot()),
          () => { input.setDraft(accepted); },
        );
        if (!outcome.committed) {
          // #39：与整条采纳同款留痕（此前这里也是一支空块——判据在跑、输出被摘空）。
          traceOnce('word-abandon', outcome.reason ?? 'unknown',
            ` kind=${content.kind} chunkChars=${chunk.length} acceptedChars=${accepted.length}`
            + ` baseDraftChars=${base.draft.length} baseRev=${String(base.rev)}`
            + ` ${frameHintFields(content.frame)}`);
          overlay.hide();
          shown = null;
          return;
        }
        traceClear('word-abandon', null);
      }
      if (wordAcceptSettled(content, accepted)) {
        overlay.hide();
        shown = null;
      }
    }
  };

  ctx.effect(() => {
      // 订阅：会话列表（切换信号）、会话快照、输入草稿、投影值。
    let unsubs: Array<() => void> = [];
    let deferredRenders: Array<ReturnType<typeof setTimeout>> = [];
    const scheduleDeferredRenders = (): void => {
      for (const t of deferredRenders) clearTimeout(t);
      // React 提交会话视图晚于 list store 更新：rebind 时 composer 可能尚未
      // 挂载，show() 会找不到编辑器；错峰补渲染覆盖这个竞态（幽灵显示后
      // 幂等，重复渲染无副作用）。
      //
      // #38：增长期间让路。这三个定时器的职责只有「覆盖挂载竞态」；幽灵既然已经画在
      // 屏幕上、又正处在一枚同代增长的帧流里，补渲染就只是把同一段文本再重画一遍
      // （顺带把 ghostContent 缓存之外的 render 全链跑一次）。判据在
      // {@link shouldSkipDeferredRepaint}，跳过次数进 tally。
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(() => {
        if (shouldSkipDeferredRepaint({ painted: overlay.isPainted, growing: overlay.growing })) {
          deferredRepaintSkips += 1;
          traceOnce('deferred-repaint', 'growth-streak',
            ` skipped=${deferredRepaintSkips} paints=growth:${overlay.paints.growth}`
            + `/remeasure:${overlay.paints.remeasure}/rebuild:${overlay.paints.rebuild}`);
          return;
        }
        traceClear('deferred-repaint', null);
        renderTraced('other');
      }, ms));
    };
    /**
     * 退订当前 `bound` 的三条 store 订阅并按当前 `bound` 重新订阅。
     *
     * 单一出口：`rebind()` 与 `resolve()` 的换绑路径都走这里，`unsubs` 因此始终与
     * `bound` 一一对应（旧实现里 resolve 换绑不重订阅，旧会话订阅会一直挂着）。
     */
    const subscribeBound = (): void => {
      for (const un of unsubs) un();
      unsubs = [];
      if (bound === null) return;
      // 回调里不能直接读 bound：它是可重新赋值的闭包变量，TS 无法把
      // 「if (bound === null) return」的收窄带到异步回调里 ⇒ 先抓一份局部常量。
      const b = bound;
      unsubs.push(
        b.session.subscribe(() => {
          // 回合结束边沿（running: true → false）就是"该开流了"的信号。
          // 生成是宿主在 turn/end 触发的，客户端拿不到回合号，但拿得到这个边沿
          // ⇒ 零往返、零落盘。（不选"常驻一条流"：要为每个会话养一条跨回合存活的
          //  sink，还得处理僵尸流与在途旧帧；不选"宿主发开始信号"：settings 面发一个
          //  信号 = 一次整档重写，实测 writeMs 361–2260ms，反而把首帧推后。）
          const running = (b.session.getSnapshot() as { running?: boolean }).running === true;
          if (lastRunning && !running && settings.streamingDelivery) {
            const id = currentSessionIdOf(sessions.list.getSnapshot());
            if (id !== undefined) ghostStream.open(id);
          }
          lastRunning = running;
          renderTraced('session');
        }),
        b.input.state.subscribe(() => {
          // 用户改草稿 = 这一帧之后都不该再显示 ⇒ 撤帧。**用 dispose 不用 abort**
          // （实测 abort 会在迭代里抛一次异常再被吞，留下一条看起来像失败的痕迹）。
          if (readDraftSnapshot(b.input.state.getSnapshot()).draft.trim() !== '') ghostStream.close('draft-changed');
          renderTraced('input');
        }),
        bound.projectionFace.subscribe(() => renderTraced('face')),
      );
    };
    const rebind = (knownId?: string | undefined): void => {
      // 先摘钩子：resolve() 换绑时它本会重订阅，而下面无条件再调一次，两次会
      // 「订完立刻退」空转一遍；这里由 rebind 独占重订阅。
      const hook = resubscribeBound;
      resubscribeBound = null;
      try {
        resolve(knownId ?? currentSessionIdOf(sessions.list.getSnapshot()));
      } finally {
        resubscribeBound = hook;
      }
      subscribeBound();
      scheduleDeferredRenders();
    };
    resubscribeBound = subscribeBound;
    rebind();
    renderTraced('other'); // 初始渲染：不依赖订阅触发（修复：会话打开即检查幽灵）
    // 历史环的拉取在 resolve() 绑定成功处统一发起（冷启动经上面的 rebind），
    // 这里不再补发——旧的「初始化时拉一次」在会话尚未就绪时必然落空。
    const onList = (): void => {
      // 会话切换（mainView 保有者变化）→ 重绑订阅（resolve 内即发起 pull）；否则仅渲染。
      const id = currentSessionIdOf(sessions.list.getSnapshot());
      if (id !== lastSessionId) rebind(id);
      renderTraced('other');
    };
    const unList = sessions.list.subscribe(onList);
    // IME 组词抑制：捕获监听（编辑器内组合事件会冒泡到 window）。组词开始
    // 立即隐藏幽灵；结束（候选上屏）后按已提交草稿重新渲染。
    const onCompositionStart = (): void => {
      composing = true;
      renderTraced('other');
    };
    const onCompositionEnd = (): void => {
      composing = false;
      renderTraced('other');
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      unsubs = [];
      resubscribeBound = null;
      for (const t of deferredRenders) clearTimeout(t);
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      pendingPull = null;
      clearInlineTimer();
      // 计时器句柄已清，策略状态必须同步归零：留着旧 ticket 会让重绑后的第一帧
      // 把「同键观察」判成 skip，于是再也不 armed。
      armState = initialInlineArmState();
      // 留痕闸门同样归零：重绑后第一条 cancel 必须能再打出一行（否则跨会话的同理由
      // 会被上一轮的 last 吃掉，现场看不到）。
      traceClear('inline-arm-cancel', null);
      traceClear('form-hold', null);
      traceClear('deferred-repaint', null);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      overlay.dispose();
    };
  }, 'dsh-suggest-ghost: composer ghost render');

  // 设置界面：往 `settings.section` 注册一个**独立设置页**。
  //
  // 槽位名必须是宿主真实存在的那个：`settings.section`（`kind: 'list'`、
  // `scope: 'root'`，每个 list entry 一页设置）。注册项靠 `id` 作导航标识、
  // `order` 定位置、`label` 出导航文案。
  //
  // **不要用 `settings.plugin.item`**：那个名字在 DSH 0.1.7-rc.2 与 0.2.0-rc.2
  // 里都不存在（全仓 grep 零命中）。往不存在的槽位注册不会报错，只是永远没人
  // 消费——表现为「服务都拿到了、注册也执行了、界面就是不画」，极难排查。
  // 宿主实际提供的相关槽位是 `settings.section` / `settings.plugins` /
  // `settings.plugins.tab` / `settings.general.item`。
  //
  // `label` 传 thunk：宿主每次投影都会重读，语言切换后无需重新注册。文案走本文件
  // 的 SECTION_LABELS + locale 快照（`sectionLabel()`），不依赖 locale/ 资源文件
  // ——`settings.section` 的 `label` 是普通函数，不是内核 locale 目录查找。

  // 插件详情页卡片（0.1.7+ / 0.2.0+）：configForms 表单 + `plugins.bundle.config` 卡片。
  // 寻址键是条目 id（`cordis.patch.yml` 的 `id: suggest-ghost`），不是 settings namespace。
  // 注意：configForms 不在顶层 inject，用嵌套 ctx.inject 按需等待（与 later 插件一致）。
  // 必须在提前返回之前注册，否则 remote.settings 缺失时卡片不会显示。
  const ENTRY_ID = 'suggest-ghost';
  // 必须用 ctx.slots（不是 ctx.get('slots')），两者在 0.2.0 中是不同的对象。
  // later 插件直接用 ctx.slots.inject / ctx.slots.register 才能正确注册到宿主。
  // key 必须是**插件包名**（dsh-suggest-ghost）：宿主按
  // `ledger.bundles.has(pkg.name)` 判断是否渲染配置区，
  // key 不匹配 → configured=false → 卡片静默不渲染。
  // 寻址键（entryId）只用于 configForms.get()，与此无关。
  if ((ctx as any).slots !== undefined) {
    ctx.inject(['configForms'], () => {
      const forms = ctx.get('configForms') as any;
      if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return;
      const formScope = forms.get(ENTRY_ID);
      ctx.effect(
        () =>
          forms.whileServed([ENTRY_ID], () =>
            (ctx as any).slots.inject('plugins.bundle.config', () =>
              (ctx as any).slots.register({
                name: 'plugins.bundle.config',
                key: 'dsh-suggest-ghost',
                locale: 'dsh-suggest-ghost',
                inject: () => ({ scope: formScope, locale, surface: 'detail' as const }),
              }, SuggestGhostCard),
            ),
          ),
        'dsh-suggest-ghost: plugins-page card',
      );
    });
  }

  // 设置对话框中的设置页：默认不显示，由插件详情页的开关控制。
  // 开关状态存储在 localStorage 中，key 为 'dsh-suggest-ghost:show-settings-section'。
  const remoteForCard = remoteOf(ctx);
  if ((ctx as any).slots === undefined || remoteForCard?.settings === undefined) return;

  const SHOW_SETTINGS_KEY = 'dsh-suggest-ghost:show-settings-section';
  const showSettingsSection = typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';

  if (!showSettingsSection) return;

  // scope **只建一次**并挂在注册表上：
  //  - 在 `inject` 里现建会让每次渲染都换一个新 scope（新的事件订阅 + 空快照），
  //    卡片拿到的永远是 `status: 'loading'`；
  //  - 生命周期由槽位 disposer 负责（卸载时退订），与卡片的订阅互不干扰。
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE);
  const disposeSection = (ctx as any).slots.inject('settings.section', () => (ctx as any).slots.register({
    name: 'settings.section',
    // 自有 id：用宿主没有的 id 才会「并排新增一页」，复用宿主 id 会顶掉那一页。
    id: SETTINGS_SECTION_ID,
    order: 40,
    label: () => sectionLabel(locale),
    // 卡片只依赖 scope 的 get/subscribe/set 三个成员（见 settings-card.tsx 的
    // PluginSettingsScope），这里用 remote.settings 适配出同形状的最小面：
    // 0.1.7 已无 settingsScope 服务，而卡片逻辑（读快照 / 订阅变更 / 写字段）
    // 与代次无关，不必改卡片本体。
    inject: () => ({ scope: cardScope, locale, surface: 'settings' as const, modelCatalog: () => officialCatalogReader?.() ?? null }),
  }, SuggestGhostCard));
  // ── 官方同源模型目录（#116 后续）：优先于自建 HTTP 目录 ─────────────────
  //
  // `ctx.modelDirectories` 是设置页模型选择器用的同一个客户端服务：`groups[].id` 就是
  // provider 路由 id、`models[].id` 就是 model id、`models[].reasoning` 带 efforts/defaultEffort
  // （官方代码里 `group.id === selection.provider` 已核实）。三个净收益：
  //   ① 与官方同一份数据、同一套标签（含"当前模型未提供推理等级"的空态语义）
  //   ② **不需要**那条不经鉴权的目录路由（#40 第 6 条的风险面直接消失）
  //   ③ 目录变化不依赖重启宿主（路由注册才依赖，#120）
  // 服务不存在（老内核/未挂）时读取器保持 null，卡片自动退回 HTTP 目录，再退回文本框。
  ctx.inject(['modelDirectories'], (catalogScope) => {
    interface RawEffort { readonly id?: unknown; readonly name?: unknown; readonly description?: unknown }
    interface RawModel {
      readonly id?: unknown; readonly name?: unknown;
      readonly reasoning?: { readonly efforts?: readonly RawEffort[]; readonly defaultEffort?: unknown };
    }
    interface RawGroup { readonly id?: unknown; readonly name?: unknown; readonly models?: readonly RawModel[] }
    const service = (catalogScope as unknown as {
      modelDirectories?: { readonly value?: { readonly groups?: readonly RawGroup[] } | null };
    }).modelDirectories;
    if (service === undefined) {
      // 服务没挂（老内核 / 该表面未提供）⇒ 保持 null，卡片退回自建 HTTP 目录。
      // 一行 debug 便于现场判断"哪一层退化"，默认阈值下不刷屏。
      console.debug('[dsh-suggest-ghost] modelDirectories unavailable; fallback to HTTP catalog');
      return;
    }
    officialCatalogReader = () => {
      const value = service.value;
      if (value === null || value === undefined) return null;
      const groups: OfficialModelGroup[] = [];
      for (const group of value.groups ?? []) {
        if (typeof group.id !== 'string' || group.id === '') continue;
        const models: { id: string; name: string; reasoning?: NonNullable<OfficialModelGroup['models'][number]['reasoning']> }[] = [];
        for (const model of group.models ?? []) {
          if (typeof model.id !== 'string' || model.id === '') continue;
          const efforts = (model.reasoning?.efforts ?? []).flatMap((effort) => {
            if (typeof effort.id !== 'string' || effort.id === '') return [];
            const name = typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id;
            return [typeof effort.description === 'string' && effort.description !== ''
              ? { id: effort.id, name, description: effort.description }
              : { id: effort.id, name }];
          });
          const defaultEffort = typeof model.reasoning?.defaultEffort === 'string'
            ? model.reasoning.defaultEffort
            : undefined;
          models.push({
            id: model.id,
            name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
            ...(model.reasoning === undefined
              ? {}
              : { reasoning: { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) } }),
          });
        }
        groups.push({
          id: group.id,
          name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
          models,
        });
      }
      return groups;
    };
    ctx.effect(() => () => { officialCatalogReader = null; });
  });
  if (typeof disposeSection === 'function') {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}

/**
 * 把 `remote.settings` 适配成设置卡片要用的 scope 最小面（store 形状：
 * getSnapshot / subscribe / set）。
 *
 * 这是 0.1.7 的替代品：旧 `settingsScope.bind({namespace})` 返回的对象直接给
 * `SuggestGhostCard`。**形状以卡片的实际调用为准**（settings-card.tsx）：
 *  - getSnapshot：返回 {@link ScopeSnapshot} **信封**（`status` / `value` /
 *    `writable`），引用稳定——卡片拿它当 `useState` 初值，返回新对象会每次订阅
 *    都重渲染；
 *  - subscribe：内核转发 `settings/document-updated` 事件即通知（回调不传参，
 *    调用方重读快照）；
 *  - set：经 `mutate` 写单个 volatile 字段，返回 Promise 供卡片 `await`。
 *
 * ⚠️ **信封而非裸值**：卡片读的是 `snap.status` / `snap.value` / `snap.writable`，
 * 直接返回 `entry.value` 会让 `status` 恒 undefined、`writable` 恒 falsy——表现为
 * 设置页所有控件虽渲染但显示「当前部署不可写（内存模式）」、保存必然失败。
 * 两边都标注成 `Record<string, unknown>`（索引签名把两种形状都吞了），所以
 * TypeScript 不会替你发现这个错配，改动此处务必对照卡片源码。
 */
function remoteSettingsScope(
  remote: RemoteLike,
  ns: string,
): PluginSettingsScope<ScopeSnapshot> {
  // 快照引用稳定：只在 describe 真正拿到新 revision 时整体替换。
  let snapshot: ScopeSnapshot = { status: 'loading', value: {}, writable: false };
  let revision = -1;
  const listeners: Array<() => void> = [];
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者抛错不牵连其余（与内核 store 的订阅语义一致）。
      }
    }
  };

  const readValue = (): void => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        const doc = unwrapSettingsDoc(described);
        const entry = (doc?.namespaces ?? []).find((row) => row.ns === ns);
        if (entry === undefined) return;
        const rev = typeof entry.revision === 'number' ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        snapshot = {
          status: 'ready',
          value: (entry.value ?? {}) as Record<string, unknown>,
          // `writable` 是 describe() 的**外层**字段（整个设置文档可否写），
          // 不是命名空间条目的字段。缺省视为可写（旧宿主不带该字段）。
          writable: doc?.writable !== false,
        };
        notify();
      } catch {
        // 后端未就绪时保留现值，等下一个事件或调用方重试。
      }
    })();
  };

  // 启动即读一次（卡片 mount 时就能拿到真值，不必等首个事件）。
  readValue();
  // 此后由内核转发的设置变更事件驱动——**无轮询**。`$on` 返回的 disposer 归
  // `dispose()` 管（scope 与订阅者是多对一：单个订阅者退订不销毁 scope）。
  // 同 applySettings：只认本命名空间的文档更新，别的条目写入不打到这里（省一次
  // describe 往返，也断掉「describe 内 emit → 再 describe」的喂火环）。
  const offUpdated = remote.$on?.('settings/document-updated', (...args: unknown[]) => {
    const evNs = typeof args[0] === 'string' ? args[0] : undefined;
    if (evNs !== undefined && evNs !== ns) return;
    readValue();
  });

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      // 退订**只移除这一个监听者**，绝不销毁 scope 本身。
      //
      // 踩过的坑：这里原本在退订时销毁了 scope（停掉其变更订阅），结果 React 卸载卡片时
      // （StrictMode 的挂载→卸载→再挂载、或用户切走设置页）scope 会永久失效，
      // `getSnapshot()` 永远停在 `status: 'loading'`、初始空值上——表现为所有控件
      // 都渲染成「当前部署不可写（内存模式）」且不显示任何真实取值。
      // scope 与订阅者是多对一关系，退订一个订阅者无权销毁它。
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: async (key, next) => {
      const svc = remote.settings;
      if (svc === undefined) return;
      // 冲突重试 + 退避 + **失败必须可见**（2026-10-23 修复：旧实现是「单次 mutate + 空
      // catch」，在宿主每秒数笔 `_push`/`_hot`/`_ops` 写顶 revision 的现实下几乎必然冲突，
      // 而失败被静默吞掉——现场证据：用户把「最少输入字符」改成 3，profile 里始终没有这个
      // 键，用户以为生效了）。每轮用**最新** revision（闭包变量由 document-updated 事件
      // 刷新），冲突按 `_ops` 写同款预算与退避重试（`opsConflictRetryAllowed` /
      // `opsConflictBackoffMs`，边界只有一份）；非冲突拒绝与预算耗尽都 warn——
      // 设置保存是低频显式动作，「没存上」必须让用户看见，不许静默。
      for (let attempt = 0; ; attempt += 1) {
        const expected = revision < 0 ? 0 : revision;
        let landedOk = true;
        let refusal: { code: string | undefined; message: string | undefined } | null = null;
        try {
          const mutated = await svc.mutate(ns, [{ op: 'set', path: [key], value: next }], expected);
          const outcome = unwrapMutateResult(mutated);
          if (outcome.ok === false) {
            landedOk = false;
            refusal = { code: outcome.code, message: outcome.message };
          }
        } catch (error) {
          landedOk = false;
          refusal = readRejection(error);
        }
        if (landedOk) {
          readValue();
          return;
        }
        if (refusal !== null && !isConflictRefusal(refusal.code, refusal.message)) {
          console.warn(`[suggest-ghost] settings save refused: key=${key} code=${String(refusal.code)} message=${String(refusal.message).slice(0, 140)}`);
          return;
        }
        if (!opsConflictRetryAllowed(attempt)) {
          console.warn(`[suggest-ghost] settings save conflict retries exhausted: key=${key} expectedRevision=${String(expected)} — 设置未持久化，请重试`);
          return;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, opsConflictBackoffMs(attempt));
        });
      }
    },
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners.length = 0;
    },
  };
}

function apply(ctx: Context): void {
  applyInner(ctx);
}

/**
 * 建议格（`_push`）的**读侧工作量计数**（Gitea #54）。
 *
 * ## 为什么要有它
 *
 * #36 建议 2 把 `_push` 拆成两格之后，唯一还没被行为侧证过的收益就是：
 * 「一次纯热度变化不该让建议格重新解析一遍、重跑一遍帧判据、动一次帧台账、
 * 换一次建议对象引用」。这句话要能被**证伪**，就得有个可数的东西。
 *
 * ## 为什么不能用 `renderHits`
 *
 * 幽灵内容的重算缓存条件是 `(draft, settingsEpoch, composing, running, currentId)` 全等，
 * 而热度列表与历史环**本来就参与**候选排序（`computeGhostContent` 的 history 分支与打分），
 * 所以热度一变 ⇒ `configValuesEqual` 为假 ⇒ `settingsEpoch++` ⇒ 缓存失效 ⇒ 幽灵重算。
 * **那是语义上正确的行为**，不是缺陷。用它当证据就会把「正确的重算」和「不该发生的重复解析」
 * 混成一团（这条口径 lead 在 #41 与 CHANGELOG 上公开更正过）。
 *
 * ## 三条设计约束
 *
 *  1. **只增不减**：断言比较的是差值（before/after），不是绝对值；重启页面才归零。
 *  2. **计数器打在决策分支上，不打在结果上**：`parses` 只在 `pushCellChanged` 那一支加，
 *     `frameRuns` 只在真的调用 `resolvePayloadFrames` 那一支加。改判据语义做不到「顺手」
 *     把计数加对——这正是可证伪性的来源。
 *  3. **留痕只打次数与原因，不打正文**（与 `#39` 的隐私口径一致，见 `traceOnce`）。
 *
 * `cellSkips` = 文档 revision 变了、但 `_push` 原文逐字没变的那几次——
 * 现场形态就是「只有热度格 `_hot` 在动」。
 */
export const pushCellStats = {
  /** 走进解析段的次数（`rev !== lastRevision` 之后、按格判重之前）。 */
  applies: 0,
  /** 真的对 `_push` 做了 `JSON.parse` 的次数。 */
  parses: 0,
  /** 真的重跑 `resolvePayloadFrames`（含读写帧台账）的次数。 */
  frameRuns: 0,
  /** 建议格原文未变 ⇒ 整段跳过解析与帧判定的次数。 */
  cellSkips: 0,
  /**
   * 建议对象的**引用**被换掉的次数。
   *
   * 这一条才配得上「不换建议对象引用」那句收益：`parses` 归零只证明没重新 parse，
   * 引用没换才是「下游拿到的还是同一个对象」（`ghostContent` 的缓存与 `saveToCache`
   * 都按引用读它）。判据是一次纯读比较，不动任何决策分支。
   */
  suggestionRefSwaps: 0,
  /**
   * 一条建议**因为归属不是当前会话**而被隐藏的次数（#56 的观测点）。
   *
   * 这条计数存在的唯一理由：载荷里**可以**带着别的会话的建议（`suggestionFieldsFor` 的
   * 既设计），而 #56 之后它更常出现——未判定的残留就是「归属还没判」的那一种。要让
   * 「B 在场时隐藏 A 的残留、切回 A 立即可用」这条**可断言**，就得有个能数的东西；
   * 只读 `settings.suggestionSessionId` 与 `currentId` 的关系，不改判据。
   *
   * 与 `llmGhostOffered` 配对读：一场「带归属别的会话的建议」应当是
   * `ownerHidden +1 且 llmGhostOffered +0`；切到那个会话之后应当反过来。
   */
  ownerHidden: 0,
  /** 建议格真的产出一条可显示的 LLM 幽灵的次数（`ownerHidden` 的反向观测点）。 */
  llmGhostOffered: 0,
};

export { apply, inject, name };
