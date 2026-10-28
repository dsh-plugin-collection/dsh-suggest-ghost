/**
 * 流式投递的 **客户端侧**（#108 决策 ①，默认关）。
 *
 * ## 为什么这里没有一行 `@deepseek-ai/*` 导入
 *
 * 本文件保持客户端产物**零内核导入**（与 `src/client/index.ts` 同一口径：`lib/client.js`
 * 实测不含任何内核包引用）。宿主 `ctx.remote.$mount` 真正要求的 contribution 形状只有
 * 两个成员（`dsh-typert-protocol/lib/types/types.d.ts:432-437`：`package` +
 * `descriptors`），所以这里**手写描述符**，不引 `createTypertRemoteInfo`、也不引 zod。
 *
 * ⚠️ **codec 的 `create()` 在这条调用路径上不会被调用**（实证：客户端 mount 只做
 * `requireStrictInputs` 的 `mode==='strict'` 检查
 * （`dsh-api-gateway/lib/client.browser.js:2101-2109`），发参数走
 * `prepareInvocation` 的"按位置映射到 wire"（`:1851-1879`），**不做类型收敛**；
 * 一元才看 `result.decode`，流不看）。所以：
 *  - 这里给的是**恒等 schema**，它的存在是为了满足 mount 的形状要求，**不是校验**；
 *  - 真正的入参守卫在宿主方法里（`src/stream-service.ts` 的 `suggest` 自己判 sessionId）；
 *  - 别把它读成"客户端有类型校验"——两侧严格度不对称这件事记在
 *    `docs/internals-cordis-settings-pitfalls.md`「第二条通道」与 Gitea #40。
 *
 * ## 撤帧为什么用 `dispose()` 而不是 `abort()`
 *
 * 同代次实测（#36 / task-31）：`ac.abort()` 会让迭代抛 `probe-cancel`，而
 * `handle.dispose()` **安静结束**（不发错误帧、不多发一帧）。改草稿这种高频动作
 * 每次都抛一次异常再吞掉，既脏又会在别处留下"看起来像失败"的痕迹。
 */

/** 与宿主 `src/stream.ts` 的 `GhostStreamFrame` 同形（两侧各自声明，靠 wire 对齐）。 */
export interface GhostStreamFrame {
  readonly turn: number;
  readonly text: string;
  readonly frame: number;
  readonly final: boolean;
}

/** 恒等 schema：只为满足 `mode:'strict'` 的形状要求（见文件头那条警告）。 */
const passthroughSchema = {
  parse: (value: unknown): unknown => value,
  safeParse: (value: unknown): { success: true; data: unknown } => ({ success: true, data: value }),
};

/** 一个 strict codec（宿主 mount 要求的三件套：mode / typeSymbol / create）。 */
const codec = (typeSymbol: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create: () => passthroughSchema,
});

/** Remote 命名空间（必须与宿主 `GHOST_STREAM_SERVICE_KEY` 一致）。 */
export const GHOST_STREAM_NAMESPACE = 'ghostStream';

/**
 * 手写 contribution：一个流方法 `ghostStream/suggest`。
 *
 * 参数**按位置**映射（宿主 SRC 侧按参数名生成 wire 字段），所以调用方必须写
 * `suggest(sessionId, signal)`，不能写 `suggest({ sessionId })` —— 后者会得到
 * `expected 1 business argument(s) plus an optional AbortSignal, got 1` 之外的
 * 形状错误（实测：具名对象会被当成第一个业务参数）。
 *
 * @returns `$mount` 可直接吃的贡献对象。
 */
export function ghostStreamContribution(): {
  readonly package: string;
  readonly descriptors: readonly unknown[];
} {
  return {
    package: 'dsh-suggest-ghost',
    descriptors: [{
      id: `${GHOST_STREAM_NAMESPACE}/suggest`,
      service: GHOST_STREAM_NAMESPACE,
      namespace: GHOST_STREAM_NAMESPACE,
      method: 'suggest',
      description: '本会话下一次生成的建议帧序列（净化前缀；终帧才可采纳）。',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'sessionId',
        wire: 'sessionId',
        description: '要监听哪个会话的下一次生成。',
        source: 'json',
        codec: codec('dsh-session/types#SessionId'),
      }],
      cancellation: { parameter: 'signal' },
      result: codec('dsh-suggest-ghost#GhostStreamFrame'),
    }],
  };
}

/** 宿主侧挂不上的失败形状（老代次 / 未装协议包 / 通道未注册）。 */
export type GhostStreamState = 'idle' | 'open' | 'closed' | 'unavailable';

/** 依赖注入形状（本模块不碰 DOM、不读 settings，全部由调用方给）。 */
export interface GhostStreamDeps {
  /** 已 `$mount` 完成的命名空间服务对象（`child.remote.ghostStream`）。 */
  readonly namespace: GhostStreamNamespace | undefined;
  /** 收到一帧。 */
  readonly onFrame: (frame: GhostStreamFrame, sessionId: string) => void;
  /** 状态变化（含失败原因），用于留痕。 */
  readonly onState: (state: GhostStreamState, sessionId: string, note: string) => void;
}

/** 只声明用到的成员：一个返回可迭代句柄的流方法。 */
interface GhostStreamNamespace {
  suggest?(sessionId: string, signal?: AbortSignal): AsyncIterable<GhostStreamFrame> & {
    dispose?: () => void;
  };
}

/**
 * 一条**按会话**的短流通道：`open(sessionId)` 开、`close()` 撤。
 *
 * 幂等性：同一会话重复 `open` 只保留最新一条流（旧的先 dispose）；换会话同理。
 * 这是"限频自己做"的另一半 —— 客户端不会因为抖动而攒出一堆并发流。
 *
 * @param deps - 见 {@link GhostStreamDeps}。
 * @returns 通道句柄。
 */
export function createGhostStreamChannel(deps: GhostStreamDeps): {
  open: (sessionId: string) => void;
  close: (note: string) => void;
  readonly sessionId: string | null;
} {
  let current: { sessionId: string; handle: AsyncIterable<GhostStreamFrame> & { dispose?: () => void } } | null = null;

  const closeNow = (note: string): void => {
    if (current === null) return;
    const closing = current;
    current = null;
    try {
      // dispose 而不是 abort：见文件头。
      closing.handle.dispose?.();
    } catch {
      // dispose 失败不改变任何判据：流已经不再被读，宿主侧靠 signal/断线回收。
    }
    deps.onState('closed', closing.sessionId, note);
  };

  return {
    open: (sessionId: string): void => {
      if (deps.namespace?.suggest === undefined) {
        deps.onState('unavailable', sessionId, 'namespace-missing');
        return;
      }
      if (current?.sessionId === sessionId) return; // 同会话重复开：不重开
      closeNow('replaced');
      try {
        const handle = deps.namespace.suggest(sessionId);
        current = { sessionId, handle };
        deps.onState('open', sessionId, '');
        void (async () => {
          try {
            for await (const frame of handle) deps.onFrame(frame, sessionId);
            if (current?.sessionId === sessionId && current.handle === handle) current = null;
          } catch (error: unknown) {
            // 通道不可用（老代次没挂上服务、网关没有这个 endpoint）是**预期内**的降级，
            // 不是失败：只报一次状态，随后照旧等 `_push` 的终帧。
            deps.onState('unavailable', sessionId, String(error instanceof Error ? error.message : error).slice(0, 120));
            if (current?.handle === handle) current = null;
          }
        })();
      } catch (error: unknown) {
        deps.onState('unavailable', sessionId, String(error instanceof Error ? error.message : error).slice(0, 120));
      }
    },
    close: (note: string): void => { closeNow(note); },
    get sessionId(): string | null { return current?.sessionId ?? null; },
  };
}
