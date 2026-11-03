# rewrite P0 三条核实（#126）

工单 #126 把「无幽灵按键通道」「宿主 composer 槽位面」「候选键占用」三项列为 P0 核实任务，
并明令「没有证据的结论不得写成已确认可行」。本文是这三项的核实结果，2026-11-03 实测。
**不含任何实现**：`src/**`、`package.json`、`CHANGELOG.md` 一字未动。

怎么读本文的证据等级：

- **Measured**：本文给出命令与真实输出，可在沙箱复跑。
- **Sourced**：溯源到 `file:line`、宿主 dist 里的真实字符串，或本文列出并跑过的命令。

引文一律保持宿主打出来的原样（含其中的破折号），不改写证据本身。
- **NOT-COVERED**：没跑到，写明缺的前置，不许当已确认用。

实验环境：隔离沙箱实例 `~/dsh-sbx-126`（`node scripts/dev-sandbox.mjs --home ~/dsh-sbx-126 --rewrite 'port: 3983=port: 4261' --check` 后再 `--deploy`），
内核 `0.2.1-rc.5`（`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/package.json` 的 version），
驱动方式：自带 headless Chromium + CDP（`Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`），
不用共享浏览器（见文末「方法记录」第 1 条）。沙箱里的实例加载的是**沙箱私有产物副本**，主仓与 live 宿主未受影响。

---

## 结论一览

| 条 | 结论 | 等级 |
|---|---|---|
| 一 无幽灵也能触发的按键通道 | **不需要新增 window 监听**。插件那条 `window` capture keydown（`src/client/index.ts#L2633` 注册、`#L2654` 摘除）在**屏幕上没有幽灵时本来就被调用**，拦路的是 `#L2412` 那行 `if (shown === null) return;`。改造面收缩为「把这道门按形态拆开」 | Measured |
| 二 宿主 composer 可注入槽位 | **有，且实测注入成功并渲染**。可用的是四个 `list` 槽：`conversation.input.overlay`（composer 卡内浮层，多行预览的正解）、`conversation.input.dock`（卡上方全宽）、`conversation.composer.dock`（卡下方，**仅已有会话态渲染**）、`conversation.input.left` / `conversation.input.right`（工具行）。**不可用**：`conversation.composer.bar`（`single`，已被宿主占位，register 抛错）、`conversation.composer`（`chain`，register 抛「requires options.select」） | Measured（`0.2.1-rc.5` 真 GUI）+ Sourced（代次枚举） |
| 三 候选键占用 | `Alt+R`、`Alt+D`、`Alt+Enter`、`Alt+Shift+R`、`Alt+↑`、`Alt+←`、`Alt+Backspace`、`Alt+.`、`Alt+C` 在**页面侧无人拦截、不改焦点、不开模态**。`Shift+Tab` 无人 preventDefault，但浏览器原生反序换焦真的把焦点抬出 composer。`Enter` 与 `Shift+Enter` 被宿主 composer 吃掉（`#DIV[composer]` 那一跳 `dp 0→1`）。另一侧的闸：`Alt+Backspace` 与 `Escape` 虽然页面侧空闲，**当前 spec 语法写不出来**（`keyCodeOf` 返回 `undefined`，静默不生效那条），要选它们得先扩 `KEY_CODES` | Measured |

对 P1 的一句话：**呈现方式选宿主槽位浮层（`conversation.input.overlay`），不选自建 DOM overlay；默认键定 `Alt+R`**。

---

## 一 无幽灵按键通道的改造面

### 结论

现状键盘面只有 `onKeyDown`（`src/client/index.ts#L2410` 起，两道门 `#L2411` IME / `#L2412` `shown === null`），
监听在 window 捕获阶段（`#L2633`），卸载在同一 `ctx.effect` 的 disposer 里（`#L2654`）。
实测给出三件事：

1. 这条监听**不是「有幽灵才挂」**，它常驻，无幽灵时每个按键也走到它、由它自己早退。
   ⇒ 「新增一条独立 window 监听」这个选项**没有收益**，只有成本（多一条要管卸载的监听、多一个注册次序问题）。
2. 它在整条链的**很前面**（window 捕获），早于 composer 元素自己的处理器，也早于 document/BODY/`DIV#root` 的各跳。
   ⇒ 在拆开的门里加 rewrite 支，拿到的时序与今天采纳路径一致。
3. 会话切换与新建会话**不会让它多挂一份**，`ctx.effect` 的清理形状在客户端这条路是真在跑。

### Measured：页内 keydown 监听清点

用 `Page.addScriptToEvaluateOnNewDocument` 把 `EventTarget.prototype.addEventListener` /
`removeEventListener` 包起来，记录每条 keydown/keyup 的注册者（含注册栈）与每次调用前后的 `defaultPrevented`。
开局（composer `phase=plain`，屏幕上没有幽灵）window 上的 keydown 监听共 **4 条**：

```
【开局】window 上的 keydown 监听：
[{"id":1,"capture":true,"live":true,"stack":"/assets/index-BXV-oxvX.js:134:22491"},
 {"id":3,"capture":true,"live":true,"stack":"installKeyboard (/plugins/??@deepseek-ai/dsh-api-gateway/client.js,@d…"},
 {"id":4,"capture":false,"live":true,"stack":"installKeyboard (/plugins/??@deepseek-ai/dsh-api-gateway/client.js,@d…"},
 {"id":5,"capture":true,"live":true,"stack":"v2.<anonymous> (/plugins/??@deepseek-ai/dsh-client-ui-trajectory/client.js,…"}]
```

`#5` 是本插件那条（`#3`/`#4` 成对出现、来自宿主 `installKeyboard`，capture 与 bubble 各一）。
点名 `#5` 的**正对照**是行为学的，不是靠栈字符串猜的：

```
【幽灵在屏 + 按 Tab】 ateBy:["#5@window keydown capture=1"]   ghost: display=block shown=1 → display=none shown=0
                      草稿尾部被补上建议文本（采纳发生）
```

`dp 0→1` 恰好发生在 `#5` 这一跳，且同一次按键让幽灵收起、草稿变长 ⇒ 插件的采纳支确实执行了 `preventDefault()`（源码 `src/client/index.ts#L2437`，逐词支在 `#L2504`）。

### Measured：无幽灵时 `#5` 仍然在场

草稿非空、屏幕上没有幽灵（rewrite 的真实状态）按 `Alt+R`，整条链 15 跳，`#5` 在列且没有翻转 `defaultPrevented`：

```
【无幽灵按 Alt+R】ghost=display:none shown=0；链（按执行顺序）：
1:window dp0>0 · 3:window dp0>0 · 5:window dp0>0 · 6:document dp0>0 · 12:BODY dp0>0 ·
8:DIV#root dp0>0 · 24:DIV[composer] dp0>0 · 7:DIV#root dp0>0 · 11:BODY dp0>0 · 4:window dp0>0 · …
```

⇒ 「无幽灵时没有任何按键入口」的成因不是「没监听」，是 `#L2412` 的早退。

### Measured：切会话不增挂

新建会话两次、再切回旧会话，window 上的 keydown 监听仍是同一组 `#1/#3/#4/#5`（`live:true`，数量不增），
同一次运行里 `removeEventListener` 记录到 document 与 `DIV[composer]` 上的多条监听被正常摘除。
⇒ 拆门方案继承的是**已经验证在跑**的那条清理路径（`ctx.effect` 的 disposer，`#L2654`）。

### 三种做法与各自牵动的既有判据

| 做法 | 牵动面 | 判定 |
|---|---|---|
| **A. 把 `#L2412` 那道门按形态拆开**（`shown === null` 时仍放行 rewrite 支，采纳支保持原样早退） | 焦点判据 `isComposerTarget` / `isComposerElement`（`#L474-L484`，要求 `[data-input-scroll]` 内的 `textarea` 或 `isContentEditable`）必须在 rewrite 支**之前**跑到；IME 约定 `#L2411` 必须留在最前（组合期不拦键）；`#L2414-L2417` 的 `activeElement instanceof` 三连同样要共用 | **推荐**。不加监听，清理面不变，时序不变 |
| B. 新增一条独立 window keydown 监听 | 要在**同一个** `ctx.effect` 里成对 add/remove（否则就是 `src/index.ts#L968-L976` 记的那条 root 僵尸同族）；要重排注册次序（新监听默认排在插件既有监听之后，与采纳支抢同一键时会晚一步）；卸载/partialReload 面翻倍 | **不做**，A 已覆盖需求 |
| C. 不用键盘，改走设置卡片/按钮触发 | 与工单「显式用户动作」不冲突，但用户要先移开焦点去点按钮，composer 焦点与 CAS 基线（`src/client/accept-guard.ts#L117`）要重建 | 可作为 A 的补充呈现，不是替代 |

### 对 P1 的约束

- 工单「客户端唯一的键盘面是 `onKeyDown`」这句要限定：设置卡片的**按键录制器**在录制态也挂一条 window capture keydown
  （`src/client/settings-card.tsx#L581`，处理器体在 `#L567-L579`，一进来就无条件 `preventDefault()` + `stopPropagation()`，`Escape` 用来取消录制）。
  本文真 GUI 的监听清单里没有出现它，因为没进录制态 ⇒ 与源码一致，不是它不存在。
  ⇒ 拆门时 rewrite 支的焦点门要把「焦点在设置卡片里」这种情况挡掉，否则两处抢键；这条也是「为什么不新增一条 window 监听」的第二个理由：
  新增的那条会与录制器那条争次序，而拆既有门不需要。
- rewrite 支**不要**调 `renderTraced`/`render`：render 的既有来源是三个 store 订阅 + 会话列表 + 设置事件 + IME 组合（`#L2587-L2631`），键盘不在其中。#21 那次风暴的成因正是「每个来源都调 render × 每次 render 都重置计时器」，判据换成「观察值变化」才压住（`src/client/index.ts#L1957` 的注释记录了这件事）。把按键再接进 render，等于给那条已封口的路重新开一个来源。
  本次实测的旁证（样本小，只作方向不作数值结论）：连打 12 个字符期间 `render-source` 留痕 1 行
  `session=3 input=4 face=0 other=43 total=50`，主导来源是 `other`，`input`（草稿订阅）只占 4。
- rewrite 支的 debounce 必须复用 `decideInlineArm` 那条**纯函数状态机**的形态（`src/client/inline-arm-policy.ts`），
  不要在 `onKeyDown` 里直接 `setTimeout`：那是 #21 的原病根。
- 拆门后 rewrite 支要**显式判「草稿非空」**，不许沿用「靠 `computeGhostContent` 分支顺序」的隐式判据
  （工单 §5.1 记的 #129 正在这条上）。

### NOT-COVERED

- **partialReload / HMR 路径下的清理**。缺的前置：沙箱要带 `--watch` 重建并真改 `lib/` 内容触发一次 `partialReload`。
  方法已经现成：同一个 `addEventListener` 包裹器 + 数 window keydown 监听条数（本文基线是 4 条，`#5` 是插件那条），
  重载后若 `#5` 变两条 ⇒ 客户端侧僵尸同族成立。谁要接就照这句话接，不必重新设计。
  本仓的前科在 `src/hotness-store.ts#L325` 那条注释里（`ctx.effect` disposer 在 partialReload 路径上**可能根本不跑**），
  这条不确定性对结论一不构成阻塞：**拆门不新增监听，就没有「漏清一份新监听」这回事**。
- render 连带的真实倍率（上面那 1 行样本不足以定数）。

---

## 二 宿主 composer 区的可注入槽位

### 结论

宿主有 **composer 级、且第三方插件可注入**的槽位。多行 rewrite 预览的正解是
`conversation.input.overlay`（kind `list`、scope `session`，宿主注释：
"Floating entries rendered inside the resident composer card"）。
⇒ **P1 不需要自建 DOM overlay**（工单 §5 那条「槽位浮层 vs 自建 DOM overlay」的分叉，落向槽位浮层）。
但 `conversation.composer.dock`（工单原本最想要的那个「卡下方 ambient 区」）**在 hero（无会话）态不渲染**，
只门在「已有会话」之后 ⇒ 用 dock 就得接受「新会话首条消息没有预览」。

### Sourced：代次枚举（哪些代有、哪些代没有）

宿主槽面是 `@deepseek-ai/dsh-client-ui-slots` 的 `interface SlotMap` 模块增强声明，
逐代次从 `~/dsh-versions/<代>/node_modules/@deepseek-ai/*/lib/types/**/*slots.d.ts` 里抽（枚举器的走法：
按目录递归、逐包读 `.d.ts`、找 `interface SlotMap` 块、按深度切出每个 `'name': { … }` 条目读 `kind`/`scope`）。
**注意 `grep -r` 不跟随符号链接**，各代次树里 `@deepseek-ai/*` 有的是指向 `.pnpm` store 的软链（如 `0.1.5-rc.3`）、
有的是真目录（如 `0.1.7-rc.2`），用 `grep -r` 数 0.1.5-rc.3 会得到 **0 命中** ⇒ 整棵目录树隐形；要 `grep -R`。

composer 区槽位面（`无` = 该代次没有这个槽名）：

| 槽名 | kind / scope | 0.1.2-rc.1 | 0.1.5-rc.3 | 0.1.7-rc.1 | 0.1.7-rc.2 | 0.2.0-rc.2 | 0.2.1-rc.2 | 0.2.1-rc.3 | 0.2.1-rc.4 | 0.2.2-alpha.2 |
|---|---|---|---|---|---|---|---|---|---|---|
| `conversation.input.overlay` | list / session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.composer.dock` | list / session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.dock` | list / session（owner `InputZone`） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.left` | list / session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.right` | list / session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.composer.bar` | single / session-maybe | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.composer` | chain / session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.activity` | single / session | 无 | 无 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.permission` | single / session | 无 | 无 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `conversation.input.model.label` | single / session | 无 | 无 | 无 | 无 | 无 | ✅ | ✅ | ✅ | ✅ |
| `conversation.hero.options` | list / session | 无 | 无 | 无 | 无 | 无 | ✅ | ✅ | ✅ | ✅ |

（live 那棵 `~/.npm/_npx/1e7f6d9597241db0`（`0.2.1-rc.5`）与 `0.2.1-rc.4` 同集合。）

宿主**真的消费**这些槽（不是只有声明），逐代次一条命令核：

```bash
for g in 0.1.2-rc.1 0.1.5-rc.3 0.1.7-rc.1 0.1.7-rc.2 0.2.0-rc.2 0.2.1-rc.2 0.2.1-rc.3 0.2.1-rc.4 0.2.2-alpha.2; do
  printf "%-14s " "$g"
  for s in conversation.composer.dock conversation.input.overlay conversation.input.dock conversation.input.left conversation.input.right; do
    printf "%s=%s " "$(echo $s | cut -d. -f2-)" \
      "$(grep -c "renderSlot(\"$s\"" ~/dsh-versions/$g/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js)"
  done; echo
done
```

输出：每一行都是 `composer.dock=1 input.overlay=1 input.dock=1 input.left=1 input.right=1`
（live `0.2.1-rc.5` 同样全是 1）。

注册形状有官方模板背书（宿主自带的插件开发 skill）：

```
~/…/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:16
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
  }, Decoration));
```

同 skill 的 `references/ui-plugin.md:5` 明写「For a simple drawing, prefer a slot with allocated space, such as
`conversation.composer.dock` when available」，`:13` 补一条硬约束「**Do not** append a second application to
`document.body`」⇒ 自建 DOM overlay 不仅多余，还违反宿主的插件纪律。

### Measured：真 GUI 里的注入实测

方法：把探针打进**沙箱私有产物副本**（`/tmp/deploy-126-slots/lib/client.js`，`--deploy` 那个目录），
在 `apply(ctx)` 里对 11 个槽名各注册一次，注册组件把自身写进 `window.__P126SLOT` 并在渲染时打 `data-p126-slot` 标记。
仓内 `src/` 与 `lib/` 未动，live 宿主未动。**负对照**：`definitely.not.a.real.slot`。

`0.2.1-rc.5` 真 GUI 的输出（逐槽）：

```
hasSlots=object hasInject=function
{"slot":"conversation.composer.dock","cbFired":true,"renderFired":false,"registerRet":"[object Function](fn)","err":null,"dom":{"found":false}}
{"slot":"conversation.input.overlay","cbFired":true,"renderFired":true,"registerRet":"[object Function](fn)","err":null,
 "dom":{"found":true,"visible":true,"size":"156x15",
        "chain":["SPAN","DIV(data-slot=conversation.input.overlay)","DIV","DIV","DIV","DIV(data-slot=conversation.composer.bar)","DIV","DIV","DIV(data-slot=conversation.composer)"]}}
{"slot":"conversation.input.dock","cbFired":true,"renderFired":true,…,"dom":{"found":true,"visible":true,"size":"806x15",…}}
{"slot":"conversation.input.left","cbFired":true,"renderFired":true,…,"dom":{"found":true,"visible":true,"size":"136x24",…}}
{"slot":"conversation.input.right","cbFired":true,"renderFired":true,…,"dom":{"found":true,"visible":true,"size":"144x24",…}}
{"slot":"conversation.composer","cbFired":true,"renderFired":false,"err":"register:chain slot \"conversation.composer\" requires options.select"}
{"slot":"conversation.composer.bar","cbFired":true,"renderFired":false,"err":"register:single slot \"conversation.composer.bar\" already has a registration at priority 0 (registered by Gb) — register at a diff…"}
{"slot":"conversation.view","cbFired":true,"renderFired":false,"dom":{"found":false}}
{"slot":"settings.section","cbFired":true,"renderFired":false,"dom":{"found":false}}
{"slot":"plugins.bundle.config","cbFired":true,"renderFired":false,"dom":{"found":false}}
{"slot":"definitely.not.a.real.slot","cbFired":false,"renderFired":false,"dom":{"found":false}}
```

读法：

- `cbFired`（inject 回调被宿主调用）是**槽名真实存在**的判据；负对照不触发 ⇒ 这条判据是活的。
  本仓 `src/client/index.ts#L2667-L2669` 记的教训（往不存在的槽名注册不报错、只是永远没人消费）在这里反过来用。
- `conversation.composer.dock` 与 `conversation.view` / `settings.section` / `plugins.bundle.config` 都 `cbFired=true`，
  差别在**渲染条件**：dock 门在已有会话态（宿主代码
  `dsh-client-ui-conversation/lib/client.js:19362`：`variant === "composer" && input !== void 0 && sessionId !== void 0`），
  后三者门在「打开设置/插件页」这类界面上（探针不导航过去，故未渲染，不是不可用）。
- `conversation.composer.bar` 与 `conversation.composer` 属于「**槽名存在但不可注入**」：
  前者是 `single` 且宿主自己已占位（register 直接抛错），后者是 `chain` 要 `options.select`。
  ⇒ 静态枚举槽名会**高估可用性**，P1 选槽必须以「register 不抛错 + 组件真渲染」为准，不能只看名字表。

dock 的会话态补测（同一个探针实例，发一条消息把页面推进 `active`）：

```
hero 态 composer.dock={"found":false}
进 active 用了 0.8s phases=active,plain
active 态 composer.dock={"found":true,"text":"P126::conversation.composer.dock","visible":true,"size":"167x15",
  "chain":["h0 DIV(data-slot=conversation.composer.dock)","h1 DIV[data-composer-dock]","h2 DIV",
           "h3 DIV(data-slot=conversation.composer.bar)","h4 DIV","h5 DIV",
           "h6 DIV(data-slot=conversation.composer)","h7 DIV","h8 DIV"]}
active 态 input.overlay={"found":true,…,"size":"156x15","chain":["h0 DIV(data-slot=conversation.input.overlay)","h1 DIV[data-composer-overlay]",…]}
```

⇒ `conversation.input.overlay` **hero 与 active 两态都在**，`conversation.composer.dock` 只在 active 在。
多行预览要在新会话首条草稿上也能出现 ⇒ 选 overlay。

### 对 P1 的约束

- 呈现落位用 `ctx.slots.inject('conversation.input.overlay', …)`，`kind: 'list'`、`scope: 'session'`，
  注册形状 `slots.register({ name, id, order, label }, Component)`；`register` 返回 disposer，必须挂进 `ctx.effect`。
- overlay 槽的宿主注释是 "Floating entries rendered inside the resident composer card"，DOM 上挂在
  `[data-composer-overlay]` 容器里（探针节点的祖先链实测：`SPAN → DIV(data-slot=conversation.input.overlay) → DIV[data-composer-overlay] → …`），
  与插件现有 ghost overlay（`#dsh-suggest-ghost-overlay`，自带 `pointer-events:none`）是两套载体。
  探针节点在 GUI 里 `visible:true`（`offsetParent !== null`），但**点击可达性本文没测**（见 NOT-COVERED）：
  预览卡要放「确认替换」按钮，就得实测能否点得着，不能靠「它是宿主渲染的普通 DOM」推定。
- `conversation.input.overlay` 在**全部 6 个受支持代次 + 0.2.2-alpha.2 都有**（见上表）⇒ 不需要 overlay 回退路径。
- 与 #129 的关系：rewrite 的预览浮层与 llm 形态灰字同屏时的优先级，本文未测（见下）。

### NOT-COVERED

- **老代次的真 GUI 渲染验证**：静态层（声明 + `renderSlot` 消费点）九棵树全绿，
  真 GUI 注入只在 `0.2.1-rc.5` 跑过。缺的前置：把同一个探针 `--deploy` 进各代次沙箱（`~/dsh-versions/<代>/node_modules/.bin/dsh` 起实例），
  一次约 3~4 分钟/代。工单验收标准里「0.2.1-rc.2+ 与一条 0.1.x 各跑一次」是 P1 实现期的活，本文没替它做。
- overlay 槽内条目的**点击可达性**（预览卡要放「确认替换」按钮）：探针节点 `visible:true`（`offsetParent !== null`）是实测，
  「点得着」不是。缺的前置：在探针组件上挂 `onClick`，用 CDP 真鼠标点它自己的 rect，看回调进不进。
- overlay 槽内条目的**尺寸/滚动/焦点行为**（多行卡片会不会把 composer 卡顶开、模态在场时谁让位）没测。
- overlay 与现有 ghost overlay、与 #129 那个「灰字压在已输入文字上」的形态同屏时的表现，没测。

---

## 三 候选键在真 GUI 里的占用矩阵

### 结论

`Alt+` 系（`R` / `D` / `Enter` / `Shift+R` / `↑` / `←` / `Backspace` / `.` / `C`）在页面侧**全部空闲**：
链上没有任何 handler 翻 `defaultPrevented`，焦点不动，模态不增，草稿不变。
`Shift+Tab` 是另一类：**没人拦它，但浏览器原生行为真的发生**（反序换焦，焦点从 composer 抬到 `BUTTON`）。
`Enter` 与 `Shift+Enter` **被宿主吃掉**（`#DIV[composer]` 那一跳 `dp 0→1`）。
`Tab` 在**无幽灵时透传**（焦点移动），**有幽灵时被本插件吃掉**（结论一的正对照）。

⇒ 默认键定 **`Alt+R`**（页面侧空闲；`Alt+D` 明确不选，理由见 NOT-COVERED 第 1 条）。
⇒ `Shift+Tab` 若要用，必须在命中时自己 `preventDefault()` 并当场把焦点放回 composer，否则用户丢焦点。

### Measured：按键矩阵

方法：CDP `Input.dispatchKeyEvent`（真 keydown/keyup 进浏览器输入管线，不是页内 `new KeyboardEvent` 合成事件），
状态是「草稿非空 `改一下这段代码` + 屏幕上没有幽灵」，每键之间把草稿清干净重打。
每键记四样：链上哪一跳翻 `dp`、`document.activeElement`、`[data-composer-dock]/[role=dialog]` 数量、草稿文本。

`0.2.1-rc.5`，无幽灵态（`ghost=display:none shown=0`）：

| 键 | 谁 preventDefault | activeElement | 模态 | 草稿 |
|---|---|---|---|---|
| `Alt+R` | 无人（链上 15 跳全 `dp0>0`） | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+D` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+Enter` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+Shift+R` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+↑` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+←` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Alt+Backspace` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变（但当前 spec 写不出，见下一节） |
| `Alt+.` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变（但当前 spec 写不出，要写 `Alt+period`） |
| `Alt+C` | 无人 | `DIV[ce]` → `DIV[ce]` | 0 → 0 | 不变 |
| `Shift+Tab` | 无人 | `DIV[ce]` → **`BUTTON`** | 0 → 0 | 不变 |
| `Tab`（无幽灵） | 无人 | `DIV[ce]` → **`BUTTON`** | 0 → 0 | 不变 |
| `Escape` | 无人（两次读数不一致，见下） | `DIV[ce]` → `DIV[ce]` | 见 NOT-COVERED | 不变（同样当前 spec 写不出） |
| `Enter` | **`#DIV[composer]`** | `DIV[ce]` → `DIV[ce]` | 不变 | **清空**（提交发生） |
| `Shift+Enter` | **`#DIV[composer]`** | `DIV[ce]` → `DIV[ce]` | 不变 | 不变（不提交） |
| `Tab`（幽灵在屏） | **本插件那条 window capture 监听** | 不动 | 0 | 采纳：草稿尾部补上建议文本，幽灵收起 |

原始 JSON 行（同一轮，节选，可直接对账）：

```
{"key":"Tab","ghost":"display=block shown=1","draftAfter":"…（采纳后变长）","activeAfter":"DIV[ce]","ateBy":["#5@window keydown capture=1"]}
{"key":"Enter","draftBefore":"改一下这段代码","draftAfter":"","sendBefore":"enabled","sendAfter":"disabled","ateBy":["#31@DIV[composer]"]}
{"key":"Shift+Enter","draftBefore":"改一下这段代码","draftAfter":"改一下这段代码","ateBy":["#31@DIV[composer]"]}
{"key":"Alt+R","ghost":"display=none shown=0","draftAfter":"改一下这段代码","activeAfter":"DIV[ce]","dialogsAfter":[…],"ateBy":[]}
{"key":"Shift+Tab","ghost":"display=none shown=0","draftAfter":"改一下这段代码","activeBefore":"DIV[ce]","activeAfter":"BUTTON","ateBy":[]}
```

复跑入口：`node scripts/dev-sandbox.mjs --home ~/dsh-sbx-126 --rewrite 'port: 3983=port: 4261' --check` → `--deploy .`，
用自带 headless Chromium + CDP 打开日志里的 URL（`grep -o 'dsh web: http[^ ]*' ~/dsh-sbx-126/logs/sbx.log | tail -1`），
先注入 `addEventListener` 包裹器（`Page.addScriptToEvaluateOnNewDocument`），再逐键 `Input.dispatchKeyEvent`。
探针脚本本轮在 `/tmp`（未入库，本文是判据与输出，脚本本身要复现得按上面的方法重写）。

### Measured：这些空闲键能不能写进 `rewriteKey`（spec 可表达性）

「页面上空闲」不等于「配置里能用」。工单登记过一条硬约束：主键不在 `KEY_CODES`（`src/client/keyspec.ts#L13-L30`）里，
`parseAcceptKey` 返回 `undefined` ⇒ 这一支永不命中且**静默**。上面矩阵里的空闲键逐条过一遍两端（纯函数直接装载实测）：

```bash
node --experimental-strip-types -e "
import('./src/client/keyspec.ts').then(m => {
  for (const [code,key] of [['KeyR','r'],['KeyD','d'],['Enter','Enter'],['Backspace','Backspace'],
       ['Escape','Escape'],['Period','.'],['ArrowUp','ArrowUp'],['Tab','Tab']]) {
    const spec = m.keyEventToSpec({code, key, altKey:true, ctrlKey:false, metaKey:false, shiftKey:false});
    console.log(code.padEnd(11), 'spec=', String(spec), ' 回读 code=', String(m.keyCodeOf(String(spec))));
  }
});"
KeyR        spec= Alt+R        回读 code= KeyR
KeyD        spec= Alt+D        回读 code= KeyD
Enter       spec= Alt+Enter    回读 code= Enter
Backspace   spec= undefined    回读 code= undefined
Escape      spec= undefined    回读 code= undefined
Period      spec= Alt+Period   回读 code= Period
ArrowUp     spec= Alt+Up       回读 code= ArrowUp
Tab         spec= Alt+Tab      回读 code= Tab
```

三条读数：

1. `Alt+R` / `Alt+D` / `Alt+Enter` / `Alt+Shift+R` / `Alt+C` / `Alt+Tab` **两端都通**（录制端给得出 spec、匹配端认得）⇒ 可直接作默认值候选。
2. **`Alt+Backspace` 与 `Escape` 写不出来**：录制端 `keyEventToSpec` 对这两个 code 返回 `undefined`，
   匹配端 `keyCodeOf('Alt+Backspace')` 同样 `undefined`。
   ⇒ 它们「页面上空闲」（上一表已测）但**当前语法不可表达**；要选它们必须先扩 `KEY_CODES`，
   并且工单里那条「把『写进 schema 默认值的 spec 一定被 `keyCodeOf` 认得』扩进 `scripts/keyspec-smoke.mjs`」要一起落。
3. **拼写有讲究**：`Alt+.` 与 `Alt+ArrowUp` 都是 `undefined`，正确写法是 `Alt+period` / `Alt+up`
   （`keyCodeOf` 查的是小写键名表）。⇒ 设置卡片把 spec 原文回显出来这件事在本条上是有用处的，别省。

⇒ 对 P1：默认键 `Alt+R` 落在「两端都通」那一档，不需要动 `KEY_CODES`。

### 对工单正文的两条纠正

1. **「`Escape` 属宿主 modal 所有权」需要限定条件**。primitives 的两条注释（
   `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js#L3694` "Give only the top modal Escape and Tab ownership"、
   `#L3879` "Escape or Shift+Tab close it"）讲的是**有模态在场时**的归属，本仓库版本是 `0.2.0-rc.2` 的 devDep，不是行为实测。
   实测的合成口径：**有模态时 Escape/Tab 归顶层模态；没有模态时 composer 里的 Escape 在链上无人拦截**。
   两轮读数不完全一致（一轮 `Escape` 使 `[role=dialog]` 从 0 变 1、没记内容；另一轮模态数不变、链上无人 preventDefault）
   ⇒ **Escape 不当候选**，本文不写成「Escape 随便用」。
2. **「候选键收缩到带 `Alt`/`Ctrl`/`Meta` 的组合」这句成立，但 `Shift+Tab` 不在「安全空闲」里**：
   它不被任何 handler 拦截 ≠ 无副作用（原生换焦真的发生）。同理 `Tab` 在无幽灵时也是「透传 + 丢焦点」。

其余行号核对：工单引的 `#L2410-L2412`、`#L2633`、`#L2654`、`#L474-L484`、`#L2421-L2424`、`#L2481-L2483`、
`#L508-L519`、`src/client/keyspec.ts#L13-L45`（`/^[a-z]$/ → Key{大写}` ⇒ `Alt+R` 这类 spec 会被 `keyCodeOf` 认得，
不踩「静默失效」那条）、`src/index.ts#L968-L976`、`scripts/hot-yield-ratio.mjs#L575`（`pressEnter`）
，在本文实验时的 HEAD（`9724539`，0.8.1）上**逐条对过，行号与内容都还成立**。
唯一要补的是 `src/client/index.ts#L2667-L2669` 那句「`settings.plugin.item` 在 0.1.7-rc.2 与 0.2.0-rc.2 里都不存在」：
按代次枚举，它**在 0.1.2-rc.1 与 0.1.5-rc.3 里是存在的**（`keyed` / `scope: root`，owner `SettingsPluginItemOwnerProps`，
声明方 `dsh-client-ui-settings-plugins`），从 `0.1.7-rc.1` 起才消失。那句注释挑的参照代次正好在消失之后，
所以「零命中」是对的、但「这个名字从来不存在」会被误读。这句不影响任何结论，登记在此防日后误读。

### NOT-COVERED

1. **headed Chrome 的浏览器级 accelerator**。`Input.dispatchKeyEvent` 走的是页面输入管线，**不经过浏览器 UI 的快捷键表**
   ⇒ `Alt+D`（headed Chrome 里聚焦地址栏）这类撞车在本手段**结构性看不见**，不是「测了没撞」，是「测不到」。
   ⇒ 决策：`Alt+D` 不选，默认键 `Alt+R`。缺的前置：一台有显示器的机器上手工按一次。
2. **IME 组合期**。`#L2411` 那条约定（组合期不拦键）本文没测「组合期按 `Alt+R`」的形态；
   页内另有 `compositionstart`/`compositionend` 两条 window 捕获监听（`#L2634-L2635`）与 `composing` 标志位参与渲染。
   缺的前置：一条能造出真组合态的输入路径。本仓 `scripts/` 里没有现成的
   （`grep -rln "IMECommitText\|isComposing" scripts/*.mjs` 零命中；这条 grep 只证明这两个串不在脚本里，不证明没有别的手段），
   既有的输入手段是 `document.execCommand('insertText')`（`scripts/hot-yield-ratio.mjs#L197`）与 CDP `Input.dispatchKeyEvent`，
   都不产生组合态。
3. **有模态在场时的候选键归属**（`Alt+R` 会不会被某个模态抢走）。本文矩阵都是在无模态的 composer 上测的。
4. `Ctrl+` / `Meta+` 系没有逐个测（只测了 `Control+Alt+R` 一例，空闲）。

---

## 方法记录：本轮咬到人的几处

按 `docs/gitea-workflow.md` §8 的口径记，都是现场发生的，不是引用。

1. **共享浏览器不保证连到自己的实例。** 早期一轮按键用 IDE 的 Playwright MCP 驱动，
   跑到一半那个 tab 被切到了**别人的沙箱**（`pid 559520`，`DSH_HOME=~/dsh-sbx-125`，端口 `43359`），
   那一轮数据全部作废，且在那台实例的 composer 里敲过字、按过一次 Tab（采纳了一次幽灵，没发消息）。
   ⇒ 本仓真 GUI 判据要么自带进程隔离的 Chromium（本轮后半段的做法：`--user-data-dir` 独立 + `--remote-debugging-port=0`，
   URL 从**自己沙箱的日志**里取），要么在派单里写死「用哪台实例」。`~/dsh-sbx-125` 不是我的实例，我没去动它。
2. **`grep -r` 不跟随符号链接 ⇒ 整棵目录树隐形**。核 `conversation.input.overlay` / `conversation.composer.dock` 时，
   `grep -rl` 数 `0.1.5-rc.3` 得 **0 命中**（那棵树的 `@deepseek-ai/*` 指向 `.pnpm` store），`grep -R` 才是 4。
   这是 §6「『某串没出现』不能直接当缺陷证据」的第三种失效方式：**遍历方式本身**。
   本轮的代次枚举器因此不走 `grep -r`，按目录递归逐文件读。
3. **在 `phase=inert` 的 composer 上按键，量出来的矩阵全是假的**（没有会话时宿主根本没挂 composer 处理器）。
   第一版 CDP 驱动用 `element.click()` 打不开工作区选择对话框，页面停在 inert，矩阵跑完才看出来 ⇒ 整轮作废重跑。
   正解：CDP `Input.dispatchMouseEvent` 真点，并且**每一步断言 `data-composer-input` 的 `phase` 脱离 `inert` 才继续**。
4. **`Input.dispatchKeyEvent` 的 `text` 字段会伪造「插字符」的假象**。带 `text: 'r'` 派发 `Alt+R`，草稿里真的多出一个 `r`，
   看起来像「宿主把 Alt+R 当字符插入」。去掉 `text` 后同一键草稿一个字都不变。
   ⇒ 本表只认 `defaultPrevented` 的翻转点、`activeElement`、模态数、草稿增删这四类可观测量，
   **不认「插了字符」当宿主行为**。CDP 派发也不跑浏览器 UI 快捷键（NOT-COVERED 第 1 条同源）。
5. **注入体自毁的两条，都被 `node --check` 抓在跑之前**：
   一是把 `'…[data-session-row]')…'` 的引号配错了，整脚本 SyntaxError；
   二是页内 `document.querySelector("[data-slot=conversation.session]")` 的属性选择器值**没加引号**，
   Node 侧语法没问题、页内抛 `SyntaxError`（`querySelector` 不接受裸 `a.b` 值）⇒ 表现为「脚本崩在捕获里」。
   ⇒ 每个注入体单独过一遍解析（`new Function(body)` / `node --check`），并且**页内异常必须打印 `exceptionDetails`**，
   静默 `undefined` 会被读成「读不到东西」。
6. **取退出码不在管道后面读 `$?`**（§8 第 3 条）：本轮清理与检查一律 `cmd > file; echo $?`。

收尾：`node scripts/dev-sandbox.mjs --home ~/dsh-sbx-126 --deploy .`（用仓内 lib 还原探针构建）→ `--cleanup` → `--residual`。

---

## 这份文档欠着的、P1 开工前必须知道的事

- 结论一里 `partialReload` 那条清理不确定性，本文用「不新增监听」绕开，而不是证明了它安全；
  若 P1 的实现中途改成「另起一条监听」，这条前科（`src/index.ts#L968-L976`、`src/hotness-store.ts#L325`）要重新拿出来核。
- 结论二的真 GUI 只在 `0.2.1-rc.5` 成立，老代次是静态层证据。工单验收标准里那条「0.1.x 各跑一次」不能因为本文而划掉。
- 结论三的 `Alt+D` 不是「测过没事」，是「测不到所以不用」。这条要落进键位默认值的理由注释里，别让后人以为是实测。
- rewrite 的「正在重写」pending 呈现面本文没测放哪：`conversation.input.overlay` 里放一个 spinner 是可行路径，
  但要它**在 hero 态也在**（overlay 槽满足）。这一条本文只到「槽在两态都渲染」的证据，没测 spinner 形态。
