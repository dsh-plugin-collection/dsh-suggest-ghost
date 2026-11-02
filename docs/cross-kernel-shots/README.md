# 跨内核 GUI 截图证据

全部来自**该代次自己的 `dsh web` 实例**：真工作区 · 新建会话 · 真模型回合 · 截图取该会话输入框区域。
不是复刻页面，不是示意图。

| 文件 | 含义 |
|---|---|
| `<代次>-PASS.png` | 修复后：输入框里出现插件预测的浅灰文字（真模型输出） |
| `<代次>-PASS-0.7.0.png` | **2026-10-27 在 `938048b`（0.7.0）构建上重拍**的同一条判据：composer 区域里的浅灰幽灵。取代旧 `<代次>-PASS.png` 的"当前性"（旧图保留作历史，理由见 `scripts/cross-kernel/FINDINGS.md` §8.2） |
| `<代次>-namespace.png` | 修复前对照：同样操作、同样输入框，但**什么都没有**（建议推不到浏览器） |
| `0.1.1-rc.2-FAIL.png` | 0.1.1 挂载失败页：`pending (waiting for service: remote.settings)` |

## 0.1.1-rc.2 已从支持列表删除（2026-10-26）

上面那张 `0.1.1-rc.2-FAIL.png` 是**删除前**的记录，保留以说明"为什么删"。

失败原因不是"没修"，而是硬约束：本插件 client 的 `inject` 含 `remote.settings`，
而 0.1.1 的前端没有该服务（`dsh-api-remotes/lib/client.js` 里 `settings` 命名空间
**0.1.2 才出现**；0.1.1 的官方设置 UI 走 `connection.api.settings`）。
cordis 对 `inject` 是**静态 park**——声明了拿不到就整条 fiber 不激活，运行时降级不可行。

两条改法都堵死：

1. 去掉 `remote.settings` 的 inject ⇒ 0.2.1 上插件直接 `dsh-suggest-ghost: failed`
   （属性读被 Proxy 拦，这正是当初必须声明它的原因）。
2. 按代次声明两套 inject ⇒ `inject` 是模块级静态数组，做不到。

唯一可行的是改成注入 `connection` 再运行时择路，但那要重验另外六代的 GUI；
且本机这棵树被 npm 重装过（198 → 196 包），修好也无法证明对原始 0.1.1 有效。
故明确不支持，而非"待修"。

## 重新生成

见 `scripts/cross-kernel/`：`generations.mjs`（代次表，唯一来源）+
`mount-run.mjs`（装配/投影）与 `verify-across-kernels.mjs`（回归入口）。
GUI 截图需要真实例 + 真模型，不是自动化回归的一部分。
本轮（0.7.0 重拍）用的驱动是 `scripts/cross-kernel/gui-round.mjs`，
逐条判据与四条方法学坑（默认阈值静音 info、picker 列表异步且入口按代次不同、
模型空返回不是插件缺陷、`push landed` 子串会算进 `hot push landed`）记在
`scripts/cross-kernel/FINDINGS.md` §8。

## 流式投递的开/关对比图（task-42）

- `streaming-0.2.1-rc.2.gif` —— 左格=流式逐帧（每格烧**页内真实时刻**与字符数），右格=关流后整块一次到齐。
  录了 3 轮：**其中 2 轮有逐帧留痕**（真实提前量 **36ms / 90ms**），第三轮 0 帧 —— 那是**采样失败不是产品结论**，
  如实剔掉并记在 FINDINGS §15.5。播放轴固定 1500ms ⇒ **名义慢放约 17×**，倍数写在画面里。
- `streaming-0.1.2-rc.1.gif` —— 该代次**拿不到开流边沿**（#111）：宿主 `streaming=1 ready=1 on=1 subs=0`，
  客户端零条 `stream open` ⇒ 只有整块出现。标注用词是"未启用流式"，**不是** bug 也不是"不支持"。
  ⚠️ 这张图里的 `t=+5413/+6852ms` 是**提交→整块出现**（含回合时长，模型主导），与流式无关。

复跑：

```bash
# 录制（DSH_HOME 一律由 dev-sandbox 设；插件要以**实体目录**在 profile 树内，流式的动态 import 才解析得到）
node scripts/dev-sandbox.mjs --home ~/xk-gif-0212 --rewrite 'port: 3983=port: 4190' \
  --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh --live-nm ~/dsh-versions/0.2.1-rc.2/node_modules
node scripts/cross-kernel/prune-bundles.mjs --home ~/xk-gif-0212 --tree ~/dsh-versions/0.2.1-rc.2
node scripts/cross-kernel/stream-gif-record.mjs --home ~/xk-gif-0212 --label on-C --rounds 3 \
  --ws ~/xk-gif-ws --burstMs 16000
# 装配（时刻一律取页内；慢放倍数由"真实提前量 / 播放轴"算出并烧进画面）
node scripts/cross-kernel/stream-gif-stack.mjs --gen 0.2.1-rc.2 \
  --on scripts/cross-kernel/out/gif-on-C --off scripts/cross-kernel/out/gif-off-B \
  --log ~/xk-gif-0212/logs/sbx.log --out docs/cross-kernel-shots/streaming-0.2.1-rc.2.gif
# 最终编码就是装配里打印的那条：ffmpeg -f concat + fps=10 + palettegen/paletteuse
```

三条口径（都是这轮实测换回来的，别再改回去）：
1. **只截 composer 区域**（`[data-input-scroll]` 外扩 26/150/46），整页会把 profile 内容与会话名带进产物；
2. **时间轴取页内 `performance.now()`**：页外轮询/抓图往返（实测 30~45ms）都会把两帧读成一次变化；
3. **回合窗口 > 提前量**：一次回合 8~25 秒，而提前量是几十毫秒 ⇒ 任何"看起来明显"的处理
   都会盖过这个比例。所以每格只说自己那一格的真实数字，不共享横轴（两次冷启动的 t=0 没有对应关系）。

## 幽灵逐段变长：重建图与 GIF（task-44，当前有效）

- `streaming-0.2.1-rc.2-stream.gif`（9 格 + 1 循环帧，**每格停留按真实间隔比例**，不用统一 1500ms；
  每帧图上都写"格与格之间的停留时长 ∝ 真实帧间隔 · 本图非录像"）
- 三轮对比图 `scripts/cross-kernel/out/gif3-rebuild/two-cells-r{1,2,3}.png`
- 口径：**重建图，非录像** —— 底图为真实截图、产品 overlay 已置空、灰字按逐帧留痕重绘。
  它回答"分几步、每步多少字、隔多少毫秒"，**不回答"那一毫秒长什么样"**。
  三轮全保留：轮 3 的终帧没带来新字符 ⇒ 图上照实写"3 字符 → 3 字符"，**不剔、不补帧**。

复跑（四步，缺一不可）：

```bash
export DSH_SUGGEST_GHOST_TRACE=debug            # 不设则逐帧留痕被默认阈值静音（脚本会直接拒绝开工）
node scripts/dev-sandbox.mjs --home ~/xk-gif3-0212 --rewrite 'port: 3983=port: 4231' \
  --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh --live-nm ~/dsh-versions/0.2.1-rc.2/node_modules
node scripts/cross-kernel/prune-bundles.mjs --home ~/xk-gif3-0212 --tree ~/dsh-versions/0.2.1-rc.2
# 录制 + 置空 + 逐帧重建（每帧一次真实截图）
node scripts/cross-kernel/stream-gif3-rebuild.mjs --home ~/xk-gif3-0212 --ws ~/xk-gif3-ws \
  --rounds 3 --out scripts/cross-kernel/out/gif3-rebuild
python3 scripts/cross-kernel/stream-gif3-measure.py scripts/cross-kernel/out/gif3-rebuild   # 四道断言
python3 scripts/cross-kernel/stream-gif3-compose.py scripts/cross-kernel/out/gif3-rebuild   # 拼版 + GIF 帧
python3 scripts/cross-kernel/stream-gif3-gif.py scripts/cross-kernel/out/gif3-rebuild \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-stream.gif
python3 scripts/cross-kernel/stream-gif3-verify-gif.py scripts/cross-kernel/out/gif3-rebuild \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-stream.gif          # 断言 E：回读 GIF 本身
```
（最后一步**不能省**：编码那步曾把每帧时长全抹成 50ms，而"停留 ∝ 真实帧间隔"就印在每格图上。）

**格序 = 每组「起点置空 → 逐帧 → 终帧」**，且编码必须 `disposal=2`（restore-to-background）：
GIF 默认 disposal=0/"keep" ⇒ 每格画在上一格残留位图上，"置空起点"在屏幕上**根本不空**，
用户会看到"出现 → 变长 → 消失 → 又出现"（那个"消失"不是产品行为）。见 FINDINGS §17.8。

三条硬规矩（都是实测换来的，见 FINDINGS §17）：
1. **画之前先把产品 overlay 置空**（`visibility:hidden` 保留布局）——否则注入的灰字与真实 overlay
   同位同色同字体，被同一份真实文字盖住，永远看不出增长（§16 的真因）。
2. **裁切贴着 overlay 自身盒子**；高度不够**加高视口**（880→1100），不要盲目放大 clip——
   多留 48px 就会把下面工具条的冷灰图标圈进来，断言立刻被污染。
3. **断言一律 PIL 逐像素**，不解析 ImageMagick `compare` 的 stdout；**读 GIF 必须读"合成后的画面"**
   （ffmpeg 抽变化帧），PIL 裸 seek 读到的是增量帧、手工 alpha 累加会算错 disposal；
   且断言之间要能互相对账
   （B=0 与 C=0 同时成立 = 框里根本没有字，不是"置空成功且没有增长"）。

## 真实像素版（**看"产品长什么样"用这张**）

- `streaming-0.2.1-rc.2-replay.gif`（574,279 B，13 格 + 1 循环帧）——
  字由**产品自己的 overlay 元素**渲染（#114 的 `data-stream-frames` 提供逐帧 frame/final/chars/t），
  不是我复刻样式的 div。
- 与上一张的分工：`…-stream.gif`（§17）= 手绘重绘版，口径"我画的 div"；
  `…-replay.gif` = 产品重放版，口径"产品 overlay 自身渲染 + **按实测 chars 重建**"。
  **两张都有效，用途不同。**
- ⚠️ **中间格不是"当时屏幕上就是这样"**：8ms 采样的逐样本观测（FINDINGS §19）显示，
  4 个回合里中间帧一次都没有上屏，首绘落后终帧 177–375ms 且内容已是终态。
  所以中间格一律标 `重建（屏幕上未出现）`，图头也写了同一句。这个结论是**观测**，
  不是推理；它把"逐帧文本是否真实"这个问题从"未判定"推进到"观测到没有"。

复跑：

```bash
export DSH_SUGGEST_GHOST_TRACE=debug
node scripts/dev-sandbox.mjs --home ~/xk-replay-0212 --rewrite 'port: 3983=port: 4241' \
  --bin ~/dsh-versions/0.2.1-rc.2/node_modules/.bin/dsh --live-nm ~/dsh-versions/0.2.1-rc.2/node_modules
node scripts/cross-kernel/prune-bundles.mjs --home ~/xk-replay-0212 --tree ~/dsh-versions/0.2.1-rc.2
node scripts/dev-sandbox.mjs --home ~/xk-replay-0212 --deploy . --bin … --live-nm …
# ⚠️ 插件必须是**实体目录**，且目录内要有 node_modules 才解析得到 typert protocol（§18.4）
ln -sfn ~/dsh-versions/0.2.1-rc.2/node_modules ~/xk-replay-0212/plugin/node_modules
# 之后重启宿主用 dev-sandbox（注意 boot 会 rmSync plugin，内链要**重启后**再补）
node scripts/cross-kernel/stream-replay-record.mjs --home ~/xk-replay-0212 --ws ~/xk-replay-ws --rounds 4
# 同会话复用对照（隔离"每轮新建会话"的影响）：加 --reuse 1
python3 scripts/cross-kernel/stream-replay-measure.py scripts/cross-kernel/out/replay   # A–D（F/F2/G 在 record.json 里）
python3 scripts/cross-kernel/stream-replay-gif.py scripts/cross-kernel/out/replay \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif
python3 scripts/cross-kernel/stream-replay-verify-gif.py scripts/cross-kernel/out/replay \
  docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif   # E：载体回读，最后一步，不能省
```

三条本版新增的硬规矩（详见 FINDINGS §18.3）：
1. **墨迹判据不许假设主题** —— 用"偏离本地背景众数"的对比度，绝对颜色在深色下恒读 0；
2. **坐标要换算** —— `measureRect` 是页面 CSS 坐标，截图是裁切后的 `deviceScaleFactor` 位图：
   `图内 y = (页面 y − clip.y) × scale`，不换算就是"在 288 高的图里找第 986 行"；
3. **回读时把自己的标注排除在被测区之外** —— 否则标注文字会被数成"墨迹"，
   看着像"置空没成功"，其实是我的注释污染了被测区域；
4. **D（跨度）要减掉起点格** —— 那一行里本来就有输入框下边框，直接量"这一行的跨度"会量到它，
   5 字符与 18 字符都读 2740（FINDINGS §19.4）。

沙箱形状（不是产品缺陷）：新建沙箱的 `agent-default-model` 若指向 `commandcode`，
该 provider 的 bundle 在 0.2.1-rc.2 树里被 `prune-bundles` 丢掉 ⇒ 回合不产生建议或建议恒被过滤。
改成同机 `qoder-route/efficient`（模型 id 必须在 `models` 里已声明）即可，见 FINDINGS §19.7。

## 0.2.2-alpha.2（2026-10-30，构建 0.8.0，task：Gitea #121 UI 面）——**未判定**

三张图，来源一律 **real-gui**（真内核 `~/dsh-versions/0.2.2-alpha.2` 的 `dsh web` 实例 ·
真工作区 `~/xk-probe-ws` · 真新建会话 · 真回车），**判据一律未达成**，成因全在模型侧：

| 文件 | 那一轮卡在哪 | 复核物 |
|---|---|---|
| `0.2.2-alpha.2-UNDET-env-no-composer-FULLPAGE.png` | lead 的第一轮：沙箱未带 `--live-nm`、未裁 bundles ⇒ 页面没有 composer 区域，**整页**兜底图（不是 composer 裁切） | 该轮 `picker: 没有可用入口`、`composers: []` |
| `0.2.2-alpha.2-UNDET-empty-composer.png` | 重建沙箱（`--live-nm` + `prune-bundles` + `--deploy` 冷启动）后第一轮：profile 钉的 `provider: commandcode` 的 bundle **不在被测树里**，被 prune 丢弃 ⇒ 回合与续写都打不到模型 | 宿主 `no adapter registered for provider "commandcode"`；会话 `turn/end reason=error code=NO_ADAPTER` |
| `0.2.2-alpha.2-UNDET-no-model-quota.png` | 把沙箱 profile 的 `agent-default-model` 与 `suggest-ghost` 两条改成被测树自带的 `deepseek-official / deepseek-flash` 后：composer 模型位显示 `DeepSeek-V4.1-Flash High`，**真回合发出去了**，但账号额度 402 ⇒ 没有建议 ⇒ 没有幽灵 | 宿主 `completion failed … Insufficient Balance` ×6；会话 `turn/end … code=QUOTA, status=402` ×3 |

**这三张都不是插件结论**，也不是 `FAIL-插件`：按技能 §1b，模型返回空/失败记在环境上。
`docs/cross-kernel-shots` 里 0.2.2 这一代**当前没有 PASS 图**，UI 面 = **未判定**。

**为什么"额度不足"会让建议格一行日志都不出**（别误读成"建议通道也报了 402"）：
两条通道的触发条件不同——
- **续写格**（`completion`）由**输入**触发 ⇒ 真打到模型 ⇒ 留下 `completion failed … Insufficient Balance` ×6（外加 boot 2 的 `no adapter registered for provider "commandcode"` ×1）；
- **建议格**（`suggestion`）只在 `turn/end` 且 **`reason.kind === 'completed'`** 时才生成（`src/index.ts:2979`），
  而这三个回合全部以 `reason.kind === 'error'`（`code=QUOTA, status=402`）收场 ⇒ 建议路径**从未被触发**，
  所以 `suggestion generated / dropped / failed` **三个计数都是 0**，这是**前置条件没到**，不是"生成了但没显示"。
⇒ 复跑时要盯的第一行是 `turn/end … kind=completed`，第二行才是 `suggestion generated`。

### 这一代已经判到的（不混进上面）

| 判据 | 结果 | 复核物 |
|---|---|---|
| ③ 宿主装配健康 | ✅ | `apply called; artifact mtime=2026-10-30T09:15:39.248Z`（三次启动各一次）；`Invalid effect` **0 命中**；`plugin/lib/index.js` 里 `await registry.register` 在场（跑的是 0.8.0 那份构建） |
| ⑤ 热表跨重启不回零 | ✅ | 第三次启动 `hotness restored n=3 tableSize=3`；`_hot` `total=3 rev=17`（`volatile-evidence.mjs`，source=`profiles/web/cordis.patch.yml`） |
| ② 同次 `_push` | ⚪ 未达成（无建议可推） | `_push` `rev=1 final=null frame=null textChars=0 hasSessionId=false` |
| ④ 设置卡 | ⚪ 只到"插件页出现插件名+描述" | gui-round `settingsCard: {found:true, via:plugins-nav, cardShown:true}`；**未**证到插件自己的表单渲染（§13.4 同一口径） |
| 流式通道（#109） | ⚪ **仍未判定**（帧没内容可推），但**协议包在 0.2.2 上运行时 import 得动** | 见下面「typert 那条 A/B」 |

**typert 那条 A/B**（同一份产物、同一棵 0.2.2 树，唯一变量 = prune-bundles 补的 `<home>/node_modules` → 被测树软链）：

| 启动 | `<home>/node_modules` | 宿主日志里出现的那一行 |
|---|---|---|
| boot 1（建沙箱、未裁 bundles） | 无 | `typert protocol import failed (ERR_MODULE_NOT_FOUND)`（日志第 16 行，**全日志仅此一次**） |
| boot 2 / boot 3（补软链之后） | 有（指向**树外**的 `~/dsh-versions/0.2.2-alpha.2/node_modules`） | `stream channel registered service=ghostStream`（第 72 / 118 行） |

这一行是**代码门禁**过的判据，不是文案巧合：`src/index.ts:486-493` 里它只在
`registerGhostStreamService(...)` **返回 true** 时打印，而那个函数只有在
`await import('@deepseek-ai/dsh-typert-protocol')` **成功**之后才走到 `return true`
（`src/stream-service.ts:56-67` 失败即 throw ⇒ 走 `stream-register-failed` 那条）。
client 侧另有 `stream namespace bound` 与 `stream open/closed session=session-255c` 留痕。

⇒ 观测结论：**「软链指向树外 ⇒ 必然 ERR_MODULE_NOT_FOUND」这条约束在本形状上不成立**
（`src/stream-service.ts:6` 那句话与 `prune-bundles.mjs` 头注释的"逐包软链"警告，
至少对 `<home>/node_modules` 这一条是过强的）。**未做**的反而是另一件事：
`streamingDelivery: true` 下的**逐帧提前量**——额度 402 让建议本身没产出，
所以 #109 的流式效果在 0.2.2-alpha.2 上仍是**未判定**，别把上面这行读成"已验证"。

### 复跑（额度恢复后）

```bash
# 1) 建沙箱：依赖必须来自被测树（§13.2 第 1 步）
DSH_SUGGEST_GHOST_TRACE=debug node scripts/dev-sandbox.mjs --home ~/dsh-sbx-xk-0222 \
  --bin ~/dsh-versions/0.2.2-alpha.2/node_modules/.bin/dsh \
  --live-nm ~/dsh-versions/0.2.2-alpha.2/node_modules
# 2) 裁 bundles + 补 <home>/node_modules → 被测树
node scripts/cross-kernel/prune-bundles.mjs --home ~/dsh-sbx-xk-0222 --tree ~/dsh-versions/0.2.2-alpha.2
# 3) ⚠️ 本轮新发现的一步：prune 会把 commandcode 这类**第三方 provider** 丢掉，
#    但保留下来的 agent-default-model / suggest-ghost 条目还钉着它 ⇒ 必然 NO_ADAPTER。
#    把这两条的 provider/model 改成**被测树自带**的（deepseek-official/deepseek-flash，
#    或同机 qoder-route/*；见本文件末尾那条"沙箱形状"注记与 FINDINGS §19.7）。
# 4) 冷启动 + 跑轮（至少 cold1/cold2 两次）
DSH_SUGGEST_GHOST_TRACE=debug node scripts/dev-sandbox.mjs --home ~/dsh-sbx-xk-0222 --deploy . \
  --bin ~/dsh-versions/0.2.2-alpha.2/node_modules/.bin/dsh --live-nm ~/dsh-versions/0.2.2-alpha.2/node_modules
node scripts/cross-kernel/gui-round.mjs --home ~/dsh-sbx-xk-0222 --gen 0.2.2-alpha.2 \
  --ws ~/xk-probe-ws --label cold1 --shot docs/cross-kernel-shots/0.2.2-alpha.2-PASS-0.8.0-cold1.png
node scripts/cross-kernel/volatile-evidence.mjs --home ~/dsh-sbx-xk-0222 --gen 0.2.2-alpha.2
```

判据口径不变：`#dsh-suggest-ghost-overlay` 要 `data-shown=1` **且** `display!=none` **且**文本非空；
截图裁 `[data-input-scroll]` 外扩 20~30px。宿主日志切片存在 `/tmp/xk-0222-gui-round.log`（本轮三次启动全量）。
