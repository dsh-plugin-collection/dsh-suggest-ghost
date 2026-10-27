/**
 * 跨内核代次清单 —— 本仓**唯一**的事实来源（single source of truth）。
 *
 * ## 为什么单独一个模块
 *
 * 代次清单写两份就一定会漂：`verify-across-kernels.mjs`（回归入口）与
 * `mount-run.mjs` / `type-surface.mjs`（逐代次明细证据）必须从**同一个数组**取代次。
 * 谁要改代次，改这里一处，三个消费者跟着动。
 *
 * ## 与 dsh-later 的关系（含一处**必须说清的事实纠正**）
 *
 * 本清单照抄 `../dsh-later` 的 7 代，但**不是** import 过来的：那两个仓各自独立发布，
 * 一个仓的 lib 产物不该是另一个仓回归门禁的依赖（`dsh-later/lib/upstream-compat.js`
 * 是构建产物，跨仓 import 会把「跑的是哪份字节」这个问题重新引进来）。
 *
 * 任务书给我的一条描述需要**当场纠正**，因为它现在与磁盘上的字节不符：
 *
 *   ❌ 任务书说：「`dsh-later` 的 `KERNEL_GENERATIONS` **没有** `0.1.7-rc.1` 条目」。
 *   ✅ 实测（2026-10-23，本次核对）：**有**。
 *      - `dsh-later/lib/upstream-compat.js:85` → `id: '0.1.7-rc.1'`（源码同处
 *        `src/upstream-compat.ts:87`，即产物与源码一致）
 *      - 该 7 代齐全：`grep -n "^        id:" lib/upstream-compat.js` 出
 *        0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2
 *      - `package.json` 的 8 个 `@deepseek-ai/dsh-*` peer 每一项都枚举了
 *        `^0.1.7-rc.1`（`grep -c '0.1.7-rc.1' package.json` = 8，与 peer 条数一致）
 *
 *   任务书的**历史版本**是对的，只是现在已被修好：`git log -S"id: '0.1.7-rc.1'"
 *   -- lib/upstream-compat.js src/upstream-compat.ts` 只出提交 **b8e3fb1**
 *   「fix(runtime): source kind 改由内核版本判定，修 0.1.7-rc.1 上提醒 100% 不投递（issue #75）」。
 *   也就是说：在 b8e3fb1 的父提交 **48e7995** 上，`lib/upstream-compat.js` 的代次是
 *   0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / **0.1.7-rc.2** / 0.2.0-rc.2 / 0.2.1-rc.2
 *   ——**确实没有 0.1.7-rc.1**，而同一时刻 `package.json` 的 peer 也只枚举到 0.1.7-rc.2。
 *   所以原始观察抓到的是一次**快照**（修复前的状态）；dsh-later 随后在修 issue #75 时
 *   把该代次**显式登记**回来了。
 *
 *   这一条留着不是抠字眼：任务书写的是「一个已发布仓的两份清单互相矛盾」，
 *   而今天磁盘上的事实是「两份清单一致」，任何照抄任务书去下游写评论/开 issue 的人
 *   都会报出一个不存在的缺陷。
 *
 * ## dsh-suggest-ghost 的 peer 没逐字写 0.1.7-rc.1 —— 但**这不是矛盾**（2026-10-26 复核推翻）
 *
 * `dsh-suggest-ghost/package.json` 的 `@deepseek-ai/dsh-*` peer 里没有任何一处
 * 逐字出现 `0.1.7-rc.1`（`grep -c '0.1.7-rc.1' package.json` = **0**）。
 *
 * ⚠️ 曾经据此写过「两份声明互相矛盾」——**那个判断是错的，已撤回**：
 * `^0.1.1-rc.2` 展开是 `>=0.1.1-rc.2 <0.2.0-0`，在 `includePrerelease: true`（内核用的正是
 * 这个口径）下**匹配** 0.1.7-rc.1。所以「逐字枚举」≠「范围匹配」，两份声明**一致**，
 * 这一代**不需要**单独补枚举。别把这条再当成缺陷报出去。
 *
 * 原文保留于此仅作方法论记录：
 * 那一个组合代上，脚踩两条船。**本模块按 7 代（含 0.1.7-rc.1）跑回归，
 * 就是要让这处矛盾在真实内核上显形，而不是靠读 package.json 猜。**
 *
 * ## 用法
 *
 *     import { KERNEL_GENERATIONS, GENERATION_IDS } from './cross-kernel/generations.mjs';
 *
 * 每个条目：
 * - `id`         semver 精确版本（发布 tag）；也是 `--kernel-root/<id>` 的目录名
 * - `peerRange`  该代次在 package.json 里应枚举的范围（node-semver 预发布需显式枚举）
 * - `bootModel`  该代次树的装配形状，决定回归脚本怎么找到 boot 入口
 * - `notes`      逐代次备注（装配形状 / 已知坑），供人读与产物留痕
 *
 * @module dsh-suggest-ghost/cross-kernel/generations
 */

/**
 * 逐代次的装配形状。
 *
 * - `app-boot`：树顶层有 `@deepseek-ai/dsh-app-boot`，可与 dsh-later 脚本一样
 *   直接 `import(<root>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js)`。
 * - `app-boot`：树顶层有 `@deepseek-ai/dsh-app-boot`，可与 dsh-later 脚本一样
 *   直接 `import(<root>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js)`。
 * - `app-boot-mismatched`：顶层**有** `dsh-app-boot`（可 import，形状没问题），
 *   但它解析到的版本与被测代次**不同版**。目前只有 `0.1.5-rc.1` 是这种：
 *   树是 pnpm 布局，`node_modules/@deepseek-ai/dsh-app-boot` 是指向
 *   `.pnpm/@deepseek-ai+dsh-app-boot@0.1.5-rc.3_.../node_modules/@deepseek-ai/dsh-app-boot`
 *   的**软链**，内容为 **0.1.5-rc.3**，而同树 `dsh` 自己是 0.1.5-rc.1。
 *   跑得起来，但跑的是同代最新补丁的启动器——这条差异必须留痕，不能默默算同版。
 *
 * **（一棵被三个人先后误判、且归因也判错过的树，留在这里省下下一次）**
 *
 * 事实（2026-10-23 17:3x 复核，全部用 `existsSync`/`lstatSync`/`realpathSync` 打精确路径）：
 * `0.1.5-rc.1/node_modules/@deepseek-ai/` 有 **241** 个条目，`dsh-app-boot` 与
 * `dsh-base` **在顶层确实存在**（所以「它缺 app-boot」是错的），
 * 但二者都是软链、指向 **0.1.5-rc.3**（所以「它就是 0.1.5-rc.1 的树」也是错的）；
 * 且 `.pnpm/node_modules` 这一层**不存在**（所以「靠 .pnpm/node_modules 兜底」还是错的）。
 *
 * 归因也要纠正一次：一度把"读数前后不一致"解释成**树正在被安装**（moving target）。
 * 本次复核的证据不支持该解释：`.npmrc` / `pnpm-lock.yaml` / `package.json` 的 mtime
 * 分别是 17:31:07 / 17:31:14 / 17:31:14，树根 mtime 17:33:21，而我们在 17:33 之后
 * 反复读数；两次相隔 6 秒的读数（条目 241、app-boot 目标版本 0.1.5-rc.3）**逐字相同**，
 * 且 `ps` 下没有任何 pnpm/npm 安装进程。**树读写期间是稳定的**，不一致来自探测手法，
 * 不来自并发安装。把它记成 moving target 会让人以为"等它跑完就好"，而真正该做的是
 * 换探测手法——错误归因比错误读数更贵。
 *
 * 具体的探测陷阱（三条，各自都会给出"看着像已验证"的错答案）：
 *   - `readlink -f <不存在路径>` 会**原样回显**输入路径，看着像存在；
 *   - `find node_modules -name dsh-app-boot` 会**穿进 .pnpm store**、匹配到软链目标，
 *     于是"顶层没有"这个结论其实是"我看到的是 store 里那份"；
 *   - `[ -e <断链>/ ]`（带尾斜杠）对**断链**返回 false，而不带斜杠的同一路径返回 true。
 *
 * 结论：判树形状只用精确路径的 `existsSync` + `lstatSync`(是不是软链) + `realpathSync`
 * + **把版本号一并打出来**——`existsSync` 为真只证明"有启动器"，不证明"是这一版启动器"。
 */
export const KERNEL_GENERATIONS = [
  // 0.1.1-rc.2 **已从支持列表删除**（2026-10-26）。原因不是"修不动"，而是硬约束：
  //
  // 本插件 client 的 `inject` 里有 `remote.settings`，而 0.1.1 的前端**根本没有
  // 这个服务**——`dsh-api-remotes/lib/client.js` 里 `settings` 命名空间在 0.1.2 才出现
  // （0.1.1 的官方设置 UI 走 `connection.api.settings`）。cordis 对 `inject` 是**静态
  // park**：声明了拿不到就整条 fiber 不激活，运行时降级不可行。实测加一个不存在的
  // `remote.NOPE` 得到的报错与 0.1.1 上一模一样（`pending (waiting for service: …)`）。
  //
  // 两条改法都堵死：① 去掉 `remote.settings` 的 inject ⇒ 0.2.1 上插件直接
  // `dsh-suggest-ghost: failed`（属性读被 Proxy 拦）；② 按代次声明两套 inject ⇒
  // `inject` 是模块级静态数组，做不到。
  //
  // 唯一可行的是改成注入 `connection` 再运行时择路，但那要重验另外六代的 GUI，
  // 且本机这棵树被 npm 重装过（198 → 196 包），修好也无法证明对原始 0.1.1 有效。
  // 故明确不支持，而非"待修"。
  {
    id: '0.1.2-rc.1',
    peerRange: '^0.1.2-rc.1',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 224,
    notes: '树为 npm 扁平布局，顶层 app-boot/dsh-base 齐备。',
  },
  {
    id: '0.1.5-rc.3',
    peerRange: '^0.1.5-rc.1',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 241,
    notes:
      '**完整且自洽的树：@deepseek-ai 共 241 项**，顶层 dsh / dsh-base / dsh-app-boot / ' +
      'dsh-session-projection **全部是 0.1.5-rc.3**（2026-10-26 复核）。' +
      'peer 用 `^0.1.5-rc.1`（范围在 includePrerelease 下匹配 rc.3），门禁判 MET。' +
      '⚠️ 历史：这里原本登记的是 `0.1.5-rc.1`，那是一棵**混合树**（dsh 是 rc.1、' +
      'dsh-app-boot 软链到 rc.3，241 项）。2026-10-26 在本机给该树补装依赖时被 npm ' +
      '删空、随后重建失败，rc.1 目录已不存在；现存的是自洽的 rc.3 树。' +
      '因此**该代次此前的 rc.1 结论不能直接套到 rc.3 上**，需要在 rc.3 上重跑才有结论。',
  },
  {
    id: '0.1.7-rc.1',
    peerRange: '^0.1.7-rc.1',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 278,
    notes:
      '**组合代**（dsh-later 记为 load-bearing，见其 upstream-compat 头注释与 docs/verification.md）：' +
      '本代已删消息 source.kind:"plugin"（v4 准入会 throw），但 renderEveryReminderBatchFraming ' +
      '改名与 allocateScheduleId 删除都还没发生——即「旧符号还在、旧 kind 已死」。' +
      '任何按符号存在性做的分代在这一代上必然判错。' +
      '本仓 engines.dsh 覆盖本代，但 peer 枚举**不含**本代（见文件头）。',
  },
  {
    id: '0.1.7-rc.2',
    peerRange: '^0.1.7-rc.2',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 284,
    notes: '组合代的下一格：符号改名/删除在本代落地。本仓 peer 枚举含本代。',
  },
  {
    id: '0.2.0-rc.2',
    peerRange: '^0.2.0-rc.2',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 289,
    notes:
      '本仓 devDependencies 钉的就是 0.2.0-rc.2，即「本地那一版内核」。' +
      '按 dsh-later 的判定语义，0.2.0 及以前仍只认 dsh-* peerDependencies，engines.dsh 不单独决定。',
  },
  {
    id: '0.2.1-rc.2',
    peerRange: '^0.2.1-rc.2',
    bootModel: 'app-boot',
    hasAppBoot: true,
    hasDshBase: true,
    observedEntries: 306,
    notes:
      '分水岭：0.2.1 起 engines.dsh **单独决定**准入（老内核不读它）。' +
      '注意本仓 engines.dsh 的上界 `>=0.2.0-rc.2 <0.3.0-0` 覆盖本代，peer 枚举也含本代。',
  },
];

/** 只要 id 的纯字符串数组（顺序与 KERNEL_GENERATIONS 一致，供 --versions 校验与遍历用）。 */
export const GENERATION_IDS = KERNEL_GENERATIONS.map((generation) => generation.id);

/** 按 id 取条目；取不到返回 undefined（调用方负责把「未知代次」报成未判定，不要静默塞默认值）。 */
export function generationById(id) {
  return KERNEL_GENERATIONS.find((generation) => generation.id === id);
}
