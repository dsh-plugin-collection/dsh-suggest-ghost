/**
 * 流式投递的 **Remote 服务注册**（宿主侧）。
 *
 * ## 为什么用动态 import
 *
 * `@deepseek-ai/dsh-typert-protocol` 必须**装在 profile 树内**才能被解析（实测：软链指向
 * 树外 ⇒ `ERR_MODULE_NOT_FOUND`，见 `docs/internals-cordis-settings-pitfalls.md`
 * 「第二条通道」）。而本插件要同时服务 0.1.x 与 0.2.x 若干代次，**顶层静态 import 会让
 * 解析不到该包的那一代次整个插件起不来** —— 那是比"没有流式"严重得多的失败。
 * 所以这里只在函数内部动态 import，失败即返回 false ⇒ 调用方按"未启用"处理，
 * 生成路径与今天逐字一致。
 *
 * ⚠️ **这个"可选"绝不能写进 `peerDependencies`**（#110 的成因，别再犯第二次）：
 * ≤0.2.0 的准入门禁是 **peers-only 语义**，它只读 `peerDependencies` 的范围、
 * **不看 `peerDependenciesMeta.optional`** ⇒ 一个"可选"声明被当**硬要求**执行，
 * 直接把插件从 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 上抹掉（幽灵、补全、热度一起没）。
 * 运行时"拿到就用、拿不到就降级"这件事**已经是完整实现**，声明面不需要它出现；
 * `scripts/cross-kernel/gate-matrix.mjs --self-test` 现在把这条钉住
 * （断言真实 manifest 内没有 `dsh-typert-protocol` 的 peer 声明）。
 *
 * ## 为什么不需要 typert manifest / codegen
 *
 * 网关解析 endpoint 时有 **SRC 兜底**：严格注册表查不到就扫 `ctx.reflect.props`，凡实例带
 * `typertRemote` 绑定、方法带 `@Remote` 标记的，按**方法参数名**现造描述符
 * （`dsh-api-gateway/lib/index.js:1224-1248`、`:1249-1275`）。⇒ 只要
 * ① 服务是 `TypertRemoteService` 子类、② 方法标 `@Remote({ mode: 'stream' })`、
 * ③ 取消参数叫 `signal` 且位于末位（`:1251-1253` 会硬判），就够了。
 *
 * ## 注册时机
 *
 * 动态 import 是异步的 ⇒ 服务可能在**首帧之后**才挂上。这不影响正确性：网关在
 * `internal/service` 上会作废 SRC 声明缓存（`lib/index.js:769-771`），下一回合就能拿到。
 * 客户端在挂上之前开流会拿到 `gateway/invocation-unavailable` ⇒ 自己退回现状路径。
 *
 * 类型面来自 `src/typert-protocol.d.ts` 的本地最小面（**不新增依赖**，理由写在那份文件里）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GhostStreamHub } from './stream.ts';
/** Remote 命名空间与服务键（客户端 contribution 里的 `namespace` 必须与此一致）。 */
export declare const GHOST_STREAM_SERVICE_KEY = "ghostStream";
/**
 * 注册 `ghostStream` 服务。
 *
 * @param ctx - 插件宿主上下文。
 * @param hub - 内存通道（帧只在它上面流动，**不落盘**）。
 * @param isEnabled - 每次开流时实时问一句开关（改配置不必重启）。
 * @returns 是否注册成功（false = 该代次/该安装形状拿不到协议包，调用方按未启用处理）。
 */
export declare function registerGhostStreamService(ctx: Context, hub: GhostStreamHub, isEnabled: () => boolean): Promise<boolean>;
