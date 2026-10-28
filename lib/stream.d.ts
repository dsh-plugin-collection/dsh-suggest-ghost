/**
 * 流式投递的宿主侧通道（Gitea #108 决策 ①：明知收益中位 1.8% / 91ms 仍做，**默认关闭**）。
 *
 * ## 为什么是「客户端自触发的短流」
 *
 * 生成是宿主在 `turn/end` 触发的，客户端事先不知道 ⇒ 三个候选里：
 *
 *  - **(a) 每会话一条常驻流**：宿主要为每个会话维护一条跨回合存活的 sink，处理僵尸流、
 *    重连后再绑定、以及「一条长活流上如何丢弃在途旧帧」。流开着的时间远大于它有用的时间
 *    （每回合只用到 1–3 秒）。
 *  - **(b) 宿主发「开始」信号 + 客户端再开流**：便宜的开始信号通道**不存在**。settings 面
 *    发一个信号 = 一次整份 profile 重写（实测 `writeMs` 361–2260ms）⇒ 反而把首帧推后，
 *    并且违反「增量帧零落盘」的精神；typert 的事件转发是白名单制（只有内核事件在表上），
 *    插件事件进不去。
 *  - **(c) = 本文件**：取 (b) 的短流形状，但**开始信号客户端自己就有** —— 客户端已经订阅了
 *    会话快照（`src/client/index.ts` 的 `bound.session.subscribe(...)`），
 *    `running: true → false` 那个边沿就是回合结束，零往返、零落盘。
 *
 * ## 三条硬约束在这里怎么落
 *
 *  1. **增量帧零落盘**：本模块不 import settings、不碰 `configEditor.edit`、不写任何格子；
 *     帧只活在内存里的订阅队列上。验收判据（#36）是日志里增量帧的 `push landed` 恒为 0。
 *  2. **终帧仍写一次 `_push`**：那条路径在 `src/index.ts` 里，本模块**不替代**它
 *     （#56/#88/#93 的权威态与冷启动/重连语义都挂在那次写上）。
 *  3. **限频自己做**：宿主下行没有合帧/丢弃原语 ⇒ {@link STREAM_FRAME_MIN_INTERVAL_MS}
 *     是一个**常量窗口**，并被冒烟断言钉住（#62 的做法）。队列溢出时丢的是**最旧的非终帧**
 *     —— 与「中途显示的内容允许被终帧丢弃」一致。
 *
 * 键只到 **会话**，不到 `(会话, 回合)`：客户端在 `running` 边沿上开流时**拿不到回合号**
 * （那是宿主侧 `turn/end` 的载荷）。回合号由帧自己带（{@link GhostStreamFrame.turn}），
 * 客户端用它做归属校验 —— 比让客户端猜一个键更稳。
 */
/** 增量帧的最小发送间隔（毫秒）。**冒烟断言钉住这个常量**，改它必须同时改断言。 */
export declare const STREAM_FRAME_MIN_INTERVAL_MS = 60;
/** 一条订阅最多能活多久（毫秒）：客户端开了流但这一回合没生成时的兜底回收。 */
export declare const STREAM_SUBSCRIPTION_TTL_MS = 45000;
/** 单条订阅的缓冲上限（帧数）：溢出丢最旧的非终帧，并计数留痕。 */
export declare const STREAM_BUFFER_MAX_FRAMES = 24;
/** 一帧：`text` 是**已净化前缀**（`prefixSafeClean` 之后），`final` 才可采纳。 */
export interface GhostStreamFrame {
    /** 本次生成对应的已完成回合号（归属校验用）。 */
    readonly turn: number;
    /** 截至本帧的净化文本（终态结果的前缀）。 */
    readonly text: string;
    /** 单次生成内单调递增的帧号（>=1）。 */
    readonly frame: number;
    /** 是否终帧。采纳只认终帧（`accept-guard` 现状即如此）。 */
    readonly final: boolean;
}
/**
 * 会话键 → 一组订阅的内存通道。
 *
 * 多标签页：同一会话可以有 N 条订阅（实测：撤帧是逻辑流粒度，不是 peer 粒度），
 * 所以这里是一个 Set 而不是单值；一条订阅 `dispose` 不影响其他订阅。
 */
export declare class GhostStreamHub {
    /** 会话 id → 该会话当前的订阅集合。 */
    private readonly channels;
    /** 会话 id → 本次生成的回合号（`beginTurn` 写，`publish` 读）。 */
    private readonly turnOf;
    /** 会话 id → 上一帧实际发出的时刻（限频窗口）。 */
    private readonly lastSentAt;
    /** 会话 id → 本次生成内已发出的帧号（单调）。 */
    private readonly seqOf;
    /** 会话 id → 本次生成内**最近一帧**（晚到的订阅靠它立刻补上当前前缀）。 */
    private readonly inFlight;
    /** 累计被丢弃的帧数（溢出），只用于留痕与断言。 */
    private droppedTotal;
    /**
     * 注册一条订阅（客户端开流时由 Remote 方法调用）。
     *
     * @param sessionId - 要监听哪个会话的下一次生成。
     * @param signal - 载体取消信号：客户端 `dispose()` / 断线都会 abort 它，
     *   本实现据此回收订阅（**不留僵尸 sink**，这是 (a) 方案最难处理的一点）。
     * @returns 一个异步可迭代；宿主没有下一次生成时它会一直等到 TTL 或 signal。
     */
    subscribe(sessionId: string, signal: AbortSignal): AsyncIterable<GhostStreamFrame>;
    /**
     * 宿主开始一次生成：给这个会话**盖章回合号**（帧要带 turn，客户端拿它做归属校验）。
     *
     * ⚠️ 它**不再是"有没有人听着"的闸门**。实测教训（#39 第一版就卡在这）：宿主在本地
     * `turn/end` 上立刻开始生成，而客户端要等会话快照过一趟网络才看到
     * `running: true → false` 那个边沿 ⇒ 客户端开流**必然晚于**本方法。若在这里按
     * "此刻无订阅"直接放弃，整条流式路径 100% 不生效（实测 7 轮：批次数恒为 1、
     * 提前量 0ms、宿主侧一条 `stream turn closed` 都没有）。
     * 现在：盖章照盖，**晚到的订阅由 `subscribe` 补发当前前缀**。
     *
     * @param sessionId - 本次生成的会话。
     * @param turn - 本次生成对应的回合号。
     * @returns 盖章时是否已经有人听着（只用于留痕，不参与"要不要发帧"的决策）。
     */
    beginTurn(sessionId: string, turn: number): boolean;
    /**
     * 这个会话此刻有没有订阅。
     *
     * 生成侧的 delta 回调先问这一句再算净化前缀：没人听着的时候**一个字节都不多做**
     * （回归判据「开关关 = 现状一字不变」的另一半；另一半是回调根本不传）。
     *
     * @param sessionId - 会话。
     * @returns 是否有活订阅。
     */
    hasSubscribers(sessionId: string): boolean;
    /**
     * 发一帧增量。**限频在这里**：距上一帧不足 {@link STREAM_FRAME_MIN_INTERVAL_MS}
     * 就跳过（终帧不受限，见 `publishFinal`）。
     *
     * @param sessionId - 会话。
     * @param text - 净化后的前缀文本。
     * @returns 是否真的发出去了（false = 被限频窗口吃掉，或没人听着）。
     */
    publish(sessionId: string, text: string): boolean;
    /**
     * 发终帧：**不受限频窗口约束**（客户端要靠它解锁采纳），发完即关闭订阅。
     *
     * @param sessionId - 会话。
     * @param text - 终态净化文本（与随后 `_push` 里那份同源）。
     * @returns 关闭前存在的订阅数（0 = 这一轮没人听着）。
     */
    publishFinal(sessionId: string, text: string): number;
    /** 当前挂着订阅的会话数（观测与断言用）。 */
    get channelCount(): number;
    /**
     * 本轮**没有可发的终帧**（模型空返回、被过滤、或生成失败）⇒ 直接关掉订阅，不发终帧。
     *
     * 为什么不发"空终帧"：客户端把终帧当"可以采纳"的信号，而权威态是随后那次 `_push`
     * （`suggestion: null` ⇒ 清空幽灵）。发空终帧会让客户端在 `_push` 之前短暂显示
     * "一条空建议且可采纳"，那是凭空造出来的状态。
     *
     * @param sessionId - 会话。
     * @returns 被关闭的订阅数。
     */
    cancelTurn(sessionId: string): number;
    /** 累计因缓冲溢出被丢弃的帧数（观测与断言用）。 */
    get droppedFrames(): number;
    /** 插件卸载：关掉所有订阅，让客户端的迭代立刻结束而不是吊死。 */
    closeAll(): void;
    /** 建订阅：装队列、装 TTL、装 signal 联动。 */
    private createSubscription;
    /** 把一帧写进该会话的每条订阅；溢出丢最旧的非终帧（终帧永远保留）。 */
    private emit;
    /** 有 waiter 就把队首交给它。 */
    private wake;
    /** 订阅的迭代器：读队列，队列空就等，关闭且空就结束。 */
    private iteratorOf;
    /** 关闭一条订阅并从所属通道上摘掉（幂等）。 */
    private close;
}
