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

三条硬规矩（都是实测换来的，见 FINDINGS §17）：
1. **画之前先把产品 overlay 置空**（`visibility:hidden` 保留布局）——否则注入的灰字与真实 overlay
   同位同色同字体，被同一份真实文字盖住，永远看不出增长（§16 的真因）。
2. **裁切贴着 overlay 自身盒子**；高度不够**加高视口**（880→1100），不要盲目放大 clip——
   多留 48px 就会把下面工具条的冷灰图标圈进来，断言立刻被污染。
3. **断言一律 PIL 逐像素**，不解析 ImageMagick `compare` 的 stdout；且断言之间要能互相对账
   （B=0 与 C=0 同时成立 = 框里根本没有字，不是"置空成功且没有增长"）。
