# 设计：按键触发的操作全部收进「键位」设置区

> 状态：**已实现**（分支 `feat/keybinding-settings`）。§7 三件事已由用户按本方案的默认拍板。
> 实现过程中本文件有 **四处被实测推翻或补强**，都就地改在原文里并标了 `【实测更正】`，
> 没有偷偷改口径。新增工单：Gitea #185（逐词采纳在 #166 同源闸下恒被放弃，**非本单引入**）。
> 读者：下一个动这块代码的人。结论先行，判据与出处都在下面。

## 0. 结论

插件今天有 **5 个「主动按键完成一个动作」的触点**，其中只有 **2 个**能在设置页改（采纳 LLM 建议、换一条）；
另有 6 条**周边判据**（让路 / IME / 不吞键那一类，§1.2）与 2 个**卡片内按键**（§1.3）。本方案：

1. 新增一个 **`keybinds` 设置分区**，把 **5 个动作**全部做成可自定义快捷键，共用一个录制控件：
   `acceptKey`（已有）、`regenKey`（已有）、**`wordAcceptKey`**（逐词采纳，新）、
   **`localAcceptKey`**（历史补全 + 停顿续写的采纳，新）、**`dismissKey`**（关闭幽灵，新）。
2. 配一条**安全键判据**（`keyspec.ts` 的 `isSafeActionKey`）：只有「不打字的键」才允许配给
   `history` / `inline` 两个**边打字边显示**的形态。这是 Gitea #167 当年把作用域收窄的**前置条件**，
   补上它才能扩范围。
3. 加**冲突检测**：5 个键之间撞键在卡片里警告（`bindingConflict`，纯函数），并把运行时判据从
   「一串 `if` 谁写在前面」改成**一张按键归属表**（§3.3）——顺带修掉 §1.4-3 那条
   **今天就能被用户触发的失效**（把「换一条」设成 `Tab` ⇒ 历史/续写形态的采纳整条失灵）。
4. **提示行与设置页同一个数据源**：`keyHintText` 的输入从「三个散字段」改成「一份生效键位表」，
   「屏幕上写的键 == 真按得动的键」这条 #167 不变量继续由冒烟钉住。
5. **不迁移**到内核官方快捷键服务。理由见 §2——那条路对本插件的键是**结构性封死**的，
   判据是实测的（§2 那张表）：零修饰的 `Tab` / `→` / `Esc` 三平台一律 `modifier-required`，
   连现役默认值 `Alt+G` 都被三平台全拒 ⇒ 迁过去等于**顺手改掉用户已经用惯的键**。
   但 §4 里有一条**顺手能做**的官方面子（`registerFixed` 只读展示），单列，不混进本次。

## 1. 现状:5 个主动按键触点,2 个可改

### 1.1 幽灵操作（输入框里真按的键）

| 动作 | 生效形态 | 当前键 | 设置页 | 出处 |
|---|---|---|---|---|
| 整条采纳 | `llm` | `acceptKey`（默认 `Tab`） | ✅ 录制控件 | [index.ts:270](../src/index.ts#L270) / [settings-card.tsx:222](../src/client/settings-card.tsx#L222) |
| 整条采纳 | `history` / `inline` | **硬编码 `Tab`** | ❌ | [accept-key.ts:43](../src/client/accept-key.ts#L43)、`:75` |
| 逐词采纳 | `history` / `inline` | **硬编码裸 `ArrowRight`**（spec 名是 `Right`） | ❌ 只有开关 | [index.ts:3462](../src/client/index.ts#L3462) |
| 换一条 | `llm` | `regenKey`（默认 `Alt+G`） | ✅ 录制控件 | [index.ts:288](../src/index.ts#L288) / [settings-card.tsx:200](../src/client/settings-card.tsx#L200) |
| 关闭幽灵 | 全部 | 提示行写 `Esc` | ❌ **且插件无处理器** | [key-hint-text.ts:58](../src/client/key-hint-text.ts#L58)、`:66` |

### 1.2 键位周边的既有语义（改键不许动它们）

| 触点 / 判据 | 现状 | 出处 |
|---|---|---|
| 让路 | 别人已 `preventDefault` 的键一律不碰 | [yield-key.ts:32](../src/client/yield-key.ts#L32) |
| 让路注册面 | keydown 挂 **window 冒泡**（不是捕获） | [index.ts:3651](../src/client/index.ts#L3651) |
| IME | `isComposing` 期间不处理按键 | [index.ts:3327](../src/client/index.ts#L3327) |
| 采纳优先于重出 | 两键配成同一个 ⇒ 采纳赢（`Tab 永远采纳`） | [index.ts:3340](../src/client/index.ts#L3340) |
| 非 `llm` 形态不碰事件 | regen 键在非 llm 形态**不吞键、不 stop**，原样交还宿主 | [index.ts:3363](../src/client/index.ts#L3363) |
| 判据不过不假装 | 帧闸 / 同源闸不过 ⇒ 不 `preventDefault`，键回原生 | [index.ts:3380](../src/client/index.ts#L3380)、[accept-source.ts:106](../src/client/accept-source.ts#L106) |

### 1.3 设置卡片内部

| 触点 | 现状 | 出处 |
|---|---|---|
| 录制态退出 | `Esc` 取消录制（卡片自有，不受 `dismissKey` 影响） | [settings-card.tsx:698](../src/client/settings-card.tsx#L698) |
| 热度手工新增 | 输入框里 `Enter` 提交 | [settings-card.tsx:853](../src/client/settings-card.tsx#L853) |

### 1.4 三条**已核实**的既有问题（一条空承诺 + 一条隐式判据 + 一条用户可触发的失效）

1. **`Esc 关闭` 这条承诺不由本插件兑现。** 全仓 `src/client/` 里 `Escape` 只出现在卡片的录制退出
   （`:698`），`onKeyDown` 从头到尾**没有 Escape 分支**——幽灵只靠「内容消失 / 焦点离开 /
   形态不符」收掉（[index.ts:2456](../src/client/index.ts#L2456)、`:2481`）。
   宿主输入框自己派发 `KEY_ESCAPE_COMMAND`（`@deepseek-ai/dsh-client-ui-conversation`），
   那个命令到底关不关幽灵**未取证**（本方案不替宿主背书）。
   ⇒ 屏幕上那行字承诺了一个我们不实现的键，还把它写死在文案里（中英各一处），且不可配。
2. **`llm` 形态的「不按 →」没有判据，只有巧合。** `wordAccept` 那条 `if` 只判
   `event.code === 'ArrowRight'`（[index.ts:3462](../src/client/index.ts#L3462)），**没判 `content.kind`**。
   今天 `llm` 形态按裸 `→` 确实什么都不写——但**不是因为形态闸**：`llm` 浮层画的是整段
   （[index.ts:1540](../src/client/index.ts#L1540) 的 `paintedText`），而逐词的 `accepted` 只是首片，
   于是 #166 的同源闸 `accepted.endsWith(painted)` 恒假 ⇒ 走 `word-abandon` 早退，且**不吞键**
   （[accept-source.ts:108](../src/client/accept-source.ts#L106)）。行为与文案一致，但一致性来自
   另一条闸门的副产物，与 #167 那条教训同形（「一致性靠的是巧合，不是结构」）：
   一旦 `llm` 形态改成只画后缀（锚定前缀），裸 `→` 就会**静默开始吃字**。
   ⇒ 建议把这条隐式判据显式化（§3.4），**不改行为**，只把巧合变成结构。
3. **【实测补强】注释与代码对「同键谁赢」说的是反话。** `onKeyDown` 里 regen 支排在采纳支**之前**
   （`:3354` 对 `:3373`），而它头上的注释写的是
   「若把 regen 键与 acceptKey 配成同一个键，**采纳优先**是本仓既有语义（Tab 永远采纳），
   而 regen 是新增入口，不该抢走用户已经习惯的那一个」（[index.ts:3339-3341](../src/client/index.ts#L3339)）。
   实际执行顺序给的是**重出优先**：命中 regen 即 `preventDefault` + `requestRegen` + `return`
   （[index.ts:3368](../src/client/index.ts#L3368)），采纳支再也拿不到这一次按键。
   更糟的是第二支：`content.kind !== 'llm'` 时它 `traceOnce('regen-skipped', 'not-llm')` 之后**直接 `return`**
   （[index.ts:3363](../src/client/index.ts#L3363)）——于是「把换一条快捷键设成 `Tab`」这个
   **今天就能在设置页做到的操作**，会让历史补全 / 停顿续写形态的 `Tab` 采纳**整条失效**
   （采纳支在同一个函数里被 `return` 挡在后面）。这条不是「文档说得不精确」，是**用户可自主触发的功能失效**。
   ⇒ §3.3 的优先级表与冲突警告要顺带把它修掉，且**默认值层面就该拒绝**（见 §3.3 末段）。

## 2. 为什么不用内核的官方快捷键服务（先钉死，防止下一个人重新猜）

内核**有**这套东西，而且比本插件自建的那份完整：`@deepseek-ai/dsh-client-shortcuts`
把服务挂在客户端 `ctx.shortcuts` 上（`declare module '@deepseek-ai/cordis' { interface Context { shortcuts: Shortcuts } }`），
提供 `register` / `registerFixed` / `describeBinding` / `edit` / `catalog`，UI 侧
`dsh-client-ui-shortcuts` 提供设置页的「快捷键」条目、参考面板与**录制层**
（`ShortcutEditor` 的 `recording(active)` 能压掉原生菜单 accelerator，还带平台键帽渲染 ⌃⌥⇧⌘）。

**但它收不下我们的键**，判据在内核自己的校验里，`lib/protocol.js`：

**包**：`@deepseek-ai/dsh-client-shortcuts@0.2.2-rc.5`，判据都在它的 `lib/protocol.js`
（下表的行号是**已安装内核的那份拷贝**，不在本仓，路径 `~/.npm/_npx/…/dsh-client-shortcuts/lib/protocol.js`）。

**判据不是推理出来的**：下面这张表是把内核的导出直接跑出来的
（`node --input-type=module` + `import('…/dsh-client-shortcuts/lib/protocol.js')`，调
`bindingIssue(normalizeBinding(b, platform), 'web', platform)`，`w/m/l` = windows / macos / linux）：

| 候选绑定（实测） | `web` 运行时结果 | 对本插件的后果 |
|---|---|---|
| `Tab` / `ArrowRight` / `Escape` / `Enter` **零修饰** | 三平台一律 `modifier-required` | **插件全部现有默认值都是零修饰键** ⇒ 一条都进不了官方可编辑命令表 |
| `Tab` + `Ctrl+Alt` | `w=OK` · `m=reserved` · `l=reserved` | 带修饰才可能合法，但 **macOS 要 meta、Linux 白名单里没有它** ⇒ 迁过去等于按平台改默认值 |
| `Alt+G`（**现役 `regenKey` 默认**） | `w=unsupported-browser` · `m=reserved` · `l=unsupported-browser` | **连今天的默认值都不被官方接受**：三平台全拒 ⇒ 迁移必然改键 |
| `KeyF` 零修饰（字母键） | 三平台 `modifier-required` | 与 #167 那条「字母键会吞输入」同向，但内核是按「裸键一律不许」一刀切 |
| `KeyG` + `Ctrl+Alt+Shift` | `w=OK` · `m=OK` · `l=unsupported-browser` | Linux web 只认 3 条白名单（`Ctrl+/`、`Ctrl+Shift+,`、`Ctrl+Shift+.`）加 ≥3 修饰里的少数形态 |

另有两条顺带核到的规则：命令 id 必须匹配 `commandPattern = /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u`
（`protocol.js:130`，`suggest-ghost.accept` 合法、单段 id 不合法）；`normalizeBinding` 只认
`Key[A-Z]` / `Digit[0-9]` / `F1–F24` 加一张 `keyNames` 表（`:42`），**表外的 code 直接抛**
——这条与本仓 `keyspec.ts` 的 `keyCodeOf` 白名单是同一个坑（历史上「spec 写了表里没有的主键 ⇒ 静默不生效」）。

三条路都试过，都不通：

1. **迁到 `register()` 当可编辑命令**：默认值非法（上表第 3 行），等于**顺手改掉用户的既有键位**，
   而且失去「幽灵在屏才生效」这一层——`resolve()` 能表达条件，但绑定本身已被内核判死。
2. **用 `registerFixed()` 声明我们的键**：语义正对口（该 API 的注释就是
   「whose keys cannot be assigned to editable commands」），但它是**只读展示 + 占位防重复**，
   **动作仍归我们自己的监听**——不产生任何自定义能力，只多一个必须维护的注册点。→ 挪到 §4 单列。
3. **只借它的录制 UI**：`ShortcutEditor` 的 props 是 `InjectFace<ReferenceInjected>` 一整套
   （`useCatalog`/`useConfig`/`useFixedCatalog`/`edit`/`recording`/`describeBinding`/`platform`/`runtime`），
   喂的是内核自己的存储文档，我们的键位存在插件 Config 里，**两套存储对不上**；硬接要写适配层，
   收益只是少一个 30 行的 `KeyField`。不值。

## 3. 方案

### 3.1 数据形状：仍然只是字符串，但**加一道校验**

4 个键位是 `z.string().min(1).default('...').volatile()`，与 `acceptKey` / `regenKey` 同族；
`dismissKey` **独享空串语义**（留空 = 不接管关闭动作），故它是 `z.string().default('Escape')`，
不带 `min(1)`（理由与 `suggestionPrompt` 同族：必填会让「清空回默认」这条路径当场写不进去）。
`.volatile()` 是**全部五键的硬要求**——内核 `SettingsForms.write()` 只接受 volatile 路径，非 volatile 直接抛。

```ts
// index.ts EditableFields
wordAcceptKey: z.string().min(1).default('Right').volatile(),
localAcceptKey: z.string().min(1).default('Tab').volatile(),
dismissKey: z.string().default('Escape').volatile(),   // 唯一允许留空的一项：空 = 不接管
```

**默认值必须被 `keyCodeOf` 认得**——这条钉在 `scripts/keyspec-smoke.mjs`，历史上「spec 写了表里没有的
主键 ⇒ 静默不生效」是本仓真踩过的坑（[accept-key.ts:26](../src/client/accept-key.ts#L26) 注释）。
注意显示名是 `Right`（`keyNameOfCode('ArrowRight') → 'Right'`），**不是** `ArrowRight`；
写 `ArrowRight` 也能命中（`KEY_CODES` 里有 `right`），但录制控件回放出来的字会跟存的值不一致。

`min(1)` 挡不住空白串（`" "` 合法），而空白 spec 在两侧都退化成「这一支永不命中」。
本方案**不改 schema 语义**（改法见 §5 的风险），而是在卡片侧用 §3.2 的录制控件保证写进去的一定是合法 spec。

### 3.2 安全键判据：`isSafeActionKey`（扩范围的前置条件）

`localAcceptKey` / `wordAcceptKey` 作用在**边打字边出幽灵**的两个形态上。把字母键配到这里，
用户设成 `F` 后每打一个字母都命中采纳 ⇒ 输入被建议吞掉。这正是 Gitea #167 收窄作用域的原始理由
（[accept-key.ts:24](../src/client/accept-key.ts#L24)），它留了话：
「要扩范围必须先定『字母键在本地即时形态上是否禁用』或收窄 schema 的合法字符集」。

本方案取**判据**而不是收窄 schema（判据能给出人话报错，schema 只会静默拒绝）：

```ts
// keyspec.ts —— 纯函数，零 DOM，smoke 可直载（与 keyEventToSpec 同一文件、同一张表）
/** 会被浏览器直接打进输入框的主键：字母、数字、空白与可打印标点。 */
function isTextKey(code: string): boolean;
/** 该 spec 能否配给「边打字边显示」的形态：非文本主键，或带 Alt/Ctrl/Meta 的组合。 */
export function isSafeActionKey(spec: string): boolean;
```

`Tab` / `→` / `Esc` / `F1–F12` / `Alt+任何` / `Ctrl+任何` 安全；裸 `F`、裸 `Space`、`Shift+A` 不安全
（`Shift` 仍会打出字符，所以它不算「解除文本」的修饰键）。`Enter` 单独一档：它**不往输入框打字**，
但在 web 宿主上通常是**发送消息**，配成采纳键会把发送吞掉 ⇒ 允许但要在卡片里给警告文案，
不静默接受。判据与警告文案同一来源，别再写第二份（本仓纪律：**判据只许有一处**，
`uiPriorLanguage` 与 `acceptKeyFor` 都是这条的既成先例）。

`KeyField` 录制时若录到不安全的 spec，**不写入**，就地显示 `t.keyUnsafe`（「这个键会吞掉打字，
换一个带 Alt/Ctrl 的组合，或用 Tab / 方向键 / F1–F12」），Esc 取消。

### 3.3 冲突检测：`bindingConflict`

5 个键位落在同一张表里，两两相同就有歧义（今天的「采纳优先于重出」是**巧合般可用**，
不是用户能预期的规则）。新增纯函数：

```ts
/** 返回与 spec 重复的其他动作名；空数组 = 无冲突。 */
export function bindingConflict(spec: string, others: Record<string, string>): string[];
```

卡片在字段下方渲染 `t.keyConflict(otherLabel)`。**警告而不禁止**——同一个键配两个动作是
用户的表达（有人就是要 `Tab` 采纳、`Tab` 关闭），禁止会把「键盘不舒服」变成「保存不了」。
**唯一的例外是 §1.4-3 那一类**：采纳键与 regen 键相同 ⇒ 不是「用户想要同一个键做两件事」，
而是**必然让一支失效**，这种组合录制时就拒绝并说明理由（`t.keyConflictFatal`）。

运行时判据要从「一串 `if` 谁写在前面」改成**一张归属表**：

```ts
/** 一次按键最多归一个动作。顺序即优先级；采纳是主操作，故在重出之前。 */
export const KEY_ACTION_PRIORITY = ['accept', 'word', 'regen', 'dismiss'] as const;
/** 这一键此刻归谁（纯函数，输入 = 生效键位表 + 事件事实）。 */
export function ownerOfKey(table: BindingTable, event: KeyFacts): Action | null;
```

顺序取 **accept > word > regen > dismiss**，与注释里那份既有语义（`Tab 永远采纳`）一致，
也修掉 §1.4-3 的反话。`dismiss` 排最后因为它**只藏浮层**、不写字，抢输的代价最小。
这条顺序**必须进冒烟**（§6）：三对键各配成同值，断言只有优先级高的那支执行。

### 3.4 `dismissKey`：把「Esc 关闭」这句承诺补成真实现

选**补实现**（`onKeyDown` 加一支：命中即 `overlay.hide()` + `setKeyHint(null)` + `shown = null`，
不写草稿、不 abort 在途生成）：

- 它兑现已经写在屏幕上的那行字，且**零副作用**（只藏浮层，下一个触发点照样重画）；
- 在 §3.3 的归属表里 `dismiss` **优先级最低**（不是「排在最前」）：与别的动作同键时，
  采纳那条已经付过模型钱的建议比关掉浮层更有价值，关掉它什么都不写、随时能再来一次。
  用户真想要「`Tab` 只关不采纳」，把 `acceptKey` 换成别的键即可——冲突警告会把这条路指清楚；
- 判据不过时同样**不吞键**（沿用 §1.2 那条不假装规则）；`dismissKey` 配成 `Escape` 时，
  宿主自己的 `KEY_ESCAPE_COMMAND` 与我们的让路规则相遇 ⇒ 因为本插件挂在冒泡层，
  宿主已 `preventDefault` 则 `shouldYieldKey` 直接让路（**用户会感觉 Esc 关不掉幽灵**）。
  这是既有架构的必然结果，**如实写进 hint**，别承诺「一定能按掉」。
- **默认 `Escape`，但允许留空**（schema 写 `z.string().default('Escape')`，**不带 `min(1)`**，
  理由与 §3.1 同）：空串 ⇒ 这一支永不命中 ⇒ 提示行也不再写 `Esc 关闭`（文案与行为同步消失，
  不留一句空话）。**只有这一项允许空**：采纳 / 逐词 / 换一条留空等于把功能锁死，属于误操作。

**同时**把逐词支的形态判据**显式化**（§1.4-2）：在该 `if` 的条件里加 `content.kind !== 'llm'`，
**行为逐字不变**（今天这一支在 `llm` 形态上被同源闸挡住，加闸之后被形态判据挡住，
可观测差异只有 trace 理由从 `word-abandon` 变成一条独立的 `word-not-llm`）。
理由是**归属**：同源闸的职责是「屏幕上那句 vs 要写那句」，不该顺带负责「这个形态有没有逐词这件事」；
把它顶着的隐式规则写回代码，才不会有下一单顺手改动同源判据就把 `→` 放出来吃字。
选代码向文案对齐（而不是反过来让提示行三形态都写 `→`），因为 `llm` 的采纳语义是**整段覆盖草稿**
（[accept-key.ts:24](../src/client/accept-key.ts#L24)），逐词吃半条再整段覆盖上去最不可解释。

### 3.5 设置页：新分区 `keybinds`，把散在三个分组里的键位收拢

`wordAccept` 现在在「历史前缀补全」区（[settings-card.tsx:379](../src/client/settings-card.tsx#L379)）、
`showKeyHint` 在「外观」、`acceptKey` / `regenKey` 在「LLM」。用户问「我要改键」时得翻三个区。

- **移入的字段**：`acceptKey`、`localAcceptKey`、`wordAccept`（开关）+ `wordAcceptKey`、
  `regenEnabled` + `regenKey`、`dismissKey`、`showKeyHint`。分区标题 `{ zh: '键位', en: 'Keyboard shortcuts' }`。
- **分区顶部加一行「当前生效键位」摘要**，读 `acceptKeyFor()` / 同一份 `bindingTable()` 的返回值，
  **不读设置项原值**——这样屏幕上那行提示与设置页这块摘要是**同一个数据源**，
  #167 那条「显示的键 == 生效的键」不变量在界面上就有两个可见出口，而不是只有一处。
- locale 目录（`zh` / `en`）各加分区名与新 hint 串；宿主其余界面语言落英文，沿用现状
  （卡片文案语言口径见 [README.md](../README.md) 的「配置」段）。
- **登记点清单（少一处就是静默失效，且都没有类型门禁兜——见下）**：
  | # | 位置 | 加什么 |
  |---|---|---|
  | 1 | [settings-card.tsx:61](../src/client/settings-card.tsx#L61) `GHOST_FIELDS` 的 `section` 联合 | 加 `'keybinds'` |
  | 2 | 同文件 `:1322`–`:1333` 的过滤 | 加 `keybindFields` 一行 |
  | 3 | 同文件 `:1336` `SECTION_LAYOUT` | `keybinds: 'stack'` |
  | 4 | 同文件 `:1370` 起的分组渲染块 | 加一段 section（决定它在详情页/设置页里的**顺序**） |
  | 5 | locale `zh` / `en` 的分区标题与新 hint 串 | 两份都要 |
  | 6 | `showKeyHint` 的 `section` 从 `'appearance'` 移到 `'keybinds'` | 单行；**同时**在「外观」区留一行交叉引用 |
- ⚠️ **这六处里第 1–4 处一个都不会红**（`.tsx` 不在类型检查范围内，见下）。
  【实测更正】本句原写「一个都不会红」——实现过程中真就在这上面炸了一次：
  `settings-card.tsx` 漏 `import { bindingTableFor }`，`tsc`/`build.mjs`/68 条冒烟**全绿**，
  一开沙箱详情页就 `ReferenceError: bindingTableFor is not defined`，宿主报
  `slot entry crashed in 'plugins.bundle.config'`（整块设置界面没了）。
  ⇒ 本单顺手补了一道闸 `scripts/client-name-check-smoke.mjs`：跑 `tsc --jsx` 但**只筛
  TS2304/TS2552**（未定义标识符），实测干净 `origin/main` 上该类为 **0**（总错误 53），
  所以「必须为 0」不会自己红；脚本自带注入自证（删掉那行 import 必须让它红）。
  下面第 250–257 行那段"不能靠编译"的结论对**其余五类错误**依然成立，只是名称这一类现在关掉了。 `tsconfig.client.json:63` 的 include 是 `src/client/**/*.ts`，
  `.tsx` **不在检查范围**（该文件 `:19` 与 `:47` 记着原因：一旦开 `jsx`，基线 25 条错误变 199 条，
  记在 Gitea #87，刻意不开）。于是 `:61` 那个联合里写着 `'display'`、实际三个字段用的是
  `'appearance'`，**没有任何门禁能发现**——`'display'` 是死值、`'appearance'` 是未声明值，
  两边都不报错（`grep -o "section: '[a-z]*'"` 实测：appearance 3 / history 5 / inline 6 / language 2 / llm 19，display 0）。
  同一条漏洞也解释了 [#127 当初漏登记 `regenKey` 的 `SETTING_SPECS`](../src/live-settings.ts#L124) 为什么能溜过去。
  ⇒ 本分区的验收**必须靠 §6 的冒烟与 GUI 取证**，不能靠编译；顺手把 `:61` 的 `'display'` 改成 `'appearance'`
  是**一行无行为影响**的纠偏，建议随本 PR 做掉并在 commit message 里点名（它不属于键位功能，属于门禁缺失的余震）。
- `wordAccept` 的 hint 必须改写：它现在写「Tab 始终采纳整条」
  （[settings-card.tsx:380](../src/client/settings-card.tsx#L380)），而 `Tab` 早已可配 ⇒ **已经存在**的文案过期，一并修。

### 3.6 生效链：一次改键要走完的五跳（少一跳就是「改了不生效」）

| # | 跳 | 位置 |
|---|---|---|
| 1 | schema 标 `.volatile()` | [index.ts:257-288](../src/index.ts#L257) |
| 2 | `PluginConfigValues` 加 `Volatile<string>` | [index.ts:389](../src/index.ts#L389) |
| 3 | `generate.ts` 的 `EditableConfig` + 两处 `readVolatile`（含 `'Tab'`/`'Alt+G'` 兜底） | [generate.ts:249](../src/generate.ts#L249)、`:295` |
| 4 | `live-settings.ts` 的 `SETTING_SPECS`（漏登记 = 实时值被丢回 boot 快照，就是 #19） | [live-settings.ts:124](../src/live-settings.ts#L124) |
| 5 | 客户端 live 读取的兜底（`:3132` 那片 `typeof v.xxx === ...`）+ `settings` 初值（`:1967`） | [index.ts:3132](../src/client/index.ts#L3132) |

`SETTING_SPECS` 是 `Record<keyof FlatConfig, FieldSpec>` ⇒ **漏键编译期就红**，这条类型面已成立；
真正会静默的是第 5 跳（客户端自己的兜底对象），所以冒烟必须覆盖它。
**【实测更正】三个新键都走完了全部五跳**，没有「客户端专用」的捷径：
`localAcceptKey` / `wordAcceptKey` / `dismissKey` 都进 `EditableFields` 与 `PluginConfigValues`，
也都进 `generate.ts` 的 `EditableConfig` + `FlatConfig` + 两处 `readVolatile` + `SETTING_SPECS`。
原因不是洁癖：`SETTING_SPECS` 是 `Record<keyof FlatConfig, FieldSpec>`，
而 `FlatConfig = Config & {…}` ⇒ **schema 里有的键，键表没有就编译不过**；
`readVolatile` 的兜底又必须与 `.default()` 同值，否则解析层与拍平层给出不同默认值（#124 配置面）。
它们仍然**不进** `_push` 载荷、不进 host 生成路径——
不要把客户端键位塞进 `GhostPushPayload`（`acceptKey` 今天进载荷是因为**宿主推的那条建议**自带采纳键，
新键没有这个来源，见 §5 的载荷不变项）。核对由
`scripts/keybinding-registration-smoke.mjs` 的 ①②③④⑤⑥ 六组集合比对钉住，不再靠人对眼。

## 4. 顺带面：`registerFixed`（单列，**不在本 PR**）

把 5 个动作的当前生效键用 `ctx.shortcuts.registerFixed({ group: 'input' })` 声明进内核的
快捷键参考面板，用户能在一个地方看全所有键位，且内核的可编辑命令不会撞上我们占用的组合。

- 语义正对口：`registerFixed` 的注释就是「read-only input action whose keys cannot be assigned to
  editable commands」，本仓先例是内核自己的 `approval.allow` / `approval.reject`
  （`@deepseek-ai/dsh-client-ui-approval/lib/client.js`）。
- 代价：**只在新内核存在**。实测包树 `~/dsh-versions`：`0.1.2-rc.1` **无** `@deepseek-ai/dsh-client-shortcuts`，
  `0.1.5-rc.3` **无**，`0.1.7-rc.2` 起**有**（`0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-rc.5` 全有），
  而本插件 `engines.dsh` 覆盖到 `>=0.1.2-rc.1`（[package.json](../package.json)）
  ⇒ 必须写成「服务不存在就跳过」的可选注入，且要补 `dsh.client.inject`。
- 独立 PR 的理由：它是**跨内核代次的兼容面**，验收要跑 `verify:kernels`，
  跟 §3 这种纯客户端行为改动混在一个 PR 里，任一条红了都说不清是谁的锅。

## 5. 明确不做 / 载荷不变

- **不改** `acceptKey` 已有语义（仍只管 `llm`… 见下）：新增 `localAcceptKey` 是把「历史/续写」
  这两支从硬编码里放出来，`acceptKey` 字段的含义**一个字节都不变**，避免同一份配置值在
  两个形态上解释不同（#167 的教训就是这个）。旧用户的既有配置因此继续成立。
- **不动** `_push` 载荷形状（`GhostPushPayload`）。`suggestion.acceptKey` 是宿主随建议推来的，
  本方案全部新键都是**客户端本地判据**，不进载荷、不进指纹——
  载荷指纹含 `acceptKey`（[index.ts:1761](../src/index.ts#L1761)），
  把它挪成客户端值会白白制造「同一条建议重推一次」。
- **不做** modifier-only 组合（内核 `keyEventToSpec` 的既有取舍：纯修饰键不成 spec，
  [keyspec.ts:64](../src/client/keyspec.ts#L64)）；**不做**多键序列/和弦（内核有 `secondCode`，
  我们没有需求，且 web 上 `secondCode` 一律 `unsupported-key`）。
- **不做**「导出/导入键位配置」——配置就是插件 Config 的字符串，`cordis.patch.yml` 已经能覆盖。
- **不改** `KeyField` 的注册方式（仍 `window` 捕获，录制态本就该抢在最前，与 §1.2 的让路规则无关）。
- **不引入**新依赖，尤其不 import `@deepseek-ai/dsh-client-shortcuts`（§2 的三条路都不走；
  §4 若做，也走 `ctx.shortcuts` 注入而非包依赖）。

## 6. 验收

### 6.1 冒烟（每条都要**变异自证**：把判据删掉，断言必须红）

| 脚本 | 新增断言 |
|---|---|
| `scripts/keyspec-smoke.mjs` | 五个默认值全部「可识别 + 可打印 + 按对了能命中自己」；`Escape` 已登记进主键表；`isSafeActionKey` 的 6 类边界（裸字母 / 裸 `Space` / `Shift+A` 不安全，`Tab`/`Right`/`F5`/`Alt+F`/`Ctrl+Enter` 安全） |
| `scripts/accept-key-smoke.mjs` | `acceptKeyFor({kind:'history'})` 读 `localAcceptKey`；`inline` 同；`llm` 仍读 `acceptKey`；「屏幕上写的键 == 生效的键」在 5 键全改后仍成立 |
| `scripts/accept-key-smoke.mjs` | 逐词支的形态闸：`kind:'llm'` + 裸 `→` ⇒ 不写入（§3.4 那条分歧修完的正证） |
| `scripts/key-hint-text` 相关（`key-hint-smoke.mjs`） | `dismissKey:''` ⇒ 提示行不出现 `Esc 关闭`；`dismissKey:'Ctrl+Alt+X'` ⇒ 出现该键名；`wordAcceptKey` 改名后 `→` 段跟着改 |
| 【实测更正】撞键断言落在 `accept-key-smoke.mjs`（没有单开 `binding-conflict-smoke.mjs`）：默认设置下**两张表内部都无撞键**；`regenKey=Tab` ⇒ llm 表报出 `accept` 且 `ownerOfKey` 判给 `accept` |
| `scripts/accept-key-smoke.mjs` | 归属表三对组合各一条：`accept`∩`regen` 同键 ⇒ 采纳赢；`accept`∩`dismiss` 同键 ⇒ 采纳赢；`word`∩`regen` 同键 ⇒ 逐词赢。另加：修饰键必须**逐一相等**（裸 `G` 命不中 `Alt+G`、`Shift+Tab` 命不中 `Tab`） |
| `scripts/tab-ownership-smoke.mjs` §I | **真 DOM 行为段**（跑在 `lib/client.js` 上，不是纯函数）：I1 dismiss 生效、I2 留空即不接管、I3 ★`regenKey=Tab`+history 仍能采纳（**跑基线产物必红，已实测**）、I4 `localAcceptKey=F4` 双向、I5 作用域不越界、I9 ★ llm 形态同键时采纳赢（**把优先级表反序必红，已实测**） |
| `scripts/keybinding-registration-smoke.mjs`（新） | 五处登记点集合比对 + 默认值三处一致 + `section` 联合与实际用值双向核对（专治 `.tsx` 无门禁） |
| `scripts/live-settings-smoke.mjs` | 3 个新键从 `describe()` 走到 `effective()`，**改后立即生效不重启**（#19 那类回归） |
| `scripts/tab-ownership-smoke.mjs` | 让路规则不因新增 `dismiss` 支而退化：已 `preventDefault` 的 `Escape` ⇒ 本插件什么都不做 |

### 6.2 真 GUI 面（沙箱 web 实例 + Playwright，配方见 [real-session-harness.md](./real-session-harness.md)）

取证 4 张，存 `docs/shots/`：`keybinds-section`（新分区全貌 + 一行摘要）、
`record-unsafe`（录到裸字母时的警告文案）、`record-conflict`（两个动作同键时的红字）、
`dismiss-works`（幽灵在屏 → 按 `dismissKey` → 浮层消失且草稿未变）。
`docs/settings-card.png` 需要重截（分区变了）。

### 6.3 文档

README 的「配置」表格加分组行、并把「快捷键」那几列从三处合并（`README.md` / `README.en.md` 同步）；
`package.json` 的 `files` 加本文件；CHANGELOG 写清新键位与 `Esc 关闭` 那条文案变更
（**改了用户可见的承诺，必须在 changelog 里单独点名**）。

## 7. 三件事的拍板结果（用户 2026-11-26：按本方案默认定）

1. **逐词形态分歧往哪边修**（§3.4）：代码向文案对齐（`llm` 不给逐词），还是文案向代码对齐
   （提示行三形态都写 `→`）？本方案默认前者，理由是 `llm` 采纳语义是整段覆盖。
2. **`Enter` 当采纳键**：允许但警告，还是直接拒绝？本方案默认允许 + 警告（不替用户决定，
   但也不静默吞掉发送）。
3. **分区搬迁会不会动到详情页**：`surface === 'detail'` 时卡片也渲染同一批字段
   （[settings-card.tsx:1350](../src/client/settings-card.tsx#L1350) 起），新增分区在详情页同样出现。
   若希望详情页保持精简，需要给 `keybinds` 加分区级白名单——这是**产品选择**，不是技术约束。
   ⇒ **按默认做**：详情页与设置页同一套分区（不加白名单），与现状一致、零新增机制。

## 8. 实现中新发现的一条缺陷（不在本单修，另开 Gitea #185）

**逐词采纳（`→`）在真实产物上写不出任何字符。** 它不是本单引入的——同一份场景跑在
`origin/main` 的产物上读数完全相同（两侧都 `writes=[]`、`pluginPrevented=false`）。
本单给它补真 DOM 行为断言时，**对照臂与实验臂一起红**，才把「我改坏了」这个假设证伪。

根因是 #166 同源闸与逐词的天然形状冲突：`history`/`inline` 形态浮层只画**后缀**，
而逐词的 `accepted` 只前进一个片段 ⇒ `accepted.endsWith(painted)`
（[accept-source.ts:106](../src/client/accept-source.ts#L106)）恒假 ⇒ 每次逐词都走
`word-abandon` 早退。只有「剩余恰好一片段」时放行，而那时逐词等价于整条采纳。
`word-abandon` 是 debug 级留痕（默认静音），所以现场只有「按了没反应」，这解释了它为什么从没被测到。

本单的处理（**不修，也不假装没看见**）：
- `scripts/tab-ownership-smoke.mjs` 的 `I6ctl` 断言**当前（错误）行为**，并写明
  「本条转红 ⇒ 逐词被修好了，请删绊线 + 把 I6 升级为真断言 + 更新 #185」；
- `I6`（`wordAcceptKey` 改键的端到端行为）标 **NOT-COVERED**，写清缺的前置是什么——
  在闸恒判否的情况下，「键已改到 ↑」与「键没接上」在 DOM 读数上**完全同形**，
  拿同形当证据就是假绿；
- `§1.4-2` 那条形态判据的显式化**照做**（行为一字不变，只是把巧合变成结构），
  但它今天的 observable 后果被这条缺陷盖住——`I8` 的证据强度因此有限，已在那条断言里写明。

## 9. 与内核官方快捷键服务的最终关系

维持 §2 的结论（不迁）。补一条实测读数，免得下一个人再去猜：
`bindingIssue(normalizeBinding(…), 'web', platform)` 直接跑的三平台结果——
零修饰 `Tab`/`ArrowRight`/`Escape`/`Enter` = `modifier-required`；
现役默认 `Alt+G` = `unsupported-browser` / `reserved` / `unsupported-browser`；
`Tab+Ctrl+Alt` = `OK` / `reserved` / `reserved`。
⇒ 官方可编辑命令表**收不下本插件任何一个默认键**；`registerFixed`（§4）仍是唯一能进官方面子的通道。
