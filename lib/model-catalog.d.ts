/**
 * 模型目录路由（#116 / task-48）：给设置卡的 Provider / Model 两个下拉框提供数据源。
 *
 * ## 为什么这条路由的安全口径要写成"构造上不可能"
 *
 * 插件自建路由**不经鉴权**（#40 第 6 条：任何本机进程都能 curl 到）。所以这里不接受
 * "响应里恰好没有敏感串"这种判据 —— 那种判据只能证明**这一次**没有，改一行代码就失效。
 * 本模块的构造性控制有两条：
 *
 *  1. **数据源只有两个函数**：`sources.providers()` 与 `sources.models(provider)`，
 *     生产接线里它们分别绑定到宿主 llm 服务的 `listProviders()` / `listModels()`。
 *     模块**不接收** session、settings、hotness、`_push`/`_hot` 任何东西 ——
 *     不是"我们没往里面塞"，而是这个函数拿不到它们。
 *  2. **白名单投影**：每一行只允许 `id` / `name` 两个字段通过（`normalizeCatalogRows`），
 *     其余键一律丢弃。所以即使宿主哪天给 provider/model 行加了新字段（描述、endpoint、
 *     上次使用的会话…），也不会顺路吐出去。
 *
 * 两条判据在 `scripts/model-catalog-smoke.mjs` 里都有对应断言（含"给源塞一条带 draft /
 * sessionId 的行，响应里必须没有"这条投毒测试）。
 *
 * ## 为什么不自己维护一份清单
 * 抄 gitea-dispatch 的做法：目录**只取宿主服务**。自己写死一份 provider 列表必然与部署漂移
 * （换路由、加账号、升内核都会让它说谎），而说谎的下拉框比自由文本输入框更坏。
 */
/** 路由路径：与 gitea-dispatch 的 `/api/<plugin>/options` 同形状，便于对照。 */
export declare const MODEL_OPTIONS_PATH = "/api/suggest-ghost/options";
/** 单次响应的行数上限（防御异常大的目录；宿主侧模型数在几百量级）。 */
export declare const CATALOG_MAX_ROWS = 500;
export interface CatalogRow {
    readonly id: string;
    readonly name: string;
}
export interface CatalogSources {
    providers(): unknown;
    models(provider: string): unknown;
}
/**
 * 白名单投影：数组 → `[{id,name}]`，去重、按 id 稳定排序、截断到上限。
 *
 * ⚠️ 这里**只读 `id` 与 `name` 两个键**。任何其它键（description、endpoint、lastSession…）
 * 一律丢弃 —— 这是"构造上不会带出会话数据"的第二道，也是防"宿主以后加字段"的那道。
 */
export declare function normalizeCatalogRows(rows: unknown): CatalogRow[];
/** 查询参数里的 provider 也要过同一套字符集约束；不合法就当没传（返回空目录）。 */
export declare function sanitizeProviderParam(raw: string | null | undefined): string | null;
/** 只用到 `writeHead`/`end` 的最小响应面（便于单测喂假对象）。 */
interface ResponseLike {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: string): void;
}
/** 只用到 `method`/`url` 的最小请求面。 */
interface RequestLike {
    method?: string;
    url?: string;
}
/**
 * 造 handler。**注意签名**：它只拿得到 `sources` 与 `logger`，拿不到会话/设置/热表。
 * 想从这条路由漏会话数据，必须先给这个函数多接一个数据源 —— 那会在 diff 里明晃晃出现，
 * 而冒烟里"源只被调用这两个方法"的断言会当场红。
 */
export declare function createModelCatalogHandler(deps: {
    sources: CatalogSources;
    logger?: {
        warn?: (msg: string) => unknown;
    };
}): (req: RequestLike, res: ResponseLike) => void;
export {};
