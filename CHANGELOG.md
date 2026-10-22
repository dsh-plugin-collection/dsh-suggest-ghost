# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### 新增

- **幽灵文本的「终态帧」契约与客户端判据**（#38 #39）。`_push` 的 suggestion 载荷新增 `frame`
  （number，`>=1`，单次生成内单调）与 `final`（boolean，终帧为 true）；`completion` 本期**不带帧号**、
  只带 `final`。两字段缺省按 `frame=0` / `final=true` 处理，旧载荷行为逐字不变。契约与取舍记在
  #41 的评论里。客户端把这两个字段变成三条能判的判据：
  - **陈旧帧整条作废**：按 `(会话, turn)` 分桶，帧号**严格小于**已见值才丢；相等必须放行（会话切回
    时的对账 `pull` 会把同一份建议原样再推一次，丢掉它就没有建议也没有历史环）。台账独立于文档级
    `rev === lastRevision` 早退（`src/client/index.ts:1502` 那条，载荷自带的 `rev` 客户端从不读），
    两者若共用判据，宿主一次自写就会把终帧判成「没变化」而丢掉
  - **采纳只认终帧**：Tab 整条与 `→` 逐词在 `final === false` 的帧上一字符不写、且**不吞按键**
    （不 `preventDefault`）。显示不归这条判据管：provisional 帧即便显示也只是中间态，**采纳才是
    不可逆动作**
  - **幽灵形态在单次生成内不得翻转**：`alignCompletion` 裁空那一支（`src/client/completion-align.ts:87`）
    原本会让本帧从 `inline` 掉到 `history`，灰色尾巴无声换成另一段不相干的文字。判据用
    `alignCompletion` 自己的归属前缀关系（`draft === payload.draft || draft.startsWith(payload.draft)`）
    当「这次生成仍在场」的证据，不靠草稿逐字相同，因此与 #33 的「边打边等」不打架。取舍是
    `consumed` 时**本帧不显示**而不是回落 history（少一次补全可接受，显错形态不可接受），纯判据、
    无内部状态，六条出口各有断言

- **overlay 的「同一次生成文本增长」快路径**（#38）。`GhostOverlay.show()` 原本每次都
  `textContent = ''` 整棵重建后缀 span，再跑两轮强制同步布局（`align()` 的 `getComputedStyle` +
  `offsetTop/clientWidth` + rect + 约 35 项排版属性复制，`verify()` 的再一次 rect + `querySelector`）。
  快路径条件是「同形态 + 同锚定文本 + 新后缀以旧后缀开头」：锚点未脏时**一次测量都不做**；锚点脏了
  只量一次行尾，位移 ≤ 1px 就不重排，越界才落回全量。实测模型：40 帧流式增长从 **80 次强制同步布局
  降到 0 次**（掺滚动事件时 8 次）。增长期间 `[60,300,900]` 三次错峰补渲染让路（它们的职责只是覆盖
  rebind 时 composer 尚未挂载的竞态，幽灵已在屏幕上时补渲染只是把同一段文本再画一遍）。两条硬约束
  一字未动：先标 `data-shown="1"` 再 `display:block`、必须 `display:block` 才能测量；`verify()` 失败
  即不绘制的语义原样保持

- **客户端留痕的出口补齐**（#39）。三处「判据在跑、输出被摘空」的分支补回留痕槽位：inline armed 的
  `disabled` / `no-session`（`inline-arm-cancel`）、Tab 采纳被草稿 CAS 放弃（`tab-abandon`）、`→` 逐词
  采纳被 CAS 放弃（`word-abandon`）；另加本轮新增的 `stale-frame`、`accept-gate-tab` /
  `accept-gate-word`、`form-hold`。长期只累加不打印的 `renderHits` 有了出口（`render-source`）：两把
  闸——同一理由 500 次到达只出 1 行；归因来源**切换**且距上次打印已累计 50 次 render 才打一行（纯
  计数节流、无计时器，离线可测也不受标签页冻结影响）。#21 现场 1127 次 render 回放 = **1 行**。
  隐私沿用既有口径：只打字符数与原因，不打正文

- **新冒烟 6 条**（`frame-monotonic` 12 / `provisional-accept` 14 / `legacy-payload` 13 / `form-flip` 15
  / `overlay-growth` 13 / `trace-gate` 10，共 77 项断言），只加在 `test:smoke` 链尾；`ghost-geom` /
  `accept-cas` / `render-storm` / `completion-align` 四条既有回归预言**一字未改**

- **端到端验收脚本 `scripts/ghost-frame-e2e.mjs`**（进程内 harness + 假 llm 服务）：把「宿主出终帧 →
  载荷 → 客户端判据」三条线的接缝跑成一条命令。harness 用真 Context + 真 dsh-session + 本仓
  `lib/generate.js`，假 llm 只实现 `ctx.llm.stream` 的异步迭代（即 `src/generate.ts` 真正读的那一个
  成员），流形状写死 3×`reasoning-delta` + 5×`text-delta` + `finish stop`，因此留痕数值可精确断言。
  断言分三档输出 PASS / FAIL / **NOT-COVERED**，未覆盖项必须写清「为什么没覆盖」且不影响退出码 0
  ——**没验到的不得写成通过**（(b) 项在拿不到盘上 `_push` 时，证据源退化到「宿主产物真正产出的对象」，
  脚本自己写的契约样本只喂 (c) 并在输出首行标注来源）。假流形状有三处坑留在注释里：增量字段名是
  `text`、`finish.reason` 必须是对象 `{kind:'stop'}`（写字符串会抛 unsupported finish reason，现象与
  「模型没话说」同形）、assistant/message 数据形状是 `{turn,step,message,stream}` 且带 `surfaceOp`

- **写失败不再是「一种」**（#36 复核产物）。此前只按 `/cannot be nested/i` 一条正则分诊，于是另一类失败
  ——**写锁等待超时**（`atomic-write: timed out waiting for the writer lock`，上限 2000ms，
  `dsh-config-editor` 取锁不传 options 所以调用方改不了）——落到 `push-failed` 分支被判成**终局丢弃**：
  载荷不入补写队列，客户端收不到幽灵，只留一条被节流的留痕。现在按三类分诊（`src/deferred-writes.ts`
  新增纯函数 `triageWriteFailure(error, channel)`，零 runtime import，可离线驱动）：
  - `structural-refusal`（nested）→ 进补写队列，kind 沿用 `push-nested` / `ops-clear-nested` /
    `deferred-*-nested`
  - `retryable-contention`（锁超时）→ **也进补写队列**，新增 kind `push-lock-timeout` /
    `ops-clear-lock-timeout` / `deferred-*-lock-timeout`
  - `unknown` → 丢弃但留痕带「unknown failure class」，kind `push-failed` / `ops-clear-failed` /
    `deferred-*-failed`

  三类 kind 两两不同 ⇒「哪种失败吃掉了几次」可统计，不再靠一条正则兜着。顺带修了 `errorText` 在
  「抛的不是 Error 实例」时退化成 `[object Object]` 的老坑

- **三类写不再自己争同一把锁**（#36 复核产物）。补写泵、即时写 `_push`、消费后 `_ops` 清空共用一把
  profile 锁，此前没有互斥：补写泵在有写在途时也会取槽抢锁，于是自己把自己的写卡到超时。现在补写泵在
  `anyWriteInFlight()` 时**不取槽、不抢锁**（留痕 `deferred-wait … waitedMs=N`，按 kind 分桶、第一条
  必报、之后每 50 次一条带计数、不带正文）；即时写在补写/清空占锁时排队等落地，排队期间**不放指纹**
  （载荷一直挂在 pending 上，落地后由 `retryFlushAfterWrite` 唤醒）

- **两处依据订正**（#36 复核产物）：`dsh-hmr` 的行号补上代次锚点（0.2.0-rc.2 `:271`/`:280`/`:283` ↔
  0.2.1-rc.2 `:736`/`:749`/`:752`，两代逐条核对过；原文的 `:270`/`:284` 是错的），`dsh-settings` 的
  `:510` → `:509`；内嵌的两处 PROBE 五行换成复核评论的 A/B 实测表（原文「差别在上下文在哪儿建立」只
  覆盖了两种成因里的一种）；补写泵 500ms 间隔的依据注释改成实测值（单次写 191-332ms、首笔 2.2-2.5s ⇒
  「500ms ≈ 生成耗时 1/4~1/3」不成立）。**泵间隔本轮未动**：间隔变小会加剧本仓锁竞争，等互斥修完、
  有新失败率数据再定

- **新冒烟 `scripts/push-failure-triage-smoke.mjs`（25 组）**，`test:smoke` 链现 35 项

- **`test:e2e` 两条既有脚本迁到 0.2.x 的宿主面**（#49）。此前整条链在本机**跑不起来**：`coldstart-e2e` 崩在
  `root.settings.register`（0.2.x 里 `SettingsForms` 本身就是注册名 settings 的 Service，旧脚本
  `extends SettingsProvider` + `load()/persist()` 那套 provider 面已不存在；`ctx.settings.register()` 与
  `settings.registrations` 在 0.1.7 被内核删除），`hotness-persist-e2e` 崩在摘要文案的深比较。现在：
  - `coldstart-e2e` 按真实面装内存 `Service('settings')`（`describe()` 行 `{ns,revision,value}` +
    `update(ns,patch)` + 写后 emit `document-updated`），**五个小节的断言本体一字未改**，只补一步 client
    冷启动 `pull`（0.1.7 起对账入口是 pull）——**这一步是断言的内容来源而不是放宽**：去掉它小节 2
    反而**假绿**（读回的是自己塞进介质的 fixture），装上它才红
  - `hotness-persist-e2e` 的根因是**本仓 API 形状漂移**（`parseHotnessOps` 在 v0.5.0 从数组换成信封
    `{ops, rejected?}`，理由见 `src/hotness-store.ts:243-254`），不是持久化逻辑坏（同脚本其余三段全绿）；
    断言取信封对应的一格并**就地加严**（畸形 JSON 必须 `rejected.kind='json'` 且 `bytes>0`、空载荷必须
    不留痕、未知 op 必须 `kind='schema'`），口径与 `ops-schema-coverage-smoke` 第 5/6/7 段一致
  - 链首 `pnpm build` 换成 `./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`（worktree 里
    node_modules 是软链，pnpm 的依赖一致性检查会让整条 e2e 起不来），同一口径写进两条脚本文件头
  - **这条链当时是红的，红得有意义**：`coldstart-e2e` 小节 2「重启对账：盘上残留的上一条建议应被恢复」
    失败，根因是 `parsePersistedPush`（`src/coldstart.ts:109`）**全仓零生产调用点**（`e853d1e` 加、
    `c3b6a80` 删、之后没接回来），且客户端第一次 pull 会把还能救的残留盖掉（#50）。断言**没有放宽**、
    没有报成 NOT-COVERED：红的小节要跟着产品语义走，不能用放宽换绿。**#50 已由 PR #55 修好，整条链现在
    全绿**（见下面「重启恢复盘上残留建议」一条）

- **辅助调用的推理档位可配**（#35）。新增 `suggestionReasoningEffort` / `completionReasoningEffort` 两个
  volatile 设置项，**默认空串 = 不往请求上写 `reasoningEffort` = 沿用该模型自己的默认档位**。默认值不是
  `low` 而是空串：档位按 provider、按 model 声明，本机 qoder-route 18 个模型里有 9 个没声明
  （efficient `:456` / fast `:468` / lite `:427`），给它们带任何档位会在**请求发出之前**被拒
  （`UNSUPPORTED_REASONING_EFFORT`，实测 0-20ms），非空默认值等于把整条建议路径配成必然失败。也不提供
  「传 off/none 关思考」的语义（qfmodel 连 `off` 都拒）。档位 id 不由本插件校验（插件无法预知模型声明了
  哪些档位），所以改成**失败即降级一次**：第一次带档位发，被拒则当场撤掉档位、不退避地重发一次，不占
  常规重试预算（`attempts` 仍是 1），留痕记 `effort_rejected=1`。留痕里的键叫 `effort_requested`（**请求**的
  档位）而不是「生效档位」：终值由宿主决定，插件侧不可观测。档位是 1.8x 量级的杠杆（同沙箱实测 qfmodel
  缺省 1468ms → 带 low 828ms），而**换模型/换路由是 4x 量级**（efficient 缺省 6238ms），所以它的定位是
  「可选的下调手段」，默认一律不动

- **辅助调用的留痕补全**（#39）。`first_text_delta_ms` 与 `first_reasoning_delta_ms` **分开报**：推理模型
  先出 reasoning、很久之后才出正文，合成一个「首块」会把「用户在干等」记成正常（实测 qfmodel 带 medium：
  推理 2072ms、正文 4235ms；efficient 缺省：推理 1443ms、**正文到死都没出**）。另加 `content_deltas` /
  `content_chars` / `reasoning_deltas` / `reasoning_chars` / `finish_kind` / `attempts_outer`（只算外层重试；路由内部自重放不可观测、不计入）/
  `effort_requested` / `effort_rejected` / `outcome`。无产出的两种病因终于是分开的：模型一个字没吐 =
  `outcome=empty`（指向提示词/档位/路由），吐了字但被净化链丢掉 = `outcome=filtered`（指向 sanitize 那
  一侧）。`src/generate.ts` 那条注释早就声称有「归因日志」而代码里一个字都没有，这次兑现。「下一条建议」
  路径此前**一条耗时留痕都没有**（只有续写有），现在补了三行新前缀：`suggestion generated` /
  `suggestion dropped (empty or filtered)` / `suggestion failed`。续写两条既有留痕行的前缀与既有键
  **逐字未动**，新键一律追加在行尾

- **`push landed` / `deferred push landed` 行尾新增 `writeMs=`**：`after=` 是「入队到落盘」（等泵 + 写），
  `writeMs=` 只是那一次 `settings.update` 自己，两者一减才是「等 500ms 泵」占了多少。没有这个数就分不出
  该降泵间隔、该用 `hmr.executing.exit`、还是该换通道

- **实测：投递尾延迟的大头是「写本身」，不是「等泵」**。隔离沙箱 5 个 `writeMs` 样本：**361 / 389 / 626 /
  776 / 2260ms**；两条 deferred 的 `after − writeMs` = **3ms 与 1ms**。排在槽里的载荷几乎没等泵，落那一次
  盘自己要 0.36-2.26s。三段拆开：① 事务内即时写被拒→入队 = 同步（`after=1ms`）；② 泵等待 = 上界 500ms 的
  随机量（本次两条恰好只有 1-3ms；对照 `_ops` 清空那几条 `after=501/508/536ms` 那才是等了一整个泵周期）；
  ③ 写落盘 = **361-2260ms（中位数 626ms）**。落盘之后到客户端可见那一段（`document-updated` 扇出 + 一次
  describe RTT + 渲染）**本期没测到**，不据此下结论

- **实测：建议路径在 `efficient` 上是「只有推理、没有正文」**（两次 `outcome=empty`，
  `first_text_delta_ms=-1`，`reasoning_chars=8354/4143`，耗时 29771ms / 15557ms）。这正是 #35 想要的
  可观测面：不拆两个首块延迟，这轮看起来是「1443ms 出首块，挺快」，实际用户等了 30 秒然后什么都没得到

- **已知缺口**：`parsePersistedPush` 在 `src/` 里**没有任何调用方**（只有冒烟在用），所以「重启后建议还在
  不在」实际靠的是客户端 localStorage；`src/index.ts:529` 一带「`_push` 是建议唯一的持久载体」那段自述
  与实现对不上。已在 #50 立号，修法排在 host 侧回读那条线上

- **端到端脚本把「留痕对不对」拆成四条独立断言**（#39 收口）。原来那项「留痕键与数值」是 NOT-COVERED，根因是
  harness 直接调 `generateSuggestion` / `generateCompletion`，而留痕行由**接线层**（`src/index.ts`）打印，
  `apply()` 不在场 ⇒ 捕获 0 行是必然。现在四条断言各有独立证据源：
  - (a1) **数值层**：直接导入 `createStreamMetrics` / `observeChunk` / `formatStreamMetrics` 三个纯函数
    （产物里已存在：`lib/generate.js:302`/`:326`/`:359`），喂脚本写死的假流形状与假时钟 ⇒ 11 个键全在场 +
    5 个数值精确相等
  - (a1b) **同源旁证**：`generateCompletion` 返回体的 metrics 必须与 (a1) 计数一致（证明真流循环确实调了
    `observeChunk`，不是格式化函数自己算对）
  - (a2) **接线层在场**：静态断言 `lib/index.js` 里 4 个 `traceOps` 打点齐备、每条模板带 `${stream}`、且有
    `const stream = formatStreamMetrics(...)`
  - (a3) **本次运行是否真的打出这一行**：需要一次真实回合，本轮标 NOT-COVERED 并写明原因，另立 issue

  ⇒ 三种状态结构上就分得开了：**产物没构建 → NOT-COVERED / 判据算错或打点丢失 → FAIL / 需要真实回合 →
  NOT-COVERED**。变异测试验过 FAIL 路真会红（改坏期望值 + 改坏一个打点前缀 ⇒ FAIL 3、退出码 1）。(a1)/(a2)
  的输出里都明写「这不等于本次运行打出了这一行」

- **端到端链的顺序修了**：`ghost-frame-e2e` 原先排在 `coldstart-e2e` 后面，而后者因 #50 故意留红 ⇒ 整条链
  里 ghost-frame **一行都不跑**。现在挪到紧跟构建之后（`tsc && build && ghost-frame && hotness && coldstart`），
  其余两条顺序原样、coldstart 的断言一字未放宽；链仍会在 coldstart 小节 2 停住（设计如此，见 #50），脚本
  文件头写明单独跑的方式

- **端到端脚本补上「没有正文的终帧」这一组判据**（#39 收口追加）。真实环境里**没有正文**比「有正文」更常见
  （host-latency 在 efficient 路由上两次实测 `content_deltas=0 / outcome=empty`、`reasoning_chars=8354`、
  耗时 29771ms / 15557ms），而原来的假流永远有正文 ⇒ 只覆盖了较少见的那一半。现在四条新断言、全走真判据、
  零 DOM 零接线层：
  - 空正文**续写**终帧 → 不显示 inline、**允许**回落历史、`hold=null`
  - **成对**的对照：同一次生成内被裁空 → 扣住（`hold=inline-consumed`）、不回落 history。**1/2 必须成对钉**，
    因为「空正文=放行 / 裁空=扣住」单独任一条都能被写反
  - 空正文**建议**终帧 → 帧判据只看 `final`、不看正文长度，写成**事实断言**（不主张空正文应当被采纳或被渲染）
  - 空正文建议的**实际渲染结果** → NOT-COVERED（判定在 `computeGhostContent` / `GhostOverlay.show()`，需要 DOM
    与接线层）

  判据归属也钉住了：`outcome` 由调用方在**净化之后**写（`src/generate.ts:819`/`:834`/`:963`/`:966`），纯函数层
  那个 `outcome=empty` 只代表「这层不拥有这个判定」，不代表「模型一个字没吐」。变异测试验过 FAIL 路真会红
  （把放行与扣住各写反 ⇒ FAIL 2、退出码 1）。脚本现状 **PASS 11 · FAIL 0 · NOT-COVERED 2**，两条 NOT-COVERED
  分别是「缺真实回合」与「缺 DOM/接线层」，都不是原因不明

- **重启后盘上残留的建议恢复回来了**（#50）。此前这条语义**在实现里没有**：`parsePersistedPush`
  （`src/coldstart.ts:109`）是 `e853d1e` 加的、`c3b6a80`（0.1.7 volatile 适配）删掉的，之后再没接回来 ——
  有定义、有单测，但**全仓零生产调用点**。实测后果比「不恢复」更糟：boot 后残留没被清盘（安全约束还在），
  但**也没被恢复**；随后客户端第一次 pull 用内存里的空把它盖掉（`fingerprintOf` 对「空建议」与「有建议」是
  两个指纹，空载荷被当成新值写下去）。现在：
  - 新增纯判定 `decidePersistedPush(raw, ctx)`（`src/coldstart.ts`，零 runtime import、可离线驱动），四档
    处置分得清：`restore` / `stale-turn`（回合已过时）/ `session-unavailable`（会话还没进店，判不了，留给
    该会话第一次 pull 补判）/ `session-mismatch`（归属不上）/ `corrupt-payload`（载荷坏了）
  - **启动期回读**（只读不写不推）：回读时把盘上那份的**指纹与 rev 一并并进本进程状态** ⇒ 恢复之后
    **第一次 pull 零写**（应答被指纹判重跳过，盘上 `_push` 的内容与 rev 都不变，e2e 直接断言
    `after === before`）。启动期推一次则 client 可能收到两份内容相同、rev 不同的载荷
  - **该会话第一次 pull 时补判**：启动那一刻会话常常还没进店（懒恢复）判不了新旧，pull 时它一定在店了
    才判；判出可恢复就接回追踪态 ⇒ **这次 pull 的应答自然带上它**，不需要额外推一次
  - 三个不变量各有断言：旧载荷不得盖掉更新的载荷（本会话已有建议 ⇒ reason=superseded，不接回）／归属
    未确认时不得清盘或推残留（会话未进店 ⇒ 盘上残留原样保留 + 启动期零写）／不得因为回读多推一次
  - 留痕 `persisted push read|restored|skipped|deferred source=startup|pull … turn= baseSeq= chars=`，**不打正文、
    不打会话 id**（会话 id 属可回推的标识）。其中 `deferred` 专门表示**「读到了却判不了」**（会话还没进店）
    ——它与「判废」是两回事，若只靠 `read` 那行撑着，日志里会看起来像「读到了、然后什么也没发生」
  - 顺带修了一个被掩盖的问题：cordis 4.0.1 的 `Context` **没有** dispose/stop/`Symbol.asyncDispose` 面 ⇒
    e2e 脚本里的 `root[Symbol.asyncDispose]?.()` 是空操作 ⇒ 插件的排水定时器一直 ref 着、进程退不出去。
    此前只因「小节 2 红 ⇒ `process.exit(1)`」才看起来正常，#50 修好后成功路径第一次被走到就挂住了
    （timeout 124）⇒ 成功路径补 `process.exit(0)`

- **`_push` 拆成两格：建议与热度/历史环分开**（#36 建议 2）。新增第三个 volatile 载体
  **`_hot` = `{hot, total, history, historySessionId}`**，`_push` 只剩建议相关四元组
  （`suggestion` / `suggestionSessionId` / `completion` / `completionSessionId`，`frame` / `final` 字段名与语义
  未动）。理由不是「载荷变小」：热度每次用户输入就变、环每回合变，而建议每回合最多一次，挤在同一格里会互相
  牵着走
  - **一格一把指纹**（`src/index.ts` 的 `fingerprintOfPush` / `fingerprintOfHot`）：sig 函数吃的是「**将要序列化
    的载荷对象**」⇒ 内存里算的与盘上那份走同一段代码（#50「零写」的前提）。**这里是本条最容易做漏的一处**：
    格子拆开、指纹还算整体，收益就归零，而 `bytes=` 照样降 ⇒ **看着像成功**
  - **合并写**：同一次 flush 里两格都脏 ⇒ 一次 `settings.update(ns, {_push, _hot})`（一次整档重写，#47 的写入
    互斥与三态分诊照旧复用，两格各有在途标记）；只有一格脏就只写那一格；**补写泵永远只带一格**（多键补丁
    无法回滚半笔）
  - **客户端按格判重**：`_push` 原文未变 ⇒ 不 `JSON.parse`、不重跑 `resolvePayloadFrames`、不动帧台账、不换
    建议对象引用（`lastPushRaw` 按原文比，而不是比解析后的结构）
  - `_hot` 进 `src/live-settings.ts` 的 `TRANSPORT_KEYS` 白名单（它是传输载体不是配置值，漏登记会被当配置值读进
    `effective()`）；`src/projection.ts` **刻意不动**（热度的投影来源是会话事件 `hot-index`，不是这个载体）

- **可量（同一份 `scripts/payload-split-smoke.mjs`，换的是产物不是代码；旧产物自动降级为「只打印不判定」）**：
  写次数 **4 / 4 持平**（每回合 1 次写，piggyback 让拆分**没有**让写变多）、**建议格被重写 4 → 2**、建议格字节
  **235–313 → 153–159 B**。真实量级核对（live 日志 124 个样本）：`bytes=` p50 = 3,121 / max 8,585 B ⇒
  夹具**低估**了拆分效果，真机上建议格只占整包约 5–6%

- **一条收益口径的更正（重要）**：拆分**不会**让「客户端幽灵内容重算」减少 —— 热度列表与历史环**本来就参与**
  幽灵候选的排序（`computeGhostContent` 的 history 分支与打分），所以 `settingsEpoch` 递增、归一化/打分/幽灵三处
  缓存失效是**语义上正确**的，不是缺陷。拆分真正省下的是：**建议格的解析与帧判定**（不 parse、不重跑帧判据、
  不换建议对象引用）＋ **建议格不再被热度变化连带重写**

- **本条是「下一步那把刀」的使能步骤**：把写次数真正打下来的刀是 **`_hot` 侧的节流/合并**（建议窗口 1000ms
  ＝约一个回合间隔，摊薄到约 0.25 次/回合），代价是客户端热度列表最长滞后一个窗口、且 `pull` 应答必须仍带
  当前热度否则切会话「先旧后新」比滞后更难看。节流引入的是**产品取舍**，本条**不实现**，方案与实测的每回合写
  次数写在 PR body 的下一步建议里

- **滚动升级顺序**：宿主先于/同步于客户端升级；**宿主升级后请刷新页面**（客户端 bundle 由同一宿主提供，
  版本偏斜只影响升级前就已打开的旧标签页）。旧标签页的现象**两格不一样**（按 #57 合并前的旧客户端代码实读）：
  **热度列表会被清成空**（旧代码把缺省的 `hot` 判成 `null`），**历史环则只是停更**（旧代码对 `history` 是
  「省略 = 保留现值」）；建议格不受影响，它还在 `_push` 里。两者都**不等于丢数据**：热表的权威存储是
  `suggest_ghost_hotness` 域（`src/hotness-store.ts:44-45`），`_hot` 只是给客户端的快照，刷新后即恢复。
  **不加**「把热度回写进 `_push`」的兼容开关 —— 那个开关会把拆分收益抹掉一半

- **`after=` 这个留痕键加了两道护栏**（事故复核增量）。它是「被拒留痕」的唯一时长信息，而它的谓词
  原先有**两个静默空洞**：**键整个消失时**（谓词在 `after=` 不存在时返回 false ⇒「留痕把 after= 弄丢」
  被读成通过 —— 而这条断言存在的理由恰恰是「after= 得有信息量」）、以及**负值**（`Number('-5') > 10_000`
  为假 ⇒ 起点被写成未来时刻时也是绿的）。两条都补上了
  - 顺带一条**变异方法论**（已写进注释）：测「有没有界」要用**显著量级的偏移**，不是符号翻转 ——
    把 `Date.now() - pushStartedAt` 翻成 `pushStartedAt - Date.now()` 在这一拍**不会红**（真实耗时 0–1ms，
    翻转后是 0 或 -1，而 `-0` 不匹配负号）⇒ 那一轮「断言没红」根本不构成变异
  - 口径也校准过一次：要求「所有 refused 行都带 after=」会把**合法行**判成红 —— `after=` 只属于即时写被拒的
    两种形态，而节流行的 `push-nested #N` 与泵侧的 `deferred hot push refused` 量的是别的东西
  - 复现这类循环**只能用 `AsyncLocalStorage`**：同步布尔标志会假阴性（`.finally` 的重试在 microtask 续体里，
    标志早已复位 ⇒ 看起来「修好了/复现不出来」）。独立复现量到：修复前**同一拍 398 次**被拒并立刻重试，
    修复后**1 次**即落地

- **热度格的写合并窗口**（#36 建议 2 第二步）：`HOT_PUSH_WINDOW_MS = 1000` + 纯函数
  `decideHotPush(now, lastWriteAt, window)`（放在 `src/deferred-writes.ts`，与 pump 常量同处，可假时钟离线断言）。
  **计时起点取「上一次写出去」而不是「第一次待写」**（后者在连续输入下会饥饿）⇒ 陈旧度有硬上界 =
  窗口 + 一个泵间隔（**≤ 1.5s**）
  - **只合并「纯热度」的变化**：建议格的变化**永远立即写**，绝不被窗口拖慢；被拒时 `disarmHotWindow()`
    交回 #47 的有界重试（窗口不该变成「把没写成功的东西再多扣一会儿」）
  - **pull 必须让路**：窗口未到期而用户 pull 时，pull 的应答带**当前**热度（必要时立即写一次热度格）——
    切会话时「先旧后新」比滞后更难看
  - 实测：5 个「只热度变」回合 ⇒ 含 `_hot` 的写 **5 → 3**；**携带建议格的写仍是 1 次即时**（未被拖慢）
  - **用户可见代价**（README 中英都写了）：热表**排序**可能滞后 ≤1.5s；**不影响建议本身**
- **一条目标口径的更正（板上的数字作废，理由是前提被否）**：原验收写「每回合写次数 1 → ≤0.45」，它的
  前提是「窗口 ≈ 一个回合间隔」—— 实测否掉了：一次建议生成本身就要 **4.26s / 15.56s / 29.77s**（#51 沙箱
  留痕）⇒ **回合驱动的热度变化各自独占一个窗口，合并不掉**。而它本来就**piggyback 在建议格那一次写上**
  （#57）⇒ 边际成本≈0 ⇒ 没有可省的。**能被合并的只有同一窗口内的高频抖动**（连续快速输入、一批多 op、
  回合结束但 `outcome=empty` 不碰建议格的时刻）⇒ 改按「**纯热度抖动的写次数下降** + **每回合总写次数不
  上升** + **建议格写次数不上升且不被拖慢**」验收。**没有把 0.6 说成 0.45**
- **顺带记一条量口径的陷阱**：「载荷字节与上次落盘逐字相同」这个口径**恒等于 0%** —— `rev` 每写一次就 +1，
  拿原始字节比原始字节，任何两次写都「不一样」，于是这个数会被读成「没有浪费」（**假阴性**）。要比必须
  **先剥掉 `rev`**；剥掉后是 0/6 格次，而那恰好是**按格判重的自证**（成立时必须是 0），**不是收益上界**
- **断言口径的一处移动（已报备）**：`hmr-write-loop-smoke` 的 B1 从 `== 1+上限` 改成 `≤1+上限 且 ≥1` ——
  上界一侧（紧循环护栏）照旧钉死；改的原因是窗口落地后首次变化可能落在前一场留下的**开口窗口**里
  （少一次 leading 写，4→3，这是节流的预期行为），保留等式等于**用测试禁止节流**

- **别的会话的一次 pull / 一次停顿续写 / 一次回合结束，不再盖掉盘上未判定的残留**（#56）。「未判定的
  残留」＝宿主重启后从盘上读到、但**判不了**的那条建议（它的会话还没进店 ⇒ `judgePersistedPush` 回
  `session-unavailable`）。此前别的会话的任何一个动作都会把 `_push` **整格**覆盖成自己的视角 ⇒ 残留丢
  （同进程内还能靠内存里的原文救回来，**重启才真丢**）
  - **新增传输载体格 `_residual`**（`{suggestion, sessionId}`，至多一条；**客户端不读**）：别的会话的动作
    只写 `_push` / `_hot`，**不碰 `_residual`** ⇒ 保护是**构造性的**，不依赖「写的时候记得带上残留」这种
    人工纪律 ⇒ **三条覆盖路径同时闭合**（pull、停顿续写、**回合结束** —— 最后这条最常见：B 跑一轮就抹了）
  - **懒搬迁**：启动期**一字不写**（「启动只读不写不推」那条不变量原样保住）⇒ 下一次写 `_push` 时同批带上
    `_residual`；崩溃/重启发生在懒写之前 ⇒ 盘上残留本就在 ⇒ 两条都闭合
  - **一条必须成立的不变式**：**每一次写 `_push` 的路径都在同一笔 patch 里带上 `_residual`** —— 补写泵那笔
    尤其要紧：第一笔写被拒 → 入队 → 队列里那份载荷不含 `_residual` → 泵 flush 时**两条一起丢**
  - 字节形状与 `_push` 的建议部分**同形** ⇒ 判定复用 `decidePersistedPush` / `parsePersistedPush`，
    **没有第二套「什么算可恢复」的判据**；了结挂在 restore / stale-turn / superseded / corrupt 四个终判出口
    （`session-unavailable`、`session-mismatch` 不算收敛 ⇒「跨会话不恢复也不清」原样）；清空**绝不碰 `_push`**
  - 一格一指纹（`residualSigOf` + `residualFingerprintOfPersisted`）；**`_push` 的三处 sig 一字未动** ⇒
    「字节变了但指纹没变 ⇒ 该写不写」那个坑**从路径上消失**；`_residual` 与 `_push` 同批写 ⇒ 被拒时两格都
    不落地 ⇒ 不会留半更新状态 ⇒ **不需要第三个补写槽**
  - 回归：`scripts/residual-carry-smoke.mjs` 10 场，**同一个文件、同一套期望**，改前 4 红 → 改后全绿；那条
    不变式由**行为钉**（三处写点各覆盖：即时写 / 补写泵 / 只需清空那笔），并用变异自证（删掉
    `attachResidualCell(drainedPatch)` ⇒ 补写泵那条当场红）
  - 客户端只加两个**只读**计数（`ownerHidden` / `llmGhostOffered`）与一条归属守卫场景（B 在场隐藏 A 的残留、
    切回 A 立即可用且**不重推**）⇒ 判据语义未动

- **新增 `docs/gitea-workflow.md`**：本仓交付路径上的**两条会静默失败的坑**与协作约定。① **发评论的正确形式是
  `tea comment -r <repo> <编号> "<正文>"`**，错误形式 `tea issues comment add …` 在本机 tea 上**退出码 0**、
  把 issue 列表当结果打出来、**评论没进服务器** ⇒ 这条形式**不能靠「跑一遍看有没有报错」验证**（报错本来
  就不是它的失败模式）；且**发完必须回读**，唯一可靠的回读是 API（`tea issues -o json` 的 `comments` 字段恒为
  空数组，用它复核会得出**反向**的错误结论）。② **`lib/` 是入库产物**（多分支各自重建必然冲突 ⇒ 由 lead 在
  main 上统一重建）⇒ **冒烟导入的是 `lib/` 不是 `src/`**，「变异没让断言变红」多半是忘了重建，而不是断言无效
  （本仓这两天真实踩过两次）。另含：origin-only / 禁 `git add -A` / 主仓是 live 那份 / worktree 里 pnpm 不可用
  的替代命令 / `dev-sandbox.mjs` 无参即启动实例 / 回收 worktree 时 cherry-pick 分支要用**空 diff** 判等价 /
  断言三态口径（NOT-COVERED 不许写成通过）与两条变异口径

- **热度格的让路触发面从 `pull` 扩到 `complete`**（#63）。`complete` 是客户端合成时发的那条信号
  （打够 `inlineMinChars` 并停顿），这是宿主能拿到的最早「有人马上要用热表」的时机；这一刻把挂起的
  热度快照放出去，客户端后续按键读到的就是**当前**热表。`HOT_PUSH_WINDOW_MS` **一字未动**（仍是
  1000），并有一条断言直接钉住这个常量，防止以后把「修让路」做成「缩窗口」
  - **让路不产生额外写**：`pushToClient` 按格判重，**没有待合并的热度变化时一个字节都不写**
  - 放出的那一份内容是**当前**热表（含刚被合并掉的那条输入），不是提前写了个旧的
  - 真人输入下的合并收益不降：纯热度抖动的写次数仍是 5→3
  - **诚实的边界**：宿主**看不见按键**（会话事件面没有任何 draft/typing 通道）⇒「burst 内第一次合成的
    首字符」那 ≤1.5s 切片**这条救不了**，救的是这次合成里后续按键与其后所有合成；要覆盖那一段只能让
    客户端在首字符时发一条信号给宿主，而那等于每轮连发多一次写，正是这个窗口省掉的东西 ⇒ 该取舍
    **另立**，本条没有替人决定

- **`docs/real-session-harness.md`**：在隔离沙箱里驱动一个真回合的配方与实测结果（#69）。含三个此前
  没写下来的事实：
  - **挂插件要三个前置，不是两个**：profile 的 `package.json → dsh.profile.bundles` 里要有该插件、profile
    的 `node_modules` 要能解析到它、`--patch` **只用于改配置、不能新增条目**（实测：无 patch 98 个顶层条目、
    带 patch 仍 98 个，`id: suggest-ghost` 零命中）
  - **headless 测不到「写」**：它自述即 “flushes its Session, prints the final assistant text, and exits”
    （`dsh-headless/lib/index.js:28-34`，config 无 keep-alive）⇒ `turn/end` 之后进程立刻退出 ⇒ 插件回合后
    那次异步调用拿不到执行时间（探针实测：`HT ENTER` 进了，`push landed` 一条没有，盘上三格计数全 0）
  - **端口以日志里那行 `dsh web:` 为准**：`--rewrite` 改的是 profile 里那条，不是实例实际服务的端口
- **「空正文的终帧」是**双重不可达**（#67 / #53 的 DOM 项已收口）：产出侧 `generateSuggestion` 在空或被过滤时
  返回 `suggestion: undefined` ⇒ `buildPushPayload` 写 `suggestion: null` ⇒ 宿主**永远不发**空正文终帧；
  回读侧把 `text === ''` 判成「无建议」⇒ `persisted push skipped … reason=corrupt-payload`，不动盘。
  真实 DOM 实测：overlay 节点根本没挂、placeholder 仍是 `display=flow-root / visibility=visible /
  opacity=1`、插件相关 console error 0 ⇒ 担心的「幽灵没画、占位文案被藏」的空白输入框**没有出现**
  - **端口以日志里那行 `dsh web:` 为准**：`--rewrite` 改的是 profile 里那条，不是实例实际服务的端口

- **`scripts/hot-yield-ratio.mjs`**：零依赖的真会话驱动（自己起沙箱、自己读 `logs/sbx.log` 取 URL+token、
  **同进程内用 CDP**（Node 内置 WebSocket）操作 headless chromium）⇒ **token 明文彻底不进 transcript**
  （输出全过 `redact()`，并自打「明文进 stdout 次数 = 0」）。**不接测试链**（它要花真回合）。
  实测结论见 #63：**让路在单人流量下没有分母** —— 真实读数 `pull 19 / complete 3 / push landed 18 /
  hot push landed 11`，而 **`hot push coalesced = 0`、`hot push yielded on input = 0`**，且**每一行落地留痕
  都带 `coalesced=0`** ⇒ 让路的触发条件（「窗口开着且本可推迟」**且**「此刻热表相对上次写是脏的」**且**
  「这一拍是 `complete`」）在单人节奏下很少同时成立 ⇒ 「应当让路的次数」为 0 ⇒ 性质那半句
  （让路写次数 ≤ 待写变化数）在真实宿主里同样成立（0 让路、0 多余写）
  - 顺带记下五个驱动真坑：`--patch` 加不了插件条目、首屏引导模态叠多层盖住工作区、全局找「打开」会命中侧栏
    「余额 打开 DeepSeek 充值页」、受控路径框吃不下合成事件与 `insertText`（改点目录行）、Lexical 只认 `char` 事件
  - 一条清理教训：**`pkill -f` 的模式串不得与执行它的命令行共串**（否则会把自己的 shell 杀掉）

### 修复

- **HMR 事务内写失败退化成微任务紧循环（2026-10-22 事故：tee 日志 23 GB、事件循环卡死）**。
  现场链路：client 一条 `pull` 写进 `_ops` → 内核在 settings 写入事务里就地 emit
  `settings/document-updated`（`dsh-settings/lib/index.js:435`）→ 宿主的 `consumeOps` 回调整个跑在
  HMR 事务内 → 应答 pull 要推 `_hot`（历史环/热度）→ 被 `HMR transactions cannot be nested` 拒 →
  #57 拆分后的失败分支把载荷放回 `pendingHotPayload`，`.finally` 见热度槽非空**又立刻
  `flushPush()`**。事务内的拒绝是同步零副作用的 `Promise.reject`，于是「失败 → 重排 → 再写」全在
  微任务里打转：事件循环拿不回控制权（timer / I/O 全饿死），每圈还打一行 `hot write refused`。
  **为什么以前没撞上**：拆格之前失败分支不把载荷放回 `pendingPushPayload`（只入补写队列），
  所以 `.finally` 的续写条件不会成立；拆格给热度格加了「放回」却没给它独立的出口，才把
  微任务链闭合。**为什么 `_ops` 一直留在盘上**：同一个事务里那次「消费后清空」也被拒，只是
  进了补写槽——而紧循环让 500ms 的泵永远轮不到。
  - **`.finally` 只续写建议格**（`pendingPushPayload`）。热度格被拒后**不再**立即 re-flush；
    载荷留在槽里，由事务外锚点 `drainDeferred` 新增的 `drainHotFromPump` 补写。
  - **热度格补写有界**：新增 `HOT_DRAIN_MAX_ATTEMPTS = 3`（每次失败计数，到点丢弃 + 放开
    `lastHotFingerprint`，下一次状态推送重建一份**当前**快照）。它不共用 `deferred` 的两槽：
    热度是整份快照、无 CAS 语义，但同样只能从事务外写，且不该和「用户刚等的东西」抢锁。
  - **在途更新不倒退**：失败放回/泵失败放回都只在槽空着时做——写入期间若已排进更新的热度，
    旧字节不许盖新状态。
  - **留痕有界**：`hot write refused` 从无条件 `traceOps` 改成 `traceFault`（同类第一条 + 每
    20 条带计数）；泵内失败按 `deferred-hot-*` 分 kind，到上限留 `hot-drain-exhausted`。
  - **顺带修 `after=` 失去信息量**：#57 重构把 `pushStartedAt` 的赋值弄丢了，被拒留痕里出现过
    `after=1792631248119ms`（从 epoch 起算）。现在 `pushToClient` 进入合并缓冲时赋值。
  - **回归**：新增 `scripts/hmr-write-loop-smoke.mjs`（11 组，A1–A6 / B1–B5，已进 `test:e2e`
    构建之后）。A 组复刻事故原路径（事务内 pull）并断言：留痕 ≤ 40 行、**夹具侧确有 `_hot`/`_ops`
    写落在事务内被 nested 拒**（下界，防止「这一拍不脏/写成功」式假绿）、`hot write refused` 1–2 次、
    `after=` < 10s、`_ops` 被事务外泵清成 `null`、`_hot` 落盘且历史环含本会话那句话、事务外写 ≤ 8 次。
    B 组把所有宿主写入都拒掉（锁超时）后**数写面而不是数被节流的日志**：`_hot` 写入次数必须等于
    `1 + HOT_DRAIN_MAX_ATTEMPTS`、再等 1.6s 不得有新增、`hot-drain-exhausted` 的 `attempts=` 必须等于
    上限、总留痕 ≤ 120 行、2.2s 等待按时结束（timer 没被饿死）。脚本自带 2000 行保险丝（越过即
    `exit 99`），修复前构建下它 **339ms 触发**；修复后整场峰值 17 行。
    `scripts/deferred-writes-smoke.mjs` 补三条静态守卫：`.finally` 里不得出现「因热度槽再 flush」、
    热度补写必须走 `drainHotFromPump` 且引用 `HOT_DRAIN_MAX_ATTEMPTS`、`pushStartedAt` 必须在
    `pushToClient` 入口（no-dirty 早退之前）赋值

- **客户端类型检查基线里 18 条是同一个 bug 的产物**（#34）。`src/client/index.ts` 里 `_push` 的解析
  结果声明成 `let pushed: {…} | null = null` 再用 `as typeof pushed` 断言，而 `typeof` 在该处取到的是
  **已被窄化过的 `null`**，于是每个 `pushed?.x` 都报 `TS2339 … on type 'never'`。改成具名
  `type PushedPayload` 后这 18 条整片消失：`tsc -p tsconfig.client.json --noEmit` 从 **41 条降到 23 条**，
  本次改动**新增 0 条**。即 #34 正文里的「基线 40 条」应重新表述为「约 23 条真错 + 18 条同源假错」，
  清零路径因此短了一截。诊断配置仍未开 `allowImportingTsExtensions`（本包 NodeNext 相对导入必须带
  扩展名，每新增一个 `src/client` 下的文件就多一条 TS5097），所以本轮的客户端判据**折进既有文件**
  （`accept-guard.ts` / `completion-align.ts` / `inline-arm-policy.ts` 末段）而不是新增 4 个文件；
  是否开该选项归 #34 定

- **净化链的判据显式分成「只看前缀能定论」与「只能在终帧定论」两组**（#37）。这是为将来的逐帧呈现
  做的前置：现有六个净化函数里至少 6 处判据依赖**结尾**或**总长**（围栏尾行、尾引号、尾随空白、
  `>200`、尾问句、`<40` 与「草稿 ×3」比值、回声窗口按全长算、`maxChars` 词边界截断），中途看前缀
  判不出来，于是**中途放行 ≠ 终态放行**。现在 `src/sanitize.ts` 模块头有两张带行号的表
  （表 A prefixSafe 六条、表 B finalOnly 九条，26 个 `L行:标记` 锚点由新冒烟逐条核对，改代码不改表
  就先红），六个对外函数只做命名化拆分，**链序与常量一字未动**
  - 新增导出 `prefixSafeClean(text, draft, maxChars)`：finalOnly 判据一律不判，改成「把可能被终态
    改写的最短尾段扣住不输出」——**只会让文本晚一帧出现，永不撤回已显示的字符**
  - `src/inline.ts` 补链序/分组注释，并预留出口 `sanitizeCompletionFrame()`（**未接进宿主投递**）
  - 行为不变的证据是差分参照而不是既有冒烟：把 #37 之前的六个函数逐字抄一份，对 3286 条输入 ×
    全部 `maxChars`/草稿组合断言完全相等（含整条 `sanitizeCompletion` 链）；单调性 1,535,356 帧 /
    124,936 个终态 **0 违规**，另加两条活性断言防止「每帧返回空串」把单调性白骗过去；变异测试证伪
    三条（帧上改跑 `cleanSuggestion` → 单调性红、退化成空串 → 活性红、终态 `0.3` 改 `0.5` →
    差分参照红）
  - 三类反例已被冒烟钉住「当前会被误放行」：围栏尾行误剥（帧 `x```keep` → `"x"`，而终态是
    `"x```keepmore"`）、`>200` 与「草稿 ×3」中途放行、回声窗口按总长误判（帧 `"xyabc"` 根本不是终态
    `"xy def gh ij kl mn op"` 的前缀，`prefixSafeClean` 同帧给 `"xy"` 扣住）
  - 顺带修正 `src/sanitize.ts:242` 与 `src/inline.ts:102` 两处既有注释笔误（写「× 5」而常量是 3），
    只动注释

- **中文会话里蹦出英文建议**（三处修，缺一不可）。根因是一条链：语言推断被喂了「按 UTF-8 输入预算裁剪
  后的转录」→ 回退证据用了**原文** → 推翻先验用的是**绝对阈值**。默认 `maxInputBytes=4096` 下，「长中文
  助手回复 + 几条短用户消息」这个最常见组合会把 `我合并了` / `我重启DSH了` 整批挤掉，只剩一条纯 URL；
  `stripNoise` 把 URL 删空后触发「回退到最后一条 assistant」，而中文调试报告里的标识符、`IP:端口`、
  Markdown 表格把 `latinScore` 顶到 195，越过 `uiLocaleWeight(100)`，于是那条本为「用户持续用英文推翻
  界面语言」设计的覆盖判据被**助手文本**触发。反直觉之处在于：只有 `zh` / `ru` 界面会翻车（`en` 或无 UI
  先验走不到那个分支，同一份转录反而判出简体中文）。实测复现于 `session-47dc0add…` 回合 22，判出的英文
  建议即 `yes, go ahead and change that line`。

  - **① 证据窗口与输入预算解耦**：`buildTranscript` 额外给出未经裁剪的 `evidencePairs`（排除合成的
    `[Earlier context summary]` 伪 user 对），suggest 与 inline 两条路径的语言判定都改用它；送给模型的
    `pairs` 一字不改 → token 成本与裁剪行为零影响。顺带给证据文本加 `EVIDENCE_TEXT_CAP_CHARS=4000`
    上界：证据不再由输入预算兜住，得自缚一个界，防用户粘贴的巨型日志把 `stripNoise` 的正则成本放大成
    整轮瓶颈
  - **② 覆盖判据加 `fromAssistantFallback` 门控**：助手文本不代表用户，无资格推翻 UI 先验
  - **③ 绝对阈值改相对比较**：`latinScore > uiLocaleWeight` → `latinScore > cjkScore`（该语言侧含先验
    的总证据；西里尔分支同理）。单条消息得分上限 60×6=360，绝对阈值 100 等于「去噪后拉丁占比 >27.8%
    就翻」，而「中文但混满路径与仓库名」的任务提示词占比普遍 52%-61%——**做完 ①② 之后这批仍全被判成
    英文**，因为那时证据已是真人消息、② 的门不再拦。`uiLocaleWeight` 由此回归单一职责（只是该语言侧的
    加成），与设置页文案「值越大越倾向界面语言」一致

  38 个真实会话末回合复算（判 English 的数量）：**线上 14 → ①② 10 → ①②③ 0**。① 单独只救回 6 条，
  还会打破 2 条本来靠「裁剪 → 回退到中文助手简报」歪打正着判对的会话；③ 把这 2 条一并收回。边界探针
  确认覆盖判据没被改成死代码（三条长英文提示仍判 English）。同源缺口**未**在本次处理：停顿续写的草稿
  本身仍不参与语言判定（中文会话里打英文草稿会被判成中文续写），`src/generate.ts` 的注释已改为如实说明。

  回归：`scripts/suggestion-language-smoke.mjs` 用例 11–17（11/12 钉 ②、14/15 钉 ③，四例在对应修复前
  实测均返回 English；16 摘自语料 A，17 是英文探针），新增 `scripts/language-evidence-smoke.mjs` 端到端
  钉 ①（修复前实测 TypeError），两者均已入 `test:smoke` 链（现 27 项）

## [0.6.0] - 2026-10-20

### 修复

- **`_ops` 写入此前必然被版本冲突拒绝**：client 侧 `remote.settings.mutate(ns, ops, expectedRevision)`
  的第三个参数是 CAS 的期望版本，此前固定传 `0`。`revision` 每次该命名空间内容变化都会推进（宿主自己
  写 `_push`、消费后清空 `_ops` 都算），所以启动后的第一次写入之后，每一次 `expected=0` 的写入都被内核
  拒绝，而客户端只看 Promise 状态，表现为「resolve 了但什么都没写」。现在改为先 `describe()` 取真实
  revision 再提交，冲突时重取 revision 重试（上限 2 次）（#16，`a864545`）
- **`complete` 操作被 zod 整批拒绝**：`opsPayloadSchema` 的 `discriminatedUnion('op', …)` 缺少 `complete`
  变体，而 `HotnessOp` 的 TS 类型里有；校验失败会让**整批** ops 一起被丢弃，停顿续写因此从不触发（#17，
  `8e2e5c0`）。两份声明互不约束，编译器不会报这种漂移
- **停顿续写推送到客户端总是丢失**：`_push` 是单槽 last-wins 快照，续写载荷只存在一瞬间，随后任何其他
  会话的 pull 应答都会重写它；客户端是「事件 → 异步 `describe()`」的快照式读取，读不到被覆盖的中间值。
  宿主现在全局追踪 `lastCompletion {sessionId, completion}`，并在目标会话缓存未命中时持续捎带最近一次续写；
  跨会话误显示由客户端既有的 `completionSessionId` + `draft` 全等双校验兜住（#18，`bceac31`）。
  ⚠️ 该方案**不充分**：它只解决「瞬时载荷被 last-wins 覆盖」，没解决「载荷写不进盘」。真实根因与
  修复见下面 #22 那条（事务外排水锚点），已端到端验到幽灵可见
- **采纳建议会吞掉用户刚打的字**（#4，`3a06a6b`）：Tab 整条采纳与 `→` 逐词采纳都是
  「读草稿快照 → 拼 `accepted` → `setDraft`」，两步之间没有任何校验。原生输入先于 React 渲染
  到达宿主草稿存储，所以用户在这两步之内打的字会被整段覆盖。现在以 `ghostContent()` 同一帧
  读出的 `{draft, draftRev}` 为 CAS 基线，写入前重读比对：宿主 `InputState.draftRev`
  （`@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2`，实测仅在草稿投影内容变化时 +1，
  **纯光标移动不推进**，故不会因挪动光标而误放弃）不等或文本不等，就一个字符都不写、幽灵照旧
  收掉。判据与 `accepted` 构造抽在 `src/client/accept-guard.ts`，两条路径共用；历史补全的斜杠
  命令整行还原逐字搬入，并由 `scripts/accept-cas-smoke.mjs` 用旧实现作回归预言逐字符比对
- **一次输入刷出上千次 armed，停顿计时器永远被推倒重来**（#21，`580e76f`）：旧
  `scheduleInlineTrigger()` 首行就 `clearInlineTimer()`，而每个 `render()` 都调它 —— debounce
  度量的其实是「距上次 render」。判据改为纯函数状态机 `decideInlineArm`（观察值 = 草稿/会话/
  幽灵形态/开关/组词），同一观察的重复送达一次都不清表；到期时刻按绝对 `dueAt` 结算，回到
  「最后一次按键 + 800ms」的真实停顿点。顺带修掉一条真实的退订泄漏：`resolve()` 也会被 render
  调用并就地换掉 `bound`（会话晚就绪），旧会话的三条 store 订阅此前一直挂到下次真切换才清，
  现在退订/订阅收敛到 `subscribeBound` 单一出口。虚拟时钟对照：armed 行数 1999 → 37、
  `setTimeout` 调用 1999 → 37、complete op 触发时刻 24780ms → 4700ms
  （`scripts/render-storm-smoke.mjs`）。**浏览器内归因已实测完成**：`renders{session=146,
  input=7,face=0,other=80}` —— 洪水来自 `sessions.list` 订阅（`onList`，未切会话时也无条件
  render）与错峰补渲染定时器，**不是**原推测的 `input.state.subscribe`；一次上百次 render 只产生
  一次 armed，修复在真实环境成立
- **设置页改开关在运行中不生效**（#19 遗留，`95994d6`）：`liveSettings = flattenConfig(resolved)`
  与 `effective()` 的两个入参同源，读的都是 `apply(ctx, config)` 首次解析并 `deepFreeze` 的时刻
  快照，内核重解析永不回填。新增 `src/live-settings.ts` 做「事件驱动标脏 + 下一次读才
  `describe()` + 5s TTL 兜底」的实时读源，`bootSettings` 降级为默认层，实时覆盖值按
  `keyof FlatConfig` 键表逐键取（`_ops`/`_push` 在类型层就落不进设置）。隔离实例已实测到
  `live settings refreshed rev=… applied=23`（按 revision 变化去重），即"改了能被重新读到"第一次
  成为可直接观察的事实；设置页各开关的逐项人工确认仍待 live 宿主重启（issue #19 验收清单）

- **同一个草稿再停顿多少次都不出续写**：宿主按载荷字符串全等给 `_ops` 去重，而「消费后清空
  `_ops`」在 `settings/document-updated` 回调里是**结构性不可能**的——那次写入落在内核 HMR 的
  `AsyncLocalStorage` 事务内，`runExclusive` 直接拒（`@deepseek-ai/dsh-hmr/lib/index.js:279-281`，
  本机一个进程实测 `HMR transactions cannot be nested` 372/373 次）。两件事实叠起来等于
  「同一份载荷永远只会被消费一次」：`pull` 因 `rev` 自增侥幸躲过，`complete` 的载荷
  `{rev:0, ops:[{op:'complete', sessionId, draft}]}` 逐字节由草稿决定，于是
  「输入 A → 停顿 → 改成 B → 删回 A → 再停顿」这条合法重发被当成回声静默丢弃。现在每次写入自带
  进程内单调 `seq`（新增 `src/client/ops-envelope.ts`，纯函数，locale 捎带一并收进来），
  去重回到它本来的职责。`scripts/ops-envelope-smoke.mjs` 断言不变量，并断言新增顶层键不会被宿主
  拒（`opsPayloadSchema` 非 strict；反向验过未知 op 仍被拒，判据不是永真）

- **故障留痕的节流按 kind 计数会吞掉新故障**：`traceFault` 原先用 `kind` 做计数键，于是
  「路由缺失」报出第一条之后，同一 50 次窗口里混进来的**任何不同性质**的新故障（写锁超时、
  模型 4xx、投影服务缺失）都被同一个计数器一起丢弃——等于主动重犯 #17 批评的静默丢弃。现在计数键
  改成 `kind + 归一化签名`（新增 `src/fault-signature.ts`）：同类只报计数，新类必定独立报出
  第一条。归一化只抹「每条都不同但显然同类」的部分（会话 id、`after Nms`、任意数字），
  原因文本保留，所以签名不会退化成常量。`scripts/fault-signature-smoke.mjs` 六组断言里
  最关键的一组就是「四类不同故障必须落在四个桶」
- **停顿续写的投递被内核事务拒绝，幽灵永远不出现**（#22，同时也是 #18 未修的那一半）：宿主消费
  `complete` → 生成续写成功 → 在 `await` 之后的续体里写 `_push` → 内核拒 `HMR transactions cannot be
  nested`（判据是 `dsh-hmr/lib/index.js:271,280,284` 的 `AsyncLocalStorage.getStore()`；ALS 沿
  await / microtask / **事务内建立的 timer** 传播，所以"推迟一个 tick"不逃逸）。实测五种写上下文
  后确定：**只有 `apply()` 期建立的异步上下文在事务外**（`boot-setInterval` 写入 OK 147ms，而
  completion 续体内的写入 1ms 即被拒）。新增 `src/deferred-writes.ts`（push/clearOps 两槽队列、
  时间与次数淘汰、`decidePushDrain`/`decideClearOpsDrain` 两个可离线证伪的判定）与 apply() 期
  `setInterval` 排水 pump，两个 nested 拒绝分支由"丢弃"改为"排队补写"。两条安全约束：带续写的载荷
  超 8s 丢弃（续写只对其所属草稿有意义，不做无界补投）；补做 `_ops` 清空前先比对盘上现值与入队时
  同步捕获的那份，不等就放弃（否则会吃掉未消费的新 op）。隔离实例端到端实测：
  `push refused … queued carriedCompletion=1` → `deferred push landed rev=3 carriedCompletion=1
  after=301ms attempts=1`，客户端 `#dsh-suggest-ghost-overlay[data-shown="1"]` 首次真的显示出续写；
  `_ops` 清空也开始成功（连带缓解"载荷长期滞留盘上、重启即被重放"）。**热重载不能用来验这条**：
  HMR 重建的 pump 仍带 `store=true`，部署必须整进程重启

- **续写的五个静默出口全部留痕 + 生成链加墙钟上界**（#22 的后续；`aa146b8` + `58feb39`）：
  `handleComplete` 原先在 `inlineEnabled=false` / 草稿太短 / 会话不存在 / 槽位被更新草稿接管
  （then 与 catch 两处）/ 请求被 abort 这五处**直接 return 不打任何痕迹**；而 `generateCompletion` 无超时，一次挂住就永久静默。实测比例：live 一个进程里
  `ops consumed: complete` 30 次只对应 5 次 `completion generated`，**25 次消失在无痕迹的分支里**。
  现在七条出口各有独立 kind/reason、报文只含字符数，纯判定抽到 `src/completion-gate.ts`。
- **超时留痕被自家节流吞掉**（同一轮里我自己造的第二个观测缺陷）：`traceFault` 按
  `kind + faultSignature` 分桶，而签名**刻意**把 `session-<hex>` 折成 `session` → 所有会话共用
  同一个 timeout 桶，`every: 5` 于是把第 2~4 次超时全部静音。现场表现正是"第二次停顿零痕迹"，
  极易被误读成"上界没触发"。timeout 改为 `every: 1` 逐次必报（每次都是用户白等一整轮；
  同一会话每个上界周期最多一条，量天然有界）。同一沙箱、同一配方、只改这一个数字做了单变量
  反证：`every:5` 复现零痕迹，`every:1` 打出 `#1` 与 `#2`。
- **上界监听挂错 signal**（第二条独立缺陷）：原先挂在 `deadline(upstream, …)` 的**融合** signal 上，
  于是"复用一个已 aborted 的 controller"会让融合 signal 一出生就是 aborted → 被判成"这不是我们的
  超时"→ **顺手撤掉 timer**，那次调用再也没有界（比原缺陷更糟：兜底被关掉）。融合 signal 中止后
  不再发第二次事件，"上游先中止 + 底层随后卡死"同样无界。现在超时权威是独立的 timer signal，
  交给生成链的才是 `AbortSignal.any([upstream, timer.signal])`，归属不再事后判断。

- **续写"变成回答"**（用户报：续写有时候怎么变成回答了）。两个成因叠加，各修一处：
  - *成因一（治本）*：`generateCompletion` 把「最近几轮对话 + 当前草稿」一起喂给模型，而
    `inlinePrompt` 只说 "predict the natural continuation"，模型把「上下文 + 用户刚说的话」
    读成「轮到我回应了」，于是去回答草稿里的问题。现在把三条生命周期事实**显式命名**：
    草稿是用户**尚未发出**的文字、上下文**只用于对齐术语与语气**、**绝不回答**其中的问题
    （新增 C6/C7/C8 条款；C1-C5 为既有五条约束，语义逐条保留）。条款改为 `C1.`-`C8.`
    编号锚点，`scripts/inline-prompt-smoke.mjs` 用集合精确比较把「一条都没被删」变成可断言。
  - *成因二（兜底）*：`shouldFilterCompletion` **刻意放行**问句与助手口吻（其注释与
    `inline-smoke` 的断言都钉着这个决定），所以回答在链路上无拦截。新增
    `shouldFilterCompletionFor(text, draft)`：原语义过滤 + 形态兜底
    （输出 ≥40 字 **且** > 草稿 × 3 → 判为对话式回答丢弃），单参版语义不变。
- 阈值不是拍的，两次都被自己的冒烟/复核抓回来：
  首版 8x → 冒烟当场漏掉实测的 `6→46`（7.7x）；改 5x 后复核发现仍漏 `16→67`（4.2x）、
  `34→135`（4.0x）、`22→79`（3.6x），且 `18→54` 恰好卡在等号上被 `>` 漏掉；取 3x 后
  拦下 8/42（5x 时 5/42）且正例全安全。数据源是同一次会话的 42 次 `completion generated`，
  字段只有长度（正文受隐私约束不落盘）：输出 min=2 中位=31.5 p90=67 max=135。
- 两条边界**明确留在"不拦"侧**并写进断言：输出 < 40 字不参与形态判定（`4→25` 这类 6.3x 放行，
  25 字中文完全可能是把半句写完）；恰好等于 3 倍不拦（等比例延伸是正常形态，不该因差一个字翻面）。
  取舍理由是不对称代价：漏拦可见、误杀与"没生成"同形（本仓库反复踩过的那类难查问题）。

- **「边打边等」不再被判失效**（用户实测：46 次停顿里 **45 次草稿长度都不同**）。原判据是
  `completion.draft === draft`（逐字全等），而续写是接在草稿后面的半句，用户在生成期间
  （中位 4.9 秒、最慢 17 秒）继续打字是最常见的用法 —— 全等判据把主路径整个判成了失效，
  用户看到的就是"等很久也不出东西"。用户当时靠**把等待时间调短**绕过，这是绕过不是修好。
  现在改为 `alignCompletion`：草稿未变或**以载荷草稿为前缀**都显示，并把你在末尾新打的、
  与续写开头重合的部分裁掉（已打出「构」→ 幽灵只补「建流程」）。
  只接受"你没改前面"的形态；**改中间/换内容/删末尾仍丢弃**（删字后光标位置无从得知，
  贴上可能错位 —— 宁可少显示，不可显错）。
- 判定与显示改为**共用同一次对齐结果**：早先这两处各写了一遍条件（`skipReason` 一套、
  显示分支一套），改动时极易只改一处（本仓库在别处踩过"两份真相互不约束"）。

### 文档

- 新增 `docs/internals-cordis-settings-pitfalls.md`：settings 双向通道与 volatile 引用的五条内核语义陷阱
  （`mutate` 的期望版本、TS 类型与 zod schema 漂移、单槽快照装不下一次性载荷、`apply(ctx, config)` 捕获的
  引用冻结、cordis 事件只向父传播），每条按「症状 → 根因 → 正确用法 → 错误用法 → 出处」写，并区分
  「已修」「待宿主验证」「内核契约」「仅本插件经验」
- 新增 `docs/upstream-feedback-settings-proxy.md`：#16 遗留思考的上游反馈草稿，**尚未提交给内核维护者**
- README.md / README.en.md 的「开发」章节各加一节「改双向 settings 通道前必读」，指向上面两篇文档

### 开发工具

- 新增 `scripts/artifact-freshness.mjs`：报告 `lib/` 是否比 `src/` 旧（2s 容差，避开 checkout 的
  毫秒级假阳性），以及 `<profile>/node_modules/dsh-suggest-ghost` 这条部署符号链接解析到哪个工作副本。
  多 worktree 并行时，只有链接指向的那一份会被宿主加载
- 新增 `scripts/gitignore-check.mjs`：查出「已被跟踪、但被 ignore 规则覆盖」的目录。这类目录里的新文件
  从此不进索引：文件在盘上、构建照常、`git status` 干净，而 `git checkout` 恢复不出来。判据用
  `git check-ignore --no-index`，缺 `--no-index` 时 git 会跳过已跟踪路径、恰好查不到这种状态
- 新增 `pnpm run check:loop`（两条体检一起跑）；`scripts/dev-loop-smoke.mjs` 用一次性 git 仓库断言
  上述判据，含「新文件 add 不进去」这条事故机制本身
- README.md / README.en.md 的「开发」章节各加一节，写清宿主加载哪份副本、以及改动到重启之间的落盘顺序

- README 中英版各加一节「宿主层改动怎么不重启就生效」：本 profile 把 `hmr.config.root` 合成成
  `[]`（只监听配置文件），而默认 `ignored` 里的 `**/node_modules` 又把 `link:` 形态的本插件排除掉，
  两层原因叠起来才造成「改宿主代码必须重启」。附可直接用的 `root/ignored/debounce` 片段、
  `--patch … --dump-config` 的免启动校验法，以及判据：`apply called; artifact mtime=…`
- `src/index.ts` 里「volatile 字段不落盘，故内存里没有跨进程残留」这条断言**是错的**，已按观测更正：
  `_ops`/`_push` 实际写在 profile 文档里，且一个复制该 profile 的新实例在没有任何客户端连接时就
  重放了遗留 `complete` 载荷。连带说明「消费后清空」为何长期失败、代价是什么

- 新增 `scripts/dev-sandbox.mjs`：一条命令拉起**隔离的第二个 DSH 实例**用于验证宿主层改动
  （`pnpm run sandbox` / `sandbox:check`）。隔离做在两层：`DSH_HOME` 独立（`sessions`/`storages`/
  `logs` 全部落沙箱），以及**插件产物独立**（私有 `lib/` 副本，其余依赖逐条软链，不跑 install）。
  后者是必须的：否则往沙箱里放未验证构建，会污染 live 宿主下次重启真正加载的那份 `lib/`。
  实测：父进程退出后子进程存活，改 `lib/index.js` 内容触发重新 apply（`apply called` 的 mtime 变）。
- 过程中钉住三件事：① profile 里 `dsh-host-webserver` 的 `port: 3081` 必须换掉，`--port 0`
  只管主 GUI 端口（不换会 `EADDRINUSE` → `webServer` 缺失 → 实例跑第一个 agent 回合时自行退出，
  我一度误判成"热重载杀进程"）；② `_push` 是跨 16 行的单引号标量，按行删会把它改坏（
  `stripKeyBlock` 按缩进整块删，`scripts/dev-sandbox-smoke.mjs` 反向验过：退化成按行删即报红）；
  ③ group 成员无法用 `--patch` 叠加层禁用（`webhook-webserver` 嵌在 `webhook-listener` 的
  `config:` 列表里，overlay 指 group 或叶子都不生效），所以走换端口而不是禁用
- 另两处自记的坑也写进了脚本注释：日志 fd 必须归子进程（父进程接管道则它退出后子进程写日志
  吃 EPIPE 而死）；`pkill -f` 的模式串会匹配到调用方自己的命令行

- 新增 `scripts/completion-align-smoke.mjs`（11 组）。写它的时候**连续抓到自己三处错**：
  ① `overlap` 计算里 `Math.min` 套 `Math.max` 无意义；② 多乘了一维"cur 与 cur+text 的公共
  前缀"，在"你打的字与续写无关"和"载荷草稿为空"两种情况下会误裁（冒烟当场抓到）；
  ③ 两条断言构造错误 —— 把"用户多打了一个与续写不重合的字"写成了"应当裁掉续写首字"，
  实际不裁才是对的。这三处都是实现/断言写错，不是需求变更。
- 顺带查实一个观测缺口：`src/client` 被根 `tsconfig.json` exclude，客户端走 esbuild
  **只转译不检查类型**，所以 `pnpm typecheck` 对客户端代码**没有任何约束**。
  `tsconfig.client.json` 是既有的诊断配置（注释里已写明"补齐两个 devDep 后可当门禁"），
  当前基线 40 条错误、尚未接入。本轮新代码在它下面只多出 1 条 **TS5097**（`.ts` 后缀导入），
  与同目录既有 9 处 import 完全同类，属既有配置缺陷的复制、非新类型问题。

### 变更

- `scripts/dev-sandbox.mjs` **通用化**：脚本本体不再含任何插件/本机专有字面量（代码区命中 0 处）。
  插件身份从 `package.json` 的 `name` 推导、profile 条目 id 用 `name: <包名>` 反查；原先硬编码的
  三样东西分别变成 `sandbox.rewrites`（整行替换 + 0 命中即拒启动 + 端口占用扫描）、
  `sandbox.disable`（顶层条目；group 成员无效这点写进 help）、`sandbox.greps`（验收读法）。
  易失载荷剥离也从"全局删 `_ops`/`_push`"改为**只删本插件条目名下的 `_` 前缀键** —— 全局删会
  顺手改掉别人条目的状态。`dev-sandbox-smoke` 从 5 组扩到 14 组，并做了两轮变异验证：忽略 entryId、
  把整行匹配放宽成包含匹配，都能报红（第一处变异起初漏抓，原因是 fixture 把别人条目排在了后面）

- **`inlineDelayMs` 默认值 800 → 100**（用户要求）。这个字段只决定"何时发请求"，不决定等多久：
  总等待 ≈ `inlineDelayMs` + 生成耗时。真实环境实测生成 **1.1~17 秒**（42 次：最快 1100ms、
  中位 4900ms、最慢 16986ms），所以 0.7 秒的差别在总时长里占比很小；代价是中文打字间隔常在
  0.1~0.3 秒，降到 100 后**几乎每敲一个字都触发一次 complete**，而单飞机制会 abort 掉在途生成
  （重启前实测：46 次停顿只产出 26 次生成）。**该值未经 A/B 对照实测**，是按要求改的产品决定；
  若后续发现 `completion preempted` 暴增而 `generated` 未涨，应回调。
- 该默认值**散在 5 处**（宿主 schema、宿主两处 `readVolatile`、客户端字面量与解析兜底）外加中英
  两处文档，各自写死、单独看都合法。新增 `scripts/inline-default-smoke.mjs`（3 组）把它们的一致性
  变成可断言的事：任一处单独改动即红（两个方向都做了变异验证）。它**不测"默认值应该是几"**
  （那是产品决定），只测几处彼此一致。
- 顺带修正 README 里两处**我此前写错的数字**：原文说生成"要 19~28 秒（隔离实例量到
  18971/24217/27793ms）"，那是**沙箱里另一个模型**的数字，被我拿去解释了真实环境。真实环境是
  1.1~17 秒。同时补上"已经到达的那份续写仍会按对齐判据显示，不再被丢弃"（#33 的行为）。

### 验证

- **#22 在 live 宿主结项**（2026-10-20 08:48 重启后，`apply called; artifact mtime=` 证明加载的是
  19 日 16:35 那份构建）。完整链路在真实环境读到：`completion generated` → `push refused inside
  settings transaction … queued carriedCompletion=1` → `deferred push landed … attempts=1`
  （37 次带续写的补写成功，平均 +1.2s，全部首次尝试即落）。`deferred _ops cleared after consume`
  85 次成功，而 live 旧行为是 0 次 —— 载荷不再长期滞留盘上。`live settings refreshed rev=…`
  也出现了（#19 的"改了有没有被重新读到"第一次在真实环境可观测）。
  唯一未补回的 `rev=41` 无用户可见影响：`bceac31` 的持续捎带让后续任何一次推送都自带同一份续写
  （其后 13 次补写落地、盘上 `_push` 现含 completion），等于这条通道对**单次推送丢失是自愈的**。
  这层作用是本次实测才发现的，此前文档只把捎带写成"解决瞬时载荷被覆盖"。
- 新增一节「内核代次与锚点位置」：本机内核已从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`，两处锚点行号漂移
  （`dsh-hmr` 的 ALS 三处 271/280/284 → 736/749/752；`dsh-app-boot` 的 exporter 4053-4066 →
  4513-4515），另三处未变（`dsh-settings` 435/509/511、`bin.js` 158）。因此本文与代码注释改为
  **按符号引用**，行号只在那一节维护一份。

### 实测事实（会改变结论的那条）

- **续写的耗时：两个环境差一个量级，别拿一个环境的数字解释另一个。**
  - 真实环境（2026-10-20，42 次生成）：**1.1~17 秒**，最快 1100ms、中位 4900ms、最慢 16986ms。
    这是用户实际体感的依据。
  - 沙箱隔离实例（同一台机器、另一个模型路由）量到 `in 18971ms` / `24217ms` / `27793ms`。
    **本文档早前把这三个数字当成"本环境的健康耗时"并据此解释用户现象，是错的** ——
    用一个环境的数字解释另一个环境，方向就偏了。
  - 20s 上界在沙箱环境确属**误杀**（现场出现过 `no settle within 20000ms … after 20001ms`，
    那是一次本来会成功的生成），故按沙箱实测最慢 ×1.5 取 **45s**，仍紧于内层单 attempt 的 60s。
  - 耗时与输出字数**不成正比**（132 字比 109 字快），固定开销主导，所以"按吞吐外推"这类取值
    算术作废。
  - live 那 25 次"消失"的主桶是 `completion-preempted`：在途生成（当时以为 19~28s）长于连续
    打字时两次停顿的间隔，每次新停顿都会中止上一次的请求 —— 真实环境虽只有 1.1~17s，
    但玩家边打边等时这个竞争依然存在，这正是后续改用**前缀对齐**（见「修复」）而非放宽阈值的原因。

### 已知缺口

按当前代码状态核对过；下面每条都还成立（原先列在这里的四项已关掉，故移除：「#17 留痕被删」与「#16 写后读回」
由 `89d3a1a`/`81778cf` 完成、「schema 变体覆盖无断言」由 `b947977` 的冒烟挡住、
「#21 运行时归因」由隔离实例实测完成 —— 它是测量结果不是代码改动，所以没有对应 commit）：

- **宿主侧 settings 写面普遍没有 CAS**：`ctx.settings.update(ns, patch)` 的第三参
  `expectedRevision` 在本插件所有调用点都没传，而内核判据是 `expected !== void 0`
  （`dsh-settings/lib/index.js:511`）——`expected` 缺省时**整段冲突校验被跳过**，调用必然"成功"。
  唯一带真实 CAS 的是 `remote.settings.mutate` 那一次 `_ops` 写。设置卡片的
  `remoteSettingsScope().set`（`src/client/index.ts`）同样忽略 `mutate` 的 `ok`：保存冲突时卡片
  显示成功，随后被下一次 `readValue()` 静默改回
- **续写投递是"排队补写"而不是根治**：被事务拒绝的写入交给 apply() 期 pump 补投（最坏 +500ms），
  根治要内核提供事务外退出（`executing.exit()` 一类）或把 `document-updated` 改成事务外 emit，
  见 `docs/upstream-feedback-settings-proxy.md` 第二诉求。另有一个未修的 sub-tick 竞态：pump 取走
  旧载荷在途时来了更新载荷，旧的仍会落一次盘再被新的覆盖；根除需要 `_push` 写入带 revision CAS
- **#4 的残余窗口**：宿主把编辑器提交批处理在 store 发布之前时，`draft` 与 `draftRev` 会一起是
  旧值，内容/版本比对都看不出漂移。闭合要宿主把 `captureInsertion()` + `insertText(text, span)`
  交到插件手上（采纳是整段替换，用 span 反而引入新的坐标系假设，理由写在 `accept-guard.ts`）
- **`GhostPushPayload` 是第二份会漂移的真相**：它从未被用作类型约束（全仓只在注释里出现），要让它
  受编译器管得先把 `src/index.ts` 里那个局部 `ClientPush` 提升为导出类型再派生 —— 跨 3 个文件的
  结构性改动，且会立刻把"宿主写 `error` 字段、客户端解析结构里没有它"变成显式契约问题
- **#19 的逐项人工确认**：`live settings refreshed` 已实测到，但设置页各开关（停顿续写 / LLM 建议 /
  阈值 / top-K 含 0=不限 / 冷启动对账 / 热度面板）仍需 live 宿主重启后按 issue #19 清单逐项过一遍
- **运行期日志通道只有 stdout**：健康进程里 `ctx.logger` 不落任何地方（exporter 只收 warn/error，
  且 `startupLogs` 只在启动失败时写盘），而 `console.log` 又是 `6dfcd78` 那类"清理调试噪声"的
  删除目标。本插件用固定标记 `[dsh-suggest-ghost][ops-trace]` 区分语义留痕与调试噪声，但通道本身
  的缺失是平台问题，语义留痕长期该有正式落点

- **排水锚点不是无条件可靠**：live 出现 3 次 `deferred push write refused again in the apply()-time
  pump … pump context is inside a transaction`，其中 2 个载荷 8 次尝试耗尽后丢弃（都是
  `carriedCompletion=0`，即非续写载荷）。含义：`apply()` 期建定时器"在事务外"这个前提在**内核反复
  重载 profile 条目**时会失效（本机同时刷了 2290 行 `webhook@0.2.0-rc.2 incompatible with
  dsh 0.2.1-rc.2` → 条目被反复禁用/重载）。所以锚点只在干净 boot 后稳定，靠它兜住一切写入是过度信任；
  根治仍是诉求二（`document-updated` 改到事务外 emit）

## [0.5.0] - 2026-10-10

### 新增

- **语言检测增强**：`suggestionLanguage` 先去噪（移除代码块/URL/路径），再按文字系统字符数统计主导语言，避免代码里的 CJK 字符误导判断
- **历史补全定位改进**：锚定到 DOM 量出的草稿行尾，修复垂直偏移（行高居中补偿）
- **设置卡片增强**：新增 `select` 控件类型、`language` section、更多可调字段（`maxInputBytes`、`maxOutputTokens` 等改为 writable）

### 改进

- **配置重构**：`StrategyFields` 合并到 `EditableFields`，全部标 `.volatile()`，统一走 WebUI 表单
- **热度淘汰优化**：`MinSeqHeap` 按 `(seq, count)` 双键排序，高频条目保留更久（如 ×21 的常用短语比单次条目存活更久）
- **文本排版属性**：ghost overlay 完整复制 30+ 项 CSS 排版属性（font-variant-*, text-rendering 等），长建议换行与编辑器一致

## [0.4.1] - 2026-10-10

### 修复

- **建议语言支持西里尔文字（俄语等）**：`suggestionLanguage` 新增 `hasCyrillic` 检测，俄语用户不再收到英文建议（[GitHub #1](https://github.com/dsh-plugins/dsh-suggest-ghost/issues/1)）
- 非 CJK/非西里尔文字回退到「镜像用户语言」指令，覆盖所有文字系统（法语、德语、西班牙语、阿拉伯语等）
- 新增冒烟测试覆盖多语言场景

## [0.4.0] - 2026-09-29

### 重大变更

- **适配 DSH 0.1.7+ volatile 配置体系**：`settings.yaml` 已被上游移除，本插件改用 `ctx.settings.update` + `settings/document-updated` 事件通道；策略字段（`maxInputBytes`、`maxOutputTokens` 等）保留在 Config 中由 `cordis.patch.yml` 控制，可调字段改走 volatile 存储
- **支持五代内核**：peer 依赖从两代扩展到五代（`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.3`、`0.1.7-rc.2`、`0.2.0-rc.2`）；`0.2.0` 起 peer 不满足会在加载期硬拒绝，必须枚举对应代次

### 新增

- 设置卡片改为 section 分组表单布局（LLM / 历史 / 热度管理），对齐官方 SettingsForm 视觉
- 新增「在设置中显示」开关（仅详情页），控制设置对话框中是否出现本插件设置页
- 新增帮助按钮（字段级说明，aria-expanded 切换）
- 新增 `icon.svg` 插件图标
- 新增 `ghost-geom-smoke.mjs` 冒烟测试（overlay 定位几何验证）
- 新增 `settings-scope.ts`（client 侧 scope 最小面类型，适配 0.1.7 移除的旧 scope）
- 新增 `styles.ts`（样式从卡片组件抽取，`sgc-` 前缀防冲突）
- 每会话建议表（`suggestionBySession`）替代单槽，多开会话互不干扰
- 新增 `cosmokit` 依赖（上游 settings 事件类型来源）

### 修复

- 设置卡片「显示设置」section 补上 i18n（中英双字典），英文界面不再残留中文

### 已知取舍

- 升级到 `0.1.7+` 后旧设置不自动迁移（volatile 字段不落盘），需按默认值重设一次
- 重启后上一条建议需要重新生成（新回合跑完即恢复）；历史前缀补全与热度面板照常可用

## [0.3.0] - 2026-09-16

### 新增

- **冷启动语义改造**：重启后不再「没有数据」
  - 改「时间」判据为**语义**判据：启动时回读盘上残留并校验，有效则原样恢复
  - 可判定为陈旧则清场；会话尚未进店时不猜测、不覆盖
  - 会话活跃期间由 `session/event` 增量维护
- 日志取环种子、回合语义校验、`_push` 回读
- 热度持久化语义（storage 域、回合边界合并落盘、重启恢复合并）
- 双语 README 重写（提升插件商城可发现性）
- AppStore 风格截图声明

## [0.2.1] - 2026-09-14

### 修复

- 修复幽灵文本重叠问题
- 修复 placeholder 让位逻辑

## [0.2.0] - 2026-09-04

### 新增

- 初始发布：LLM 下一条建议 + 历史前缀补全
- 热度管理（跨会话高频短语）
- 设置卡片（中英双语）
