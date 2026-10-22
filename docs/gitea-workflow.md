# Gitea 协作流程（本仓的实际约定，含两条会静默失败的坑）

**结论先行**：这个仓的交付路径上有两处**「看起来成功了其实没成功」**的地方 —— 评论命令写错形式
（退出码 0、打印 issue 列表、评论没进去）与 `lib/` 是入库产物（多分支各自重建必然冲突）。
两条都在 2026-10-21/22 这两天真实踩过并留下了证据，所以这页存在。

---

## 1. 发评论：`tea comment`，且**发完必须回读**

### 正确形式

```bash
tea comment -r dsh-plugins/dsh-suggest-ghost <编号> "$(cat /tmp/comment.md)"
```

### 错误形式（本仓任务书以前写的是这个，别再抄）

```bash
tea issues comment add -r dsh-plugins/dsh-suggest-ghost 36 -m "…"   # ❌
```

**实测行为**（2026-10-22，本机 tea）：

| 观察项 | 结果 |
|---|---|
| 退出码 | **0**（不是报错） |
| 标准输出 | **整个 issue 列表**（`tea` 把无法识别的子命令当成 `issues list` 跑了） |
| 评论是否写进服务器 | **没有** |

`tea --help` 的 `COMMANDS → ENTITIES` 里只有顶层的 `comment, c`；`tea issues comment` 没有帮助主题
（`Error: No help topic for 'comment'`）。⇒ **这条命令的形式不能靠"跑一遍看有没有报错"验证**，
报错本来就不是它的失败模式。

### 回读复核（唯一可靠的确认方式）

```bash
tea api "/repos/<owner>/<repo>/issues/<编号>/comments?limit=100" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const a=JSON.parse(d);
      console.log('评论总数=',a.length,'| 最后一条=',a[a.length-1].user.login, a[a.length-1].created_at);
    });"
```

⚠️ **不要用 `tea issues -o json` 的 `comments` 字段做回读**：实测那个字段恒为空数组，
用它复核会得出"评论没发出去"的错误结论（反过来也验证不了发出去了）。只有 API 那条路径可信。

---

## 2. 分支与 PR

- **只推 `origin`（Gitea），绝不推 `github` remote**。本仓配了两个远端，github 那边是镜像；
  推上去会污染镜像且拿不到 CI/评审。推完确认：`git log --oneline -1 origin/<分支>`。
- **开 PR 用 `tea pulls create --remote origin --repo <owner>/<repo> --head <分支> --base main`**。
  `--remote origin` 不是可选的：tea 会按 remote 反查登录，缺了它可能挑到另一个 login。
- **逐条 `git add <文件>`，不许 `git add -A`**：worktree 里的 `node_modules` 是指向主仓的**软链**，
  `-A` 会把它连带进索引（`.gitignore` 挡的是目录内容，不保证挡得住已经被解析成路径条目的东西）。
  提交前跑一次 `git status --short` 数一下条目，与本任务的写范围对齐。
- PR body 必须含三件：**CHANGELOG 条目草稿**（lead 统一落仓，你只交草稿）、**验收命令的真实输出**、
  **遗留风险**。结论措辞按实测量级写，不要用"感觉变快了"替代数字。

---

## 3. 产物纪律：`lib/` 由 lead 在 main 上统一重建

`lib/` 是**入库产物**（宿主直接加载它，见 `docs/internals-cordis-settings-pitfalls.md`），
所以：

- 多条分支各自 `tsc && node build.mjs` ⇒ `lib/*.js` 必然冲突，而且冲突发生在**生成物**上，
  人工解冲突等于在猜编译器的输出；
- 约定：**你在自己的 worktree 里构建只为跑冒烟**（冒烟导入的是 `lib/`，见第 4 节），
  **提交时把 `lib/` 一起提**，由 lead 顺序合并后在 main 上统一重建一次收口；
- `CHANGELOG.md` 与 `package.json` 的 `version` **由 lead 写**，协作者只交草稿（第 2 节）。

⚠️ 一条推论：**冒烟导入的是 `lib/` 而不是 `src/`** ⇒ 改了 `src/` 不重建 `lib/` 就重跑冒烟，
测的还是旧字节码，"变异没让断言变红"很可能是这个原因而不是断言无效。
本次实测踩过：变异 `src/index.ts` 后直接跑冒烟全绿，补上
`./node_modules/.bin/tsc -p tsconfig.json && node build.mjs` 之后才如预期变红。

---

## 4. 主仓纪律与 worktree 构建

- **主仓目录是 live 宿主正在加载的那一份** ⇒ 不在里面改代码、不在里面构建。
  要改就开 worktree：

  ```bash
  git -C <主仓> worktree add -b <分支> wt/<名字> origin/main
  ln -s <主仓>/node_modules wt/<名字>/node_modules
  ```

- **worktree 里 `pnpm` 不可用**（软链的 `node_modules` 过不了它的依赖检查），改用直接调二进制：

  ```bash
  ./node_modules/.bin/tsc -p tsconfig.json --noEmit          # 类型检查
  ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs  # 构建 lib/
  bash -c "$(node -p "require('./package.json').scripts['test:smoke']")"
  bash -c "$(node -p "require('./package.json').scripts['test:e2e']")"
  ./node_modules/.bin/tsc -p tsconfig.client.json --noEmit | grep -c "error TS"   # 客户端基线数
  ```

- **隔离实例**用 `node scripts/dev-sandbox.mjs --home ~/dsh-sbx-<名字> --rewrite 'port: 3983=port: 41NN'`。
  两条它自带的坑：
  1. **它无参数即创建并启动一个实例**（不是校验脚本）⇒ 批量挑脚本跑之前先排掉非 `*-smoke.mjs`；
  2. `pkill -f <模式>` 的模式串会匹配到调用方自己的命令行 ⇒ 会把自己那条命令杀掉。
  用完**一条命令**收尾（停实例 → 体检并删工作区 → 删沙箱目录 → 两处残留自检）：

  ```bash
  node scripts/dev-sandbox.mjs --cleanup
  ```

  它删**两处**：沙箱目录 `--home`（**里面有一份 `.credentials.yaml` 副本**，凭据留在磁盘上比删掉更糟）
  与**工作区** `--ws`（默认 `<--home>/ws`；旧默认在 `~/dsh-sbx-<entry>-ws`、**不在** `--home` 里 ⇒
  手工 `rm -rf` 沙箱带不走它 ⇒ 每次用完都残留一个目录，**里面可能有凭据副本**，Gitea #72）。
  ⚠️ **工作区不一定在 `<home>` 里**（历史遗留位置、或显式 `--ws <dir>`）⇒ 收尾命令按**三处
  来源**找它：沙箱目录里 `.dsh-sandbox-home` 记着的真实路径、`<--home>/ws`、以及家目录下
  `~/dsh-sbx-*-ws` 的通配兜底 ⇒ **每一处都过同一道闸门与护栏**（#83）。
  工作区脏了（`git status --porcelain` 非空）或认不出是本沙箱建的 ⇒ **不删并明确报出来**
  （退出码 1）；工作区默认在沙箱目录内部 ⇒ 它脏的时候**连沙箱目录也不删**。
  ⚠️ **报告与能力一致**：没删掉的每一处都写「**这条命令不会删它**，原因 X，删除方式 Y」
  ⇒ 不许留「报了残留却退出码 0」的形态；`--residual` 与 `--cleanup` 共用同一份枚举。
  ⚠️ **fail-closed**：任何**查不出来**的情况（`git status` 抛错、目录读不出、`.git` 是
  worktree 指针）一律判「无法确认 ⇒ 拒绝删除」——删的可是带凭据副本的目录，方向只能是
  「多留一个目录」。⚠️ **删除护栏**：`--home` 指向主目录本身、`~/.dsh`（含其祖先）或仓库目录
  ⇒ **直接拒绝、一个字都不删**（退出码非 0）。
  只看残留不删东西：`node scripts/dev-sandbox.mjs --residual`（`~/dsh-sbx*` 与 `~/dsh-sbx-*-ws` 两处都查）。

- **回收 worktree 前要确认两件事**：工作树干净，且**内容**已进 main。
  cherry-pick 进去的分支不是 main 的祖先，`merge-base --is-ancestor` 会判"未合并"，
  这时用 `git diff origin/main <分支>` 打出**空 diff** 才算内容等价。

---

## 5. 断言与冒烟的两条口径（本仓特有）

- **没验到的不得写成通过**：区分 `PASS / FAIL / NOT-COVERED` 三态，NOT-COVERED 必须写清
  缺哪个前置（见 `scripts/ghost-frame-e2e.mjs` 的收尾说明）。基线产物跑同一份脚本时，
  脚本要**自动降级成"只打印不判定"**，而不是把判定跳过当成通过。
- **形状断言 vs 语义断言**：形状（"某句必须是函数第一句"）**可以严格蕴含**语义
  （"守卫前不得有任何 IO"），而且比 token 名单强 —— 改名能绕过 token 名单，绕不过位置约束。
  想把形状改成语义之前，**先拿变异证明语义版更强**，别默认"语义一定更好"
  （本仓有一次 lead 的这类指示被实测驳回，见 `scripts/deferred-writes-smoke.mjs` 里那条注释）。
- **变异必须数值上可分辨**：真实耗时是 0~1ms 时，把 `Date.now() - t0` 翻转成 `t0 - Date.now()`
  **不构成变异**（`-0` 不匹配负号），"断言没红"在这个前提下不说明任何事。测边界要用显著量级偏移。

## 6. 「检查有没有变瞎」的判据：注入，不是数文件

比较两次 `tsc` 的条数时，**条数变少不等于检查变少**（类型塌成 `any` 时条数也会少）。本仓的判据：

```bash
# ❌ 假信号：tsc --listFiles 会把【错误行】也打到 stdout
tsc -p tsconfig.client.json --listFiles | wc -l          # 基线 35 = 12 个文件 + 23 行错误
# ✓ 滤掉错误行才是文件集（真值 12 → 12）
tsc -p tsconfig.client.json --listFiles | grep src/client | grep -v 'error TS' | wc -l
```

**但文件集不变也不能证明检查还活着**（塌成 `any` 时文件数一样）。
**加一道闸之前，先证这道闸本身是活的**，而且证据必须是**实跑输出**、不是「退出码非 0」：

- 闸脚本自己的失败模式是**静默的**：锚点写错的字符串替换是**空操作**，`git commit` 照样通过 ⇒
  提交说明里"已接进 test:smoke"当场成假话；`node --check | grep` 这类坏管道会把**真有语法错**的文件判成 ✓；
  在 JSDoc 里写 `~/.npm/_npx/*/node_modules` 时那个 `*/` 会**提前闭合注释**、整个脚本语法崩 ⇒
  那四轮"全红"其实是脚本坏，不是断言生效（本仓三条都真实发生过，见 #86）
- 正确做法：**注入一个应当让闸红的场景，并读到它打出来的那句原因**；以及**从被改文件里读出真实末项**
  当锚点，而不是硬编码一个可能已经变了的字符串。要验某条分支（如"宿主不可达"）时，**先把挡住它的
  硬编码绝对路径去掉**，否则那条分支永远测不到
**决定性判据是注入**：往被测文件末尾加一行故意的类型错误（例如 `const _probe: 1 = someValue;`），跑 tsc **看它报不报**；
报 ⇒ 量具在检查那块代码；不报 ⇒ 检查变瞎，**这条改动不许合**。

⚠️ 探针本身也有失效方式：插进 **JSDoc 注释块里**的探针不会被检查，那轮"没报"是**探针无效**而不是"检查在"（本仓实测踩过一次，改用文件末尾重做才有效）。

## 7. 发布前自检：「部署链正确」不等于「运行态是它」

核「用户是不是在跑这份代码」要核**两件事**，只看一件会得出反向结论：

1. **部署链**：`~/.dsh/profiles/web/node_modules/<pkg>` 是否解析到这份工作副本（软链）
2. **条目是否启用**：`~/.dsh/profiles/web/cordis.patch.yml` 里该 `- id:` 有没有 `disabled: true`

```bash
# 两条都要看，缺一不可
ls -l ~/.dsh/profiles/web/node_modules/dsh-suggest-ghost
grep -n -A3 '^- id: suggest-ghost$' ~/.dsh/profiles/web/cordis.patch.yml
```

⚠️ **只核第 1 条会把「延迟失真」读成「正在失真」**：链对但条目禁用 ⇒ 用户**没在**跑这些代码，只是**下一次启用那一刻**会立刻拿到一批没有版本记录的行
为。⇒ 这条判据直接影响发布决定与发布说明的措辞（本仓 2026-10-22 就这么错过一次：拿部署链 + 产物比 src 新，论证「用户已在跑未发布行为」，
而 `:712` 是 `disabled: true`）。

**同一条自检还该看产物是否嵌版本号**：本仓 `lib/index.js` 里 `0.6.0` 命中 **0 处** ⇒ 版本 bump **不触发**产物重建；但 `lib/` 整体仍是
入库产物（见 §3），改了 `src/**` 就必须重建再跑 `check:loop`，否则「版本号改了、产物还是旧的」会被那道门禁拦住。
