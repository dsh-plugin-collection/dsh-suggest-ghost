/**
 * 续写载荷与当前草稿的对齐判定（纯函数，便于离线断言）。
 *
 * ## 背景：为什么不能再要求「逐字全等」
 *
 * 原判据是 `completion.draft === draft`。而续写是**接在草稿后面**的半句，用户在生成期间
 * （实测中位 4.9 秒、最慢 17 秒）继续打字是**最常见**的用法。线上实测一次会话的 46 次停顿里
 * **45 次草稿长度都不同** —— 全等判据把主路径判成了失效，用户看到的现象就是「等很久也不出东西」。
 *
 * ## 判据：只接受「你没改前面」的两种形态
 *
 * 设 `payload` = 生成这份续写时客户端提交的草稿，`cur` = 当前草稿：
 *
 * | 关系 | 含义 | 处理 |
 * |---|---|---|
 * | `cur === payload` | 草稿未变 | 照常显示（原行为） |
 * | `cur` 以 `payload` 开头 | 你在末尾继续打了字 | **显示**，并裁掉已打出的重叠部分 |
 * | 其他 | 改了中间 / 换了内容 / 删了字 | 丢弃（贴上去会错位） |
 *
 * 为什么**不**接受「`payload` 以 `cur` 开头」（即你删了末尾的字）：删字后光标位置无从得知，
 * 续写直接接在当前草稿后面可能落在错误的位置。这种形态保持丢弃 —— 宁可少显示，不可显错。
 *
 * ## 重叠裁剪
 *
 * 「你在末尾继续打字」时，`payload + completion.text` 的前若干字符可能**已经被你打出来**了。
 * 例如载荷续写是「测试了」，而你已经打出「测」，那幽灵只该补「试了」。
 *
 * 裁剪点取**两个候选的对齐结果中更靠后**的一个，且限定在续写文本内：
 *  - `cur` 与 `payload+text` 的公共前缀（你已经照着续写打下去了）；
 *  - `cur` 长于 `payload` 的那一段（你新打的内容）与 `text` 的公共前缀。
 *
 * 取更靠后者是为了避免"你打的字与续写开头不重合"时把整段续写重复显示。
 *
 * 全为 UTF-16 码元比较（与 `commonPrefixLength` 同款），不做语言相关的归一化：
 * 幽灵渲染按字符对齐，越界或错位比"少显示一个字符"更糟。
 *
 * ## 裁空之后：形态不得在同一次生成内翻转（Gitea #38 第 4 条）
 *
 * `:87` 那支裁空（`suffix === ''`）返回的是 `ok: false`，而调用方的分支顺序是
 * 「续写 → 历史补全 → LLM 建议」，于是本帧会继续往下落，幽灵从 `inline` 掉到
 * `history`。判据收在本文件末尾（`decideInlineForm`），理由：它唯一的证据就是这里
 * 的归属前缀关系，拆开写就会变成第二份互相不约束的真相。
 *
 * ## 「空草稿」这一份判据与 LLM 形态的可达性（Gitea #129）
 *
 * 同一条分支顺序还留着一个更贵的洞：「非空草稿不会落到 LLM 支」过去**只靠隐式顺序**
 * 兜住，把设置里的「启用历史补全」关掉就失效 —— 灰字压在用户已输入的字上、Tab 整段
 * 覆盖草稿。判据（{@link hasUserDraft} / {@link decideLlmForm}）同样收在本文件末尾，
 * 理由与上面那条一致：三条形态支共用的「空/非空」判据必须只有一份拼写，且 LLM 支的
 * 可达性不许跟着别的功能的开关走。
 *
 * @module dsh-suggest-ghost/completion-align
 */

/** 判定的三种结果。`ok` 为 true 时给出对齐后的幽灵后缀。 */
export type CompletionAlignResult =
  | { readonly ok: true; readonly kind: 'exact' | 'extended'; readonly suffix: string; readonly full: string }
  | { readonly ok: false; readonly reason: 'draft-mismatch' | 'empty-text' | 'empty-draft' };

/** 两串按 UTF-16 码元的公共前缀长度。 */
function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 判定一份续写载荷能否对齐到当前草稿。
 *
 * @param cur 当前草稿（渲染这一帧时输入机的值）
 * @param payloadDraft 生成这份续写时客户端提交的草稿
 * @param completionText 宿主生成的续写文本（接在 `payloadDraft` 之后的半句）
 */
export function alignCompletion(
  cur: string,
  payloadDraft: string,
  completionText: string,
): CompletionAlignResult {
  if (completionText === '') return { ok: false, reason: 'empty-text' };
  if (!hasUserDraft(cur)) return { ok: false, reason: 'empty-draft' };
  // 草稿未变：原行为，整段续写都是幽灵。
  if (cur === payloadDraft) {
    return { ok: true, kind: 'exact', suffix: completionText, full: cur + completionText };
  }
  // 只在「你在末尾继续打字」时显示；其余（改中间/换内容/删字）一律丢弃。
  if (!cur.startsWith(payloadDraft)) return { ok: false, reason: 'draft-mismatch' };

  // 你新打的那一段（可能已与续写开头重合）。
  const typedSince = cur.slice(payloadDraft.length);
  // 裁剪点 = 你新打的内容与续写开头的公共前缀，且**不超过续写长度**
  // （否则会把整段续写吃掉、显示空白）。
  //
  // 为什么只用这一维：早先还叠加了「cur 与 cur+text 的公共前缀」那一维，想覆盖
  // "你已经照着续写打下去了"。但那维在两种情况下会**误裁**（冒烟当场抓到）：
  //   - 你打的字与续写无关（`前面ABC` vs 续写 `构建流程`）却被算成重合；
  //   - 载荷草稿为空时 `typedSince` 等于整个 `cur`，直接裁空。
  // 而 `typedSince` 这一维本身就够：它能命中的正是"你打出的东西与续写开头一致"的场景。
  const overlap = Math.min(completionText.length, commonPrefixLength(typedSince, completionText));
  const suffix = completionText.slice(overlap);
  // 裁完为空 = 你已经把整段续写打完了，此时没有幽灵可显示（不是错误）。
  if (suffix === '') return { ok: false, reason: 'empty-text' };
  return { ok: true, kind: 'extended', suffix, full: cur + suffix };
}

// ── 同一次生成内的形态判据（Gitea #38 第 4 条）──────────────────────────
//
// ## 要闭合的现象
//
// 上面 `:87` 那支裁空（你已经把整段续写打完了）返回 `ok: false`，而调用方
// `computeGhostContent` 的分支顺序是「续写 → 历史补全 → LLM 建议」，于是本帧会继续往下
// 落：幽灵从 `inline` 掉到 `history`，用户看到的是「灰色尾巴无声换成另一段不相干的文字」
// ——形态在同一次生成里翻转了。
//
// ## 判据：只作用于「同一次生成的连续帧」，且不靠草稿逐字相同
//
// 「这次生成仍然在场」的证据**不是** `draft === payload.draft`（#33 之后「边打边等」是
// 主路径，草稿会长）。真正的证据就是上面 `alignCompletion` 的**归属前缀**关系：
// `draft === payload.draft || draft.startsWith(payload.draft)`。该关系在 `:72` 已被检查，
// 只有先通过它才可能走到 `:87` 的裁空——所以「裁空」这一事实本身就意味着这次生成仍拥有
// 这份草稿。判据因此不需要任何自造的 generation key，也不会与 #33 打架。
//
// | 状态 | 含义 | 历史补全可否回落 |
// |---|---|---|
// | `show` | 续写可显示 | ——（本来就不回落） |
// | `consumed` | 载荷仍拥有这份草稿，只是被裁空 | **否**（宁可不显示） |
// | `superseded` | 这次生成结束了（改中间/删字/清空/换会话/空文本/无载荷/开关关闭） | 是 |
//
// 取向与上面「宁可少显示，不可显错」一致：少一次建议可接受，显错形态不可接受。下一次宿主
// 出新载荷、或用户把草稿改成 `superseded`，历史补全自然回来。LLM 建议那一支不在这里管：
// `consumed` 只在草稿非空时成立，而 LLM 建议只在草稿为空时显示，两条路径天然不相交。

/** 本帧「续写这一路」处于什么状态。`reason` 供留痕与冒烟断言。 */
export type InlineFrameState =
  | { readonly kind: 'show' }
  | { readonly kind: 'consumed' }
  | {
      readonly kind: 'superseded';
      readonly reason:
        | 'inline-disabled'
        | 'empty-draft'
        | 'no-payload'
        | 'other-session'
        | 'no-text'
        | 'draft-mismatch'
        | 'empty-draft-after-align';
    };

/** 判据的入参：全部来自 `settings` + 当前草稿 + 一次 {@link alignCompletion} 的结果。 */
export type InlineFrameInput = {
  /** 停顿续写开关。 */
  readonly inlineEnabled: boolean;
  /** 当前草稿（原样，判据内部才 trim）。 */
  readonly draft: string;
  /** host 推来的续写载荷（`settings.completion`）。 */
  readonly payload: { readonly draft: string; readonly text: string } | null | undefined;
  /** 载荷是否属于当前会话（`settings.completionSessionId === currentId`）。 */
  readonly payloadBelongsToCurrentSession: boolean;
  /** `alignCompletion(...)` 的 `ok`；未对齐（载荷不属于本会话）时为 false。 */
  readonly alignedOk: boolean;
  /** `alignCompletion(...)` 的失败理由；`ok` 时为 null。 */
  readonly alignedReason: 'draft-mismatch' | 'empty-text' | 'empty-draft' | null;
};

/**
 * 这份载荷当前是否仍然**拥有**草稿——即 #33 的「草稿未变 / 末尾继续打字」关系。
 *
 * 只在前置判据成立时才算拥有；导出它是因为冒烟要能单独钉住这条，而不必借道
 * `alignCompletion` 的实现细节。
 */
export function ownsDraftByAlignmentContract(draft: string, payloadDraft: string): boolean {
  return draft === payloadDraft || draft.startsWith(payloadDraft);
}

/** 给一次生成定状态。顺序与 `computeGhostContent` 的守卫一致，先排除「根本没有续写在场」。 */
export function classifyInlineFrame(input: InlineFrameInput): InlineFrameState {
  if (!input.inlineEnabled) return { kind: 'superseded', reason: 'inline-disabled' };
  if (!hasUserDraft(input.draft)) return { kind: 'superseded', reason: 'empty-draft' };
  const payload = input.payload;
  if (payload === null || payload === undefined) return { kind: 'superseded', reason: 'no-payload' };
  if (!input.payloadBelongsToCurrentSession) return { kind: 'superseded', reason: 'other-session' };
  // 宿主推了空续写：这不是一次「生成」，没有形态可保护。
  if (payload.text === '') return { kind: 'superseded', reason: 'no-text' };
  if (input.alignedOk) return { kind: 'show' };
  // 裁空：`alignCompletion` 只在「载荷仍拥有草稿」时才可能走到它那步裁剪。
  if (input.alignedReason === 'empty-text') {
    return ownsDraftByAlignmentContract(input.draft, payload.draft)
      ? { kind: 'consumed' }
      : { kind: 'superseded', reason: 'draft-mismatch' };
  }
  if (input.alignedReason === 'empty-draft') return { kind: 'superseded', reason: 'empty-draft-after-align' };
  return { kind: 'superseded', reason: 'draft-mismatch' };
}

/** 本帧的形态裁决。 */
export type InlineFormVerdict = {
  /** 续写本身可否显示。 */
  readonly showInline: boolean;
  /** 可否回落到历史补全。 */
  readonly allowHistory: boolean;
  /** 非 null = 本帧被扣住（同代不得翻转），值就是留痕的理由。 */
  readonly hold: string | null;
};

/**
 * 「续写 → 历史补全」的回落判据：只有 `consumed` 扣住，其余一切保持现状。
 *
 * 注意 LLM 建议那一支不在这里管：它的进入条件见本文件末尾的 {@link decideLlmForm}
 * （Gitea #129），与这里的续写归属判据正交。
 */
export function decideInlineForm(input: InlineFrameInput): InlineFormVerdict {
  const state = classifyInlineFrame(input);
  if (state.kind === 'show') return { showInline: true, allowHistory: true, hold: null };
  if (state.kind === 'consumed') return { showInline: false, allowHistory: false, hold: 'inline-consumed' };
  return { showInline: false, allowHistory: true, hold: null };
}

// ── 「空草稿」这一份判据 与 LLM 形态的可达性（Gitea #129）──────────────────
//
// ## 要闭合的现象
//
// `computeGhostContent` 的分支顺序是「续写 → 历史补全 → LLM 建议」，而「非空草稿不会
// 落到 LLM 支」过去**只靠隐式顺序**兜住：历史支的进入条件是 `historyEnabled && 非空草稿`，
// 进去了就必 `return`（有候选给 history、无候选给 null）。于是把设置里的「启用历史补全」
// 关掉（默认开），非空草稿直接掉进 LLM 支。llm 形态的锚定文本是**空串**
// （`index.ts` 的 `overlayShapeOf`），灰字从第 0 列画出去、压在用户正打的字上；采纳又是
// **整段覆盖**草稿（`accept-guard.ts` 的 `buildFullAccept` 对 llm 就是 `return content.text`）
// ⇒ 用户输入无声消失。CAS 救不了：草稿在「算」与「写」之间没变时判据完全通过——
// 这不是竞态，是**形态可达性**。
//
// ## 判据：注释里写着的「草稿为空」改成显式一条
//
// `decideLlmForm` 只认一个量：草稿空不空。它**不看** `historyEnabled`——可达性跟着
// 另一个功能的开关走正是缺陷本体，把这条独立性做成类型面看得见、冒烟钉得住的形状。
// 「同一次生成内形态不得翻转」（#38，`decideInlineForm`）不在这里管：本判据加在
// LLM 支自己头上，续支/历史支的相对顺序一字未动。
//
// ## 命令前缀草稿（`/later `、`/later +3m `）算不算「空」——算**非空**
//
// 本仓此前没定义这条，拍板理由有两条且互相印证：
//  1. `stripCommandPrefix` 是历史支的**匹配**判据（那些命令 `recordInput:false`，历史里
//     只有内容部分，拿整行匹配必然 `startsWith` 失败），不是「用户有没有输入」的判据；
//     历史支自己在 `contentDraft` 为空时 `return null`——**什么都不显示**，与这里同形。
//  2. 判成「空」就等于在 `/later +3m ` 上放行一条整段覆盖的采纳，把用户正在敲的命令一起
//     抹掉——正是本条要堵的丢输入。
// ⇒ 「空」的唯一口径是 {@link hasUserDraft}（`trim()` 后无字符），与历史支的进入条件
// **同一份函数**，续写支/对齐判据也改走它；`stripCommandPrefix` 继续只管「拿什么去匹配、
// 采纳时怎么回填前缀段」，不参与空/非空裁决。

/**
 * 草稿里有没有**用户已输入的字符**（`trim()` 后非空）。
 *
 * 三条形态支（续写、历史补全、LLM 建议）共用的那一份空/非空判据。写成函数而不是
 * 三处 `draft.trim() !== ''`：同一份草稿在两支里得到相反结论（#129 的成因）正是靠
 * 「判据各写各的」活下来的，冒烟 `llm-form-guard-smoke.mjs` 现在钉住源文本里只许有
 * 这一份拼写。
 */
export function hasUserDraft(draft: string): boolean {
  return draft.trim() !== '';
}

/** {@link decideLlmForm} 的入参。 */
export type LlmFormInput = {
  /** 这一帧的草稿（与渲染、采纳同源于同一次快照读取）。 */
  readonly draft: string;
  /**
   * 历史补全开关。**不参与裁决**——它出现在入参里的唯一理由是让「可达性不跟着别的
   * 功能的开关走」这条独立性可断言（见本节开头；Gitea #129 的缺陷本体就是这条耦合）。
   */
  readonly historyEnabled: boolean;
};

/** LLM 形态的本帧裁决。 */
export type LlmFormVerdict = {
  /** 可否出 llm 形态（幽灵 + 可采纳）。 */
  readonly allow: boolean;
  /** 留痕理由：放行 = 空草稿；拦下 = 草稿里有用户已输入的字符。 */
  readonly reason: 'blank-draft' | 'draft-not-blank';
};

/**
 * LLM 建议形态只在**空草稿**上可达（Gitea #129）。
 *
 * 拦下时调用方当场 `return null`：这一帧不显示任何幽灵，也不往下落——它已经是最后一支。
 */
export function decideLlmForm(input: LlmFormInput): LlmFormVerdict {
  return hasUserDraft(input.draft)
    ? { allow: false, reason: 'draft-not-blank' }
    : { allow: true, reason: 'blank-draft' };
}
