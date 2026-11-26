/**
 * 「别再给我补这句」——**忽略表**（forget list）的纯逻辑，零 DOM、零 IO。
 *
 * ## 为什么它不能只是「删掉热表那一行」（本单的第一性判据）
 *
 * 用户看到幽灵时想「这句话以后别出现了」，而屏幕上那句幽灵**几乎不是从热表来的**：
 * 它是 client 用 host 推下来的**会话历史环**（`historyRings`，从会话日志物化）当场算的。
 * 实测（PR 描述里有原始输出）：热表里把该文本删干净之后，
 * `historySuggestion([…, R, …], '帮我', { hotCounts: <无 R> })` **仍然返回 R**
 * ⇒「删热表条目」与「这句话不再被补全」是两件事。
 *
 * 所以本表是**独立于热表、独立于历史环**的第三份状态，判定点必须同时覆盖：
 *  1. 候选构造（会话环与跨会话候选，同一入口）；
 *  2. 热度记账（`HotnessTable.recordUserText`）——否则用户**再打一次这句它就复活**。
 *     实测：同会话隔一句再打、或换会话再打，删掉的条目都会以 `×1` 回来。
 *
 * ## 为什么按归一化文本比对，而热表按原文
 *
 * 两张表要回答的问题不同：
 *  - 热表问「这条原文出现过几次」（原文即身份，展示也要用原文）；
 *  - 忽略表问「用户说不想要的是不是**这一句**」——大小写、全半角、空白折叠都不该
 *    让它躲过去（用户按下的是一次「别再给我这句」，不是一次「别再给我这个字节序列」）。
 * 归一化复用 `text-match.ts` 的那一份，不另建第二把尺子。
 *
 * ## 容量
 *
 * 与热表同量级的有界淘汰（{@link FORGET_MAX_ENTRIES}）：忽略表是否定语义，无界增长会让
 * 可用候选池随使用单调变小，而用户完全没有感知。淘汰按**插入序**（FIFO），不按最近性：
 * 忽略表高频命中恰恰说明**不该**淘汰它；配合设置页的「恢复」入口，代价有界且可逆。
 *
 * @module dsh-suggest-ghost/forget
 */
/** 忽略表条目上限（与 `HOT_TABLE_MAX_ENTRIES` 同量级：都是「用户数据的有界缓存」）。 */
export declare const FORGET_MAX_ENTRIES = 2000;
/** 单条文本上限：与热表一致，超过视为系统注入/超大粘贴。 */
export declare const FORGET_TEXT_MAX_CHARS = 2000;
/**
 * 这条文本是否被忽略（归一化后比对）。
 *
 * 空串恒 `false`：空文本从来不是可补全候选，判它只是噪声。
 */
export declare function isForgotten(ignored: ReadonlySet<string> | null | undefined, text: string): boolean;
/** 忽略表的一条（设置页「已忽略」列表渲染用）。 */
export interface ForgottenEntry {
    /** 归一化键（稳定标识，恢复时用它）。 */
    readonly norm: string;
    /** 最近一次被忽略时的**原文**（展示用；归一化会改大小写与全半角，展示必须还原）。 */
    readonly text: string;
}
/**
 * 忽略表的可变状态（host 端唯一一份：纯内存 + 由 `hotness-store` 落盘）。
 *
 * 只有「加」与「删」两个动作，判据都在上面的纯函数里 —— 本类不重复判定，
 * 它只负责「原文 ↔ 归一化键」的映射与容量淘汰。这点很重要：这里再实现一遍
 * 「什么算被忽略」，就会立刻出现第三把尺子。
 *
 * ⚠️ {@link asSet} 返回的是**同一个可变对象**（内部 `norms` 原地增删）：
 * 调用方（每按键一次的候选过滤）不该为此每帧新建一个 `Set`。
 */
export declare class ForgetTable {
    /** 归一化键集合（与 `texts` 同键，原地维护）。 */
    private readonly norms;
    /** 归一化键 -> 原文（插入序即 FIFO 淘汰序，`Map` 迭代序保证这一点）。 */
    private readonly texts;
    /**
     * 条目变更回调（`entry === null` = 删除 / 淘汰），供持久层同步。
     *
     * ⚠️ 写成**显式字段赋值**而不是构造函数参数属性（`constructor(private readonly onChange?: …)`）：
     * 本文件被 `scripts/forget-smoke.mjs` 用 `--experimental-strip-types` 直接加载，而
     * Node 的 strip-only 模式**不支持参数属性**，会以 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
     * 当场拒绝加载（本文件第一版就是这么写的，实测过）。这是本仓「独立模块必须能被
     * 冒烟直载」的既有约束，见 `src/client/keyspec.ts` 头部那条。
     */
    private readonly onChange;
    constructor(onChange?: (entry: ForgottenEntry | null, norm: string) => void);
    /** 条目数。 */
    get size(): number;
    /**
     * 记一条「别再补这句」。
     *
     * @returns `true` = 状态真的变了（新插入或原文刷新）；`false` = 幂等命中或不合格输入。
     *   幂等返回 `false` 是刻意的：`consumeOps` 靠它算 `changed` 以决定要不要回推客户端，
     *   「重复按同一个键」不该产生一次整档重写。
     */
    add(text: string): boolean;
    /**
     * 恢复一条（用户点设置页的「恢复」）。
     *
     * @param normOrText - 归一化键（`ForgottenEntry.norm`），也接受原文（内部归一化一次）。
     * @returns `true` = 真的删掉了；`false` = 本来就不在里面（幂等）。
     */
    remove(normOrText: string): boolean;
    /** 清空（设置页「全部恢复」）。@returns 清掉的条数。 */
    clearAll(): number;
    /** 恢复持久层记录（启动回放）：不触发 `onChange`（数据来自持久层，回写纯浪费）。 */
    restoreEntry(text: string, norm?: string): void;
    /** 是否被忽略（转发 {@link isForgotten}，判据只有一份）。 */
    has(text: string): boolean;
    /** 给 `historySuggestion` / `HotnessTable` / 推送载荷用的只读集合（**同一对象**，见类注释）。 */
    asSet(): ReadonlySet<string>;
    /** 快照（设置页列表；`limit<=0` 不限）。顺序 = 插入序（最早的在前，与 FIFO 淘汰一致）。 */
    snapshot(limit?: number): readonly ForgottenEntry[];
}
