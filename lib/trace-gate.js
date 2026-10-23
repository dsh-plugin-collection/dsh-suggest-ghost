/**
 * 宿主侧「同一件事的重复留痕」闸门（纯函数，可被 smoke 直接驱动）。
 *
 * 与客户端 `src/client/inline-arm-policy.ts` 的 `stepReasonGate` / `stepSlotEmit` 是
 * 同一族的东西，只是那边管「渲染风暴期不要每帧打一行」，这边管「同一条消息被连着
 * 送上来时不要每条打一行」。形状也一致：**判据不在日志调用点上，在这里**，调用点只
 * 决定「拿什么当 key」。
 *
 * 为什么要有这个文件（2026-10-23 live 统计）：`~/.dsh/dsh-web.log` 665 行里本插件占约
 * 600 行，其中**单条形态**最大的一支是 `ops consumed: pull …` —— 229 行、18 个会话，
 * 每个会话几乎都是连续 5 条（客户端 `PULL_MAX_ATTEMPTS=4` + 首发 = 一个完整的退避
 * 阶梯）。这 229 行里真正有信息量的只有两件事：「这个会话开始对账了」和「它把重试
 * 预算跑满了」。中间那 3 条是同一句话的复读：宿主侧对每条 pull 做的动作逐字相同。
 *
 * 三条设计约束，都来自本仓既有的教训：
 *  1. **节流不等于静音**。#17 的结论就是「静默丢弃不可诊断」，所以重复必须**变成计数
 *     出现在报文里**（`seen` 随结果返回），而不是被 `if` 吞掉。阶梯跑满这件事从「刷屏」
 *     变成「一行带 `pulls=5` 的证据」——比原来更好读。
 *  2. **key 变化必开门**。换会话（`stepRepeatTrace` 里 key 不等）立刻重新打第一行：
 *     「客户端在问哪个会话」是每件事里唯一的变量，吞掉它就等于把可诊断性丢了。
 *     代价写在冒烟里：两个会话交替 pull 时各算一次首行（本闸门只防**连续**重复）。
 *     这条是取舍，不是漏网——交替形态交给 `every` 之外的上游修复（应答确认契约）。
 *  3. **首行必打**。`seen === 1` 无条件放行，所以任何「这行在不在」的既有断言（3 个
 *     harness 按 `ops consumed: …` 数过 op）不会因为加了闸门而失去载体。
 *
 * @module dsh-suggest-ghost/trace-gate
 */
/** 初始状态（`key: null` = 从未打过，第一次必然放行）。 */
export function initialRepeatTraceGate() {
    return { key: null, seen: 0 };
}
/**
 * 走一步。
 *
 * @param gate - 上一步的状态（纯函数，不改入参）。
 * @param key - 本次事件的归一化身份。**必须是不含正文的稳定标识**（会话 id 可以，
 *   草稿正文不行——本插件的隐私口径：留痕只打计数与字符数）。
 * @param every - 连续第 N 次时 `N % every === 0` 才再打一行。`every <= 1` 退化成
 *   「每次都打」，即闸门关闭（留给冒烟做变异自证用）。
 * @returns 新状态、是否打印、当前连续次数。
 */
export function stepRepeatTrace(gate, key, every) {
    const seen = key === gate.key ? gate.seen + 1 : 1;
    const print = seen === 1 || every <= 1 || seen % every === 0;
    return { gate: { key, seen }, print, seen };
}
/**
 * 把「连续第几次」拼成报文后缀。`seen === 1` 时返回空串——首行是本插件既有留痕的
 * 逐字形态（`sandbox.greps` 与若干 harness 按前缀匹配，后缀只在重复时才出现）。
 *
 * @param label - 计数进报文时的字段名（如 `pulls`）。
 */
export function repeatTraceSuffix(label, seen, note) {
    if (seen <= 1)
        return '';
    return ` [${label}=${seen}${note === '' ? '' : `：${note}`}]`;
}
