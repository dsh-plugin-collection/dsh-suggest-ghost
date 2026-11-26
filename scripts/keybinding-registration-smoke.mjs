#!/usr/bin/env node
/**
 * 键位设置项的**五处登记点**集合比对（Gitea #157 续）。
 *
 * ## 为什么必须有这道闸，而不是「记得都改」
 *
 * 一个 volatile 设置项要同时活在五个地方：
 *   ① `src/index.ts` 的 `EditableFields`（schema，决定能不能热写）
 *   ② `src/generate.ts` 的**两处** `readVolatile`（`flattenConfig` + `resolveConfig`，
 *      漏一处 = 解析层与拍平层给出不同默认值，见 Gitea #124 配置面）
 *   ③ `src/live-settings.ts` 的 `SETTING_SPECS`（漏登记 = `describe()` 读到但被丢弃，
 *      生效值永远停在 boot 快照，就是 #19 那个「改了不生效」）
 *   ④ `src/client/settings-card.tsx` 的 `GHOST_FIELDS`（用户在界面上看不见这一项）
 *   ⑤ 两份 README（用户文档）
 * 每一处**单独看都合法**，所以只有集合比对能发现问题。
 *
 * ## 为什么这道闸特别重要：`.tsx` 没有类型门禁
 *
 * `tsconfig.client.json` 的 include 是 `src/client/` 下的 `.ts`（`.tsx` 不在内：
 * 开 `jsx` 会照出上百条存量问题，见该文件头部与 Gitea #87）。于是 ④ 这一处
 * **编译器根本不看**——历史上同一个联合类型里留着早就不用的 `'display'`、
 * 实际在用的 `'appearance'` 反而没声明，两边都不报错。
 * ⇒ ④ 只能靠本脚本这种集合比对兜住，不是可选的锦上添花。
 *
 * ## 默认值三处一致
 *
 * schema 的 `.default('X')`、`generate.ts` 的 `readVolatile(..., 'X')`、
 * 客户端 `settings` 初值，三处必须逐字相同；`accept-key.ts` 的 `DEFAULT_*` 常量
 * 是它们的**单点定义**，本脚本从那里读，不写第二份字面量。
 *
 * 用法：node --experimental-strip-types scripts/keybinding-registration-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACCEPT_KEY, DEFAULT_DISMISS_KEY, DEFAULT_FORGET_KEY, DEFAULT_REGEN_KEY, DEFAULT_WORD_ACCEPT_KEY } from '../src/client/accept-key.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
const run = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 键位字段 -> 期望默认值（空串合法的那些单独标记）。 */
const KEYS = [
  { key: 'acceptKey', def: DEFAULT_ACCEPT_KEY, allowEmpty: false },
  { key: 'localAcceptKey', def: DEFAULT_ACCEPT_KEY, allowEmpty: false },
  { key: 'wordAcceptKey', def: DEFAULT_WORD_ACCEPT_KEY, allowEmpty: false },
  { key: 'regenKey', def: DEFAULT_REGEN_KEY, allowEmpty: false },
  { key: 'dismissKey', def: DEFAULT_DISMISS_KEY, allowEmpty: true },
  // 本单：「别再给我补这句」。与 `dismissKey` 同一条空串口径（不接管是合法意愿）。
  { key: 'forgetKey', def: DEFAULT_FORGET_KEY, allowEmpty: true },
];
const NAMES = KEYS.map((k) => k.key);

// ── ① schema：都在、默认值正确、都标了 volatile ──────────────────────────
run('① src/index.ts：六个键位字段齐、默认值一致、都标 .volatile()', () => {
  const host = read('src/index.ts');
  for (const { key, def, allowEmpty } of KEYS) {
    // 中间那段（可能含 `.min(1)`）用 (.*?) 捕获：写成正则字符类时容易漏掉括号转义，
    // 结果 new RegExp 直接抛「Unmatched ')'」——断言以「红」的形式暴露，不会假绿。
    const re = new RegExp(`${key}: z\\.string\\(\\)(.*?)\\.default\\('([^']*)'\\)\\.volatile\\(\\)`);
    const m = re.exec(host);
    assert.ok(m !== null, `src/index.ts 里找不到 ${key} 的 schema（形态变了？）`);
    assert.equal(m[2], def, `${key} 的 schema 默认值是 "${m[2]}"，应为 "${def}"`);
    const hasMin = m[1].includes('.min(1)');
    assert.equal(hasMin, !allowEmpty,
      `${key} 的 min(1) = ${hasMin}，但 allowEmpty = ${allowEmpty}：空串合法的键位加了 min(1) 就写不进「不接管」`);
  }
});

// ── ② generate.ts 的两处 readVolatile 与 schema 同值 ─────────────────────
run('② src/generate.ts：flattenConfig 与 resolveConfig 两处兜底都与 schema 同值', () => {
  const gen = read('src/generate.ts');
  for (const { key, def } of KEYS) {
    const hits = [...gen.matchAll(new RegExp(`readVolatile\\((?:config|raw)\\.${key},\\s*'([^']*)'\\)`, 'g'))].map((m) => m[1]);
    assert.equal(hits.length, 2, `${key} 应有 2 处 readVolatile（flattenConfig + resolveConfig），实得 ${hits.length}`);
    for (const h of hits) assert.equal(h, def, `${key} 的 readVolatile 兜底 "${h}" 与 schema 默认值 "${def}" 不一致`);
    // 只对本单**显式声明**的三个新键要求 `X: string;` 这一行。
    // `acceptKey` 也在拍平块里（历史如此）；`regenKey` **不在**——它从 `Config & {…}` 的
    // 交叉类型带过来，于是 `FlatConfig` 里它的类型是 `Volatile<string>` 而不是裸串。
    // 这是一条**已存在**的漂移（不是本单造成的），本单不顺手改：改它要连带动
    // `pickLiveSettings` 的返回类型口径，属于另一件事，已写进 PR 的遗留项。
    if (['localAcceptKey', 'wordAcceptKey', 'dismissKey'].includes(key)) {
      assert.match(gen, new RegExp(`${key}: string;`), `FlatConfig 里 ${key} 不是裸 string → live-settings 的 Record<keyof FlatConfig> 会读错类型`);
    }
  }
});

// ── ③ live-settings 键表 ────────────────────────────────────────────────
run('③ src/live-settings.ts：六键都在 SETTING_SPECS，空串口径正确', () => {
  const ls = read('src/live-settings.ts');
  for (const { key, allowEmpty } of KEYS) {
    const want = allowEmpty ? 'true' : 'false';
    assert.match(ls, new RegExp(`^\\s*${key}: STR\\(${want}\\),`, 'm'),
      `${key} 不在 SETTING_SPECS 里（或 STR 参数不是 ${want}）→ 设置页改了不生效（#19 那一类）`);
  }
});

// ── ④ 设置卡片 ──────────────────────────────────────────────────────────
run('④ settings-card.tsx：六行卡片都在、可写、且都归进 keybinds 分区', () => {
  const card = read('src/client/settings-card.tsx');
  for (const key of NAMES) {
    const block = new RegExp(`key: '${key}'[\\s\\S]{0,700}?section: '([a-z]+)'`).exec(card);
    assert.ok(block !== null, `设置卡片里没有 ${key} 这一行`);
    assert.equal(block[1], 'keybinds', `${key} 落在 "${block[1]}" 分组，不在「键位」里 → 用户改键要翻多个分区`);
  }
  // 分区联合必须与实际用值一致：`.tsx` 没有类型门禁，这条只能这么核。
  const union = /readonly section: ([^;]+);/.exec(card);
  assert.ok(union !== null, '找不到 section 的联合类型声明');
  for (const used of [...card.matchAll(/section: '([a-z]+)'/g)].map((m) => m[1])) {
    assert.ok(union[1].includes(`'${used}'`), `字段用了 section '${used}'，但联合类型里没声明它（.tsx 不检查，不会报错）`);
  }
  // 声明了却没人用的值 = 后门（历史上 'display' 就这么烂在那里）。
  for (const declared of [...union[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])) {
    assert.ok([...card.matchAll(/section: '([a-z]+)'/g)].some((m) => m[1] === declared),
      `section 联合里 '${declared}' 没有任何字段在用（死值，删掉）`);
  }
});

// ── ⑤ README 两份 ───────────────────────────────────────────────────────
run('⑤ 两份 README 都写了六个键位字段', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const doc = read(file);
    for (const key of NAMES) assert.ok(doc.includes(key), `${file} 里没有 ${key}`);
  }
});

// ── ⑥ 客户端兜底：旧宿主 / describe 缺席时不许改变键位 ──────────────────
run('⑥ src/client/index.ts：客户端初值与 live 读取的兜底都与 DEFAULT_* 同值', () => {
  const client = read('src/client/index.ts');
  // `Alt+G` 里的 `+` 是正则量词——不转义的话这条断言会「匹配不到」而不是报错，
  // 表现成「客户端初值不对」的假红（本脚本第一版就红在这儿）。
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `acceptKey` **不在客户端 settings 里**：llm 形态的采纳键是随建议载荷一起来的
  // （`GhostPushPayload.suggestion.acceptKey`，宿主在生成那一刻读的值），
  // 客户端只兜它的缺省。所以下面这一圈只跑「客户端自己持有」的四个键，
  // acceptKey 由最后那条单独的形状断言管。
  for (const { key, def } of KEYS.filter((k) => k.key !== 'acceptKey')) {
    const init = new RegExp(`${key}: '${esc(def)}',`).test(client);
    const live = new RegExp(`${key}:[\\s\\S]{0,160}?: '${esc(def)}'`).test(client);
    assert.ok(init, `客户端 settings 初值里 ${key} 不是 "${def}"（旧宿主上会凭空改变键位）`);
    assert.ok(live, `客户端 live 读取里找不到 ${key} 的 "${def}" 兜底（#19 那一类：改了不生效 / 缺席时漂移）`);
  }
  // acceptKey 的客户端路径：载荷缺省时必须回落到**同一个** DEFAULT_ACCEPT_KEY，
  // 而不是文件里再写一份 'Tab' 字面量（#167 那条「不留第二份字面量」的规矩）。
  assert.match(client, /acceptKey: settings\.suggestion\?\.acceptKey \?\? DEFAULT_ACCEPT_KEY/,
    '客户端的 acceptKey 兜底没有走 DEFAULT_ACCEPT_KEY（要么改了载荷路径，要么偷偷写回了字面量）');
  assert.equal((client.match(/\?\? 'Tab'/g) ?? []).length, 0,
    '客户端里又出现了 `?? \u0027Tab\u0027` 这类第二份字面量（该走 DEFAULT_ACCEPT_KEY）');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} keybinding-registration-smoke: ${failed === 0 ? '五处登记点一致' : `${failed} 处漂移`}`);
process.exit(failed === 0 ? 0 : 1);
