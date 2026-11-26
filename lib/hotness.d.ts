/**
 * 跨会话历史热度表：增量统计所有会话 `user/message` 的去重文本频次。
 * host 端全局一份，供历史补全打分取 top-K 快照（经 settings `_push` 送达 client）。
 * 纯内存、无持久化；重启后从零累积。条目数有上限（最久未用者淘汰），长驻内存有界。
 *
 * 淘汰用 lazy-deletion 最小堆（按 lastSeq）：新条目入堆，条目 lastSeq 更新时
 * 旧堆项自然过期，evict 时从堆顶跳过过期项——O(log n) 淘汰，替代全表线性扫描。
 *
 * 持久化（可选）：构造时传入 {@link HotnessChangeHook}，表在每次记账/淘汰时
 * 上报变更，由 `hotness-store` 合并落盘；重启后经 {@link restoreEntry} 恢复频次。
 * @module dsh-suggest-ghost/hotness
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SuggestGhostHotEntry } from './domain.js';
/** 单条候选文本最大长度：超过视为系统注入/超大粘贴，不进热表。 */
export declare const HOT_TEXT_MAX_CHARS = 2000;
/** 热表条目数上限：超过后淘汰最近性最差的条目，防止长驻进程内存无限增长。
 * 取 2000 与设置页「最大历史条目」可配置的上限对齐（避免用户配大值被静默砍半）。 */
export declare const HOT_TABLE_MAX_ENTRIES = 2000;
/**
 * 热度变更回调（持久化的脏标记来源）：entry 非空为记账/频次更新（携带最新
 * 记账值），null 为淘汰删除。恢复路径（restoreEntry 的插入）不上报——数据本
 * 就来自持久层，回写是纯浪费。
 */
export type HotnessChangeHook = (text: string, entry: Readonly<{
    count: number;
    lastSeq: number;
    pinned: boolean;
}> | null) => void;
/** 单条热度管理操作（管理面板经 `_ops` 反向通道送达 host）；定义在 domain.ts（client 共享）。 */
export type { HotnessOp } from './domain.js';
/** 跨会话频次与最近性都保留（按 count 降序、lastSeq 降序取 top-K）。 */
export declare class HotnessTable {
    private readonly table;
    /** 每个会话最近一条已入表文本（trim 后）：同会话相邻重复不再计入频次。 */
    private readonly lastTextBySession;
    /** 按 lastSeq 的最小堆：evict 时取最近性最差的条目（lazy-deletion）。 */
    private heap;
    /** 变更回调（持久化脏标记来源）；缺省为纯内存用法。 */
    private readonly onChange;
    /**
     * 「这条文本是否被忽略」的**判定钩子**（缺省 = 没有忽略表）。
     *
     * **为什么闸必须开在记账这一侧**（本单的核心判据）：删掉热表条目之后，
     * 用户只要**再打一次那句话**，`recordUserText` 就会把它以 `×1` 重新收进表里
     * （实测：同会话隔一句、或换个会话，都是 `×1` 回来）。于是「删掉」变成一个
     * 只在下次输入前有效的临时状态，而用户的理解是永久的。
     * 这一侧不设闸，另外两处（候选过滤、热表删除）都会在下一次输入后失效。
     *
     * 传**钩子**而不是构造时拷一份快照：忽略表在进程内可变，快照会让「刚按下的忽略」
     * 在下一句输入前不生效 —— 而那个窗口正好是最容易被观察到的（删完立刻再打一次）。
     *
     * ⚠️ 形状是**谓词**而不是 `ReadonlySet<string>`：判据本体（含归一化比对）住在
     * `forget.ts`，本文件是宿主编译单元（`tsconfig.json` 的 NodeNext 只认 `.js`
     * 说明符），而 `forget.ts` 依赖 `text-match.js`。若这里 `import` 它，那么
     * `scripts/hotness-consume-smoke.mjs` / `hotness-persist-smoke.mjs` 这类
     * **用 `--experimental-strip-types` 直载 `src/hotness.ts`** 的冒烟会当场
     * `ERR_MODULE_NOT_FOUND`（Node 的 strip-only 模式不做 `.js → .ts` 回退，本仓
     * 已在 `src/client/history.ts` 上踩过同一条）。注入谓词让本文件继续保持**零宿主依赖**，
     * 而「什么算被忽略」仍然只有 `forget.ts` 一份实现。
     */
    private readonly isIgnored;
    constructor(onChange?: HotnessChangeHook, isIgnored?: (text: string) => boolean);
    /**
     * 记账一次出现：同一会话内与上一条相邻重复的文本不再累计频次
     * （同一时刻重发 / 回放重复派发不应虚增热度）；跨会话的再次出现正常累计。
     *
     * ⚠️ **忽略表命中时直接不计账**（见 `ignored` 字段的注释）：这条闸是「删掉之后
     * 不会再复活」的唯一保证。位置在**去重判据之后、写表之前**——
     *   - 放在去重之前：`lastTextBySession` 不会更新 ⇒ 同一通话再说一次仍会被视作
     *     「没说过」，与真实语义相反；
     *   - 放在写表之后：已经 `set` 进去了，只能再删一次，等于每次都要多一次变更上报。
     * 现在这个位置让「相邻去重」保持原样、被忽略的文本连一次 `onChange` 都不产生。
     */
    recordUserText(text: string, seq: number, sessionId?: string): void;
    /**
     * 恢复一条持久化条目（重启后由 `hotness-store` 回放持久层记录时调用）：
     *  - 表内尚无该文本 → 以恢复频次插入；lastSeq 取 -∞（「比任何活事件都旧」）：
     *    seq 是会话内单调号，跨会话本就不可比；恢复条目排到最近性最末，
     *    下一次真实出现（live seq > -∞）自然把 lastSeq 推进到正常轨道。
     *  - 表内已有（open 异步窗口内 live 事件先到）→ 频次合并（live + 持久），
     *    lastSeq 保持 live 值，并上报变更（合并值待落盘）。
     * 插入不触发 onChange（数据来自持久层，回写纯浪费）；容量溢出走常规淘汰。
     */
    restoreEntry(text: string, count: number, pinned?: boolean): void;
    /**
     * 管理操作：设置固定标记。仅固定状态变化时上报变更并返回 true；
     * 文本不在表内为 no-op（固定的对象必须是已存在的热度条目）。
     */
    setPinned(text: string, pinned: boolean): boolean;
    /** 管理操作：删除条目（含持久层经 onChange(null) 同步）。文本不在表内为 no-op。 */
    deleteEntry(text: string): boolean;
    /**
     * 管理操作：手工新增一条候选。表内已有该文本时只按需补固定标记（频次
     * 不虚增——它统计的是真实输入）；新条目 count=1、lastSeq=-∞（排到最近性
     * 最末，真实再出现时被 live seq 推进），命中常规容量淘汰。
     */
    addEntry(text: string, pinned?: boolean): boolean;
    /** 管理操作：清空全表（持久层经 onChange(null) 同步删除）。返回删除条数。 */
    clearAll(): number;
    /**
     * 淘汰优先级最高的条目（堆顶 = (seq, count) 最小）：
     *  - `seq` 最小 → 最久未出现的条目先走
     *  - 同 `seq`（如恢复条目全为 -∞）→ 低 `count` 先走
     * 固定条目豁免。
     */
    private evictLeastRecent;
    /** 重建堆，只保留与表内当前 lastSeq 一致的有效版本（O(表大小)）。 */
    private compactHeap;
    /** 消费一条会话事件（仅处理真实用户发出的 user/message）；其余事件为空操作。
     * @param sessionId - 当前会话 id；传入以启用「同会话相邻去重」。 */
    consume(event: SessionEvent, sessionId?: string): void;
    /**
     * 取 top-K（固定条目恒置顶，其余按频次降序、最近优先；K<=0 表示不限）。
     * 固定条目不计入排序竞争——管理面板与跨会话候选都保证先看到它们。
     */
    snapshot(limit: number): readonly SuggestGhostHotEntry[];
    /** 当前跟踪的去重会话数（即不同用户消息数）。 */
    get size(): number;
}
