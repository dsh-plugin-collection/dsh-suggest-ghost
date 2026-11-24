#!/usr/bin/env node
/**
 * 自定义提示词（Gitea #182）冒烟：登记点一致 + 留空逐字不变 + 占位符展开 + 端到端接线。
 *
 * ## 它挡的是哪三类事故
 *
 * 1. **登记点漂移**。一个 volatile 设置项要同时活在 `src/index.ts` 的 schema、
 *    `src/generate.ts` 的**两处** `readVolatile`、`src/live-settings.ts` 的键表、
 *    `src/client/settings-card.tsx` 的卡片行，以及两份 README 里。少一处 = 「设置页显示 A、
 *    实际生效 B」或「改了不生效」（#19 那一类），而每一处**单独看都合法**，只有集合比对能发现。
 *    （口径同 `reasoning-effort-smoke.mjs`，那条的注释里有完整推演。）
 * 2. **默认形态被改掉**。两键默认空串，此时发给模型的 system 必须与今天**逐字相同**——
 *    README 的 42 次实测口径、`generate.ts:1045` 与 `regen.ts:226` 那句「`systemPrompt()`
 *    本体一字不改」都建立在它上面。所以用例 6 是字节级判据，不是「差不多就行」。
 * 3. **上限变成两份真相**。硬上限只写在 schema 的 `.max(PROMPT_MAX_CHARS)`，卡片引用的是
 *    `src/prompt-override.ts` 里同一个常量。卡片里出现字面量 `6000` 就说明有人抄了第二份
 *    ——抄来的数字与 schema 分叉之后，界面挡住的是另一个长度。
 *
 * ## 为什么从 lib/ 导入
 *
 * `generate.ts` 里有 `using` 声明，`node --experimental-strip-types` 剥不动它
 * （与 `reasoning-effort-smoke.mjs`、`inline-smoke.mjs` 同一取舍），所以端到端用例驱动构建产物。
 * 改完 src 记得先 `./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`
 * （`docs/gitea-workflow.md` §3：不重建就跑冒烟测的是旧字节码）。
 *
 * 用法：`node scripts/prompt-override-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlinePrompt } from '../lib/inline.js';
import { generateCompletion, generateSuggestion, systemPrompt } from '../lib/generate.js';
import {
  BUILTIN_TOKEN,
  LANGUAGE_TOKEN,
  MAX_CHARS_TOKEN,
  PROMPT_MAX_CHARS,
  expandPrompt,
  isCustomPrompt,
  promptSource,
  resolveSystemPrompt,
} from '../lib/prompt-override.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
const run = (name, fn) => {
  try {
    const out = fn();
    return out instanceof Promise
      ? out.then(
        () => console.log(`  ✓ ${name}`),
        (error) => { failed += 1; console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`); },
      )
      : (console.log(`  ✓ ${name}`), Promise.resolve());
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
    return Promise.resolve();
  }
};

const KEYS = ['suggestionPrompt', 'completionPrompt'];
/** 展开时用的变量（固定这两个值，断言才写得出来）。 */
const VARS = { language: 'English', maxChars: 240 };

// ── 1. 宿主 schema：形态必须是 `.max(PROMPT_MAX_CHARS).default('').volatile()` ──
run('src/index.ts schema：两字段齐、上限引常量、默认空串、标了 volatile', () => {
  const host = read('src/index.ts');
  for (const key of KEYS) {
    const pattern = new RegExp(`${key}: z\\.string\\(\\)\\.max\\(PROMPT_MAX_CHARS\\)\\.default\\(''\\)\\.volatile\\(\\)`);
    assert.ok(pattern.test(host), `src/index.ts 里找不到 ${key} 的 schema（形态变了？要求 .max(PROMPT_MAX_CHARS).default('').volatile()）`);
    // 输出类型必须是 Volatile<string>，否则 PluginConfigValues 与推断不符（同 #35 那条）。
    assert.ok(new RegExp(`${key}: Volatile<string>;`).test(host),
      `PluginConfigValues 里 ${key} 不是 Volatile<string>`);
  }
  assert.ok(/import \{[^}]*PROMPT_MAX_CHARS[^}]*\} from '\.\/prompt-override\.js'/
    .test(host), 'src/index.ts 没有从 prompt-override.ts 引上限常量 ⇒ 上限正在变成两份');
});

// ── 2. generate.ts 的两处 readVolatile 与 schema 同值 ──────────────────────────
run('src/generate.ts：flattenConfig 与 resolveConfig 两处兜底都是空串', () => {
  const gen = read('src/generate.ts');
  for (const key of KEYS) {
    const reads = [...gen.matchAll(new RegExp(`readVolatile\\((?:config|raw)\\.${key},\\s*('')\\)`, 'g'))]
      .map((m) => m[1]);
    assert.equal(reads.length, 2,
      `src/generate.ts 里 ${key} 应有 2 处 readVolatile（flattenConfig + resolveConfig），实得 ${reads.length}`);
    for (const r of reads) assert.equal(r, "''", `${key} 的 readVolatile 兜底 ${r} 与 schema 默认值不一致`);
    // 拍平后的视图必须是裸值 string，否则 live-settings 的 Record<keyof FlatConfig> 会漏键。
    assert.ok(new RegExp(`${key}: string;`).test(gen), `FlatConfig 里 ${key} 不是裸 string`);
  }
});

// ── 3. live-settings 键表 + 设置卡片行（漏一处就是 #19 那一类）─────────────────
run('src/live-settings.ts 键表：两键都在且允许空串（空 = 内置，是合法写入值）', () => {
  const ls = read('src/live-settings.ts');
  for (const key of KEYS) {
    assert.ok(new RegExp(`^\\s*${key}: STR\\(true\\),`, 'm').test(ls),
      `${key} 不在 SETTING_SPECS 里（或不是 STR(true)）→ 设置页改了不生效，或「清空回内置」被丢弃`);
  }
  // 反向：两键绝不能被误登记进传输载体白名单（那里有一条加载期不变量会直接抛）。
  const transport = /export const TRANSPORT_KEYS[^[]*\[([^\]]*)\]/.exec(ls)?.[1] ?? '';
  for (const key of KEYS) {
    assert.ok(!transport.includes(`'${key}'`),
      `${key} 被登记成传输载体了：它会被 pickLiveSettings 从配置里剔掉`);
  }
});

run('src/client/settings-card.tsx：两行卡片都在、可写、形态是 textarea', () => {
  const card = read('src/client/settings-card.tsx');
  for (const key of KEYS) {
    assert.ok(new RegExp(`key: '${key}',`).test(card), `设置卡片里没有 ${key} 这一行`);
    assert.ok(new RegExp(`key: '${key}',[\\s\\S]{0,600}?kind: 'textarea'`).test(card),
      `${key} 这一行不是 textarea 形态`);
  }
  assert.ok(/export type FieldKind = [^\n]*'textarea'/.test(card),
    "FieldKind 里没有 'textarea'：多行提示词会被塞进单行 input");
  assert.ok(/import \{ PROMPT_MAX_CHARS \} from '\.\.\/prompt-override\.js'/.test(card),
    '卡片没有引 prompt-override 的上限常量 ⇒ 超长校验正在变成第二份数字');
  // 抄来的上限 = 第二份真相。连 `6000` 这个字面量都不许出现在卡片里。
  assert.ok(!/\b6000\b/.test(card), '卡片里出现了字面量 6000：上限应当从 PROMPT_MAX_CHARS 引');
  // 超长必须在**保存之前**挡住（内核 zod 拒绝时 save() 读不到失败，界面表现为「点了保存、值没变」）。
  assert.ok(/fieldInvalid[\s\S]{0,700}?PROMPT_MAX_CHARS/.test(card),
    '卡片没在 fieldInvalid 里按上限判超长 ⇒ 超长只会被内核静默拒掉');
});

run('两份 README 都写了这两个配置项与三个占位符', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const doc = read(file);
    for (const key of KEYS) assert.ok(doc.includes(key), `${file} 里没有 ${key}`);
    // README 还得说清占位符，否则文档等于没写（用户不知道该填什么形态）。
    for (const token of [BUILTIN_TOKEN, LANGUAGE_TOKEN, MAX_CHARS_TOKEN]) {
      assert.ok(doc.includes(token), `${file} 里没有解释占位符 ${token}`);
    }
  }
});

// ── 4. 纯函数语义：留空判定 ────────────────────────────────────────────────────
const BUILTIN = 'BUILTIN::{{language}}::{{maxChars}}';

run('留空 / 纯空白 / 非字符串 → 返回内置模板**同一个引用**', () => {
  for (const empty of ['', '   ', '\n\t ', undefined, null, 0, {}]) {
    assert.equal(resolveSystemPrompt(empty, BUILTIN, VARS), BUILTIN, `${JSON.stringify(empty)} 应当判成留空`);
    assert.equal(isCustomPrompt(empty), false, `${JSON.stringify(empty)} 不应当判成自定义`);
    assert.equal(promptSource(empty), 'builtin');
  }
  // 「同一个引用」比「相等」更强：它挡住的是「有人改成永远走 expand」——
  // 一个 `{get()}` 引用对象漏进 flattenConfig 时，展开会交出 `[object Object]`，
  // 而 `=== builtin` 这条会先红。
  assert.ok(resolveSystemPrompt('', BUILTIN, VARS) === BUILTIN, '留空时必须是同一个字符串对象');
});

run('三个占位符各自展开，未识别的原样保留', () => {
  const out = expandPrompt(`A${BUILTIN_TOKEN}B${LANGUAGE_TOKEN}C${MAX_CHARS_TOKEN}D{{unknown}}E`, 'BUILTIN', VARS);
  assert.equal(out, 'ABUILTINBEnglishC240D{{unknown}}E', `展开不符：${out}`);
  assert.equal(promptSource('x'), 'custom');
});

run('{{builtin}} 让「在内置前后加自己的规则」不需要抄全文', () => {
  const builtin = systemPrompt(240, 'English');
  const out = resolveSystemPrompt(`Follow it strictly:\n${BUILTIN_TOKEN}\nNever suggest committing.`, builtin, VARS);
  assert.ok(out.includes(builtin), '内置模板必须逐字出现在展开结果里');
  assert.ok(out.startsWith('Follow it strictly:'), '前缀应当保留');
  assert.ok(out.endsWith('Never suggest committing.'), '后缀应当保留');
});

// ── 5. 端到端夹具（与 reasoning-effort-smoke 同一套形状）────────────────────────
const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: 0,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const asstMsg = (seq, text) => ({
  type: 'assistant/message', seq, time: 0,
  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: 0, data: { turn } });
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } });

/** 假会话：有转录（建议路径要求）、有显式路由对（#47 之后不继承会话路由）。 */
const fakeSession = () => ({
  id: 'session-prompt-smoke',
  snapshotEvents: () => [
    turnStart(1, 1), userMsg(2, '把冒烟跑一遍'), asstMsg(3, '跑完了，全绿。'), turnEnd(4, 1),
  ],
  requestHeader: () => ({ config: { provider: 'p-smoke', model: 'm-smoke' } }),
});

const baseConfig = (over = {}) => ({
  provider: 'p-smoke',
  model: 'm-smoke',
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxTranscriptChars: 12000,
  maxSuggestionChars: 240,
  inlineMaxChars: 160,
  ...over,
});

/** 文本流：一条 text-delta + finish(stop)。 */
const textStream = (text) => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();

const fakeCtx = () => {
  const calls = [];
  return { calls, llm: { stream: (options) => { calls.push(options); return textStream('跑一下测试'); } } };
};
const abortOf = () => new AbortController().signal;

/**
 * `generateSuggestion` 的位置参数表（11 个）。
 * 夹具必须按**全名**传，不能像 case 10 那样数错位——`avoidBlock` 是第 11 个，
 * 倒数第 2 个才是 `onTextDelta`；错位会把无关字符串灌进 `languageMode`。
 */
const callSuggest = (ctx, cfg, extra = []) => generateSuggestion(
  ctx, cfg, fakeSession(), 1, abortOf(),
  undefined, // uiLocale
  undefined, // languageMode
  undefined, // uiLocaleWeight
  undefined, // lastLanguage
  ...extra,  // onTextDelta, avoidBlock
);
const callComplete = (ctx, cfg, draft = '把改动') => generateCompletion(
  ctx, cfg, fakeSession(), draft, abortOf(), undefined, undefined, undefined, undefined,
);

// ── 6. 留空的回归判据：发给模型的 system 与今天逐字相同 ─────────────────────────
await run('建议路径：留空 → options.system 与 systemPrompt() 逐字相同', async () => {
  const ctx = fakeCtx();
  const result = await callSuggest(ctx, baseConfig());
  assert.equal(ctx.calls.length, 1, '应当只发一次请求');
  assert.equal(ctx.calls[0].system, systemPrompt(240, result.language),
    '留空时发给模型的 system 必须与内置模板逐字一致');
  assert.equal(result.promptSource, 'builtin');
});

await run('续写路径：留空 → options.system 与 inlinePrompt() 逐字相同', async () => {
  const ctx = fakeCtx();
  const result = await callComplete(ctx, baseConfig());
  assert.equal(ctx.calls[0].system, inlinePrompt(160, result.language),
    '留空时续写的 system 必须与内置逐字一致');
  assert.equal(result.promptSource, 'builtin');
});

// ── 7. 自定义真的到得了模型，且两路径分键不串台 ────────────────────────────────
await run('建议路径：自定义模板 → 展开结果就是 options.system', async () => {
  const ctx = fakeCtx();
  const template = `只输出一句中文待办。上限 {{maxChars}} 字，语言 {{language}}。`;
  const result = await callSuggest(ctx, baseConfig({ suggestionPrompt: template }));
  const expected = template
    .split(MAX_CHARS_TOKEN).join('240')
    .split(LANGUAGE_TOKEN).join(result.language);
  assert.equal(ctx.calls[0].system, expected, `自定义模板没按预期到达模型：${ctx.calls[0].system}`);
  assert.equal(result.promptSource, 'custom');
});

await run('续写路径：自定义模板 → 展开结果就是 options.system', async () => {
  const ctx = fakeCtx();
  const template = `Continue the draft only. Max {{maxChars}} chars, language {{language}}.`;
  const result = await callComplete(ctx, baseConfig({ completionPrompt: template }));
  const expected = template
    .split(MAX_CHARS_TOKEN).join('160')
    .split(LANGUAGE_TOKEN).join(result.language);
  assert.equal(ctx.calls[0].system, expected, `续写模板没按预期到达模型：${ctx.calls[0].system}`);
  assert.equal(result.promptSource, 'custom');
});

await run('两条路径分键，互不串台（同 #35 档位的口径）', async () => {
  const only = baseConfig({ suggestionPrompt: 'SUGGESTION-ONLY' });
  const ctxA = fakeCtx();
  await callSuggest(ctxA, only);
  assert.ok(ctxA.calls[0].system.includes('SUGGESTION-ONLY'), '建议路径没读到 suggestionPrompt');

  const ctxB = fakeCtx();
  const rB = await callComplete(ctxB, only);
  assert.ok(!ctxB.calls[0].system.includes('SUGGESTION-ONLY'), '续写路径读到了建议的提示词（串台）');
  assert.equal(ctxB.calls[0].system, inlinePrompt(160, rB.language), '续写在只配建议时应当仍是内置模板');

  const ctxC = fakeCtx();
  await callComplete(ctxC, baseConfig({ completionPrompt: 'COMPLETION-ONLY' }));
  assert.ok(ctxC.calls[0].system.includes('COMPLETION-ONLY'), '续写路径没读到 completionPrompt');

  const ctxD = fakeCtx();
  await callSuggest(ctxD, baseConfig({ completionPrompt: 'COMPLETION-ONLY' }));
  assert.ok(!ctxD.calls[0].system.includes('COMPLETION-ONLY'), '建议路径读到了续写的提示词（串台）');
});

// ── 8. 内置模板本体没被改动（两条路径的 builtin 仍来自那两个函数）──────────────
run('systemPrompt() / inlinePrompt() 仍是唯一的内置出处', () => {
  const gen = read('src/generate.ts');
  const inline = read('src/inline.ts');
  assert.ok(/const builtinSystem = systemPrompt\(config\.maxSuggestionChars, language\)/.test(gen),
    '建议路径的内置模板不再是 systemPrompt() 的直接调用（有人把展开塞进函数本体了）');
  assert.ok(/const builtinSystem = inlinePrompt\(inlineMaxChars, language\)/.test(gen),
    '续写路径的内置模板不再是 inlinePrompt() 的直接调用');
  // 内置函数本体不接受第三个参数（模板注入点必须在调用处，见 generate.ts:1045 那条纪律）。
  assert.ok(/export function systemPrompt\(maxSuggestionChars: number, language: string\): string/.test(gen),
    'systemPrompt 的签名被动过了');
  assert.ok(/export function inlinePrompt\(maxChars: number, language: string\): string/.test(inline),
    'inlinePrompt 的签名被动过了');
});

// ── 9. 留痕：四条产出行都带 prompt=，且既有前缀一字未动 ────────────────────────
run('四条产出行都带 prompt=，且追加在行尾（既有键序与前缀未动）', () => {
  const host = read('src/index.ts');
  const prefixes = [
    'completion generated session=',
    'completion dropped (empty or filtered) session=',
    'suggestion generated session=',
    'suggestion dropped (empty or filtered) session=',
  ];
  for (const prefix of prefixes) {
    const line = host.split('\n').find((l) => l.includes(`traceOps(\`${prefix}`));
    assert.ok(line !== undefined, `找不到留痕行：${prefix}`);
    assert.ok(line.includes('at=${Date.now()}'), `${prefix} 的既有段被动过（sandbox.greps 靠它抓行）`);
    assert.ok(/prompt=\$\{(value|result)\.promptSource\}`\);/.test(line),
      `${prefix} 的行尾没有追加 prompt= 读数`);
  }
});

// ── 10. 已知缺陷的钉桩：avoidBlock 今天**没有**拼进 system ─────────────────────
// 这条不是「验收」，是把 #182 里登记的既有缺陷钉成断言：`generateSuggestion` 收了
// `avoidBlock` 形参（`src/generate.ts:1052`）却从未在函数体里引用它。
// 将来有人接上拼接时**本条必红**，那时请连同 issue 与 `docs/editable-prompt-design.md` §6
// 一起更新，而不是把这条删掉了事——删掉它等于把缺陷重新变回静默。
await run('既有缺陷钉桩：avoidBlock 仍未拼进 system（修它时这条会红，见 #182 / design §6）', async () => {
  const ctx = fakeCtx();
  await callSuggest(ctx, baseConfig({ suggestionPrompt: 'MY-PROMPT' }), [undefined, 'MUST-NOT-REPEAT-BLOCK']);
  assert.ok(!ctx.calls[0].system.includes('MUST-NOT-REPEAT-BLOCK'),
    'avoidBlock 现在被拼进 system 了 ⇒ 缺陷已修，请同步更新本冒烟与 #182 的记录');
  assert.ok(ctx.calls[0].system.includes('MY-PROMPT'), '自定义提示词应当仍然生效（拼不拼接与它无关）');
});

// ── 11. 上限判的是模板，不是展开结果 ───────────────────────────────────────────
run('上限只有一份：PROMPT_MAX_CHARS 约束模板长度，{{builtin}} 展开后的总长不受它夹', () => {
  assert.equal(PROMPT_MAX_CHARS, 6000, '上限改了要同步两份 README 与卡片说明（用户看到的数字来自那里）');
  const builtin = systemPrompt(240, 'English');
  const template = `${BUILTIN_TOKEN}\n再加一条你自己的规则。`;
  assert.ok(template.length < PROMPT_MAX_CHARS, '夹具本身应当在上限内');
  const out = resolveSystemPrompt(template, builtin, VARS);
  assert.ok(out.includes(builtin), '内置全文应当原样进入展开结果');
  assert.ok(out.length > template.length, '展开后的长度由内置模板决定，可以大于模板自身的上限');
});

console.log('');
if (failed > 0) {
  console.error(`❌ prompt-override-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ prompt-override-smoke: 全部通过（登记点一致、留空逐字不变、占位符展开、两路径分键、留痕带 prompt=）');
