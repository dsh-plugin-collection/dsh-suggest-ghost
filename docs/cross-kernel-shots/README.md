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
