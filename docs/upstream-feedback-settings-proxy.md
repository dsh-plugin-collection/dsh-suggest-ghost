# 上游反馈草稿：settings 远程代理的写冲突语义，与 `document-updated` 的事务内 emit

> **状态：待提交的草稿。** 尚未提交给 DSH 内核或 dsh-settings 维护者，也未收到任何回复。
>
> 收件对象：DSH 内核 / `@deepseek-ai/dsh-settings`、远程 settings 代理
> （`dsh-api-settings-controller`）、以及 `dsh-hmr` 的事务串行化维护者。
> 涉及版本：`@deepseek-ai/dsh-settings@0.2.0-rc.2`、
> `@deepseek-ai/dsh-api-settings-controller@0.2.0-rc.2`、
> `@deepseek-ai/dsh-api-gateway@0.2.0-rc.2`、`@deepseek-ai/dsh-hmr@0.2.0-rc.2`、
> `@deepseek-ai/cordis@4.0.1`（本机核对于 2026-10-19）。
> **2026-10-21 复跑所用版本**：实跑宿主 `@deepseek-ai/dsh-hmr@0.2.1-rc.2`、
> `@deepseek-ai/dsh-settings@0.2.1-rc.2`、`@deepseek-ai/dsh-config-editor@0.2.1-rc.2`、
> `@deepseek-ai/dsh-atomic-write@0.2.1-rc.2`、`@deepseek-ai/cordis@4.0.5`。
> 其中 `dsh-settings` 与 `dsh-config-editor` 的 `lib/index.js` 与 0.2.0-rc.2 **逐字节相同**
> （`cmp` 通过）⇒ 本文引这两包的行号在两代都成立；`dsh-hmr` 有位移（672 → 1465 行）但
> `runExclusive` 函数体逐字未变 ⇒ **语义未变，只是行号漂**。详见「机制链」与文末「复跑更正」。
> 报告方：dsh-suggest-ghost 插件（`src/client/index.ts` 的 `writeOps`，修复见 `a864545`
> 与本轮的 `src/client/settings-result.ts`）。
>
> 本文有三个诉求，**第二个比第一个更根本**，第三个是文档/默认值层面的（不改 API 也能少踩坑）：
>  - **诉求一**（冲突为何对客户端表现为成功）：机制本轮**已在源码里定位**，不再是未闭环
>    问题；现在请维护者确认「折进 `RemoteResult` 后照常兑现」是设计意图，并确认
>    `code` 的重映射（`SETTINGS_CONFLICT` → `settings/conflict`）是稳定契约。
>  - **诉求二**（新）：`settings/document-updated` 在 HMR 事务**内** emit，订阅方在自己的
>    回调里写 settings 必被 `HMR transactions cannot be nested` 拒绝，且该上下文沿
>    await/timer 传播、无法靠「推迟一个 tick」摆脱。本插件有实测数据：一个进程内
>    372/373 次 `_ops` 清空都是这个拒绝。
>    **2026-10-21 复跑限定（不改上面的历史结论，只标范围）**：判据复现成立（真事务内五种退路全
>    FAIL、同步拒绝 23–68ms、`revision` 零递增），但「必被拒」要限定为「**由事务内那次
>    `describe()`（`dsh-settings/lib/index.js:509`）触发的**事件」；`await edit(…)` 之后那次
>    `describe()`（`:536`）与订阅方自己读的 `describe()` 都在事务外 emit。另外 0.2.1 的
>    `dsh-hmr/lib/index.js:1321` 新增「`reconcileProfile` 必须在事务内」的反向断言，把事务边界
>    变**宽**了 —— 也就是说这条问题在新代次上更容易撞上，不是被修好了。

## 一句话

1. `SettingsForms.write()` 遇到 revision 不匹配会抛 `SettingsConflictError`；经由
   `ctx.remote.settings.mutate()` 提交同类写入时，**拒绝被折进 `RemoteResult` 的 error
   分支后照常兑现**，于是「写失败」在客户端侧表现为「Promise 成功」——而绝大多数调用方
   只读 Promise 状态。机制已定位（见下「环节在哪一层丢的」），我们要确认的是这是不是
   设计意图，以及 `code` 重映射是否是稳定契约。
2. `settings/document-updated` 是在 HMR 事务的 `AsyncLocalStorage` 上下文里 emit 的，
   因此订阅方在自己的回调里发起的任何 settings 写入都会被
   `HMR transactions cannot be nested` 拒绝；而这个上下文沿 await/microtask/timer
   继续传播，调用方**没有办法**靠自己「推迟到下一个 tick」摆脱它。我们要么需要一个
   显式的退出机制，要么需要该事件改为事务外 emit。
   > **2026-10-21 复跑修正这两句的范围**（详见「复跑更正」一节）：① 「任何写入都被拒」应为
   > 「**由事务内那次 `describe()`（`dsh-settings/lib/index.js:509`）触发的**回调里发起的写入都被拒」
   > ——同一事件若由 `await edit(…)` 之后的 `describe()`（`:536`）触发，回调里写得进；② 「推迟到
   > 下一个 tick」确实摆脱不了（真事务内五种退路实测全 FAIL，23–68ms、`revision` 零递增），但
   > **显式退出今天已可用**：`executing.exit()` 实测能写进去，只是它在类型面上是 private
   > （`dsh-hmr/lib/types/index.d.ts:89`）。所以诉求一请当作「转正既有内部能力」来看。

## 期望的行为（内核源码里确实是这么实现的）

`@deepseek-ai/dsh-settings/lib/index.js`：

```
501  async write(ns, change, expected, paths = []) {
511    if (expected !== void 0 && descriptor.revision !== expected) throw new SettingsConflictError(ns, expected, descriptor.revision);
```

`SettingsConflictError` 带稳定机器码与描述（`lib/index.js:165`、`lib/index.js:176`）：

```
code = "SETTINGS_CONFLICT"
message = settings namespace "<ns>" changed since it was read (expected revision <e>, now <a>)
```

`revision` 的语义在类型注释里写清楚了：`describe()` 视图上的单调版本，写时把它带回去，
过期编辑器应当被拒绝而不是静默覆盖（`lib/types/types.d.ts:37-40`）。

## 实际观测

dsh-suggest-ghost 的客户端把热度操作写进 volatile 字段 `_ops`，调用形态是：

```ts
remote.settings.mutate('suggest-ghost', [{ op: 'set', path: ['_ops'], value }], 0);
```

第三个参数固定传 `0`。宿主端每次写 `_push`、每次消费后清空 `_ops`
（`dsh-suggest-ghost/src/index.ts:653`、`src/index.ts:730`）都会推进该命名空间的
`revision`（`dsh-settings/lib/index.js:421-428`：`revision` 由 `describe()` 按内容指纹
增量推导，首次为 0，之后每次指纹变化加一），因此 `expected = 0` 在启动后的第一次写入
之后必然过期。

观测到的结果：客户端打印 `writeOps: mutate OK`（成功分支的日志，由 `d015864` 加入，
结论记录在 `a864545` 的提交说明中；main 现状已删除该日志），而随后 `describe()` 读回的
`_ops` 仍是旧值。也就是说：

1. 内核按契约拒绝了写入；
2. 拒绝没有到达发起写入的客户端；
3. 客户端把自己「从未生效」的写入当成了成功，并且没有任何返回信息能让它发现。

插件侧的修法是写前先 `describe()` 取当前 revision、按真实 revision 提交、冲突时重取重试
（commit `a864545`，`src/client/index.ts:1070-1094`）。这让功能可用，但没有解决「失败看起来
像成功」这个 API 语义问题，其他插件仍会踩。

## 为什么 resolve-不-reject 是危险的 API

- 唯一携带的返回值是「命名空间视图」。调用方拿到一个成功的 Promise 时，无法区分三种情况：
  写进去了、被冲突拒绝、被别的校验拒绝（如 `lib/index.js:507` 的
  `Config field "..." is not volatile`）。
- 这个 API 的正确用法要求调用方**额外**做一次读回校验才能确认写入生效。缺省形态把验证
  责任推给了调用方，而违反它的表现不是报错，是数据悄悄留在旧值上。
- 设置类写入的失败大多是低频、用户手动触发的：一次冲突可能等到用户下次打开设置页才被发现，
  而那时用户和开发者都会认为是「改了没生效」的 UI 问题，而不是并发控制拒绝。本仓库为定位
  第三个参数留了三个连续的诊断提交（`d015864`、`685045a`、`006c554`），之后才有 `a864545`。
- 冲突拒绝本身是有价值的设计（避免覆盖他人改动）；问题只在拒绝的信号被丢弃。

## 环节在哪一层丢的（本轮源码取证，0.2.0-rc.2）

```
@deepseek-ai/dsh-settings/lib/index.js:511
  if (expected !== void 0 && descriptor.revision !== expected) throw new SettingsConflictError(ns, expected, descriptor.revision);
      ↑ code = "SETTINGS_CONFLICT"（同文件 :165），message 含 "revision"（:176）

@deepseek-ai/dsh-api-settings-controller/lib/index.js:489,501-507
  settingsConflictOf(error) → new RemoteError("settings/conflict", conflict.message, {ns, expected, actual})
      ↑ 码在这里被换成远程 taxonomy；details 保留了 expected/actual

@deepseek-ai/dsh-api-gateway/lib/index.js:1425-1437   rpcFailure(error) → {ok:false, error:{code,message,details}}
@deepseek-ai/dsh-api-gateway/lib/client.js:2124-2126  rebuiltFailure(e) → new RemoteError(e.code, e.message, e.details)
@deepseek-ai/dsh-api-gateway/lib/client.js:1795-1802  invoke(): if (!result.ok) return {ok:false, error: rebuiltFailure(...)}
      ↑ 兑现，不是 reject

@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:60-73
  「The Remote face itself folds carrier failures into the error branch, so no consumer
   wraps a call to recover one; only assembly faults (arity, an unmounted method, a
   missing Context adapter) still reject.」
```

即：内核确实抛了，控制层也确实分类了，**丢信号的最后一步是「兑现一个带 error 的结果」这个
API 形状本身**。三点补充观察：

- 码是**跨传输层保留**的（`rebuiltFailure` 原样重建 `code`），但值被重映射过。
  所以上层要判 `settings/conflict`，判 `SETTINGS_CONFLICT` 会漏——这两个名字在不同层，
  很容易踩。我们建议文档里把「远程 taxonomy 的码表」当作公开契约写出来。
- 内核自己的设置页已经是按这个形状写的（`await ctx.remote.settings.mutate(...)` 之后
  读 `response.ok`，再按 `response.error.code === "settings/conflict"` 分支：
  `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2795-2805`）。也就是说
  「记得读 `ok`」目前是靠每个调用方各自发现，而不是 API 逼出来的。
- 成功分支带回的 `SettingsNamespaceView`（含 `revision: z.number()` 与整份 `value`，
  `dsh-api-settings-controller/lib/typert.remote-client.js:69-82`）其实**已经足够**让
  调用方做写后确认，无需额外 `describe()`。我们按这个把插件的判定做实了。
  如果能在返回结构里再加一个显式判别式（例如 `applied: boolean`），就能把「没生效」
  变成不可能被忽略的分支——这也是下面建议 2 的落点。

## 最小复现路径

以下 1-4 是从源码推导的路径，**尚未在本机以真实宿主跑通**（缺隔离 profile 下的双客户端环境）；
第 5 步的观测是本插件的实际记录。

1. 宿主与浏览器客户端都在运行，某插件声明了一个 volatile 字符串字段 `x`。
2. 客户端调用 `ctx.remote.settings.mutate(ns, [{op:'set', path:['x'], value:'A'}], 0)`。
   若这是本进程该命名空间的第一次写入，成功。
3. 宿主端做任意一次会导致该 ns 配置内容变化的写入（例如同插件的
   `ctx.settings.update(ns, { y: ... })`）。
4. 客户端再用同一个 `expected = 0` 调用 `mutate`。
5. 观察点：客户端 Promise 是否 reject；随后 `describe()` 里该 ns 的 `x` 是否还是旧值。
   本插件在 5 处看到的是 resolve + 旧值。

## 建议的 API 语义（按侵入性从小到大）

1. **冲突必须 reject**（最小改动）：远程代理保持 Promise 语义与本地
   `SettingsForms.mutate()` 的抛错一致，把 `code: 'SETTINGS_CONFLICT'`、
   `expected`、`actual` 一并带到客户端，让调用方能分辨「过期」与「其他失败」。
2. **或者返回实际写入结果**：`Promise<SettingsNamespaceView>` 已经在成功时带回 `revision`
   （`dsh-api-settings-controller/lib/typert.remote-client.js:69,81`）。若不想让冲突成为
   reject，就给结果加上显式的判别式，例如 `{ applied: boolean, revision: number, code?: ... }`，
   让「未应用」是一个必须被读到的分支，而不是一个可以忽略的 Promise 状态。
3. **可选参数带来的静默**：`expectedRevision?` 在本地接口和远程 schema 里都是可选的
   （`dsh-settings/lib/types/index.d.ts:114`；`typert.remote-client.js:67` 声明为
   `undefined | number`），省略即完全跳过比较（`lib/index.js:511` 的 `expected !== void 0`）。
   对「跨进程写入」而言，默认无并发控制与「默认覆盖」几乎同样危险，建议远程形态要求显式
   传参或显式传 `{ mode: 'force' }` 之类的意图声明。
   注：插件侧曾观测到远程层因少传该参数直接报错，记录文本为
   `settings/mutate expected 3 argument(s), got 2`（`src/client/index.ts:87-92`），而该文本
   在本机 0.2.0-rc.2 产物里检索不到。这个 arity 门禁是哪一层、哪个代次加的，需要维护者确认；
   它也可能正是丢错误的那一层。

## 诉求二：`document-updated` 的事务内 emit 让订阅方无法回写

**现象与数据**（本机 `~/.dsh/dsh-web.log`，同一进程内计数）：

| 观测 | 次数 |
|---|---|
| `_ops` 清空失败 `HMR transactions cannot be nested` | 372 |
| `_ops` 清空失败 `atomic-write: timed out waiting for the writer lock` | 1 |
| `_ops` 清空成功 | 0 |
| `consumeOps` 消费 `complete` op | 169（消费本身成功） |

**机制链**（逐处 file:line。2026-10-21 已在实跑宿主 `0.2.1-rc.2` 复跑：`dsh-settings` 与
`dsh-config-editor` 的 `lib/index.js` **两代逐字节相同** ⇒ 它们没有行号位移；有位移的只有
`dsh-hmr`，且 `runExclusive` 的函数体两代逐字未变）：

```
dsh-config-editor/lib/index.js:134      await (hmr === void 0 ? run() : hmr.runExclusive(run));   ← 两代同一行
dsh-hmr  executing = new AsyncLocalStorage()                       （0.2.0 :271 / 0.2.1 :736）
dsh-hmr  if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"));
                                                                       （0.2.0 :280 / 0.2.1 :749）
dsh-hmr  return this.executing.run(true, operation)                （0.2.0 :283 / 0.2.1 :752）
           ↑ 原文这里记的「0.2.0 是 :284」是错的：:284 是紧随其后的 `});`，已更正。
dsh-settings/lib/index.js:508           await this.ownerContext.configEditor.edit(entry, (raw, inherited) => {
                                            const descriptor = this.describe()...   ← 事务内（:509）
           ↑ 原文记的 :510 是下一行 `descriptor === void 0` 的抛错，已更正；两代行号相同。
dsh-settings/lib/index.js:435           ...this.ownerContext.emit("settings/document-updated", entry.options.id, revision);
           ↑ 两代同一行；另有 :461 第二处 emit（条目转 inactive），0.2.1 没有新增 emit 点。
```

于是：**由这一次「事务内 `describe()`」触发的 `settings/document-updated` 回调里（含该回调的任何
await 续体）发起的 settings 写入，必被拒**。而「消费完清空队列」「应答 pull」「续写完成后推载荷」
这些再正常不过的反应式写入，全都长在这个回调上。

> **范围限定（复跑新增，请维护者一并确认）**：`write()` 里 `describe()` 有**三类调用点**，
> 只有第①类在事务内——① edit 回调内（`:509`）、② `await edit(…)` **之后**那次（`:536`，跑在调用方
> 上下文，`getStore()` 为 `undefined`）、③ 插件/订阅方自己读的 `describe()`。同一个回调被①触发时
> 写不进、被②③触发时写得进。这解释了为什么插件侧曾同时留下「全 FAIL」和「handler OK」两组
> 互相矛盾的观测（issue #36 复核评论 `#issuecomment-37810` 有逐条实测表）：判据本身没错，
> 差在**是哪一次 `describe()` emit 的这一次事件**。

**调用方自救不了**，我们实测过四条路：

| 做法 | `executing.getStore()` | 结论 |
|---|---|---|
| 回调里直接 `settings.update()` | `true` | 拒绝 |
| `await Promise.resolve()` 之后再写 | `true` | 拒绝 |
| `queueMicrotask(...)` 里写 | `true` | 拒绝 |
| 回调里 `setTimeout(..., 5)` 里写 | `true` | 拒绝（ALS 上下文随 timer 一起传播） |
| 事务**外**建的 `setTimeout` / `new AsyncResource()` 里写 | `undefined` | 可以通过 |
| 事务**内**建的 `AsyncResource`，3s 后 `runInAsyncScope` 里写（2026-10-21 补测） | `true` | 拒绝 |
| 事务**内**建的 `setTimeout`，**等事务关闭后** 5s 才触发（2026-10-21 补测） | `true` | 拒绝 |
| 事务**内**用 `hmr.executing.exit(() => settings.update(...))`（2026-10-21 补测） | `undefined` | **可以通过** |

最后一行是唯一的出路，但它要求调用方**持有一个建立于事务之外的锚点**。插件侧没有可靠的
这样的锚点：`apply(ctx)` 本身就可能跑在配置重载事务里（`dsh-hmr/lib/index.js:289` 的
`runReload` 也在 `runExclusive` 内），所以在启动期捕获的 `AsyncResource` 有可能一开始就
带着 `true`。让每个订阅方去赌锚点的时机，不是一个可写进文档的规则。

> **复跑补充（2026-10-21，隔离沙箱，实跑宿主 `0.2.1-rc.2`）**：
> 1. 上面这张表在真事务里全部复现，且拒绝是**同步**的——实测 23–68ms 即失败、`revision` 零递增
>    （`dsh-hmr/lib/index.js:749` 直接 `Promise.reject`，不进锁也不进 reconcile）。
> 2. `runReload` 的行号请维护者按代次看：`0.2.0` 声明在 `:288`、它调 `runExclusive` 在 `:289`
>    （原文只写 `:289` 容易被读成声明行）；`0.2.1` 对应 `:757` / `:758`。
> 3. **更重要**：正文那段说的「唯一出路」指补测前表格的第五行（事务**外**建的 `setTimeout` /
>    `new AsyncResource()`）；而今天其实已经存在一条更直的退出手腕——补测新增的 `executing.exit()`
>    那一行，实测 1438–1524ms 写成功、`revision` 递增。它不需要调用方赌锚点
>    时机。这直接改变下面「诉求一的修法 1」的性质：**不是请内核造新机制，而是把内核自己已经在
>    用的能力（`dsh-hmr/lib/index.js:772`，0.2.0 是 `:303`）转正**。今天它只是没进类型面：
>    `executing` 在 `@deepseek-ai/dsh-hmr/lib/types/index.d.ts:89` 声明为
>    `private readonly executing`（同文件 `runExclusive` 是 public，`:101`），插件靠运行时字段访问
>    才摸得到——我们不会把这种拿法当受支持用法，所以才提出诉求一。
> 4. 还有一种**与事务无关**的写失败，请一并考虑：`atomic-write: timed out waiting for the writer
>    lock`（`dsh-atomic-write/lib/index.js:208`，0.2.0 是 `:206`；上限
>    `DEFAULT_LOCK_WAIT_MS = 2e3`，`:164` / 0.2.0 `:163`）。`dsh-config-editor/lib/index.js:72` 调
>    `withFileLock` 时不传 options，所以两笔在事务外发起的写一旦重叠超过 2s，后到那笔就这样失败；
>    一次事务外的写锁空闲时实测 191–332ms，与另一笔重叠可到 1.4–2.5s。它的报文与 nested 拒绝
>    完全不同，但上层同样只看到一个被拒的 Promise。

**我们建议的修法（按侵入性从小到大）**：

1. **提供显式退出**：`dsh-hmr` 已经在自己的 `watchConfig` 里用了
   `this.executing.exit(...)`（`dsh-hmr/lib/index.js:303`，0.2.1 是 `:772`），把这个能力以受控形式暴露给
   订阅方即可（例如 `hmr.runDetached(fn)` 或 `ctx.settings.writeOutsideTransaction(fn)`），
   并写明「事件回调内回写 settings 必须走它」。**2026-10-21 复跑更新**：这条不需要新机制——
   运行时直接 `executing.exit()` 已经能用（实测写成功、`revision` 递增，见上面复跑补充第 3 条），
   缺的只是它不在类型面上（`lib/types/index.d.ts:89` 的 `private readonly executing`）。
   请把它从「内部实现细节」升为「有支持的公开面」，并说明它与 `runExclusive`（`types/index.d.ts:101`，
   public）的关系；否则插件只能靠运行时字段访问，而那不构成为它兜底的契约。
2. **把 `document-updated` 改成事务外 emit**（把 `describe()` 里那次 emit 排到当前事务
   结束后再广播）。代价是订阅者看到的事件可能落后于实际文档状态，但至少回调里的写入是
   合法动作，而不是注定失败的静默 no-op。注意 `SettingsForms.write()` 在 edit 回调内调
   `describe()` 只为读一次 `descriptor.revision` 做比较（`dsh-settings/lib/index.js:509`；
   原文记的 `:510` 是 `descriptor === void 0` 那行，已更正）——
   如果那次内部 `describe()` 不 emit（或者提供一个不发事件的内部读取面），这条链就断了。
   **2026-10-21 复跑补充**：这条链其实**已经断了一半**——`write()` 在 `await edit(…)` 之后还有一次
   `describe()`（`:536`），它跑在调用方上下文里、`getStore()` 为 `undefined`。所以插件侧今天同时
   观察到「回调里写被拒」和「回调里写得进」，取决于事件由哪一次 `describe()` emit。请维护者明确
   哪一种才是设计意图：现在这个「同一事件有两种可信度」的状态比全 FAIL 更难推理。
3. **最低成本**：把 nested 拒绝从 `Promise.reject(new Error(...))` 换成带稳定码的失败
   （现在只有一句人读文本，上层无法可靠分诊），并在 `dsh-settings` 文档里明确写
   「settings 事件回调内不可再写 settings」。我们插件现在靠自己 `text.includes('cannot be nested')`
   来分诊这一类（见 `src/index.ts` 的 `traceFault('ops-clear-nested', ...)`），这是不该
   由文本匹配承担的分支。

**我们接受的反驳**：如果 (1)(2) 都不打算做，那么请明确「反应式写入必须挂在自己的定时器/
非 ALS 锚点上」是有支持的用法，并给出推荐锚点。目前我们只能把它记为「结构性失败 + 分诊
留痕」，并在 `docs/internals-cordis-settings-pitfalls.md` 陷阱 1.5 里按插件经验引用。

## 诉求三：HMR reload 不回收插件挂在 root 上的监听器，dispose 会——两条路径语义不一致

**症状**（2026-10-22 live，本插件「续写幽灵永不出」的最终根因）：插件因
`settings/document-updated` 的 ownerContext 问题必须 `root.on(...)` 注册监听（cordis 事件只
向上传播，插件 ctx 收不到服务 ownerContext 上的 emit）。HMR `partialReload` 重跑 `apply()`
之后，**旧 fiber 经 `root.on` 挂上的 handler 仍然收事件**：它闭包里的旧 `ctx` 已 inactive，
走到 `ctx.sessions` 时抛 `cannot get required service "sessions" in inactive context`，
批次在事件分发里炸穿——新 fiber 的 handler 收不到该事件（或被僵尸的 payload 守卫抢先），
`_ops` 从此滞留盘上。本机一天重载 28 次，僵尸最多叠 28 层。

**probe 实测（`@deepseek-ai/cordis` 4.0.x，最小复现）**：

```
a = root.extend(); b = root.extend();
a.root.on('t/e', A); b.root.on('t/e', B);   // 两个都注册在 root 上
root.emit('t/e')            → A、B 都收到
await a.fiber.dispose();    // 手动 dispose
root.emit('t/e')            → 只有 B 收到 —— dispose 把 A 的 handler 回收了
```

也就是说 **`fiber.dispose()` 会回收该 fiber 在任何对象上注册的 handler（owner 记的是注册时
的 ctx），但 loader 的 `partialReload` 路径没有走这套回收**（或 reload 时 handler 的 owner
归属与首次装载不同）。同一个「fiber 生命周期结束」，两条路径给出两种监听器语义——插件侧
唯一可靠的对策是**自己把 `on` 的返回值接住、挂进 `ctx.effect` 的清理**（effect disposer 在
两条路径都跑），本仓已照此修（`src/index.ts` 的 `offDocumentUpdated`）。

**请求**（按侵入性从小到大）：

1. **对齐语义**：`partialReload` 的 unload 阶段执行与 `fiber.dispose()` 相同的 handler 回收
   （owner 归属同一张表）。这是最小改动，且让「root.on 需要手动 off」这个隐性要求消失。
2. **或者文档化**：明确「跨 ctx 生命周期注册的监听器（`x.root.on` / 别的 ownerContext 上的
   `on`）不由 reload 回收，插件必须自持 off 并挂 effect」——现在这条只存在于插件踩坑文档
   （本仓 `docs/internals-cordis-settings-pitfalls.md`），内核侧没有任何出处。
3. **顺带**：`cannot get required service "sessions" in inactive context` 这个抛错发生在
   事件分发里时，cordis 是否吞掉、是否影响同事件后续 handler——请给一个明确契约
   （本仓已按「会炸穿同批后续 handler」防御：handler 内自带 try/catch + 留痕）。

**我们接受的反驳**：如果 (1) 有性能或时序上的理由不做，(2) 必须做——插件现在按「dispose
会回收」写的代码在 reload 路径下静默变成监听器泄漏，这是两条路径不一致造成的**默认错误**，
不该靠踩坑文档传播。

## 我们接受的反驳

这一条已经不需要反驳了——机制在源码里定位到了（见「环节在哪一层丢的」），远程面**设计上
就是不 reject**。所以我们想从维护者那里得到的答案换成两个问题：

1. 「失败折进 `RemoteResult` 的 error 分支后照常兑现」是**长期契约**还是当前实现的偶然？
   若某天改成 reject，只读 `ok` 的调用方会突然开始看到 unhandled rejection（我们两侧都
   做了兼容：`ok === false` 与 reject 分支走同一套分诊）。
2. `SETTINGS_CONFLICT` → `settings/conflict` 的重映射会不会随版本变动？如果远程 taxonomy
   的码表是公开契约，请写进文档，我们好只认一个码而不是两个。

在拿到答复之前，本仓库按「API 形状如此、调用方必须读兑现值」处理：判定与写后确认已做实
（`src/client/settings-result.ts` + `scripts/ops-write-verify-smoke.mjs`），文档见
`docs/internals-cordis-settings-pitfalls.md` 陷阱 1。

## 复跑更正（2026-10-21，实跑宿主 `0.2.1-rc.2` + `cordis@4.0.5`，隔离沙箱**实测**）

这一节不改动上面的历史观测记录，只把复跑得出的四条事实集中列给维护者：

1. **事务边界的判据没变，但 0.2.1 上它更宽。** `dsh-hmr` 的 `runExclusive` 函数体在
   `0.2.0-rc.2:279-287` 与 `0.2.1-rc.2:748-756` 之间**逐字相同**（`diff` 空）；而
   `0.2.1-rc.2` 的 `dsh-hmr/lib/index.js:1321` **新增**了一条反向断言
   （`reconcileProfile` 里 `if (this.executing.getStore() !== true) throw "HMR profile reconciliation must run inside runExclusive"`，
   0.2.0 没有这条，`reconcileProfile` 也不在 `dsh-hmr` 里）。它把「必须在事务内」也变成硬约束，
   profile 级对账整体进事务 ⇒ 订阅方回调撞上 nested 拒绝的窗口**变大**。请把它当作诉求二的
   严重度输入，而不是「新一代次已经修好」。
2. **`document-updated` 的事件有两种可信度**（不是两个代次）：`dsh-settings/lib/index.js` 里
   `describe()` 的调用点是①edit 回调内 `:509`（**在事务内**）、②`await edit(…)` 之后 `:536`
   （**在事务外**）、③订阅方自己读的 `describe()`（事务外）。同一个回调被①触发时写不进、被②③
   触发时写得进。这就是插件侧同时留下「四种推迟全 FAIL」和「handler 里写得进」两组矛盾记录的
   原因（复核：issue #36 评论 `#issuecomment-37810`）。请明确哪一种才是设计意图。
3. **诉求一的能力已经存在，只是没进类型面**：事务内
   `root.get('hmr').executing.exit(() => settings.update(…))` 实测**写成功**（1438–1524ms、
   `revision` 递增、`getStore()` 由 `true` 变 `undefined`）。`executing` 目前是
   `@deepseek-ai/dsh-hmr/lib/types/index.d.ts:89` 的 `private readonly executing`，而
   `runExclusive` 在同文件 `:101` 是 public；内核自己已经在 `dsh-hmr/lib/index.js:772`（0.2.0 `:303`）
   用它。所以这条诉求是「把已有内部能力转正 + 写明用法」，成本远低于新机制。
4. **还有第三种失败与事务无关**：`atomic-write: timed out waiting for the writer lock`
   （`dsh-atomic-write/lib/index.js:208`，0.2.0 `:206`；`DEFAULT_LOCK_WAIT_MS = 2e3`，`:164` /
   0.2.0 `:163`）。`dsh-config-editor/lib/index.js:72` 不传 options ⇒ 调用方无法调这个上限。
   两笔**都在事务外**的写重叠超过 2s 就后到那笔失败；锁空闲时一次事务外写实测 191–332ms，重叠时
   可达 1.4–2.5s（因为一次 volatile 写 = 一次全量 profile reconcile + 一次整文档原子写，见
   `dsh-config-editor/lib/index.js:123` 全文写与 `:125` 写后 reconcile）。请求：给
   `withFileLock` 的等待上限留出可配置面，或把「重试用尽」与「结构性拒绝」在报文里区分开
   （这与诉求三的「带稳定码」是同一条）。

## 发出前要补的证据

- [x] ~~区分「内核没收到」与「内核拒绝但没回传」~~ —— 已在源码层定位（见「环节在哪一层
      丢的」）：内核抛了、控制层分类了、远程面折进 error 分支兑现。仍需在真实宿主上复跑
      一遍 1-5 步以确认代次一致性，但结论不再依赖它。
- [x] ~~诉求二需要一次可控复现~~ —— **2026-10-21 已做**：隔离沙箱实例（实跑宿主
      `0.2.1-rc.2`，插件私有副本 + 临时 ALS 探针，整进程重启三轮），用 `hmr.runExclusive(…)`
      建立真事务后逐条写同 ns 的 volatile 字段。结果：五种「推迟」写法全 FAIL（23–68ms、
      `revision` 零递增），`executing.exit()` 一条 OK（1438–1524ms、`revision` 递增）；
      事务外建立的锚点全 OK（boot 首笔 2.2–2.5s，其余 191–332ms）。逐条表见
      `docs/internals-cordis-settings-pitfalls.md` 陷阱 1.5 与本文件「复跑补充」。
- [x] ~~确认观测所用的内核代次~~ —— **2026-10-21 已核**：事故记录（372/373 那组）出自
      `0.2.0-rc.2` 一代；本轮复跑在 `0.2.1-rc.2` 上判据不变（`dsh-hmr` `runExclusive` 函数体
      两代逐字相同）。`dsh-settings` / `dsh-config-editor` 两代 `lib/index.js` 逐字节相同 ⇒
      本文件引这两包的行号无需按代次换算；只有 `dsh-hmr`（`:271/:280/:283` ↔
      `:736/:749/:752`）与 `dsh-atomic-write`（`:188/:206/:163` ↔ `:189/:208/:164`）需要标代次。
- [ ] 用 `code === 'SETTINGS_CONFLICT'` 而不是文本匹配做一次判定，确认客户端能否拿到该码
      （当前插件代码靠 `/conflict|revision/i` 匹配文本，`src/client/index.ts:1086`）。

## 环境

dsh-suggest-ghost 分支 `fix/issue-16-18-cleanup`，基线 commit `1eb708d`；本文行号与 diff
核对于该基线。内核侧行号核对于本机
`@deepseek-ai/dsh-settings@0.2.0-rc.2`（2026-10-19）。

**2026-10-21 复跑记录**：内核侧在实跑宿主 `0.2.1-rc.2` + `cordis@4.0.5` 上重核（安装包
`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`），代码基线 `fe2dd17`。运行时观测来自
隔离沙箱 `~/dsh-sbx-hmr`（`DSH_HOME` 独立、GUI 随机端口、profile 副本监听端口改走 `--rewrite`），
ALS 探针只打进**沙箱私有副本** `~/dsh-sbx-hmr/plugin/lib/index.js`，**未回拷仓内**：仓内 `src/` 与
`lib/` 与该 commit 的 HEAD 一致（`grep -c "__alsProbe" lib/index.js src/index.ts` 均为 0）。
本文件「复跑更正」一节引用的实测数字都出自这三轮。

## 诉求三：三个默认值/文档层面的缺口，让插件作者以为"必须重启"

都不是 API 变更请求，是**默认值与文档**层面的，成本极低但每人都要重踩一遍：

1. **`hmr` 的 `root: []`**。base bundle 用它启用 HMR，README 写明空数组时"只保留 explicit
   configuration watches"。后果是：默认配置下**没有任何模块源码被监听**，插件作者的第一反应就是
   "改宿主代码必须重启"。而第二层更隐蔽：默认 `ignored` 含 `**/node_modules`，开发期插件是 `link:`
   挂在 `profiles/<p>/node_modules/<包名>` 下的，所以**即使把 root 恢复成 `["."]` 也监听不到它**。
   请求：在插件开发文档里把这两条写在一起（现在分开写在两处，单看任一条都得不出正确结论），
   或提供一个"开发用" profile 模板把 root/ignored 一起配好。
2. **`ctx.logger` 在健康进程里不落任何地方**。全局唯一 exporter
   （`dsh-app-boot` 的 `boot()` 里唯一一个 exporter；0.2.0 在 `:4053-4066`，0.2.1 在 `:4513-4515`）
   `levels:{default:2}` 丢 debug、回调只收 warn/error 所以
   info 也丢，而 `startupLogs` 只在启动失败时由 `dsh/lib/bin.js:158` 写盘。后果是插件作者把诊断
   写进 `logger.debug/info` 后**什么都看不到**，会误判成"代码没执行"（本仓 issue #20 记过一次），
   或者反过来把 `console.log` 当唯一出路、再被下一轮"清理调试噪声"删掉语义留痕。
   请求：给运行期日志一条正式落点（哪怕就是把 info 收到一个可 tail 的文件），并在文档里写清
   "插件里的诊断该往哪儿打"。
3. **`volatile()` 字段是否持久化没有明确契约**。本插件的 `_ops`/`_push` 实测写在 profile 文档里
   （`cordis.patch.yml` 中能看到两行），而插件代码里此前普遍按"不落盘"假设写注释与判据。
   叠加诉求二（消费后回写清空被事务拒绝），实际行为是"载荷长期滞留 + 新实例启动即重放"。
   请求：文档明确 volatile 字段的持久化语义（写在哪、何时被清、重启后是否可见）。

