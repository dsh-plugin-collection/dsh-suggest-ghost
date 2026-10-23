# pull 应答的可对账性：阶梯为什么跑满，以及最小契约改动

> 范围：只回答「客户端 pull 退避阶梯为什么必然跑满 5 条」这一条线上现象的成因与契约结论。
> 不改代码，不实现修法。
>
> 取证口径：**实测** = `node scripts/pull-ack-smoke.mjs` 的输出（本仓产物 `lib/index.js`，
> 核对于 commit `6402dbd`，2026-10-23 15:33 实跑，22 组断言全绿）或现场盘上文件/日志的读数；
> **依据** = 文件:行号；**推测** = 逻辑推断但没有直接读数支撑，逐条标注。
> 本仓 `src/` 与 `lib/` 在本轮调查中同时被改动过（#89 于 15:09 合入），所以**所有行号都是 6402dbd 上的**。
>
> 非目标：HMR 事务内写被拒导致的补写延迟（那是另一条上游，见 CHANGELOG 2026-10-23 的两条
> 「没动的三条」说明）；热度表恢复失败的修复本身（#88/#89）。

## 结论

1. **第一个 pull 的应答带不带 `history`，取决于 `ctx.sessions.get` 能否解析该会话。**
   能解析 ⇒ 带数组（实测：场景 A，`history=array(2)`、`historySessionId=session-ack-known`）；
   解析不到 ⇒ `history` 与 `historySessionId` **两个键一起消失**（实测：场景 B，落地载荷的键只有
   `rev,hot,total`）。而客户端停止阶梯的唯一判据要求 `history` 是数组（依据：
   `src/client/index.ts:2100-2105`、`src/client/index.ts:1936-1939`），所以 B 形态的应答
   **在协议上不可能被确认**，阶梯必然跑满（实测：场景 B3）。
2. **一个阶梯里后 4 条 pull 零写 = 按格判重。** 实测：场景 C 的五次 pull 应答写笔数是
   `1,0,0,0,0`，而同一轮 `_ops` 被注入 5 次、清空 5 次 ⇒ 消费一直在跑，只是不写
   （依据：`src/index.ts:1780-1795`，`hotDirty`/`pushDirty` 任一格不变就不发那格）。
3. **问题 2 的答案：会。** 空环会话（能解析、环为 `[]`）的 `historyKey` 同样折进 `'∅'`
   （依据：`src/index.ts:1400-1403`，判据里带 `o.history.length === 0`）。实测：场景 E，
   `LA` 首次 pull 写 1 笔、切到 `LB` 首次 pull 写 **0** 笔。
   但 E 与 B 是**两条独立的失效层**：E 落地的载荷本身带着 `history: []` 和 `historySessionId`，
   也就是说这份应答**足以**让客户端收敛，被吞掉的只是那一次**写**（实测：场景 E1 与 E2 分别成立）；
   B 的载荷里连凭证都没有，就算写十次也不收敛。
4. **还有第三条独立成因，本轮实测才看见：#89 的 `hotUsable` 闸门。**
   热表恢复在飞行中时整格 `_hot` 不许说话（依据：`src/index.ts:1789-1794`），而 pull 应答的
   `history` 恰好住在这格 ⇒ **会话可解析、环非空也拿不到可确认的应答**。
   实测：场景 F，窗口内 `_hot` 写 0 笔、`hot push withheld` 留痕 1 行、落地那一笔只有建议格；
   恢复终局之后再 pull 才写出 `history=array(1)`。
   现场对照：15:09 那份日志里 `hotness domain busy, retrying attempt=1/10/20/30` 紧跟
   `hotness restore FAILED`（重试预算 40×150ms ≈ 6s，实测读数），而客户端阶梯的时间轴是
   0 / 0.6 / 1.8 / 4.2 / 9.0s（依据：`src/client/index.ts:347`、`:358`、`:1953`）
   ⇒ 前四次尝试可以整条落在窗口里。**推测**：这条是 15:09 之后新进程才会撞上的形态，
   任务书里那份 665 行日志（15:09 前的产物）不含它。

## 一、脚本与夹具口径

`scripts/pull-ack-smoke.mjs`：假 ctx（`Context` + 真 `SessionStore`）+ 假 settings 服务
（`describe()/update()` 形状照 `scripts/payload-split-smoke.mjs:84-101`），直接驱动 `lib/index.js`
的 `apply()`，喂 `_ops` 里的 `pull` op，读落地的 `_hot`/`_push` 载荷。四条口径值得写清：

- **一个场景一个进程。** `lastHotFingerprint`、`pushRev`、`historyRings` 都是 `apply()` 闭包态，
  共用进程会让后一个场景继承前一个场景的指纹，测出的「零写」就不是被测机制了。
- **回合必须在 `apply()` 之前补。** 之后补的事件会走 `handleTurnEnd → pushToClient`
  （依据：入口 `src/index.ts:2649`，推送 `src/index.ts:2714-2721`），于是「第一次 pull」读到的是已被写过的那一格。
  这条夹具坑本轮真踩了一次：A0 假红成「第一次 pull 写了 0 笔」。
- **夹具不造 HMR 事务**，所以每一笔写都写得进盘。这是对收敛**最有利**的介质：
  在这种介质下阶梯仍然不收敛，才能把责任判给契约而不是补写泵。
- **两份判据镜像**（`clientReconciles()` 与 `hotSigMirror()`）只用来把机制说成可核对的数，
  结论仍由行为断言（写了几笔、落了几格、载荷有哪些键）给出。镜像与源码同形由 G1/G2 静态守卫钉住。

实测输出（22 组全绿，留痕 70 行）：

| 场景 | 关键数字 | 判定 |
| --- | --- | --- |
| A 会话可解析且有用户消息 | 应答写 1 笔，`history=array(2)`，`historySessionId=session-ack-known`，客户端判据成立 | 通过 |
| B 会话解析不到 | 应答写 1 笔，载荷键只有 `rev,hot,total`，`history` 缺席，客户端判据不成立 | 通过 |
| C 同一未知会话连 pull 5 次 | 应答写 `1,0,0,0,0`；`_hot` 总写 1 笔、`_push` 总写 1 笔；`_ops` 注入 5 次清空 5 次 | 通过 |
| D 两个未知会话交替 | 各自新进程首次都写 1 笔；同进程 `U1`=1 → `U2`=0 → `U1`=0；两份指纹逐字相同 `<HOT>∅<T>0<HIST>∅` | 通过 |
| E 两个可解析但空环的会话 | `LA` 首次写 1 笔且带 `history=[]` + `historySessionId=LA`；`LB` 首次写 0 笔 | 通过 |
| F 热表恢复窗口内 pull 可解析会话 | 窗口内 `_hot` 写 0 笔 + `hot push withheld` 1 行；恢复后写 1 笔且 `history=array(1)` | 通过 |

## 二、问题 4：真实宿主里 `ctx.sessions.get()` 能不能解析侧栏会话

**答案：不能，除非该会话此刻正被某个 agent 生命周期持有。** 逐条依据（宿主运行时
`@deepseek-ai/dsh-session@0.2.1-rc.2` 等，取自本次运行的检出
`/home/wujue/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`；插件 devDependencies 写的是
0.2.0-rc.2，行号按运行时这份核）：

- `ctx.sessions` 是**纯内存**的活会话表：`dsh-session/lib/index.js:1708-1715`
  （类注释「In-memory session store (`ctx.sessions)`… Persistence is intentionally not
  implemented here」，`store = new Map()`）。
- `get()` 只查这张表：`dsh-session/lib/index.js:1979-1982`
  （`get(id) { return this.store.get(id)?.session; }`）。表里没有就是 `undefined`，**不会**回退到磁盘。
- 只有 `enter()` 会入表：`dsh-session/lib/index.js:1854-1872`；agent 发布时调用它
  （`dsh-agent-loop/lib/index.js:1790`），agent 析构时配套的 `detachSession?.()`
  （`dsh-agent-loop/lib/index.js:1732`）经 `detachEntered()` 把它删掉
  （`dsh-session/lib/index.js:1887-1892`）。⇒ **入表/出表完全跟着 agent 生命周期走**。
- 读路径**不**入表：`prepare()` 明确返回「NOT yet in the store」
  （`dsh-session/lib/index.js:1795-1823`）；冷读优先取活的、取不到就 `prepare()` 一个 detached 会话
  （`dsh-session-query/lib/index.js:351-356`、`:369-375`）；侧栏/详情用的
  `inspect()` 与 `readSessionState()` 文档就是「**without activating its Agent**」
  （`dsh-api-session-controller/lib/index.js:3040-3055`、`:1087-1099`）。
  只有发消息/接管那种路径才 `resume()` 出 agent（`dsh-api-session-controller/lib/index.js:370-404`）。
- 这张表是全进程一张（`super(ctx, "sessions")`，`dsh-session/lib/index.js:1739`），
  不按 workspace 分。⇒ 「多 workspace 侧栏会话」不是「另一个 store 所以查不到」，
  而是「**没被 enter 过所以查不到**」。

现场旁证（实测于 2026-10-23 15:35 的 `~/.dsh/dsh-web.log` 快照，当时 1620 行、417 行 pull、
24 个被 pull 的会话；这份文件在被运行中的宿主持续追加，读数只对那一刻负责）：

- 8 个会话（64 / 417 行 pull，占 15%）在本进程内**没有任何**正面活证据
  （`suggestion generated` / `completion generated` 计数为 0），其中包括三个 `webhook-*` 会话，
  它们的日志目录分别属于 `--home-wujue-workspace-apbot-broadcast--` 等别的 workspace。
  这两类留痕都要求 `ctx.sessions.get` 命中才会出现：续写入口先解析会话
  （依据：`src/index.ts:1196-1198`），建议生成由 `session/event` 驱动（依据：`src/index.ts:2649`）。
  ⇒ 这 15% 与「会话未进店」一致。
- 会话 `session-cfdcef58`（16 行 pull）的日志里 `user/message` 事件数实测为 **0**
  ⇒ 它同时是空环形态（E）的现场实例。
- 但另外 16 个会话（353 / 417 行，85%）**有**活证据（同一进程内出现过 `suggestion generated` /
  `completion generated`）。**这条不能反过来证明它们在 pull 那一刻也是活的**：
  入表/出表跟着 agent 生命周期，回合结束留痕与页面打开时的 pull 不在同一时刻。
- 一条**不能当证据**的留痕，写在这里防下个读日志的人踩：
  `persisted push deferred source=pull reason=session-unavailable` 打的是
  **盘上残留建议自己的** `sessionId`，不是被 pull 那个会话的
  （依据：`src/index.ts:1058` 的 `sessionExists: (id) => ctx.sessions.get(id)`，
  留痕取数在 `src/index.ts:1109`）。现场那一行是裸 uuid `a7bcae96-…`，而本机同时存在
  带前缀（`session-*`）与不带前缀（`4516c0c8-*`、`5dd94aee-*`、`a7bcae96-*`）两种会话 id
  （实测：`find ~/.dsh/sessions -name '*<id>*'`），所以那行只说明「按那个字符串查不到」，
  **不能**说明「被 pull 的那个会话查不到」。

**主因判定：B 与 D 都成立，且互不蕴含，没有一条能替另一条解释现场。**

- D（含同一机制的 E）是「换会话后永远收不到应答」的必要解释：实测 D3/E2，
  跨会话同指纹 ⇒ 一次写都不发。这条**不依赖**会话能否解析。
- B 是「应答明明落地了，客户端还是不认」的必要解释：实测 B2/B3。这条**不依赖**判重。
- 占比无法从现有留痕判定（**实测缺口**，不是推测）：`hot push landed … bytes=` 只给整格字节数，
  不给「这一格当时带没带 history」。要把 B / D / F 的占比量出来，需要留痕补一个字段（见「待办」第 1 条）。

## 三、问题 3：最小契约改动

候选与代价，逐条对着实测结果说。「能修哪几条」这一列全部来自变异自证表（下一节），不是推理。

| 候选 | 动几处 | 能修 | 修不了 | 代价 |
| --- | --- | --- | --- | --- |
| (a) 应答带显式 ack 身份，且 pull 应答绕过按格判重 | 三处：`buildHotPayload`（`src/index.ts:1439-1445`）、`hotSigOf`（`src/index.ts:1400-1403`）、`retryPendingPull`（`src/client/index.ts:1936-1939`） | B、D、E（F 要再加下面说的第三半） | 本轮没测出 (a) 之外的剩余形态 | 每轮 pull 至少一笔写，哪怕内容没变；现场 `writeMs` 实测 291~4200ms（n=278）⇒ 写放大必须配节流或上限 |
| (b) 会话解析不到时把 `history` 写成 `[]` | 一处（`ringFor` 或 `statePushOf`） | 只有 B | D、E、F 都修不了（实测 M2：D3 不红） | 客户端会把**本地**历史清成空数组（依据：`src/client/index.ts:2100-2102` 直接取 `hotSource.history`），把「切回会话仍有历史」的体验一起清掉；F 的窗口里那一格根本不会被写，所以这条对 F 完全无效 |
| (c) 只改客户端判据（收到任何指向该会话的载荷就算对账） | 一处（客户端） | 严格形态下什么都修不了 | D/E 是「根本没有写」：客户端等的是 `document-updated` 事件，没有写就没有对账机会（实测：C2 的 `1,0,0,0,0`）。B 的载荷里没有任何会话身份（实测：B2 的键只有 `rev,hot,total`），「指向该会话」无从判断 | 若放宽成「收到任何载荷就算对账」，那是把别的会话的载荷认成本会话的凭证：`_hot` 是全进程共享的一格 volatile 字段（依据：`src/index.ts:270`），载荷里除 `history` 那对键之外没有会话归属（依据：`src/index.ts:1439-1445`）⇒ 历史环与热度会被读成别的会话的，属于用错数据换安静 |

**推荐 (a)，并且 (a) 的两个半边都不能省。** 依据：M4 单独（只让指纹带上会话身份）只红 E2、
不红 D3，因为未知会话的身份在载荷里根本不存在；M2 单独（只让载荷带身份）只红 B2/B3、
不红 D3；两者叠加 M5 才同时红 B 与 D。也就是说
「**载荷里有身份**」+「**判重认这个身份**」是最小契约的两半，缺一半就还剩一条不收敛的路。
F 需要第三半：ack 不许被 `hotUsable` 扣住（要么 ack 身份与热表解耦成两格，要么 `hotNow`
那条通道显式豁免这个闸门）。

**推测（标注清楚，别当结论）**：把 ack 拆成独立小格（比如 `_ack = {sessionId, rev}`）比
「pull 一律绕开判重写整格 `_hot`」便宜。依据只是本轮量到的相对字节数（实测：
`~/.dsh/dsh-web.log` 的 `hot push landed … bytes=` 分布，15:09 前 2789~4965，15:09 之后
136~2713），而身份字段本身是几十字节量级。
**这条没做过写次数与写耗时的前后对比，不能当已验证结论。**

## 四、变异自证（实测）

做法：把整份 `lib/` 复制到 `/tmp/pull-ack-mut/<名字>/lib`，在**副本**里做单点变异，
`GHOST_PULL_ACK_REPO=<副本目录> node scripts/pull-ack-smoke.mjs` 跑同一份脚本
（`GHOST_*_REPO` 是本仓 payload-split / hot-throttle 已有的换产物口子）。
本仓 `src/`、`lib/` 一字未动（`git status --short` 只有两条未跟踪的新文件）。

| 变异 | 改坏的那一处 | 变红的断言（实测） | 没变红 |
| --- | --- | --- | --- |
| M1 | `statePushOf` 恒 `history: null` | A2 / A3 / A4 / E1 / F3 | C、D（判重与身份无关） |
| M2 | `ringFor` 解析不到时返回 `[]`（= 候选 (b)） | B2 / B3 | **D3 不红**、E2 不红、F 不红 |
| M3 | 去掉按格判重（`pushDirty`/`hotDirty` 恒真） | C2 / D3 / E2 | A、B（写不写与载荷内容无关） |
| M4 | `hotSigOf` 的 `historyKey` 带上归属会话 | E2 | **D3 不红**（未知会话两侧都没有身份可带） |
| M5 | M2 + M4 | B2 / B3 / D3 / E2 | C2 仍绿（同会话同 id ⇒ 同指纹，判重照旧） |
| M6 | `hotUsable` 恒真（#89 闸门失效） | F1 | A、B、C、D、E |

M5 里 C2 仍绿不是漏判：修法生效后第一笔应答就足以让客户端收敛，本来就不该再有第 2..5 次 pull。
C2 钉的是「宿主侧按格判重让重复 pull 零写」这一机制本身，与客户端是否已经满足是两件事。

## 五、待办（本文只出结论，不改代码）

1. **留痕补一个字段**，否则下次还是只能猜：落地应答那行（`push landed` / `hot push landed`）
   现在不报「这一格带没带 history、带的是哪个会话」。加 `hasHistory=0/1` 与 `ackSession=<id>`
   两个键，B / D / E / F 四条路径当场可分（本条属于 #17「不许静默」的同族，不是新需求）。
   ✅ **已落地（同日）**，与本文有两处实现差异，记在这里免得下次照本文找键名找不到：
   ① `hasHistory` 实现成**三态** `1/0/-` 而不是 `0/1`——`-` 表示「这一笔根本不含热度格」
   （`cells=push` 的即时写、以及永远单格的补写那一笔）；布尔会把 `-` 吞成 `0`，于是
   「没带热格」伪装成「带了但没历史」，join 出来的占比当场失真。② 键从**落盘那串字节**上
   正则读（`src/trace-gate.ts` 的 `hotAckFields`），不读闭包变量——留痕要说的是盘上现在
   是什么，不是我本想写什么。占比分析器：`scripts/pull-ack-split.mjs`（统计窗口从第一条
   带键的落地行起算；按整份日志统计会把补键之前的落地行「看不见 ack」误判成 D/E）。
2. **契约改造（推荐 (a) 的两个半边 + F 的第三半）** 落地时，本脚本的 A/B/C/D/E/F 六组断言
   应当逐条转成「改后为绿」的目标态；M2/M4/M5 三行已经给出哪些断言在哪个阶段该翻色。
3. `#89` 的 `hotUsable` 闸门需要与 ack 契约一起想：现在的形态是「热表没恢复 ⇒ 整格闭嘴」，
   而这一格里住着客户端唯一的对账凭证。实测 F1/F2/F3 说明窗口内必然漏掉应答，
   而现场实测的重试预算（40×150ms ≈ 6s）覆盖阶梯前四次尝试的整个跨度（0 到 4.2s）。
4. 客户端读侧还有一条**没验**的候选，列出来免得下次重复发现：`_hot` 落地后仍可能被帧闸门整条丢掉
   （依据：`src/client/index.ts:2070-2076` 的 `if (!frames.accept) { … return; }` 在
   `historySessionId` 赋值**之前**返回）。**本脚本不覆盖它**（宿主侧夹具不跑客户端），
   所以这里只记为未验证，不记为成因。
