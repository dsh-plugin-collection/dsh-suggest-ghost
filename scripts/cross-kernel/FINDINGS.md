# 跨内核代次验证 · 已验证事实台账

本文件只登记**已被复现**的事实，每条都带可复核的现场。未判定的单列在末尾，
不许写成结论。跑法见同目录 `generations.mjs` 与各 runner；本文件是结论的索引。

被测插件：`dsh-suggest-ghost@0.8.0`（§8–§19 那几段是在 `0.7.0` 上跑的，都逐段标了构建号 —— **别拿旧段的结论套新构建**，尤其是 §9 那条"当前不可复跑"）。

> ## ⚠️ 现状（2026-10-26 删除 0.1.1-rc.2；2026-10-30 登记 0.2.2-alpha.2）
>
> 本文后面大量段落提到 0.1.1-rc.2，那些是**历史记录**（记录它曾经怎么坏、怎么修），
> 不是"当前仍支持"。当前支持 **6 个代次**：0.1.2-rc.1 / 0.1.5-rc.**3** / 0.1.7-rc.1 /
> 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 —— 注意这一格今天是 **rc.3** 那棵自洽树，
> `0.1.5-rc.1` 的树已不存在（§9），那一代的旧结论属历史。
> 另登一条**预发布线** `0.2.2-alpha.2`（§20，装配/门禁/类型/投影四面绿、UI 面未判定），
> 它**不在**上面那 6 个"支持"里，也不构成对 `0.2.2` 正式版的承诺。
>
> **删除原因（硬约束，不是"没修"）**：本插件 client 的 `inject` 含 `remote.settings`，
> 而 0.1.1 的前端没有该服务——`dsh-api-remotes/lib/client.js` 里 `settings` 命名空间
> **0.1.2 才出现**（0.1.1 的官方设置 UI 走 `connection.api.settings`）。
> cordis 对 `inject` 是**静态 park**：声明了拿不到就整条 fiber 不激活。
> 实测加一个不存在的 `remote.NOPE`，报错与 0.1.1 上一模一样
> （`pending (waiting for service: …)`）——即"缺服务"与"写错服务名"不可区分。
>
> 两条改法都堵死：① 去掉 `remote.settings` 的 inject ⇒ 0.2.1 上直接
> `dsh-suggest-ghost: failed`（属性读被 Proxy 拦，这正是当初必须声明它的原因）；
> ② 按代次声明两套 inject ⇒ `inject` 是模块级静态数组，做不到。
> 唯一可行的是改成注入 `connection` 再运行时择路，但那要重验另外六代的 GUI，
> 且本机这棵树被 npm 重装过（198 → 196 包），修好也无法证明对原始 0.1.1 有效。

## 0. 声明面（被测对象）

```
engines.dsh       >=0.1.2-rc.1 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0
6 × dsh-* peers   ^0.1.2-rc.1 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.2
```

`engines.dsh` 是一个**单条范围**，不逐代枚举。

> **为什么 peer 里没有逐字写 `0.1.7-rc.1` 却仍然覆盖它**：`^0.1.2-rc.1` 展开是
> `>=0.1.2-rc.1 <0.2.0-0`，在 `includePrerelease: true`（内核口径）下匹配 0.1.7-rc.1。
> 「逐字枚举」≠「范围匹配」，别把这读成缺口。

## 1. 门禁面：`engines.dsh` 在大多数代次上根本不执行

| 代次 | 导出 evaluator | 读 `engines.dsh` | 该代次实际执行的口径 |
|---|---|---|---|
| 0.1.1-rc.2 | 否 | — | 无门禁 |
| 0.1.2-rc.1 | 否 | — | 无门禁 |
| 0.1.5-rc.1 | 否 | — | 无门禁 |
| 0.1.7-rc.1 | 是 | **否** | 仅 peer |
| 0.1.7-rc.2 | 是 | **否** | 仅 peer |
| 0.2.0-rc.2 | 是 | **否** | 仅 peer |
| 0.2.1-rc.2 | 是 | 是 | 仅 `engines.dsh`（peer 被忽略） |
| **0.2.2-alpha.2**（2026-10-30 新增，§20.4） | 是 | 是 | 仅 `engines.dsh`（peer 被忽略） |

复核物：`out/gate.json`；门禁实现 `~/dsh-versions/<v>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
（0.1.7-rc.1/rc.2/0.2.0-rc.2 在 `:286`，0.2.1-rc.2 在 `:311`）。

**这一条是本次验证最重要的结论。** 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 三个代次
**导出**了 `evaluatePluginCompatibility`，但它在那三代里**完全不读 `engines.dsh`** ——
把 `engines.dsh` 改成 `>=9.0.0` 这种无意义的值，在这三代上依然返回「兼容」。
只有 0.2.1-rc.2 真正执行 `engines.dsh`。

后果：本插件那条 `>=0.1.2-rc.1 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0` 声明，
在**当时那 7 个代次**里只有 **1 个**（0.2.1-rc.2）会被内核真正执行；在 0.1.1/0.1.2/0.1.5 上
连 evaluator 都没有。也就是说**这条声明在多数代次上是不可执行的文本**，
准入实际由 peer 枚举承担（见 §2：两套口径结论一致，覆盖上没有洞）。

> ⚠️ **2026-10-30 更正本段那两个读数**（原文是"7 个代次里只有 1 个"与"6/7 的代次"）：
> 那两句写于 `0.1.1-rc.2` 已删除之前、也写于 `0.2.2-alpha.2` 登记之前。**今天的口径**：
> 代次表 7 条（§20.5），其中**读 `engines.dsh` 的有两个** —— 0.2.1-rc.2 与 0.2.2-alpha.2；
> 有闸但不读 `engines.dsh`（仅 peer）的有三个；**根本没有闸**的有两个（0.1.2-rc.1 / 0.1.5-rc.3）。
> 结论方向不变（`engines.dsh` 在多数代次上仍是不可执行的文本），别照抄那个计数。

## 2. 声明与语义的一致性：无矛盾

用被测那一代自己的 evaluator，对真 manifest 逐代跑：

- **当时那 7 代**（含尚未删除的 `0.1.1-rc.2`）**全部**通过（evaluator 返回 `undefined` = 无未满足项）。
  今天这张表同样是逐代 MET，其中新登记的 `0.2.2-alpha.2` 见 §20.4 那条 `[GREEN]`。
- `^0.1.2-rc.1` 展开为 `>=0.1.2-rc.1 <0.2.0-0`，**匹配** `0.1.7-rc.1`
  （`includePrerelease: true`，内核即用此口径；本仓在删除 `0.1.1-rc.2` 之前写的下界是 `^0.1.1-rc.2`，
  那条范围同样覆盖 0.1.7-rc.1 —— 两句是同一件事的两个时期）。
- `^0.2.0-rc.2` 匹配 `0.2.1-rc.2`，也匹配 `0.2.2-alpha.2`（§20.4）。

> 撤回一条本仓内部的中间结论：曾据「peer 枚举里没有逐字写 `0.1.7-rc.1`」推断
> 声明与执行口径不一致。**该推断错误**：「逐字枚举」≠「范围匹配」，
> `^0.1.1-rc.2` 的范围已经覆盖它。由 gate-runner 指出并复核。

RED 路径可达（`--self-test` 用双向不满足的 manifest 触发 exit 1），
但**没有任何一个代次触发它** —— 本插件不存在声明不足。

## 3. 功能面：投影单元在 0.1.1-rc.2 上不落地（**已复现 → 已修 → 复验转绿**）

> **状态：已修复（2026-10-26）。** 本节保留缺陷的完整成因作为记录；修法见 §3.1。
> 修复后 `npm run verify:kernels` 与 `mount-run.mjs` 两套独立实现均 **7/7 GREEN、exit 0**。

插件按 `typeof registry.cachedSnapshot === 'function'` 二选一代际形状
（原 `src/index.ts:2817`、legacy 分支 `:2834-2838`，**已删除**）。

**为什么这个探针在 0.1.1-rc.2 上必然读错**（两条独立验证一致）：

`cachedSnapshot` **不在** `dsh-session-projection` 的注册表上，它定义在
`dsh-session-projection-cache/lib/index.js:140`。而 0.1.1-rc.2 的
`dsh-base/cordis.patch.yml` 只挂了 `dsh-session-projection`（`:126-127`），
`dsh-session-projection-cache` 只出现在 `dsh-web-app/cordis.patch.yml` 里 ——
本装配面（dsh-base 层）根本不含它。于是 `registry.cachedSnapshot` 是 `undefined`，
插件选 **legacy 形状**。

**而 legacy 形状在所有代次上都不被消费**（品牌 register 只认 `stateSchema` / `wire`，
见下）。两条独立实现都量到同一结果：

| 代次 | apply 落痕 | 投影注册 | 形状 | 判定 |
|---|---|---|---|---|
| 0.1.1-rc.2 | Y | 是 | **stateSchema/wire 两者皆无** | **RED** |
| 0.1.2-rc.1 | Y | 是 | modern | GREEN |
| 0.1.5-rc.1 | Y | 是 | modern（混合树，见 §4） | GREEN |
| 0.1.7-rc.1 | Y | 是 | modern | GREEN |
| 0.1.7-rc.2 | Y | 是 | modern | GREEN |
| 0.2.0-rc.2 | Y | 是 | modern | GREEN |
| 0.2.1-rc.2 | Y | 是 | modern | GREEN |

复核物：`out/mount-<stamp>.json`（Lead 实现）与 `out/replay.json`（script-porter 实现），
两套独立代码得到同一张表。0.1.1-rc.2 的原始值：
`{"modernShape":false,"legacyShape":false,"hasSchema":false,"hasTopView":false,"hasStateSchema":false,"hasWire":false,"stateVersion":2}`
—— 即「注册成功，但两种形状都不是」。

**精确定义（这条被修正过两次，写死在这里）**：不是「没有 stateSchema 槽位」，
而是**槽位在、值为 `undefined`**。0.1.1-rc.2 上
`Object.getOwnPropertyDescriptor(def,'stateSchema')` → `{value: undefined, writable: true, enumerable: true, configurable: true}`，
`wire` 同。所以 `'stateSchema' in def === true` 而 `def.stateSchema === undefined`。
差别不是措辞：**它把责任从内核移到插件** —— 内核只是照单全收并把不认识的字段写成
`undefined`，是插件**递错了形状**。

> 判据纪律：`in` 与「取值」不是一回事。本仓先后有人用 `'x' in def` 读成
> `stateSchema=true`，又有人据此写成「没有这个字段」，两次都错，方向相反。

机制（复核物：`dsh-session-projection/lib/index.js`）：

- `:51-62` `register()` 只读 `definition.stateSchema` 与 `definition.wire`，
  legacy 的 `schema` / 顶层 `view` 被整个丢掉，两个槽位照写 `undefined`；
- `:125` / `:199` `if (registration.def.wire === void 0) continue;` —— **静默跳过**，
  不抛错；
- `:204` / `:243` `def.stateSchema.parse(row.val)`。

**分界线是一个方法的存废，不是猜出来的版本阈值**：
`cachedSnapshot` 在 0.1.1-rc.2 的 `dsh-session-projection` 里 grep 计数 **0**，
在 0.1.2-rc.1 里是 **1**（`dsh-session-projection/lib/index.js:165`）——所以探针
到 0.1.2-rc.1 才开始选中 modern 分支，0.1.1-rc.2 是唯一的红。

> 一句反直觉但已复现的事实：`register()` 在**每一代**都把入参擦成新形状。
> 我把 legacy 形状分别注册进 0.1.1-rc.2 / 0.1.2-rc.1 / 0.2.1-rc.2，**三代全部不落地**。
> 所以准确说法是「legacy 分支在任何内核上都不是可用路径」，
> 0.1.1-rc.2 只是**恰好会让这个探针选中那个死分支**的代次。
> 修复方向在插件侧（探针不该用 `cachedSnapshot` 分代），不在内核侧。

**未做的更强断言**：没有真的驱动一个回合去看投影「不物化」的现场——那需要模型。
所以这是**注册面**的红（形状与宿主消费面不匹配），不是「用户看到功能坏了」的现场红。

### 3.1 修法与复验（2026-10-26）

**结论先说：不需要删除 0.1.1-rc.2 的兼容声明。** 坏的是那段按探针分代的代码，
不是那个代次。删掉分支即可，改动 1 处、约 20 行。

改动（`src/index.ts` 的投影注册，净减 1 个分支）：

- 删掉 `else` 分支（legacy 的 `schema` + 顶层 `view`）与 `is02` 探针，
  以及随之无用的 `cachedSnapshot?: unknown` 类型字段；
- 无条件注册 modern 形状（`stateSchema` + `wire.viewSchema` / `wire.view`）；
- 注释改写成"为什么不分代"，并写明原注释里"两代形状在对方类型里都不可见"**是错的**。

**为什么这套形状能一把覆盖七代**（三条互补证据）：

1. **运行时**：把 modern 形状注册进 0.1.1-rc.2 / 0.1.2-rc.1 / 0.2.1-rc.2，
   `registrations.get(key).def` 的 `stateSchema` 与 `wire.viewSchema` **全部非 undefined**。
2. **内核源码**：六个代次的 `register()` 里 `definition.schema` 读取次数**全为 0** ——
   旧形状从来没有任何一代消费过，本来就是死代码。
3. **类型面**：0.1.1-rc.2 自己的
   `dsh-session-projection/lib/types/index.d.ts:41` 就把 `stateSchema` 列为必填，
   `:57` 的 `wire` 也是 modern 形状。

**复验（两套独立实现 + 三道既有闸）**：

| 闸 | 修复前 | 修复后 |
|---|---|---|
| `npm run verify:kernels` | 6G/1R，exit 1 | **7G/0R，exit 0** |
| `scripts/cross-kernel/mount-run.mjs`（独立实现） | 6G/1R，exit 1 | **7G/0R，exit 0** |
| `scripts/cross-kernel/type-surface.mjs` | 7G（red=[]） | **7G（red=[]）** |
| `npm run test:smoke` | 全绿 | **全绿，exit 0** |
| e2e `ghost-frame-real-e2e.mjs` | 全 PASS | **全 PASS** |

0.1.1-rc.2 现在的行是
`契约=peer-only · apply落痕=Y · 投影=Y（modern:stateSchema+wire.view）`。

**仍未覆盖**：同 §6——没有驱动真实回合去看投影物化的现场（需要模型）。
本次复验只到"装配 + 注册形状正确"这一层。

## 3b. client 侧未声明的 `dsh-client-ui-primitives`：**可用**，不是硬下界

`src/client/settings-card.tsx:35` import 了 `@deepseek-ai/dsh-client-ui-primitives`，
`build.mjs` 用 `packages: 'external'`，所以产物 `lib/client.js:908` 留一条
`require("@deepseek-ai/dsh-client-ui-primitives")`，由宿主 `__ModuleLoader__` 解析。
但 `package.json` **只在 devDependencies（:87）**声明它，peerDependencies 与
`dsh.client.inject` 都没有它。

**结论：这个缺失不构成跨代障碍。** 复核物是各代次自己的前端产物
`dsh-web-frontend/dist/assets/index-*.js` —— 该包在那里是 `__ModuleLoader__`
注册表的一等条目：

```
0.1.1-rc.2  ...,"@deepseek-ai/dsh-client-ui-slots":g6,"@deepseek-ai/dsh-client-ui-primitives":Kd}}
0.1.2-rc.1  ..."@deepseek-ai/dsh-client-ui-primitives":Fp}}
0.1.7-rc.2  ..."@deepseek-ai/dsh-client-ui-primitives":qb,"@deepseek-ai/dsh-client-ui-dockkit":FS}}
0.2.0-rc.2  ..."@deepseek-ai/dsh-client-ui-primitives":sE,...
0.2.1-rc.2  ..."@deepseek-ai/dsh-client-ui-primitives":zU,...
```

即：宿主前端把 primitives **打进自己的 bundle 并注册**，插件不需要在自己的
`node_modules` 里看见它。

> 两条被实测否掉的中间假设，留在这里防止复发：
> 1. 「树的 `node_modules` 里没有该目录，所以解析不到」——**错**。0.1.1-rc.2 /
>    0.1.2-rc.1 / 0.2.1-rc.2 的 `node_modules` 里确实都没有，但前端 bundle 里有。
> 2. 「registry 没发布这一版」——**错**，且由我自己的检查否掉：
>    `@deepseek-ai/dsh-client-ui-primitives` 的 0.2.1-rc.2 / 0.2.1-rc.3 都已在 npm 上。
> 由「安装树里没有目录」推到「该代次没发布」是无效推理。

仍然成立的一条**声明卫生**问题（不影响功能）：这是一个**运行时真实需要**的包，
却只挂在 devDependencies 上。声明面没有表达它，任何依赖 peer 语义的准入
都无法检查它。

## 4. 0.1.5-rc.1 内核树不是单一版本（复核物：树内 package.json）

`~/dsh-versions/0.1.5-rc.1` 里 241 个 `@deepseek-ai` 包中，**只有 1 个**
（`dsh` 本身）是 `0.1.5-rc.1`，另外 **240 个解析到 `0.1.5-rc.3`**。

成因：`dsh@0.1.5-rc.1` 把自己的依赖写成 `"@deepseek-ai/dsh-app-boot": "^0.1.5-rc.1"`，
安装器把 `^0.1.5-rc.1` 解析到了最新的匹配预发布版 rc.3。

后果：这一代上得到的任何结论，实际是「0.1.5-rc.1 启动器 + 0.1.5-rc.3 服务」的结论，
**不能**当作对 0.1.5-rc.1 这一代的干净判定，也不能与另外六棵树平滑比较
（另外六棵**自洽**于各自版本）。其余六棵树逐包解析版本与代次号一致。

## 5. 装配面：0.2.1-rc.2 上真冷启动通过（Lead 亲自复现）

以 temp `DSH_HOME` + 实体插件副本 + 该代次版本树软链，按 `initProfile()` →
补写 `profile/cordis.yml`（`[]`）→ `loadOverlayPatches`（dsh-base + 插件 + 关 hmr）→
`boot.boot(...)` 装配 0.2.1-rc.2，实测（stdout）：

```
[dsh-suggest-ghost][ops-trace] apply called; artifact mtime=2026-10-23T09:44:33.808Z
[dsh-suggest-ghost][ops-trace] fiber=1 hotness domain opened attempt=1
[dsh-suggest-ghost][ops-trace] fiber=1 hotness restored n=0 tableSize=0
BOOT OK. agents=true sessions=true settings=true
sessionProjections registrations is Map: true
suggestGhost registered: true | has stateSchema: true | has wire: true
```

即：插件在 0.2.1-rc.2 上真的被装载、`apply()` 真的跑了、投影单元按**新形状**注册成功。

**踩坑（本仓脚本层）**：`boot.initProfile(dir, bundles)` 只写
`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`，**不写** `cordis.yml`；
而 `boot.boot()` 的第一个参数就是那个 `cordis.yml` 路径。不补写它 → 整棵 profile 树
`config file not found` → 插件根本没进 loader → 判据报「apply 无落痕」。
这是**判据假红**，不是插件缺陷：曾在 `scripts/verify-across-kernels.mjs` 上 7 代全红，
补上这一行后 0.2.1-rc.2 转绿。

## 6. 未定 / 未验

- 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 无 evaluator ⇒ 门禁面**无法执行**，判「未判定」。
- 投影不落地是**静默**的（`continue`）；尚未在 0.1.1-rc.2 上取得运行期断言。
  在拿到断言前，第 3 节是「已复现的机制」，不是运行期红。
- 门禁是否在**安装/装配路径上真的被调用**，未执行验证（只读了调用点）。
- 未验证：0.1.7-rc.1 与 0.1.7-rc.2 对本插件是否有行为差异。

## 7. 类型面 + 客户端导入可用性（T-TYPE，`type-surface.mjs` → `out/type.json`）

结论：**七代全绿**（exit 0）。类型面**没有任何跨代次漂移**；客户端未声明导入
**不构成功能红**，但确是一处**声明卫生**缺口。

### 7.1 一个必须先纠正的口径：`tsconfig.json` 根本不测客户端

任务书写的是跑 `./node_modules/.bin/tsc -p tsconfig.json --noEmit`。这条命令
**永远看不出客户端类型面**：根 `tsconfig.json` 带 `"exclude": ["src/client"]`。
`--listFiles` 实测：它编 **16** 个 `src/` 文件、`src/client` **0** 个。
客户端的是另一份 `tsconfig.client.json`（`include: ["src/client/**/*.ts"]`，
并**显式** `"exclude": []` 清空继承来的排除项）。所以两份都必须跑。

### 7.2 逐代次结果

基线 = 本仓 checkout（devDeps 钉的 0.2.0-rc.2）：host **0** 条、client **7** 条。
**代次红 = 出现基线里没有的错误「种类」**，不是绝对条数——那 7 条是这份诊断配置
有意保留的存量（其文件头逐条归因过），拿绝对条数判会把七代全判红。

| 代次 | host | client | 基线外新增 | host seed 表 | 判定 |
|---|---|---|---|---|---|
| 0.1.1-rc.2 | 0 | 6 | 0 | 有（7 键） | 绿 |
| 0.1.2-rc.1 | 0 | 6 | 0 | 有（8 键） | 绿 |
| 0.1.5-rc.1 | 0 | 6 | 0 | 有（9 键） | 绿（**混树**，见 7.4） |
| 0.1.7-rc.1 | 0 | 6 | 0 | 有（9 键） | 绿 |
| 0.1.7-rc.2 | 0 | 6 | 0 | 有（9 键） | 绿 |
| 0.2.0-rc.2 | 0 | 6 | 0 | 有（9 键） | 绿 |
| 0.2.1-rc.2 | 0 | 6 | 0 | 有（11 键） | 绿 |

客户端那 6 条**七代逐字相同**，即**没有代次敏感项**。原文（首三条）：
```
src/client/accept-guard.ts(51,36): error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
src/client/chunk.ts(68,39): error TS2532: Object is possibly 'undefined'.
src/client/chunk.ts(71,33): error TS2532: Object is possibly 'undefined'.
```
另两条：`src/client/index.ts(793,17)` TS18047、`src/client/index.ts(1575,13)` TS2341。
checkout 基线是 **7** 条，多出的 `src/client/index.ts(30,21)` TS2307
（找不到 `@deepseek-ai/dsh-client-ui-conversation`）在 overlay 里被消除——因为 overlay 挂了该代的该包。
**顺带一处文档漂移**：`tsconfig.client.json` 头注释自称残留 **8** 条，实测 **7** 条。

### 7.3 客户端未声明导入：`dsh-client-ui-primitives`

`src/client/settings-card.tsx:35` 运行时 import
`@deepseek-ai/dsh-client-ui-primitives`；`build.mjs` 用 `packages:'external'`，
故它在 `lib/client.js:908` 以 `require(...)` 形式留下、**由宿主运行时解析**，
但 `package.json` **只在 devDependencies**（第 87 行）声明它——
既不在 `peerDependencies`，也不在 `dsh.client.inject`（后两者只有
`dsh-client-ui-settings`、`dsh-client-ui-conversation`）。

逐代次分别回答三问（**混起来就会得出错论**）：

| 代次 | (a) 该代次树里解析得到？ | 该代次版本发布过？ | (c) 宿主 seed 表提供？ |
|---|---|---|---|
| 0.1.1-rc.2 | **否**（树里没有该目录） | 是 | **是** |
| 0.1.2-rc.1 | **否** | 是 | **是** |
| 0.1.5-rc.1 | **否** | 是 | **是** |
| 0.1.7-rc.1 | 是 | 是 | 是 |
| 0.1.7-rc.2 | 是 | 是 | 是 |
| 0.2.0-rc.2 | 是 | 是 | 是 |
| 0.2.1-rc.2 | **否** | 是 | **是** |

⇒ **不是发布硬下界，也不是功能红**：四个"树里没有"的代次，其**自己的**前端产物
都把它注册进了宿主模块表。判据是 `dsh-web-frontend/dist/assets/index-*.js` 里的
`staticModules:<fn>()` seed 表；而 `dsh-client-modules/lib/client.js` 的 `makeRequire`
解析顺序是 **seed 表 → 模块表 → 已注册 factory → 抛错**，seed 表**第一顺位**。
逐代 seed 函数：Jd / zp / by / iE / WS / rM / SZ，七代**全部**含该键。

正确说法是「**靠宿主恩典解析、但未声明**」：既不是干净的绿，也不是功能红，
而且**任何基于 peerDependencies 的准入检查永远看不到它**。
（证据强度：bundle 证据。未做真实浏览器加载——见第 8 节。）

### 7.4 两条方法学坑（都曾在本任务上造出**假红**，留档）

1. **把 peer 目录用外指软链挂进 overlay ⇒ 假红。** 首版 overlay 用 `ln -s` 指向
   `~/dsh-versions/...`，0.2.0-rc.2 报 **18 条**（`Property 'llm' does not exist on
   type 'Context'` 等）。**全是 overlay 自己的产物**。归因：`preserveSymlinks` 默认
   off，TS 按 **realpath** 认模块身份；软链 realpath 一旦落在 program root **之外**，
   cordis 的 `Context` 服务增强就不再合并。对照（内容逐字节相同）：
   外指软链 **18 条** / overlay 内实体副本 **0 条**。且 `diff -rq` 证实本仓 pnpm 的 9 个
   peer 与内核树里**逐字节相同** ⇒ 与代次无关，纯属挂载手法。
   **peer 必须 materialize 成 overlay 内的实体目录（`cp -rL`）。**
2. **`import.meta.resolve(spec, parentURL)` 忽略第二个参数**，永远从调用方模块解析
   （实测从 /tmp 探针调用时任何 parentURL 都解不出来）。要"以某棵树为根"只能用
   `createRequire(<该树内 anchor>)`。

### 7.5 0.1.5-rc.1 是**混树**（类型面结论属于 rc.3，不属于 rc.1）

独立复现：`dsh` 自身是 0.1.5-rc.1，但 dsh-* 服务里
**230/231 是 0.1.5-rc.3**（六个 overlay peer 全是 rc.3）。
其余六棵树 dsh-* 版本错配为 **0**。
故该代次的绿是 **0.1.5-rc.3 的类型面**；`out/type.json` 里该行带
`mixedTreeAnnotation`。**不要把它读成「0.1.5-rc.1 通过」**。

### 7.6 自检（本任务对脚本本身做的验证）

- **负控通过**：往 overlay 的 `src/domain.ts` 注入 `const __probe: number = "s"`
  ⇒ host tsc 当场报 `TS2322`，撤销后回 0 条。即"能报红"这条路是活的，
  不是恒绿。（首版负控用了 `(undefined as any).foo()` —— `any` 可赋给 `number`，
  **不是**真错误；那次"负控失败"是探针本身无效，一并记下。）
- **不碰真 checkout**：`git status --porcelain src/ lib/ tsconfig*.json` 为空；
  `lib/client.js` mtime 仍是 Oct 23 17:08；overlay 全在 `.work/type/` 下。
- **可复现**：连跑两次（一次带 `--json`），除 `generatedAt` 外产物逐字节相同。
- 顺带发现并修掉的三个**我自己的** bug（都曾造成假红）：seed 表键正则漏掉无引号键
  `react:`；`injects` 是完整 specifier 却被拼到已以 `@deepseek-ai` 结尾的目录上
  （拼成 `@deepseek-ai/@deepseek-ai/...`）；把 `dsh.client.inject` 当 seed 词判
  （它们是**启动图行**，正确判据是"树里有没有这个包"）。

## 8. UI 面 + 功能面：三代次真 GUI 重验（2026-10-27，构建 `938048b` = 0.7.0）

矩阵脚本（`verify-across-kernels.mjs`）只覆盖装配/门禁/类型/投影，注释里自己承认
**没有覆盖 client 侧、不截图**。本节补的就是那两面：**用户到底看不看见浅灰幽灵文字**。
判据是"真正被用户感知的入口"（真 GUI 发真问题 → 真模型回合 → 建议 → `_push` →
composer 里的 overlay），**没有调任何内部 handler**。

### 8.1 结论

| 判据 | 0.1.7-rc.2 | 0.2.0-rc.2 | 0.2.1-rc.2 |
|---|---|---|---|
| ① composer 出现浅灰幽灵（截图） | ✅ 「如何创建额外工作目录」10 字 | ✅ 「保留改动那条命令就行」10 字 | ✅ 「怎么用 git worktree 签出新分支」22 字 |
| ② 同次 `_push`：rev 递增 + suggestion 非空 + `final=true` | ✅ rev=3 final=true frame=1 | ✅ rev=7 final=true frame=1 | ✅ rev=9 final=true frame=1 |
| ③ 健康启动无三条新 warn | ✅ 三条各 0 命中 | ✅ 同 | ✅ 同 |
| ④ 设置卡可打开（client 面两个 inject 真的可用） | ✅ 插件页出现本插件卡与描述原文 | ✅ 同 | ✅ 同 |
| ⑤ 重启一次后热表不回零 | ✅ `hotness restored n=1 tableSize=1`，`_hot total=1` | ✅ `n=3 tableSize=3`，`total=3` | ✅ `n=1 tableSize=1`，`total=1` |

**三代全绿。** ⚠️ **但 0.1.7-rc.2 那行"当前不可复跑"** —— task-36 在同一份构建、同一套驱动上
四次都建立不起对照组（`bound=false / no-session`），见 §10.3 的撤回说明。0.2.0 / 0.2.1 两行不受影响。 **（§11 已判明：三条工具面缺陷，非产品面 ⇒ 本行恢复为 GREEN（当前可复跑，冷启动 ×3）；撤回记录保留在 §10.3/§11。）** 每代次都是**该代次自己的 `dsh` bin** 起的实例（`/proc/<pid>/cmdline` 逐次
核过，例如 `node /home/wujue/dsh-versions/0.1.7-rc.2/node_modules/.bin/dsh --profile web --port 0 --no-open`），
插件是**实体副本**（`apply called; artifact mtime` 三代同一份 `938048b` 构建），
`@deepseek-ai` 走**整目录**软链，冷启动、无 HMR。

### 8.2 `supersedes`（旧证据为什么不算了）

`docs/cross-kernel-shots/` 里 `<代次>-PASS.png` 三张产出于 `4b72fae`（#95）。
`src/client/**` 与 `lib/client.js` 自那以后**一字未动** ⇒ 显示路径的旧证据本身仍成立；
但截图之后宿主侧动了 4 次，其中 **`802ef61`（0.7.0 发布，"清掉包内的本机绝对路径"）
改的就是产物字节** ⇒ "跑的是哪份产物"这个问题在旧截图上已经答不了。
故本轮重拍为 `<代次>-PASS-0.7.0.png`，**旧三张保留**（它们是"为什么曾经要修"的历史证据，
尤其 `0.1.1-rc.2-FAIL.png` 与 `-namespace.png` 那组对照）。

### 8.3 四条方法学坑（每条都曾在我手上造成**假红**，写下来给后来人）

1. **默认阈值静音 info ⇒ "日志里没有 `apply called`" 不等于插件没挂载。**
   该留痕是 `traceNote` = **info** 级（`src/trace.ts:104`、`src/index.js:322`），
   默认阈值 `warn` 直接丢弃。设 `DSH_SUGGEST_GHOST_TRACE=debug` 后同一进程立刻出全痕。
   这正是 #97 那条纪律的又一次命中：**判"没发生"之前，先证明"发生了就一定被打印"。**
2. **工作区选择器的入口与就绪判据都按代次不同**：
   - 0.1.7-rc.2 上点 composer 的 `aria-label="选择工作区"` **不会**开选择器（点完 dialog 仍为空），
     真入口是侧栏 `aria-label="添加工作区"`；
   - 选择器的**目录列表是异步加载**的，打开后立刻查行 ⇒ "列表里没有那一行"假红；
   - 「选择工作区」字样在侧栏工作区行上**长期存在** ⇒ 就绪与否要看
     `composer().dataset.phase !== 'inert'`，不能看那个字样消没消失。
3. **模型会返回空 ⇒ `suggestion dropped (empty or filtered)` 不是插件/代次缺陷。**
   0.2.0-rc.2 那轮前两次尝试都是 dropped、第三次才出建议；按技能要求换问题重试，
   **不要**把这种情况记成红。判据上区分得很清楚：`generated` 与 `dropped` 是两条不同留痕。
4. **`grep -c 'push landed'` 会把 `hot push landed` 一起算进去**（子串匹配）。
   本轮 0.2.1 那个 17 是含热度帧的总数；要数"建议格落地"得按前缀分开数。

### 8.4 复现

```bash
# 每一代次：建沙箱（实体副本 + 该代次自己的 bin + 冷启动）→ 跑一轮 → 重启核热表
DSH_SUGGEST_GHOST_TRACE=debug node scripts/dev-sandbox.mjs \
  --home ~/dsh-sbx-xk-<简写> --rewrite 'port: 3983=port: <各自端口>' \
  --bin ~/dsh-versions/<代次>/node_modules/.bin/dsh
node scripts/cross-kernel/gui-round.mjs --home ~/dsh-sbx-xk-<简写> --gen <代次> \
  --ws ~/xk-probe-ws --shot docs/cross-kernel-shots/<代次>-PASS-0.7.0.png
node scripts/dev-sandbox.mjs --home ~/dsh-sbx-xk-<简写> --deploy . --bin …（同上）
grep -a 'hotness restored' ~/dsh-sbx-xk-<简写>/logs/sbx.log | tail -1
```

驱动 `scripts/cross-kernel/gui-round.mjs` 的页内选择器与操作顺序抄自
`scripts/hot-yield-ratio.mjs`（同机多代次实测跑通的那条路）。token 全程只从
`<home>/logs/sbx.log` 取、所有输出过 `redact()`，每轮自证明文进 stdout 次数 = 0。

### 8.5 未判定（本轮**没有**覆盖的，别当成绿）

- **0.1.5-rc.1**：本机无该代次树（只有 `0.1.5-rc.3`）⇒ UI 面**未判定**。
- **0.2.1-rc.3 / rc.4**：树在（`~/dsh-versions/`），但不在本片分片内 ⇒ 未跑。
- **GUI 面的并发/多标签页语义**：本轮未测（task-31 在 0.2.1 上测过 typert 流的多标签页，
  与本轮的 settings 通道不是同一条路，不能互相顶替）。
- **对照实验缺失**：没有做"故意去掉 `remote.settings` 声明 ⇒ 该代次应当 failed"的反证，
  所以 ④ 只证明了三代**能**用，不证明"这一代必须有它才行"。0.1.1 那条硬约束的对照
  实验仍在 `docs/cross-kernel-shots/README.md` 里记着，未受本轮影响。

## 9. 台账自审（2026-10-27，lead）：有一条 GREEN **当前不可复跑**

矩阵表里 `0.1.5-rc.1` 那行（§表：`| 0.1.5-rc.1 | Y | 是 | modern（混合树，见 §4） | GREEN |`）与 §4 整节，
复核物都是 `~/dsh-versions/0.1.5-rc.1` 这棵树。**该目录今天已不存在**（本机现有 6 棵树：
0.1.2-rc.1 / 0.1.5-rc.**3** / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2，逐棵核过"目录名 == 树内 `@deepseek-ai/dsh` 版本"，全部一致）。
§4 记的"241 个包"与今天的 `0.1.5-rc.3` 包数相同 ⇒ 那棵树后来被重新物化/改名，**不是同一份现场**。

⇒ 结论：那一行是**历史证据**，不是当前判定。按本文件自己的规矩（只登记已被复现的事实 + 未判定单列），
它的当前状态是 **未判定**：`peerDependencies` 逐字枚举了 `^0.1.5-rc.1`，而本机没有该版本的树可跑。
⇒ 要闭合：取 `0.1.5-rc.1` 的干净树重装（registry 有发布），再跑 `verify:kernels` + GUI 面。
⇒ **不要拿 `0.1.5-rc.3` 顶替**：§4 已经证明 rc.1 那份是混合树，两者形状不同，顶替会得出"看起来绿"的假结论。

### 本轮新增的两条测量坑（都造成过假结论）
1. **`grep -c 'push landed'` 会把 `hot push landed` 一起算进去**（子串匹配）⇒ 拿它算"每回合写几次"或 C 方案成本会**高一个量级**。要数就锚 `] push landed` 这种带前缀边界的形态
2. **管道后的退出码不是命令的**：`ls -d X | sed ...` 即使 `X` 不存在，整条管道的退出码仍是 `sed` 的 0 ⇒ `||` 分支不触发，"不存在"被读成"存在但没打印"。⇒ 判存在性用显式 `[ -d X ] && ... || ...`，别接管道

## 10. 判据 ④ 的反证：去掉 `remote.settings` 声明，GUI 上到底还有没有幽灵（2026-10-27，task-36）

§8.1 的 ④ 只证明了"三代**能**用"，没证明"这一代**必须**有它"。本节补那条反证 —— 这也是
当初把 `0.1.1-rc.2` 从支持列表删掉时所用的**同一类证据形状**（client fiber 不激活 ⇒ 界面上什么都没有）。

**单变量**：只改 `src/client/index.ts:403` 一行，把 `'remote.settings'` 从 `inject` 里去掉
（宿主侧 `src/index.ts` 的 `inject` 不动）。改完重建，**产物与提交版本逐字节一致**
（`git status --porcelain src lib` 在还原后为空 ⇒ 反证期间唯一差异就是那一行声明）。

### 10.1 结果：0.2.1-rc.2 **决定性**，0.1.7-rc.2 **未判定**

| | 对照组（带声明） | 反证组（去掉声明） |
|---|---|---|
| **0.2.1-rc.2** | ✅ 幽灵出现「怎么杀掉占用进程」8 字；`建议格 push landed=4`；设置卡可开 | ❌ **整个 GUI 起不来**：页面只剩 `HARNESS / Failed to load plugins / dsh-suggest-ghost / web boot: 1 entry did not activate / dsh-suggest-ghost: loading`；DOM 实测 `composers=0`、`[data-input-scroll]=0`、`[role=textbox]=0`、overlay 不存在；宿主侧 `建议格 push landed=0`、`suggestion generated=0`、**`suggestion dropped=0`** |
| **0.1.7-rc.2** | ❌ **对照组建立不起来**（见 §10.3）⇒ 反证无从判 | 未跑（无对照组就不跑，跑了也不算证据） |

**反证比预期更强**：我原本预期"该代次插件 `failed` ⇒ 幽灵不出现"，实测是
**一条 client fiber 激活不了，整个 web boot 直接拒绝渲染应用**（harness 兜底页 +
`console.error` 抛 `Error: web boot: 1 entry did not activate`）。
所以这条不只是"④ 是硬约束"的证据，还是一条**宿主行为事实**：
在 0.2.1-rc.2 上，插件客户端声明写错 = **把用户的界面整个弄没**，
而不是"我的功能静默不可用"。这条应该单独递到 #40（见 §10.6）。

三条判据逐条交代：

1. **打在真 GUI 上** ✅ —— 两张图都在 `docs/cross-kernel-shots/`：
   `0.2.1-rc.2-PASS-with-decl.png`（幽灵可见）与 `0.2.1-rc.2-FAIL-no-remote-settings-decl.png`（同位置、什么都没有）。
   没有用 in-process boot 的红绿替代。
2. **同一 session 内保留对照组** ✅（0.2.1）—— 同一份构建、同一代次、同一沙箱，
   先跑对照再 `--deploy` 探针构建冷启动跑反证，两轮之间只换了那一行声明。
3. **措辞升级** ⇒ ④ 在 **0.2.1-rc.2** 上从"可用"改为 **「硬约束成立（附反证）」**。
   对 0.1.1 那条删除理由：证据形状**一致**（`entry did not activate` ↔ 当年的
   `pending (waiting for service: remote.settings)`），但那是**同形状推断**，
   不是我在 0.1.1 上重跑出来的 —— 别把它写成"已复现"。

### 10.2 为什么反证组的"没有幽灵"不是模型空返回冒充的

`dropped=0` 与 `generated=0` 是排除它的关键：模型空返回会打 `suggestion dropped`，
而本轮一次都没有 ⇒ 宿主根本没进入生成，因为**客户端 fiber 从未激活**（console 那条
`1 entry did not activate` 是独立信号，来自浏览器而不是宿主日志）。
这正是 §1c 那条纪律的落地：**"没幽灵"至少有三种成因，必须各自有独立信号才能分开。**

### 10.3 ⚠️ 一条自我撤回：§8.1 里 **0.1.7-rc.2 那行 PASS 需要复核**

本轮在 0.1.7-rc.2 上**四次**都建立不起对照组，症状固定：

- 客户端**活着**（能收到 push、设置卡能开、`push-cell: applies=1` 之类留痕都在）；
- 但 `inline-arm-cancel: reason=no-session draftChars=0 bound=false enabled=true` 反复出现；
- 宿主侧 `suggestion generated=0`、`建议格 push landed=0`；
- 磁盘上**确实有会话**（`sessions/--home-wujue-xk-cf-ws--/session-…/session.v4.jsonl.zstd`），
  点侧栏已有会话（`--prefer-existing`）也一样拿不到当前会话。

⇒ 两个结论必须分开写：
1. **反证在 0.1.7-rc.2 未判定**（对照组不成立 ⇒ 差异无从归因，跑了也不算证据）。
2. **§8.1 那行 0.1.7-rc.2 的 UI 面 PASS 是同一份构建、同一套驱动在另一份沙箱上拿到的**；
   本轮拿不到 ⇒ 它可能依赖 warm 状态（那份沙箱在被删前已经过若干轮，界面上有历史会话）。
   在有人复跑之前，**不要把 §8.1 的 0.1.7 那行当成可复跑的结论**。
   这与 §9 对 `0.1.5-rc.1` 的处理是同一类问题：**证据的"当前可复跑性"要单独声明。**

### 10.4 本轮新增的三条坑

1. **`dialogGone=false` 在 0.1.7-rc.2 上是常态误报**：该代次界面上有**常驻的 `role=dialog` 容器**，
   选择器关掉与否不能用 `[role=dialog] == null` 判。（我据此加了一次"再点主按钮"的兜底，
   结果 `secondClick=null` —— 说明那个 dialog 根本不是选择器的，判据本身选错了。）
2. **反证必须自带"排除模型空返回"的信号**，否则 `dropped` 与"fiber 死了"在 GUI 上同形。
   现在驱动把浏览器 console 一起收（`out.steps.console`），并把宿主日志计数**按前缀边界分开**
   （`(?<!hot )push landed` 与 `hot push landed` 各数一份 —— §9 那条坑的自动化版本，
   0.2.1 对照轮实测 4 / 5，裸 grep 会报 9）。
3. **模板字符串内部的注释不能出现反引号**：会把模板提前结束，`node --check` 才报得出来。
   本轮在同一个文件里踩了**两次**（第二次就发生在给第一次写警告注释的时候）。

### 10.5 反证顺带产出的两条（一条要递上游）

1. **【上游诉求，可直接递】一条写错的 `inject` 应当只废掉那个插件，不应当废掉整个 GUI。**
   现状（0.2.1-rc.2 实测）：插件 client 的 `inject` 里少一个服务 ⇒
   `web boot: 1 entry did not activate / <插件>: loading` ⇒ 页面停在
   `HARNESS / Failed to load plugins`，**用户什么界面都没有**（composer、侧栏、设置页全没）。
   而"激活门控"本来就是 cordis 的静态语义（§1d），所以问题不在门控本身，
   在于**门控失败被提升为整个 web boot 的致命错误**。
   建议：单插件 fiber 失败降级为"该插件不可用 + 一条可发现的错误"，应用照常渲染，
   并把失败插件名列在设置/插件页里。今天的形状意味着**任何一个第三方插件的
   一行声明错误，都能把用户的整个 DSH 界面变白屏**，而插件作者拿到的只是一句
   `loading`（不带"缺哪个服务"）。
   附：错误文案里也没说清是哪个依赖没拿到 —— 与 §40 那条
   `cannot get property "remote.<ns>" without inject` 指向性差是同一族问题。
2. **【本仓纪律】"没有幽灵"的三种成因要用三个不同信号分开**：
   `suggestion dropped`（模型空）/ `bound=false no-session`（会话归属）/
   `composers=0 且 overlay 不存在`（fiber 没激活，界面根本没起来）。
   只看 GUI 上"没字"三种都会一模一样 —— §1c 那条纪律在 0.2.x 上再次命中。

### 10.6 证据文件

| 文件 | 是什么 |
|---|---|
| `docs/cross-kernel-shots/0.2.1-rc.2-PASS-with-decl.png` | 对照组：composer 区域，浅灰幽灵「怎么杀掉占用进程」可见 |
| `docs/cross-kernel-shots/0.2.1-rc.2-FAIL-no-remote-settings-decl.png` | 反证组：**整页**（不是 composer 区域），只有 `Failed to load plugins` harness 页 —— 因为界面根本没渲染，截 composer 区域无从截起 |
| `docs/cross-kernel-shots/0.1.7-rc.2-UNDET-no-session-binding.png` | 0.1.7-rc.2 对照组失败现场（composer 在、无幽灵、`no-session`）⇒ 该代次反证**未判定** |

> 命名说明：反证组那张是**整页截图**，与 §8 的"截 composer 区域"口径不同 ——
> 这不是偷懒，是那一代次根本没有 composer 可截。图的内容差异本身就是结论的一部分。

### 10.7 复现

```bash
# 对照（pristine 构建）
node scripts/dev-sandbox.mjs --home ~/dsh-sbx-cf-0212 --rewrite 'port: 3983=port: 4141' \
  --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh
node scripts/cross-kernel/gui-round.mjs --home ~/dsh-sbx-cf-0212 --gen 0.2.1-rc.2 \
  --label with-decl --fresh-log --ws ~/xk-cf-ws --shot docs/cross-kernel-shots/0.2.1-rc.2-PASS-with-decl.png
# 反证：删掉 src/client/index.ts:403 里的 'remote.settings' → npm run build → 冷重启
printf '\n=== dev-sandbox 新启动 ===\n' >> ~/dsh-sbx-cf-0212/logs/sbx.log   # 计数窗口分界
node scripts/dev-sandbox.mjs --home ~/dsh-sbx-cf-0212 --deploy . --bin …（同上）
node scripts/cross-kernel/gui-round.mjs --home … --label without-decl --fresh-log --shot …FAIL-no-remote-settings-decl.png
# 收尾：git checkout -- src/client/index.ts && npm run build && git status --porcelain src lib  （必须为空）
```

## 11. 0.1.7-rc.2「建不起对照组」的成因：**三条工具面缺陷叠加**，快照形状假设不成立（2026-10-27，task-37）

**判定 = (b) 工具面。** 产品面的会话归属/快照形状（`current` vs `retainedBy.mainView`，§1c 第 4 条点名的那条）**不是成因**：
模态关掉之后，`currentSessionIdOf` 的两条来源在本代次都工作，`bound` 正常建立。

三条缺陷互不相干，而**每一条单独都足以产出同一行日志**（`no-session / bound=false / generated=0`）：

1. **首屏「内测声明」模态从来没被关掉。** 0.1.7-rc.2 的 GUI 第一屏是模态，确认按钮文案是中文「继续」，
   而驱动 `dismiss()` 的标签表里只有英文 `Continue` ⇒ 模态盖住 composer ⇒ 消息发不出去 ⇒
   宿主**一个会话事件都收不到**。更误导的是：picker 步骤的兜底分支会点「继续」，于是
   **它把模态的「继续」当成了 picker 的「继续」**，返回 `viaContinue:true, ready:false`
   —— 一个"我执行过了"的假信号（本轮实测就是这么被带偏第一轮的）。
2. **Node 侧常量被原样写进页内脚本。** `(PREFER_EXISTING === true ? existing : null)` 出现在
   `evaluate` 的模板字符串里 ⇒ 页内 `ReferenceError: PREFER_EXISTING is not defined` ⇒
   「点新会话 / 点已有会话」这一步**从来没执行过**（每轮静默失败，只在 `rounds[].newSession.pageError` 里露出来）。
   引入者是 `2b48d24`（§10 反证那一轮）⇒ **同轮的 0.2.x 结论也只在它之前成立**。
3. **冷启动目录列表竞态。** picker 打开后 9s 内没找到目标行就退到兜底分支；同一个 home 第二次跑就直接
   `viaRow` 成功 ⇒ 冷沙箱第一轮常输在这里。现在改成「关掉重开一次再判」。

### 物证（DOM 序列 + 宿主归属，两边都取）
| | 修之前 | 修之后（同一沙箱、同一份构建） |
|---|---|---|
| DOM | `composerReady:false`、`phase:"inert"`、`composers:["DIV/inert/选择工作区"]` | `phase:"plain"`、`composerReady:true` |
| 宿主 | 只有 `ops consumed: pull`，**零** turn/end、**零** suggestion、**零** dropped | `ops consumed: pull session=session-…`（真实会话 id）、`reason=no-session` 计数 **0** |

### 冷启动复现（全新沙箱 ×3，全部 PASS）
| home | verdict | 幽灵字数 | 备注 |
|---|---|---|---|
| `xk-ns-cold2` | **PASS** | 16 | 一次成功 |
| `xk-ns-cold3` | **PASS** | 15 | 第一句 `suggestion dropped (empty or filtered)`、第二句 `generated` ⇒ §10.1 第 3 条的换问句重试机制生效，**不记成代次缺陷** |
| `xk-ns-cold4` | **PASS** | 20 | 第三次；仓库侧留图 `0.1.7-rc.2-PASS-cold3x.png` |

⇒ **§8.1 里 0.1.7-rc.2 那行改写为「GREEN（当前可复跑，冷启动 ×3）」**，撤回声明解除；
但**撤回这件事本身要留着** —— 它记录了"证据的可复跑性"与"证据"是两件事（§9 对 0.1.5-rc.1 同理）。

### 顺带补齐：判据 ④ 的反证在 0.1.7-rc.2 **成立**（§10.1 那行"未判定"可以判了）
- 单变量：`src/client/index.ts:403` 的 `inject` 去掉 `'remote.settings'`，其余一字不动，同一份构建、同一套驱动。
- 结果：`composerReady:false`、连 composer 都截不到 ⇒ 驱动改截**整页**，页面文案实测：
  `HARNESS Failed to load plugins dsh-suggest-ghost web boot: 1 entry did not activate dsh-suggest-ghost: failed`
- 物证：`docs/cross-kernel-shots/0.1.7-rc.2-CF-without-decl-FULLPAGE.png`
- ⇒ **④ 从「0.2.1 硬约束成立」扩到「0.1.7-rc.2 同样成立」，且形态一致**（整页起不来，
  不是"功能静默不可用"）⇒ 这条仍然支持 §10.5 递去 #40 的那句：一次写错的 `inject` 不该废掉整个 GUI。

### 驱动因此补的两条（都在 `gui-round.mjs`）
- `dismiss()` 加中文确认文案，并**限定作用域**：绝不点 picker 里的「继续」（那会选中列表当前目录而不是我们的 ws）。
- `noBox` 时改截整页并记页面文案：反证组的界面根本没渲染，只留 `noBox:true` 等于没有物证。

### 方法论（这次最该留下的一条）
"看起来像产品缺陷"的症状可以由**三条互不相干的工具面缺陷**分别造成，而留痕文本一模一样。
⇒ 判"某代次不支持"之前，至少要凑齐三件物证：**DOM 侧 `phase` 序列 + 宿主侧 `session=` 归属 + 一张整页截图**。
只看留痕（尤其只看"某行没出现"）会误判 —— 这与 §6 那条「阈值 + 通道」两种失效方式是同一类问题，
只是这次的"通道"换成了"模态盖住了输入框"。

## 12. §10 那组（0.2.1-rc.2 对照 + 反证）用修好的驱动重跑（2026-10-27，task-38）

**为什么要重跑**：§10 那组是在 `gui-round.mjs` 带一条致命缺陷时拿到的 —— 我在 `2b48d24`
里把 Node 侧常量 `PREFER_EXISTING` 原样写进页内脚本 ⇒ 页内 `ReferenceError` ⇒
**「点新会话/已有会话」这一步从来没执行过**。client-ghost 在 #105 修掉（`origin/main` 起
`:354` 现在插的是 Node 侧的值，已核）。所以 §10 的结论当时是「有证据，但可复跑性未证」。
本轮用修好的驱动 + 全新沙箱重跑，并给每一行标上**「当前可复跑」/「历史证据」**。

### 12.1 结果（同一次运行内建立对照与反证；驱动 `--label` 逐轮标记）

| 组 | 轮 | GUI 结果 | 会话选择自证（三条） | `push landed`（前缀边界） | 可复跑性 |
|---|---|---|---|---|---|
| 对照 | ctrl1 | ✅ 幽灵「怎么创建 worktree」13 字 | `phase: inert→plain`、`composerReady=true`、`found=true label=新会话 新建会话`；宿主 `suggestion generated session=session-c5dd9c6a-34ba-4f54-98e9-b9b2d20fc020`；`reason=no-session` **0** | 建议格 **2** / hot **3**（裸 `grep -c` 会给 **5**） | **当前可复跑** |
| 对照 | ctrl2 | ❌ 未出幽灵 —— **模型空返回**：`suggestion dropped (empty or filtered) session=session-163c55cc-…` / `session-session-33de0100-…`，`generated=0`，`no-session=0` | 会话选择**执行了**（三次都拿到真实 session id） | 建议格 0 / hot 0 | 不计入判定（既不是反例也不是绿） |
| 对照 | ctrl3 | ✅ 幽灵「什么时候该使用它」8 字 | `generated session=session-fd3df22f-95e5-4e8f-8f78-cc82b7642d80`；`dropped=0`；`no-session=0` | 建议格 **2** | **当前可复跑** |
| 反证 | probe | ❌ **整页起不来**：`HARNESS / Failed to load plugins / dsh-suggest-ghost / web boot: 1 entry did not activate / dsh-suggest-ghost: failed`；DOM `composers=0`、`[data-input-scroll]` 无 ⇒ 驱动走整页兜底出图 | 无从判（界面没渲染）；宿主 `apply called=5` ⇒ 宿主侧正常，死的是 client fiber | 建议格 **0** / hot **0** / `generated` **0** | **当前可复跑** |

⇒ **两次干净对照出幽灵（ctrl1 + ctrl3）+ 反证整页失败 ⇒ §10 的结论复跑成立**：
判据 ④ 在 **0.2.1-rc.2** 上是 **「硬约束成立（附反证，且当前可复跑）」**。
单变量核对：只改 `src/client/index.ts:403` 一行，跑完 `git checkout` + 重建，
`git status --porcelain src lib` **为空** ⇒ 产物字节与提交一致。

### 12.2 与 §10 原始记录的唯一差异（照实记，不解释成因）

harness 页上那行状态词：§10 记的是 **`dsh-suggest-ghost: loading`**，本轮是
**`dsh-suggest-ghost: failed`**。页面标题、`Failed to load plugins`、插件名、
`web boot: 1 entry did not activate` 四条完全一致，只有这个状态词不同。
**为什么不同我没有证据**（按本轮新立的规矩：不指定成因方向），只登记观察。
两种词都不影响判据 —— 结论只依赖"界面没渲染 + 宿主侧正常"这两条物证。

### 12.3 更正我自己写的一条撤回措辞

§10.3 我把 0.1.7-rc.2「建不起对照组」写成"可能是 warm 状态依赖"。
**那个成因是错的**：task-37（#105）判明是**三条工具面缺陷叠加**，其中一条就是本节开头那条
`PREFER_EXISTING` 页内 `ReferenceError`（我 `2b48d24` 引入的）。
⇒ 撤回的**方向**成立（当时那组结论确实不可复跑），**成因**是错的。
§8.1 的 0.1.7-rc.2 那行已由 task-37 恢复为 GREEN，本节不再重复判它。

### 12.4 三条测量口径（本轮逐条实测过，不是转抄）

1. **`push landed` 必须用前缀边界**：`(?<!hot )push landed` 与 `hot push landed` 分开数。
   本轮 ctrl1 实测 **2 / 3**，裸 `grep -c 'push landed'` 给 **5** —— §9 那条坑的量化版本。
2. **判"选择器已关"用 `composer().dataset.phase !== 'inert'`**，不要用 `[role=dialog]` 计数
   （本轮 0.2.1 上 `dialogGone=true` 恰好为真，但那是巧合；0.1.7 上是常态误报，见 §11）。
3. **`--fresh-log` 切窗是必需的**：沙箱日志追加写，不切窗就会把上一轮的 `push landed`
   / `dropped` 算进本轮。本轮三次对照 + 一次反证各切一个窗，计数才可归因。

### 12.5 证据与复现

- `docs/cross-kernel-shots/0.2.1-rc.2-PASS-with-decl-rerun.png` —— 对照组 composer 区域（幽灵可见）
- `docs/cross-kernel-shots/0.2.1-rc.2-FAIL-no-remote-settings-decl-rerun-FULLPAGE.png` —— 反证组**整页**
  （该代次没有 composer 可截，整页 + 页面文案就是物证本体；口径见 §11 的驱动兜底条）
- 复现：`--home ~/xk-021-a --rewrite 'port: 3983=port: 4151' --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh`
  → `gui-round.mjs --label ctrl1|ctrl2|ctrl3 --fresh-log` → 删声明 + `npm run build` + `--deploy .` 冷重启
  → `--label probe` → **还原** `git checkout -- src/client/index.ts && npm run build`
- 收尾核对：`--cleanup` 后等 8 秒显式复查 —— 我的沙箱目录 / `-ws` / `~/xk-021-ws` / `/tmp/xk-gui-*`+`/tmp/pp-*`
  / 端口 4151 / 残留实例 **全部为 0**。⚠️ **`TMPDIR` 未设时 chrome 的 `user-data-dir` 落在 `/tmp`，
  `--cleanup` 收不到**（#100 第二条缺口，本轮实测命中）⇒ 必须自己显式清。
  `ls ~ | grep -E "xk-|dsh-sbx"` 剩下的 4 条**都不是本片的**（`dsh-sbx-real`、`dsh-sbx-xkg-0153`、
  `xk-gui-0153-ws`、`xk-gui-0171`），按并发约定未动。

### 12.6 未判定

- **0.2.0-rc.2 的反证**：不在本片。§10.5 那句"大概率同形"仍然是**预测**，不是结论。
- **`loading` 与 `failed` 两个状态词的成因**：见 §12.2，本轮无证据。
- **模型空返回率**：ctrl2 三轮全空、ctrl1/ctrl3 首轮即中 —— 只够说明"重试是必需的"，
  不够给任何代次或路由下结论（那是 probe-llm 那片的事）。
## 13. 老代次三片真 GUI 重验：0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1（2026-10-27，构建 0.7.0，冷启动 ×2）

Gitea #41 / task-34。分片是**最老的三代**（0.2.x 与 0.1.7-rc.2 在 §8 / §11）。
每代次都在**全新冷沙箱**上跑**两次**独立 GUI 轮（lead 采纳的口径：**证据 ≠ 证据的可复跑性**），
依赖一律来自**被测那代次的树**（`--live-nm`，见 §13.2 第 1 步）——本轮第一版把依赖留给了
live profile（0.2.1 那份），0.1.7-rc.1 那两行绿因此**作废重跑**，这正是技能 §1 说的
"两份内核模块实例"矩阵失真。

### 13.1 结论

| 判据 | 0.1.2-rc.1 | 0.1.5-rc.3 | 0.1.7-rc.1 |
|---|---|---|---|
| ① composer 出现浅灰幽灵（截图为证） | ✅ cold1 9 字「什么时候该用工作树」/ cold2 18 字 | ✅ cold1 20 字 / cold2 16 字（另 cold3 8 字） | ✅ cold1 19 字 / cold2 8 字 |
| ② 同次 `_push`：rev 递增 + 非空 + `final=true` + 有会话归属 | ✅ rev=2 final=true frame=1 chars=9/18 | ✅ rev=2 final=true frame=1 chars=20/16 | ✅ rev=2 final=true frame=1 chars=19/8 |
| ③ 健康启动无 #101/#104 三条 warn | ✅ 三条各 0 命中 | ✅ 同 | ✅ 同 |
| ④ 设置卡可打开 | ⚪ **未判定**（见 §13.4） | ⚪ **未判定**（见 §13.4） | ✅ `cardShown=true` |
| ⑤ 重启一次后热表不回零 | ✅ `_hot total=1`（重启后仍 1） | ✅ 同 | ✅ 同 |

⇒ **UI 面 + 功能面在这三代都成立**：老代次不是"装配能过但界面上看不见"。
④ 单独未判定，不与前四条混算，也不因"其余四条绿"默认它没事。

物证：`docs/cross-kernel-shots/<代次>-PASS-0.7.0-coldN.png`（**截 composer 区域**，
判据是 `#dsh-suggest-ghost-overlay` 且 `data-shown=1`、`display!=none`、文本非空；
本轮每张都人眼复核过浅灰文字确实在图里）。机器侧证据：
`node scripts/cross-kernel/volatile-evidence.mjs --home <沙箱> --gen <代次>`。

**supersedes**：`<代次>-PASS.png` / `-PASS-fixed.png`（产出于 `4b72fae`，#95）。
`src/client/**` 与 `lib/client.js` 自那以后一字未动 ⇒ 旧图本身不算错，但截图之后
`802ef61`（0.7.0 发布，"清掉包内的本机绝对路径"）改的就是产物字节 ⇒ 旧图答不了
"跑的是哪份产物"。旧图**保留**，本节是"当前可复跑"的那一份。

### 13.2 老代次装配配方（四步，每步都对应一次实测失败——少一步就"不监听"）

`dsh web` 不监听时**不报错、零输出**，所以这四步只能逐个排。全部由
`scripts/cross-kernel/prune-bundles.mjs` 一次做完（幂等，会打印每步动了什么）：

1. **依赖必须来自被测树**：`dev-sandbox --live-nm ~/dsh-versions/<gen>/node_modules`。
   默认它把依赖逐条软链到**真实 profile** 的 node_modules（= live 那份 0.2.1）⇒
   插件的裸导入拿到 0.2.1 的宿主包，而内核是 0.1.x ⇒ 矩阵失真，跑出来的绿不可信。
2. **`.bin/dsh` 的形状按代次不同**：0.1.5-rc.3 的 `.bin/dsh` 是 **`#!/bin/sh` 包装脚本**，
   而 dev-sandbox 用 `node <bin>` 起 ⇒ `SyntaxError: Invalid or unexpected token`。
   老树改用 JS 入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`（0.1.2 / 0.1.7 两者皆可）。
3. **bundles 必须裁到该树解析得到的**：live 的 23 条里有
   `@deepseek-ai/dsh-experimental-agent-team-profile` 这类老树没发布的包，0.1.5 的
   `dsh-app-boot` 对不可解析 bundle 是**硬失败**：
   `Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-experimental-agent-team-profile"`。
   裁到 `dsh-base + dsh-web-app + 本插件`（`dsh-web-app` 缺了就回到"不监听零输出"）。
4. **patch 条目也必须一起裁**（本工具第一版在这里写错过一句"留着是空操作"）：
   嵌在别的顶层条目里的 `webhook-listener` 会让 0.1.5 抛
   `failed to apply loader entry webhook-listener (cordis:group)`。
   白名单：本插件条目（**id 是 `suggest-ghost`，不等于包名**）+ `hmr` +
   LLM 路由四条（`llm-pi-ai` / `agent-default-model` / `permission` / `locale`）。
   少了 LLM 那几条 ⇒ 没有模型可打 ⇒ 不出幽灵，而那**不是**代次缺陷。
5. 另需 `<home>/node_modules` → 被测树的 node_modules：dev-sandbox 把插件放在
   `<home>/plugin/`，那里没有可向上解析的 node_modules，0.1.5 实测报
   `failed to import loader entry suggest-ghost: Cannot find package '@deepseek-ai/schemastery'`。

HMR 那条前置（技能 §1b）**有效**：0.1.2 / 0.1.5 两棵树里的
`@deepseek-ai/cordis-plugin-hmr` 都是 **1.0.17**（带 `registerConfig`），patch 保留
`- id: hmr` + `disabled: false` ⇒ 本轮三代都没有出现"启动即崩"。
⚠️ 包名是**带作用域**的 `@deepseek-ai/cordis-plugin-hmr`，技能里写的非作用域名在树里不存在。

### 13.3 volatile 的落点随代次不同（②⑤ 取证必须两处都读）

| 代次 | `_push` / `_hot` 落在 |
|---|---|
| 0.1.7-rc.1 | `<home>/profiles/web/cordis.patch.yml`（本插件条目的 `config._push`） |
| 0.1.5-rc.3 / 0.1.2-rc.1 | **`<home>/settings.yaml`**（老内核的 settings 存储），profile patch 里没有 |

⇒ 只读 profile patch 会把后两者判成"没有证据"——那是**读错了地方**，不是插件没写。
`scripts/cross-kernel/volatile-evidence.mjs` 两处都读并在输出里标 `source`。
值是跨多行的单引号标量（内含建议正文），解析必须走到行尾闭合引号。

### 13.4 ④ 在 0.1.2 / 0.1.5-rc.3 **未判定**（不写成通过，也不写成缺陷）

观察到的事实（0.1.5-rc.3）：侧栏**没有** Plugins 入口（枚举可见标签只有
`Settings`/`New session`/`Add workspace`…），但 **Settings → Plugins 是存在的**
（先进 Settings 再枚举，`Plugins` 出现并可点）；点进去后
`document.body.innerText` 里**找不到** `dsh-suggest-ghost` 字样，
而我们 client 的 `<style data-plugin-css="dsh-suggest-ghost">` **确实注入了 1 个**。
0.1.2-rc.1 的探针连 Settings 都没找到（探针在重启后立刻跑，页面尚未就绪，属探针时机问题）。

⇒ 结论只能是**未判定**：现有证据既不足以说"卡片渲染出来了"（正文不可观测），
也不足以说"该代次打不开设置卡"（client 产物在、入口在）。
两种待排的可能：① 插件页是虚拟列表，卡片在视口外 ⇒ innerText 取不到；
② 0.1.x 的 settings UI 不渲染第三方插件卡。
下一步（不阻塞本节结论）：进 Plugins 页后按**元素**而不是按 innerText 找卡，并滚到可见。
⚠️ ①/④ 的差别不影响本节主结论：**幽灵画得出来本身已经证明 client bundle 在这三代都加载并运行了**。

### 13.5 本轮给驱动补的两条（都是"英文 UI"这一类）

- 工作区入口：`gui-round.mjs` 原来只按中文 `aria-label="添加工作区"/"选择工作区"` 找入口。
  0.1.5-rc.3 / 0.1.2-rc.1 整页是英文（`Add workspace` / `Choose workspace`）⇒ 得到
  「没有可用入口」⇒ 工作区设不上 ⇒ composer 永远 `phase=inert` ⇒ 必然不出幽灵，
  长得像"该代次不支持"。与 §11 修的 `dismiss()` 标签表是**同一类工具缺口**。
- 设置卡导航项：原来 `exact` 的正则把「插件/Plugins」和「设置/Settings」混在一起，
  `.find()` 按 DOM 顺序先撞上 `Settings` ⇒ 点进设置页却判"卡没出现"。改成**优先插件项**、
  Settings 只作 fallback，并在结果里标 `via`（`plugins-nav` / `loose` / `settings-fallback`）
  ⇒ 让"点错页"这件事自己说话。
- **没改的一条，留给后来人**：Settings → Plugins 是**两级**导航，驱动只会找顶层一项
  （§13.4 那个未判定就卡在这里）。

## 14. 流式投递（#109）跨代次实测：通道三代都能注册，但 **`running` 边沿在 0.1.2 拿不到**；另立一条**门禁回归**（2026-10-28，task-40，构建 `ad3ccd2`）

Gitea #108 / #41 / PR #109。测的是**已进 main 的那份产物**（`ad3ccd2`），不是 feature 分支。
三棵代表树各起一个**全新冷沙箱**、依赖一律来自**被测那代**（`--live-nm`），
每代交任务书要求的五项。

### 14.1 结论（先给判词，证据在下面各节）

| 判据 | 0.2.1-rc.2 | 0.1.7-rc.2 | 0.1.2-rc.1 |
|---|---|---|---|
| ① 通道真注册（四因子留痕，非"看起来有字"） | ✅ `streaming=1 ready=1 on=1 subs=1` | ✅ 同（**须先豁免**，见 §14.5） | ⚠️ 注册 ✅ 但 `subs=0`（见下） |
| ② 硬判据：增量帧不落盘 | ✅ 源码断言 + 每生成写次数与 OFF 同量级 | ✅ OFF 2.43 vs ON 3.17 次/生成（帧 2.3/生成 ⇒ 若落盘应≈5.5） | ✅ 无帧可落；`_push` 正常写 9 次 |
| ③ 提前量（同轮首帧→终帧） | **中位 112ms / p90 169ms**，8 轮全多帧 | **中位 174ms / p90 266ms**，5/6 多帧 | ❌ **未测出（没有帧）** |
| ④ 帧序正确性 | ✅ 8/8：帧号从 1 连续、终帧唯一且末帧、前缀不缩 | ✅ 5/5（同判据） | ⚪ 无帧可判 |
| ⑤ `running: true→false` 边沿是否可得 | ✅ 可得（客户端开流并收到帧） | ✅ **可得** —— 老代次同样有这枚边沿 | ❌ **拿不到**：宿主 7 次收口全 `subs=0`，页内 0 条 `stream open` |
| 非流式功能面（对照） | ✅ 幽灵正常 | ✅ 幽灵正常 | ✅ 幽灵正常（`gui-round` 拿到 21 字） |

⇒ **两条硬结论**：
1. **通道本身不是代次问题**：三代的宿主侧都注册成功（`@deepseek-ai/dsh-typert-protocol` 与
   网关 SRC 兜底在各代都是**自己的号**，lead 的静态推断在此被实测证实）。
2. **(c) 设计的命门在 0.1.2 上不成立**：整个方案押在客户端 `running: true→false` 那枚边沿上，
   0.1.2 上**边沿没触发过** ⇒ 流式在最老下界上退化成"什么都不发生"（不是报错、不是崩，
   是**静默无帧**）。0.1.7-rc.2 实测可得 ⇒ 分界线在 **0.1.7**。

### 14.2 提前量怎么量的（以及为什么不能靠页外轮询）

`scripts/stream-leadtime-measure.mjs`：CDP 驱动真 GUI，逐轮"新会话→真问题→回车"，
提前量 = **同一轮内首帧与终帧的页内 `performance.now()` 差**，由客户端逐帧打的 `t=` 算出。

- ⚠️ **页外 15ms 轮询量不到它**：实测两帧常挤在同一个采样间隔里，0.2.1 上一度把
  "批次数=1、提前量 0ms" 当成结论 —— 那是**量具分辨率**，不是产品事实。
- ⚠️ **分桶键只能是留痕顺序**：帧行不带会话号（只有 `stream open` 带），按 `session=` 分组
  会把 22 帧挤成一桶，算出"提前量 289 秒"这种荒唐数（本轮真实踩过并修）。

| 代次 | 每轮帧数 | 多帧轮 | 提前量分布（ms） | 中位 | p90 |
|---|---|---|---|---|---|
| 0.2.1-rc.2 | `[2,2,2,3,2,2,2,3]` | 8/8 | 34,57,78,78,112,114,130,169 | **112** | 169 |
| 0.1.7-rc.2 | `[4,1,3,2,2,2]` | 5/6 | 1,155,174,193,266 | **174** | 266 |
| 0.1.2-rc.1 | `[]` | 0/0 | — | — | — |

⇒ **两代同形**（都是 2–4 帧、百毫秒级、偶发单帧轮），与 task-30 预测的 91ms 同量级；
0.1.7 那轮里出现过一个 `1ms` 的多帧轮（两帧贴在一起）⇒ **提前量可以低到接近零**，
这比"中位 152ms"更该写进决策。

### 14.3 硬判据②在老代次上怎么复核（前缀边界不是可选项）

同一窗口内：

- 0.1.7-rc.2 ON：`(?<!hot )push landed` = **19**，裸 grep `push landed` = **38**，`hot push landed` = 19。
  ⇒ **裸 grep 会把数字放大一倍**（§9 那条坑在这里再次成立，本轮是定量版）。
- 判"增量帧不落盘"用的是**每生成的写次数**：OFF 2.43（7 生成/17 写）vs ON 3.17（6 生成/19 写），
  而 ON 那轮实际发了 **14 帧** ⇒ 若帧落盘应约 5.5 次/生成。实测远低于该值 ⇒ 判**成立**。
- 另有与代次无关的两条：**构造性**（`src/stream.ts` 不认识写面）+ **冒烟源码断言**
  （`stream-hub-smoke` 剥注释后查代码），所以这条不依赖单次日志计数。

### 14.4 老代次 volatile 的落点差异会直接决定开关读不读得到

`scripts/cross-kernel/volatile-evidence.mjs` 实测 `source`：

| 代次 | volatile 落在 | `streamingDelivery` 怎么设才生效 |
|---|---|---|
| 0.1.7-rc.2 | `profiles/web/cordis.patch.yml` | 写进本插件条目 `config:` 下 ✅（实测 `on=1`） |
| 0.1.2-rc.1 | **`<home>/settings.yaml`** | 同一条 patch 配置也被读到了（`on=1`），但 `_push`/`_hot` 取证必须去 `settings.yaml` 找 —— **别只读 patch** |

⇒ 任务书那条提醒是对的、且**方向要补一句**：0.1.2 上"配置读到了"与"载荷落在哪"是两处，
`live settings refreshed` 那行在 0.1.2 **根本没出现**（该代次没有这条痕），
所以判"配置有没有生效"只能靠四因子行里的 `on=`。

### 14.5 立案：**#109 把插件从三个代次上抹掉了**（peer 语义被内核门禁当真执行）

`scripts/cross-kernel/gate-matrix.mjs`（用**各代自己的** `evaluatePluginCompatibility`）实测：

```
[RED]  0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2
       declared supported but unmet under BOTH engines.dsh and peer semantics
       met under engines.dsh=null  peers=false  (semantics: peers-only)
[GREEN] 0.2.1-rc.2
[UNDETERMINED] 0.1.2-rc.1 / 0.1.5-rc.3 —— 这两代不跑插件准入门禁（无 evaluatePluginCompatibility）
EXIT 2
```

真 GUI 侧的同一条证据（0.1.7-rc.2，豁免前）：

```
dsh: skipping profile bundle "dsh-suggest-ghost": Error: Plugin dsh-suggest-ghost@0.7.0 is
incompatible with dsh 0.1.7-rc.2: peerDependencies {"@deepseek-ai/dsh-typert-protocol":"^0.2.1-rc.2"}.
… To accept this risk explicitly, grant the exact-version exemption … `dsh plugin allow-version` …
Exact-version exemption: not active.
```

**成因**：#109 把协议包声明成 `peerDependencies` + `peerDependenciesMeta.optional: true`，
想的是"可选依赖拿不到就降级"。但 **0.1.7–0.2.0 的准入门禁只看 peer 范围、不看 optional 标记**
（≤0.2.0 是 peers-only 语义，`engines.dsh` 不参与）⇒ 一个"可选"声明被当成**硬要求**执行，
插件在 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 上**直接不装载**。0.1.2 / 0.1.5 侥幸没受影响，
纯粹因为那两代**没有门禁**——不是设计如此。

**影响面**：`engines.dsh` 声明下界到 `0.1.2-rc.1`，而 #109 之后**三个代次失去整个插件**
（不只是失去流式：幽灵、补全、热度全没）。这是一次**功能性回归**。

**修法（都要走 PR，本任务书不许我动产品代码）**：
- 首选：把协议包从 `peerDependencies` **移出去**（改成本地 ambient 面 + 动态 import 的
  "拿到就用、拿不到降级"，或放 `optionalDependencies` 的非 peer 位置）——只要它**不出现在
  peers-only 门禁读的字段里**，回归就消失；
- 或：按逐代枚举写范围（`^0.1.7-rc.2 || ^0.2.0-rc.2 || ^0.2.1-rc.2`），代价是这本来就是个
  实现细节而非兼容边界；
- **别用 `dsh plugin allow-version` 当解**——那是用户手工承担风险的豁免，不是插件的兼容声明。

### 14.6 三条**工具面**缺陷（都是我这两轮踩的，已修进脚本；不改产品代码）

1. **locale 盲**：0.1.2-rc.1 的界面是**英文**（`Add workspace` / `New session`），驱动只搜中文
   ⇒ 报 `no-opener`，被误判成"这代不支持"。同代 `gui-round`（有英文兜底）拿到了 21 字幽灵
   ⇒ **是工具的语言面缺陷**。（§13 早写过中英都要试，我的新脚本没抄。）
2. **首屏时机**：固定 `sleep(9s)` 在冷沙箱不够（0.2.1 实测 9s 时 `composers: []`，20s+ 才
   `phase=plain`）⇒ picker 拿不到行、整轮空跑。改成**轮询 composer 的 `phase`**，
   仍不拿 `[role=dialog]` 计数当门。
3. **行匹配没有兜底**：老代次 picker 的列表里拿不到目标行（`row-missing`）时应当走
   **路径框 + 打开**那条第二路（`gui-round` 早就实现了）；我的脚本补上后 0.1.7 立刻跑通。

### 14.7 复跑命令（当前可复跑）

```bash
# 0.2.1-rc.2（门禁自然通过）
node scripts/dev-sandbox.mjs --home ~/xk-str-0212 --rewrite 'port: 3983=port: 4181' \
  --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh --live-nm ~/dsh-versions/0.2.1-rc.2/node_modules
node scripts/cross-kernel/prune-bundles.mjs --home ~/xk-str-0212 --tree ~/dsh-versions/0.2.1-rc.2
node scripts/dev-sandbox.mjs --home ~/xk-str-0212 --deploy . --bin … --live-nm …    # deploy 不碰 profile 条目
rm -f ~/xk-str-0212/profiles/web/node_modules/dsh-suggest-ghost                     # 把软链换成实体副本
cp -r ~/xk-str-0212/plugin ~/xk-str-0212/profiles/web/node_modules/dsh-suggest-ghost
# 本插件条目 config: 下加 streamingDelivery: true，再起一次，然后：
node scripts/stream-leadtime-measure.mjs --home ~/xk-str-0212 --rounds 8 --label xk-0212 --ws ~/xk-str-ws

# 0.1.7-rc.2：上面全部换成 0.1.7-rc.2 路径，并**额外**加豁免（否则插件不装载，见 §14.5）
DSH_HOME=~/xk-str-0172 node ~/dsh-versions/0.1.7-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile web allow-version dsh-suggest-ghost@0.7.0 --dsh-version 0.1.7-rc.2 --accept-risk
```

⚠️ 两处沙箱专属：① **实体副本**（软链会让宿主侧动态 import 失败，#109 §1 已写）；
② **豁免只加在沙箱里**，它不是兼容声明（§14.5）。
依赖归属自证：`readlink <home>/node_modules/@deepseek-ai/cordis` 必须指向被测树。

### 14.8 未判定（没测的写在这里，不混进上面）

- **0.1.2 上 `running` 为什么拿不到**：观测是"宿主 7 次收口全 `subs=0` + 页内 0 条 `stream open`"，
  但**机制未证**。三条候选都没排除：(a) 该代会话快照根本没有 `running` 字段；(b) 字段有但
  语义不同（回合结束时不经过 `true`）；(c) 客户端 `session.subscribe` 在这代不在边沿上触发。
  下一步该做的是**把 `bound.session.getSnapshot()` 的键名打在页内**，一代一条，别再靠 grep 内核
  产物猜（我这次 grep `dsh-session/lib` 三代都是 0 命中 —— 那个字段不在那儿，grep 到的"没有"
  不是"不存在"）。
- **0.1.5-rc.3 / 0.1.7-rc.1 / 0.2.0-rc.2 的运行时**：门禁面有结论（§14.5），
  但**没起过 GUI**；`0.1.5-rc.3` 还额外受 `.bin/dsh` 是 sh 包装（§13.2 第 2 步）影响。
- **写放大归因**（#109 遗留）：本轮 OFF/ON 各一轮，n=6–7，仍不足以归因 ⇒ 继续挂未判定。
- **双标签页并发帧序**：冒烟覆盖了"两条订阅各自收帧"，真 GUI 双页仍未测。
- **`content_deltas=1` 那 ~9% 轮次要不要退回整块**：0.1.7 实测确实出现过单帧轮，
  策略问题留给 #108 决策。

### 14.9 物证

- `scripts/cross-kernel/out/gate.json`（门禁矩阵机器输出，EXIT 2 = 有未判定）
- `docs/cross-kernel-shots/0.2.1-rc.2-streaming-PASS.png`
- `docs/cross-kernel-shots/0.1.7-rc.2-streaming-PASS-exempt.png`（**豁免后才装载**，名字里写明了）
- `docs/cross-kernel-shots/0.1.2-rc.1-streaming-NOSTREAM-ghost-only.png`（**未判定/失败侧也要出图**：
  幽灵走 `_push` 出来了，但流式一帧没有）
- 各沙箱 `logs/sbx.log`（四因子行、`stream turn closed subs=`、`(?<!hot )push landed` 计数）

### 14.10 追加：#110 的修法实测（task-41 / PR #112）【当前可复跑】

task-40 立的 **#110**（#109 的 optional peer 声明被 ≤0.2.0 的 peers-only 门禁当硬要求执行
⇒ 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 上**整个插件不装载**）已修，只改声明面：
**把协议包从 `peerDependencies` / `peerDependenciesMeta` 移出**，运行侧维持
「动态 import + 失败降级」。⚠️ **没有**用"放宽成通配范围"那种修法（那等于把不支持说成支持）。

逐代次 `verify:kernels` 原样输出（修好的 manifest）：

```
汇总：绿 6 / 红 0 / 未判定 0；门禁分面 红 0 / 未判定 2（EXIT=2）
[GREEN]        0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2
[UNDETERMINED] 0.1.2-rc.1 / 0.1.5-rc.3 —— this generation runs no plugin admission gate
```

**反证（重点在这条）**：只把那条 peer 声明原样加回去、其它一字不动 ⇒ `绿 3 / 红 3`、**退出码 1**。
⇒ 闸会咬，不是数条目数的假绿。`gate-matrix --self-test` 六条全 PASS（含新加的两条）。

顺带修了闸本身的两处口径缺陷：

1. **`verify:kernels` 原先看不见这件事**：它的 verdict 量的是装配 + 投影，**不调**
   `evaluatePluginCompatibility` ⇒ **"合并 #109 时就算跑了 verify:kernels 也不会红"**。
   现在准入分面（`gate-matrix`）被合成进这条合并入口。
   ⇒ 记一句：**入口存在 ≠ 入口覆盖了这个面**，这两件事要分别核。
2. **退出码原来用 `max()` 合成** ⇒ 反证那一轮报"红 3"却退出 **2**，把"有红"读成"只是没测到"。
   现在**红压过未判定**（红 = 1 / 无红有未判定 = 2 / 全绿 = 0），两个方向都实测过。

运行时实测（不停在声明面）：

| 代次 | 装载 | 界面 |
|---|---|---|
| 0.1.7-rc.2 | **不给任何豁免**：`skipping=0`、`apply called`、`stream channel registered` | 真回合出幽灵 18 字 |
| 0.1.2-rc.1 | `skipping=0`、`apply called`、四因子 `streaming=0 ready=1 on=0 subs=0`（默认关） | 真回合出**整块**幽灵 16 字 ⇒ **没把 0.1.2 的整块路径带坏** |
| 0.2.1-rc.2 | 正常 | 开关开、`subs=1`；4 条收过终帧的流帧序全通过，提前量 29–145ms（中位 104ms） |

⇒ **#108 的「启用前置」收窄成一条**：只剩**部署形态**（软链开发态 vs 打包实体安装），
代次那一档不再是障碍。0.1.2 的 `subs` 恒 0 仍挂在 **#111**（机制未证）。

**这一节里我自己判掉的两处**（都是工具面，别再复用错判据）：

- **`row-missing` 不是装载回归**。全新工作区不出现在 picker 的"最近用过"列表里，而我又漏了
  gui-round 那条"关掉重开再判一次"（目录树异步加载）与 `title` 属性匹配 ⇒ 拿 `skipping=0`
  复核之后才发现插件装得好好的。**误判源是我自己的驱动**，不是宿主。
- **帧序断言把合法行为判成违规**：改草稿即撤流 ⇒ 一条流可以**没有终帧**
  （这是硬约束 4「中途显示的内容允许被丢弃」推到极致的样子：不是被终帧修正，是整条流提前收尾，
  权威态仍来自随后那一次 `_push`）。上一版把它算成违规并 exit 4；现在只判"收过终帧的流"，
  无终帧的记成 `earlyClose` 不计违规。
- ⚠️ 反引号那条纪律**又犯了一次**（注释里写反引号 ⇒ 模板字符串提前结束），
  但这次是 `node --check` **当场拦住的** ⇒ 印证 §8：改完注入体/生成脚本先单独做语法检查，
  再看有没有落盘。

**未判定（不变）**：0.1.2 边沿机制；写放大归因；双标签页并发帧序；`content_deltas=1` 那部分轮次的策略。

## 15. 流式投递的 GIF 录制（task-42）：录制方法本身就是判据，三条实测坑（2026-10-28，构建 `5b13d76`）

Gitea #108 / #41。产物：`docs/cross-kernel-shots/streaming-0.2.1-rc.2.gif`、
`streaming-0.1.2-rc.1.gif`；脚本 `scripts/cross-kernel/stream-gif-record.mjs` + `stream-gif-stack.mjs`；
复跑口径写在 `docs/cross-kernel-shots/README.md`。

### 15.1 结论：**看不出**，而且"看不出"有定量理由

| 代次 | 可见增长步（真实提前量） | 说明 |
|---|---|---|
| 0.2.1-rc.2 | **36ms / 90ms**（两轮；第三轮无留痕） | 每轮就是"两个可见状态"，中间没有第三次 |
| 0.1.2-rc.1 | **无** —— `streaming=1 ready=1 on=1 subs=0` ×3 | 宿主武装完毕、客户端一次都没开流（#111） |

一次流式投递**只产生 2 帧**（`frame=1 final=0` → `frame=2 final=1`），间隔 36~90ms；
而**一次回合要 8~25 秒**。⇒ 正常速率下 GIF 里根本看不见差别；要"看得见"就必须把
回合时长压掉、只放那 90ms —— 那就是造假。所以产物选择：**每格烧真实时刻 + 真实字符数，
播放轴固定 1500ms 并在画面里写明名义慢放**。

### 15.2 我当场撤回的一条错误结论

中途我判过"**这一代次根本没有可见的中间帧**"（依据是轮 2 的 `12 字符 → 36ms 后仍是 12 字符`）。
**这条说错了**：那是**那一轮**的终帧没带新字符（净化后的前缀已经给完），不是普遍规律 ——
同代次另一轮是 `6 → 13 字符 / 90ms`，确实可见。撤回的教训：**一帧的形状不能从一推三**，
本轮第 3 次犯同族错（前两次：`row-missing` 当成装载回归、回合时长当成提前量）。

### 15.3 三条录制方法学坑（都会伪装成"产品不行"）

1. **burst 必须贴着回车起**。`insertText` 与两次 `dispatchKeyEvent` 各是一趟 CDP 往返（合计 ~240ms），
   在它们**之前**起 burst ⇒ 起点偏后，而回合只有 ~11 秒 ⇒ 宿主那几帧落在窗口之前，
   页内一条都抓不到，还会把**下一轮**的幽灵当成本轮的变化（实测读到"跨度 28854ms"）。
2. **页内留痕必须按轮切**。`consoleLines` 是整页累积的，早期版本每轮 `slice(-8)` 全局尾部
   ⇒ 轮 2 装着轮 1 的帧、轮 3 装着 1+2 的帧，"提前量"被读成 71636ms。
3. **两种时刻不可混用，也不可互相冒充**：
   - `console` 的 `stream frame … t=`：页内绝对时钟，逐帧、**权威**；
   - burst 事件：只在 DOM 文本变化处**才盖时刻**，于是把"提交→回合完成"整段空白
     读成一个事件 ⇒ 它的跨度含回合时长。
   ⇒ 装配按"有逐帧留痕就用逐帧，没有才回退 burst，并在格子上标明来源"，
     绝不把 burst 的跨度印成"提前量"（上一版印成 `真实提前量 6852ms / 慢放 1500×` 就是这种错）。

### 15.4 顺带实测到的两条产品/代次事实

- **0.1.2-rc.1 的 volatile 落点确认是 `<home>/settings.yaml`**：写进 profile patch 时
  四因子是 `on=0`（配置根本没读到），写进 `settings.yaml` 才变 `on=1`。
  ⇒ `FINDINGS` §13.3 那条"落点随代次不同"在**设置项**上同样成立，不止在 `_push`/`_hot` 载体上。
- **只截 composer 区域**这条不是卫生问题：整页截图会把 profile 内容与会话名带进产物（本仓已泄漏过两次）。
  headless 下 `Page.screencastFrame` **一帧都不推**（实测 `cast=0`），所以逐事件抓图 + 页内时刻是这里可行的做法。

### 15.5 未判定

- **左右并排同一条横轴**（任务书原始形状）没做：开与关是两次冷启动，`performance.now()` 每次从 0 起算
  ⇒ 两个 t=0 没有对应关系。要做对需在同一次运行里同时拿到两路（同一 `t0`），
  而那要改产品或引入双命名空间 —— 本任务书不许改产品 ⇒ 挂未判定。
- 0.1.7-rc.2 本轮没重录（`sub=1` 与提前量 174ms 是 §14 的数据）；GIF 只交了 0.2.1 与 0.1.2 两张。
- 录制器自身的稳定性：同一沙箱连跑三轮里有一轮没抓到逐帧留痕（回合完成得比 burst 采样更早？
  未证），**"0 帧"不能当作"该产品行为"的证据**，只当采样失败。

## 16. 流式效果的可视化（task-43）：**"断言全绿而图是错的"这一类**，以及我把自己驱动写坏却去怪环境（2026-10-29，基线 `52e3ffe`）

Gitea #108 / #113。

> **⚠️ 本节的图不交付（撤回），但撤回的"理由"我先前写错了两次，现按实测更正。**
> 我先后写过两个错理由：① "格子里那行字是首屏欢迎模态的文案"；② "我的注入不产生任何像素差、
> 重绘根本没生效"。**两条都不成立**，逐条实测如下。
>
> - **那行灰字是产品自己的真实 overlay。** 在干净沙箱上重跑合成脚本、把单个格子裁出来看，
>   读到的是 **`怎么用 ss -tlnp`** —— 正是该沙箱里产品真实渲染的幽灵（不是模态文案，
>   也不是脚本写进去的 `字字字…` 占位）。**⇒ "真实像素里有幽灵 overlay"这件事已被证明。**
> - **注入是有效的。** 对照实验用 PIL 逐像素比（**不是** ImageMagick `compare` 的 stdout）：
>   A（无注入）vs B（注入一行灰字）**不同像素 91,413**、浅灰采样 10,667 → 20,722，
>   裁出的差异带里能看见注入的那行 `字`×12 以产品同款浅灰渲染。
>   我先前那句"A≡B、AE=0 ⇒ 注入无效"来自**我自己解析 `compare` 输出的 bug**（AE=0 与
>   "差异外接框=整幅"自相矛盾，当时没警觉）。**⇒ 工具报错也要自证：判据的数值互相矛盾时，先怀疑判据。**
> - **三格内容相同**的真实原因：合成脚本把格子裁在"文字矩形"上，而**页面上产品的 overlay
>   已经在那儿、内容不变**；我注入的那个 div 与它同位同色，**被同一份真实文字盖住**，
>   于是每格拍到的都是**同一行真实幽灵** ⇒ 三格相同、没有增长。
>   （不是"重绘没生效"，也不是"拍到了模态"。）
>
> **正面结论（这条决定 #113 的范围）**：
> **真实像素含幽灵 overlay（终态）已被证明；未证明的只是"中间态"** ——
> 帧间隔 30–90ms 抓不到像素，且回合结束后 DOM 清空 ⇒ 事后取不回中间态。
> ⇒ **#113 只需解决"中间态事后取不回来"，不需要重新证明幽灵可见。**
>
> **仍然成立、可复跑的硬证据**（客户端页内 `performance.now()`，3 轮全保留、未剔）：
> 轮1 `12 → 26 → 26(终帧)` 间隔 90ms / 22ms、全程 112ms；轮2 `8 → 9(终帧)` 572ms；轮3 `7 → 11(终帧)` 76ms。
> **0.1.2 那张对照同样不交。**

### 16.1 最重要的一条：断言通过 ≠ 断言问的是我要的那个问题（本轮犯了**两次**）

第一版我加了任务书要求的两道自证断言，**全绿**：

```
A（clip ∩ 输入元素 bbox）    6/6 intersects=true
B（Range 文字矩形 w/h>0）     chars=6 rect w=58 / chars=13 rect w=95 / 12→91 / 21→207
```

而**图里根本没有那行浅灰字** —— 截到的是工具条那一行（完全权限 / Qwen3.8-Flash / 上传按钮）。
成因：我把 overlay 挂在一个 `position:static` 的祖先下，`getBoundingClientRect()` 量到的盒子
与"我据此算出的裁切框"**不在同一个坐标系里**，于是"量到了文字"与"截到了文字"是两件事。

⇒ 补的第三条断言必须是**像素侧**的：**裁切框内该文字盒位置上确有浅灰墨迹**。
本轮做成了工具（`stream-gif2-rerender.mjs` 里每格算墨迹采样数），实测：

```
轮1  before 1345 → 12字 43658 → 26字 125550 → 终帧 125550
轮2  before 1026 →  8字 33024 →  9字  35381
```

**这一类形态以前没登记过**：不是"判据没跑"，也不是"判据太松"，而是**判据与用户要看的东西不同轴**。
以后凡是"图/截图/可视化"类交付，判据里必须有一条**读像素**的，不能只有读 DOM 的；
**而且这条读像素的判据必须核"内容对不对"，不能只核"有没有墨迹"** ——
16.5 那次就是墨迹有、内容却是模态文案，我差点签了"眼验通过"。

### 16.2 我撤回一条自己刚写下的"环境结论"

我报过"**这个沙箱的 GUI 走不完一次回合**"（依据：`msgs=0`、`running:true` 挂 150–180s、
新沙箱 `contenteditable=false`）。lead 打回后按他的四条逐一查，**结论错了**：

| 他给的候选 | 实测 |
|---|---|
| (1) 凭据/路由 | 未命中 —— 重放里模型确实回话 |
| (2) 回合在跑但极慢 | **命中** —— 日志有 `completion timeout: no settle within 45000ms`；我却把采样窗口按秒级设 |
| (3) `msgs=0` | 我的选择器错（该宿主不用 `[data-message-id]`），不是"回合没发生" |
| (4) `contenteditable=false / phase=inert` | **命中** —— 全新沙箱工作区没设上，属工具面 |

**复现证据**：同一台机器、同一代次、冷启动，跑 task-40 那份驱动
（`scripts/stream-leadtime-measure.mjs`）立刻拿到 `帧行=4`、提前量 56/65ms。
⇒ **根因是我这轮为了"改进"删掉了每轮的 `newSession()` 并把窗口设成秒级**，
不是环境退化。**"环境不行"是我最容易用来给自己收尾的借口，这次被实测推翻。**

### 16.3 真实逐帧数据（时刻全部来自客户端页内 `performance.now()`）

```
轮1  12 → 26 → 26(终帧)   间隔 90ms / 22ms，全程 112ms
轮2   8 →  9(终帧)        间隔 572ms（首帧后模型只补了 1 字）
轮3   7 → 11(终帧)        间隔 76ms
```

3 轮全部保留，未剔任何一轮。**中间态像素抓不到**是结构性的：帧间隔 30–90ms，
而一次截图往返 ~30ms —— task-42 那三张旧截图的像素经比对**完全相同**（浅灰采样 11413 vs 11413），
证明当时三张都是终态。⇒ 所以本节的图是**重建图**，图头明写"本图非截图"。

### 16.4 一条前置判据（做成了工具，不是一次性）

`stream-gif2-shots.mjs` 现在**拒绝**在没设 `DSH_SUGGEST_GHOST_TRACE=debug` 的实例上运行：
逐帧留痕走 `console.debug`，默认阈值 warn 会整条静音 ⇒ 我会拿着一张空表继续往下走，
并把"空表"解释成"产品没出帧"（本轮就是这么被骗的）。**宁可拒绝开工，不交空结论。**

### 16.5 未判定 / 后续

- **真实像素的中间态**仍未拿到（要 #113：overlay 写 `data-stream-frames`，只存 frame/chars/t、不存正文）。
- 0.1.2-rc.1 的对照图本轮**不交**（按"要么看得清要么别交"）。
- 重建图与 GIF 只覆盖 0.2.1-rc.2；0.1.7-rc.2 未重录。

### 16.6 一条操作纪律（本轮的学费，进 §8 同族）

**未跟踪的产出脚本 = 没有脚本。** 我这轮把逐帧数据跑出来了，但录制器是**未跟踪文件**，
我在它上面做字符串手术把文件改坏，git 里没有副本 ⇒ **恢复不了**，只能靠它留下的 `record.json`。
⇒ 规矩：**先 `git add` 再改**（哪怕当时觉得"还不可交付"）；改坏未跟踪文件等价于删掉实验本身。

## 17. 幽灵逐段变长的重建图与 GIF（task-44）：**先置空产品 overlay，再按逐帧留痕重绘**（2026-10-29，基线 `5150c83`）

Gitea #108 / #113。产物：
- `docs/cross-kernel-shots/streaming-0.2.1-rc.2-stream.gif`（179,561 B，7 格，每格停留按**真实间隔比例**）
- `scripts/cross-kernel/out/gif3-rebuild/two-cells-r{1,2,3}.png`（三轮对比图，供眼验）
- 脚本：`stream-gif3-rebuild.mjs`（录制+置空+重建）、`stream-gif3-measure.py`（四道断言）、
  `stream-gif3-compose.py`（拼版/GIF 帧）、`stream-gif3-gif.py`（编码）
- 顺带删除 §15 遗留的 `streaming-0.2.1-rc.2.gif`：它画的是"流式开第 k 帧 vs 关流"的**共享时间轴**，
  而那条轴是 §15.3 已证伪的跨轮累积产物 ⇒ 留着比删掉更坏。

### 17.1 这一节能成，只因为一句：**画之前先把产品 overlay 置空**

§16 查明的失败真因是"注入的灰字与真实 overlay 同位同色同字体 ⇒ 被同一份真实文字盖住"。
所以这次的顺序是硬性的：**真回合跑到终态 → 截"含真实幽灵"（正面证据）→ 置空 overlay
（`visibility:hidden` 保留布局）→ 再截（断言 B 的底）→ 按逐帧留痕在同一盒子、用产品自己的
computed style 逐帧重绘**。置空之后，画面里那行灰字**只能是我画的**。

### 17.2 四道断言的实测数字（全部落在**真实截图**上，PIL 逐像素，3 轮全过）

下面是**修好首字被裁**（裁切左边界 12→28px）之后重测的那一轮 —— 改了框就重跑，不重跑不算数：

```
轮1  A=true  B墨迹=0  C墨迹 2430→9620→15044（单调）  D跨度 167→464→686px 对应 5→11→15 字符
轮2  A=true  B墨迹=0  C墨迹 10102→14663（单调）      D跨度 387→670px      对应 7→12 字符
轮3  A=true  B墨迹=0  C墨迹 5584→5584                D跨度 165→165px      对应 3→3  字符
```

逐帧数据（页内 `performance.now()`，**3 轮全保留、未剔任何一轮**）：
轮1 `5 → 11 → 15(终帧)`，t=+0/97/142ms；轮2 `7 → 12(终帧)`，t=+0/85ms；轮3 `3 → 3(终帧)`，t=+0/34ms。
⇒ **轮 3 终帧没带来新字符 ⇒ 该轮"无逐帧可见增长"**，照实保留、不剔、**不补帧**。
⇒ GIF 每格停留时长**按真实间隔比例**映射（实测间隔 97/45/85/34ms → 260–1600ms），
   不用统一 1500ms 把快慢抹平；每帧图上都带一行"**格与格之间的停留时长 ∝ 真实帧间隔 · 本图非录像**"
   —— GIF 会被单独转发，口径必须跟着图走，不能只写在 README 里。

### 17.3 判据把我纠正了三次 —— 同一类错的三种形态，都记下来

1. **颜色判据不区分"我要量的"和"长得像它的"**：浅灰只要求"三通道接近"，于是把中性灰
   UI 边框 `(223,223,223)` 算成墨迹 ⇒ B 报 405（其实是边框）、D 跨度=整幅（其实是左右两条边）。
   收紧为**冷灰 `b-r∈[4,30]`**（产品幽灵色 `#9aa0a6`，b 比 r 大 ~12）后 B 精确 = 0。
2. **为了救一个问题把框扩大**：字形下沿被切，我一时把 clip 多留 48px ⇒ 把**下面工具条的冷灰图标**
   圈进来，B 立刻从 0 变 6165。正解是贴着 overlay 自身盒子，高度不够**加高视口**（880→1100；
   矮视口时是**文档边缘**在切字形，不是我的裁切）。
3. **每条断言各测各的，没人问"字还在框里吗"**：重建锚点用"输入框下沿+2"，而 overlay 盒子比文字高
   ⇒ 重建的那行字落到裁切框**外面** ⇒ **B 完美(0) 而 C 全是 0**。改成锚到 overlay 自身盒子才对。

⇒ 通用一条：**断言之间要能互相对账**（B=0 与 C=0 同时成立时，说明"框里根本没有字"，
   而不是"置空成功且没有增长"）。这次是 D 的跨度全 0 把我逼回去查的。

### 17.4 标注也是交付物的一部分

PIL 默认字体不画中文 ⇒ 第一版标注全是方块；改用 ImageMagick `-annotate` 又**丢中文字形**
（"重建图""轮""置空后"整块不见了）。最终用真实 TTF（`wqy-zenhei.ttc`）画。
⇒ **标注坏了就是坏交付**：一张内容正确、标签是方块的图，用户无法判断它声称了什么。

### 17.5 口径（写死在图头，不许含糊）

> **重建图，非录像**：底图为该代次真实界面截图；产品 overlay 已置空；
> 灰字按客户端逐帧留痕（真实 `t=` 与字符数）在真实样式下重绘。
> **真实像素含幽灵（终态）已由 §16 证明；本图展示的是逐帧增长过程，其逐帧数据为实测。**

⇒ 不许写"这就是流式效果"，也不许写"非截图"（底图确实是截图）。

### 17.6 未判定 / 后续

- **真实像素的中间态仍未拍到**（帧间隔 77–352ms 内截图往返 ~30ms，且回合结束后 DOM 清空）
  ⇒ #113 落地后可把本图的"重绘"换成"真录像"，届时**断言 B 应当不再是 0**（真像素自带中间态）。
- 本轮只覆盖 0.2.1-rc.2；0.1.7-rc.2 未重录；0.1.2-rc.1 仍**不交**（按"要么看得清要么别交"）。
- **给 #113 落地后的那一版留一句话（两版不许混着讲）**：那一版应当**不需要"置空 + 重绘"**——
  直接按 `data-stream-frames` 重建真实 DOM 再截图，届时**断言 B 不应再是 0**（真像素自带中间态），
  而 §17.1 的"置空"这一步应当整段删除。本节这张图是"没有 #113 时能做到的上限"，不是最终形态。
- 建议文本长度由模型决定，本轮三轮分别只到 12/11/7 字符 ⇒ **增长步数少是产品行为，不是采样失败**；
  若要多步，需换更长的提示词并**声明**（本轮未换，沿用同一组三问）。

### 17.7 图上的话与图本身不符 —— 断言 E 才抓出来（lead 回读发现，我没自查）

每格图上都印着"**格与格之间的停留时长 ∝ 真实帧间隔**"。而交付的文件里 **18 帧全是 50ms**
（唯一值 `{50}`，总时长 900ms）。三个**互相独立**的成因，全部只有"回读产物"才能发现：

1. **`-vf fps=20` 把 concat 的 `duration` 指令重采样掉** ⇒ 脚本里确实算了 260–1600ms 的映射，
   编码那一步全丢了。
2. **compose 三轮写进同一批文件名**（`gif-00/01/02.png`）⇒ 后一轮覆盖前一轮，
   交付的 GIF 其实只有**轮 3 的格子重复三遍**；我报告里写的"8 格"也是错的（文件里 18 帧）。
3. 改 `-vsync passthrough` 之后，ffmpeg 又把 9 帧**吃掉 5 帧**（只剩 4 帧）；
   改回 PIL 逐帧 `duration` 后，末帧与前一帧**内容完全相同**又被 PIL **合并**
   （320ms + 700ms 被并成 1020ms、帧数少 1）⇒ 给循环帧画了角标让它真的不同。

⇒ 断言 E（`stream-gif3-verify-gif.py`，**重新打开交付的 GIF 逐帧读 duration**）：
```
计划格数 = 9   文件帧数 = 10（末帧为循环重复帧，显式解释）
实测 duration = [260, 1600, 320, 260, 1600, 320, 260, 1600, 320, 700]
E1 帧数 == 格数+1 ✓   E2 每帧与目标一致（最大偏差 0ms）✓   E3 时长不全等（唯一值 260/320/700/1600）✓
```

⇒ **通用规矩（进 §8）：印在交付物上的每一句话，都必须有一条读交付物本身的断言。**
   本轮 A–D 四条断言全在"图片内容"上，**没有一条读 GIF 文件的帧表**——
   于是"内容正确、载体说谎"的产物顺利通过了全部断言。这与 §16 那三条同族：
   **断言通过 ≠ 断言问的是我要的那个问题**，只不过这次漏问的是"文件本身"。

### 17.8 交付的 GIF 有个我没想到的缺陷：**disposal=0 让"置空起点格"在屏幕上根本不空**

lead 指出"起点格被排在每组末尾 ⇒ 用户看到 出现 → 变长 → **消失** → 又出现"。
我把格序改成 `起点 → 逐帧 → 终帧` 之后，**新写的 E4 仍然 FAIL** —— 于是发现了更深的一层：

**GIF 默认 disposal=0/"keep"，每一格是画在上一格的残留位图上的。**
所以"置空起点"那一格在屏幕上并不空，它只是把上一轮的终帧留在原地 ——
实测合成后该格墨迹 **15,837**（它自己的源 PNG 只有 606）。
⇒ 修法是 `save(..., disposal=2)`（restore-to-background），加上之后合成画面变成：
```
组1 [177, 2764, 7913]   组2 [181, 2812, 2801]   组3 [181, 3325, 6226]   （末格=循环重复帧）
```
⇒ **两个独立的错**（格序 + disposal）叠在一起，才造成"文字会消失"的观感；只修一个都不够。

**测这一层时我又踩到第三个坑（这次自己抓回来了）**：用 PIL **裸 seek** 逐帧读，读到的是
**增量帧**（画布是上一帧的遗留），于是得出"起点格有 5370 墨迹"的**假结论**，
差点让我判 E4 不过。正确做法是**把 GIF 合成回画面再量**（ffmpeg `select='gt(pts-prev_pts,0)'`
抽内容变化帧）。⇒ 与 lead 那条同族：**读 GIF 要用会正确处理 disposal 的工具，手工累加/裸 seek 都不可信。**

⇒ 断言 E 现在包含 **E4：合成后逐格墨迹**，专测"载体层面的语义"（帧序 + disposal），
  而不只是"每格画了什么"。规矩仍是那条：**印在交付物上的每一句话，都要有一条读交付物本身的断言**
  —— 这次连"读"的方式都必须是**合成后**的读法。

### 17.9 顺带把 PIL 的静默合并写进 §17.7 那条规矩（lead 要求）

**PIL 会静默合并相邻的同内容帧**（实测 320ms + 700ms 被并成一帧 1020ms、帧数少 1），
不报错、不提示，**写入值与文件里的值就是不一样**
⇒ **帧数与时长必须回读文件核对，不能信写入值。**（给循环帧画角标让它真的不同，只是绕开，
   真正的保险是 E1/E4c 那类"数一数文件里到底有几帧"。）

## 18. 真实像素版：产品 overlay 自己渲染逐帧内容（task-46，2026-10-29，基线 `f79306a`，含 #114）

Gitea #108 / #113。产物：`docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif`
（446,681 B，11 格 + 1 循环帧）；脚本 `stream-replay-record.mjs` / `stream-replay-measure.py` /
`stream-replay-gif.py` / `stream-replay-verify-gif.py`。

### 18.1 与 §17 的本质差别（为什么这一版更可信）

| | §17 手绘重绘版 | §18 产品重放版（本节） |
|---|---|---|
| 字由谁渲染 | **我另建的一个 div**，样式常量抄自产品源码 | **产品自己的 `#dsh-suggest-ghost-overlay` 元素** |
| 内容来源 | 占位符 `字`×N（只保证长度对） | 终态真实文本的前缀（产品语义：净化前缀恒为终态前缀） |
| 逐帧数据校验 | 单一来源（console 留痕） | **两条独立来源逐格对齐**（DOM `data-stream-frames` × console 留痕）＝断言 F |
| 可信度 | "看起来像产品的字" | "产品的代码渲染的字" |

⇒ **§17 那张仍然有效**（口径已写明"我画的 div"），但要看"产品长什么样"应当用 §18 这张。

### 18.2 断言实测（A–F 全过，3 轮全保留、未剔）

```
F) 两条来源逐格对齐：3 轮 chars 全等=true、t(±5ms) 全等=true
   轮1 7→11(+71ms)   轮2 5→9(+76ms)→9(+112ms)   轮3 11→23(+66ms)→23(+95ms 终帧)
A–D（源格，PIL 局部对比度）：
   轮1 B=0 C=[11458,19637]        D=[338,562]  对应 7→11 字符
   轮2 B=0 C=[8928,17639,17639]   D=[226,449,449] 对应 5→9→9
   轮3 B=0 C=[4760,21895,21895]   D=[251,773,773] 对应 11→23→23
E（回读交付的 GIF）：帧数=格数+1 ✓ 最大偏差 9ms ✓ 时长不全等 ✓
   合成后逐格墨迹：轮1 [0,11648,20129] 轮2 [0,9151,17786,17637] 轮3 [0,4784,22139,22139]
   ⇒ 起点格合成后**真的是 0**（disposal=2 生效，§17.8 那条在这里被正向验证）
```

### 18.3 这一轮我踩的 5 个错，全部是"断言没问对问题"

1. **绝对颜色判据在深色主题恒读 0**：本沙箱背景众数 `(44,44,46)`，产品幽灵色走 CSS 变量，
   §17 那套"冷灰 b>r"直接失效 ⇒ 改**偏离本地背景众数**的对比度法，跨主题成立。
2. **先清空再量几何**：空 overlay 的 bbox 塌成 0 ⇒ clip 退化成空矩形，C/D 全 0（§17.3 第 3 条同族）。
3. **终帧落地后产品 `hide()` 走 `display:none`**（源码注释："用 display 而非 visibility"）
   ⇒ 只写 `textContent` 不可见。回填时**测试侧显形**，口径仍写"重放图"、不写"产品当时的画面"。
4. **measureRect 是页面 CSS 坐标，截图是裁切后的 4× 位图** ⇒ 不换算就是"在 288 高的图里找第 986 行"，
   C 恒 0；我连着两轮把它当成"产品没画字"，**其实图里产品渲染的字一直在**。
5. **回读脚本自己三个错**：循环帧被当"格"计入（E1 永远差 1）；ffmpeg 的 select 内容筛选把帧序弄乱
   （出现"三组起点墨迹完全相同"的假形状）；**E4 把我自己的标注文字也算成墨迹**（起点格 6297 全是标签像素）。

### 18.4 一条沙箱形状事实（不是产品缺陷）

插件做成**实体目录**后，`<home>/plugin/` 内没有 `node_modules` ⇒ 裸标识符
`@deepseek-ai/dsh-typert-protocol` 解析不到 ⇒ `stream channel` 不注册（`streaming=0 on=0 subs=0`）。
补 `<home>/plugin/node_modules → 被测树 node_modules` 后 `stream channel registered`、`subs=1`。
打包安装形态天然有这层提升 ⇒ **是沙箱形状问题，不是产品缺陷**；但值得记：
"通道没注册"和"产品不支持"在日志上长得一模一样。

### 18.5 未判定

- **测试侧 MutationObserver 没抓到中间帧文本**（overlay 首绘才创建，装观察者时它还不存在，
  `moLog` 恒为 1）⇒ 中间帧内容走的是 `final-prefix` 兜底，已在 `record.json` 逐格标 `textSource`。
  要拿到"逐帧真实文本"，需要在 overlay 创建**之前**就挂上观察（或产品侧留正文钩子，那违反零正文）。
- 0.1.7-rc.2 / 0.1.2-rc.1 未用这条重放路重做。

## 19. 逐样本观测（task-47）：**中间帧没有上屏** —— §18 那张图的中间格是"重建"，不是"当时屏幕"（2026-10-29，基线 `721fcf6`）

问题来自 review：§18 只挂了一个 MutationObserver，而且挂在 overlay 自己身上、等它出现才装
（`moLog` 恒为 1）。所以"中间那一格当时是不是这几个字"在 §18 里是**假设**，不是观测。

本轮把观测换成两条独立通道，并在**发问之前**就打开，结论是：**帧到了客户端、也留下了可读痕迹，
但中间态一次都没有被画到屏幕上**。§18 的中间格因此只能算"产品渲染能力 + 实测 chars 的重建"。

### 19.1 观测装置（两条通道，都先于发问）

| 通道 | 做法 | 它能回答 |
|---|---|---|
| tick | `setInterval` 8ms 读 `overlay.textContent` + `display`/`data-shown` + `performance.now()` | 那一刻**屏幕上这块 DOM 里是什么字**（不依赖任何事件到达） |
| mo | `MutationObserver` 挂 `documentElement`（childList/subtree/characterData），回调里只读一次当前状态 | 确有变化，并在两次 tick 之间补点 |

两条通道的样本都带 `src`，按 `text`+`display` 去重（所以"一直是同一个状态"只会留一条，
这解释了样本数为什么常常只有 2 条）。观测在回合结束、几何测量与回填**之前**停止，
所以回填写进去的文本不会被记成"观测"。

`absent`（overlay 不在文档里）与 `''`（在文档里但没字）**分开记**，这一点是下面结论成立的前提。

### 19.2 实测：F 全过，F2 一条都不成立

本次交付记录 4 回合（另有一次 3 回合的同会话复用对照、一次 4 回合的旧脚本运行，合计 11 回合）：

| 轮 | DOM 帧 chars | 首绘（相对首帧） | 首绘落后终帧 | 观测到的非空文本 |
|---|---|---|---|---|
| 1 | 7 → 16 → 16（终帧） | +394ms | 277ms | 16 = 终态全文 |
| 2 | 9 → 19（终帧） | +259ms | 184ms | 19 = 终态全文 |
| 3 | 9 → 13（终帧） | +285ms | 202ms | 13 = 终态全文 |
| 4 | 3 → 16（终帧） | +520ms | 187ms | 16 = 终态全文 |

- **F（`data-stream-frames` × console 留痕）11/11 全等**：逐格 `chars` 相等、`t` 差 ≤5ms（一次 1ms）。
  这一列一直成立，本轮没有变化。
- **F2（DOM 帧 × 观测样本）0/11**：中间帧的 `chars` 在样本里**找不到**对应状态。
  新会话的回合里，帧窗口内 overlay 处于 `absent`（元素还没进文档）；
  同会话复用的回合里，帧窗口内它显示的是**上一轮的旧建议**，新文本同样没有出现。
- **G（"中间帧 = 终态前缀"）**：观测到的非空文本**恒为终态全文**（长度与终态一致），
  中间长度出现过 0 次。⇒ §18 的 `final-prefix` 兜底没有被推翻成"错"，
  但它也确实不是观测：它只是"按实测 chars 取终态前缀"这个构造的定义。
- 首绘落后终帧 **177–375ms**（11 回合区间），而帧间隔只有 **31–333ms** ⇒ 首绘必然晚于最后一帧。

### 19.3 这意味着什么

1. **图的口径必须再收一格。** §18 的每格已标"`textSource=observed|final-prefix`"，但读者仍会以为
   "中间格 = 当时屏幕上就是这样"。本轮证据说：中间格**在屏幕上没有出现过**。所以
   `stream-replay-gif.py` 现在把中间格直接标成 `增长步 N · 重建（屏幕上未出现）`，
   图头口径写"中间格按实测 chars 重建；8ms 采样逐样本观测：中间帧未上屏，首绘落后终帧 177–375ms"。
   交付物仍是那张 `streaming-0.2.1-rc.2-replay.gif`（`record.json` 里记 `supersedes`）。
2. **对 #108 的意义（可见收益在这条路上是 0）。** 流式帧的价值一直是"字一个个出来"，
   而本轮 11 个真实回合里，用户看到的第一次画面已经是终态文本，且比终帧晚 176–375ms。
   这与 #108 记录的"提前量中位 91ms"不矛盾：那 91ms 是**帧到达 vs 整块到达**的差，
   本轮说的是**帧到达 vs 上屏**。两者相加的读法是：帧虽然早到，但上屏被推迟到终态之后。
3. **这不是"§18 的图错了"。** 两张图仍然是产品代码在渲染（回填的是产品 overlay 自身的
   `textContent`），断言 A–E 全过（见 19.4）。变的是它证明的**命题**：
   从"产品逐帧长这样"降为"产品渲染这串字符长这样"。

### 19.4 判据自身一处缺陷（D 一直在量输入框边框）

D 断言"文字像素水平跨度与 chars 同向"。本轮 4 个回合里 `raw span` 恒为 **2740**（= 裁切宽 −100），
对 5 字符与 18 字符完全一样，D 于是恒失败。原因：这一行里**本来就有宿主的输入框下边框**
（一条贯穿整宽的水平线），"这一行的墨迹跨度"量到的是它。

修法：先算**起点格（overlay 置空）**的逐列墨迹，再算每格的逐列墨迹，**只数这一格多出来的列**
（`fcols[i] > bcols[i] + 2`），跨度取这些列的外接框。修完 D 通过，数值回到与字符数同向：
轮1 `336 → 838`、轮2 `448 → 788`、轮3 `157 → 341`、轮4 `112 → 840`
（raw 仍是 2738–2740，两条都留在 `record.json` 里对照）。

同一类错的第三次形态（前两次在 §17.3、§18.3）：**判据要量被测对象，不能量"这一行里还有什么"**。

### 19.5 断言全表（本次交付）

| 断言 | 结果 | 载体 |
|---|---|---|
| A clip 与文字行相交 | 4/4 | `record.json` 的 `clip` 与 `measureRect` |
| B 置空格墨迹 | 27 像素（阈值 600） | 起点格 PNG，逐像素局部对比度 |
| C 逐帧墨迹单调不减 | 4/4，且首格 > 800 | 同上 |
| D 跨度与 chars 同向（逐列相减） | 4/4 | 同上 |
| E 回读交付的 GIF | PASS（13 格 + 1 循环帧、最大偏差 9ms、时长不全等、合成后起点格为空） | `stream-replay-verify-gif.py` |
| F DOM × 留痕 | 11/11 全等（chars 与 t） | `record.json` 的 `F.rows` |
| F2 DOM × 观测 | **0/11**（见 19.2） | `record.json` 的 `F2.rows` |
| G "中间帧=终态前缀" | 观测到的非空文本恒为终态全文，中间长度 0 次 | `record.json` 的 `G.rows` |

### 19.6 未判定

- **"中间帧为什么不上屏"的成因没有证死。** 三条候选都没排除：
  (a) 帧时刻客户端 `streamFrameFor(currentId)` 为 null（会话 id 归属/快照时序）；
  (b) 帧进了 `render()` 但被"内容未变"的 key 判定跳过；
  (c) 确有 `show()` 但被 60/300/900ms 的错峰补渲染覆盖（源码 `src/client/index.ts` 的
      `scheduleDeferredRenders`）。
  已排除的一条：**不只是 attach 竞态** —— 同会话复用两轮时 overlay 已在文档里，
  中间帧同样没有上屏。
  要证死需要在产品侧给 `ghostContent()`/`render()` 加一行"本次取到的是哪一帧、早退原因"的留痕，
  那是产品改动，须单独走 PR（本轮不动 `src/**`）。
- **8ms 采样的分辨率边界**：短于 ~8ms 的闪现会被合并掉。本轮的帧窗口是 31–154ms，
  不可能整个窗口都落在盲区里，但"绝对没有过一帧"这句只在 8ms 分辨率上成立。
- **0.1.7-rc.2 / 0.1.2-rc.1 未用这条重放路重做**（与 §18.5 同）。

### 19.7 复跑

```bash
export DSH_SUGGEST_GHOST_TRACE=debug
# 沙箱（0.2.1-rc.2）：见 docs/cross-kernel-shots/README.md 的四步；插件目录要补 node_modules 内链（§18.4）
node scripts/cross-kernel/stream-replay-record.mjs --home ~/xk-replay-0212 --ws ~/xk-replay-ws --rounds 4
# 同会话复用对照（隔离"每轮新建会话"的影响）：加 --reuse 1
python3 scripts/cross-kernel/stream-replay-measure.py scripts/cross-kernel/out/replay      # A–D
python3 scripts/cross-kernel/stream-replay-gif.py scripts/cross-kernel/out/replay \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif
python3 scripts/cross-kernel/stream-replay-verify-gif.py scripts/cross-kernel/out/replay \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif                                  # E
```

沙箱形状（本轮补记，不是产品缺陷）：新建的沙箱 home 里 `agent-default-model` 若指向
`commandcode`，该 provider 的 bundle 在 0.2.1-rc.2 树里解析不到（`prune-bundles` 会把它丢掉），
表现为**回合根本不产生建议**（`no adapter registered for provider "commandcode"`）或
**建议恒被过滤**。本轮把沙箱那份 profile 改成同机 `qoder-route/efficient` 后回归正常
（模型 id 必须在该 provider 的 `models` 里已声明，否则报 `Model is unavailable`）。

## 20. 内核 0.2.2 线（`0.2.2-alpha.2`）：`register()` 返回契约变更的实测与适配（2026-10-30，issue #121，构建 = 0.8.0 + 本次改动）

台账 §0/§1 那两张表都停在 0.2.1-rc.2。这一节把 **0.2.2-alpha.2** 拉进来，并且**逐条把 issue #121 的描述对着发布产物与真运行时核过**——核出的两条下修（§20.2、§20.4）比核出的那条真问题更重要，因为下游会照 issue 的措辞改代码。

### 20.1 契约事实（读发布产物，不读仓库里的旧副本）

对照物：`/tmp/proj-alpha/{0.2.0-rc.2,0.2.1-rc.5,0.2.2-alpha.2}/package/lib/types/index.d.ts`（npm 上逐个 tarball 解开，非本仓 `node_modules`）。

| 代次 | `register()` 返回 | 声明里的时序要求 |
|---|---|---|
| 0.2.0-rc.2 / 0.2.1-rc.5 | `() => void`（同步 disposer，`:150-159` 两个重载） | 无 |
| **0.2.2-alpha.2** | `Promise<ProjectionHandle<S>>`（`:186` / `:196`） | **「Callers must await registration before publishing consumers; registration may perform asynchronous work.」** |

实现层三条配套事实（`0.2.2-alpha.2/package/lib/index.js`）：

1. `:80-105` 返回的**不是裸 promise**，是 `Object.assign(dispose, {then, catch, finally, [Symbol.toStringTag]:'Promise'})` —— **一个可调用 thenable**：函数体是老 disposer，`then` 转发到 `ready`。
这句话把三种写法一次性判完了（断言见 §20.3）：
   **① 直接丢掉返回值**：两代都不炸（只是丢掉拒绝的可见性）；
   **② 把 `await` 的结果 `return` 给 cordis**：**只有老代次安全**（拿到的是函数 ⇒ 被收成 disposer），
      alpha.2 拿到的是 handle 对象 ⇒ cordis 抛 `Invalid effect`、本条 fiber 被拆掉 —— 这条最反直觉，
      因为"顺便把 disposer 交回框架管理"听起来是更正确的写法；
   **③ 按代次分叉写两条**：不需要，也只会多一条走错的岔路。
2. `:127-151` `acquire()` 里 `this.ctx.effect(...)` **同步**把单元写进 `registrations`（refcount `refs+=1`），**之后**才 `await Promise.resolve()`（`:152`）再 `assertActive()`。⇒ 单元进注册表这件事**不依赖 await**。
3. `:86-92` 给 `ready` 挂了一条 `setImmediate` 兜底：没人观察它时，注册失败只在**内核自己的 logger** 里冒一次。这是 issue 没写的一半：不 await 的代价不是"读到 undefined"，而是**拒绝不可辨**。

`SessionProjectionStateMap` 确实在 alpha.2 被删（状态类型改由 `ProjectionDefinition<K extends string, S>` 泛型携带），`SessionProjectionMap` 与 `./types` 出口仍在 ⇒ 本仓 `src/domain.ts:125` 那条 declare-merge **有效、无需改动**（issue 第 2 条，核对为真）。

### 20.1b 对着**已发布产物**直接量 `register()` 的形状（`npm run verify:register-shape`）

新脚本 `scripts/cross-kernel/projection-register-shape.mjs`：实例化被测树里那份真
`SessionProjectionRegistry`，量四件事——返回值是不是「可调用 thenable」、`await` **之前**
`registrations.has(key)` 是不是已经为真、`await` 给回的是不是 handle、注册生命周期是不是
由内核自己挂 `ctx.effect`。四代实测（退出码 0=符合 alpha 预期 / 2=未判定 / 1=不符）：

| 被测产物 | `typeof` / `thenable` | await **前** `has(key)` | await 给回 handle | 内核自持生命周期 | 退出 |
|---|---|---|---|---|---|
| 0.2.2-alpha.2 | `function` / **true** | **true** | true（`stateOf`/`readerFor`/`dispose`） | true（effect 返回 disposer 函数） | 0 |
| 0.2.1-rc.2 | `function` / false | **true** | false（拿回的就是那个函数） | true | 2（非 0.2.2 线，不拿 alpha 预期量它） |
| 0.2.0-rc.2 | `function` / false | **true** | false | true | 2 |
| 0.1.7-rc.2 | `function` / false | **true** | false | true | 2 |

⇒ 两条被这张表钉死的事实：**① 单元进 `registrations` 在四代上都是同步的**（所以"不 await ⇒ 消费方读到 undefined"
在**任何一代**都不是既有行为，issue 那句只能算设计意图的推测）；**② `await` 一个纯函数（老 disposer）
原样拿回它、不产生调用**，所以同一条 `await` 跨代安全 —— 这就是不分代写分支的依据（§20.3 断言 4）。

⚠️ **这张表差点是错的，错的正是探针自己的 stub**：第一版 stub 只 `fn()` 一次就记账，而
0.1.7/0.2.0/0.2.1 那三代的 `register()` 走的是 `ctx.effect(function* () { this.registrations.set(…) })`
——**生成器函数调用只得到迭代器、函数体一行没跑**，于是三代全被我量成"await 前 `has(key)=false"，
看上去恰好支持 issue 那句"会短暂读到 undefined"。照 cordis `_execute()` 的四条分支
（函数 / nullish / thenable / `Symbol.iterator`，`lib/index.js:1134-1144`）补上"同步 drain 到底"之后，
三代都改成 **true**。**记下来：探针的 stub 与被测包之间，任何一条分支没对齐，量到的就是 stub 自己。**

### 20.2 真问题与时序缺口有多大（下修 issue 第 1 条）

issue 说「若在注册 promise 落定前被 client 侧读到，会短暂读到 undefined」。按 §20.1b 那张**对着发布产物量出来的表**，`registrations` 在四代上都是同步写入的，缺口只有**一个 microtask**（`await Promise.resolve()`），且 cordis 的 `_reload()` 本来就先 `await Promise.resolve()` 再跑插件体（`@deepseek-ai/cordis/lib/index.js:1348-1355`）——插件 fiber 与注册 fiber 之间**至少已经隔着一次微任务交接**。

⇒ 结论口径要改：**await 该加**（它是新契约的明文要求，且把拒绝从"内核兜底日志"搬回"我们的 fiber"），但**不要把它写成一个"用户会看见空白"的现网缺陷**——那个后果在这一版实现里被同步写入抵消掉了。夸大它会让下一次有人为了"修这个"去加轮询重试，那条路本仓已经验过是错的（§13.4 一类）。

### 20.3 适配（`src/index.ts` 投影注册处）与它的运行时反证

改法就一条：`ctx.inject(['sessionProjections'], async (c) => { await registry.register({...}) })`，结构强转返回类型改成 `(() => void) | Promise<unknown>`。**不按代次分叉**：`await` 一个函数会原样拿到它、不产生调用。

新增 `scripts/projection-register-contract-smoke.mjs`（`test:smoke` 链 50 → 51），跑的是**本仓 node_modules 里那份 cordis 的真 fiber 生命周期**，5 组断言 6 项全过：

| 断言 | 结果 | 复核物 |
|---|---|---|
| 1 await 注册 ⇒ fiber 在 promise 落定后才就绪 | ✓ | `registered > after-await`，+61ms（promise 延后 60ms） |
| 2 不 await ⇒ 回调体与 fiber 就绪都早于落定 | ✓ | `body-end@+0ms > fiber-await-settled@+0ms` |
| 3 **return** 那个 handle ⇒ `Invalid effect` + fiber 掉线 | ✓ | `await 抛 "Invalid effect"`、`logger.error ["Invalid effect"]`、`fiber.state=3` |
| 4 await 老 disposer = 拿到函数、**不**误调用 | ✓ | `typeof(awaited)=function`，disposer 调用次数 = 0 |
| 5a 不 await 时拒绝只以未处理拒绝出现 | ✓ | `未处理拒绝 ["registration-rejected(simulated)"]`、`logger.error []`、`fiber.state=2` |
| 5b await 时同一条拒绝上浮到 fiber | ✓ | `await 抛 "registration-rejected(simulated)"`、`fiber.state=3` |

**3 与 4 就是"顺手改"的两个雷**：把 `await` 的结果 return 出去（很自然的"顺便把 disposer 交回 cordis 管理"）会让插件在该 fiber 上**直接掉线**；而"分代写两个分支"没有收益。断言 3/4 是**可证伪**的：改动这两处任一条，本 smoke 会红。

### 20.4 门禁面：`engines.dsh` 与 peer 的分工在 0.2.2 上如何显形（下修 issue 第 4 条）

issue 第 4 条说「当前 peer 枚举按 semver 预发布规则**不会**匹配 `0.2.2-alpha.x`，要临时补 `|| ^0.2.2-alpha.2`」。**这句话只在安装面成立，在准入面不成立**，两者必须分开写：

| 口径 | 谁在用 | `^0.2.0-rc.2` 对 0.2.2-alpha.2 | 实测 |
|---|---|---|---|
| `includePrerelease: true` | **内核准入闸**（`dsh-app-boot/lib/index.js:276-278` 的 `satisfies()`） | **true** | 用 0.2.1-rc.4 树里那份真的 `evaluatePluginCompatibility` 跑本仓 manifest：0.2.1-rc.5 / 0.2.2-alpha.1 / 0.2.2-alpha.2 **全判 MET** |
| `includePrerelease: false`（npm/pnpm 解 peer） | 装依赖 | false | 同一份 ranges 实测 false |
| 正式版 0.2.2 | 两者 | **true** | `semver.satisfies('0.2.2','^0.2.0-rc.2')` = true（两种口径都是 true） |

⚠️ **而且这条安装面缺口不是 alpha 专属**：同一个 `semver.satisfies` 实测
`^0.2.0-rc.2` 对 **0.2.1-rc.5**（正式版线上当前的最新 rc）在 `includePrerelease: false` 下**同样是 false**
（`true` 只在 `includePrerelease: true` 那一侧）。⇒ 拿 npm 解 peer 的方式装进任何一根新 rc 线都会报 unmet peer，
这是**逐代枚举 vs 区间匹配**这个既有选择的后果，不是 0.2.2 的新问题；所以"要不要为 alpha 补一条枚举项"
这个问题本身问错了对象 —— 真要修就一次性决定"每个新 rc 都补一项"（上游 dsh-later 的口径），
零散补一根 alpha 只会让两份声明更难对齐。**本轮决定：peerDependencies / engines.dsh 都不改。**

⇒ **决定：peerDependencies / engines.dsh 都不改。** 为一个 alpha 放宽声明，等于把"未验证的代次"写进支持列表（技能 §5：现状声明要写硬事实）。0.2.2 正式版出来时**两种口径都自动覆盖**，届时只需代次表新增一条并重跑。

对照证据（真宿主，不是推断）：在 0.2.2-alpha.2 冷启动实例里——
- 本插件**被装载并 apply**：`[dsh-suggest-ghost][ops-trace] apply called; artifact mtime=2026-10-30T09:05:20.793Z`；
- **同一次启动**里 `dsh-later@1.10.0` 因 `engines.dsh`（上界 `<0.2.2-0`）被 `skipping profile bundle`，两条 `@deepseek-ai/dsh-webhook*@0.2.1-rc.5` 因 peer 精确钉版本被 `disabling profile plugin row`；
- ⇒ 那道闸**是活的**，本插件被放行靠的是 `engines.dsh` 上界 `<0.3.0-0`。

顺带修掉回归脚本一条**会误标语义**的判据：`verify-across-kernels.mjs` 原来用 `runtime.startsWith('0.2.1')` 标准入契约 ⇒ 0.2.2-alpha.2 会被标成 `peer-only`，而它实际读 `engines.dsh`。改成与 `gate-matrix.mjs` **同一个源码信号**（`function unmetRequirements(` 是否存在），读不到标 `unknown` 并落进 note。旧 bug 的产物证据：本轮第一次跑（改动前）0.1.5-rc.3 那行就显示 `契约=none`——那是**新**代码给出的正确答案，改动前它会被叫成 `peer-only`。

**这条修改本身被逐代核过**（拿 `out/gate.json` 那份**独立实现**的分类做对照，两个口径都来自同一份
app-boot 源码、但走的是两条不同代码路径）：

```
0.1.2-rc.1   verify=none         gate-matrix=absent             ✓
0.1.5-rc.3   verify=none         gate-matrix=absent             ✓
0.1.7-rc.1   verify=peer-only    gate-matrix=peers-only         ✓
0.1.7-rc.2   verify=peer-only    gate-matrix=peers-only         ✓
0.2.0-rc.2   verify=peer-only    gate-matrix=peers-only         ✓
0.2.1-rc.2   verify=engines.dsh  gate-matrix=engines.dsh-alone  ✓
0.2.2-alpha.2 verify=engines.dsh gate-matrix=engines.dsh-alone  ✓   ← 旧代码在这里会报 peer-only
```

⇒ 七代**逐代一致**，新标注没有把任何一代带偏。

### 20.5 跨代次回归（含新代次）

`node scripts/verify-across-kernels.mjs --no-install --kernel-root ~/dsh-versions`（2026-10-30，构建含 §20.3 的 await）：

```
0.1.2-rc.1   GREEN   0.1.5-rc.3   GREEN   0.1.7-rc.1   GREEN
0.1.7-rc.2   GREEN   0.2.0-rc.2   GREEN   0.2.1-rc.2   GREEN
0.2.2-alpha.2 GREEN  （内核=0.2.2-alpha.2 · 启动器=0.2.2-alpha.2 · 契约=engines.dsh
                      · apply落痕=Y · 投影=Y（modern:stateSchema+wire.view） · 树戳=331 项）
汇总：绿 7 / 红 0 / 未判定 0；门禁分面 红 0 / 未判定 2（EXIT=2）
```

- 树身份：`~/dsh-versions/0.2.2-alpha.2` 为 npm 扁平布局、**自洽**——`@deepseek-ai` 331 项，dsh / dsh-app-boot / dsh-base / dsh-session / dsh-session-projection 等 11 个被测包**全部 0.2.2-alpha.2**（逐包读 `package.json` 核过，非软链混版）。
- **EXIT=2 不是本次引入的**：门禁分面对 0.1.2-rc.1 / 0.1.5-rc.3 报「app-boot 存在但不导出 `evaluatePluginCompatibility`」⇒ 按技能 §2 走未判定。**未判定 ≠ 绿**：这两代没有闸可判，别把"装配 GREEN"读成"准入已验证"。
- 明细：`scripts/cross-kernel/out/across-kernels-2026-10-30T09-55-14-761Z.json`（**这份取代** `…T09-03-01-445Z.json`：
  两者跑的都是 7 代全 GREEN，但 09:03 那一次跑完之后我又改了 `src/index.ts` 的注释并重建了 `lib/`
  ⇒ 按"证据要对应交付字节"的规矩，以 **09:55 这次为准**；旧文件保留，别当两条独立结论）；
  门禁分面 `out/gate.json`（含 `[GREEN] 0.2.2-alpha.2: real manifest passes under this generation's own evaluator`）；
  类型面 `out/type.json`；`out/` 三份都是本轮产物。

### 20.5b 类型面（FACE A/B）：`0.2.2-alpha.2` 与其余六代同绿

`node scripts/cross-kernel/type-surface.mjs`（代次同样取自 `generations.mjs`，复核物 `out/type.json`）：

口径先抄明白（`type-surface.mjs:666-700`）：表头是 `host / +new / client / +new / unsolved-in-tree / seed`，
而 **判红的唯一条件是"出现了 baseline 里没有的错误种类"**（`novelVsBaseline`），不是"错误数为 0"。

```
0.2.0-rc.2     host 0 (+0) · client 6 (+0) · seed yes   GREEN
0.2.1-rc.2     host 0 (+0) · client 6 (+0) · seed yes   GREEN
0.2.2-alpha.2  host 0 (+0) · client 6 (+0) · seed yes   GREEN   ← exit=0 red=[] undetermined=[]
baseline（仓里那份 0.2.0-rc.2 devDeps）        host 0 · client 7
```

⇒ 0.2.2-alpha.2 的 host 面**一个新错都没有**；client 面那 6 条（`TS5097 / TS2532×2 / TS2341 / TS18047 / TS6142`）
**逐条是 baseline 就有的种类**，`novelVsBaseline=[]`。别把它们读成"0.2.2 带来的"，也别顺手写成"client 0 错"
——那是把 `+new` 那一列看成了 `client` 那一列。

⚠️ **`out/type.json` 里的 `faceA.overlayDir`（`.work/type/<代次>`）是临时脚手架，不是证据本体**：
本轮清理时把 `.work/` 整个删掉了（334 MB，逐代 overlay 副本，`.gitignore` 里本就排除）。
可复核物是 `out/type.json` 内的 `mountedPeers` / `overlayVersions` / `missingPeers` 与错误原文列表 ——
**它们记录了"判的是哪一份字节"**；要重看目录就重跑 `type-surface.mjs`（它每次 `rmSync` 后重建，幂等）。
⇒ 记一条纪律：**别把可再生的临时目录当证据留着**，但也别说"证据还在目录里"。

另用**整目录**换代的口径独立复现过一次（不看 overlay、直接把 `node_modules/@deepseek-ai`
整条软链到 `~/dsh-versions/0.2.2-alpha.2/node_modules/@deepseek-ai`，那份树里
cordis=4.0.6-alpha.1 / cosmokit=1.8.7-alpha.1 / schemastery=3.18.6-alpha.1 /
dsh-session-projection=0.2.2-alpha.2）：`tsc -p tsconfig.json --noEmit` **0 错**，
`node build.mjs` 与 `client-import-surface-smoke` / `client-surface-drift-smoke` 全过。
⇒ issue 第 1/2 条的"编译不 break"被正面确认；`SessionProjectionStateMap` 的删除**没有**打到这里。

⇒ **"类型面判绿"这句话必须带的两个限定**（都不是 0.2.2 的债，但都会被误读成它的债）：

1. **换个安装形状就换个结论（zod 双实例）。** 同一个 alpha.2，两种装法两种结果：
   - 上面两种口径（overlay 的 `cp -rL`、以及我那次"`@deepseek-ai` 整目录软链到被测树"）都把
     **本仓自己那份 zod 4.4.3**（实测 `node_modules/zod/package.json`）留在**唯一一份**的位置上 ⇒ host 面 0 新错；
   - 另开副本走 `npm i` **全新解析** devDeps（本仓 `zod: ^4.0.0` 解析到顶层 **4.6.7**，而该代宿主包精确要 **4.4.3**）
     ⇒ 装出**两棵 zod / 两套互不兼容的 `ZodType`** ⇒ host 面冒出 8 条错，**全部落在 `src/hotness-store.ts`**
     （`TS2589`×2 `:113/:114`、`TS18048`×5、`TS2322`×1 `:407`），默认堆还会先 `EXIT=134` OOM；
     npm 与 pnpm **双复现**，把 devDeps 的 `zod` 钉成 `4.4.3` 后回到 0 错。
   ⇒ 记成**安装形状**的债。本仓 pnpm 布局今天解析到的就是 4.4.3 ⇒ **没有当场要改的东西**；
   真要跑 alpha 线的 CI 安装，那一行 `zod: "4.4.3"` 就是修法（且它改的是 dev 面，不动产物）。
2. **绿 ≠ 为契约背书。** 注册处走 `as unknown as { register: … }` 自建形状 ⇒ **tsc 从未检查宿主真实的
   `register()` 签名**。把真签名硬接进去探一次会得到 `TS2769`（`hot` 的 readonly vs mutable），
   而**同一条错在 0.2.0-rc.2 上一模一样**（既有摩擦，非 0.2.2 回归）。
   ⇒ `Promise<ProjectionHandle>` 这条新契约的守护者**不是类型面**，是 §20.3 那 5 组 cordis **运行时**断言。
   读 issue #121 的验收时别把"编译干净"当成"契约已验"。

⚠️ 两条读数纪律：
- `type-surface.mjs` 头部就写着 `tsconfig.json` **exclude 了 `src/client`**，所以"根 tsconfig 绿"只证明 host 面；
  这个 runner 两份配置都跑才叫类型面。手工只跑 `tsconfig.client.json` 会在**每一代**上报
  `TS5097 / --jsx is not set`（本仓那份 baseline 也报，属**调用方式错**，不是漂移）——我第一次就误读过一次。
- `FACE B` 的 `unsolved-in-tree = @deepseek-ai/dsh-client-ui-primitives / react / react/jsx-runtime`
  **七代全有**（0.2.1-rc.2 同样命中）⇒ 既有形状，不是 0.2.2 引入的。而且 runner 头部写着
  **不能拿 node_modules 解析当判据**：宿主 `__ModuleLoader__` 的 seed 表**排在 tree 之前**
  （`hostSeed.keys` 11 项含这三个），所以"树里解析不到"不等于"运行时拿不到"。

### 20.6 未判定（本轮**没有**覆盖的，别当成绿）

- **UI 面（"用户在 composer 里到底看见没看见浅灰幽灵"）在 0.2.2-alpha.2 上 = 未判定，卡在模型侧（环境），
  不是选择器、不是装配、也不是插件缺陷 ⇒ 不能据此推断"插件不支持 0.2.2"。**
  按 §13.2 完整配方重做（`--live-nm` 指被测树 + `prune-bundles.mjs` + `<home>/node_modules` + `--deploy` 冷启动），
  三次启动的判据行计数（`/tmp/xk-0222-gui-round.log`，174 行 = 三轮全量，沙箱已删 ⇒ 这是唯一副本）：

  ```
  apply called 3 · hotness restored 3（n=0/0/3）· hot push landed 17 · 建议格 push landed 1
  suggestion generated 0 · dropped 0 · failed 0
  completion failed 7（6× Insufficient Balance + 1× no adapter "commandcode"）
  Invalid effect 0 · 门禁拒绝行 13（dsh-later / dsh-webhook* 被拒 = 闸是活的对照证据）
  运行的产物：plugin/lib/index.js mtime 2026-10-30 17:15:39 ⇒ 就是本轮 0.8.0 重建那份字节
  ```

  - **建议格一行日志都没有，成因不是它也报了 402**：建议只在 `turn/end` 且 `reason.kind === 'completed'`
    时生成（`src/index.ts:2979`）⇒ **前置条件没到**。
    ⚠️ 证据分级要说清：`turn/end … reason.kind='error'`（`code=QUOTA, status=402`）这一行是
    **执行那轮的 teammate 观测**（沙箱随后被 `--cleanup` 带走），**不在保留下来的日志切片里**
    （`grep -c "turn/end" /tmp/xk-0222-gui-round.log` = 0，那是会话日志里的事件、不是 ops-trace 行）。
    保留切片里能独立复核的是同因的下游两行：`completion failed` **7**（`Insufficient Balance` 6 + `no adapter` 1）
    与 `建议格 push landed` 只有 **1** 次、且那一次是 `rev=1 carriedCompletion=0 hasHistory=-`
    （初始空推，**不是**真建议）。⇒ 复跑时**先盯 `turn/end … kind=completed`，再盯 `suggestion generated`。
  - **白捡到的正面证据（三条，都不等于判据①）**：装配 ×3、`Invalid effect` **0**
    （⇒ §20.3 那条 `await` 在**真 alpha.2 宿主**上不会踩 cordis 的 `Invalid effect`，这是比断言 3 更强的一层确认）、
    `hotness restored n=3` 跨三次重启（§13 那条"热表不回零"判据在 alpha.2 上也成立）。
  - **未达成**：判据①（幽灵文字）与②（真建议 `_push` 的 `rev/final/frame/chars`）；
    `volatile-evidence.mjs` 只量到 `rev=1 final=null frame=null textChars=0 hasSessionId=false`。
  - **物证三张（都按技能 §5b 标了来源与判定）**：
    `0.2.2-alpha.2-UNDET-env-no-composer-FULLPAGE.png`（lead 首轮整页兜底）、
    `-UNDET-empty-composer.png`（composer 裁切 822×232，模型位"请选择模型"）、
    `-UNDET-no-model-quota.png`（composer 裁切，模型位**已选上** `DeepSeek-V4.1-Flash High`、输入框空、无幽灵）。
  - **本轮新发现的一条配方缺口（会必然复现，已写进 `docs/cross-kernel-shots/README.md` 复跑第 3 步）**：
    `prune-bundles` 会丢掉不在被测树里的**第三方 provider**（`@mars-sea/dsh-commandcode-provider`），
    而**保留下来的** `agent-default-model` / `suggest-ghost` 两条仍钉着 `provider: commandcode`
    ⇒ 必然 `no adapter registered for provider "commandcode"` ⇒ 回合直接 error ⇒ 幽灵必然不出。
    本轮是把沙箱 profile 那两条改成被测树自带的 provider/model 才让模型位选上的。
    **§13.2 没有这一步**，老那几轮也没撞上（当时 provider 可用）——所以"GUI 判据到不了"这一类以后要先查这条。
  - **两处口径纠正**（都是我自己先前写错的，按"当场撤回"的规矩留痕）：
    ① lead 首轮 `picker: 没有可用入口` **不是**阻塞点——同一轮 `pickerClosed` 是 `composerReady=true phase=plain`，
       工作区早就设上了，那行是"已设过 ⇒ 不再显示入口按钮"的正常态；把它读成"沙箱构造失败"是误判。
    ② `~/xk-probe-ws` 是**空目录、没有 `.git`**（`git -C` 报 not a git repository），
       先前"`.git` 在、工作区有效"那句不成立（本轮不受影响：会话 cwd 正确落到了它）。
- **流式通道（#109）在 0.2.2-alpha.2 上：注册面**已验通**，逐帧提前量仍未判定。**
  ⚠️ **先撤回我自己的一条错判**（本节上一版把它写成"沙箱依赖形状不满足该包解析要求 ⇒ 未验证"）：
  我拿 `src/stream-service.ts:6` 那句**注释断言**（"软链指向树外 ⇒ ERR_MODULE_NOT_FOUND"）加一次
  `createRequire(...).resolve()` 成功，就推成"运行时也解析不到"。运行时日志反对这个结论：
  `/tmp/xk-0222-gui-round.log` 三次启动里 `typert protocol import failed` **只出现在 `:16` 那一次**
  （建沙箱后、还没补 `<home>/node_modules` → 被测树那条软链之前）；补上之后 `:72` 与 `:118`
  两次都打出 **`stream channel registered service=ghostStream`** ——而这一行按
  `src/index.ts:486-493` 只在 `registerGhostStreamService()` **返回 true** 时才打，
  该函数只有 `await import('@deepseek-ai/dsh-typert-protocol')` 成功才走到 `return true`
  （`src/stream-service.ts:56-67`：失败即 throw，落 `stream-register-failed`）。
  ⇒ **一条指向树外的软链就够**，`src/stream-service.ts:6` 那句对本形状**过强**（它的历史条件很可能是
  "逐包软链"而不是"整目录软链"，与 `prune-bundles.mjs` 头注释同源；本轮没有复现逐包形状，**不替它下结论**）。
  方法教训一句：**注释与 resolve() 都不是运行时证据，判"能不能 import"只认宿主日志里那条成功/失败行。**
  仍未判定的部分是**`streamingDelivery: true` 下的逐帧提前量**——额度 402 让建议没内容可推，
  别把"注册成功"读成"#109 在 0.2.2 上验过了"。
- **`wire.summary: false`（issue 第 3 条）未采纳**：客户端历史前缀补全要从摘要里读 `hot`，排除出去等于砍掉热路径数据源；要改先量会话列表 payload 体积。

## 21. 六面矩阵复跑（2026-11-05，构建 `8b79c83` = 0.8.1+regen+route）

本轮把 skill §0 的六面**逐面重跑**，因为此前类型面停在 11/02 的旧产物、client 面从未跑过、
UI/功能面只覆盖 0.2.1-rc.2 一代。**结果：五面绿，功能面与 UI 面在三代次上都通过。**

| 面 | 命令 | 覆盖 | 结果 |
|---|---|---|---|
| ① 装配 mount | `npm run verify:kernels` | 7 代 | 全 GREEN |
| ② 门禁 gate | 同上（各代自己的 `evaluatePluginCompatibility`） | 7 代 | 5 GREEN / 2 UNDETERMINED（0.1.2-rc.1、0.1.5-rc.3 无 evaluator ⇒ 按 §0 约定不算红） |
| ③ 类型 type | `node scripts/cross-kernel/type-surface.mjs` | 7 代 | **全 GREEN**（`red=[] undetermined=[]`），`out/type.json` 已被本轮覆盖 |
| ④ client 导入可用性 | 同上（FACE B） | 7 代 | **全 GREEN**；每代都标 `unresolved-in-tree: react, react/jsx-runtime`，但 `hostSeed=true`（宿主提供）+ 形状 `published=true` ⇒ 不是缺陷 |
| ⑤ 功能 function（regen） | `node scripts/cross-kernel/regen-round.mjs` | 3 代 | 全 PASS，见下 |
| ⑥ UI（幽灵可见） | `node scripts/cross-kernel/gui-round.mjs` | 3 代 | 全 PASS，见下 |

### 21.1 UI 面读数（真 GUI，用户可见文本）

| 代次 | 幽灵 chars | 文本 |
|---|---|---|
| 0.1.7-rc.2 | 28 | 「在什么场景下应该选 worktree 而不是 clone」 |
| 0.2.0-rc.2 | 23 | 「顺便说说 git worktree 的使用场景」 |
| 0.2.1-rc.2 | 23 | 「用 worktree 给当前仓库开个新分支目录」 |

### 21.2 功能面读数（换一条，`regen-round.mjs`）

| 代次 | 第一条 → Alt+G 之后 | 留痕 | verdict |
|---|---|---|---|
| 0.1.7-rc.2 | 「为什么 git worktree 不能切换…」→ 文本未变 | `started=1 dropped=1` | PASS（`dropped` ⇒ 文本必不变） |
| 0.2.0-rc.2 | 「如何创建并列出所有 worktree」→「普通 clone 会重新拉取完整历史吗」 | `started=1 landed=1` | PASS |
| 0.2.1-rc.2 | 上午那轮 + 配额轮 | `used=2/2 wait=never` | PASS |

### 21.3 判据自身被修过一次（记下来，否则下一个人会重复我的错）

`regen-round.mjs` 初版判据是「幽灵文本必须变化才算 PASS」。第一次跑 `--rounds 2` 判 **FAIL**，
而真实原因是 `regen dropped outcome=filtered ghostUnchanged=1` —— 模型产出被
`maxSuggestionChars` 过滤，宿主**正确地**让幽灵保持原样。**判据把正确行为判成了缺陷。**

改成「`landed` ⇒ 文本必变；`dropped`/`failed` ⇒ 文本必不变；且 `ops consumed: regen` 恰 1 次」后，
做了 8 个样本的**判据自证**（其中 5 个是应当判红的坏情况：landed 却没变 / dropped 却变了 /
ops 消费 0 次 / 消费 2 次 / 发起却无处置），全部符合预期。
方法教训与 §5 那句同源：**一条从没红过的判据不是判据。**

### 21.4 工具面缺陷（非产品面，但会让读数变成假红）

`regen-round.mjs` 首版没有处理「选工作区」，于是在 0.1.7-rc.2 上第一条建议永远不出现 ⇒ 判 FAIL。
真实原因是**驱动没把 composer 弄可用**，不是插件坏。补齐 `ensureComposer()` 后转 PASS。

同时记三条驱动坑（都在这次踩过，写进两个脚本的头注）：
1. **固定 sleep 不够**：GUI 是懒挂载，2.5s 时 `[role=dialog]` 一个都没有，后面全对着一片白板做；
2. **`[role=textbox]` 会选中工作区选择器**：它的 aria-label 是「选择工作区」，同样可见 ⇒
   往它里面打字，`draft` 长度恒 0，整轮静默失败；
3. **模板字符串里不能写反引号**：`const GY = String.raw\`...\`` 的正文里出现反引号会把模板提前闭合，
   报的错是 `Unexpected identifier`，位置在几十行之外。本次连踩三次，最后固化成
   `check-driver.sh`（先数模板内反引号，再查两处语法）。

### 21.5 `supersedes` / 未判定

- `out/type.json`：本轮覆盖旧文件（旧数据为 2026-11-02），**旧结论不保留**——类型面按代次重新算过，无冲突。
- `out/across-kernels-2026-11-05T07-56-56-764Z.json` 取代 10-30 的两份同类产物。
- **UI 面 0.2.2-alpha.2 仍未判定**（预发布线，§20 原记录即如此），本轮没有扩到它。
- **功能面/UI 面只覆盖 3 代**（0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2）。0.1.2-rc.1、0.1.5-rc.3、
  0.1.7-rc.1 未跑 UI：它们不是当前支持矩阵的主线代次，如需覆盖要另起沙箱，**不当作已验**。
