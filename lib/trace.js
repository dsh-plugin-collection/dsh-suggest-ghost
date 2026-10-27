/**
 * 默认静默的留痕通道（用户侧控制台不该被刷屏）。
 *
 * ## 为什么需要这一层
 *
 * 此前所有常态留痕（`push landed` / `hot push landed` / `ops consumed` /
 * `fiber=N …` / 已被补救的 `HMR nested` 拒绝等）都走 `console.log`，在健康进程里
 * 实测 **9294 行**，其中约 59% 是「一切正常」的确认心跳与「已成功补救」的中间态。
 * 用户开着终端或看 `~/.dsh/dsh-web.log` 时，这些行把**真正需要看的东西**埋掉了。
 *
 * ## 分级口径（唯一判据）
 *
 * - **`warn` / `error`**：**永远打印**。故障、被拒且**未能补救**、数据可能丢失、
 *   启动期异常——任何「需要人看一眼」的事都在这一级，不受任何开关影响。
 * - **`info`**：默认**静默**。状态迁移（apply、fiber 就位、域打开/恢复）这类
 *   「一次性、但正常运行时不该刷屏」的行。
 * - **`debug`**：默认**静默**。每次事件的确认心跳与中间态。
 *
 * ## 怎么打开
 *
 * ```
 * DSH_SUGGEST_GHOST_TRACE=info    # 放行 info 及以上
 * DSH_SUGGEST_GHOST_TRACE=debug   # 全量（排查时用）
 * DSH_SUGGEST_GHOST_TRACE=warn    # 显式等同默认
 * ```
 *
 * 未设或无法识别 ⇒ 等于 `warn`（**默认安静**）。取值大小写不敏感。
 *
 * ## 为什么默认走 console.debug 而不是干脆不打
 *
 * 宿主全局只有一个 logger exporter（`@deepseek-ai/dsh-app-boot` 的 `boot()` 内，
 * `levels:{default:2}` 挡掉 debug；回调只收 warn/error），且它只在**启动失败**时
 * 由 `dsh/lib/bin.js` 写盘。而 `console` 与 logger 是**两条独立通道**：`console.debug`
 * 照样进 stdout → `tee ~/.dsh/dsh-web.log`，只是级别低。
 * 所以「默认静默」用 `console.debug` 实现时**信息并没有被删除**，
 * 用户把开关打到 `debug` 就能原样拿回全部留痕。
 *
 * ⚠️ 不要把这里改回 `ctx.logger`：那会真的丢（见上）。也不要直接 `return`
 * 掉低频级——`debug` 档位就再也拿不回来了。
 *
 * @module dsh-suggest-ghost/trace
 */
/** 留痕级别，由低到高（数值越大越重要）。 */
export const TRACE_LEVELS = ['debug', 'info', 'warn', 'error'];
/** 级别数值（用于比较）。 */
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/**
 * 读取用户设置的门槛。默认 `warn` —— 即**只有告警与错误会到达用户侧**。
 *
 * 每次调用重新读环境变量，不在模块顶层缓存：沙箱/测试会在进程内改它，
 * 缓存会让「设了不生效」变成一个极难查的现象。
 */
export function traceThreshold() {
    const raw = (process.env['DSH_SUGGEST_GHOST_TRACE'] ?? '').trim().toLowerCase();
    if (raw === '')
        return 'warn';
    // 允许简写：true/1/on 视为全量
    if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'all')
        return 'debug';
    if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'none')
        return 'error';
    return TRACE_LEVELS.includes(raw) ? raw : 'warn';
}
/** 某级别的行当前是否会到达用户侧。 */
export function traceEnabled(level) {
    return LEVEL_RANK[level] >= LEVEL_RANK[traceThreshold()];
}
/** 前缀：与既有 `ops-trace` 口径一致，现有 grep 脚本不用改。 */
export const TRACE_PREFIX = '[dsh-suggest-ghost][ops-trace]';
/**
 * 打一行留痕（按级别分流到 console 的对应通道）。
 *
 * @param level - 级别；`warn` / `error` 永不被丢弃。
 * @param message - 正文。**不得含用户草稿或建议原文**（隐私口径见各调用点）。
 */
export function traceAt(level, message) {
    // warn / error 一律放行，且**不读** threshold：告警绝不能被配置弄丢。
    if (level === 'warn') {
        console.warn(`${TRACE_PREFIX} ${message}`);
        return;
    }
    if (level === 'error') {
        console.error(`${TRACE_PREFIX} ${message}`);
        return;
    }
    if (!traceEnabled(level))
        return;
    if (level === 'info')
        console.info(`${TRACE_PREFIX} ${message}`);
    else
        console.debug(`${TRACE_PREFIX} ${message}`);
}
/**
 * 兼容既有调用点的两层 API：`traceOps(msg)` = debug（常态心跳）、
 * `traceNote(msg)` = info（状态迁移）。两者默认都不打印。
 */
export const traceOps = (message) => traceAt('debug', message);
/** 状态迁移类留痕（默认静默，`=info` 时可见）。 */
export const traceNote = (message) => traceAt('info', message);
