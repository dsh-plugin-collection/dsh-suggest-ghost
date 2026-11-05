/**
 * 文本比较的**唯一**归一化实现。
 *
 * ## 为什么必须有且只有一份
 *
 * 「这两条文本算不算同一条」这件事现在有**两个**读者，它们在两个不同的运行时里：
 *
 *  - **客户端**的历史前缀补全：草稿与历史条目比较前先归一化
 *    （`src/client/history.ts`，逐次按键都会跑，所以它自带缓存）；
 *  - **宿主**的重出判同：`regen` 产出的那条与「本回合已产出/已被拒的」那几条比，
 *    内容相同就丢弃并留痕 `regen-duplicate`（`src/index.ts` 的 `handleRegen`）。
 *
 * 两份实现的后果不是「重复代码」这么轻，是**判同口径分叉**，而且分叉在界面上长成
 * 最难查的那一族：宿主那份少折叠一次空白，用户就会看见一条「只差一个空格」的重出
 * 真的换了上去（客户端认定它没变）；宿主那份多做一次小写化，模型换一种大小写就被
 * 误判成复读而丢弃（用户看见「按了没反应」）。⇒ 这里钉的是**一条实现、两个引用**，
 * 由 `scripts/regen-smoke.mjs` 断言「全仓只有这一份归一化实现」。
 *
 * ## 说明符的坑（改引用方之前先读）
 *
 * 客户端侧的引用者（`src/client/history.ts`）必须写 `'../text-match.ts'`——**带 `.ts`**，
 * 不是宿主侧惯例的 `.js`：本仓有 8 条离线冒烟用 `--experimental-strip-types` 按 TS 源码
 * 直载 `history.ts`，而 Node 的 type-stripping **不做 `.js → .ts` 回退解析**（实测
 * `ERR_MODULE_NOT_FOUND`）。先例是 `src/client/accept-guard.ts` 的 `'./history.ts'`；
 * 白名单钉在 `scripts/client-import-surface-smoke.mjs`。代价是客户端诊断面多一条
 * `TS5097`（7 → 8），那是**授权的变化**：宁可多一条口径产物，也不留第二份实现。
 *
 * ## 依赖
 *
 * 零 import、零 DOM、零 I/O ⇒ 宿主图与客户端图都能引，离线冒烟能直载。
 *
 * @module dsh-suggest-ghost/text-match
 */
/**
 * 归一化缓存的容量上限。
 *
 * **必须有上限**：这个函数以前只在客户端跑，而客户端每次 settings 变更都
 * `clearNormalizeCache()` 把它清干净。现在宿主也调它（每回合至多 3 次判同比对），
 * 而宿主侧**没有**那个清理时机——一个长期运行的 headless 进程里，缓存会随会话里
 * 出现过的文本条数单调增长。取 4096 的理由不是「够用」，是它把上界钉成常数：
 * 到点整体丢弃（而不是丢弃一半——那会让「缓存」变成一份会自己漂的 LRU，
 * 而这里没人需要 LRU 的命中率，只需要它别吃内存）。
 */
const NORMALIZE_CACHE_MAX = 4096;
/**
 * 归一化缓存：同一文本只跑一次 5 条正则。
 * 由调用方在 settings 变更时通过 {@link clearNormalizeCache} 清空，
 * 避免跨推送的旧条目泄漏内存；{@link NORMALIZE_CACHE_MAX} 是无上限时的兜底。
 */
const normalizeCache = new Map();
/** 清空归一化缓存（settings 变更时调用）。 */
export function clearNormalizeCache() {
    normalizeCache.clear();
}
/**
 * 归一化本体：全角 ASCII（U+FF01–U+FF5E，含 ，？！等）→ 半角、表意空格 →
 * 空格、小写化、连续空白折叠、去首尾。**只用于比较与打分，不改动展示文本。**
 *
 * 这五行正则是判同口径的**全部内容**。改它就等于改判同，两个运行时同时受影响，
 * 而 `scripts/regen-smoke.mjs` 的归一化向量表会当场红——这是刻意的：本函数是
 * 客户端补全命中率的回归基线，不该被顺手改。
 */
function normalizeCore(text) {
    return text
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
/** 匹配用归一化（带缓存的那一层；缓存是性能面，不是判据）。 */
export function normalizeForMatch(text) {
    const cached = normalizeCache.get(text);
    if (cached !== undefined)
        return cached;
    const result = normalizeCore(text);
    if (normalizeCache.size >= NORMALIZE_CACHE_MAX)
        normalizeCache.clear();
    normalizeCache.set(text, result);
    return result;
}
/**
 * 两条文本按判同口径是否等价——认的是**内容**，不是回合归属。
 *
 * 「内容而不是归属」这一句是判据，不是修辞。宿主侧的推送判据（`pushSigOf`）里
 * 建议段是 `turn:text:truncated:acceptKey`：**`rev` 与 `baseSeq` 都不进指纹**。
 * 于是「只换 rev」与「只换 baseSeq」的重出在这条通道上都是**零外部效果**
 * （一次写都不发），界面就是「按了没反应」。判同若把归属字段算进去，就会出现
 * 「宿主以为换了、客户端一个字节都没收到」的错位；只认文本才与写面口径一致。
 *
 * 空串走**字面全等**这一支不是兜底，是判据的一部分：归一化把 `''` 与 `'   '` 折成
 * 同一个值，而两侧对「空」的含义完全不同（空 = 槽里没有可比对的正文）。
 * 空串在两个运行时里都只该与自己相等。
 */
export function isSameText(a, b) {
    if (a.length === 0 || b.length === 0)
        return a === b;
    return normalizeForMatch(a) === normalizeForMatch(b);
}
/**
 * 32 位摘要（FNV-1a，按 UTF-16 码元），`regen` 载荷里 `shownHash` 的算法。
 *
 * **为什么是摘要而不是正文**：`_ops` 会落进 profile 文档，而「消费后清空 `_ops`」在
 * 事件回调里历史上 373 次里 372 次被 `HMR transactions cannot be nested` 拒（现场记录
 * `src/index.ts`）⇒ 载荷长期留盘。把被拒的模型产出抄进这条通道，等于新增一类长期
 * 留在 profile 里的生成内容。宿主的内存里本来就有本会话那条建议（`suggestionBySession`，
 * 有界 16 会话）⇒ 摘要对齐就够，对不上走盲重出并留痕 `regen-no-basis`。
 *
 * **为什么不引 `node:crypto`**：这个函数必须在两个运行时里**逐字同值**（客户端算一个、
 * 宿主算一个，然后比）。`crypto` 在浏览器侧不存在，要么引 polyfill 要么在客户端另写一份
 * ——两种都把它变成两份真相。纯整数运算没有这个风险：同一段源码在 V8 的两侧算出同一个数。
 * 冒烟钉了一组**黄金向量**（固定输入 → 固定摘要），换算法当场红。
 *
 * 它**不是**安全原语，也不承担去重职责；唯一用途是「客户端看见的那条，是不是宿主内存里
 * 这一条」。32 位空间在「同一会话相邻几条建议」的量级上碰撞概率可忽略（生日界要百万级
 * 条目才到 1%，这里每会话上限 16 条）。
 */
export function hashText32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
