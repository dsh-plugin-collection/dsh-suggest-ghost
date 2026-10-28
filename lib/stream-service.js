var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
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
export async function registerGhostStreamService(ctx, hub, isEnabled) {
    let protocol;
    try {
        protocol = await import('@deepseek-ai/dsh-typert-protocol');
    }
    catch (error) {
        // 拿不到协议包 ⇒ 不注册、退回"整块到达"。但**不能只说"not resolvable"**：
        // 这条降级路径的排查成本全在"到底是哪一步没解析到"——是包没装，还是插件模块的
        // 解析根不在 profile 树里？两者修法完全不同，所以把 code 与原文一起带出来。
        const raw = error;
        const code = typeof raw?.code === 'string' ? ` (${raw.code})` : '';
        const message = error instanceof Error ? String(error.message) : String(error);
        throw new Error(`dsh-suggest-ghost: typert protocol import failed${code}: ${message.slice(0, 240)}`);
    }
    const { Remote, TypertRemoteService } = protocol;
    /** 下一次生成的建议流：客户端在 `running` 边沿上开，宿主逐帧 yield 净化前缀。 */
    let GhostStreamService = (() => {
        let _classSuper = TypertRemoteService;
        let _instanceExtraInitializers = [];
        let _suggest_decorators;
        return class GhostStreamService extends _classSuper {
            static {
                const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
                _suggest_decorators = [Remote({ mode: 'stream' })];
                __esDecorate(this, null, _suggest_decorators, { kind: "method", name: "suggest", static: false, private: false, access: { has: obj => "suggest" in obj, get: obj => obj.suggest }, metadata: _metadata }, null, _instanceExtraInitializers);
                if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            }
            /**
             * 绑定服务键。
             * @param owner - 宿主上下文。
             */
            constructor(owner) {
                super(owner, GHOST_STREAM_SERVICE_KEY);
                __runInitializers(this, _instanceExtraInitializers);
            }
            /**
             * 本会话下一次生成的建议帧序列。
             *
             * @param sessionId - 要监听哪个会话（客户端在回合结束边沿上拿得到当前会话 id）。
             * @param signal - 载体取消：客户端 `dispose()` 或断线都会 abort 它 ⇒ 订阅即刻回收。
             * @returns 净化前缀帧；开关关闭或本轮无生成时是空序列。
             */
            async *suggest(sessionId, signal) {
                if (!isEnabled())
                    return;
                if (typeof sessionId !== 'string' || sessionId.length === 0)
                    return;
                for await (const frame of hub.subscribe(sessionId, signal))
                    yield frame;
            }
        };
    })();
    // cordis 的 Service 子类构造即注册（`ctx.reflect.provide`），所以 new 出来就进树。
    new GhostStreamService(ctx);
    return true;
}
