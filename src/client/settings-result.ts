/**
 * 远程 settings 写面的**兑现值判定**（纯函数，无 DOM、无 I/O）。
 *
 * 单独成模块的理由有二：
 *  1. #16 的实质（「日志 mutate OK、宿主侧 `_ops` 永远停在 boot 初值」）就发生在
 *     这一层判定上——它必须是可测的，否则只能等宿主重启后现场看日志；
 *     `scripts/ops-write-verify-smoke.mjs` 用假兑现值直接驱动它。
 *  2. 与 `accept-guard.ts` / `inline-arm-policy.ts` 同一HOUSE 约定：client 里
 *     凡是「决策」而不是「接线」的部分都抽成纯模块，node 能直接 import 源文件
 *     （本模块没有 `.js` 说明符依赖，裸 node 可解析）。
 *
 * ## 为什么「兑现」不等于「写成功」
 *
 * 内核 `SettingsForms.write()` 遇 revision 过期抛 `SettingsConflictError`
 * （`@deepseek-ai/dsh-settings/lib/index.js:511`，`code = "SETTINGS_CONFLICT"`，
 * 同文件 :165/:177）。但 `ctx.remote.settings.mutate` 的调用方**看不到那次抛错**：
 *
 *  - `@deepseek-ai/dsh-api-settings-controller/lib/index.js:489,501-507`：控制器
 *    捕获内核错误并**重新分类**成 `RemoteError`——冲突的码是 `settings/conflict`
 *    （不是内核那个码！），details 带 `{ns, expected, actual}`，message 保留内核原文；
 *  - `@deepseek-ai/dsh-api-gateway/lib/index.js:1425-1437`：`rpcFailure` 把
 *    `code`/`message`/`details` 原样编码上线；
 *  - `@deepseek-ai/dsh-api-gateway/lib/client.js:1795-1802,2124-2126`：客户端面
 *    用 `rebuiltFailure` 原样重建 `RemoteError`，然后**折进 `RemoteResult` 的 error
 *    分支照常兑现**；
 *  - `@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:60-73`：契约写明「只有
 *    装配故障（参数元数、方法未挂载、缺 Context 适配器）才 reject」。
 *
 * 所以：**Promise 兑现状态不含任何写入信息**，成功与否只存在于兑现值的 `ok` 判别式里。
 * 内核侧 `SettingsConflictError.code` 跨远程层被**重映射**成 `settings/conflict`——
 * 码是保留的，值换了 taxonomy（对照：内核自己的设置页也按
 * `response.error.code === 'settings/conflict'` 分支，
 * `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2795-2805`）。
 * 本模块因此**两个码都认**：远程形态 `settings/conflict`，以及本地 `SettingsForms`
 * /不经那次重分类的老代次给出的 `SETTINGS_CONFLICT`。
 *
 * 成功分支的兑现值是写后的 `SettingsNamespaceView`（`revision: z.number()` + 整份
 * `value`，`@deepseek-ai/dsh-api-settings-controller/lib/typert.remote-client.js:69-82`），
 * 它就是现成的写后凭证，**不需要再发一次 describe()**（浏览器侧热路径）。
 * @module dsh-suggest-ghost/client/settings-result
 */

/** 认得出的写后命名空间视图（只用到这两个字段）。 */
export interface NamespaceViewLike {
  readonly revision?: unknown;
  readonly value?: unknown;
}

/** `unwrapMutateResult` 的分类结果。 */
export interface MutateOutcome {
  /**
   * 远程面的业务结论。
   * `undefined` = 这一代的返回值里认不出 `ok` 判别式，也认不出命名空间视图。
   */
  readonly ok: boolean | undefined;
  /** 失败时的稳定机器码（远程 taxonomy：`settings/conflict`）。 */
  readonly code: string | undefined;
  /** 失败时的诊断文本（内核原文，含 "revision" 一词）。 */
  readonly message: string | undefined;
  /** 成功时的写后视图（认不出来时 undefined）。 */
  readonly view: NamespaceViewLike | undefined;
}

/** 一次 `_ops` 写入的最终判定（`settleWriteVerdict` 的返回值）。 */
export type WriteVerdict =
  /** 有证据表明载荷进了文档。 */
  | 'landed'
  /** 版本冲突（可重取 revision 重试）。 */
  | 'refused-conflict'
  /** 其它拒绝（字段不可写 / 条目不存在 / 传输失败）。 */
  | 'refused-other'
  /** 远程说成功了，但写后视图既没有我们的载荷、revision 也没动——#16 的签名。 */
  | 'unsettled'
  /** 这一代给不出可判读的返回值：调用方自己补一次读回。 */
  | 'unreadable';

/**
 * 一次 `_ops` 写入**总共**允许的尝试次数（含首次发送）。
 *
 * 旧实现把 `attempt < 2` 直接写在两处分支里（共 3 次），既看不出是「总次数」还是
 * 「重试次数」，也让「放宽预算」这类改动必须同时改两个地方。现在两条冲突分支都经
 * {@link opsConflictRetryAllowed} / {@link opsConflictBackoffMs} 判定，这里只留一个数。
 *
 * 为什么是 8（2026-10-22 第二次校准）：串行队列消掉**页面自抢**后，剩下的冲突来自宿主侧
 * 写入（应答 `_push`/`_hot`、消费后 `_ops` 清空）与其它页签的同 ns 写入。上一档
 * 「5 次 + 25/50/100/200（总 375ms）」被 live 栈证伪：冲突报文是 `expected 733, now 734`
 * ——只落后**一笔**写，而宿主一笔写的实测在途窗口是 0.2~1.6s（writeMs），375ms 的总退避
 * **比一次在途写还短**，5 连败是必然而不是运气。8 次 × 新退避（总窗口 ≈5.9s）覆盖 2~3 个
 * 宿主写窗口；再长就该问「为什么宿主一直在写」而不是让客户端无限等。
 */
export const OPS_WRITE_MAX_ATTEMPTS = 8;

/** 冲突重试退避的**上限**（毫秒）。attempt 超过第 4 档后不再增长，防止长尾等待。 */
export const OPS_WRITE_CONFLICT_BACKOFF_CAP_MS = 1_600;

/** 退避第一档（毫秒）；第 n 档 = 基础值 × 2^n，超过上限即截断。 */
const OPS_WRITE_CONFLICT_BACKOFF_BASE_MS = 100;

/**
 * 第 `attempt` 次尝试**冲突后**、重试前应等待的毫秒数：100 / 200 / 400 / 800 / 1600，
 * 之后截断在 {@link OPS_WRITE_CONFLICT_BACKOFF_CAP_MS}。
 *
 * 量纲依据：对手（宿主应答/清空写、别的页签）单次写在途 0.2~1.6s——第一档 100ms 给
 * 「擦肩而过」的快碰撞让路，后几档跨过整个慢写窗口。纯函数、无定时器（真等待在调用点），
 * 所以 `scripts/ops-write-queue-smoke.mjs` 可以直接断言序列。非法输入（负数 / NaN /
 * Infinity）退回第一档，不返回 `NaN`——否则 `setTimeout(NaN)` 会退化成 0ms 忙重试。
 */
export function opsConflictBackoffMs(attempt: number): number {
  const tier = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(
    OPS_WRITE_CONFLICT_BACKOFF_BASE_MS * 2 ** tier,
    OPS_WRITE_CONFLICT_BACKOFF_CAP_MS,
  );
}

/**
 * 第 `attempt` 次尝试失败后**是否还允许重试**（`attempt` 从 0 起算）。
 *
 * 判据是「总次数」而不是「剩余重试数」：`attempt + 1 < OPS_WRITE_MAX_ATTEMPTS`，
 * 于是 MAX=8 时 attempt 0..6 可重试（总共 8 次尝试）、attempt 7 放弃。
 * 两条冲突分支（mutate reject 的 `isConflictRefusal` 与 `settleWrite` 的
 * `refused-conflict`）共用它，不许各写一份边界。
 */
export function opsConflictRetryAllowed(attempt: number): boolean {
  return Number.isInteger(attempt) && attempt >= 0 && attempt + 1 < OPS_WRITE_MAX_ATTEMPTS;
}

/** 从任意一层封装里认出一个命名空间视图。 */
function looksLikeNamespaceView(node: Record<string, unknown>): boolean {
  const hasIdentity = typeof node.ns === 'string' || typeof node.revision === 'number';
  return hasIdentity && ('value' in node || 'revision' in node);
}

/**
 * 解包 `mutate` 的兑现值，**不假设层数**（与 `unwrapSettingsDoc` 同一理由：
 * transport 是否已解一层在不同代次表现不一致，按固定层数写会在另一种形状下
 * 恒为 undefined，且静默失败）。
 */
export function unwrapMutateResult(response: unknown): MutateOutcome {
  const none = (): MutateOutcome => ({ ok: undefined, code: undefined, message: undefined, view: undefined });
  let node: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== 'object' || node === null) return none();
    const record = node as Record<string, unknown>;
    if (typeof record.ok === 'boolean') {
      if (record.ok === false) {
        const error = record.error;
        const box = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
        return {
          ok: false,
          code: typeof box?.code === 'string' ? box.code : undefined,
          // 老 host 可能把失败压成裸字符串 / 裸 Error：message 一律兜住，供文本判据用。
          message: typeof box?.message === 'string'
            ? box.message
            : typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : undefined,
          view: undefined,
        };
      }
      node = record.value;
      continue;
    }
    if ('result' in record) { node = record.result; continue; }
    // 没有 ok 判别式：这一代的返回值本身就是视图。
    if (looksLikeNamespaceView(record)) {
      return { ok: true, code: undefined, message: undefined, view: record as NamespaceViewLike };
    }
    return none();
  }
  return none();
}

/**
 * 是否「版本冲突」。**有码就只按码判**，文本匹配降级为「这一代根本没给码」时的兜底：
 *  - `settings/conflict`：远程层重分类后的码（取证见模块头）；
 *  - `SETTINGS_CONFLICT`：内核本地码（本地 `SettingsForms` 或未经重分类的代次）；
 *  - 兜底文本：老 host 把错误压成裸字符串时 `code` 拿不到，而报文本身含
 *    "revision" 一词（`dsh-settings/lib/index.js:176`）。
 *
 * 「有码就不看文本」是刻意的：`settings/rejected` 的 message 可能也带 revision
 * （例如某条路径把内核原文塞进去），按文本判会把**不可重试**的拒绝误判成冲突，
 * 白重试两轮还把日志刷脏。
 */
export function isConflictRefusal(code: string | undefined, message: string | undefined): boolean {
  if (typeof code === 'string') return code === 'settings/conflict' || code === 'SETTINGS_CONFLICT';
  return /conflict|revision/i.test(message ?? '');
}

/**
 * 只看写后视图能得出什么结论。两个判据取或：
 *  1. **载荷仍在盘上**（`view.value._ops === sent`）——最强证据；host 消费完会把
 *     `_ops` 写回空值，所以这条可能因抢先清空而不成立，不能单独用。
 *  2. **revision 与提交时不同**——内核按内容指纹推导 revision
 *     （`dsh-settings/lib/index.js:428`），写进去的内容与现值相同时指纹不变、
 *     计数不动（那种情况判据 1 必然成立）；因此「计数没动 + 盘上不是我们那份」=
 *     这份写根本没进文档，正是 #16 的现象。
 *     取「不同」而不是「更大」：host 重启会让计数回到 0，用 `>` 会在那种时刻假报警。
 */
export function verdictFromView(
  view: NamespaceViewLike | undefined,
  expectedRevision: number,
  sentPayload: string,
): WriteVerdict {
  if (view === undefined) return 'unreadable';
  const revision = typeof view.revision === 'number' ? view.revision : undefined;
  const box = view.value;
  const landedOps = typeof box === 'object' && box !== null
    ? (box as Record<string, unknown>)._ops
    : undefined;
  if (landedOps === sentPayload) return 'landed';
  if (revision !== undefined && revision !== expectedRevision) return 'landed';
  if (revision !== undefined) return 'unsettled';
  return 'unreadable';
}

/**
 * 把 `mutate` 的兑现值折成一个判定。**这是 #16 的闭环点**：
 * `{ok:false, error:{code:'settings/conflict'}}` 以前被 `.then(() => true)` 读成
 * 成功，现在归 `refused-conflict`（调用方重取 revision 重试或留痕返回 false）。
 */
export function settleWriteVerdict(
  response: unknown,
  expectedRevision: number,
  sentPayload: string,
): WriteVerdict {
  const outcome = unwrapMutateResult(response);
  if (outcome.ok === false) {
    return isConflictRefusal(outcome.code, outcome.message) ? 'refused-conflict' : 'refused-other';
  }
  const verdict = verdictFromView(outcome.view, expectedRevision, sentPayload);
  if (verdict !== 'unreadable') return verdict;
  // `ok === true` 但视图读不出 revision/_ops：这一代的返回值没有可判别的写后凭证。
  return outcome.ok === true ? 'unreadable' : 'unreadable';
}

/** 从 reject 出来的错误值里取 code/message（装配故障走这条路：远程面确实会 reject）。 */
export function readRejection(error: unknown): { code: string | undefined; message: string | undefined } {
  if (typeof error === 'string') return { code: undefined, message: error };
  if (typeof error !== 'object' || error === null) return { code: undefined, message: undefined };
  const box = error as Record<string, unknown>;
  return {
    code: typeof box.code === 'string' ? box.code : undefined,
    message: typeof box.message === 'string' ? box.message : String(error),
  };
}
