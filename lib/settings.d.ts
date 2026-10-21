/**
 * `suggest-ghost` 的 settings 传输形状与配置合并。
 *
 * ## 0.1.7 的机制变化
 *
 * 内核移除了 `settings.yaml` 体系：`SettingsProvider.register()` 与
 * `SettingsScope<T>` 都不复存在，`ctx.settings` 变为 `SettingsForms`。命名空间
 * 不再由插件注册——内核把**插件自己的 Config schema**（其中 `.volatile()` 的
 * 字段）投影成 WebUI 表单，ns 即 Loader 条目 id（`suggest-ghost`）。所以：
 *
 *  - 用户可调项声明在 `index.ts` 的 `Config` 里（见那里的 `EditableFields`）；
 *  - host 写入经 `ctx.settings.update(ns, patch)`；
 *  - client 读取经 `ctx.remote.settings.describe()`；
 *  - 变更通知经 `settings/document-updated(ns, revision)` 事件。
 *
 * 本文件因此只保留两件事：`_push` / `_ops` 两个 JSON 载荷的**传输形状**，
 * 以及把 live 值合并回生成配置。schema 本身在 `Config` 里。
 * @module dsh-suggest-ghost/settings
 */
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { FlatConfig } from './generate.js';
/**
 * 命名空间名：等于 Loader 条目 id（见 cordis.patch.yml 的 `- id: suggest-ghost`）。
 * 不用官方 `settingsNamespace()` helper——它在 DSH 0.1.2 内核已被删除，运行时
 * 导入会让本模块链接失败；该 helper 仅是校验后原样返回同样的字符串。
 */
export declare const SUGGEST_GHOST_NAMESPACE: SettingsNamespace;
/** `_push` / `_hot` / `_ops` 的空载荷（JSON 字符串的 null 表示）。 */
export declare const EMPTY_PUSH = "null";
/**
 * host → client 的**建议格**载荷（`_push` 字段的 JSON 形态）。
 *
 * ## #36 建议 2：一格一节奏
 *
 * 今天所有推送数据挤在一个载荷、一道指纹、一次写里，于是「用户又打了一句话
 * （热表 +1）」和「出新建议了（用户真正等的东西）」共用同一把锁、同一次整档 profile
 * 重写，客户端也无从分辨哪一格变了。现在拆成两格：
 *  - `_push`（本类型）：**建议 / 续写 / 错误**——低频、珍贵，走 #47 的三态分诊与事务外补写；
 *  - `_hot`（{@link GhostHotPayload}）：**热度快照 / 总数 / 历史环**——高频、每帧都可被下一帧覆盖。
 *
 * 两格各自有指纹、各自判「变没变」；同一次 flush 里两格都脏就**合并成一次**
 * `settings.update`。合并的理由**不是**「少一次整档重写」——补写泵不排队（probe-hmr
 * 第二次复核：泵在事务外，每 500ms 无脑调一次 `update()`，前一笔在途时不 await、
 * 不延后，锁串行发生在内核 `withFileLock` 内部），各写各的最坏只是多等一个 500ms
 * tick。合并真正省的是**客户端一次重解析**：一次 `describe()` 回来的就是两格的完整
 * 当前状态，两格各写会把客户端叫醒两次（第二次里热度是新的、建议是旧的）。
 *
 * `*SessionId` 归属守卫与帧字段（`frame` / `final`，#41 契约）都在这一格里，语义未动。
 */
export interface GhostPushPayload {
    /** 递增标识新值。 */
    readonly rev: number;
    /** 最新 LLM 建议；null = 无建议。 */
    readonly suggestion: {
        readonly turn: number;
        readonly baseSeq: number;
        readonly text: string;
        readonly truncated: boolean;
        readonly acceptKey: string;
        /**
         * 单次生成内的帧号（>=1，单调；见 domain.ts 的 SuggestGhostSuggested）。
         * host 侧由 `pushToClient` 统一补齐（缺省 1），所以这个键在载荷里**恒在**。
         */
        readonly frame: number;
        /** 是否终帧（本期恒 true）。 */
        readonly final: boolean;
    } | null;
    /** 建议所属会话（null = 无有效建议）。 */
    readonly suggestionSessionId: string | null;
    /** 行内续写；缺省表示不携带（client 保留现值），null = 作废。 */
    readonly completion?: {
        readonly draft: string;
        readonly text: string;
        readonly final: boolean;
    } | null;
    /** completion 所属会话。 */
    readonly completionSessionId?: string | null;
    /** 最近一次生成失败的摘要（可诊断）。 */
    readonly error?: string;
}
/**
 * host → client 的**热度格**载荷（`_hot` 字段的 JSON 形态）。
 *
 * 缺省语义与建议格一致：**整格缺省（键不存在 / 空载荷）= client 保留现值**，
 * 不是「热度清空了」；格内的 `history` 同样是「省略 = 不携带、null/空 = 不更新」。
 * 所以旧载荷（没有 `_hot` 的年代）在新客户端上只是「这一格没说话」，不会清空列表。
 */
export interface GhostHotPayload {
    /** 递增标识新值（与 `_push` 的 rev 各自独立：两格不是同一次变更的产物）。 */
    readonly rev: number;
    /** 跨会话热度快照（top-K）；null = 无热度数据。 */
    readonly hot: readonly {
        text: string;
        count: number;
        pinned?: boolean;
    }[] | null;
    /** 热表总条目数（管理面板「共 N 条」展示；快照只是 top-K）。 */
    readonly total: number;
    /** 本会话历史环；缺省表示不携带（client 保留现值）。 */
    readonly history?: readonly string[];
    /** history 所属会话。 */
    readonly historySessionId?: string;
}
/** `_push` / `_hot` / `_ops` 在 settings 里的传输形状（三个 JSON 字符串）。 */
export interface SuggestGhostSettings {
    /** host → client 的实时推送载荷·建议格（见 `GhostPushPayload`）。 */
    _push: string;
    /** host → client 的实时推送载荷·热度格（见 `GhostHotPayload`）。 */
    _hot: string;
    /** client → host 的热度管理操作队列（见 `parseHotnessOps`）。 */
    _ops: string;
}
/**
 * 把 live 值合并回生成配置：路由对为空串时回退到插件配置的继承语义
 * （不显式传 provider/model → generateSuggestion 继承主请求路由）。
 *
 * **第一入参 = 默认层，第二入参 = 覆盖层**（`{...plugin, ...live, ...route}`）。
 * #19 之后 `live` 允许是**部分**视图：实时值由 `live-settings.pickLiveSettings()`
 * 从 `settings.describe()` 的 `row.value` 提炼，只有「内核这一行里确实有、且校验
 * 通过」的键才在对象上，缺席的键由 `{ ...plugin }` 兜底（= 回落到插件配置 / 默认值）。
 * 路由判据写成 `live.provider ?? ''` 本来就得容忍未覆盖。
 * @param plugin - 默认层：boot 解析 + 拍平后的插件配置。
 * @param live - 覆盖层：实时读到的用户可调项（可以是部分键）。
 */
export declare function effectiveConfig(plugin: FlatConfig, live: Partial<FlatConfig>): FlatConfig;
/**
 * host 的实时合并策略：`effectiveConfig` 的包装，专门处理「路由对被**清空**」。
 *
 * `bootSettings` 只是同一个 volatile 字段的**旧读取结果**（#19 的失效快照），不是一个
 * 独立的配置层。所以实时行里 provider/model 在场时它才是权威值——包括空串（= 继承
 * 主请求路由，见 generate.routeOf 的判据）。若仍然让 boot 当回退层，用户在设置页
 * **清空** provider/model 会被 boot 里的旧路由复活，正好复刻 #19 那个「改了不生效」。
 * 这里在实时值带上这一对时把回退层的路由置空；实时行没给这一对（describe 不可用 /
 * 老代次未渲染）时按原样回落到 boot，保持迁移前的行为。
 * @param boot - 默认层（boot 快照）。
 * @param live - 覆盖层（describe() 提炼的实时值）。
 */
export declare function mergeLiveConfig(boot: FlatConfig, live: Partial<FlatConfig>): FlatConfig;
