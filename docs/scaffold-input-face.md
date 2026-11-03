# 起稿输入面：宿主向插件暴露不暴露 cwd / 工作区标识（#124 的准入判据）

> 范围：只回答一个问题——**插件运行时能不能拿到"这个会话属于哪个项目"的先验输入**。
> 不改代码，不实现修法。结论供 #124（空草稿起稿建议）的 P1 实现准入用。
>
> 取证口径：**实测** = 只读读取 `~/dsh-versions/<代次>/node_modules/@deepseek-ai/*` 的
> dist/d.ts 产物 + `~/.dsh/sessions/**` 盘上日志头部的读数（全程未起沙箱、未起实例、未写
> 任何用户数据）；**依据** = 文件:行号，逐条可复核；**推测** = 逻辑推断但没有直接读数支撑，
> 逐条标注。
> ⚠️ 跨代次 grep 一律 `grep -R`（**跟软链**）：各树 `@deepseek-ai/*` 有的指向 `.pnpm`
> store 软链（0.1.5-rc.3 实测如此，`readlink` 出 `../.pnpm/@deepseek-ai+dsh-session@0.1.5-rc.3_…`）、
> 有的是真目录（0.1.7-rc.2 实测），`grep -r` 不跟软链会把整棵树数成 0 命中（lead 实测踩过，
> 本轮 0.1.5-rc.3 复现确认）。下列全部证据行的量具都是 `grep -R`。
>
> 被测代次（`dsh-session` 包版本与各树逐一对号，`require(…/package.json).version` 实测）：
> 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.2-alpha.2，
> 七棵树全在场。

---

## 结论（准入判定：**CONDITIONAL**）

**插件运行时拿得到项目标识，唯一通道是 `session.header.cwd`，且七个代次形状一致。**
条件是：**它是可选字段**（`cwd?: string`），宿主建会话时**有 cwd 才填**；拿不到时的
回退输入只有"无项目先验"，**没有**合规的替代来源（宿主私有布局不算，见 §4 与本节第 3 条）。

对 #124 P1 的三条直接约束：

1. **GO 的部分**：起稿提示词可以放项目先验——`ctx.sessions.get(id)?.header?.cwd` 或事件
   回调里的 `session.header.cwd`，七代次可达链逐处钉死（下表）。P0 量度（见 #124 评论
   id=45539）测出按工作区分表能把 top-1 从 4.0% 抬到 7.1%，这条抬升的输入现在有来源了。
2. **必须处理的部分**：字段类型 `string | undefined`。实现必须写
   `header.cwd ?? <无先验分支>`，**不许**假设恒有值——类型是可选的、填充分支是条件的
   （`cwd === void 0 ? {} : { cwd }`），某条建会话路径不带 cwd 时字段**静默缺席**，
   tsc 不会报，运行时才现形。
3. **不许做的部分**：cwd 缺席时**不许**去读 `~/.dsh/storages/workspace.json` 或
   `session_projcache.json` 之类的宿主私有布局补数据。插件声明域只有自己的 storage 域
   （`suggest_ghost_*`），读宿主布局 = 把兼容性建在未承诺的结构上（`docs/gitea-workflow.md`
   §9「没验到的不得写成通过」同族判据）。`session/title` 是 LLM 语义生成的标题，
   与项目目录无稳定对应关系，**不构成**回退输入。

**运行时可达性的实测边界**（诚实声明）：本机盘上会话日志头 `cwd` 在 v3 格式时代
813/813、v4 格式时代 1600/1600 全部有值（见 §3）——这证明**本机跑过的两个宿主时代**的
真实建会话路径都填了 cwd，但这是「填了」的证据，不是「恒填」的证据：折叠逻辑本身就是
条件式的，没填的形态在本机数据里不存在、无法用数据证否。判定 CONDITIONAL 正是为这种情况。

---

## 1. 可达链逐代次核对（三处全同构）

判据拆成三段，缺一不可：**类型里有 → 服务面给得到 → 事件里送得过来**。

| # | 判据 | 七代次一致性（行号顺序 = 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.2-alpha.2，均 `grep -R`） |
|---|---|---|
| A | `SessionHeader.cwd?: string` 在面向插件的 d.ts | `dsh-session/lib/types/types.d.ts` 行 71 / 69 / 69 / 69 / 69 / 70 / 70，声明逐字同：`readonly cwd?: string;`（注释也是逐字同：`Absolute working directory the session was created in (if any).`） |
| B | `Session` class 公开 `header` | `dsh-session/lib/types/index.d.ts` 行 118 / 117 / 118 / 119 / 119 / 150 / 154：`readonly header: SessionHeader;` |
| C | `ctx.sessions: SessionStore` 服务声明 + `get(id): Session \| undefined` | `sessions: SessionStore;` 行 28 / 26 / 27 / 28 / 28 / 28 / 28；`get` 签名行 414 / 419 / 436 / 447 / 447 / 491 / 502 |
| D | 事件回调参数就是 Session 实例 | `index.d.ts`：`'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent)` 行 64 / 62 / 63 / 64 / 64 / 61 / 63 ⇒ `ctx.on('session/event', (session) => session.header.cwd)` 这条路不经过 `get(id)` 也通 |

> 归属说明（判据 1 的"来源是 session 快照 / ctx.get / 事件载荷"三选）：**三条都是同一条**
> ——宿主 store 里的那个 `Session` 实例本体。没有"脱敏投影"版本：`dsh-api-session-controller`
> 的 list/manager 面是 GUI 远端（客户端）的，不是插件的；插件面只有 `ctx.sessions` 一条。

## 2. 宿主填充链（判据 ③：类型有 ≠ 有值）

`cwd` 进 header 的完整链，逐代次实读：

```
config.agents[].cwd（或 GUI 建会话的 opts.cwd）
  → dsh-agent-loop: const meta = cwd === void 0 ? {} : { cwd };   // 有 cwd 才造 meta
  → this.create(id, options, meta) → ctx.sessions.prepare(id, { meta })
  → dsh-session 折叠: ...meta?.cwd === undefined ? {} : { cwd: meta.cwd }   // 有 meta.cwd 才进 header
  → session.header.cwd
```

| 环节 | 行号（同序七代次，均 `grep -R`） |
|---|---|
| agent-loop meta 构造（`dsh-agent-loop/lib/index.js`） | 1097 / 1538 / 1527 / 1553 / 1568 / 1594 / 1348 |
| dsh-session meta→header 折叠（`dsh-session/lib/types/index.js`） | 783 / 817 / 849 / 865 / 865 / 981 / 998 |
| GUI/web 路径（`dsh-api-session-controller/lib/types/client/sessions/manager.js`，`opts.cwd` 透传） | 0.1.2-rc.1:463/468 · 0.2.0-rc.2:426/431 · 0.2.2-alpha.2:450/455（逐代次 `grep -Rn cwd` 命中数 7/7/6/6/6/6/6，形状一致） |

**老五代次（≤0.2.0-rc.2）宿主自己就在消费 `session.header.cwd`**——systemPrompt 有
`ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)`
（`dsh-agent-loop/lib/index.js` 行 1095 / 1536 / 1525 / 1551 / 1566，`grep -R`）。
这条比任何日志读数都硬：**内核自己的提示词模板读的就是这个字段，值必须是运行时真在的**。

## 2b. 0.2.1+ 不再把 cwd 注入 systemPrompt ≠ 字段没了（防一整轮误读）

0.2.1-rc.2 / 0.2.2-alpha.2 里这条 `variable("cwd")` **搬家了**：agent-loop 与 system-prompt 两包
`grep -R`（跟软链）均不再命中。⚠️ **推测标注**：注入新址没钉到（不在这两包里）；这对准入无影响——
插件通道是 `header.cwd` 本身，不依赖 prompt 消费形态。

但 `header.cwd` 在 0.2.1+ **仍是活字段**：`grep -Rl "header\.cwd" --include='*.js'`（跟软链）在
两棵树的后端包里各命中 8+ 个消费者（`dsh-session/lib`、`dsh-session-log-export`、
`dsh-session-projection-cache`、`dsh-session-query`、`dsh-session-persistence-jsonl`、
`dsh-session-reference`…），且 `dsh-session-reference/lib/typert.host.js:16` 仍写着

```js
'cwd': z.string().optional().describe('Source session working directory, when recorded.'),
```

⇒ 给 #124 实现人的警示：**别从"新代次 prompt 不注入 cwd"推断"字段没了"**——那是内核自己怎么
消费 cwd，不是插件能不能读 cwd。两代次证据的关系是反的：老五代次靠"内核 systemPrompt 在用它"
反向坐实运行时真值；新两代次靠 persistence/reference 消费者 + §3 的盘上读数坐实。

## 3. 运行时填充率（真实盘上数据，只读，零正文外泄）

会话日志头是宿主折叠后的**产物**，读它 = 读"运行时到底填没填"：

| 日志格式（宿主写入时代） | 会话数 | header.cwd 有值 | 创建时间跨度 |
|---|---|---|---|
| v3（老格式，0.1.x 时代落盘） | 813 | **813（100%）** | 2026-08-24 → 2026-09-28 |
| v4（现格式） | 1600 | **1600（100%）** | 2026-09-05 → 2026-11-03 |

量具：只读 `zstd -dc` 每个会话目录的第一行，检查 `typeof header.cwd === 'string'`，
**不读取/不记录 cwd 的值本身**。v3/v4 是两套宿主写入格式（`dsh-session` 的
`SESSION_FORMAT_VERSION` 现行=4，v3 头部来自其前一代内核时代），两段跨度都有真实数据
⇒ 至少覆盖本机实际跑过的两个宿主时代；不能外推到任意代次的任意建会话路径（见结论的诚实声明）。

## 4. 不存在的东西（负结论也要逐代次钉）

- **workspace id / 工作区标题字段：不存在。** 插件可达面（`dsh-session` 的 types d.ts +
  `dsh-session-projection`）`grep -Rn "workspace\|Workspace"` 三代抽样（0.1.2-rc.1 /
  0.2.0-rc.2 / 0.2.2-alpha.2）均 **0 命中**。宿主 GUI 侧确有 `dsh-client-ui-workspace` /
  `dsh-api-workspace-files` 等包（`ls` 实见），但那是**浏览器侧的远端 API 面**，
  不是插件的 `ctx`；插件声明域拿不到它们。⇒ 「工作区标识」的唯一可得形态就是 `header.cwd`
  （目录名/项目名可由 cwd 派生 `basename`，热表按 cwd 分桶即 P0 里那个"分表"形态）。
- **`request/context` 事件载荷里没有 cwd**（`RequestContext` 声明面只有
  provider/model/contextWindow/systemPromptUpdate，0.2.2-alpha.2 实读）⇒ 事件载荷这条路
  不成立，成立的是回调第二参数 `session: Session`。
- **`session/title` 存在但不构成回退**：`dsh-session-title` 包七代全在场（require 版本号
  逐一对号），title 事件可订；但标题是模型生成的语义摘要，与项目目录无承诺的对应关系。

## 5. `header.cwd` 入模的先例核验（本仓第一次主动送路径）

lead 补问：起稿若把 `cwd` 放进提示词，是否开了"把用户本机路径送进辅助调用"的先例。核两件事：

**① 现有两条生成路径（建议 + 续写）都没有结构化路径字段入模——无先例。** 入模内容面逐处实读：

| 面 | 送什么 | 出处 |
|---|---|---|
| 转录 | 仅 `{role, text}` 对，text = 消息原文过 `redactSecrets`；会话元数据不进 | `src/generate.ts:601`（`buildTranscript` 的 `allPairs.push`） |
| 续写草稿 | `redactSecrets(draft)` 拼进 userText | `src/generate.ts:1003` |
| 系统模板 | `inlinePrompt(inlineMaxChars, language)` 只带预算与语言参数，无路径占位符 | `src/generate.ts:998` |
| `sessionId` | 出现在 `GenerateOptions`（`src/generate.ts:868`、`1024`）——内核调用的关联元数据面，**不是 prompt 文本**；且 id ≠ 路径，不构成先例 | 同上两行 |
| `redactSecrets` 覆盖面 | 8 条全在挡密钥类（AWS/OpenAI/GitHub/Slack/Stripe/JWT/private-key/Bearer，`src/sanitize.ts:46-54`）+ 控制字符/ANSI 转义（`src/sanitize.ts:67-68`）；**没有任何路径脱敏逻辑** | 实读 |

**但"路径进过模型"以另一形态早已发生**：用户在消息正文里打的绝对路径（"看下
`/home/…/x.ts` 的报错"）随转录原样入模——`redactSecrets` 不挡它。⇒ 准确的说法是：
起稿送 cwd 不是"第一次有路径进模型"，是**第一次把路径从『用户恰好写到』变成『每个新会话必送』**
——暴露从偶发升为必然，且送的是**未经用户输入动作确认**的机器状态。

**② 文案与设置项怎么算不算「悄悄多送一样东西」（结论，一句）：**
默认关（工单已定）之外，开关文案必须**点名"项目文件夹路径"这个粒度**，不许停在
"会话相关信息"这种兜底话术——因为 `redactSecrets` 挡不住路径，用户无法指望既有脱敏
帮他挡这一项。两个可选形态的文案义务不同：
- **送完整 cwd**（先验最强，P0 分表收益的来源）：文案需写明含用户名层级的本机路径会发给
  模型、且每次新会话触发；这比"其他会话的高频首句"更敏感（首句至少是用户自己打的字）。
- **送 `basename(cwd)`**（只露项目目录名）：暴露面降一档，文案写"项目文件夹名"；
  P0 的 7.1% 分表收益只依赖"会话同属一桶"这个判据，**不依赖模型看见路径本身**——
  宿主侧分表、模型侧只见桶内 opener 候选，是暴露最小的合法形态（推测标注：该形态的
  命中率等价性成立的前提是分桶打分与全局分表同构，P0 脚本已按此实现，未见反例）。
- 文案闸口径（`scripts/settings-copy-smoke.mjs`）：zh ≤130 字、禁实现词（"宿主""落盘"）、
  禁 issue 号——上面两条任选其一重写为用户语言，示例走向：
  「开启后，新会话的空草稿会参考你在其他项目里常用的开头，并把当前项目文件夹名用于匹配。
  默认关闭。」（basename 形态；完整 cwd 形态则须直说"文件夹完整路径"。）

## 6. 对 #124 起稿的约束（本文件的落地段）

1. 起稿提示词的项目先验输入 = `session.header.cwd`（宿主侧取，P0 取证已确认客户端手里
   没有本地对话文本、打分必须落宿主侧，cwd 同样只有宿主侧可得）。
2. 代码形态必须是 `const project = session.header.cwd;`（`string | undefined`），
   undefined 分支走"无项目先验"提示词——**这是 CONDITIONAL 的"条件"本体**，
   写实现的人不许把它当死物。
3. 若 #124 P1 之外还想给"同项目历史"更强的先验（P0 数字：分表 7.1% vs 全局 4.0%），
   合法来源只有：本插件自己的 storage 域里按 cwd 分桶的聚合（新增持久化要过 #88 那条
   容量上限讨论），**不是**读宿主布局文件。
4. 代次声明面零风险：`header`/`get`/事件参数三处七代同构（§1 表），本仓 peer 范围内
   不存在"某一代拿不到"的分裂 ⇒ 不需要任何代次分支代码。
5. **路径暴露义务（§5）**：现两条生成路径无"主动送会话元数据入模"先例，`redactSecrets`
   不挡路径 ⇒ 起稿若送完整 `cwd` 是暴露升格（偶发→必送），开关文案必须点名"文件夹路径"
   粒度；**优先形态**是宿主侧按 cwd 分桶打分、模型只见桶内候选（文案只写"项目文件夹名"，
   完整路径不进模型）。这条进 #124 的隐私文案清单，与工单既有"其他会话高频首句"义务并列。

## 7. 复核命令（都能本机重跑）

```bash
# 可达链（任一树，示例 0.1.5-rc.3 —— 软链树，必须用 -R）
grep -Rn "readonly cwd?: string" ~/dsh-versions/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
grep -Rn "readonly header: SessionHeader" ~/dsh-versions/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts
grep -Rn "meta?.cwd === undefined" ~/dsh-versions/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-session/lib/types/index.js
grep -Rn "const meta = cwd === void 0" ~/dsh-versions/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js
# 运行时填充率：见 §3 量具描述（读日志头 cwd 是否存在，不读值）
```
