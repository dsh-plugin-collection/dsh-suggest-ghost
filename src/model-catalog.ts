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
export const MODEL_OPTIONS_PATH = '/api/suggest-ghost/options';

/** 单次响应的行数上限（防御异常大的目录；宿主侧模型数在几百量级）。 */
export const CATALOG_MAX_ROWS = 500;

export interface CatalogRow {
  readonly id: string;
  readonly name: string;
}

export interface CatalogSources {
  providers(): unknown;
  models(provider: string): unknown;
  /**
   * 精确 provider/model 的元数据（宿主 `llm.resolveModel`）；返回 `{reasoning:{efforts,defaultEffort}}`。
   *
   * ⚠️ 档位**不在** `models()` 的行里（那些行只有 id/name，实测如此），必须走这条解析。
   * 解析失败/无该模型由调用方按"空数组"处理。
   */
  efforts(provider: string, model: string): unknown;
}

/** 一行是不是 `{id,name}` 形状的非空字符串对；不是就整行丢弃（不做部分保留）。 */
function pickRow(value: unknown): CatalogRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { id?: unknown; name?: unknown };
  if (typeof row.id !== 'string' || row.id.trim() === '') return null;
  const id = row.id.trim();
  // name 缺失时退回 id：下拉框里空标签比重复标签更难排查
  const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id;
  // id 进 URL 查询（?models=…）与 DOM option 的 value：限制字符集，避免把带空格/控制符的
  // 脏数据当合法 id 传回宿主服务。
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id)) return null;
  return { id, name };
}

/** 档位行：`id` + `name`，可带 `description`（宿主 `LlmReasoningEffortInfo` 的超集投影）。 */
export interface CatalogEffortRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * 档位行投影：**只读 id / name / description**，其余键一律丢弃。
 *
 * 与 `pickRow` 同一条纪律：不经白名单就没有字段能带出容器外 —— 这条路由不经鉴权
 * （#40 第 6 条），"构造上拿不到"必须由投影保证，而不是由"源里现在没有那字段"保证。
 */
function pickEffortRow(value: unknown): CatalogEffortRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { id?: unknown; name?: unknown; description?: unknown };
  if (typeof row.id !== 'string' || row.id.trim() === '') return null;
  const id = row.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id)) return null;
  const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id;
  const out: { id: string; name: string; description?: string } = { id, name };
  if (typeof row.description === 'string' && row.description.trim() !== '') {
    out.description = row.description.trim().slice(0, 200);
  }
  return out;
}

/**
 * 白名单投影：数组 → `[{id,name}]`，去重、按 id 稳定排序、截断到上限。
 *
 * ⚠️ 这里**只读 `id` 与 `name` 两个键**。任何其它键（description、endpoint、lastSession…）
 * 一律丢弃 —— 这是"构造上不会带出会话数据"的第二道，也是防"宿主以后加字段"的那道。
 */
export function normalizeCatalogRows(rows: unknown): CatalogRow[] {
  const list = Array.isArray(rows) ? rows : rows instanceof Map ? [...rows.values()] : [];
  const seen = new Set<string>();
  const out: CatalogRow[] = [];
  for (const value of list) {
    const row = pickRow(value);
    if (row === null || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= CATALOG_MAX_ROWS) break;
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 查询参数里的 provider 也要过同一套字符集约束；不合法就当没传（返回空目录）。 */
export function sanitizeProviderParam(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(trimmed)) return null;
  return trimmed;
}

/** `?efforts=<provider>|<model>` 的第二段：与 provider 同一套字符集约束。 */
export function sanitizeModelParam(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(trimmed) ? trimmed : null;
}

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
export function createModelCatalogHandler(deps: {
  sources: CatalogSources;
  logger?: { warn?: (msg: string) => unknown };
}): (req: RequestLike, res: ResponseLike) => void {
  const send = (res: ResponseLike, status: number, payload: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      // 目录随部署变化（换 provider / 加账号），不缓存。
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  /**
   * 一段取不到就退化成空数组：下拉框少几项可挑，比整条 500 好；
   * 但**响应体里绝不带上错误文本** —— 错误文本的内容不由我们决定（宿主/适配器抛什么都有可能），
   * 而这条路由不经鉴权。要排查的人去看日志，日志里也只有段名与截断后的原因。
   */
  const safeRows = async (section: 'providers' | 'models', label: string, run: () => unknown): Promise<CatalogRow[]> => {
    try {
      return normalizeCatalogRows(await run());
    } catch {
      deps.logger?.warn?.(`dsh-suggest-ghost: model catalog section "${section}" unavailable (${label})`);
      return [];
    }
  };
  return (req, res) => {
    if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        allow: 'GET, HEAD',
      });
      res.end(req.method === 'HEAD' ? undefined : 'method not allowed\n');
      return;
    }
    let wanted: string | null = null;
    let effortPair: { provider: string; model: string } | null = null;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // 档位分支优先：`?efforts=<provider>|<model>`（换模型必须重解析 ⇒ 不做跨模型缓存）
      const rawEfforts = url.searchParams.get('efforts');
      if (rawEfforts !== null) {
        const sep = rawEfforts.indexOf('|');
        const p = sanitizeProviderParam(sep < 0 ? null : rawEfforts.slice(0, sep));
        const m = sanitizeModelParam(sep < 0 ? null : rawEfforts.slice(sep + 1));
        effortPair = p !== null && m !== null ? { provider: p, model: m } : null;
      }
      wanted = effortPair === null ? sanitizeProviderParam(url.searchParams.get('models')) : null;
    } catch {
      wanted = null;
    }
    if (effortPair !== null) {
      const { provider, model } = effortPair;
      // ⚠️ 这里**不能**走 `safeRows`：它会把结果按 `{id,name}` 归一化，而我们要的是
      // 宿主 `resolveModel` 返回的整个元数据（档位在里面）。所以自己 try/catch，
      // 同样"取不到 ⇒ 空数组 + 200、响应体不带错误文本、不回显入参"。
      void (async () => {
        // 显式命名形状：`sources.efforts` 返回 unknown，直接 `as typeof info` 会被推成 never。
        type ResolvedInfo = { reasoning?: { efforts?: unknown; defaultEffort?: unknown } } | null;
        let info: ResolvedInfo = null;
        try {
          info = (await deps.sources.efforts(provider, model)) as ResolvedInfo;
        } catch {
          deps.logger?.warn?.(`dsh-suggest-ghost: model catalog section "efforts" unavailable `
            + `(${provider}/${model})`);
        }
        const list: unknown[] = Array.isArray(info?.reasoning?.efforts)
          ? (info!.reasoning!.efforts as unknown[])
          : [];
        const efforts = list
          .map(pickEffortRow)
          .filter((row): row is CatalogEffortRow => row !== null)
          .slice(0, CATALOG_MAX_ROWS);
        const rawDefault = info?.reasoning?.defaultEffort;
        const defaultEffort = sanitizeModelParam(typeof rawDefault === 'string' ? rawDefault : null);
        send(res, 200, defaultEffort === null
          ? { version: 1, efforts }
          : { version: 1, efforts, defaultEffort });
      })();
      return;
    }
    if (wanted !== null) {
      const provider = wanted;
      void safeRows('models', provider, () => deps.sources.models(provider)).then((models) => {
        // ⚠️ 不回显 provider 参数：反射输入没必要，少一个能被人控制的字段就少一个面。
        send(res, 200, { version: 1, models });
      });
      return;
    }
    void safeRows('providers', 'providers', () => deps.sources.providers()).then((providers) => {
      send(res, 200, { version: 1, providers });
    });
  };
}
