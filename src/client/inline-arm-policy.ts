/**
 * 停顿续写的 armed 调度策略（issue #21）——**纯函数状态机，无 DOM / 无定时器**。
 *
 * ## 为什么要有这个文件
 *
 * 0.5.1 之前，`scheduleInlineTrigger()` 挂在 `render()` 首行，且每次调用都
 * `clearTimeout` + `setTimeout` 重来。于是 debounce 的真实语义是「**距离上一次
 * render 多久**」，而不是「**距离用户最后一次改草稿多久**」。render 的来源远不止
 * 按键：`settings/document-updated`（其他命名空间的写入也算）、`connection/reset`、
 * 会话列表变化、投影面变化、host `_push` 落地后的补渲染……一次 40 字符的输入实测
 * 打出 **1127 次 `inline armed`**，停顿计时器被无限推到重来，续写触发点被拖离用户
 * 真实停顿点，CPU 与日志一起遭殃（见 Gitea #21）。
 *
 * 本模块把判据从「render 次数」换成「**观察值是否变化**」：只有 draft / session /
 * ghostKind / 配置签名中的任一项真的变了，才允许重新计时。
 *
 * ## 状态机的三条不变量
 *
 * 1. **同键不重置**：ticket 与本次观察同键 → `skip`，既有到期时刻 `dueAt` 一字不动。
 * 2. **发过不再发**：同一 (session, draft) 已经发出过 `complete` → `skip`，直到草稿
 *    再变化。这条同时掐断了「fire→写 `_ops`→revision 变→事件回来→render→再 fire」
 *    的自循环。
 * 3. **幽灵已就位就不问**：当前已经在显示这个草稿的续写（ghostKind==='inline'）
 *    → `cancel`，续写都显示出来了，没有再问一次的理由。
 *
 * 调用方只负责执行决策（建/清真实的 setTimeout）并把 `settleInlineTimer` 用在定时器
 * 回调里；所有「该不该重新计时」的判断都在这里，因此可以被 node 直接测（见
 * `scripts/render-storm-smoke.mjs`）。
 *
 * ## 同族的另外两组判据（#38 第 2 条、#39 客户端留痕）
 *
 * 本文件后半段还住着两组**同样「无 DOM / 无定时器、可被 node 直接测」**的 render 侧
 * 判据：幽灵 overlay 的「同一次生成的文本增长」快路径，以及留痕的 reason-change
 * 闸口。放一起是因为它们与 armed 调度共享同一条教训（#21：每帧都跑的东西必须
 * 按观察值变化才动，日志同理），拆开四个文件只会让下次改动漏改一处。
 */

/** 幽灵形态（与 client 的 `GhostContent.kind` 同字面量；null = 当前无幽灵）。 */
export type InlineArmGhostKind = 'llm' | 'history' | 'inline' | null;

/** 一次 render 向策略提供的观察值（全部为不可变快照，策略不读外部状态）。 */
export type InlineArmObservation = {
  /** 观察时刻（ms，来自 `Date.now()`）。 */
  now: number;
  /** 当前草稿（原样，不做 trim；阈值判断才 trim）。 */
  draft: string;
  /** 当前会话 id；null = 未绑定会话（无 bound 时也传 null）。 */
  sessionId: string | null;
  /** 当前幽灵形态；决定「是否已经有续写可看」。 */
  ghostKind: InlineArmGhostKind;
  /** 停顿续写开关。 */
  enabled: boolean;
  /** 触发所需的最小草稿字符数。 */
  minChars: number;
  /** 停顿时长（ms）。 */
  delayMs: number;
  /** IME 组词中：组合文本还不是最终意图，不提问。 */
  composing: boolean;
};

/** 一次「有效 armed」：一个待发送的 complete 请求及其身份。 */
export type InlineArmTicket = {
  sessionId: string;
  draft: string;
  ghostKind: InlineArmGhostKind;
  minChars: number;
  delayMs: number;
  /** 绝对到期时刻（ms）。同键重复观察时该值必须保持不变。 */
  dueAt: number;
};

/** 策略状态（可序列化，无函数）。 */
export type InlineArmState = {
  /** 当前在跑的计时器；null = 无计时器。 */
  ticket: InlineArmTicket | null;
  /** 最近一次实际发出 `complete` 的会话；与 {@link firedDraft} 一起构成去重键。 */
  firedSessionId: string | null;
  /** 最近一次实际发出 `complete` 的草稿。 */
  firedDraft: string | null;
  /** 被判定为「同键」而抑制的 render 次数（诊断用，不参与决策）。 */
  suppressed: number;
};

/** 决策动作。 */
export type InlineArmAction =
  /** 无计时器在跑且本次合格 → 起新表。 */
  | 'arm'
  /** 已有计时器但观察键变了（真实输入/切换/配置变更）→ 重起。 */
  | 'reset'
  /** 观察键未变（或已为该草稿发过请求）→ **不动**现有计时器。 */
  | 'skip'
  /** 不合格（开关关闭/无会话/未达阈值/组词中/已有续写）→ 清掉现有计时器且不新建。 */
  | 'cancel';

/** 决策原因（诊断用；同时是日志里的 `reason=` 字段）。 */
export type InlineArmReason =
  | 'first-arm'
  | 'draft-changed'
  | 'session-changed'
  | 'kind-changed'
  | 'config-changed'
  | 'same-observation'
  | 'already-fired'
  | 'disabled'
  | 'no-session'
  | 'below-min-chars'
  | 'composing'
  | 'completion-visible';

export type InlineArmDecision = {
  action: InlineArmAction;
  reason: InlineArmReason;
  /** arm/reset 的绝对到期时刻；其余动作为 null。 */
  dueAt: number | null;
  /** arm/reset 采用的停顿时长（等于观察值 `delayMs`，便于调用方算剩余时间）。 */
  delayMs: number;
  /** 触发本次 armed 的草稿/会话（skip/cancel 时为上一次的或 null）。 */
  draft: string;
  sessionId: string | null;
};

export type InlineArmOutcome = {
  state: InlineArmState;
  decision: InlineArmDecision;
};

/** 初始状态（插件启动、解绑、effect 卸载时都回到这里）。 */
export const initialInlineArmState = (): InlineArmState => ({
  ticket: null,
  firedSessionId: null,
  firedDraft: null,
  suppressed: 0,
});

/** 请求身份：一次 complete 只对「某会话的某份草稿」提出。 */
const firedMatch = (state: InlineArmState, obs: InlineArmObservation): boolean =>
  state.firedDraft !== null
  && state.firedSessionId === obs.sessionId
  && state.firedDraft === obs.draft;

/** 观察键是否变化；返回变化维度（未变返回 null）。 */
const changedDimension = (ticket: InlineArmTicket, obs: InlineArmObservation): InlineArmReason | null => {
  if (ticket.draft !== obs.draft) return 'draft-changed';
  if (ticket.sessionId !== obs.sessionId) return 'session-changed';
  if (ticket.ghostKind !== obs.ghostKind) return 'kind-changed';
  if (ticket.delayMs !== obs.delayMs || ticket.minChars !== obs.minChars) return 'config-changed';
  return null;
};

const decide = (
  state: InlineArmState,
  obs: InlineArmObservation,
  action: InlineArmAction,
  reason: InlineArmReason,
  ticket: InlineArmTicket | null,
  suppressed: number,
  /** 一次新的 armed 意味着请求对象已经换了一份草稿/会话，去重键随之作废。 */
  clearFired = false,
): InlineArmOutcome => ({
  state: {
    ticket,
    firedSessionId: clearFired ? null : state.firedSessionId,
    firedDraft: clearFired ? null : state.firedDraft,
    suppressed,
  },
  decision: {
    action,
    reason,
    dueAt: ticket === null ? null : ticket.dueAt,
    delayMs: ticket === null ? obs.delayMs : ticket.delayMs,
    draft: ticket === null ? obs.draft : ticket.draft,
    sessionId: ticket === null ? obs.sessionId : ticket.sessionId,
  },
});

/**
 * 唯一的决策入口：给定状态与本次观察，返回新状态与要执行的动作为一对。
 *
 * 判定顺序（前面的命中即返回，不再往下看）：
 *  1. 不合格条件（开关、会话、组词、阈值）→ `cancel`；
 *  2. 该草稿已有续写在显示（ghostKind==='inline'）→ `cancel`；
 *  3. 已有计时器且观察键未变 → `skip`（到期时刻保持不变，这是 #21 的核心）；
 *  4. 该 (会话, 草稿) 已发过请求 → `skip`（掐断写→推→render→再写的自循环）；
 *  5. 其余 → `arm`（无计时器）或 `reset`（有计时器但键变了）。
 */
export const decideInlineArm = (state: InlineArmState, obs: InlineArmObservation): InlineArmOutcome => {
  if (!obs.enabled) return decide(state, obs, 'cancel', 'disabled', null, state.suppressed);
  if (obs.sessionId === null) return decide(state, obs, 'cancel', 'no-session', null, state.suppressed);
  if (obs.composing) return decide(state, obs, 'cancel', 'composing', null, state.suppressed);
  if (obs.draft.trim().length < obs.minChars) {
    return decide(state, obs, 'cancel', 'below-min-chars', null, state.suppressed);
  }
  if (obs.ghostKind === 'inline') {
    return decide(state, obs, 'cancel', 'completion-visible', null, state.suppressed);
  }

  const { ticket } = state;
  if (ticket !== null && changedDimension(ticket, obs) === null) {
    // 同一次观察被重复送达（事件风暴、订阅多次通知）：**绝不**碰现有计时器。
    return decide(state, obs, 'skip', 'same-observation', ticket, state.suppressed + 1);
  }
  if (ticket === null && firedMatch(state, obs)) {
    return decide(state, obs, 'skip', 'already-fired', null, state.suppressed + 1);
  }

  const next: InlineArmTicket = {
    sessionId: obs.sessionId,
    draft: obs.draft,
    ghostKind: obs.ghostKind,
    minChars: obs.minChars,
    delayMs: obs.delayMs,
    dueAt: obs.now + obs.delayMs,
  };
  return decide(
    state,
    obs,
    ticket === null ? 'arm' : 'reset',
    ticket === null ? 'first-arm' : changedDimension(ticket, obs) ?? 'draft-changed',
    next,
    state.suppressed,
    // 一旦为新的 (会话, 草稿) 起表，上一份草稿的去重键即刻作废：否则「输入 A → 停顿
    // 发问 → 继续输入 B → 删回 A」这条再普通不过的路径会被永久锁死在 A 上。
    true,
  );
};

/**
 * 计时器回调开头必须调用：把 ticket 消费掉（本次 armed 已结束）。
 *
 * `sent` 非 null 表示真的发出了 `complete`（记下去重键，同草稿不再重复问）；
 * null 表示到期时草稿已不合格而什么都没发——**不**记去重键，用户继续输入或
 * 下一次 render 仍能为这份草稿重新计时。
 */
export const settleInlineTimer = (
  state: InlineArmState,
  sent: { sessionId: string; draft: string } | null,
): InlineArmState => ({
  ticket: null,
  firedSessionId: sent === null ? state.firedSessionId : sent.sessionId,
  firedDraft: sent === null ? state.firedDraft : sent.draft,
  suppressed: state.suppressed,
});

/**
 * 结构化等值比较（JSON 形状的值：原始值 / 数组 / 普通对象 / null / undefined）。
 *
 * 用于 `applySettings`：内核的事件只带 `(ns, revision)`，revision 变了**不代表**
 * 本插件关心的值变了（host 每次 `_push` 都推进 revision，而载荷里大部分字段常年
 * 不变）。值未变时若照样替换 `settings` 对象，就会 bump `settingsEpoch` → 缓存全废
 * → `render()` → 又一次 armed，把 #21 的风暴从「事件侧」放大到「渲染侧」。
 *
 * 先比引用（同一引用直接命中，host 省略 `history` 时保留的是旧数组引用），再递归。
 */
export const configValuesEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!configValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k)) return false;
    if (!configValuesEqual(ra[k], rb[k])) return false;
  }
  return true;
};

// ── overlay 绘制快路径判据（Gitea #38 第 2 条）────────────────────────────
//
// ## 要治的成本
//
// `GhostOverlay.show()` 原本每次都 `textContent = ''` 整棵重建后缀 span，然后跑**两轮**
// 强制同步布局：`align()`（`getComputedStyle` + `offsetTop/offsetLeft/clientWidth` +
// 一次 `getBoundingClientRect` + 约 35 个排版属性逐项 setProperty）与 `verify()`（再一次
// rect + computed style + `querySelector`）。而一帧流式增量只是尾巴变长，几何上什么都没动。
//
// ## 快路径的两个前提
//
//  1. **文本是延续**：同形态、同锚定文本、新后缀以旧后缀开头（`startsWith`）。
//  2. **锚点没脏**：自上次全量对齐以来没有滚动 / 尺寸变化 / 重新挂载。锚点坐标只由
//     「草稿文本 + 编辑器排版」决定；两者都没动，行尾就不可能移动 → 这类帧**一次测量都不做**。
//     锚点脏了才降级为「只量一次行尾」，位移不超过阈值就不重排。
//
// ⚠️ 这里的「锚定文本相同」是**几何**判据（尾巴从哪起画），与形态判据无关；形态不翻转
// 那条走 `completion-align.ts` 的 `decideInlineForm`，靠归属前缀关系，不靠草稿逐字相同。
//
// ## 不许破坏的既有硬约束（index.ts 的对齐注释里写过，勿回退）
//
//  - 必须先 `display:block` 再测量（rect 对 `display:none` 恒返回全 0）；
//  - 必须在显示之前就 `data-shown="1"`（placeholder 让位规则挂在它上面，晚标就同帧双绘）。
//  快路径**完全不写**这两个属性：进入它的前提就是「两者已一致且自检刚通过」，所以
//  「`verify()` 失败即不绘制」的语义与那条 `body:has(...)` 让位规则都不需要重算。

/** overlay 一次绘制所需的最小形状信息（不含任何正文之外语义；文本只用于比较）。 */
export type OverlayShape = {
  readonly kind: 'llm' | 'history' | 'inline';
  /** 锚定文本：非 llm 形态 = 当时的草稿（幽灵挂在它末尾）；llm 形态 = ''（从内容原点起）。 */
  readonly anchorText: string;
  /** 本次要显示的后缀文本（llm 形态 = 整段建议文本）。 */
  readonly suffixText: string;
};

/** 快路径的三种动作。 */
export type OverlayPaintAction =
  /** 全量重建 + 对齐 + 自检（现状路径）。 */
  | 'rebuild'
  /** 只改后缀文本，零测量（锚点未脏）。 */
  | 'grow-only'
  /** 只改后缀文本 + 量一次行尾；位移超阈值再由调用方落回 `rebuild`。 */
  | 'grow-remeasure';

/** 行尾坐标允许漂移多少像素仍算「没动」（亚像素舍入用）。 */
export const ANCHOR_REDRAW_TOLERANCE_PX = 1;

/** 草稿行尾的一个点（`draftEndRect()` 的 right/top）。 */
export type AnchorPoint = { readonly right: number; readonly top: number };

/** 是否「同一次生成的文本延续」。 */
export function isSameGenerationGrowth(prev: OverlayShape | null, next: OverlayShape): boolean {
  if (prev === null) return false;
  if (prev.kind !== next.kind) return false;
  if (prev.anchorText !== next.anchorText) return false;
  if (next.suffixText.length < prev.suffixText.length) return false;
  return next.suffixText.startsWith(prev.suffixText);
}

/** 该形态的行尾锚点是否可测（llm 从内容原点起，没有可测的行尾锚点）。 */
export const anchorMeasurable = (kind: OverlayShape['kind']): boolean => kind !== 'llm';

/**
 * 裁决这一帧该怎么画。
 *
 * @param prev 上一次显示的形状（null = 屏幕上还没有幽灵）
 * @param next 本帧要显示的形状
 * @param painted overlay 当前是否真的在绘制（自检通过、`display:block`、`data-shown="1"`）
 * @param anchorDirty 自上次全量对齐后是否发生过滚动 / 尺寸变化 / 重新挂载
 */
export function decideOverlayPaint(input: {
  prev: OverlayShape | null;
  next: OverlayShape;
  painted: boolean;
  anchorDirty: boolean;
}): OverlayPaintAction {
  const { prev, next, painted, anchorDirty } = input;
  // 不在绘制中（首帧 / 自检被拦 / 刚 hide）：必须走全量，才能保证 display 与 data-shown
  // 的先后顺序、并让 verify() 重新裁决。
  if (!painted) return 'rebuild';
  if (!isSameGenerationGrowth(prev, next)) return 'rebuild';
  if (!anchorDirty) return 'grow-only';
  // 锚点脏了：可测的形态先轻量量一次行尾，比较后再决定要不要全量重排；
  // llm 形态没有行尾可量（它的位置只取决于编辑器原点），直接重排。
  return anchorMeasurable(next.kind) ? 'grow-remeasure' : 'rebuild';
}

/**
 * 行尾是否移动超过阈值。任一端未知（null / 非有限）一律判「动了」——保守重测。
 */
export function anchorMovedBeyond(
  prev: AnchorPoint | null,
  current: AnchorPoint | null,
  tolerancePx: number = ANCHOR_REDRAW_TOLERANCE_PX,
): boolean {
  if (prev === null || current === null) return true;
  if (!Number.isFinite(prev.right) || !Number.isFinite(prev.top)) return true;
  if (!Number.isFinite(current.right) || !Number.isFinite(current.top)) return true;
  return Math.abs(current.right - prev.right) > tolerancePx || Math.abs(current.top - prev.top) > tolerancePx;
}

/**
 * `[60, 300, 900]` 错峰补渲染在「幽灵正在增长」时应否跳过。
 *
 * 那三个定时器的唯一职责是覆盖「rebind 时 composer 尚未挂载」的竞态；幽灵既然已经
 * 画在屏幕上（`painted`）且正处在一枚增长的帧流里（`growing`），补渲染就只会把同一
 * 段文本再重画一遍。形态一旦跳出增长（新载荷、自检被拦、hide），`growing` 即失效，
 * 未消化的补渲染照旧执行。
 */
export function shouldSkipDeferredRepaint(input: { painted: boolean; growing: boolean }): boolean {
  return input.painted === true && input.growing === true;
}

// ── 留痕出口：按理由变化才打（Gitea #39 客户端部分）──────────────────────────
//
// ## 要补的两类缺口
//
//  1. **「判据在跑但留痕被摘空」的分支**：#21/#25 的清理把几条 `console.log` 删掉了，
//     判定本身却留着，于是这些分支在观测上完全同形——
//      - `scheduleInlineTrigger` 的 `disabled` / `no-session`（只剩两个空 if 块）；
//      - Tab 采纳被草稿 CAS 放弃（空块）；
//      - `→` 逐词采纳被 CAS 放弃（空行）；
//      - 本期新增：陈旧帧被整条丢弃、provisional 帧拒绝采纳、同代形态回落被扣住。
//  2. **`renderHits` 没有出口**：#21 待查项 1 的按来源计数探针只累加、从不打印（注释里
//     写的「只在 armed 那一行汇总打印」指的正是那条已被摘空的日志），现场拿不到「到底
//     哪个来源在刷 render」的答案。
//
// ## 出口只有一种打法
//
// #21 的教训就是每帧刷屏（一次 40 字符输入 1127 行）。所以两把闸都只认「变化」：
//  - `stepReasonGate`：同一理由连续到达只打第一行，理由归 null（判据通过）静默并重新开门；
//  - `stepTally`：归因理由 = 当前占大头的来源，只在理由变化**且**距上次打印已累计
//    `TALLY_MIN_INTERVAL_RENDERS` 次 render 时打一行。纯计数节流、不用计时器，
//    因此离线可测，也不会因标签页被冻结而漂移。
//
// 隐私口径与既有留痕一致：**只打字符数与原因，不打正文**。

/** 留痕前缀：宿主侧 `sandbox.greps` 与本插件其它 ops-trace 行同用这一条。 */
export const OPS_TRACE_PREFIX = '[dsh-suggest-ghost][ops-trace]';

/** 理由闸的一步结果。 */
export type ReasonGateStep = {
  /** 写回调用方，作为下一次比较的基线。 */
  readonly last: string | null;
  /** 本行该不该打。 */
  readonly print: boolean;
};

/**
 * 理由闸：`reason` 与上次不同才打印；`null`（判据通过 / 状态清空）静默并重新开门。
 *
 * 与 index.ts 里既有的 `lastCompletionSkip` / `lastSkipReason` 手写做法同构，
 * 收成一个函数是为了让「摘空」的分支补回去时不会各写各的。
 */
export function stepReasonGate(last: string | null, reason: string | null): ReasonGateStep {
  // 判据通过（reason 归 null）静默：只有关卡重新扣住东西才值得留痕，
  // 「解除了」本身不是事件——否则一次输入里 null↔理由来回翻就会翻倍刷屏。
  if (reason === null) return { last: null, print: false };
  if (reason === last) return { last, print: false };
  return { last: reason, print: true };
}

/**
 * **槽级发射冷却**（2026-10-22，#39 理由闸的补闸）。
 *
 * `stepReasonGate` 对「来回交替」不设防：`push-cell` 的 `hot-cell-only ↔ suggestion-cell-changed`
 * 每次交替都算一次理由变化、各打一行——宿主两格高频交替写时控制台又成组刷（用户 2026-10-22
 * 现场：刷新后仍见成串 `push-cell:` 黄线）。理由闸管「同理由连打」，冷却闸管「换理由连打」，
 * 两闸叠用：同一 slot 每 {@link TRACE_SLOT_COOLDOWN_MS} 至多一行，**新理由不丢只迟到**
 * （冷却内的最新一次记成 pending，冷却结束后下一次调用把它打出来）。
 *
 * 不用定时器驱动（#21 的教训：留痕自己不许成为新的 render/计时器源）——pending 由后续
 * 自然调用放行；没有后续调用就没有人再看控制台，迟到项静默过期无害。
 */
export const TRACE_SLOT_COOLDOWN_MS = 5_000;

/** 一个 slot 的冷却状态（index.ts 里按 slot 各存一份）。 */
export interface SlotEmitGate {
  /** 上一次**真的打出去**的时刻（null = 从未打过 ⇒ 首次必过，不依赖时钟量级巧合）。 */
  readonly lastEmitAt: number | null;
  /** 冷却期内攒下的最新理由（null = 没有待打）。 */
  readonly pendingReason: string | null;
  /** 攒下那条的字段串（与 reason 成对，last-wins 覆盖）。 */
  readonly pendingFields: string;
}

export const initialSlotEmitGate = (): SlotEmitGate => ({
  lastEmitAt: null,
  pendingReason: null,
  pendingFields: '',
});

/** 一步冷却判定的输出：`emit` 非 null = 这一拍该打这一行。 */
export interface SlotEmitStep {
  readonly gate: SlotEmitGate;
  readonly emit: { readonly reason: string; readonly fields: string } | null;
}

/**
 * 纯函数版发射判定：`now` 由调用方给（假时钟可测）。
 * @param gate - 该 slot 当前状态。
 * @param now - 本次到达时刻。
 * @param wantsPrint - 理由闸（`stepReasonGate`）的结论。
 * @param reason - 本次理由（wantsPrint=false 时不会被采用，仅保持签名一致）。
 * @param fields - 本次字段串。
 */
export function stepSlotEmit(
  gate: SlotEmitGate,
  now: number,
  wantsPrint: boolean,
  reason: string,
  fields: string,
): SlotEmitStep {
  const cooling = gate.lastEmitAt !== null && now - gate.lastEmitAt < TRACE_SLOT_COOLDOWN_MS;
  if (cooling) {
    // 冷却中：想打的记成 pending（最新一份赢），什么都不输出。
    return wantsPrint
      ? { gate: { ...gate, pendingReason: reason, pendingFields: fields }, emit: null }
      : { gate, emit: null };
  }
  // 冷却已过：先放行攒下的（它代表冷却期里最后一次「新理由」，不能丢）。
  if (gate.pendingReason !== null) {
    const emit = { reason: gate.pendingReason, fields: gate.pendingFields };
    return { gate: { lastEmitAt: now, pendingReason: null, pendingFields: '' }, emit };
  }
  if (wantsPrint) {
    return { gate: { lastEmitAt: now, pendingReason: null, pendingFields: '' }, emit: { reason, fields } };
  }
  return { gate, emit: null };
}

/** 一次 render 的来源计数（与 index.ts 的 `renderHits` 同形状）。 */
export type RenderHitCounts = {
  readonly session: number;
  readonly input: number;
  readonly face: number;
  readonly other: number;
};

/** 归因来源；`none` = 还没有任何 render。 */
export type RenderSource = keyof RenderHitCounts;

/** 平局时的固定优先序（保证可测、可比较，不因对象键顺序漂移）。 */
const SOURCE_ORDER: readonly RenderSource[] = ['session', 'input', 'face', 'other'];

/** 占大头的来源 = 本行的「理由」。全 0 时为 null。 */
export function dominantRenderSource(counts: RenderHitCounts): RenderSource | null {
  let best: RenderSource | null = null;
  let bestValue = 0;
  for (const source of SOURCE_ORDER) {
    const value = counts[source] ?? 0;
    if (value > bestValue) {
      best = source;
      bestValue = value;
    }
  }
  return best;
}

/** tally 的打印状态：理由 + 上次打印时的总 render 数。 */
export type TallyState = {
  readonly reason: string | null;
  readonly atTotal: number;
};

export const initialTallyState = (): TallyState => ({ reason: null, atTotal: 0 });

/**
 * 两次打印之间至少要累计多少次 render。
 *
 * 取 50 的依据：#21 现场一次输入 1127 次 render，按这个下限最坏也就 22 行，
 * 而真发生了「来源切换」（例如从 input 主导变成 face 主导）时一定能在 50 次内看到。
 */
export const TALLY_MIN_INTERVAL_RENDERS = 50;

/** tally 闸的一步结果。 */
export type TallyStep = {
  readonly state: TallyState;
  readonly print: boolean;
  /** print 为 false 时是空串（调用方不必再拼字符串）。 */
  readonly line: string;
};

const totalOf = (counts: RenderHitCounts): number =>
  (counts.session ?? 0) + (counts.input ?? 0) + (counts.face ?? 0) + (counts.other ?? 0);

/**
 * 按「归因理由变化 + 最小间隔」决定是否打一行 render 来源统计。
 *
 * 纯计数节流，不用计时器：离线可测，也不会因为浏览器标签页被冻结而漂移。
 */
export function stepTally(state: TallyState, counts: RenderHitCounts): TallyStep {
  const reason = dominantRenderSource(counts);
  const total = totalOf(counts);
  if (reason === null) return { state, print: false, line: '' };
  if (reason === state.reason) return { state, print: false, line: '' };
  if (total - state.atTotal < TALLY_MIN_INTERVAL_RENDERS) return { state, print: false, line: '' };
  return {
    state: { reason, atTotal: total },
    print: true,
    line: renderTallyLine(counts, reason),
  };
}

/** 一行 tally 留痕：只有计数，没有任何正文。 */
export function renderTallyLine(counts: RenderHitCounts, reason: RenderSource | null): string {
  return (
    `render tally: dominant=${reason ?? 'none'}`
    + ` session=${counts.session ?? 0} input=${counts.input ?? 0}`
    + ` face=${counts.face ?? 0} other=${counts.other ?? 0} total=${totalOf(counts)}`
  );
}
