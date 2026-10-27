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

**三代全绿。** 每代次都是**该代次自己的 `dsh` bin** 起的实例（`/proc/<pid>/cmdline` 逐次
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
