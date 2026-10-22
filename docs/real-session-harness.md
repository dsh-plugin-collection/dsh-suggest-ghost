# 真会话 harness：在隔离沙箱里驱动一个真回合（#69 / task-20）

**结论先行**：`dsh headless` 能在隔离沙箱里挂上本插件并跑完一个**真 LLM 回合**（含
`turn/end reason={kind:"completed"}`），所以「宿主侧到底加不加载插件、事件到不到插件」这类问题
从此不需要浏览器就能验。但它**测不到写**：headless 在 `turn/end` 之后立刻 flush + 退出，插件那一次
回合后的异步建议生成拿不到执行时间 ⇒ `push landed` / `_push` / `_hot` 这类**写侧**观测必须换
「长驻的 web 实例 + 一个客户端」。这条页记下已经证实的部分、证不了的原因，以及可复跑的配方。

三处待替掉的 NOT-COVERED 与它们现在的前置状态：

| 待验项 | headless 够不够 | 缺什么 |
|---|---|---|
| ① #67 浏览器级三项（空正文终帧的真 DOM 呈现、`客户端写→宿主写→广播回客户端`的真实节律、读写护栏归属） | **不够** | 真 DOM ⇒ 必须长驻 web 实例 + 浏览器驱动 |
| ② #63 的两条（真实宿主里的让路、让路写次数的真实比例） | **不够**（进程在写之前就退） | 长驻宿主 + 真会话驱动 |
| ③ 双端偏斜真双进程（新宿主 + 旧客户端） | 新宿主半边**部分够**（挂载、读面、回读判定都能验）；写与旧客户端都不够 | 长驻宿主（写）+ 真浏览器或旧产物客户端 |

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

## 7. 还没做完的（这条页的诚实边界）

- ①②③ 三处的**写侧**验证仍缺「长驻 web 实例 + 可脚本化驱动客户端」这一件前置。
  `dsh headless` 不是它，`--patch` 加条目也不是它。
- 旧客户端那一半（③）还没做：做法是把沙箱私有副本的 `lib/client.js` 换成改动前的产物
  （`git show <rev>:lib/client.js`）再跑一次新宿主，看 `_residual` 是否真的不影响它 ——
  那才算真验；**「`_residual` 是宿主自用格 ⇒ 旧客户端会忽略」目前只是支持性推断**，
  不能顶替验证。
