#!/usr/bin/env node
/**
 * suggestionLanguage 回归测试（`src/transcript.ts`）。
 *
 * 钉住 #24 修复的两条性质：
 *  1. UI 先验阈值：当 UI locale 是中文，但转录里拉丁字符证据超过 `uiLocaleWeight`
 *     时，返回 English；否则返回简体中文。
 *  2. 注入消息过滤：调用方（generate.ts）必须在构建 pairs 前过滤掉 source.kind !== 'user'
 *     的注入消息（time-context, skill-catalog 等），否则英文注入会污染语言判定。
 *     本测试验证纯函数侧的行为，注入过滤在 generate.ts 的集成测试里覆盖。
 *
 * 用法：node --experimental-strip-types scripts/suggestion-language-smoke.mjs
 */
import assert from 'node:assert/strict';
import { suggestionLanguage } from '../src/transcript.ts';

/** 构造一对。 */
const pair = (role, text) => ({ role, text });

// ─── 1. 纯中文转录，UI locale 中文 → 简体中文 ─────────────────────────────
{
  const pairs = [
    pair('user', '你好，请帮我写一个函数'),
    pair('assistant', '好的，这是一个示例函数...'),
    pair('user', '再加一个参数校验'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, '简体中文', `纯中文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 2. 纯英文转录，UI locale 中文 → English ──────────────────────────────
{
  const pairs = [
    pair('user', 'Hello, can you help me write a function'),
    pair('assistant', 'Sure, here is an example function...'),
    pair('user', 'Please add parameter validation'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, 'English', `纯英文 + zh locale 应返回 English，实际: ${result}`);
}

// ─── 3. 中文为主 + 少量英文，UI locale 中文 → 简体中文（UI 先验生效）────────
{
  const pairs = [
    pair('user', '你好，请帮我写一个 function'),
    pair('assistant', '好的，这是一个示例 function...'),
    pair('user', '再加一个 parameter validation'),
  ];
  // CJK 字符约 20+，Latin 约 30，latinScore < uiLocaleWeight(100)
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `中文为主 + 少量英文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 4. 中文为主 + 大量英文，UI locale 中文，latinScore > uiLocaleWeight → English
{
  const pairs = [
    pair('user', '你好'),
    pair('assistant', '好的'),
    pair('user', 'Please help me write a comprehensive function with parameter validation, error handling, and proper documentation including examples and edge cases'),
  ];
  // CJK 约 4，Latin 约 150+，latinScore(150) > uiLocaleWeight(100)
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, 'English', `中文少 + 英文多 + latinScore > uiLocaleWeight 应返回 English，实际: ${result}`);
}

// ─── 5. UI 先验阈值：latinScore 略低于 uiLocaleWeight → 简体中文 ──────────
{
  const pairs = [
    pair('user', '你好世界'), // CJK 4
    pair('user', 'abc'), // Latin 3
  ];
  // 粗略：cjkScore ≈ 8 + 100 = 108, latinScore ≈ 12
  // latinScore(12) < uiLocaleWeight(100)，返回简体中文
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `latinScore < uiLocaleWeight 应返回简体中文，实际: ${result}`);
}

// ─── 6. 俄语转录，UI locale 英文 → Russian（Cyrillic 主导，无视 UI）────────
{
  const pairs = [
    pair('user', 'Привет, помоги мне написать функцию'),
    pair('assistant', 'Хорошо, вот пример функции...'),
  ];
  const result = suggestionLanguage(pairs, 'en-US');
  // Cyrillic 主导，hasUiPrior=false（en-US 不算 UI prior），直接返回 Russian
  assert.equal(result, 'Russian', `俄语 + en-US locale 应返回 Russian，实际: ${result}`);
}

// ─── 7. 空转录 → 默认 English ─────────────────────────────────────────────
{
  const pairs = [];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, 'English', `空转录应返回 English（无消息可分析），实际: ${result}`);
}

// ─── 8. 只有 assistant 消息，无 user 消息 → 回退到 assistant 语言 ─────────
{
  const pairs = [
    pair('assistant', '这是一个回复'),
    pair('assistant', '这是另一个回复'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  // 无 user 消息，回退到最近一条 assistant 消息（中文），应返回简体中文
  assert.equal(result, '简体中文', `无 user 消息 + assistant 中文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 9. 混合 CJK + Cyrillic + Latin，CJK + UI 先验主导 → 简体中文 ────────
{
  const pairs = [
    pair('user', '你好 Привет Hello'),
    pair('user', '世界 World Мир'),
  ];
  // 粗略计算：CJK ~12, Cyrillic ~9, Latin ~10
  // 加上 zh UI prior (+100 to cjkScore)，cjkScore 远超 cyrillicScore
  // 走 CJK 分支，latinScore < uiLocaleWeight，返回简体中文
  // 注意：hasUiPrior 只匹配 'zh' 或 'ru'，不匹配 'zh-CN'
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `混合语言 + CJK + UI 先验主导 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 10. uiLocaleWeight 调低：少量英文就触发 English ─────────────────────
{
  const pairs = [
    pair('user', '你好'),
    pair('user', 'hello world'),
  ];
  // CJK 2, Latin 11, latinScore(11) > uiLocaleWeight(5)
  const result = suggestionLanguage(pairs, 'zh', 5);
  assert.equal(result, 'English', `latinScore(11) > uiLocaleWeight(5) 应返回 English，实际: ${result}`);
}

// ─── 11. 助手回退证据不得推翻 UI 先验（真实转录复现）────────────────
// 现场：回合窗口里有长中文助手回复，输入预算（maxInputBytes=4096）从最老的对开始丢，
// 短用户消息被整批挤掉，只剩一条纯 URL → stripNoise 后为空 → 回退到最后一条 assistant。
// 该回复是中文 Markdown 报告，但含大量标识符 / IP:端口 / 表格，latinScore ≈ 195
// > uiLocaleWeight(100)。旧实现在这里返回 English——用户看到的英文建议正是由此而来。
{
  const pairs = [
    pair('user', 'http://192.168.4.77:3000/whq/apbot/actions/runs/8714/jobs/8730'),
    pair('assistant', "根因不在 CI，也不在广播脚本——**3081 只绑在 `127.0.0.1`**，而 runner 是 k3s pod。\n\n## 证据链\n\n| 证据 | 含义 |\n|---|---|\n| `ss -ltnp`：`LISTEN 127.0.0.1:3081` | 监听只在回环接口 |\n| job 日志：`Failed to connect to 10.42.0.1 port 3081 … refused` | **refused 而不是 timeout** 说明 SYN 已经到达主机、只是没有监听 → pod→主机这条路是通的 |\n| profile [:98](/home/wujue/.dsh/profiles/web/cordis.patch.yml#L98)：`host: 127.0.0.1` | 配置漂了；本插件文档里写的拓扑是 **0.0.0.0:3081** |\n| action 内置候选：`172.26.211.49:3081`、`10.42.0.1:3081` | 第二个正是本机在 k3s 网桥上的地址，绑定对了就能通 |\n\n另一个坑：`172.26.211.49` 是 WSL 的 NAT IP，**每次重启都会变**，而它排在候选第一位——所以每次广播都要先白等一次 refuse 才试第二个。\n\n## 修法（一行 + 重启）\n\nprofile `~/.dsh/profiles/web/cordis.pa"),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', '回退到助手文本时拉丁证据不代表用户，不应推翻 zh 先验，实际: ' + result);
}

// ─── 12. 同一判据在 Cyrillic 分支同样生效 ────────────────────────────────
{
  const pairs = [
    pair('user', 'https://example.com/some/very/long/path/to/a/file.png'),
    pair('assistant', 'Хорошо, вот пример: ss -ltnp слушает 127.0.0.1:3081, профиль cordis.patch.yml, хост 10.42.0.1, порт 3081, curl -s -o /dev/null -w http_code http://10.42.0.1:3081/github — это отладочный отчёт с таблицей и кодом.'),
  ];
  const result = suggestionLanguage(pairs, 'ru', 100);
  assert.equal(result, 'Russian', '回退证据不应推翻 ru 先验，实际: ' + result);
}

// ─── 13. 真人英文消息依然可以推翻 UI 先验（②不得把覆盖一起关掉）──────────
{
  const pairs = [
    pair('user', 'Please rewrite the webhook host binding and restart the profile'),
    pair('assistant', '好的，我来改。'),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, 'English', '真人英文证据仍应推翻 zh 先验，实际: ' + result);
}


// ─── 以下三例摘自真实会话转录（文本按 200-1100 字截断，判定与全文一致，生成时用修复前后两个实现校验过）───

// ─── 14. ③守卫：混合中文任务提示词不得被绝对阈值推翻（真实转录 turn1，①+② 下曾判 English） ───
{
  const pairs = [
    pair("user", "你在评审 DSH（DeepSeek Harness）社区插件是否达标某个组织的「设计原则」。所有仓库源码已预先下载到本地，只读，不要安装依赖、不要修改任何文件、不要联网。\n\n# 六条原则（逐字，这是唯一准绳）\n1. 不喧宾夺主：像 DSH 原生能力一样自然，不抢宿主的存在感。优先复用官方图标集与 UI 原语、跟随官方样式与主题、注入官方挂载点，而非自带一套；尽量不占显眼或高频位置，不打断主流程，不反复强调自身；优先扩展而非替换官方既有行为。\n2. 不过度设计：优先最克制、够用的方案，能少一层抽象就少一层。\n3. 配置自由：关键行为尽量可配置，把选择权交给用户。\n4. 不重复造轮子：优先复用官方能力、已有插件和成熟依赖，不另起等价实现。\n5. 性能保证：尽量不阻塞主线程、不做无谓重排与轮询，不给宿主添负担。\n6. 足量测试：关键路径尽量有测试覆盖，升级不悄悄破坏既有行为。\n\n# 必读的误判护栏（重要）\n- `cordis.patch.yml` 是 DSH 插件的标准 bundle 安装清单（把插件条目 insert 进宿主 profile），**不是**给宿主打补丁，不得据此判「替换官方行为」。\n- 官方 `@deepseek-ai/dsh-*` 包由宿主提供，插件正确做法是放进 devDependencies + manifest 的 `client.inject`，运行时 import。这是**复用官方能力**（原则 1/4 的正面证据），不是「造轮子」也不是「多余依赖」。\n- 客户端里出现 querySelector / MutationObserver 要分情况：只在自己的浮层/面板内部查找 = 正常；遍历宿主 DOM、按宿主 class/data-attr 定位并改写宿主节点、移除宿主节点 = 抢宿主存在感且升级即坏（负面）。请实际看代码判断，别只看数量。\n- 主题/skin 类插件天然要覆盖样式，评价重点是是否走官方 design token（`--dsw-*`）而不是硬编码色值 + `!important` 狂轰。\n\n# 你要评审的 4 个插件（给出的是仓库根目录，相对 /tmp/dsh-audit/）\n1. @michengai/dsh-skills-manager → repos/michengai__dsh-skills-manager/dsh-skills-manager-HEAD\n2. @michengai/dsh-archive-manager → repos/michengai__dsh-archive-manager/dsh-arch…"),
    pair("assistant", "## @michengai/dsh-skills-manager（月下载 212,152）\n定位：本机/多 Agent Skills 统一面板（启停、分类、拖排、导入、回收站、仓库源 + skills.sh/ClawHub 目录、自更新）；src 23 文件 9,515 行，唯一 runtime dep 是 fflate。\n1. 不喧宾夺主：**部分** — 走官方挂载点与原语（src/client.ts:952 `slots.inject(\"settings.section\",{id:\"skills-manager\",order:25,icon:\"skill\"})`、src/client.ts:15 官方 Button/Modal/SegmentedTabs）；但 src/settings-nav-icon.ts:92 遍历宿主 `[role=\"dialog\"] nav button`、:58/:64 给宿主按钮打属性并 prepend 自家 span、:27 `[data-dssm-nav-icon=\"skills\"]>svg{display:none!important}` 隐藏宿主 svg。\n2. 不过度设计：**部分** — src/core.ts 3,633 行单文件揽下解析/ZIP/分类/工作区/路由；src/index.ts:55-108 自写日志轮转与 body 流解析（已注入官方 webServer，src/index.ts:429）。\n3. 配置自由：**不达标** — 全仓无 schemastery/Config 声明（grep 仅命中 src/index.ts:407 的 JSON schema 字面量）；可配的只有数据面启停/分类（src/types.ts:79-89），日志 1 MiB（src/index.ts:48）、上传 88 MiB（:50）、更新检查与目录源全硬编码。\n4. 不重复造轮子：**达标** — src/index.ts:389 `ctx.skills.registerProvider(...)`、:393 `ctx.tools.register`、:429 `ctx.webServer.register` 均官方扩展点，ZIP 用 fflate，官方包按规范放 devDeps + `dsh.client.inject`；负向：src/plugin-updater.ts:370/401/411 自写整套 `dsh plugin add` 升级流程，与官方插件管理等价。\n5. 性能保证：**不达标** — src/s…"),
    pair("assistant", "已完成 4 个插件的评审并回传给父 agent（上方正文即完整结论，约 100 行）。\n\n补充说明两点边界：\n- 全程只读，未安装依赖、未修改文件、未联网；月下载量取自本地 `/tmp/dsh-audit/metrics.jsonl`（skills-manager 212,152 / archive-manager 182,647 / dsh-ops 22,879 / dsh-custom-mode 11,982）。\n- 为核对「是否重复造轮子」，额外读了本机已装的官方包（`dsh-workspace`、`dsh-client-ui-workspace`、`dsh-client-ui-primitives` 的引用面）以确认官方确实已有 `archiveSession`、`Modal`、`agentPresets` 等能力；`dsh-client-ui-primitives` 本体不在这份 checkout 内，故官方 Modal 的存在是由 skills-manager 的正常使用（src/plugin-update-ui.ts:3）反推的，这一点若你们要更硬的证据可以再补官方包读源。\n\n最关键的那个判定事实：`@michengai/dsh-archive-manager` 在运行时把自家 `ArchiveWorkspaceRegistry.prototype` 的方法逐个覆盖到宿主 `workspaceRegistry` 实例上（src/workspace.ts:1531-1536）——四者中唯一直接命中「替换官方既有行为」的结构性实现。"),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, "简体中文", "14. ③守卫：混合 应判 简体中文，实际: " + result);
}

// ─── 15. ③守卫 + 反向回归守卫：① 让真实用户消息回归后仍应判界面语言（5fcf54bd turn1） ───
{
  const pairs = [
    pair("user", "你在目录 /home/wujue/workspace/dsh-plugins/dsh-suggest-ghost 工作。**只读调研，禁止修改任何文件、禁止写新文件、禁止 git 操作。**\n\n目标：查清浏览器客户端这一侧「幽灵文本」从收到载荷到绘制、到 Tab 采纳的完整路径，为「改成流式（文本逐段变长）」的设计指出会受影响的位置。证据一律给 `src/...:行号`。\n\n重点文件：src/cl…"),
    pair("assistant", "I'll start by mapping the repo structure and then reading the key files."),
    pair("assistant", "Now let me read the key files. Starting with the smaller ones plus the first chunk of the main client file."),
    pair("assistant", "Now the main client file. Let me locate key symbols first, then read the relevant regions."),
    pair("assistant", "Research complete. Here is the fact list I'll send to the parent, and the same content as my reply."),
    pair("assistant", "只读调研完成，未修改/新建任何文件，未执行 git 写操作。结果已发给父 agent。以下是要点（行号 = 当前工作树）。\n\n## 1. `_push` 载荷处理链\n- **订阅点**：`remote.$on?.('settings/document-updated', onDocumentUpdated)` [src/client/index.ts:1602](src/client/index.…"),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, "简体中文", "15. ③守卫 +  应判 简体中文，实际: " + result);
}

// ─── 16. 线上语义守卫：语料 A（dsh-later turn2，v0.6.0 用被裁到 2 对的转录判 English） ───
{
  const pairs = [
    pair("user", "你看看github那边的issues，现在是不是解决了"),
    pair("assistant", "已核对了 GitHub 上的 issues，也对着本地 1.5.0 源码实测复现了两遍 —— **结论：两条都还没解决，GitHub 上仍是 OPEN，代码里的病根也原样在那。**\n\n（GitHub 仓库只有 3 个 issue：#7 已关闭，#5、#6 仍 OPEN。）\n\n## #6 面板自定义时间 HH:mm 必被拒 —— 未解决（核心缺陷仍在）\n\n用当前构建产物（`dsh-schedule`…"),
    pair("user", "解决了的话，你引用提交，评论回复并关闭issues"),
    pair("assistant", "理解你的条件是「解决了才关」。所以在关之前，我把「是不是真解决了」再往深核一层——特别是有没有**别的机制**已经覆盖了这两条（比如代次护栏让插件在 rc.1 上直接拒绝加载，而不是静默投递失败）。"),
    pair("assistant", "核完了。**两条都没解决，所以按你给的条件，我没有关任何一个，也没法引用提交——仓库里不存在对应的提交。**\n\n我这次专门多查了一轮\"会不会有别的机制已经兜住了\"，结论是没有：\n\n| 可能的兜底机制 | 实测结论 |\n|---|---|\n| 插件启动期代次拦截 | **不存在**。`src/index.ts` 的 `apply()` 里没有代次判断；唯一的拦截来自宿主 peer 校验，而 [ups…"),
    pair("assistant", "明白 —— 把这两条镜像到 Gitea 侧跟踪。先确认 Gitea 的访问方式和现有 issue，避免建重复的。"),
    pair("assistant", "已同步到 Gitea 侧，两条都在 `dsh-plugins/dsh-later` 的 open 列表里：\n\n| GitHub | → Gitea | 标题 |\n|---|---|---|\n| [#5](https://github.com/dsh-plugin-collection/dsh-later/issues/5) | **[#75](http://192.168.4.77:3000/ds…"),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, "简体中文", "16. 线上语义守卫 应判 简体中文，实际: " + result);
}

// ─── 17. 覆盖判据没变成死代码：真人纯英文长提示仍能推翻 zh 先验 ───
{
  const pairs = [
    pair('user', 'Please refactor the webhook dispatcher and add retry with exponential backoff'),
    pair('user', 'Also update the tests and the changelog accordingly'),
    pair('user', 'Then open a pull request against main and watch the CI run'),
  ];
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, 'English', '纯英文证据必须仍能推翻 zh 先验，实际: ' + result);
}

console.log('✅ suggestionLanguage 17 组用例全部通过');

