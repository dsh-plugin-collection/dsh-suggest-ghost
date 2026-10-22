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

- 主仓 `/home/wujue/workspace/dsh-plugins/dsh-suggest-ghost` 是 live 宿主加载的那份：只读，
  不在里面改或构建；所有构建与实例都在 worktree / 沙箱目录里。
- 起实例前先 `ss -ltnH "( sport = :<port> )"` 确认端口空闲；用完 kill，**并 `rm -rf` 沙箱目录**
  （里面有 `.credentials.yaml` 副本）。本轮结束时 `~/dsh-sbx*` 残留数 0、无监听端口、无进程。
- 凭据只读键名，不打印值；日志里出现长 token 时先掩码再看。
- `scripts/dev-sandbox.mjs` **不带参数就会启动真实实例**：批量跑 `scripts/*.mjs` 时必须排除它。

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
