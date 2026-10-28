# 跨内核代次验证 · 已验证事实台账

本文件只登记**已被复现**的事实，每条都带可复核的现场。未判定的单列在末尾，
不许写成结论。跑法见同目录 `generations.mjs` 与各 runner；本文件是结论的索引。

插件：`dsh-suggest-ghost@0.7.0`。

> ## ⚠️ 现状（2026-10-26）：0.1.1-rc.2 **已从支持列表删除**
>
> 本文后面大量段落提到 0.1.1-rc.2，那些是**历史记录**（记录它曾经怎么坏、怎么修），
> 不是"当前仍支持"。当前支持 **6 个代次**：0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.7-rc.1 /
> 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2。
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

复核物：`out/gate.json`；门禁实现 `~/dsh-versions/<v>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
（0.1.7-rc.1/rc.2/0.2.0-rc.2 在 `:286`，0.2.1-rc.2 在 `:311`）。

**这一条是本次验证最重要的结论。** 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 三个代次
**导出**了 `evaluatePluginCompatibility`，但它在那三代里**完全不读 `engines.dsh`** ——
把 `engines.dsh` 改成 `>=9.0.0` 这种无意义的值，在这三代上依然返回「兼容」。
只有 0.2.1-rc.2 真正执行 `engines.dsh`。

后果：本插件那条 `>=0.1.1-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0` 声明，
在 7 个代次里只有 **1 个**（0.2.1-rc.2）会被内核真正执行；在 0.1.1/0.1.2/0.1.5 上
连 evaluator 都没有。也就是说**这条声明在 6/7 的代次上是不可执行的文本**，
准入实际由 peer 枚举承担（见 §2：两套口径结论一致，覆盖上没有洞）。

## 2. 声明与语义的一致性：无矛盾

用被测那一代自己的 evaluator，对真 manifest 逐代跑：

- 七个代次**全部**通过（evaluator 返回 `undefined` = 无未满足项）。
- `^0.1.1-rc.2` 展开为 `>=0.1.1-rc.2 <0.2.0-0`，**匹配** `0.1.7-rc.1`
  （`includePrerelease: true`，内核即用此口径）。
- `^0.2.0-rc.2` 匹配 `0.2.1-rc.2`。

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
