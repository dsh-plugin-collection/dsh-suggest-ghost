/**
 * `@deepseek-ai/dsh-typert-protocol` 的**本地最小面**（只声明本仓真正用到的三个成员）。
 *
 * ## 为什么不直接把它加进 devDeps
 *
 *  1. 本仓已有同手法的前例：`src/client/index.ts` 的 `ClientSessionsSurface` /
 *     `RemoteLike` 都是本地声明，因为那些宿主客户端包**不在 devDeps**（`require.resolve`
 *     实测失败），而客户端产物必须保持**零内核导入**。
 *  2. 运行时的解析成败**不由本仓决定**：协议包必须随 profile 树安装（实测软链指树外 ⇒
 *     `ERR_MODULE_NOT_FOUND`）。把它写进 devDeps 只会让"类型上过、运行时挂"变成静默错位。
 *     所以这里声明的是**形状**，运行时靠 `src/stream-service.ts` 的动态 import + 失败降级。
 *
 * ⚠️ **若将来把 `@deepseek-ai/dsh-typert-protocol` 加进 devDeps，删掉本文件**改用真声明：
 * 同一模块的两份声明会合并，届时这里的形状与真身不一致就会变成"看不出谁改了"的问题。
 * （与本仓对 `connection/reset` 事件表的处理口径一致。）
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context } from '@deepseek-ai/cordis';

  /** 标准方法装饰器（TC39 v12 形态；协议实现按 `context.kind === 'method'` 收标记）。 */
  export type GhostRemoteMethodDecorator = <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ) => void;

  /** `@Remote({ mode: 'stream' })`：把方法登记为一条逻辑流（真身见协议 README:49）。 */
  export function Remote(options: { readonly mode: 'stream' }): GhostRemoteMethodDecorator;

  /** 带 Typert 绑定的 Cordis Service 基类：构造即注册服务并暴露 `typertRemote`。 */
  export abstract class TypertRemoteService {
    protected constructor(ctx: Context, serviceKey: string);
  }
}
