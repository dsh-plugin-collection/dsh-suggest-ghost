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
import type { GhostStreamFrame, GhostStreamHub } from './stream.ts';

/** Remote 命名空间与服务键（客户端 contribution 里的 `namespace` 必须与此一致）。 */
export const GHOST_STREAM_SERVICE_KEY = 'ghostStream';

/**
 * 注册 `ghostStream` 服务。
 *
 * @param ctx - 插件宿主上下文。
 * @param hub - 内存通道（帧只在它上面流动，**不落盘**）。
 * @param isEnabled - 每次开流时实时问一句开关（改配置不必重启）。
 * @returns 是否注册成功（false = 该代次/该安装形状拿不到协议包，调用方按未启用处理）。
 */
export async function registerGhostStreamService(
  ctx: Context,
  hub: GhostStreamHub,
  isEnabled: () => boolean,
): Promise<boolean> {
  let protocol: typeof import('@deepseek-ai/dsh-typert-protocol');
  try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol');
  } catch (error: unknown) {
    // 拿不到协议包 ⇒ 不注册、退回"整块到达"。但**不能只说"not resolvable"**：
    // 这条降级路径的排查成本全在"到底是哪一步没解析到"——是包没装，还是插件模块的
    // 解析根不在 profile 树里？两者修法完全不同，所以把 code 与原文一起带出来。
    const raw = error as { code?: unknown; message?: unknown };
    const code = typeof raw?.code === 'string' ? ` (${raw.code})` : '';
    const message = error instanceof Error ? String(error.message) : String(error);
    throw new Error(`dsh-suggest-ghost: typert protocol import failed${code}: ${message.slice(0, 240)}`);
  }
  const { Remote, TypertRemoteService } = protocol;

  /** 下一次生成的建议流：客户端在 `running` 边沿上开，宿主逐帧 yield 净化前缀。 */
  class GhostStreamService extends TypertRemoteService {
    /**
     * 绑定服务键。
     * @param owner - 宿主上下文。
     */
    constructor(owner: Context) {
      super(owner, GHOST_STREAM_SERVICE_KEY);
    }

    /**
     * 本会话下一次生成的建议帧序列。
     *
     * @param sessionId - 要监听哪个会话（客户端在回合结束边沿上拿得到当前会话 id）。
     * @param signal - 载体取消：客户端 `dispose()` 或断线都会 abort 它 ⇒ 订阅即刻回收。
     * @returns 净化前缀帧；开关关闭或本轮无生成时是空序列。
     */
    @Remote({ mode: 'stream' })
    async *suggest(sessionId: string, signal: AbortSignal): AsyncIterable<GhostStreamFrame> {
      if (!isEnabled()) return;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      for await (const frame of hub.subscribe(sessionId, signal)) yield frame;
    }
  }

  // cordis 的 Service 子类构造即注册（`ctx.reflect.provide`），所以 new 出来就进树。
  new GhostStreamService(ctx);
  return true;
}
