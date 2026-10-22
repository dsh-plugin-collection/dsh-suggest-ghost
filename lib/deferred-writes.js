/**
 * 事务外补写的槽队列（纯函数模块，零 runtime import，可离线驱动断言）。
 *
 * **它解决的问题**：宿主写 `_push` / `_ops` 会被内核拒——**两种模式**：结构性拒绝
 * （`HMR transactions cannot be nested`）与**可重试的竞争失败**
 * （`atomic-write: timed out waiting for the writer lock`）。判据是
 * `@deepseek-ai/dsh-hmr` 里 `runExclusive` 的
 * `if (this.executing.getStore()) return Promise.reject(...)`，而 `executing` 是一个
 * `AsyncLocalStorage`（同文件 :271），事务由 :283 的 `executing.run(true, operation)`
 * 建立。
 *
 * ⚠️ **行号按版本代次漂移，引用必须带代次锚点**（否则下一次升级又会写错行号）：
 *  - `dsh-hmr` **0.2.0-rc.2**：:271 = `executing = new AsyncLocalStorage()`、
 *    :280 = nested 拒绝、:283 = `executing.run(true, operation)`；
 *  - `dsh-hmr` **0.2.1-rc.2**：:736 / :749 / :752 —— 那一代的 `runExclusive` 函数体
 *    **逐字不变**，只是整段位移（实测：`dsh-settings` 与 `dsh-config-editor` 的
 *    `lib/index.js` 在两代之间逐字节相同、无位移，所以只有 `dsh-hmr` 的行号会漂）。
 *
 * ALS 上下文沿 `await`、microtask、以及**在事务内创建的 timer** 继续传播，所以
 * 「排到下一个 tick」根本逃不出去（issue #16 的取证注释就是这个结论）。
 *
 * **为什么定时器能逃出去、而事务内的写逃不出去**：timer 捕获的是**建它那一刻**的
 * `AsyncLocalStorage` 上下文（`apply()` 期建定时器时 store 是 undefined，于是它以后
 * 每次触发都在事务外）。复核评论 #36 `issuecomment-37810` 在实跑宿主 0.2.1-rc.2 上
 * 实测的写上下文（节选；「判定」列是「写有没有进盘并 bump revision」，**不是**耗时）：
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
 * 两条结论：① **失败有两种互不相同的成因**——nested 由**上下文在哪儿建立**决定（同步
 * 零副作用拒绝，23~31ms 即拒），锁超时由**争锁**决定（2s 硬上限，与上下文无关）；
 * ② 早先 PROBE 里 1463/1722ms 那两行「OK」其实撞的是锁窗口，**耗时不是写入耗时**。
 * 所以本模块排的队要装**两类**被拒写入（见下面的三态分诊），而 pump 还必须**别和
 * 即时写抢锁**（见 `src/index.ts` 里 `drainDeferred` 的互斥段）。
 *
 * 本模块就是这个「事务外锚点」要排的队：被拒的写入不再丢，稍后由 `src/index.ts` 里的
 * pump 补写。
 *
 * **槽语义**：最多两个槽（push / clearOps），同类入队只保留最新一份。这与 `pushToClient`
 * 现有的尾写合并（`pendingPushPayload` 新载荷覆盖旧载荷）是同一条语义，所以排队不会改变
 * 载荷的可见顺序，只是将「注定被拒的即时写」换成「一次可成的延后写」。
 *
 * 本模块只管**排、取、淘汰、判定**；真正的写与留痕在 `src/index.ts`，因为那需要 settings
 * 服务与 `traceOps`。判定函数把风险最高的两条安全约束放在这里，是为了让它们能被
 * `scripts/deferred-writes-smoke.mjs` 离线证伪（见那两个函数的注释）。
 *
 * @module dsh-suggest-ghost/deferred-writes
 */
/**
 * pump 间隔：500ms。
 *
 * 依据（两头都要给理由）：
 *  - **上限那头**：补写延迟必须小到用户还等得起。⚠️ **原来那条「500ms ≈ 典型生成耗时的
 *    1/4~1/3（生成常见 1.5~3s）」的依据已失效**：「1.5~3s」是估计而不是实测，而实测
 *    **单次写耗时 191~332ms**（首笔 2.2~2.5s，复核评论 #36 `issuecomment-37810` 在实跑
 *    宿主 0.2.1-rc.2 上的 A 组）—— 500ms 反而**大于**一次写，所以「按生成耗时的比例」
 *    这个论证不成立（生成耗时的分布见 `src/completion-gate.ts` 里的实测，两组样本差得
 *    很远，不是一个能拿来当分母的常数）。
 *    现在留 500ms 的理由换成另外两条：**①** 空转成本（见下）；**②** **本轮明确不缩短**
 *    ——间隔变小会加剧本仓与其它写者的**锁竞争**，而锁竞争正是
 *    `atomic-write: timed out waiting for the writer lock` 的来源之一；等互斥修完、
 *    有了新的失败率数据再定这个值（排期在 lead 那边，不在本轮）。
 *    取 2s 以上就等于没修：那时 client 早就在下一次输入了。
 *  - **下限那头**：空转成本。队列空时回调必须立刻 return（一次 `isEmpty()` 布尔判断），
 *    不做 `describe()`、不做读盘，所以 500ms 的代价是每秒 2 次布尔判断。再密下去只换来
 *    零点几秒的收益，不值。
 *  - 两个槽，每 tick 至多补写一个，所以最坏情况是两个 tick（1s）排空一批。
 */
export const DEFERRED_PUMP_MS = 500;
/**
 * 热度格（`_hot`）的写合并窗口（task-16 / #36 建议 2 第二步）。
 *
 * **为什么要有它**：#57 把热度/历史环拆成独立一格之后，写次数并没有下降（实测 4/4 持平）——
 * 因为热度**每次用户输入都会变**，一格一格只是把「谁被重写」分开了。真正把每回合写次数
 * 压下来的，是不让纯热度变化每次都触发一次整档 profile 重写。
 *
 * **为什么是 1000ms**：≈ 一个回合间隔（本轮 harness 实测每回合 1 次写，窗口取一回合长度
 * 时，连续热度变化的写次数上界就是「每窗口一次」）。这不是调参调出来的，是要与
 * `HOT_PUSH_STALENESS` 一起看的取舍：**窗口越长，写越少，但客户端看到的热度快照越旧**。
 * 陈旧影响的是**热表排序**（历史补全候选的打分顺序），**不影响建议本身**——建议格独立、
 * 永不被这个窗口拖慢（那是本条的硬规则，`decideHotPush` 只被热度格调用）。
 */
export const HOT_PUSH_WINDOW_MS = 1000;
/**
 * 这一次热度格变化该立刻写，还是并入正在计时的窗口。
 *
 * 判据用**窗口开启时刻**而不是「上一次写时刻」：
 *  - 用上次写时刻 + 连续热度变化，会得到「每次都往后推」的**饥饿**（只要用户一直在打字，
 *    热度永远写不进盘）。
 *  - 用固定起点则保证「每窗口至多一次写」，且陈旧度有上界（≤ 窗口 + 泵间隔）。
 * 首个变化（`windowOpenedAtMs === null`）必须立刻写：那才是「客户端尽早看到新热度」的一侧，
 * 之后的变化才谈得上合并。
 *
 * @param nowMs - 当前时刻（`Date.now()` 量纲；**由调用方传入**，冒烟用假时钟精确推进）。
 * @param windowOpenedAtMs - 本窗口开启时刻；null = 当前没有在计时的窗口。
 * @param windowMs - 窗口长度，默认 {@link HOT_PUSH_WINDOW_MS}（测试会传 0 来证伪断言）。
 */
export function decideHotPush(nowMs, windowOpenedAtMs, windowMs = HOT_PUSH_WINDOW_MS) {
    if (windowOpenedAtMs === null)
        return { action: 'write', heldMs: 0 };
    const heldMs = nowMs - windowOpenedAtMs;
    // 边界取 `>=`：刚好到点就算到期（写成 `>` 会让「窗口正好」这一拍多等一个泵 tick）。
    return heldMs >= windowMs ? { action: 'write', heldMs } : { action: 'defer', heldMs };
}
/**
 * 带续写的 push 载荷在槽里的最长存活时间：8000ms。
 *
 * 理由：`completion` 是**「此刻这份草稿」**的产物。补写成功时用户早已改了草稿，把一条
 * 陈年续写推进去会在光标位置显示一段不对题的幽灵文本（比「没幽灵」更糟，因为用户会
 * Tab 接受它）。8s 是这么定的：
 *  - 触发一次续写的输入停顿本身在 0.5~1.5s 量级，8s 相当于「用户又往下打了好几轮」；
 *  - 它是 `DEFERRED_PUMP_MS` 的 16 倍（8000/500），也就是排在槽里的续写至少有 16 次
 *    机会落盘，淘汰不会被当成「根本没试过」；
 *  - 按**单次写耗时**（实测 191~332ms，首笔 2.2~2.5s）算是 24~42 倍。这份额外的余量
 *    覆盖的是**补写与在途写争锁**要走的退避回合：锁等待的硬上限是 2s
 *    （`dsh-atomic-write` 的 `DEFAULT_LOCK_WAIT_MS = 2e3`，`dsh-config-editor` 取锁
 *    不传 options ⇒ 调用方改不了），争锁失败就重来，最坏要把一整个 2s 窗口让完才轮得到
 *    补写 —— 所以 8s 给的是「让完仍有余」，不是「生成时间的几倍」（生成耗时的实测分布
 *    见 `src/completion-gate.ts`）；
 *  - lead 给的反例（30 秒前的续写推进去是错的）在这个上限之上，本上限比它保守 4 倍。
 *
 * 不带 completion 的 push（纯热度/历史/对账刷新）**不按时间淘汰**：那些载荷是幂等的
 * 当前状态快照，晚一点写进去仍然正确，而且同类入队只会留最新一份，不存在积压陈旧。
 */
export const DEFERRED_PUSH_MAX_AGE_MS = 8000;
/**
 * 单个槽的最长补写次数：8 次（≈4s 的补写窗口）。
 *
 * 理由：事务外的 pump 建立时上下文才是「事务外」的。若插件在 HMR 事务**内**被重新
 * `apply()`（partialReload 会重跑 apply），那这个定时器就继承了 store=true，补写会
 * 永远被拒。没有界的重试会把每个 tick 变成「一次写 + 一条留痕」，而下一次自然写点
 * （回合结束、pull 应答）本来就会把最新状态补出去。所以到达上限就丢弃并留痕，
 * 让「补不上」这件事可见而不是一把烧日志。
 */
export const DEFERRED_MAX_ATTEMPTS = 8;
/**
 * 结构性拒绝的报文：内核 `runExclusive` 的拒绝文案。
 *
 * 取证见本文件顶部：`@deepseek-ai/dsh-hmr` 里 `runExclusive` 的
 * `if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions
 * cannot be nested"))`。
 */
const NESTED_RE = /cannot be nested/i;
/**
 * 写锁等待超时的报文。
 *
 * 实测原文：`atomic-write: timed out waiting for the writer lock at <path>`
 * （`@deepseek-ai/dsh-atomic-write/lib/index.js`：争锁按指数退避重试，超过
 * `DEFAULT_LOCK_WAIT_MS = 2e3` 即抛）。第二条正则兜住「前缀变了但语义没变」的变体
 * （`atomic-write:` 后面直接跟 `timed out`）。
 */
const LOCK_TIMEOUT_RE = /timed out waiting for (?:the |a )?(?:writer |write )?lock/i;
const LOCK_TIMEOUT_PREFIX_RE = /atomic-write:\s*timed out/i;
/**
 * 从任意错误对象里取可读文本。
 *
 * `error instanceof Error ? error.message : String(error)` 这个老写法在「抛的不是
 * Error 实例、但带 `message` 字段」时会退化成 `[object Object]`，于是分诊认不出报文、
 * 把可重试的竞争失败错判成「未知」。这里补上那一支。
 */
export function errorText(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    if (typeof error === 'object' && error !== null) {
        const message = error.message;
        if (typeof message === 'string')
            return message;
    }
    return String(error);
}
/** 是不是结构性拒绝（HMR 事务嵌套）？ */
export function isStructuralRefusal(text) {
    return NESTED_RE.test(text);
}
/** 是不是可重试的竞争失败（写锁等待超时）？ */
export function isWriterLockTimeout(text) {
    return LOCK_TIMEOUT_RE.test(text) || LOCK_TIMEOUT_PREFIX_RE.test(text);
}
/**
 * 把一次写失败分成三类，并给出处置与留痕 kind。
 *
 * 判定顺序有讲究：**先结构性拒绝、再竞争失败**。两者都不含对方的关键字，所以顺序
 * 只影响「同时命中两份特征」的边角报文；那种报文按更结构性的那一类处理（它更可能是
 * 真因，竞争失败只是表象）。
 *
 * @param error - 写失败的错误对象（`Error` 实例、带 `message` 的对象或字符串都行）。
 * @param channel - 写通道（决定 kind 的前缀）。
 */
export function triageWriteFailure(error, channel) {
    const text = errorText(error);
    if (isStructuralRefusal(text)) {
        return {
            cls: 'structural-refusal',
            disposition: 'queue',
            suffix: 'nested',
            kind: channel === 'push' ? 'push-nested' : 'ops-clear-nested',
            deferredKind: `deferred-${channel}-nested`,
            label: 'structural refusal (HMR transaction nested)',
        };
    }
    if (isWriterLockTimeout(text)) {
        return {
            cls: 'retryable-contention',
            disposition: 'queue',
            suffix: 'lock-timeout',
            kind: channel === 'push' ? 'push-lock-timeout' : 'ops-clear-lock-timeout',
            deferredKind: `deferred-${channel}-lock-timeout`,
            label: 'retryable contention (writer lock wait timed out)',
        };
    }
    return {
        cls: 'unknown',
        disposition: 'drop',
        suffix: 'failed',
        kind: channel === 'push' ? 'push-failed' : 'ops-clear-failed',
        deferredKind: `deferred-${channel}-failed`,
        label: 'unknown failure class',
    };
}
/**
 * 从 `_push` 载荷里读出续写草稿与会话。
 *
 * 只用**载荷里已有的信息**：`completion.draft` 与 `completionSessionId`。读不出来（不
 * 是 JSON、无该键、值不是字符串）一律返回 null，调用方据此退回时间上限那一道门；这里
 * 绝不「猜一个草稿出来」，也不声称能拿当前草稿（宿主没有草稿源，草稿在 client 输入框里）。
 */
export function pushPayloadCompletionMeta(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return { rev: null, completionDraft: null, completionSessionId: null };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { rev: null, completionDraft: null, completionSessionId: null };
    }
    const row = parsed;
    const rev = typeof row.rev === 'number' ? row.rev : null;
    const completion = row.completion;
    if (typeof completion !== 'object' || completion === null) {
        // `completion: null` = 显式作废，本来就不带续写，没有什么陈旧可担忧。
        return { rev, completionDraft: null, completionSessionId: null };
    }
    const draft = completion.draft;
    const sessionId = row.completionSessionId;
    return {
        rev,
        completionDraft: typeof draft === 'string' ? draft : null,
        completionSessionId: typeof sessionId === 'string' ? sessionId : null,
    };
}
/**
 * 补写 push 前的判定（安全约束二的 `_push` 那一半）。
 *
 * 「补写不得覆盖更新的盘上状态」在这里落实为三条跳过规则，按代价从便宜到贵排：
 *  1. `already-landed`：同一份字节已经在盘上（刚才有别的写点把它写成功了），再写一次
 *     只是白推一个 revision。
 *  2. `superseded`：指纹已不是入队时那一份 ⇒ 期间有人推了**更新的载荷**。那份新载荷要么
 *     已经落盘，要么覆盖了本槽（同类只留最新）。两种情形下再把旧载荷写回去都会用陈旧
 *     状态盖掉新状态（续写通道是单槽 last-wins，陈旧一份就把新鲜一份吃了）。
 *  3. `stale-draft`：载荷自带的 `completion.draft` 与宿主已知的该会话最新草稿不一致 ⇒
 *     用户早就换了草稿，这条续写推进去是错的。宿主草稿源 = `completionCache`（上一次
 *     成功生成的那份）；拿不到（null）时**不猜**，由时间上限兜底。
 *
 * @param item - 槽里的 push 项。
 * @param ctx - 调用方现读的最新状态（三个值都必须是**取槽之后**的当前值）。
 * @returns `write` 或 `skip` + 可留痕的原因。
 */
export function decidePushDrain(item, ctx) {
    if (ctx.lastLandedPayload === item.payload) {
        return { action: 'skip', reason: 'already-landed' };
    }
    if (item.fingerprint !== ctx.lastPushFingerprint) {
        return { action: 'skip', reason: 'superseded' };
    }
    if (item.completionDraft !== null
        && ctx.latestCompletionDraft !== null
        && ctx.latestCompletionDraft !== item.completionDraft) {
        return { action: 'skip', reason: 'stale-draft' };
    }
    return { action: 'write' };
}
/**
 * 补写 `_ops` 清空前的 CAS（安全约束二）。
 *
 * 判据来自 `src/index.ts` 的 `readOps()`：它走 settings 服务的 `describe()` 现读盘上的
 * `_ops` 值，是插件内唯一权威源。**相等才清**：相等说明盘上躺着的仍是「我们刚消费掉的
 * 那一份」，清空吃掉的是已消费的 op。不相等说明期间 client 又写了新载荷（载荷里带单调
 * `seq`，同值重写也会变），此时清空会**吃掉未消费的 op**：那是把用户输入弄丢，比留一
 * 份陈旧载荷在盘上严重得多。所以放弃这次清空（丢弃槽，不重试）：新载荷会走它自己的
 * `document-updated` → `consumeOps` → 入队自己的清空。
 *
 * @param item - 槽里的 clearOps 项。
 * @param onDiskPayload - 取槽**之后**现读的 `readOps()` 结果。
 */
export function decideClearOpsDrain(item, onDiskPayload) {
    if (onDiskPayload !== item.consumedPayload) {
        return { action: 'skip', reason: 'newer-ops-on-disk' };
    }
    return { action: 'clear' };
}
/**
 * 最多各存一项的槽队列。
 *
 * 不是无界队列：两个槽就是全部设计。`_push` 是单槽 last-wins 通道，`_ops` 是「全部消费完
 * 才清空」的批，两者都只需要最新一份，所以「同类覆盖」与现有 `pendingPushPayload` 的
 * 尾合并语义一致，且不存在无界内存。
 */
export class DeferredWriteQueue {
    pushSlot = null;
    clearSlot = null;
    /**
     * 入队一份被拒的 push 载荷（同类覆盖，新载荷取代旧载荷）。
     * 草稿/会话/rev 从载荷自身读出（见 `pushPayloadCompletionMeta`：不编造能力）。
     */
    enqueuePush(input, now) {
        const meta = pushPayloadCompletionMeta(input.payload);
        const item = {
            kind: 'push',
            payload: input.payload,
            fingerprint: input.fingerprint,
            rev: meta.rev,
            carriesCompletion: input.carriesCompletion,
            completionDraft: meta.completionDraft,
            completionSessionId: meta.completionSessionId,
            enqueuedAt: now,
            attempts: 0,
        };
        this.pushSlot = item;
        return item;
    }
    /** 入队一次被拒的 `_ops` 清空（同类覆盖，带**本次已消费**的载荷原文做 CAS 依据）。 */
    enqueueClearOps(consumedPayload, now) {
        const item = { kind: 'clearOps', consumedPayload, enqueuedAt: now, attempts: 0 };
        this.clearSlot = item;
        return item;
    }
    /**
     * 队列是否为空。pump 每 tick 都要调它，**必须便宜**（两个 null 比较，不碰盘、不
     * `describe()`）：队列常年是空的，空转成本完全由这个函数决定。
     */
    isEmpty() {
        return this.pushSlot === null && this.clearSlot === null;
    }
    /** 当前槽数（0~2，只为断言与留痕）。 */
    get size() {
        return (this.pushSlot === null ? 0 : 1) + (this.clearSlot === null ? 0 : 1);
    }
    /**
     * 淘汰「补了也没意义」的项，返回它们的留痕材料。
     *
     * 两条规则（都在 `take` 之前跑，所以陈旧载荷不会被写回去）：
     *  - `completion-too-old`：带续写的 push 超过 `DEFERRED_PUSH_MAX_AGE_MS`。
     *  - `attempts-exhausted`：任一槽补写满 `DEFERRED_MAX_ATTEMPTS` 次。
     */
    evict(now) {
        const out = [];
        const push = this.pushSlot;
        if (push !== null) {
            const ageMs = now - push.enqueuedAt;
            if (push.carriesCompletion && ageMs > DEFERRED_PUSH_MAX_AGE_MS) {
                out.push({ item: push, reason: 'completion-too-old', ageMs, attempts: push.attempts });
                this.pushSlot = null;
            }
            else if (push.attempts >= DEFERRED_MAX_ATTEMPTS) {
                out.push({ item: push, reason: 'attempts-exhausted', ageMs, attempts: push.attempts });
                this.pushSlot = null;
            }
        }
        const clear = this.clearSlot;
        if (clear !== null && clear.attempts >= DEFERRED_MAX_ATTEMPTS) {
            out.push({ item: clear, reason: 'attempts-exhausted', ageMs: now - clear.enqueuedAt, attempts: clear.attempts });
            this.clearSlot = null;
        }
        return out;
    }
    /**
     * 取一项执行（入队最早的那个槽优先，等时长时 push 优先：用户在等的是幽灵）。
     * 取即离槽：调用方失败后自己调 `retry` 放回来，避免「槽里还有一份正在写的」误读。
     */
    take() {
        const push = this.pushSlot;
        const clear = this.clearSlot;
        if (push === null && clear === null)
            return null;
        if (push === null) {
            this.clearSlot = null;
            return clear;
        }
        if (clear === null) {
            this.pushSlot = null;
            return push;
        }
        if (clear.enqueuedAt < push.enqueuedAt) {
            this.clearSlot = null;
            return clear;
        }
        this.pushSlot = null;
        return push;
    }
    /**
     * 补写被拒后放回原槽并计一次数（`enqueuedAt` 不变，所以时间淘汰仍在计时）。
     *
     * 放回前检查同种槽是否已被**更新的入队**占住（在途写期间可能发生）：那种情况下旧项
     * 已被取代，放回会把新载荷盖掉，所以直接丢弃并返回 false 让调用方留痕。
     */
    retry(item) {
        if (item.kind === 'push') {
            if (this.pushSlot !== null)
                return false;
            this.pushSlot = { ...item, attempts: item.attempts + 1 };
            // `enqueuedAt` 保持原值：计龄不能因重试而停表（否则每 4s 一轮的失败永不超龄）。
            return true;
        }
        if (this.clearSlot !== null)
            return false;
        this.clearSlot = { ...item, attempts: item.attempts + 1 };
        return true;
    }
}
