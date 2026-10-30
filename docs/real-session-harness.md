# 真会话 harness：在隔离沙箱里驱动一个真回合（#69 / task-20）

**结论先行**（2026-10-22 更新，实测在下文 §8）：**长驻沙箱 + Playwright 这条路已经打通**，
三处 NOT-COVERED 里 —— #56 的双端偏斜（新宿主 + 真旧客户端）与 #67 的「真实 DOM 呈现」两条
**已拿到真实验证**；#63 的「让路在真实宿主里的比例」**仍未覆盖**（本轮跑到的是 0 次让路，
原因见 §8 末）。

两条生命周期完全不同的驱动方式，选型时别混：

- **`dsh headless`**：能挂插件、能跑真回合、能验「事件到不到插件」与启动判定；**测不到写**
  —— 它在 `turn/end` 之后立刻 flush + 退出，插件回合后的那次异步建议生成拿不到执行时间（§5 探针实证）。
- **沙箱 web 实例 + Playwright**：长驻 ⇒ 写侧、DOM 侧、旧客户端侧全都可验（§7 配方、§8 结果）。

三处待替掉的 NOT-COVERED 与它们现在的前置状态：

| 待验项 | headless 够不够 | 缺什么 |
|---|---|---|
| ① #67 浏览器级三项 | **已验 2/3**（§8）：真实 DOM 里幽灵的呈现 + `客户端写→宿主写→广播回客户端` 的真实节律都拿到了；**「空正文的终帧在真 DOM 里长什么样」仍未验**（需要往 `suggestGhost` 投影里种一份 `text:""` 的终帧） | 缺一个可控的投影写入面 |
| ② #63 的两条 | **未验**：本轮两次建议格写、一次热度写，`hot push yielded on input` **0 次** | 让路要求「pull 落在热度合并窗口内」，本轮时序没撞上（§8 末） |
| ③ 双端偏斜真双进程 | **已验**：新宿主 + **真旧客户端**（`99a478c^1` 的 `lib/client.js`，0 处 `_residual`）连跑两轮，`_residual` 字节不变、旧客户端照常渲染幽灵、宿主零报错 | — |

---

## 1. 挂插件：三个前置，不是两个

上一轮任务书写了「`--patch` 加条目 + `node_modules` 能解析到包」。**第一条是错的**，实测：

- `dsh --profile headless --dump-config` 顶层条目数：**无 patch = 98 / 带 patch = 98**，且
  `grep "id: suggest-ghost"` 无输出 ⇒ `--patch` 叠加层只**覆盖已有条目的配置**，不会新增插件条目
  （`dsh` 启动器把 patch 当作 profile 之上的层，条目集合由 profile 自己的 bundle 列表决定）。

真正的开关是 **profile 的 `package.json → dsh.profile.bundles`**：

```bash
# live web profile 里有这一项（所以它加载本插件）；headless 没有：
node -e "console.log(require(process.env.HOME+'/.dsh/profiles/web/package.json').dsh.profile.bundles.includes('dsh-suggest-ghost'))"   # true
node -e "console.log(require(process.env.HOME+'/.dsh/profiles/headless/package.json').dsh.profile.bundles)"
# [ '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless' ]
```

三个前置一起满足才加载：

1. `dsh.profile.bundles` 里有 `dsh-suggest-ghost`；
2. 该 profile 的 `node_modules` 能解析到包 —— 用软链，**不要 install**：
   `profiles/headless/node_modules/dsh-suggest-ghost → <沙箱>/plugin`，
   并把 hoisted 的 `profiles/node_modules` 整体软链过来（deps 都在那一层）；
3. `--patch` 只用来改**已存在条目**的配置（例如把 `disabled` 翻成 false、改 `llmEnabled`）。

⚠️ 另一条容易看错的：**live 宿主当前根本没跑这条插件** ——
`~/.dsh/profiles/web/cordis.patch.yml:712` 是 `disabled: true`，而
`node_modules/dsh-suggest-ghost` 的软链仍在。⇒「宿主加载的是主仓」成立，但
**加载 ≠ 启用**；任何「去 live 宿主看真实留痕」的路径都是空的，验证必须自己 enable。

## 2. 凭据：headless 的 provider 面比 web 薄

- headless 栈里 `llm-pi-ai` 条目**没有 providers 配置**（`--dump-config` 该块为空），
  `deepseek-official` 路由存在但直接报：
  `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`
  —— 尽管 `~/.dsh/.credentials.yaml` 的 `refs:` 里就有 `DEEPSEEK_API_KEY`。
  也就是说 headless 这条路径不吃那份 ref，只认**进程环境**。
- 可复跑做法（**只把值送进子进程环境，任何时候都不打印**）：

  ```bash
  export DEEPSEEK_API_KEY=$(awk '/^  DEEPSEEK_API_KEY:/{sub(/^  DEEPSEEK_API_KEY: /,"");print}' ~/.dsh/.credentials.yaml)
  test -n "$DEEPSEEK_API_KEY" && echo "已注入（长度 ${#DEEPSEEK_API_KEY}）"   # 只报长度
  ```

- 别试 `opencode2dsh` / `qoder-route`：`dsh --profile headless` 会报
  `NO_ADAPTER: no adapter registered for provider "opencode2dsh"` —— 那些 adapter 是 web profile
  挂进来的，headless 的 bundle 栈里没有。

## 3. 可复跑配方（headless，真回合）

```bash
SBX=~/dsh-sbx-realsession
cd <本仓某棵 worktree>                       # 主仓是 live 宿主加载的那份，不要在里面构建
./node_modules/.bin/tsc -p tsconfig.json && node build.mjs
node scripts/dev-sandbox.mjs --home "$SBX" --check          # 建沙箱：私有产物副本 + 凭据副本
# 建 headless profile（沙箱内，不碰 live）
cp -r ~/.dsh/profiles/headless "$SBX/profiles/headless"
rm -rf "$SBX/profiles/headless/node_modules"
ln -sfn ~/.dsh/profiles/node_modules "$SBX/profiles/node_modules"
mkdir -p "$SBX/profiles/headless/node_modules"
for e in ~/.dsh/profiles/web/node_modules/*; do
  ln -sfn "$(readlink -f "$e")" "$SBX/profiles/headless/node_modules/$(basename "$e")"
done
ln -sfn "$SBX/plugin" "$SBX/profiles/headless/node_modules/dsh-suggest-ghost"
node -e "const fs=require('fs'),p='$SBX/profiles/headless/package.json',j=JSON.parse(fs.readFileSync(p));
  j.dsh.profile.bundles.push('dsh-suggest-ghost'); fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n')"
# 跑一个真回合（凭据按上一节注入）
cd /tmp && mkdir -p real-session-ws && cd real-session-ws
DSH_HOME="$SBX" dsh --profile headless "只回答一个字：好。不要调用任何工具。" 2>&1 | tee /tmp/headless.log
grep -c "dsh-suggest-ghost" /tmp/headless.log
# 收尾（必须做：目录里有凭据副本）
rm -rf "$SBX"
```

## 4. 实测拿到了什么（本轮，一次真回合）

宿主 stdout（**长驻无关**，插件确实起来了）：

```
[dsh-suggest-ghost][ops-trace] apply called; artifact mtime=2026-10-22T03:29:01.359Z
[dsh-suggest-ghost][ops-trace] persisted push read source=startup present=0 turn=n/a baseSeq=n/a chars=n/a
[dsh-suggest-ghost][ops-trace] live settings refreshed rev=0 applied=25
好
```

会话日志（`zstd -dc sessions/<ws>/<session>/session.v4.jsonl.zstd`）证明这是一次真回合：
18 类事件、`request/header` 1、`user/message` 3、`assistant/message` 1、
**`turn/end` reason `{"kind":"completed"}`**。热表落盘：`storages/suggest_ghost_hotness.json`
条目数 1 ⇒ `user/message` 确实进了插件的事件面。

## 5. 为什么「写」测不到（实证，不是推断）

在**沙箱私有副本**（仓内一字未改）的 `handleTurnEnd` 首行插一条探针，跑完得到：

```
[ghost-probe] HT ENTER turn=1        ← 接线层的回合结束处理确实进来了
（无 HT GENERATED、无 suggestion generated / dropped / failed、无 push landed / hot push landed）
```

且整场跑完盘上三格计数为 0：`grep -c "^  _push:"` / `_hot` / `_ops` 全是 **0**。

原因在 headless 自己的文档里（`@deepseek-ai/dsh-headless/lib/index.js:28-34`）：
「drives the task to quiescence, flushes its Session, prints the final assistant text to stdout,
**and exits**」；它的 `Config` 只有 `task` / `sessionId` / `json` 三个字段，没有 keep-alive。
⇒ `turn/end` 之后插件起的那一次异步建议生成（实测要 0.8s～30s）被进程退出截断。

**⇒ 结论：headless 适合验「插件挂没挂上、事件到不到、启动回读判定对不对」；
不适合验「宿主写了什么、写几次、让不让路」。** 后一类必须换长驻宿主（web profile）+ 客户端驱动，
那也正是 #67 与 #56 遗留边界 2 需要的同一件前置。

## 6. 安全与收尾（本仓口径）

- 主仓 `<repo>` 是 live 宿主加载的那份：只读，
  不在里面改或构建；所有构建与实例都在 worktree / 沙箱目录里。
- 起实例前先 `ss -ltnH "( sport = :<port> )"` 确认端口空闲；用完 kill，**并删沙箱目录**
  （里面有 `.credentials.yaml` 副本）。本轮结束时 `~/dsh-sbx*` 残留数 0、无监听端口、无进程。
- 凭据只读键名，不打印值；日志里出现长 token 时先掩码再看。
- `scripts/dev-sandbox.mjs` **不带参数就会启动真实实例**：批量跑 `scripts/*.mjs` 时必须排除它。

### 6.1 沙箱会留下**两处**东西（Gitea #72 的口径）

| 位置 | 是什么 | 怎么没的 |
| --- | --- | --- |
| **沙箱目录** `--home`（默认 `~/dsh-sbx-<entry>`） | 实例的 `sessions`/`storages`/`logs` + **一份 `.credentials.yaml` 凭据副本** | 收尾命令删；或手工 `rm -rf` |
| **工作区** `--ws`（默认 **`<--home>/ws`**） | 给 client「工作区选择器」用的夹具目录。旧默认在 `~/dsh-sbx-<entry>-ws`，**不在** `--home` 里 ⇒ `rm -rf` 沙箱带不走 ⇒ 每次用完都留一个目录，**里面可能有凭据副本** ⇒ 「清掉了还会再长出来」的根因之一 | 工作区默认收在沙箱目录**内部** ⇒ 删沙箱目录就一并带走 |

⇒ **一条命令的收尾步骤**（停实例 → 枚举残留 → 能删的删 → 残留自检）：

```bash
node scripts/dev-sandbox.mjs --cleanup
```

它的输出**逐处**说明动了哪里：删了哪几处、哪一处**没删**以及为什么。只想看残留、不删东西：

```bash
node scripts/dev-sandbox.mjs --residual     # 只读自检：与 --cleanup **同一份枚举** ⇒ 结论与退出码一致
```

⚠️ **工作区不一定在 `<home>` 里**（#83）：历史遗留的 `~/dsh-sbx-<entry>-ws`、或显式
`--ws <dir>` 指到别处，都是真实用法 ⇒ 所以收尾命令**不许**认死 `<home>/ws`。现在它按
**三处来源**找工作区：① 沙箱目录里 `.dsh-sandbox-home` 记着的**真实路径**（建沙箱时写的）、
② `<home>/ws`、③ 家目录下的 `~/dsh-sbx-*-ws` 通配兜底 ⇒ **每一处都过同一道闸门与护栏**
（脏的/认不出的 ⇒ 不删 + 报出 + 退出码 1）。

⚠️ **报告与能力必须一致**：凡是没有删掉的每一处，输出都要写清「**这条命令不会删它**，
原因 X，删除方式 Y」⇒ **不许**留「报了残留却退出码 0」那种自相矛盾的形态（那正是 #83 的现场：
报出 `~/dsh-sbx-yield-ws` 却清不掉、还报「清理成功」）。⇒ `--residual` 与 `--cleanup`
共用**同一份枚举与判定**，两者的结论与退出码因此一致。

⚠️ **不许删别人的工作区**：`--cleanup` 删工作区前必过**三道闸**——**确实是本沙箱建的**
（本脚本的标记文件，或空仓签名：目录里**只有** `.git` 外加可选的标记文件）+ **干净**
（`git status --porcelain` 为空；**只有同名**的标记文件才算那个标记，别名不算）+ **里面没有
别人的东西**（无提交历史、无远端、无凭据副本）。过不了就**不动并明确报出来**（退出码 1，
不静默跳过）；凭据只读键名，不打印值。工作区默认在沙箱目录**内部** ⇒ 它脏的时候
**连沙箱目录也不删**（删它等于间接删掉别人的工作区）。

⚠️ **fail-closed**：删的可是**带凭据副本的目录** ⇒ 任何**查不出来**的情况一律判
「无法确认 ⇒ 拒绝删除」，绝不当成「干净」。「空仓签名」因此用**文件系统**判定（不问 git），
「有提交」也用文件系统判定（`refs/heads` / `packed-refs`）；`git status` 抛错（index.lock、
索引损坏、权限）⇒ 判「无法确认」⇒ 拒绝删除。方向只能是「多留一个目录」，不能是「删掉别人的东西」。

⚠️ **删除护栏**：`--cleanup`（以及启动期那次重建）删沙箱目录前先证明「删的是沙箱自己的目录」
——不是主目录本身、不是 `~/.dsh`、也不是 `~/.dsh` 的**祖先**目录、不是仓库目录，且要么是
`--home` **显式给出**的、要么**正好等于**默认的 `~/dsh-sbx-<entry>`。任一条不满足 ⇒
**直接拒绝、一个字都不删**、退出码非 0。

## 7. 长驻沙箱 + 浏览器的配方（§8 的结果就是这么跑出来的）

```bash
SBX=~/dsh-sbx-realsession
# ① 先建沙箱（--check 只建目录不启动；它会 rmSync 重建，所以**补丁要打在这之后**）
node scripts/dev-sandbox.mjs --home "$SBX" --rewrite 'port: 3983=port: 4112' --check
# ② 沙箱 profile 里把条目 enabled，并种一条「属于没进店会话」的残留样本（照 live 那条的形状，
#    正文用自编文本，不抄真实数据）：config 下加
#      _push: '{"rev":35,"suggestion":{...,"turn":39,"baseSeq":1976,...},"suggestionSessionId":"session-not-in-sandbox"}'
# ③ **用 --deploy 启动**：`--deploy` 不 rmSync、不重拷凭据 ⇒ ②的补丁不会被冲掉（不带它就会被重建抹掉）
node scripts/dev-sandbox.mjs --home "$SBX" --rewrite 'port: 3983=port: 4112' --deploy .
# ④ 端口以**日志里那行 `dsh web:`** 为准：本轮 `--rewrite` 把 profile 里那条改成了 4112，
#    但 app 自己仍在 33899 上服务 GUI（`ss -ltnp` 按 pid 核）。⇒ 别拿 rewrite 端口当实例端口。
# ⑤ Playwright 打开 `dsh web:` 给的 URL+token（**绝不碰 3080**）：选工作区 → 输
#    一条短消息 → 等 `turn/end` → 读 `logs/sbx.log` 的留痕 + 盘上四格。
#    ⚠️ 目录选择器里输入路径后要**按一次 Enter**，「打开」按钮才 enable（直接点会 timeout）。
# ⑥ 收尾：`kill $(cat "$SBX/sbx.pid")` → 确认 `ss` 端口释放 → `rm -rf "$SBX"`。
#    ⚠️ dev-sandbox 还会在 **`~/dsh-sbx-<entry>-ws`** 建一个 git 工作区目录（默认名不带
#    `--home` 的信息），它**不在沙箱目录里**，`rm -rf $SBX` 不会带走它 —— 本轮残留的
#    `~/dsh-sbx-suggest-ghost-ws` 就是这么来的（无凭据、空 git 仓，已删）。
```

旧客户端那半边（③）：把沙箱私有副本的产物换成改动前的版本即可，**不用重启宿主**
（`lib/client.js` 按请求给客户端，页面重载就生效）：

```bash
git show 99a478c^1:lib/client.js > "$SBX/plugin/lib/client.js"   # 0 处 `_residual`，就是「完全不认识这个键」
# 浏览器 reload 即可
```
- **清理命令会杀掉执行它自己的 shell**：`pkill -f "cdp-yield"` 的模式串出现在同一条命令行里
  ⇒ pkill 匹配到执行这条命令的 bash ⇒ 后面的命令全没跑（本轮踩了**两次**）。
  ⇒ 教训的形式要说准：**不是「别把模式串和命令行共串」，而是「选一个不可能匹配到执行它的
  shell 自身的模式」** —— 例如把其中一个字符写成字符类：`pkill -f "hot-yield-[_]ratio.mjs"`
  （bash 自身的命令行里是字面 `[_]`，匹配不到自己）。按 pid 文件杀更稳。
- **GUI 的受控输入框吃不下页内合成事件**：`el.textContent = …` / `dispatchEvent(new InputEvent)` /
  甚至 `Input.insertText` 都进不了 React/Lexical 状态（表现：值看起来进去了，提交按钮仍 disabled、
  草稿长度恒 0）。可靠做法是 `Input.dispatchKeyEvent` 逐字符发 **keyDown + char + keyUp**
  （只发 keyDown/keyUp 不插字），并且**每次发完回读**（`textContent.length` / `value.length`）自证。
- **沙箱里有个自己会说话的噪声源，且关不掉**：`auto-continue`（日志实证
  `[auto-continue] 已自动发送「继续…」`）会**自己往会话里发消息**，它的回合末尾照样写热度、
  照样把合并窗口打开。它**不是 profile 的顶层条目**（`grep -i continue cordis.patch.yml` = 0 命中），
  是 bundle 带进来的 ⇒ `--patch` 对它无效。
  ⇒ 处理它**有两条路，先走第一条**：
  ① **先确认能不能盖掉**：它虽然由 bundle 带入，但在 composed 配置里是**顶层条目**
     （`dsh --profile web --dump-config` 里 `- id: auto-continue`；profile 文件里出现 0 次）
     ⇒ **profile 层加一条 `disabled: true` 就能盖掉**（`--patch` 也能）。本文件的 `--burst2` 默认就这么做。
  ② 盖不掉或不该盖时，才按归因排除：要求"开窗口那次写"的 `rev` 紧跟**我自己发起**的那次动作
     （如我点出来的那次 `ops consumed: pull`），并检查两次写之间没有第三者插进来。
  ⚠️ 别把"排除"当成默认立场：`auto-continue` 也是**一个真实的热表消费者 + 新鲜热度的消费者**，
  让路在它开的窗口上照样触发，正是这段代码该有的行为（谁先把窗口打开不重要，谁下一个来读
  就该拿到当前值）。所以它既是可以排除的噪声，也是**第二种真实形态**——两种读法都要报。
- **留在插件详情页时 composer 不会被 attach**：`[data-composer-input]` 还在、`data-phase` 甚至是
  `plain`，但插件没 attach ⇒ 打字与回车**根本不进宿主**（本轮两次 60s 超时就是这么来的）。
  ⇒ 编排前必须先把主视图拉回来（点「新会话」）并做一次**提交冒烟**，别拿超时当数据。

⚠️ 这里有个容易记错的点：`99a478c` 不是 #64 的合并提交（它是 **#59** 的合并），
它的一父 `88ee440` 才是「残留工作之前」的产物 —— 用 `99a478c^1` 恰好落在那一侧。

## 8. 真实宿主验证结果（2026-10-22，一次跑、两轮回合）

**启动判定（种进去的残留）**——两行都在，判成「未判定」而不是「判废」：
```
persisted push read     source=startup reason 无        present=1 turn=39 baseSeq=1976 chars=8
persisted push deferred source=startup reason=session-unavailable turn=39 baseSeq=1976 chars=8
persisted push deferred source=pull    reason=session-unavailable …      ← 别的会话 pull 时仍判不了、不动盘
```

**写侧（真宿主，非离线 harness）**：
```
push landed rev=36 … deferred push landed rev=36 carriedCompletion=0 after=439ms attempts=1
push landed rev=37 bytes=193 writeMs=214 hotBytes=146 cells=both
suggestion generated ×2、push landed ×2（都 cells=both）、hot push landed ×1、deferred push landed ×1
hot write refused ×1、push write refused ×1、_ops clear refused ×1 → 全部由事务外补写救回
```

**#56 的正面结论（这条以前只是推断）**：第一轮建议落地之后，盘上
```
_push     rev=37 → 38   归属=本次会话   建议 8 → 10 字      ← 建议格正常被新内容重写
_residual 177 字节       turn=39 baseSeq=1976 归属=session-not-in-sandbox   ← 原样还在
```
⇒ **未判定的残留在真实宿主里被自己的格子保住，别的会话的写盖不掉它**；而且它是在
`push landed` 那**同一笔** patch 里落地的（懒搬迁生效）。

**#67 的 DOM 侧 + 真实节律**（旧客户端期间）：
```
overlay 存在=true  display=block  data-shown="1"  文本 8 字  data-reject=null
composer 存在=true，宿主日志期间 error 计数 0
```
⇒ 「客户端写 `_ops` → 宿主写 `_push` → 广播回客户端 → 渲染成幽灵」这条真实节律在真浏览器里跑通，
并且是**旧客户端 + 新宿主**同时成立（③的旧客户端半边与①的 DOM 半边一次验掉）。

**② 仍未覆盖，原因具体**：两次建议写、一次热度写里，`hot push yielded on input` **0 次**。
让路的条件是「pull 落在热度合并窗口（1000ms）之内」；本轮 pull 只发生在页面加载那一拍，
距上一次热度写早已超过窗口 ⇒ 结构性撞不上。**要量真实比例，需要「一次纯热度变化后 1s 内
再来一次 pull」的编排**（例如发送后立刻切会话再切回），这属可做的下一步，但本轮没做，
不拿「窗口逻辑单元测过」顶替。

**① 还剩一项没验**：空正文的终帧在真 DOM 里到底画成什么（会不会出现「幽灵没画、占位文案被藏」）。
需要往投影里种一份 `text: ""` 的终帧再观察；本轮没有做，**不当已验**。

## 9. 还没做完的（这条页的诚实边界）

- ① 的「空正文终帧在真 DOM 的呈现」、② 的「真实宿主里的让路比例」两项仍未验（各自原因见 §8 末）。
- 支持性推断与验证要分清：「`_residual` 是宿主自用格 ⇒ 旧客户端会忽略」是**推断**；
  §8 里那条装旧客户端跑两轮、`_residual` 字节不变的观察才是**验证**。

## 10. #67 空正文终帧的真 DOM（2026-10-22 第二次真跑，结论：**当前架构下双重不可达**）

做法：先跑一个真回合物会话有 `turn=1 (completed)`，杀掉宿主，往沙箱 profile 的 `_push` 里**手写一份**
`{suggestion:{version:1,turn:1,baseSeq:12,text:"",truncated:false,acceptKey:"Tab",frame:1,final:true},
suggestionSessionId:<那个会话>}`，重启并打开该会话（触发 7 次 pull）。

**宿主侧实测**：
```
persisted push read   source=startup present=1 turn=n/a baseSeq=n/a chars=n/a
persisted push skipped source=startup reason=corrupt-payload turn=n/a baseSeq=n/a chars=n/a
```
⇒ 空正文根本进不了恢复链：`parsePersistedPush` 在结构层就把 `text === ''` 判成「没有建议」
（`src/coldstart.ts:234`），于是 `decidePersistedPush` 走 `suggestion===null && sessionId!==null`
那条 ⇒ 归为 `corrupt-payload` 并**跳过、不动盘**。
另一半不可达是产出侧：`generateSuggestion` 在「空/被过滤」时返回 `suggestion: undefined`
⇒ 载荷里写的是 `suggestion: null`（`buildPushPayload` 的 `p.suggestion === null ? null : …`），
所以**宿主自己永远不会发一份 `text:""` 的终帧**。

**真实 DOM 侧实测**（Playwright，会话视图下）：
```
overlay 存在 = false        ← 连节点都没挂上
placeholder display=flow-root / visibility=visible / opacity=1
console error 计数 = 0（该页 1 条 error 与插件无关，宿主其它面）
```
⇒ **#53 遗留的「空正文会不会画一枚空幽灵并把占位文案藏掉」这条 NOT-COVERED 可以收口**：
在真实宿主 + 真实浏览器里，那种空白输入框**没有出现**，而且原因不是"运气好"——是
产出侧与回读侧**两条都把它挡住了**。

⚠️ 一处**留痕措辞**的小问题（不改行为，交给 lead 定）：`reason=corrupt-payload` 被用来描述
「结构合法但正文为空」这种情况。它不是载荷坏了，是「没有内容」。要么在 `parsePersistedPush`
里把 `text === ''` 与「字段类型不对」分开归因，要么把这条留痕的理由改名 —— 现在这样会让人
以为盘上载荷损坏（进而去怀疑写盘路径）。

## 11. #63 让路比例：本轮**仍未量到**，且原因结构性（不拿推断顶替）

同一轮日志的计数：
```
ops consumed: pull   7     push landed  6     hot push landed  3
hot push coalesced   0     hot push yielded on input   0     ops consumed: complete   0
```

读代码后能确定**为什么正常操作量不到**：`hot push yielded on input` 要同时满足三件事
（`src/index.ts` 的 `complete` 分支）。**下面这版是更正过的**（第一版把第 2 条写成「槽里还攒着
一份没落地的热度快照」——那是 `coalesced` 的窗口侧现象，**不是**让路的触发条件）：

1. **窗口开着**（`hotWindowOpenedAt !== null` 且 `decideHotPush(now)` 判 `defer`）——即 1000ms 内
   刚写过热度格；
2. **这一次 flush 真的带走了热度格**（`lastFlushWroteHot`）——即此刻热表相对上次落地是**脏**的；
3. 这一拍来的必须是 **`complete`** op（用户打了 ≥`inlineMinChars` 个字符并停顿）。

⇒ 让路**不需要 pending 队列参与**：不要求曾经有一次推送被窗口推迟过。
单会话正常使用凑不齐的是 **1+2 同时成立**：窗口开着的那一刻，往往正是上一次热度刚落地的时刻
⇒ 热表还没变化 ⇒ 第 2 条不成立 ⇒ **让路没有对象可带**（这才是「分母为 0」的正确归因，
而不是「窗口从未攒出快照」）。
⇒ **量比例需要一次刻意的三方编排**：
`pull`（arm 窗口）→ 立刻改一次热表（管理面板 add/delete ⇒ 制造 pending）→ 1s 内在输入框打出
≥4 个字符并停顿（`complete`）。**本轮没做这条**，因为三步要在 1s 内完成，而我这边每一次
浏览器调用往返就是数秒级 ⇒ 只能写成一次 in-page 脚本化编排（`page.evaluate` 里连做 click +
输入 + 停顿），那是下一条线的活，不是本轮能靠多试几次绕过去的。

⇒ 本节当时得到的结论是「分母为 0、比例无从谈起」；**§12 的连发编排把它推翻了**：
按上面更正过的条件造出 1+2 之后，让路在真实宿主里**第一次真的执行了**。两节合读以 §12 为准。
离线侧 `scripts/hot-yield-smoke.mjs`（**断言 6** 钉住判据③前半句：让路写次数 ≤ 待写变化数；
**断言 3** 钉后半句：无待写时不写）继续钉着性质，
但**那不等于真实比例**，两件事在 tracker 上别合并。

## 12. #63 让路比例：脚本打通了真实宿主，但**量出来的分母是 0**（这是数据，不是失败）

驱动：`scripts/hot-yield-ratio.mjs`（task-22）。零依赖：自己起沙箱、自己读 `logs/sbx.log` 取
URL+token、自己在同一进程里用 **CDP（Node 内置 WebSocket）** 操作 headless chromium。
**不接进 `test:smoke`/`test:e2e`**（每条链要花真 LLM 调用）。

同一份沙箱日志累计（多次探测试跑合起来的真实流量）：

| 计数 | 值 |
|---|---|
| `ops consumed: pull` | 19 |
| `ops consumed: complete` | 3 |
| `push landed` / `deferred push landed` | 18 / 4 |
| `hot push landed` | 11 |
| **`hot push coalesced`** | **0** |
| **`hot push yielded on input`** | **0** |

关键读数不是那两个 0，而是**每一行落地留痕里都带 `coalesced=0`**：
⇒ **合并窗口在这份真实流量里从未攒出过 pending 热度快照**（`windowWasOpen` 因此永远为 false）。
⇒ 「让路 / 应当让路」的分母是 **0**，不是"编排没打中时机"，而是**根本没有可让的写**。

为什么会这样，用同一条日志就能说清：这份流量是**单人 casual 操作**（切会话、发一条、等回合），
每一次热度变化都发生在「没有别的热度变化在 1s 内跟着来」的时刻，而 pull 与回合末尾的推送要么
带 `hotNow`（立刻写、不攒），要么窗口本来就还没开 ⇒ 窗口一次没开过。
⇒ **#62/#63 那套节流与让路的真实收益/比例，只在「连发」形态下才有分母**（正是 #68 那条
「同一秒内既改热表又换会话」的形态）。所以这条现场结论应当这样表述：

> 真实宿主 + 单人 casual 流量：**0 次 coalesce、0 次 yield、0 次多余写**。
> 这既证明节流在普通操作下不产生额外写（判据③的后半句在真宿主里成立），
> 也说明**比例这个指标需要连发流量才有意义** —— 用现在这台实例的手点节奏量不到。

要做的是给驱动加一段**连发编排**（不是"多试几次"）：同一秒内制造两次热表变化 + 一次 `complete`，
最省的实现是走热度管理面板的 add/delete（`_ops`，不产生推送 ⇒ 真正造出 pending），而不是切会话
（切会话每次都是 `hotNow`，永远攒不出 pending —— 这条是本轮跑出来的、可直接写进 #63 的观察）。

### 脚本现状（诚实）
- ✅ 起沙箱、打补丁（enable + `inlineDelayMs=60`）、CDP 打开 GUI、关首屏叠层引导、选工作区、
  打字发消息（真回合）、读日志计数、kill + 删目录，全链路可复跑
- ✅ **token 纪律达成**：token 只在脚本进程内存在，所有输出过 `redact()`，脚本自己统计并打印
  「明文进 stdout 的次数 = 0」；10+ 次运行里这条一直是 0（tool 参数里也不再出现 token —— 这是
  改用 CDP 而非 Playwright MCP 的唯一理由）
- ⚠️ 编排的 ①② 步（切会话）在 `--rounds-only` 复用时拿不到 `[role=treeitem]`（这一版 GUI 的
  会话行不在该 role 下，或列表被折叠），所以连发编排还没跑起来 —— 已定位，属选择器适配，
  不是路径不通

## 13. 让路的第一次现场执行：**执行了 6 次，但归因还没成立**（本轮的诚实边界）

连发编排（`--burst`，`scripts/hot-yield-ratio.mjs`）跑了两批，真实宿主里的计数：

| 批次 | 轮数 | `complete` | `hot push yielded on input` | `hot push coalesced` |
|---|---|---|---|---|
| 批 1（复用沙箱，3 轮） | 3 | +2/+3/+3 | **+1/+1/+1 = 3** | 0 |
| 批 2（复用沙箱，4 轮） | 4 | +0/+0/+2/+8 | **+0/+0/+1/+2 = 3** | **1** |
| 批 3（全新沙箱，6 轮） | 6 | 0（提交没进宿主） | 0 | 0 |

⇒ **`hot push yielded on input` 在真实宿主里第一次出现**（此前 0 次），累计 6 次。
⇒ 性质那半句在现场同样成立：让路 6 次 ≤ 同段热度写增量 8（批 2 起点 22 → 终点 30）。

### 但「比例」我报不出来，两处错都在我自己的度量方法上

1. **按轮算分母会算出 1.50 这种不可能的数**：`complete` 是异步消费的，上一轮打的字在下一轮才落到
   `_ops` ⇒ 分子跨轮串味。已改成整段计数（分母 = 期间到达宿主的 complete op 总数）。
2. **更要命的一条：arm→complete 的实测间隔 `typeGap ≈ 1400ms`，超出 1000ms 窗口。**
   ⇒ 那 6 次让路的窗口**不是我的编排开的**。沙箱里还有个 **`auto-continue`** 插件会自己往会话里
   发「继续」（日志实证：`[auto-continue] 已自动发送「继续…」`），它的回合末尾照样写热度、照样开
   窗口 ⇒ 它才是窗口开启源之一。⇒ 所以现在的状态是 **「已执行 ≠ 已归因」**，
   我不能把 6 次说成"编排命中率 6/N"。

### 第 3 项（放出去的是不是**当前**热表）：**未核实**，原先的判据本身是错的
我一开始用「`_hot` 末条的长度 == 本轮提交文本的长度」判，前提就不成立：热表按 **count 降序**排，
新条目不保证在末尾；且沙箱复用时同名提交会被**去重**（`total` 不涨）。批 3 改用「本轮独有 token
是否出现在 `_hot` 里」这个正确判据，但那一轮 GUI 侧把 composer 弄丢了
（`composerSend` 返回 `{"step":"no composer"}`，全新沙箱、主视图刚点过「新会话」之后），
提交一次都没落到宿主 ⇒ **现场仍未取到这个数**。离线侧 `hot-yield-smoke` 的断言②仍然只覆盖离线。

### 环境障碍记录（下一个人不必重新发现）
- **`auto-continue` 关不掉**：它不是沙箱 profile 的顶层条目（`grep -i continue cordis.patch.yml` = 0 命中），
  是 bundle 带进来的 ⇒ `--patch` 对它无效（这条与「group 成员条目关不掉」是同一类，但入口更深）。
  ⇒ 想要干净的分母，得先解决噪声源：要么换一个不带 auto-continue 的 profile 变体，
  要么把 arm 的判据换成「**只认我这一拍产生的那次热度写**」（写之前记下 `_push` 的 rev，
  要求开窗口那次的 rev 与我的提交一一对应）。后者是可行的下一步。
- **主视图 attach 时机不稳**：全新沙箱里点过「新会话」之后 composer 元素可能整个消失；
  复用沙箱里又会被留在插件详情页导致「元素在但没 attach」。两种都得在编排前做**提交冒烟**，
  冒烟不过就别往下跑（这条已经写进 §7）。

⇒ **#63 的比例保持未覆盖**。但这条线现在的状态从「已发布、从未执行」推进到
「已现场执行 6 次、性质成立、归因与落地内容两项仍待做」——这是**新的基线**，不是原地。

## 14. rev 对齐归因：闸门做出来了，**并用一个对照实验证实了「那 5 次让路不是我编排出来的」**

`--burst2` 的归因闸门（四条，逐条报哪个没成立）：
① 开窗口那次写的 `rev` 必须紧跟在我明确发起的那次 `ops consumed: pull` 之后；
② `arm→complete` 实测间隔 ≤ 1000ms（窗口长度）；
③ 窗口内不得有第三者插写；
④ 造脏那次提交真的发生（回车前草稿非空、回车后草稿清空）。

### 关键的对照实验（这条比任何数字都有价值）
`auto-continue` 虽然是 bundle 带进来的，但 `dsh --profile web --dump-config` 里它是**顶层条目**
（`- id: auto-continue`，dump 第 1909 行）⇒ profile 层可以盖掉它。盖掉之后：

| 状态 | 让路（`hot push yielded on input`）增量 | coalesced 增量 |
|---|---|---|
| auto-continue **开着**（§13 那两批） | **+3、+3**（累计 6 次，其中 burst2 首批 2 次带 rev 对齐） | 0 → 1 |
| auto-continue **关掉**（本轮两批共 12 轮） | **0** | 1 → 4 |

⇒ **§13 那 6 次让路的窗口是 auto-continue 的活动开的，不是我的编排** —— 这不是推测了：
把噪声源关掉，让路立刻归零。⇒ 归因结论成立，且方式是「对照组」而不是「读代码说不是」。

### 为什么编排自己凑不出那 1 秒（量化过，不是"没试够"）
关掉噪声源后逐轮实测 `arm→complete`：**2655 / 2666 / 2675 / 2655 / 2655ms**（五轮全部超窗），
而唯一一次 **97ms**（轮 4）发生在会话恰好空闲的时候。⇒ 单步 CDP 往返在**页面正在流式输出**时
约 **600ms** 一次，编排里 4~5 步 ⇒ 必然 ~2.6s，**结构性超出 1000ms 窗口**。
⇒ 要压进窗口只能把三步放进**同一次 in-page 执行**，而在页内提交消息 / 触发 complete 需要
Lexical 吃合成事件（实测不吃，见 §7）⇒ 这条路在当前宿主形态下走不通。
⇒ **#63 的「由编排归因的触发比例」仍未拿到**，但现在有明确的不可达原因与量级（600ms/步 vs 1000ms 窗口），
不是"再多跑几轮"能翻的。

### 我自己度量方法上的两个错（都已修，且都是它们挡住了正确结论）
1. **token 判据漏检**：profile 里长单引号标量被 **YAML 折行**，`includes(token)` 跨行匹配不上 ⇒
   我一度以为"提交一次都没落地"。改成折回一行再匹配后，同一批数据里立刻出现
   `落地含本轮独有 token=✓`（轮 2）⇒ **提交是会落地的**，之前那个"全 ✗"是我的度量误差。
   教训：判据本身要测一次「它能不能被满足」，否则会把检测器的瞎当成被测对象的哑。
2. **按轮算分母**（§13）会跨轮串味 ⇒ 出现过 `3/2=1.50`；burst2 改成「四条同时成立的轮」才是分母。

### 现在 tracker 上的两件独立的事（别混成一件的完成度）
- **已证（现场）**：让路分支在真实宿主里执行过（累计 5 条 `hot push yielded on input` 留痕），
  性质成立（让路增量 0 ≤ 热度写增量 19；上一批 3 ≤ 8 同样成立）；且**噪声源对照**证明过那些
  执行的窗口来源。
- **未证（现场）**：由编排归因的触发比例；以及「放出去的是不是**当前**热表」—— 后者在可归因轮里
  仍取不到数（本轮 `第 3 项 = 2/0`：有 2 轮的独有 token 落地了，但那 2 轮都没过归因闸门）。

## 15. 分布数据 + 我自己两个错误假设的现场反驳（#63 的比例：按决策规则该退役了）

`--burst2 --tight`，生产窗口 **1000ms 未改**、产品代码一字未动，`auto-continue` 关掉：

```
arm→complete 分布：样本=2（另 3 轮等 arm 超时）  min=56ms 中位=69ms max=69ms
分档：≤300ms 2 / 301–1000ms 0 / 1001–3000ms 0 / >3000ms 0
CDP 单步往返实测：Runtime.evaluate 中位 2ms（min 1 / max 16）；Input.insertText 中位 1ms
```

⇒ **我上一条"600ms/步、墙在传输层"的假设被我自己的测量反驳了**：单步是 1~2ms。
⇒ 也 ⇒ **timing 不是障碍**：修掉编排里我自己那句 `waitIdle(2500ms)` 之后，`arm→complete` 从
中位 **2705ms** 掉到 **69ms**，稳稳落在 1000ms 窗口内。**上一批超窗的主因是我的等待，不是环境。**

### 但分母仍然是 0，而且原因变成了结构性的（同样有实测）
那两轮落在窗口内的轮次，都卡在同一条：**`idleB = "busy"` ⇒ 提交被排进 agent inbox ⇒
那一刻热表没变脏 ⇒ 让路没有对象可带**（与 §13 会话日志里 6 条 `agent/inbox/spliced` 一致）。
把三条实测拼起来就是这个死结：

1. 主视图里唯一能让热表变脏的动作是**提交用户消息**，而提交本身就会让会话进入 busy ⇒
   下一个提交被排队（不是"没落地"，是**不在那一刻落地**）；
2. 不触发回合的脏源（`_ops` 的 add/delete）只在**插件详情页/热度面板**上，而那里的实测是
   `composer:false`（composer 被顶掉、没 attach）⇒ 同一页里既造得出脏、又发不出 `complete`；
3. ⇒ 「窗口内 + 脏 + complete」三者同视图成立，**必须有一个第三方角色去开窗口或改热表** ——
   而这恰恰就是 `auto-continue` 在做的事，也正是 §13/§14 那 **6 次真实让路**的来源。

### 所以按 lead 的决策规则收口
`分母 = 0`（timing 已修好、窗口已落进、仍为 0）⇒ **「编排归因的触发比例」这个指标该退役**。
#63 的现场结论应当是（含 lead 的 reframe）：

- **路径在真实宿主里执行过 6 次**，且**其中至少一部分是由第三方消费者（auto-continue）开的窗口触发的**
  ⇒ 这不是"被排除的噪声"，而是**第二个真实形态**：谁开的窗口不重要，下一个来读热表的人拿到当前值，
  正是这段代码该有的行为；
- **性质成立**（现场两批：3 ≤ 8、0 ≤ 32、0 ≤ 9）；
- **合并窗口有效**（`coalesced` 在关掉噪声源后仍出现，1 → 4）；
- **未证**：编排归因的比例（指标 ill-posed，原因见上三条实测）、「放出去的是不是**当前**热表」
  （本轮 `可归因轮里 0/0`；另有 2 轮的独有 token 确实落进 `_hot`，但那 2 轮超窗/忙 ⇒ 不算归因轮）。

### 顺带修的两处自己的东西
- `dev-sandbox --cleanup` 认的工作区约定是 **`<home>/ws`**；我把 ws 放在 `~/dsh-sbx-yield-ws`
  时它会**报残留却删不掉** ⇒ 本脚本默认改成 `<home>/ws`（收尾一条命令才真的干净）。
- 关键路径上那句 `waitIdle(2500ms)` 是我加的，它把中位数从 69ms 抬到 2705ms ⇒
  **量测工具自己也要过一遍"这一步在关键路径上吗"**，否则会把自己的等待当成环境的墙。
