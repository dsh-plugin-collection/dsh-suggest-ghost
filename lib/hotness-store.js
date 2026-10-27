/**
 * 热度表持久化：经宿主 `ctx.storageDomain`（dsh-storage-domain）把 HotnessTable
 * 的跨会话频次落到 storage backend（随宿主 json backend 落在 `~/.dsh/storages/`），
 * 重启后恢复，频次信号（打分公式里的 hotFreq）不再从零累积。
 *
 * 设计（与宿主 `dsh-session-projection-cache` 同一模式）：
 *  - 域声明 `suggest_ghost_hotness`，单表 `entries`，一条记录一个去重文本的频次；
 *  - 写路径 fail-soft：写失败只告警，热表照常工作（损失的是重启后的频次）；
 *  - 写合并在内存标脏（HotnessChangeHook），flush 时机：回合结束 + 卸载兜底，
 *    不逐条 user/message 写盘；恢复合并在 domain open 后一次性完成；
 *  - 恢复条目的 lastSeq 取 -∞（seq 是会话内单调号，跨会话不可比——恢复条目
 *    排到最近性最末，真实再次出现时自然被 live seq 推进），只持久化 count。
 *
 * 装配是可选的：宿主未挂 `storageDomain`（如极简 headless 组合）时回调不触发，
 * 热表行为与纯内存版完全一致（与 settings 注入同一防御模式）。
 * @module dsh-suggest-ghost/hotness-store
 */
import { defineDomain, domainTable, } from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';
import { traceAt } from './trace.js';
import { HOT_TABLE_MAX_ENTRIES, HotnessTable } from './hotness.js';
/** 恢复时防御性截断：与 recordUserText 的上限一致，异常大记录直接跳过。 */
const RECORD_TEXT_MAX_CHARS = 2000;
/**
 * 热表恢复流程的**正面留痕**通道（#88）。
 *
 * 为什么走 console 而不是 `ctx.logger`：#88 的诊断里，「日志里没有那行 warn」被当成过
 * 证据两次，而两次都错 —— 单一 exporter 会丢 info/debug，而错误消息里含
 * `dsh-suggest-ghost:` 子串会造成假阳性。⇒ **拿"某字符串没出现"当证据是不可靠的**，
 * 所以这里给恢复流程配上必然出现的正向锚点：缺哪一行，就直接看出卡在哪一步。
 * 前缀与 `ops-trace` 一致 ⇒ 现有的 grep 口径不用改。
 */
const hotnessTraceLine = (message) => {
    // 状态迁移（域开/关、恢复、就绪）比逐事件心跳更重要一档：`=info` 就能看到
    // 「这个 fiber 走到哪一步」，默认仍静默。
    traceAt('info', message);
};
/**
 * **fiber 序号**：每次 `setupHotnessPersistence()` 调用（= 每次 `apply()` 挂载）取一个。
 *
 * 为什么需要：live 日志里 42 行 `apply called` 长得一模一样，而恢复流程的每一行也只写
 * 「domain busy / opened / closed」——**分不清是谁在开、谁在关、谁卡住了**。没有身份就没有
 * 因果：`hotness domain close requested` 到底对应哪一次 `opened`，只能靠猜。这次调查要回答的
 * 正是「持有者到底有没有释放」，所以先把 fiber 身份补上。
 * ⚠️ 计数在**模块顶层**，而 partialReload 会重新求值本模块（实测：每次重载的
 * `artifact mtime=` 都变）⇒ 序号是「每个模块实例内递增」，不是全进程唯一。跨重载配对要靠
 * `mtime` + 序号一起看，别把两段的 `fiber=1` 当成同一个持有者。
 */
let FIBER_SEQ = 0;
/**
 * 域名被前一个句柄占着时 `open()` 会**同步拒绝**（`dsh-storage-domain/lib/index.js:356`
 * 的 `already-open`）。⇒ 被拒是**常态**，不是配置错误 ⇒ 有界重试：等到旧句柄释放。
 *
 * 时序口径已在沙箱重测（2026-10-23，`--watch` + 真改 `lib/index.js` 内容触发 partialReload）：
 * 正常路径上一笔重载的顺序是 `… ready → hotness domain closed → apply called（新 mtime）→
 * opened attempt=1`，也就是**旧 fiber 的 disposer 跑在新 fiber 重试之前**，重载后一次就开上。
 * 旧注释写的「新 fiber 先 apply、旧 fiber 的 dispose 后跑」是更早一次探针的读数，当时
 * `close()` 这侧一个字都不落（本行留痕 `hotness domain closed` 就是补上的那块表），
 * 所以那个先后关系**测不准**，不该继续当依据引用。
 * ⚠️ 这条只证明「无流量的沙箱里 disposer 会跑」，**不**证明 live 进程里那个卡住的持有者
 * 是被同一条路径放开的——live 的 6 次重载 0 次 open 成功，与新加的 `closed` 留痕对一下
 * 才知道差在哪（要么持有者的 disposer 根本没跑，要么它 `await flush()` 挂住了）。
 * 上限见下（不能无限，更不能 tight-loop）。
 */
const HOTNESS_OPEN_RETRY_MS = 150;
const HOTNESS_OPEN_MAX_ATTEMPTS = 40;
/**
 * 「没有持久层会来」的宽限期（#88）。
 *
 * 为什么需要它：`ctx.inject(['storageDomain'])` 在**没挂这个服务的组合**里永远不触发
 * （`payload-split-smoke` 的夹具就是这种，且注释明说「夹具里没有 storageDomain 可恢复热表」）。
 * 若 `pending` 没有出口，那种组合下热度格会被永久扣住 ⇒ 卡片停在空表、盘上那一格再也不更新
 * —— 比原 bug 更糟。⇒ 宽限期内没人来要句柄，就判定 `unavailable`（内存态即权威，格子照常说话）。
 * 用 timer 而不是同步检查：服务可能在插件之后才挂载。
 */
const HOTNESS_RESTORE_GRACE_MS = 5000;
/** 域声明：名字须匹配 UNIT_NAME_RE（小写字母开头的 [a-z0-9_]）。
 * `pinned` 为可选字段（v1 内演进，不 bump 版本——旧介质照常打开）。 */
const hotnessDomainSpec = defineDomain({
    name: 'suggest_ghost_hotness',
    version: 1,
    tables: { entries: domainTable(z.object({
            text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS),
            count: z.number().int().positive(),
            pinned: z.boolean().optional(),
        })) },
});
/**
 * 装配热度表 + 持久化：构造带脏标记回调的热表，并（可选地）经 storageDomain
 * 打开持久域、恢复历史频次、注册卸载兜底。
 * @returns hotness 供 index.ts 消费事件 / 取快照；persistence 供回合结束 flush。
 */
export function setupHotnessPersistence(ctx) {
    // 本 fiber 的留痕通道：每条自动带 `fiber=<序号>`，让「谁开的、谁关的、谁卡住的」可对得上。
    const fiberId = FIBER_SEQ + 1;
    FIBER_SEQ = fiberId;
    const hotnessTrace = (message) => {
        hotnessTraceLine(`fiber=${fiberId} ${message}`);
    };
    /** 脏标记：text → 最新记账值（null = 待删除）。flush 前累积，flush 取快照清空。 */
    const dirty = new Map();
    let entries = null;
    let domain = null;
    /** 恢复合并完成前的脏标记先攒着（否则 live 计数会以「缺历史频次」的值抢先落盘）。 */
    let ready = false;
    /**
     * **是否真的把历史频次灌回来了**（#88 的核心区分）。
     *
     * `ready` 只表示「恢复阶段结束了」——降级（open 失败、无 storageDomain）同样会结束它，
     * 于是 `size === 0` 既可能是「还没恢复」也可能是「用户真的没有热表」，消费方分不出来，
     * 卡片就在热重载后显示「共 0 条」（盘上 2000 条一条没少）。
     * ⇒ `restored` 只在恢复合并真的跑过时为 true；`snapshot()`/`size` 交给消费方之前必须看它。
     */
    let restored = false;
    /**
     * 恢复阶段的状态（#88）—— **三态**，两态不够：
     *  - `pending`：还在等句柄（重试中）⇒ 消费方**不许**把 `snapshot()`/`size` 当权威发出去，
     *    那正是「共 0 条」症状的成因；
     *  - `restored`：历史频次真的灌回来了；
     *  - `unavailable`：环境没有持久层，或重试到上限仍拿不到句柄 ⇒ **内存态就是全部真相**，
     *    此时照常发布才是正确行为（极简 headless 组合下不发热度格会把卡片永久钉在空表）。
     */
    // 默认 **unavailable**：没有人在恢复 ⇒ 内存态就是权威，热度格照常发布（今天的行为）。
    // 只有当注入回调真的拿到 facility、开始要句柄时，才转成 `pending` —— 那一刻起
    // `snapshot()` 的空表才「不代表用户没有热表」。反过来默认 pending 会把
    // 没挂 storageDomain 的组合（极简 headless、以及 `payload-split-smoke` 的夹具）
    // 永久扣住格子，比原 bug 更糟。
    let restoreStatus = 'unavailable';
    /** 是否已经真的向 facility 要过句柄（宽限期判据用）。 */
    let openAttempted = false;
    /** `!ready` 期间脏标记撞到硬上限被清空的次数与条数（那条护栏本来静默丢弃，#88 要求留痕）。 */
    let dirtyCapClears = 0;
    let dirtyCapDropped = 0;
    /** whenReady 的兑现柄：恢复阶段（成功或降级）结束时调用一次。 */
    let settleReady = () => { };
    const whenReady = new Promise((resolve) => {
        settleReady = resolve;
    });
    const onChange = (text, entry) => {
        // 护栏：持久层未就绪（宿主无 storageDomain / open 失败）时脏标记永远不会被
        // flush 消费——超硬上限直接清空，防长驻进程内存泄漏。已就绪后 flush 每回合
        // 都会消费，到不了这个量级。即使 open 稍后成功，恢复合并（restoreEntry 的
        // merge 分支）会重新标记脏值，清空不丢正确性；最多损失 open 前的删除标记
        // （已淘汰条目下次重启多活一轮，有界churn，无害）。
        if (!ready && dirty.size >= HOT_TABLE_MAX_ENTRIES * 2) {
            // 这条护栏把「长期不就绪」变成**静默丢弃累积**（#88）：清空照旧，但必须留痕 + 计数，
            // 否则症状只会以「热表莫名变空」的形式浮出来，查不到丢在哪一步。
            dirtyCapClears += 1;
            dirtyCapDropped += dirty.size;
            hotnessTrace(`hotness dirty cap cleared: n=${dirty.size} limit=${HOT_TABLE_MAX_ENTRIES * 2}`
                + ` clears=${dirtyCapClears} droppedTotal=${dirtyCapDropped}`);
            dirty.clear();
        }
        dirty.set(text, entry);
    };
    const hotness = new HotnessTable(onChange);
    // 兜底：若某个组合里回调拿到了 facility 却卡在别处（永远没走到 open），也别把格子扣死。
    const grace = setTimeout(() => {
        if (restoreStatus === 'pending') {
            restoreStatus = 'unavailable';
            hotnessTrace(`hotness restore grace elapsed ms=${HOTNESS_RESTORE_GRACE_MS} openAttempted=0`
                + ' ⇒ 这组宿主没有持久层可等，内存态即权威，热度格照常发布');
            settleReady();
        }
    }, HOTNESS_RESTORE_GRACE_MS);
    // 不让它把进程/事件循环钉住（冒烟与单测里 context 是手搓的，没有正常的卸载路径）。
    grace.unref?.();
    const flush = async () => {
        const table = entries;
        if (table === null || !ready || dirty.size === 0)
            return;
        const batch = [...dirty];
        dirty.clear();
        const results = await Promise.allSettled(batch.map(([text, entry]) => entry === null
            ? table.delete(text)
            // pinned 仅 true 时落盘（可选字段，与 v1 介质兼容；false 省略）
            : entry.pinned
                ? table.put(text, { text, count: entry.count, pinned: true })
                : table.put(text, { text, count: entry.count })));
        for (const result of results) {
            if (result.status === 'rejected') {
                ctx.logger.warn(`dsh-suggest-ghost: hotness persist write failed: ${String(result.reason)}`);
            }
        }
    };
    const close = async () => {
        // **进入即留痕**：上一行 `closed` 是在 `finally` 里打的，所以「一次都没出现」有两种
        // 完全相反的含义——① disposer 根本没跑（宿主 reload 路径不回收旧 fiber 的 effect，#17
        // 的僵尸同族）；② 跑了但**卡在 `await flush()` / `runClose()` 的写链上**，于是
        // `onClosed()` 里的 `reserved.delete` 永远轮不到 ⇒ 域名被一个"还在关闭中"的句柄永久占住。
        // 现场 live 进程 08:44 那笔重载**只有** ①/② 里的某一种会发生（沙箱里 `closed` 正常打出），
        // 两者修法不同，所以这两行是分叉判据，不是啰嗦。
        hotnessTrace(`hotness domain close requested owned=${domain ? 1 : 0} ready=${ready} status=${restoreStatus}`);
        try {
            await flush();
        }
        finally {
            const closing = domain;
            domain = null;
            entries = null;
            ready = false;
            try {
                await closing?.close(); // 排空已在域写链上的写入；幂等
            }
            catch (error) {
                ctx.logger.warn(`dsh-suggest-ghost: hotness domain close failed: ${String(error)}`);
            }
            // **这行是 #88 的续查工具，不是装饰**：现场 6 次热重载里 `hotness domain opened`
            // 出现 **0** 次、`restore FAILED` 10 次、`domain busy` 重试 28 次 —— 也就是新 fiber
            // 重试满 40×150ms≈6s 也没拿到域名。三种可能只靠那侧的留痕**分不开**：
            //  (i) 旧 fiber 的 `ctx.effect` disposer 在 partialReload 路径上根本不跑（与 #17 的
            //      僵尸 root 监听同族）；
            //  (ii) 跑了但没释放名字（`dsh-storage-domain` 的 `onClosed` 挂钩失效）；
            //  (iii) 跑了但跑得比 6s 预算晚。
            // 宿主侧 `close()` **确实**会把名字从 `reserved` 里摘掉（`dsh-storage-domain/lib/index.js:385-386`
            // 构造 Domain 时传 `onClosed = () => { domains.delete; reserved.delete }`），所以 (ii)
            // 的先验最低——但没有这行留痕，先验就不是证据。
            hotnessTrace(`hotness domain closed released=${closing ? 1 : 0} size=${hotness.size} status=${restoreStatus}`);
        }
    };
    ctx.inject(['storageDomain'], (sctx) => {
        void (async () => {
            try {
                // 注入回调的 ctx 类型来自 dsh-storage-domain 的 Context augmentation；
                // 与 settings 注入一致地防御式取用，未挂载则静默降级为纯内存。
                const facility = sctx.storageDomain;
                // 服务在但域不可用：同样是「不会再被异步改写」的终局，兑现信号。
                if (facility === undefined) {
                    // 没有持久层：内存态即权威。但必须说一声，且 `restored` 保持 false ——
                    // 消费方要能把「环境没持久层」与「重载竞态没等到释放」分开呈现。
                    hotnessTrace('hotness domain unavailable: no storageDomain facility');
                    restoreStatus = 'unavailable';
                    settleReady();
                    return;
                }
                // ⚠️ #88：同名域是**独占**的（`dsh-storage-domain/lib/index.js:356` 抛 `already-open`），
                // 热重载期间被拒是**常态**，不是配置错误 ⇒ 有界重试：每 150ms 一次，最多 40 次（≈6s）。
                // 原实现一把抓住就降级为纯内存，于是 `ready=true` 而 `size=0`，与「用户真的没有热表」
                // 完全同形（卡片「共 0 条」就是这么来的）。
                // ⚠️ 时序口径已在沙箱重测（见本文件顶部 `HOTNESS_OPEN_RETRY_MS` 上方那段）：干净重载里
                // 旧 fiber 的 `close()` 跑在**新 fiber 重试之前**，一次就 open 上；旧注释引用的
                // 「新 apply 先、旧 dispose 后」当时 `close()` 那侧没有任何留痕，测不准，别再当依据。
                // 为什么必须**有界**且每轮都 await 一个 timer：本仓被「失败→立刻重试」的微任务紧循环
                // 烧过 23 GB 日志（`scripts/hmr-write-loop-smoke.mjs` 就是那次的事后护栏）。
                openAttempted = true;
                clearTimeout(grace);
                // 从这里开始才叫「恢复在飞行中」：此时表里还没有历史频次，发出去就是盖掉用户的数据。
                restoreStatus = 'pending';
                let opened = null;
                let attempt = 0;
                for (;;) {
                    attempt += 1;
                    try {
                        opened = await facility.open(hotnessDomainSpec);
                        break;
                    }
                    catch (error) {
                        const reason = String(error?.message ?? error).slice(0, 60);
                        if (attempt >= HOTNESS_OPEN_MAX_ATTEMPTS)
                            throw new Error(`open rejected after ${attempt} attempts: ${reason}`);
                        if (attempt === 1 || attempt % 10 === 0) {
                            hotnessTrace(`hotness domain busy, retrying attempt=${attempt} reason=${reason}`);
                        }
                        await new Promise((r) => setTimeout(r, HOTNESS_OPEN_RETRY_MS));
                    }
                }
                hotnessTrace(`hotness domain opened attempt=${attempt}`);
                // ⚠️ **顺序就是修复本体**（2026-10-23 现场：42 次 `apply called`、`opened` 0 次、
                // `close requested` / `closed` 也 0 次。⚠️ 那个持有者产生于这两行留痕装上**之前**，
                // 所以「它没注册钩子」与「注册了但 disposer 没跑」已经无法区分；本仓能确定的只有
                // 「这段顺序确实留了一个『拿到名字却没挂钩子』的窗口，一旦被踩就是永久占用」。
                // 沙箱对照证明 disposer 本身正常：一笔干净重载是
                // `ready → closed released=1 → apply(新 mtime) → opened attempt=1`）。
                // 旧写法在 `open()` 成功之后才读表、解析、合并，**最后**才 `ctx.effect(...)`；而
                // `open()` 一返回名字就归本 fiber 所有 ⇒ 从那一刻到注册钩子之间任何一步抛
                // （`opened.table()`、record 解析、`restoreEntry`）都会被外层 catch 接住、降级成
                // 「staying in-memory」，域名于是被一个无人认领的句柄**永久占住**——与 live 现象一致。
                // ⇒ 先认领、先挂释放钩子，再做任何可能抛的事。**其余判据一字未动**：状态机
                // （`pending`/`restored`/`unavailable`）、发布口径、`ready` 时机全部保持原样，
                // 这条修复只改「谁在什么时候负责 close」。
                domain = opened;
                // 卸载兜底挂在注入派生 fiber 上：storageDomain 卸载或插件卸载都会触发。
                // 带名字注册：cordis 的 effect 名会出现在诊断面上，测试也据此**只挑自己那一个**
                // （同一个 root 上还有 `ctx.plugin()` 之类的别人家的钩子，一起跑会把 fiber 也拆了）。
                ctx.effect(() => () => void close(), 'hotness domain close');
                const table = opened.table('entries');
                // 恢复：count 降序截断到容量上限（防御历史超限 / 未来上限调小），合并进活表。
                const records = [...table.entries()]
                    .map(([, record]) => record)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, HOT_TABLE_MAX_ENTRIES);
                for (const record of records)
                    hotness.restoreEntry(record.text, record.count, record.pinned === true);
                entries = table;
                // 恢复条数必须打出来：#88 的「共 0 条」到底是没恢复、还是恢复了却被当空发出去，靠这行分。
                hotnessTrace(`hotness restored n=${records.length} tableSize=${hotness.size}`);
                restored = true;
                restoreStatus = 'restored';
                ready = true;
                hotnessTrace(`hotness ready dirty=${dirty.size} restored=${restored}`);
                void flush(); // 补写 open 窗口期累积的 live 记账与恢复合并值
                settleReady(); // 恢复合并已完成：消费方（index.ts）据此补推完整快照
            }
            catch (error) {
                // 重试也没拿到句柄 ⇒ 仍然降级，但留一行正面痕：这是 #88 里唯一能把「放弃」与
                // 「根本没持久层」「恢复成功」三者分开的锚点。
                hotnessTrace(`hotness restore FAILED, staying in-memory: ${String(error?.message ?? error).slice(0, 90)}`);
                restoreStatus = 'unavailable'; // 放弃之后内存态即权威，格子要照常说话
                ctx.logger.warn(`dsh-suggest-ghost: hotness persistence unavailable, staying in-memory: ${String(error)}`);
                settleReady(); // 降级同样终结恢复阶段：内存态即权威，消费方无需再等
            }
        })();
    });
    return {
        hotness,
        persistence: {
            get ready() {
                return ready;
            },
            // #88：这两个是消费方唯一能区分「还没恢复」与「真的空」的口子。
            get restored() {
                return restored;
            },
            get status() {
                return restoreStatus;
            },
            get dirtyCapCleared() {
                return { clears: dirtyCapClears, dropped: dirtyCapDropped };
            },
            whenReady,
            flush,
            close,
            applyOps(ops) {
                let changed = 0;
                for (const op of ops) {
                    switch (op.op) {
                        case 'delete':
                            if (hotness.deleteEntry(op.text))
                                changed += 1;
                            break;
                        case 'pin':
                            if (hotness.setPinned(op.text, op.pinned === true))
                                changed += 1;
                            break;
                        case 'add':
                            if (hotness.addEntry(op.text, op.pinned === true))
                                changed += 1;
                            break;
                        case 'clear':
                            changed += hotness.clearAll();
                            break;
                        default:
                            break; // 未知操作忽略（前后版本协议差异下保持宽容）
                    }
                }
                return changed;
            },
        },
    };
}
/** `_ops` 载荷的单条操作校验 schema（与 HotnessOp 对齐；非法载荷整体拒绝）。 */
const opsPayloadSchema = z.object({
    rev: z.number(),
    ops: z.array(z.discriminatedUnion('op', [
        z.object({ op: z.literal('delete'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS) }),
        z.object({ op: z.literal('pin'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean() }),
        z.object({ op: z.literal('add'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean().optional() }),
        z.object({ op: z.literal('clear') }),
        z.object({ op: z.literal('pull'), sessionId: z.string().min(1) }),
        z.object({ op: z.literal('complete'), sessionId: z.string().min(1), draft: z.string().min(1) }),
    ])),
    /** client UI 语言（'zh' | 'en'）；可选，捎带在每次 _ops 写入中。 */
    locale: z.string().optional(),
});
/**
 * 从 `opsPayloadSchema` **现推导**「schema 这一侧认得哪些 op 变体、各自要求哪些字段」。
 *
 * 存在的唯一理由：#17 是「`domain.ts` 的 TS 类型有 `complete`、schema 没有」这种
 * 两份真相互不约束的漂移，而编译器不会报错。漂移断言（`scripts/ops-schema-coverage-smoke.mjs`）
 * 要拿这一侧的清单去和 TS 那一侧比，所以这份清单**必须**从真正在跑的 schema 推导，
 * 不能手抄——手抄的名单自己就会变成第三份会漂移的真相。
 *
 * 推导失败（zod 换大版本、`discriminatedUnion` 内部形状变了）时**直接抛**：
 * 静默返回空数组会让漂移断言「全都对」，那比没有断言更坏。
 */
export function hotnessSchemaVariants() {
    const opsNode = opsPayloadSchema.shape.ops;
    const options = opsNode?.element?.options;
    if (!Array.isArray(options)) {
        throw new Error('dsh-suggest-ghost: cannot introspect opsPayloadSchema (zod internal shape changed?)');
    }
    return options.map((option) => {
        const shape = option.shape;
        if (shape === undefined) {
            throw new Error('dsh-suggest-ghost: opsPayloadSchema option has no .shape (zod internal shape changed?)');
        }
        // zod v4：`z.literal('x')` 的判别值在公开访问器 `.value` 上，内部 `def.values` 是数组。
        // 两种都认，是为了让这个「推导」本身不因 zod 小版本换内部形状而静默给出错的名单。
        const opNode = shape.op;
        const kind = opNode?.def?.type;
        const op = kind === 'literal'
            ? (typeof opNode?.value === 'string' ? opNode.value : opNode?.def?.values?.[0])
            : undefined;
        if (typeof op !== 'string') {
            throw new Error('dsh-suggest-ghost: opsPayloadSchema option has no literal `op` discriminator');
        }
        const required = [];
        const optional = [];
        for (const [key, child] of Object.entries(shape)) {
            if (key === 'op')
                continue;
            const kind = child.def?.type;
            if (kind === 'optional' || kind === 'default')
                optional.push(key);
            else
                required.push(key);
        }
        return { op, required, optional };
    });
}
/** 日志摘要里保留的 zod issues 条数上限（再多也没法看）。 */
const ISSUE_SUMMARY_MAX = 4;
/** 把 zod issues 收成一行摘要：`path:code(message)`。 */
function summarizeIssues(issues) {
    return issues
        .slice(0, ISSUE_SUMMARY_MAX)
        .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.code} (${issue.message})`)
        .join('; ')
        + (issues.length > ISSUE_SUMMARY_MAX ? `; …${issues.length - ISSUE_SUMMARY_MAX} more` : '');
}
/** 截断成单行日志片段（压掉换行，避免多行载荷污染日志）。 */
function headOf(raw, limit) {
    const flat = raw.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
/**
 * 解析 client 写入 `_ops` 的 JSON 载荷：非法/空载荷返回空结果（调用方据此
 * 跳过消费）。上限防御：单批操作数最多 1000（防畸形巨载荷拖住写链）。
 *
 * **三条返回空 ops 的路径语义不同，留痕也不同**（Gitea #17 的教训：载荷被整批
 * 拒了却毫无线索）：
 *  1. 空载荷（`undefined` / `''` / `'null'`）：**正常态**，不是丢弃。host 每次消费
 *     完都把 `_ops` 写回空值，`document-updated` 必然再读到它，所以这里不打日志
 *     （打了就是每次推送一条噪声）。
 *  2. JSON 解析失败 → `rejected.kind = 'json'`，必须留痕。
 *  3. zod 拒绝 → `rejected.kind = 'schema'`，必须留痕并带 issues 摘要（整批丢弃的
 *     原因只有 issues 能说清）。
 * 2/3 由调用方（`index.ts` 的 `consumeOps`）经 `ctx.logger.warn` 打印——不用
 * console.log：main 的 `6dfcd78`（chore: remove all debug console.log statements）
 * 正是把 console 当调试噪声清掉的那次；走 logger 的留痕不会被下一轮清理顺手删。
 */
export function parseHotnessOps(raw) {
    if (typeof raw !== 'string' || raw === '' || raw === EMPTY_OPS)
        return { ops: [] };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return {
            ops: [],
            rejected: {
                kind: 'json',
                summary: `JSON.parse failed: ${String(error instanceof Error ? error.message : error)}; head=${headOf(raw, 120)}`,
                bytes: raw.length,
            },
        };
    }
    const result = opsPayloadSchema.safeParse(parsed);
    if (!result.success) {
        // 静默丢弃会让「客户端写了、宿主没动」彻底不可诊断——必须留痕（见上面第 3 条）。
        return {
            ops: [],
            rejected: {
                kind: 'schema',
                summary: `opsPayloadSchema rejected the batch: ${summarizeIssues(result.error.issues)}`,
                bytes: raw.length,
            },
        };
    }
    return {
        ops: result.data.ops.slice(0, 1000),
        locale: result.data.locale,
    };
}
/** `_ops` 的空载荷（JSON 字符串的 null 表示；与 settings.EMPTY_PUSH 同值）。 */
const EMPTY_OPS = 'null';
