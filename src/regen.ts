/**
 * 重出（regen）的判据：配额、冷却、被拒清单、留痕构造。
 *
 * **纯函数、零 import、零 DOM、零 I/O**（Gitea #127）——与 `src/completion-gate.ts`
 * 同族：判据是纯函数、留痕走表，于是它能被冒烟直接驱动，而不必先造一个宿主。
 *
 * ## 为什么上限与冷却是**常量**，不是配置项
 *
 * 工单原本列了三个 volatile 项（`regenEnabled` / `regenMaxPerTurn` / `regenCooldownMs`）。
 * 后两个**刻意没做成可配项**，理由与 `COMPLETION_DEADLINE_MS` 同源
 * （`src/completion-gate.ts` 顶部那段）：它们防的是「连按把调用刷出去」，那是**安全边界**，
 * 不是用户偏好。一旦可配，注入面就从「冒烟里传几十毫秒」变成「用户可以把上限配成无限」，
 * 而这条路径每一次都花真的模型调用（同路由实测中位 4.9s / 最慢 17s）。
 * 钉成常量还有第二个好处：本仓那道机械闸（`scripts/completion-pipeline-smoke.mjs`
 * 断言宿主源码不出现 `cfg.(deadline|budget)`）不必放宽。
 * ⇒ 配置面只新增 `regenEnabled` 与 `regenKey` 两键，七处登记按这两个走。
 *
 * ## 默认值是拍的，这里如实标注
 *
 * `2` 与 `1500ms` **没有实测支撑**：本仓没有「同一回合连按两下的真实间隔分布」这份数据。
 * 取的是保守值——上限把「一个回合的调用数」钉在 1 + 2 次；冷却取明显小于同路由一次生成
 * 的中位耗时（4.9s）⇒ 它拦的是**上一条落地之后立刻再按**，不拦「认真等完一次再按下一张」。
 * 这条口径写进 PR 的遗留风险，不写成「这样应该够」。
 *
 * ## 留痕分级（#97 的教训：分级不能把失败告警静音）
 *
 *  - `regen-refused` / `regen-duplicate` 是**常态**（配额就是会耗尽、模型就是会复读）
 *    ⇒ `traceOps`（debug，默认静音）。
 *  - `regen-no-basis`（对齐不上、走了盲重出）与写面失败是**故障** ⇒ `traceFault`（默认放行）。
 *  - 任何一支都**不许静默 return**：那正是本工单要消灭的「按了没反应」。
 *
 * ## 隐私口径
 *
 * 判据与留痕只碰**字符数、次数、时长与摘要**，不碰正文。下面三个 `*Trace` 刻意做成
 * **独立函数**，为的是「留痕里没有正文」这条可断言：冒烟喂进一条真实正文，断言输出里
 * 找不到它。被拒的建议正文唯一去的地方是模型请求本身（{@link buildAvoidBlock}）——
 * 那是本次调用的输入，不落盘、不进日志。
 *
 * @module dsh-suggest-ghost/regen
 */

/**
 * 每个 `(会话, 回合)` 至多几次重出 ⇒ 一个回合的调用上限是「1 条正常建议 + 本数」。
 * 默认值未经量度，取保守值（见模块头）。
 */
export const REGEN_MAX_PER_TURN = 2;
/**
 * 两次重出之间的最小间隔（毫秒）。默认值未经量度，取保守值（见模块头）。
 *
 * **它的作用域是会话，不是回合**——配额按回合、冷却按会话，这个不对称是刻意的：
 * 同一个回合里连按十下正是「刷调用」的形状，若冷却也只落在同一个 turn 内，
 * 换回合就连按等于没有冷却。判据顺序见 {@link decideRegen}。
 */
export const REGEN_COOLDOWN_MS = 1_500;
/** 负向约束最多带几条被拒正文（再多是提示词膨胀，而复读率并不线性下降）。 */
export const REGEN_AVOID_CAP = 3;
/**
 * 被拒清单里每条正文的字符上限。
 *
 * 正文进的是**模型请求**，不是盘 ⇒ 这里要的不是隐私上限（那条由「留痕不打正文」
 * 与「载荷不带正文」两条管住），是**提示词预算**上限。与建议字符上限同量级。
 */
export const REGEN_AVOID_TEXT_MAX_CHARS = 240;
/**
 * 重出表的容量。**与建议表同一条有界纪律**（`SUGGESTION_CACHE_CAP = 16`）：
 * 表只按会话建键、换回合在记录内部归零 ⇒ 条数上界是「同时活跃的会话数」，
 * 不随回合数增长。拼 `sessionId + turn` 复合键的表会随回合单调增长，而
 * 「随 suggestionBySession 同生命周期过期」在那种形状下**不会发生**（建议表按会话
 * 挤出，旧回合的复合键没人删）⇒ 那样写出来的「有界」是假的。
 */
export const REGEN_TABLE_CAP = 16;

/** 一个会话的重出记账单元。 */
export interface RegenRecord {
  /** 这份记录归属的**已完成回合**（0 = 无已完成回合）。 */
  readonly turn: number;
  /** 该回合已发起的重出次数（**含在途那一次**：发起即计数，见 {@link beginRegen}）。 */
  readonly used: number;
  /** 上一次发起的时刻（`Date.now()`）；冷却判据用它。**按会话**，跨回合不清零。 */
  readonly lastAt: number;
  /**
   * 本回合「已被用户拒掉」的建议正文（最新在尾，≤ `REGEN_AVOID_CAP` 条）。
   *
   * **登记时机只有一个**：用户按下 regen **并且**载荷与宿主内存里那条对齐时，把当时
   * 展示的那条记进来（`noteRejected`）。也就是说这一列装的是**显式拒绝**，不是「所有
   * 产出过的建议」。
   *
   * ⚠️ 用户直接打字把幽灵顶掉**不算拒绝**：那是无标注信号，拿它当负样本会把「模型
   * 恰好猜中」这一类永久封杀（工单 §4）。同理，被拒的建议从不进热表与历史环。
   */
  readonly rejected: readonly string[];
}

/** 拒绝的原因（`ok` 不在这列——那是放行，不是理由）。 */
export type RegenRefuseReason = 'disabled' | 'in-flight' | 'quota' | 'cooldown';

/** {@link decideRegen} 的结论。 */
export interface RegenDecision {
  /** 本次要不要发起生成。 */
  readonly allow: boolean;
  /** 放行是 `'ok'`；拒绝给出可留痕的原因。 */
  readonly reason: RegenRefuseReason | 'ok';
  /**
   * 还要多久才可能放行（毫秒）；`Infinity` = 等多久都没用（关着 / 配额已尽）。
   * **只为留痕服务**，不参与任何判据：它把「按了没反应」拆成「等 X 毫秒再来」。
   */
  readonly waitMs: number;
}

/** 某会话本回合还没重出过时的初值。 */
export const emptyRegenRecord = (turn = 0): RegenRecord => ({
  turn,
  used: 0,
  lastAt: 0,
  rejected: [],
});

/**
 * 该不该为这一次按键再花一次模型调用。
 *
 * **四条判据的顺序是判据的一部分**，不是实现细节：
 *  1. `disabled`（唯一的可配项，关掉等于这个功能不存在）；
 *  2. `in-flight`（在途互斥：上一条没落地之前不叠第二条。叠了会在同一个
 *     `(会话, turn)` 桶里各拿一个连续帧号、结果互相覆盖，而两边都「有效」——
 *     宿主只会看见后落地那条，先那条的 token 白花）；
 *  3. `quota`（本回合上限）；
 *  4. `cooldown`（与上一次发起的间隔，**按会话**）。
 *
 * 配额排在冷却之前：配额耗尽时 `waitMs` 必须是 `Infinity`，而冷却未到是一个具体数字。
 * 反过来排会让「按到第 N+1 下」在日志里显示成「再等 1.5s 就行」——那是假希望。
 *
 * 换回合 ⇒ `used` 归零（`quota` 重新给满），但 `lastAt` **不归零**（冷却按会话，见模块头）。
 *
 * @param input.maxPerTurn / input.cooldownMs —— **只给冒烟注入用**，宿主传默认常量。
 *   判据收显式参数而不是读模块常量，正是「它能被离线驱动、能把冷却配成 30ms 来验」的前提。
 */
export function decideRegen(input: {
  readonly enabled: boolean;
  readonly record: RegenRecord | undefined;
  /** 本次重出归属的回合（`lastCompletedTurnInLog` 现算）。 */
  readonly turn: number;
  readonly now: number;
  readonly inflight: boolean;
  readonly maxPerTurn?: number;
  readonly cooldownMs?: number;
}): RegenDecision {
  const max = input.maxPerTurn ?? REGEN_MAX_PER_TURN;
  const cooldown = input.cooldownMs ?? REGEN_COOLDOWN_MS;
  const record = input.record;
  if (!input.enabled) return { allow: false, reason: 'disabled', waitMs: Number.POSITIVE_INFINITY };
  // 在途判据**不看 turn**：一次在途生成意味着这个会话此刻真有一笔模型调用在跑，
  // 换回合不解除互斥（换回合那次 `turn/end` 会先 abort 它，见 `src/index.ts`）。
  if (input.inflight) {
    return { allow: false, reason: 'in-flight', waitMs: 0 };
  }
  const sameTurn = record !== undefined && record.turn === input.turn;
  if (sameTurn && record !== undefined) {
    if (record.used >= max) {
      return { allow: false, reason: 'quota', waitMs: Number.POSITIVE_INFINITY };
    }
  }
  // 冷却：跨回合也判（`lastAt` 不因换回合而清零，所以这里**不**要求同回合）。
  if (record !== undefined && record.lastAt > 0) {
    const elapsed = input.now - record.lastAt;
    if (elapsed < cooldown) {
      return { allow: false, reason: 'cooldown', waitMs: cooldown - elapsed };
    }
  }
  return { allow: true, reason: 'ok', waitMs: 0 };
}

/**
 * 记一次**已发起**的重出：计数 +1、冷却起点推进、在途置真。
 *
 * **发起即计数，不等落地**：失败的重出照样花了模型调用（`generateSuggestion` 内部还有
 * `maxAttempts = 3` 的退避重试预算），不计数就等于「失败那次不吃上限」⇒ 一条坏掉的
 * 路由能被连按刷成无限次调用。唯一**退款**的情形是判同命中，见 {@link refundRegen}。
 *
 * 换回合时 `used` 归零、`rejected` 清空（素材只在本回合内有意义），`lastAt` 保持
 * （冷却按会话）。本函数**不记在途**：在途是 `SessionState.regen` 的事，见上面那条注释。
 */
export function beginRegen(prev: RegenRecord | undefined, turn: number, now: number): RegenRecord {
  if (prev === undefined || prev.turn !== turn) {
    return { turn, used: 1, lastAt: now, rejected: [] };
  }
  return { ...prev, used: prev.used + 1, lastAt: now };
}

/**
 * 退款一次重出的**额度**（判同命中）。
 *
 * 「退额度、不退冷却起点」是这条判据的正文：工单写明判同不扣配额（模型复读时用户
 * 按两下就耗尽配额，剩下的一路都堵死），而 {@link REGEN_COOLDOWN_MS} 防的是连按刷调用
 * ——退款若把 `lastAt` 也回滚，就等于「只要模型复读，用户就能无冷却地连按」，
 * 那正好把安全边界拆在了最常见的那条路径上。
 */
export function refundRegen(record: RegenRecord): RegenRecord {
  return { ...record, used: Math.max(0, record.used - 1) };
}

/**
 * 把一条建议登记进「本回合已产出/已被拒」清单（负向约束的素材）。
 *
 * 三条规矩：按判同口径**去重**（同一句以两种大小写出现两次只会稀释这一段的分量）、
 * **只留最后 `REGEN_AVOID_CAP` 条**（最新被拒的那条最可能是模型即将复读的那条）、
 * 单条**截到 `REGEN_AVOID_TEXT_MAX_CHARS`**（提示词预算）。
 *
 * @param same - 判同口径。由调用方注入 `isSameText`（`src/text-match.ts`），本模块
 *   不 import 它：这一层要保持**零 import**，冒烟才能直载并把冷却/上限配成任意值。
 */
export function noteRejected(
  record: RegenRecord,
  text: string,
  same: (a: string, b: string) => boolean,
): RegenRecord {
  const cut = text.length > REGEN_AVOID_TEXT_MAX_CHARS
    ? text.slice(0, REGEN_AVOID_TEXT_MAX_CHARS)
    : text;
  const kept = record.rejected.filter((item) => !same(item, cut));
  return { ...record, rejected: [...kept, cut].slice(-REGEN_AVOID_CAP) };
}

/**
 * 被拒清单 ⇒ 追加到 system prompt **尾部**的负向约束块。
 *
 * **`systemPrompt()` 本体一字不改**：那句措辞是全仓回归基线绑着的（README 的 42 次
 * 实测口径建立在它之上），改本体要付的回归代价远大于在调用处拼接。
 * 空清单返回**空串** ⇒ 调用方据此不拼接，整次调用的 system 与今天逐字相同
 * （这一条由 `scripts/regen-smoke.mjs` 钉住）。
 */
export function buildAvoidBlock(
  rejected: readonly string[],
  same: (a: string, b: string) => boolean,
): string {
  const picked: string[] = [];
  for (const text of rejected.slice(-REGEN_AVOID_CAP).reverse()) {
    if (picked.every((kept) => !same(kept, text))) picked.push(text);
  }
  if (picked.length === 0) return '';
  const list = picked.reverse().map((text) => `- "${text}"`).join('\n');
  return [
    '',
    'REGEN CONSTRAINT:',
    'The user already rejected the suggestion(s) below. You MUST NOT repeat any of these —',
    'not verbatim, not with different capitalization or punctuation, not as a paraphrase',
    'of the same idea. Predict a genuinely different next prompt, or reply with nothing at all.',
    list,
  ].join('\n');
}

/** `wait` 字段：`Infinity` 写成 `never`（等多久都没用，别伪装成一个数字）。 */
const waitField = (waitMs: number): string =>
  (Number.isFinite(waitMs) ? `${Math.max(0, Math.round(waitMs))}ms` : 'never');

/** 同一回合的已用次数（别的回合的 `used` 不许报进来）。 */
const usedField = (record: RegenRecord | undefined, turn: number): string =>
  `${record !== undefined && record.turn === turn ? record.used : 0}/${REGEN_MAX_PER_TURN}`;

/**
 * 拒绝行的留痕文本（**只带计数与时长，不带任何正文**）。
 *
 * `reason` 有四种，用户在界面上看见的完全同形（幽灵不变、按键不吞）——
 * 这一行就是两者唯一的区别，所以它必须存在。
 */
export function regenRefusedTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly reason: RegenRefuseReason;
  readonly waitMs: number;
  readonly record: RegenRecord | undefined;
}): string {
  return `regen-refused session=${input.sessionId} turn=${input.turn} reason=${input.reason}`
    + ` used=${usedField(input.record, input.turn)} wait=${waitField(input.waitMs)}`;
}

/**
 * 判同命中行的留痕文本。
 *
 * `basis` 这一位是判据不是装饰：盲重出（`blind`）复读的概率显著更高，
 * 两条混在一行就看不出该先修哪一头。`refunded=1` 明写这次不扣配额——
 * 否则「按了三下没换」与「配额耗尽」在日志里读起来是同一件事。
 */
export function regenDuplicateTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly chars: number;
  readonly compared: number;
  readonly basis: 'aligned' | 'blind';
}): string {
  return `regen-duplicate session=${input.sessionId} turn=${input.turn}`
    + ` chars=${input.chars} compared=${input.compared} basis=${input.basis} refunded=1`;
}

/**
 * 对齐不上（走盲重出）行的留痕文本。**故障级**（默认放行，#97）。
 *
 * 三种分档而不是笼统一句「没对齐」：`no-suggestion`（宿主内存里这条就没有）、
 * `hash-mismatch`（有，但不是用户此刻看见的那条）、`stale-turn`（有、也对得上，
 * 但它对应的回合已经不是该会话最后一个已完成回合）。三者都走盲重出，
 * 但「该修哪一头」是三件不同的事。
 */
export function regenNoBasisTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly reason: 'no-suggestion' | 'hash-mismatch' | 'stale-turn';
  readonly shownChars: number;
}): string {
  return `regen-no-basis session=${input.sessionId} turn=${input.turn}`
    + ` reason=${input.reason} shownChars=${input.shownChars} basis=blind`;
}

/** 放行行的留痕文本（成功/失败那两行沿用建议侧既有的 `suggestion generated/dropped/failed`）。 */
export function regenStartedTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly frame: number;
  readonly basis: 'aligned' | 'blind';
  readonly avoid: number;
  /** 客户端自报它看到的 `_push.rev`（归因用：与宿主这一侧的 rev 并排打，差多少一目了然）。 */
  readonly basisRev: number;
  readonly hostRev: number;
}): string {
  return `regen started session=${input.sessionId} turn=${input.turn} frame=${input.frame}`
    + ` basis=${input.basis} avoid=${input.avoid} clientRev=${input.basisRev} hostRev=${input.hostRev}`;
}

/** 在途被新回合中止的留痕（与 `pending.controller.abort()` 同语义，那条一直无声）。 */
export function regenAbortedTrace(input: {
  readonly sessionId: string;
  readonly staleTurn: number;
  readonly newTurn: number;
}): string {
  return `regen aborted session=${input.sessionId} staleTurn=${input.staleTurn} newTurn=${input.newTurn}`;
}

/**
 * 落位行的留痕文本（一次重出**换成了新内容**）。
 *
 * `frame` 打出来是为了让「同桶递增」这条判据在 live 日志里可读：同一 `(会话, turn)`
 * 连续两行 `frame=1 / frame=2` 就是它成立的证据，不需要开 debug 之外的任何开关。
 */
export function regenLandedTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly frame: number;
  readonly chars: number;
  readonly avoided: number;
  readonly elapsedMs: number;
}): string {
  return `regen landed session=${input.sessionId} turn=${input.turn} frame=${input.frame}`
    + ` chars=${input.chars} avoided=${input.avoided} in ${input.elapsedMs}ms`;
}

/**
 * 重出这次**模型没给内容**（空/被过滤）的留痕。
 *
 * 它是一条独立的行而不是复用 landed：幽灵保持原样、用户会再按一次，
 * 「为什么按了没换」必须有答案（`dropped=empty|filtered` 指出该往哪一头查）。
 */
export function regenDroppedTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly outcome: string;
  readonly avoided: number;
  readonly elapsedMs: number;
}): string {
  return `regen dropped session=${input.sessionId} turn=${input.turn} outcome=${input.outcome}`
    + ` ghostUnchanged=1 avoided=${input.avoided} in ${input.elapsedMs}ms`;
}

/** 重出真实失败的留痕（故障级：用户在等这一次，不能只进 tee）。 */
export function regenFailedTrace(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly elapsedMs: number;
  readonly error: string;
}): string {
  return `regen failed session=${input.sessionId} turn=${input.turn} ghostUnchanged=1`
    + ` in ${input.elapsedMs}ms ${input.error}`;
}
