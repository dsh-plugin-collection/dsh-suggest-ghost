/**
 * 采纳写入的草稿 CAS 守卫（Gitea #4）——纯逻辑，零 DOM、零宿主依赖。
 *
 * ## 要闭合的窗口
 *
 * 「采纳建议」（Tab 整条 / `→` 逐词）是一条**读-改-写**：读草稿 → 拼出
 * `accepted` → `setDraft(accepted)`。读与写之间只要有一次用户键击落到草稿
 * （原生 input 会先于 React 渲染到达，宿主 store 也在编辑器提交后才发布），
 * 写入就会把这段新输入**整段覆盖**——用户打的字无声消失。
 *
 * ## 判据（两条采纳路径共用这一份）
 *
 * 1. **首选版本号比对**：宿主 `InputState.draftRev` 是单调编辑器修订号
 *    （`@deepseek-ai/dsh-client-ui-conversation` 0.2.0-rc.2 已对外发布该字段；
 *    其自增条件是草稿投影 `clipboardText`/`detectText`/引用 chip 列表变化，
 *    **纯光标移动不推进**，所以可以安全地拿来 CAS）。计算 `accepted` 所用
 *    快照的 `base.rev` 与写入前重读的 `live.rev` 不等即放弃。
 * 2. **文本判据始终参与**：`base.draft !== live.draft` 一律放弃——老宿主或
 *    rev 语义漂移时，这是唯一可靠的「用户输入是否还在」的证据。
 * 3. **退化方案**：face 上没有 `draftRev`（宿主版本较旧 / 非 conversation
 *    实现）时，rev 记为 `null` 并退化为纯**内容等值**比对。残余风险必须
 *    知晓：内容等值只证明「store 投影未变」，不证明「编辑器实例未变」——
 *    若宿主把一次编辑器提交批处理在 store 发布之前，同一 tick 内读到的
 *    `draft` 与 `draftRev` 会一起是旧值，这个窗口就仍然敞着。真正闭合它需要
 *    宿主把原子插入 verbs（`captureInsertion()` + `insertText(text, span)`，
 *    捕获坐标与修订号同源于编辑器而非 store）交到插件手上。
 *
 * ## 为什么不用宿主的 `insertText(text, span)`
 *
 * 采纳写入是**整段草稿替换**（历史补全要回填斜杠命令前缀段、LLM 建议直接
 * 覆盖整段草稿），而 `insertText` 是 span 拼接语义：span 坐标取自编辑器
 * 文档（含引用 chip 的投影差异），与 `draft` 字符串的坐标系并不一致。用
 * 「整段 span」模拟替换会引入新的坐标假设，比版本号 CAS 更脆。故这里走
 * 「校验后 `setDraft`」，并在放弃时什么都不写。
 *
 * ## 放弃时的动作
 *
 * 本模块只给判定与「是否真的写了」。隐藏幽灵由调用方负责（复用既有的
 * `overlay.hide()` + `shown = null`），保持模块可单测。
 *
 * ## 第二组判据：终态帧与帧号（Gitea #38，#41 契约）
 *
 * 采纳的**前置**条件不止「草稿没被改过」，还有「这一帧是终帧」：宿主对 `_push`
 * 的 suggestion 载荷新增 `frame`（number，`>=1`，单次生成内单调）与 `final`
 * （boolean，终帧 true）。收在同一个模块的理由很直接——两条判据共同定义「这次采纳
 * 可不可以发生」，分放两处就会各改各的。判据本体与逐条说明见本文件末尾。
 *
 * @module dsh-suggest-ghost/client/accept-guard
 */

import { stripCommandPrefix } from './history.ts';

/** 一次草稿快照读取中与采纳有关的两个量。 */
export interface DraftSnapshot {
  /** 草稿文本（宿主 `InputState.draft`，引用 chip 展开后的剪贴板投影）。 */
  readonly draft: string;
  /** 宿主编辑器修订号（`InputState.draftRev`）；face 未提供时为 `null`。 */
  readonly rev: number | null;
}

/** 放弃采纳的原因（诊断用）。 */
export type DraftAbandonReason =
  | 'draft-changed'
  | 'rev-changed';

/** 一次 CAS 提交的结果。 */
export interface DraftCasOutcome {
  /** 是否执行了 `write()`。 */
  readonly committed: boolean;
  /** 未提交时：放弃原因（版本号漂移 / 内容漂移）。 */
  readonly reason: DraftAbandonReason | null;
}

/**
 * 从宿主输入机快照里读采纳所需的两量。
 *
 * 只接受**同一个对象**上的 `draft` 与 `draftRev`——分两次读会把「文本」与
 * 「版本」取自不同帧，CAS 就失去意义。face 形态不完整时（缺字段 / 非对象）
 * 保守地返回空草稿 + `rev: null`，让判据退化为内容等值比对而不是抛错。
 */
export function readDraftSnapshot(raw: unknown): DraftSnapshot {
  if (raw === null || typeof raw !== 'object') return { draft: '', rev: null };
  const state = raw as { draft?: unknown; draftRev?: unknown };
  const draftValue = state.draft;
  const revValue = state.draftRev;
  return {
    draft: typeof draftValue === 'string' ? draftValue : '',
    rev: typeof revValue === 'number' && Number.isFinite(revValue) ? revValue : null,
  };
}

/**
 * 计算所用快照与写入前重读的快照是否仍指同一份草稿。
 *
 * 顺序：先看文本（必要条件，也是无 rev 时的唯一判据），再看版本号
 * （两边都有 rev 时额外要求一致，用于捕捉「文本巧合相同但编辑器已变」）。
 */
export function isDraftPristine(base: DraftSnapshot, live: DraftSnapshot): boolean {
  if (base.draft !== live.draft) return false;
  if (base.rev !== null && live.rev !== null) return base.rev === live.rev;
  return true;
}

/** 放弃原因（`isDraftPristine` 已给出布尔，这里只为日志/单测取因）。 */
export function draftDriftReason(base: DraftSnapshot, live: DraftSnapshot): DraftAbandonReason | null {
  if (base.draft !== live.draft) return 'draft-changed';
  if (base.rev !== null && live.rev !== null && base.rev !== live.rev) return 'rev-changed';
  return null;
}

/**
 * 草稿未被外部改动时才执行写入；否则什么都不做并回报放弃。
 *
 * 调用方在**计算** `accepted` 时所用快照与**紧邻写入之前**重读的快照之间
 * 用它，`write` 里放 `setDraft`。返回值供调用方决定是否隐藏幽灵。
 */
export function commitDraftIfPristine(
  base: DraftSnapshot,
  live: DraftSnapshot,
  write: () => void,
): DraftCasOutcome {
  const reason = draftDriftReason(base, live);
  if (reason !== null) return { committed: false, reason };
  write();
  return { committed: true, reason: null };
}

/**
 * 可采纳的幽灵内容（与 index.ts 的 `GhostContent` 结构兼容：判别联合，
 * 成员按需携带 `text` / `full`）。本模块只读这几个字段，故声明得比宿主
 * 类型更松，避免与 index.ts 互相依赖。
 */
export type AcceptableContent =
  | { kind: 'llm'; text: string; acceptKey?: string }
  | { kind: 'inline'; prefix: string; suffix: string; full: string }
  | { kind: 'history'; prefix: string; suffix: string; full: string };

/** 采纳整段时的目标全文（逐词采纳的完成判定也用它）。 */
export function acceptTarget(content: AcceptableContent): string {
  return content.kind === 'llm' ? content.text : content.full;
}

/**
 * 整条采纳（Tab）的目标文本。
 *
 * - `llm`：直接覆盖草稿（幽灵本就出现在空草稿上，无前缀可接）。
 * - `inline`：停顿续写，`full` 已含命令前缀，整段替换。
 * - `history`：草稿若是斜杠命令整行（如 `/later +3m 我`），候选 `full` 是
 *   历史里的「内容」部分（命令 `recordInput:false`，不带命令名+参数），
 *   必须把命令前缀段回填，否则用户的命令意图被破坏、只剩内容部分。
 *
 * @param content - 幽灵内容（按**显示时**的草稿算出）。
 * @param draftAtCompute - 计算该幽灵内容所用的草稿（CAS 的 base.draft）。
 */
export function buildFullAccept(content: AcceptableContent, draftAtCompute: string): string {
  if (content.kind === 'llm') return content.text;
  if (content.kind === 'inline') return content.full;
  const contentDraft = stripCommandPrefix(draftAtCompute);
  // 命令整行：contentDraft 是「内容部分」，不含命令名+参数。还原时把
  // draft 头部到 contentDraft 之前的那段（命令名、时间参数、其间的空白）
  // 一并保留，再接 content.full。
  const head = contentDraft === ''
    ? draftAtCompute
    : draftAtCompute.slice(0, draftAtCompute.length - contentDraft.length);
  const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
  return `${head}${tailJoiner}${content.full}`;
}

/**
 * 逐词采纳的前缀匹配基准：命令整行要用剥掉命令前缀后的内容部分去匹配
 * 候选（候选里没有命令名+参数），其余形态直接用草稿本身。
 */
export function wordMatchBase(content: AcceptableContent, draftAtCompute: string): string {
  return content.kind === 'history' ? stripCommandPrefix(draftAtCompute) : draftAtCompute;
}

/**
 * 逐词采纳（`→`）前进一个片段后的目标草稿。
 *
 * 命令整行同样回填 head（含时间参数）段，与整条采纳保持一致。
 */
export function buildWordAccept(
  content: AcceptableContent,
  draftAtCompute: string,
  matchBase: string,
  chunk: string,
): string {
  if (content.kind !== 'history') return draftAtCompute + chunk;
  // draft 头部到 matchBase 之前是命令前缀段（含时间参数），随逐词采纳保留。
  const head = matchBase === ''
    ? draftAtCompute
    : draftAtCompute.slice(0, draftAtCompute.length - matchBase.length);
  const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
  return `${head}${tailJoiner}${matchBase}${chunk}`;
}

/**
 * 逐词采纳后建议是否已被吃干净（该收掉幽灵了）。
 *
 * 历史补全下 `accepted` 带着命令前缀段，比候选 `full` 长，故用后缀判定。
 */
export function wordAcceptSettled(content: AcceptableContent, accepted: string): boolean {
  const full = acceptTarget(content);
  return accepted === full || (content.kind === 'history' && accepted.endsWith(full));
}

// ── 终态帧与帧号（Gitea #38）─────────────────────────────────────────────
//
// 上面是「草稿 CAS」这一组判据；下面是「帧终态」这一组。两组在采纳链上是串联关系：
// 先过帧闸（`gateAccept`），再过 CAS（`commitDraftIfPristine`）。
//
// ## 契约（#41 已落定）
//
// `_push` 的 **suggestion** 载荷新增两个字段：`frame`（number，`>=1`，单次生成内单调）
// 与 `final`（boolean，终帧 true）。`completion`（停顿续写）本期**没有帧号**、只有一帧，
// 但宿主同样会带 `final`，所以两条采纳链共用下面这组判据。
//
// ⚠️ **本期前提**：宿主对一次生成只投递**一个终帧**。把帧序判据按 `(会话, turn)` 分桶、
// 并要求帧号单调，是给**将来的多帧**预留的接口形状；今天现场任何「帧号回退」只能有两种
// 解释——旧载荷（没带帧字段，归一化成 0），或契约错配（宿主出了不该出的帧）。
//
// ## 三条不变量
//
//  1. **缺省兜底**：不带 `frame`/`final` 归一化成 `{ frame: 0, final: true }`。`0` 的语义
//     是「旧载荷，**不参与帧序比较**」：既不拦后来的 `frame=1`（这条最容易写反，冒烟
//     逐条钉住），也不被任何后来的帧判成陈旧，且**不登记台账**。
//  2. **单调丢弃**：按 `(会话, turn)` 分桶，帧号**严格小于**该桶已见值 → 整条载荷丢弃。
//     相等**不**丢：会话切回时的对账 `pull` 会把同一份建议原样再推一次，丢掉它就没有
//     历史环、也没有建议了。台账独立于文档 revision（那条是 `rev === lastRevision` 的
//     文档级早退，载荷自带的 `rev` 客户端从不读）。
//  3. **采纳只认终帧**：Tab 整条与 `→` 逐词都必须在 `final === false` 的帧上直接放弃
//     （一个字符都不写、也不吞按键）。显示与否不归这里管——provisional 帧即便显示出来
//     也只是中间态，**采纳才是不可逆动作**。

/** 归一化后的帧提示。`frame === 0` 表示旧载荷、不参与帧序比较。 */
export type FrameHint = {
  readonly frame: number;
  readonly final: boolean;
};

/** 旧载荷（不带 frame/final）的兜底值。 */
export const LEGACY_FRAME_HINT: FrameHint = { frame: 0, final: true };

/** 归一化帧号：非有限数 / `<1` 一律落到 0（= 不参与比较）。 */
function normalizeFrameNo(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 0;
  return Math.floor(value);
}

/**
 * 归一化终帧标志：**只有显式 `false` 才算非终帧**。
 *
 * 缺字段、null、字符串等一律视为终帧（true），与 #41 契约里「缺省兜底按 final=true，
 * 旧载荷行为不变」一致；判据写成 `final === false 才拒`，比「只有显式 true 才放行」
 * 更保守于体验、也更保守于兼容性。
 */
function normalizeFinal(value: unknown): boolean {
  return value !== false;
}

/**
 * 从载荷里读帧提示，按参数顺序取**第一个真正带帧字段的对象**。
 *
 * @param primary - 首选载体（`pushed.suggestion` / `settings.completion`）。
 * @param secondary - 兜底载体（`_push` 顶层）：宿主若把帧字段放在信封上也能读到。
 */
export function readFrameHint(primary: unknown, secondary?: unknown): FrameHint {
  for (const source of [primary, secondary]) {
    if (source === null || typeof source !== 'object') continue;
    const record = source as Record<string, unknown>;
    if (record.frame === undefined && record.final === undefined) continue;
    return { frame: normalizeFrameNo(record.frame), final: normalizeFinal(record.final) };
  }
  return LEGACY_FRAME_HINT;
}

/** 分桶键：一次生成属于「哪个会话的哪个回合」。 */
export function frameBucketKey(sessionId: string | null | undefined, turn: number | null | undefined): string {
  const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'no-session';
  const turnKey = typeof turn === 'number' && Number.isFinite(turn) ? String(Math.floor(turn)) : 'no-turn';
  return `${session}|${turnKey}`;
}

/** 帧台账：桶键 → 已见过的最大帧号（只登记 `>=1` 的帧）。 */
export type FrameLedger = {
  readonly seen: Readonly<Record<string, number>>;
  /** 累计被单调丢弃的载荷条数（留痕用，不含正文）。 */
  readonly dropped: number;
};

export const emptyFrameLedger = (): FrameLedger => ({ seen: {}, dropped: 0 });

/** 一次帧观测的结论。 */
export type FrameStep = {
  /** false = 这条载荷整条丢弃（陈旧帧）。 */
  readonly accept: boolean;
  /** 观测后的新台账（accept 时也返回新值：登记/计数）。 */
  readonly ledger: FrameLedger;
  /**
   * 归因（留痕与冒烟断言用）：
   *  - `legacy` 旧载荷，不参与比较；
   *  - `first` 该桶首帧；
   *  - `newer` 更新的帧；
   *  - `same` 同帧重发（对账 replay，必须放行）；
   *  - `older` 陈旧帧，整条丢弃。
   */
  readonly outcome: 'legacy' | 'first' | 'newer' | 'same' | 'older';
  /** 该桶此前已见的最大帧号；无记录时 null。 */
  readonly seen: number | null;
};

/**
 * 观测一帧并给出「这条载荷要不要整条丢掉」。
 *
 * @param ledger 当前台账
 * @param bucket {@link frameBucketKey} 的分桶键
 * @param frame 归一化后的帧号（`0` = 旧载荷）
 */
export function observeFrame(ledger: FrameLedger, bucket: string, frame: number): FrameStep {
  if (frame < 1) {
    // 旧载荷：不参与帧序比较，也不登记（否则会污染台账）。
    return { accept: true, ledger, outcome: 'legacy', seen: ledger.seen[bucket] ?? null };
  }
  const seenValue = ledger.seen[bucket];
  if (seenValue === undefined) {
    return { accept: true, ledger: record(ledger, bucket, frame), outcome: 'first', seen: null };
  }
  if (frame < seenValue) {
    return {
      accept: false,
      ledger: { seen: ledger.seen, dropped: ledger.dropped + 1 },
      outcome: 'older',
      seen: seenValue,
    };
  }
  if (frame === seenValue) {
    return { accept: true, ledger, outcome: 'same', seen: seenValue };
  }
  return { accept: true, ledger: record(ledger, bucket, frame), outcome: 'newer', seen: seenValue };
}

function record(ledger: FrameLedger, bucket: string, frame: number): FrameLedger {
  return { seen: { ...ledger.seen, [bucket]: frame }, dropped: ledger.dropped };
}

/** 采纳闸的结论。 */
export type AcceptGate =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: 'provisional-frame' };

/**
 * 这一帧的内容能不能采纳（Tab / `→` 都过这道闸）。
 *
 * 判据只有一条：`final === false` 拒绝。缺省（旧载荷 / 宿主没带字段）放行，
 * 于是 #38 之前的行为逐字不变。
 */
export function gateAccept(hint: FrameHint | null | undefined): AcceptGate {
  if (hint === null || hint === undefined) return { allow: true };
  if (hint.final === false) return { allow: false, reason: 'provisional-frame' };
  return { allow: true };
}

/** 留痕用的帧字段展开（只打数字，不打正文）。 */
export function frameHintFields(hint: FrameHint): string {
  return `frame=${hint.frame} final=${String(hint.final)}`;
}

/** `_push` 载荷里与本判据有关的部分（其余字段由调用方自己解析，本函数不碰）。 */
export type PushedFrameCarrier = {
  suggestion?: unknown;
  completion?: unknown;
  suggestionSessionId?: unknown;
  /** 兜底载体：宿主若把帧字段打在信封顶层。 */
  frame?: unknown;
  final?: unknown;
};

/** {@link resolvePayloadFrames} 的结论。 */
export type PayloadFrames = {
  /** false = 陈旧帧，整条载荷作废（调用方据此 return，不改状态、不刷缓存、不 render）。 */
  readonly accept: boolean;
  /** 观测后的新台账（`accept` 为 false 时也返回新值：`dropped` 已计数）。 */
  readonly ledger: FrameLedger;
  /** 归因，供留痕与冒烟断言；`absent` = 这条载荷根本没有建议。 */
  readonly outcome: 'absent' | 'legacy' | 'first' | 'newer' | 'same' | 'older';
  /** 分桶键；无建议时为 null。 */
  readonly bucket: string | null;
  /** 该桶此前已见的最大帧号（留痕用），无记录时 null。 */
  readonly seen: number | null;
  readonly suggestionFrame: FrameHint;
  /**
   * 续写的帧提示。省略/作废语义与 `completion` 本体保持同款：**省略=保留现值**
   * （`prevCompletionFrame`），**显式 null=归回缺省**。本期宿主不给续写出帧号，
   * 所以这里只可能从载荷身上读到 `final`。
   */
  readonly completionFrame: FrameHint;
};

/**
 * 一条 `_push` 载荷 → 帧判据结论（#38 解析段的**全部**判据都收在这里）。
 *
 * 抽成一个函数的理由：`applySettings` 里剩下的只有接线（读文档、比深、换状态、render），
 * 而「这一帧要不要整条丢掉、两个对象各自的终态是什么」是纯判定，必须能在 node 里直接
 * 驱动（见 `scripts/frame-monotonic-smoke.mjs` 与 `scripts/legacy-payload-smoke.mjs`）——
 * #34 的现状是客户端连类型检查都没有，判据留在 DOM 文件里就等于没有测试。
 *
 * @param input.ledger 当前台账
 * @param input.pushed 解析出的 `_push` 载荷（null/undefined = 这条 revision 没带载荷）
 * @param input.prevCompletionFrame 现值，供「省略=保留」使用
 */
export function resolvePayloadFrames(input: {
  ledger: FrameLedger;
  pushed: PushedFrameCarrier | null | undefined;
  prevCompletionFrame: FrameHint;
}): PayloadFrames {
  const { pushed, prevCompletionFrame } = input;
  const completionPayload = pushed === null || pushed === undefined ? undefined : pushed.completion;
  const completionFrame = completionPayload === undefined
    ? prevCompletionFrame
    : completionPayload === null
      ? LEGACY_FRAME_HINT
      : readFrameHint(completionPayload);
  const suggestionPayload = pushed === null || pushed === undefined ? null : pushed.suggestion ?? null;
  if (suggestionPayload === null) {
    return {
      accept: true,
      ledger: input.ledger,
      outcome: 'absent',
      bucket: null,
      seen: null,
      suggestionFrame: LEGACY_FRAME_HINT,
      completionFrame,
    };
  }
  const suggestionFrame = readFrameHint(suggestionPayload, pushed);
  const bucket = frameBucketKey(
    typeof pushed?.suggestionSessionId === 'string' ? pushed.suggestionSessionId : null,
    typeof (suggestionPayload as { turn?: unknown }).turn === 'number'
      ? (suggestionPayload as { turn: number }).turn
      : null,
  );
  const step = observeFrame(input.ledger, bucket, suggestionFrame.frame);
  return {
    accept: step.accept,
    ledger: step.ledger,
    outcome: step.outcome,
    bucket,
    seen: step.seen,
    suggestionFrame,
    completionFrame,
  };
}
