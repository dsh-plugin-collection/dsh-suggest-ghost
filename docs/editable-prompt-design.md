# 设计：提示词改为「设置页可编辑 + 热生效」

> 状态：实现中。对应 Gitea issue：见 PR 里的链接。
> 读者：下一个改这块代码的人。结论先行，依据都在下面。

## 0. 结论

新增两个 volatile 配置项 `suggestionPrompt`（下一条建议）与 `completionPrompt`（停顿续写），
设置页里各给一个多行输入框。**留空 = 内置模板逐字不变**；填了内容 = 用它当模板展开，
模板里可以写 `{{builtin}}` / `{{language}}` / `{{maxChars}}` 三个占位符。
热生效沿用本仓既有的 `describe()` 实时覆盖层（#19 那条通路），不需要新机制。

## 1. 现状（为什么今天改不了）

| 事实 | 出处 |
|---|---|
| 两条提示词是硬编码函数 | `systemPrompt()` `src/generate.ts:586`、`inlinePrompt()` `src/inline.ts:72` |
| 调用处只传「字符上限 + 判定出的语言」 | `src/generate.ts:1083`、`:1296` |
| 设置页表单 = 内核把插件 Config 里 `.volatile()` 的字段投影出来 | `src/index.ts:132` 的 `EditableFields` |
| 全仓没有任何 prompt 类配置键 | `EditableFields` / `SETTING_SPECS` / `GHOST_FIELDS` 三处都过了一遍 |

⇒ 提示词既不能热改，也不能冷改，只能改源码重新构建。

## 2. 热生效这条通路已经存在，不需要新机制

写入：卡片 → `remote.settings.mutate` → 内核 `SettingsForms.write()`（只接受 volatile 路径）
→ `fiber.resolveConfig(next)` 换掉 fiber 的 config 引用。
读取：内核 emit `settings/document-updated(ns, revision)` → host `invalidate()` 标脏
→ 下一次 `effective()` 现读一次 `settings.describe()`（`src/live-settings.ts:366`）。
生效：每次生成都先 `const cfg = effective()`（`src/index.ts:3404`），而 system 在那次调用里现算
→ **改完到下一次生成就换词**，不重启。
兜底：事件没挂上时 5s TTL 自愈；`describe()` 抛错则回落 boot 快照，不崩。

这条通路今天对 32 个字段已经成立（#19 修的就是它）。新字段只要**登记齐**就白拿热生效；
漏登记 `SETTING_SPECS` 的后果正是 #19 那一类「设置页改了不生效」，所以登记点用冒烟钉死。

## 3. 语义（拍板的部分）

### 3.1 留空 = 内置模板，逐字不变

`override.trim() === ''` ⇒ 返回 `builtin` **同一个字符串**。
这不是偷懒，是回归判据：README 的 42 次实测口径、`regen.ts:226` 与 `generate.ts:1045`
都写着「`systemPrompt()` 本体一字不改」。默认发布形态（两键都是空串）必须与今天逐字节相同，
冒烟用例 2 / 7 钉这一条。

### 3.2 填了内容 = 用它当模板，三个占位符

| 占位符 | 展开成 | 为什么需要 |
|---|---|---|
| `{{builtin}}` | 内置模板全文 | 让「在内置前后加自己的规则」成为可能，不必抄一份全文，也不会因为整段替换而丢掉内置那十几条禁令 |
| `{{language}}` | 本次判定出的输出语言（`简体中文` / `English` …） | 语言仍由 `languageMode` / auto 判定决定，不因为自定义提示词而失效 |
| `{{maxChars}}` | 该路径的字符上限（建议 = `maxSuggestionChars`，续写 = `inlineMaxChars`） | 上限仍是设置项，不该被写死进用户抄的模板里 |

未识别的 `{{xxx}}` **原样保留**：不吞掉、不报错。吞掉会让用户以为生效了，报错会让整次生成
静默失败——两者都比「照原样发给模型」更难排查。

### 3.3 长度上限放在 schema，不在 resolver 里二次截断

`z.string().max(6000)`。6000 是「模板」的长度，`{{builtin}}` 展开后的总长不受这一项约束
（展开是用户显式要求的，内置模板本身约 1.9KB）。
卡片在**保存之前**按同一常量判超长并禁用保存按钮：内核的 zod 校验在写失败时只把 Promise
折成 `ok:false`，而卡片的 `save()` 不读这个结论（界面上表现为「点了保存、值没变」），
所以超长必须在客户端先挡住。上限常量只在 `src/prompt-override.ts` 定义一次，
卡片 import 它 —— 两份真相正是本仓反复防的东西（`ops-schema-coverage-smoke.mjs` 同款理由）。

### 3.4 三条路径各自读自己的键

`generateSuggestion` 只读 `suggestionPrompt`，`generateCompletion` 只读 `completionPrompt`，
与 `suggestionReasoningEffort` / `completionReasoningEffort` 的既有分键口径一致。

### 3.5 观测面

两条生成留痕各加一个键：`prompt=custom|builtin`（判据由 `promptSource()` 单点提供，
resolver 与留痕共用）。用途是回答「我改了提示词，这一轮用的到底是哪条」——
本仓的判据是「别拿日志里没出现当证据」，所以这里给的是一个**一定会出现**的量，
而不是"失败时才打"。

## 4. 登记点清单（少一处就是 bug）

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `src/index.ts` `EditableFields` + `PluginConfigValues` | 设置页根本不出现这一项 / 类型与推断不符 |
| 2 | `src/generate.ts` `Config`、`FlatConfig` | `live-settings` 的 `Record<keyof FlatConfig>` 编译期红 |
| 3 | `src/generate.ts` `flattenConfig` **与** `resolveConfig` 两处 `readVolatile` | `flattenConfig` 靠 `...config` 打底，漏一处的 boot 层会把 `{get()}` 引用对象当裸值带出去 |
| 4 | `src/live-settings.ts` `SETTING_SPECS` | #19 那一类：改了不生效（实时值被当非设置键丢弃） |
| 5 | `src/client/settings-card.tsx` `GHOST_FIELDS` | 界面没这一行，用户无从修改 |
| 6 | `README.md` + `README.en.md` | 文档与实现分叉（`reasoning-effort-smoke.mjs` 同款判据） |
| 7 | `scripts/prompt-override-smoke.mjs` | 上面六处此后各自漂移，没有任何检查会报 |

`_ops` / `_push` / `_hot` / `_residual` 是 **volatile 传输载体**，登记在 `TRANSPORT_KEYS`；
新增的两个是**真配置项**，绝不能登记进 `TRANSPORT_KEYS`（那里有一条加载期不变量会直接抛）。

## 5. 明确不做的事

1. **不做「查看内置模板」按钮**。卡片里不带内置全文的副本 ⇒ 零分叉风险；
   要看原文有两个去处：代码里的 `systemPrompt()` / `inlinePrompt()`，或直接在框里写
   `{{builtin}}` 把它保留进生效的那条。
   > **合并后修订（2026-11-27）**：这条判断作废了一半。"看不见基线的覆盖项只对读过源码的人
   > 可用"是可用性缺陷，不是审美问题，所以**要做可见性** —— 但形态改成
   > **「查看这次请求」**：只读展示 ① 生效的 system（内置或自定义展开后的结果）与
   > ② 框架化后的 user 消息，文本由宿主在请求时现算（走插件已有的 remote service，
   > 不是那条**故意不经鉴权**的 `/api/suggest-ghost/options`，也不是会落进
   > `cordis.patch.yml` 的 volatile 载体）。这样既覆盖全部文本面，又零分叉、零新增可配项。
   > 同一次讨论里我还提过"把摘要标签写得更明确"（`[Earlier context (plugin summary, not user speech)]`）——
   > **那条也撤回**：实测框架标签已占载荷 **123/426 字节（29%）**，加长标签是往反方向走；
   > 正确解法是把摘要挪出 user 角色（顺带一次性解决"摘要伪装成用户发言"）。
2. **不动 `systemPrompt()` / `inlinePrompt()` 本体**，也不动 `regen.ts` 的 `buildAvoidBlock`。
3. **不修 `avoidBlock` 这个死参数**（见第 6 节）。本 PR 只加功能，修复单独走一支，
   否则「功能没生效」与「修复有副作用」会在同一支里互相掩盖。
4. 不改输出净化/过滤链（`sanitize.ts`）：自定义提示词让模型输出更长文本时，
   既有的截断与过滤照旧兜住，这是有意为之——上限是行为边界，不是提示词的一部分。

## 6. 顺手发现的一条既有缺陷（不在本 PR 修）

`generateSuggestion` 声明了 `avoidBlock?: string`（`src/generate.ts:1052`），
`src/index.ts:3233` 也算好并从 `:3252` 传了进来，但 **`generate.ts` 的函数体里没有任何一处
引用这个参数**（`grep -c avoidBlock lib/generate.js` 在函数体内 = 0，只有形参本身）。
⇒ #127「换一条」的「避开本回合已拒的那几条」今天实际上**没有发给模型**。
`src/generate.ts:1045` 与 `src/regen.ts:226` 的注释都写着「只在调用处拼接」，
而那次拼接没写出来；`scripts/regen-smoke.mjs` 这个被注释引用的冒烟脚本也不存在
（现存的是 `regen-policy` / `regen-pending` / `regen-key` 三个）。
本 PR 把 resolver 放在 system 组装的**同一位置**，所以将来接上 `avoidBlock` 时
拼接顺序天然是「生效模板 + avoid 块」，自定义提示词不会把它挤掉。

## 7. 验收（已跑；真实输出贴在 PR 里）

| 层 | 命令 | 结果 |
|---|---|---|
| 类型 | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` | 0 error |
| 客户端类型面 | `./node_modules/.bin/tsc -p tsconfig.client.json --noEmit 2>&1 \| grep -o 'error TS[0-9]*' \| sort \| uniq -c` | 与 main **逐码相同**（TS18047×1 / TS2307×1 / TS2341×2 / TS2532×2 / TS5097×2 / TS6142×3 = 11） |
| 新冒烟 | `node scripts/prompt-override-smoke.mjs` | 17 组全绿 |
| 新真回合 e2e | `node scripts/prompt-override-real-e2e.mjs` | 8 通过 / 0 失败 / 0 NOT-COVERED |
| 全量冒烟 | `bash -c "$(node -p scripts['test:smoke'])"` | 退出码 0 |
| 全量 e2e | `bash -c "$(node -p scripts['test:e2e'])"` | 退出码 0 |
| 仓库闸 | `node scripts/artifact-freshness.mjs` / `gitignore-check.mjs` | 绿 |

### 变异自证（§6 的判据：注入，并且读到那句失败原因）

| 注入 | 红了哪条 |
|---|---|
| 删 `SETTING_SPECS` 里的 `suggestionPrompt` | 「两键都在且允许空串」 |
| 删 `flattenConfig` 的一处 `readVolatile` | 「应有 2 处 readVolatile，实得 1」 |
| 删卡片里 `key: 'suggestionPrompt'` 那一行 | 「两行卡片都在、可写、形态是 textarea」 |
| 卡片里把上限抄成字面量 `6000` | 「卡片里出现了字面量 6000」 |
| 删 `suggestion generated` 行尾的 `prompt=` | 「四条产出行都带 prompt=」 |
| 留空也走 `expandPrompt` | 「返回内置模板**同一个引用**」 |
| 把 `effective()` 换成 boot 快照（复刻 #19） | 真回合 e2e 两条：「回合 2 system 是展开结果」「留痕 prompt=custom」 |
| 把 `avoidBlock` 接上拼接 | 「既有缺陷钉桩」那条（它本来就是设计成"修它时必红"） |

⚠️ 变异必须**先重建 `lib/`** 再看语义类断言：本轮第一条"留空也走 expand"的注入第一次跑是**全绿**，
因为冒烟的端到端用例导入的是 `lib/`（`docs/gitea-workflow.md` §3 那条坑，实测撞上过一次）。
补上 `tsc && node build.mjs` 之后才如预期变红。文本类断言（读 `src/`）不受影响，所以那五项当场就红了。

### 真 GUI 面（沙箱 web 实例 + Playwright，`docs/real-session-harness.md` §7 的配方）

拿到的是 DOM 与盘上读数，不是推断：

- 两个字段在真实插件详情页渲染成
  `<textarea id="sgc-field-suggestionPrompt" rows="5" class="sgc-input sgc-textarea">` 与 `…completionPrompt`
  （`document.querySelectorAll('textarea')` 实测只返回这两个）。
- 从卡片写入 ⇒ 值落到 `cordis.patch.yml` 该条目的 `config` 里（`grep -n suggestionPrompt` 命中），
  **并且重启后仍在**：写 `重启存活验证 RESTART-PROBE` → kill + `--deploy` 重启 → 卡片回显该值、盘上仍在。
- 一次**无关字段**的写入（改 `maxRecentTurns`）与一次**宿主自己的** `_hot` 回写
  （留痕 `hot push landed via deferred pump`）都没有把 `suggestionPrompt` 从补丁里挤掉。
- 超长护栏在界面上成立：填 6001 字 ⇒ 保存按钮 `disabled=true`、`aria-invalid=true`、
  状态行「提示词最长 6000 字，当前 6001 字，请精简后再保存」。

**这一面当时没拿到的那条，已在盒子上补掉**（见下面的 §7.1）—— 本机沙箱起不了真 agent 回合：
这台部署的 `ui-workspace` 条目停用，composer 恒 `data-phase="inert"`，工作区选择器不弹
（`[role=dialog]` 计数 0），手工往 `storages/workspace.json` 种一行也没让它进店，
所以沙箱日志 `grep -c "suggestion generated"` = 0。

### 7.1 盒子（Simular 云电脑）上的真回合 A/B —— 这条腿的实际出处

本机拿不到的东西盒子有：**能选工作区、能跑真回合、有可用路由**的完整实例。

| 前置 | 读数 |
|---|---|
| 内核 | `0.2.2-rc.1`（`~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh`） |
| 插件 | 装的是 **`dsh-suggest-ghost@0.12.0-alpha.1`**（本支产物发 npm 的 test 版，dist-tag `pr183`） |
| profile | `testbox`，条目 `suggest-ghost` 在册，路由 `dsh-opendesign-go / deepseek-v4.1-flash-eco` |
| 工作区 | `/home/user`，71 个既有会话 ⇒ composer 可 attach |

**代码怎么上去的**：本机沙箱端口盒子够不到、LAN Gitea 对盒子不可达（`Network is unreachable`）、
把 141 KB 产物切块经工具面搬运不成立（`read` 把超长行截到 2000 字符），
而**推 GitHub 镜像是本仓明令禁止的**。最终走 npm：在临时副本里把 `version` 改成
`0.12.0-alpha.1`（**不改仓里的 package.json** —— version 由 lead 落），
`npm publish --tag pr183`（**不动 `alpha` / `latest`**），盒子 `npm pack` 后整包替换。
⇒ 测的是这条分支的确切字节，不是手改的旧产物。

**A/B 两步（都是真回合、真 `SettingsForms` 写入、真模型输出）**：

| 步 | 盘上 `suggestionPrompt` | 留痕行尾 | 模型产出的幽灵建议 |
|---|---|---|---|
| 实验组 | `输出必须以下列标记开头：BOXPROBE- …语言 {{language}}，最多 {{maxChars}} 字。` | `prompt=custom` | `BOXPROBE- 请用一句话解释递归：递归是函数直接或间接调用自身…` |
| 对照组 | `""`（从设置页清空并保存） | `prompt=builtin` | `举个例子说明一下`（DOM 全文搜 `BOXPROBE` ⇒ `probeHits=0`） |

判据是**可证伪的**：`BOXPROBE-` 这个前缀内置模板绝不会产出，它只随自定义提示词出现、
清空即消失。另外续写那行的 `prompt=builtin` 也在真实回合里出现过一次
（`completion generated … draftChars=24 chars=18 … prompt=builtin`），
所以四条产出行里的两条都有真宿主读数。

**测完的恢复**：插件目录换回 `0.11.1-alpha.1`（替换前整目录留了 `.bak`，事后回滚并核对版本）、
profile 里两行探针配置删除（`grep -c 'Prompt:'` = 0）、实例停掉（`pgrep` = 0）、
含 token 的 `/tmp/box-dsh.log` 与全部临时目录清掉。

**仍未覆盖的**（写清楚，不含糊）：
- 盒子上**没验**「改完不重启、下一回合立刻换词」—— 那两步之间各重启了一次实例；
  热读不重启由 §7 的真回合 e2e 覆盖（同一进程内写完直接跑下一回合，断的是 `options.system`），
  但那个 e2e 用的是内存 settings 面，不是内核会写盘的 `SettingsForms`。两条各证一半，别合成一条"全验了"。
- 盒子 GUI 上「从设置页写 `completionPrompt`」这一发**没落盘**（脚本点到了保存、回读是空、
  宿主日志零活动）—— 现象在 `suggestionPrompt` 上不存在（同一卡片、同一段代码写成功过）。
  未归因，形态更像我的驱动脚本在详情页重渲染后拿到了脱离的 DOM 节点，而不是产品缺陷；
  但既然没归因，就不写成"卡片写续提示词已验证"。
## 8. 顺手核到的两条内核事实（写下来防止下一个人重新猜）

1. **volatile 字段会写进 profile 补丁**。`src/settings.ts` 顶部那句「内核写盘时把它们从 profile
   文档里剔除，只活在 Loader 条目的内存 config 里」与本机 0.2.x 实测不符：设置页写一次，
   `cordis.patch.yml` 里就多一行，重启后还在。代码面也对得上：`dsh-settings/lib/index.js` 的
   `write()` 走 `configEditor.edit(entry, () => mergeLayers(strip(raw, form), next))`，`next` 里
   就带着这些 volatile 值；而 `dsh-config-editor` 整个包 `grep volatile` = 0 命中，它不做二次剔除。
   ⇒ 对本功能的含义：**一条最长 6000 字的自定义提示词会原样进用户手改的补丁文件**。
   这是既有 32 项共同的语义、不是本支新引入的，但提示词是这一列里第一条"长文本"，
   所以要单独在 PR 的遗留风险里点出来，由 lead 决定是否在 README 加一句提醒。
2. **`live settings refreshed` 不适合当"改没改到"的证据**。`live-settings.ts` 只在 `applied`
   变化时打这一行，而 `describe()` 的 `row.value` 投影的是**全部** volatile 字段（不是"用户改过的那些"）
   ⇒ `applied` 从 boot 起就是常数 ⇒ 沙箱里 `grep -c "live settings refreshed"` = 0，
   **这不表示热读没发生**。本轮差点把它当故障方向；按 §6 的口径改用"会随事件变化的量"
   （`options.system` 的实际内容、`prompt=` 读数）才对上。


## 9. 这个功能讨论出来的后续（都不在本支，登记在此防止重新推一遍）

| 项 | 状态 | 关键约束 |
|---|---|---|
| 续写上下文被裸魔数 `Math.min(maxTranscriptChars, 2000)` 绑住，设置页「转录字符预算」对续写完全无效 | **已开工单 Gitea #190**（含实测表：预算 12000/50000/200000 三档，续写侧恒 1488 字符 / 3 条） | 修法必须钉"默认配置下续写请求的上下文逐字节等于今天" |
| 「查看这次请求」只读视图（覆盖 §5.1 修订） | 未开工单 | 取文走已鉴权 remote service；不碰那条不经鉴权的目录路由；不碰 volatile 载体 |
| shown / accept / hide 三率留痕（本功能的配套缺口：现在能改提示词，但没有"改好了还是改坏了"的读数） | 未开工单，设计已讨论 | **桶键必须硬顶 2（当前 + 上一个）**；`provider`/`model`/`sessionId`/日期禁止进桶键；flush 队列照 `hotness-store.ts:248` 那道 dirty cap 的范本（超限丢最旧 + warn 留痕 + `clears`/`droppedTotal` 计数）；通道不可用时面板必须显式写"未计数"，绝不显示 0% |
| `avoidBlock` 死参数（§6） | 未开工单，冒烟里钉成"修它时必红" | 与上面任何一项都不同支，防互相掩盖 |
