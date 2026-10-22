/**
 * 冷启动语义（纯函数，无 host 服务依赖）：把「重启后怎么恢复」从插件装配里
 * 拆出来单独表达，便于单测。
 *
 * 这一层的存在理由：重启后「没有数据」并不是真的没数据——建议在 settings.yaml、
 * 历史在会话日志，两者都是持久的。所谓冷启动问题，本质是**判据选错了**：
 * 旧实现用「时间」（重启即作废、事件到达才播种）当判据，于是产生两个空窗；
 * 这里统一改成**语义**判据：
 *  - 历史环是会话日志的缓存 → 任何时候都能从日志现算，没有「播种时机」；
 *  - 建议是否可用，取决于它对应的回合是否仍是该会话最后一个已完成回合。
 * @module dsh-suggest-ghost/coldstart
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SuggestGhostSuggested } from './domain.js';

/**
 * 读取会话完整事件日志（跨代兼容）。
 * DSH 0.1.2 起 `Session.events` getter 被移除：公开面改为 `snapshotEvents()`
 * （无参调用返回全量冻结数组，语义与旧 `events` 一致）；≤0.1.1 内核只有
 * `events` getter、没有 `snapshotEvents`。两边的属性在对方那一代都不存在，
 * 类型上互不可见，这里按运行时能力探测读取。两者都缺失（不该出现的代际
 * 组合）时回退空数组——日志读取路径绝不能再因此崩掉。
 *
 * 放在本模块（而非 generate.ts）：本模块是纯语义层，不得依赖任何运行时模块，
 * 否则单测无法用 --experimental-strip-types 直接导入它。
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const reader = session as unknown as {
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[];
    events?: readonly SessionEvent[];
  };
  if (typeof reader.snapshotEvents === 'function') return reader.snapshotEvents();
  return reader.events ?? [];
}

/** `_push` 携带的历史文本条数上限（控制 settings 写盘体积；client 端再按
 * historyMaxEntries 做打分窗口截尾，取两者较小窗口）。 */
export const HISTORY_PUSH_CAP = 300;
/** 单条历史文本上限（与 client extractHistory 的 HISTORY_TEXT_MAX_CHARS 一致）。 */
export const HISTORY_TEXT_MAX_CHARS = 2000;
/** 环容量 = 推送窗口的两倍（硬上限防泄漏）。 */
export const RING_CAPACITY = HISTORY_PUSH_CAP * 2;
/** 每会话建议表的容量（同时活跃的会话数上限；超出逐出最久未更新者）。
 * 只存内存、不落盘（建议本就是可重建的 LLM 输出），故取小值即可。 */
export const SUGGESTION_CACHE_CAP = 16;

/**
 * 从一条会话事件提取可补全的用户输入文本（null = 跳过）。筛选语义与 client
 * `extractHistory` 对齐：只收 `source.kind === 'user'` 的 user/message 文本块，
 * 跳过空白、系统提醒包装块与超长文本。
 */
export function userTextOfEvent(event: SessionEvent): string | null {
  if (event.type !== 'user/message') return null;
  const data = event.data as { content?: unknown; source?: { kind?: unknown } };
  const srcKind = data.source?.kind;
  if (typeof srcKind === 'string' && srcKind !== 'user') return null;
  let text = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === 'text' && typeof record.text === 'string') text += record.text;
    }
  }
  text = text.trim();
  if (text === '' || text.startsWith('<system-reminder>') || text.length > HISTORY_TEXT_MAX_CHARS) return null;
  return text;
}

/**
 * 从会话日志抽取历史环种子（时间序的可补全用户文本，相邻重复只计一次）。
 * 日志持久化，插件 apply 时必然已在内存——这是「按需物化」的数据基础：
 * 环只是缓存，命中与否都不影响正确性。
 */
export function seedRingFromLog(session: Session): string[] {
  const seed: string[] = [];
  for (const past of sessionEvents(session)) {
    const text = userTextOfEvent(past);
    if (text === null) continue;
    if (seed[seed.length - 1] === text) continue; // 相邻重复只计一次
    seed.push(text);
  }
  return seed;
}

/**
 * 会话日志里最后一个已完成回合号（0 = 无）。建议语义校验的判据：只有当建议
 * 的 turn 等于它时，那条建议才仍然是「针对当前状态的下一条预测」。
 */
export function lastCompletedTurnInLog(session: Session): number {
  let last = 0;
  for (const event of sessionEvents(session)) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      last = Math.max(last, event.data.turn);
    }
  }
  return last;
}

/**
 * 启动回读**不恢复**盘上残留建议的原因（留痕要写清是哪一种，不许笼统成「没恢复」）。
 *
 *  - `no-persisted-payload`：盘上根本没有残留载荷（正常态）。
 *  - `corrupt-payload`：盘上有载荷但结构不合法（上个进程写坏了 / 被人手改过）。
 *  - `empty-text`：载荷**结构完全合法，只是正文为空**（`text === ''`）。以前这一档借用
 *    `corrupt-payload`，于是读到它的人会去怀疑写盘路径 —— 而那笔写根本没坏，盘上也没有坏
 *    字节（实测被误导过一次：手写一份 `text:""` 的终帧进 profile，留痕打的就是
 *    `reason=corrupt-payload`，见 docs/real-session-harness.md §10 与 #73）。
 *    **分档而不是改名**：`corrupt-payload` 留给真损坏，这个词已被沙箱日志与文档检索过。
 *  - `session-mismatch`：载荷里的建议**无法归属**到会话（缺 `suggestionSessionId`），
 *    或它属于**另一个**会话（用户切了会话）——此时不恢复、不 track、**不动盘**。
 *  - `session-unavailable`：会话尚未进店（宿主的持久化懒恢复未发生）⇒ 无从判新旧，
 *    绝不猜、绝不据此清盘，留给该会话第一次 pull 时再判。
 *  - `stale-turn`：建议对应的回合已不是该会话最后一个已完成回合 ⇒ 陈旧，作废。
 *  - `superseded`：该会话**已有更新的建议**（更新一轮产出/回读后接上的），残留不得
 *    盖掉它 ⇒ 不接回（这不是载荷的毛病，是状态更新了）。
 */
export type PersistedPushSkipReason =
  | 'no-persisted-payload'
  | 'corrupt-payload'
  | 'empty-text'
  | 'session-mismatch'
  | 'session-unavailable'
  | 'stale-turn'
  | 'superseded';

/**
 * `parsePersistedPush` 的返回值。
 *
 * `emptyText` 是「结构全都合法、**只有正文为空**」这件事的**数据形态**：由结构校验那一处
 * 报出来（不在上层重判 ⇒ 不会出现第二套口径），`decidePersistedPush` 只负责把它映射成
 * reason。`_push` 与 `_residual` 共用这条链 ⇒ 同一档（要求 2）。
 */
export type ParsedPersistedPush = {
  readonly suggestion: SuggestGhostSuggested | null;
  readonly sessionId: string | null;
  /** 非 null = 载荷结构合法、正文为空（带定位用的 turn/baseSeq）；其余情况为 null。 */
  readonly emptyText: { readonly turn: number; readonly baseSeq: number } | null;
};

/** 「跳过」时的定位信息：正文为空这一档没有建议对象，但留痕仍要说清是哪一条。 */
export type PersistedPushLocation = {
  readonly turn: number;
  readonly baseSeq: number;
  readonly chars: number;
};

/** 一次回读判定的结论。 */
export type PersistedPushVerdict =
  | {
      readonly action: 'restore';
      readonly reason: null;
      readonly suggestion: SuggestGhostSuggested;
      readonly sessionId: string;
    }
  | {
      readonly action: 'skip';
      readonly reason: PersistedPushSkipReason;
      /** 解析得出来的建议（载荷损坏/无法归属时为 null）——留痕要带 turn/baseSeq/字符数。 */
      readonly suggestion: SuggestGhostSuggested | null;
      readonly sessionId: string | null;
      /**
       * 没有建议对象**但仍有定位信息**时（`empty-text`）用：正文为空 ⇒ `suggestion` 是
       * null，旧写法留痕里 turn/baseSeq/chars 全打成 `n/a`，等于把「是哪一条」这个信息
       * 丢了。这一档恰恰是最需要定位的（盘上确实躺着一条有会话、有回合、没内容的载荷）。
       */
      readonly location?: PersistedPushLocation | null;
    };

/**
 * 判定盘上残留的建议能不能恢复（**纯函数**，可离线驱动）。
 *
 * 这条语义是 `e853d1e` 加的、`c3b6a80`（0.1.7 volatile 适配）删掉后一直没接回来的：
 * 「宿主重启后把盘上残留的建议恢复出来」。删掉的理由是读面变了（`scope.get()._push`
 * 那个 API 没了），但**语义本身没作废**——`_push` 至今仍是建议（不可重建的 LLM
 * 输出）唯一的持久载体，`src/index.ts` 的启动对账那段自述至今还写着这件事。
 *
 * 判定分两步，顺序不能换：
 *  1. **结构**（{@link parsePersistedPush}）：盘上内容不可信，逐字段校验。
 *  2. **语义**：会话在不在店（不在 ⇒ 无从判新旧，绝不猜）、建议回合是否仍是该会话
 *     最后一个已完成回合（不是 ⇒ 陈旧作废）。
 *
 * @param raw - `_push` 字段的 JSON 字符串（'null' / undefined = 无残留）。
 * @param ctx - 两个**语义**判据的注入点（纯函数不能自己碰 ctx）：
 *  - `sessionExists`：该会话是否已在宿主里（懒恢复可能还没发生）。
 *  - `isCurrent`：该建议此刻是否仍对那个会话有效（回合语义）。
 */
export function decidePersistedPush(
  raw: string | undefined,
  ctx: {
    readonly sessionExists: (sessionId: string) => boolean;
    readonly isCurrent: (suggestion: SuggestGhostSuggested, sessionId: string) => boolean;
  },
): PersistedPushVerdict {
  const present = typeof raw === 'string' && raw !== '' && raw !== 'null';
  if (!present) {
    return { action: 'skip', reason: 'no-persisted-payload', suggestion: null, sessionId: null };
  }
  // 先自己判「盘上这一坨是不是连 JSON 都不是」：`parsePersistedPush` 对「JSON 坏了」与
  // 「JSON 合法但没有会话 id」都给出 `suggestion:null`（两者 `emptyText` 也都是 null），
  // 而这两种的处置不同（前者是载荷损坏，后者是无法归属），留痕必须分清。
  let record: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null) record = value as Record<string, unknown>;
  } catch { record = null; }
  if (record === null) {
    return { action: 'skip', reason: 'corrupt-payload', suggestion: null, sessionId: null };
  }
  const parsed = parsePersistedPush(raw);
  if (parsed.suggestion === null) {
    // JSON 合法但解析不出建议，三档必须分清（处置相同：不恢复、不动盘）：
    //  1. 会话 id 缺失 ⇒ 无法归属（`session-mismatch`）。**优先级保持原样**：这一条先看，
    //     否则「归属不上的空正文」会从旧档漂到新档。
    //  2. 结构全都合法、只有正文为空 ⇒ `empty-text`（#73）。以前它落在第 3 档，读的人
    //     会以为盘上字节坏了、去怀疑写盘路径；这里把它分出来，并带上定位信息。
    //  3. 其余（字段类型不对等）⇒ `corrupt-payload`，词不变。
    if (parsed.sessionId === null) {
      return { action: 'skip', reason: 'session-mismatch', suggestion: null, sessionId: null };
    }
    if (parsed.emptyText !== null) {
      return {
        action: 'skip',
        reason: 'empty-text',
        suggestion: null,
        sessionId: parsed.sessionId,
        location: { turn: parsed.emptyText.turn, baseSeq: parsed.emptyText.baseSeq, chars: 0 },
      };
    }
    return { action: 'skip', reason: 'corrupt-payload', suggestion: null, sessionId: parsed.sessionId };
  }
  const suggestion = parsed.suggestion;
  const sessionId = parsed.sessionId;
  if (sessionId === null) {
    return { action: 'skip', reason: 'session-mismatch', suggestion, sessionId: null };
  }
  if (!ctx.sessionExists(sessionId)) {
    return { action: 'skip', reason: 'session-unavailable', suggestion, sessionId };
  }
  if (!ctx.isCurrent(suggestion, sessionId)) {
    return { action: 'skip', reason: 'stale-turn', suggestion, sessionId };
  }
  return { action: 'restore', reason: null, suggestion, sessionId };
}

/**
 * 从 settings 盘上残留的 `_push` 回读建议状态（重启复用）。字段逐个做结构校验，
 * 任一可疑即按「无建议」处理——盘上内容是上一次进程写的，可能被手改或来自旧版本。
 *
 * 这里只做**结构**校验；「是否仍有效」是语义问题，需要会话日志，由调用方用
 * {@link lastCompletedTurnInLog} 判定（会话尚未进店时不得据此清盘，见 index.ts）。
 * @param raw - `_push` 字段的 JSON 字符串（'null' = 无）。
 * @returns 结构合法的建议与其会话 id；无建议时 suggestion 为 null。
 */
export function parsePersistedPush(raw: string | undefined): ParsedPersistedPush {
  const noSuggestion = (sessionId: string | null) => ({ suggestion: null, sessionId, emptyText: null }) as const;
  if (typeof raw !== 'string' || raw === '' || raw === 'null') return noSuggestion(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return noSuggestion(null);
  }
  if (typeof parsed !== 'object' || parsed === null) return noSuggestion(null);
  const record = parsed as { suggestion?: unknown; suggestionSessionId?: unknown };
  const sessionId = typeof record.suggestionSessionId === 'string' && record.suggestionSessionId !== ''
    ? record.suggestionSessionId
    : null;
  const rawSuggestion = record.suggestion;
  if (sessionId === null || typeof rawSuggestion !== 'object' || rawSuggestion === null) {
    return noSuggestion(sessionId);
  }
  const s = rawSuggestion as Record<string, unknown>;
  const nonNegativeInt = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (!nonNegativeInt(s.turn) || !nonNegativeInt(s.baseSeq)) return noSuggestion(sessionId);
  // 「正文为空」与「正文类型不对」是**两件事**（#73）：前者结构完全合法，只是没有内容；
  // 后者才是盘上那一份不可信。两者都构不成建议（处置一致：不恢复、不动盘），但**归因必须
  // 分开**，且这个区分只能在这里做——上层再判一次就等于第二套口径（两套校验必然会漂）。
  // 所以这里把「只有正文为空」当**数据**报出去（`emptyText`），由 `decidePersistedPush`
  // 映射成 reason，`_push` 与 `_residual` 两格共用同一条判定链 ⇒ 同一档。
  if (typeof s.text !== 'string') return noSuggestion(sessionId);
  if (s.text === '') {
    return { suggestion: null, sessionId, emptyText: { turn: s.turn, baseSeq: s.baseSeq } };
  }
  if (typeof s.truncated !== 'boolean') return noSuggestion(sessionId);
  if (typeof s.acceptKey !== 'string' || s.acceptKey === '') return noSuggestion(sessionId);
  // 帧语义（#39）：这里的重建是**逐字段白名单**，不写下面两行就等于把 frame/final
  // 在重启的那一刻悄悄丢掉——客户端随后按「旧载荷」兜底（frame=0），表现为判据
  // 时灵时不灵。缺省取值定的是 **frame=1 / final=true**：本期宿主每个回合只出
  // 一帧，所以盘上那一份必然就是它的第 1 帧、也是终帧；`0` 留给「载荷里根本没有
  // 帧字段」那种旧版本情况，由客户端自己兜底，宿主这边不主动伪造 0。
  // 类型上做**结构校验后再回落**（与上面几个字段同一个偏保守的味道：宁可按默认
  // 重建，也不因为盘上一个手改坏的键就整条丢弃仍然有效的建议）。
  const frame = typeof s.frame === 'number' && Number.isInteger(s.frame) && s.frame >= 1
    ? s.frame
    : 1;
  const final = typeof s.final === 'boolean' ? s.final : true;
  return {
    suggestion: {
      version: 1,
      turn: s.turn,
      baseSeq: s.baseSeq,
      text: s.text,
      truncated: s.truncated,
      acceptKey: s.acceptKey,
      frame,
      final,
    },
    sessionId,
    emptyText: null,
  };
}

/**
 * 就地追加一条历史文本（幂等：相邻重复不重复入环；超出容量从头截断）。
 * 会前先由调用方物化环——环绝不能凭空从单条文本起建，否则丢掉此前的轮次。
 * @returns 是否实际追加（false = 相邻重复，无变化）。
 */
export function appendToRing(ring: string[], text: string): boolean {
  if (ring[ring.length - 1] === text) return false;
  ring.push(text);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  return true;
}

/**
 * 建议是否仍对该会话有效：会话存在，且建议回合仍是其最后一个已完成回合。
 * 判定所需的一切都能从日志现算，因此不依赖任何「重启时机」或事件先后。
 */
export function suggestionIsCurrent(
  suggestion: SuggestGhostSuggested | null,
  session: Session | undefined,
): boolean {
  if (suggestion === null || session === undefined) return false;
  return suggestion.turn === lastCompletedTurnInLog(session);
}

/** 「最新建议」追踪状态：建议本身 + 它所属的会话。 */
export interface TrackedSuggestion {
  readonly suggestion: SuggestGhostSuggested | null;
  readonly sessionId: string | null;
}

/**
 * 计算建议产出/作废后的新追踪状态。
 *
 * 规则只有两条，但都是踩过的坑：
 *  - 产出新建议（非 null）→ 直接取代（last-wins，跨会话也取代：它才是「最新」）；
 *  - 作废（null）→ **仅当**被作废的正是该会话自己的建议时才清空——另一会话的
 *    生成失败不该抹掉本会话仍在有效期的那条，否则切回来就没有建议了。
 * @param current - 当前追踪状态。
 * @param sessionId - 本次产出/作废所属的会话。
 * @param suggestion - 新建议；null = 作废该会话的建议。
 */
export function nextTrackedSuggestion(
  current: TrackedSuggestion,
  sessionId: string,
  suggestion: SuggestGhostSuggested | null,
): TrackedSuggestion {
  if (suggestion !== null) return { suggestion, sessionId };
  if (current.sessionId === sessionId) return { suggestion: null, sessionId: null };
  return current;
}

/**
 * 组装推给 client 的建议字段：本会话的建议按语义校验结果取用；不属于本会话、
 * 但仍被追踪的那条原样带上（client 端按 sessionId 守卫隐藏，切回时立即可用）。
 * 这正是「pull 一次别的会话不能把仍在有效期的建议弄丢」的落点。
 * @param tracked - 追踪状态。
 * @param sessionId - 目标会话；null = 无特定会话。
 * @param currentForSession - 该会话经语义校验后的有效建议（无则 null）。
 */
export function suggestionFieldsFor(
  tracked: TrackedSuggestion,
  sessionId: string | null,
  currentForSession: SuggestGhostSuggested | null,
): { readonly suggestion: SuggestGhostSuggested | null; readonly sessionId: string | null } {
  if (currentForSession !== null) return { suggestion: currentForSession, sessionId };
  const elsewhere = tracked.sessionId !== null && tracked.sessionId !== sessionId
    ? tracked.suggestion
    : null;
  return elsewhere === null
    ? { suggestion: null, sessionId: null }
    : { suggestion: elsewhere, sessionId: tracked.sessionId };
}
