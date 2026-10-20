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

console.log('✅ suggestionLanguage 13 组用例全部通过');

