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
// 行状态判据本体在 keyspec.ts（卡片只是喂参数）——静态 import，不用 dynamic：
// 本脚本的 run() 第一版不认 Promise，async 用例的断言失败会静默打 ✓（已修，见 run 的注释）。
import { keyRowStateOf } from '../src/client/keyspec.ts';
import { bindingTableFor } from '../src/client/accept-key.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
/**
 * 登记并立刻跑一条用例。**必须认 Promise**：
 * 本脚本第一版的 `run` 只 try 同步调用，于是任何写成 `async` 的用例
 * ——断言的 rejection 落在返回的 Promise 上，`failed` 永远不加——
 * **无论对错都打 ✓**。这是一道假闸，比没有闸更糟（它会让人以为判据在跑）。
 * 现在 async 用例必须 await，且顶层用 `await run(...)` 串起来。
 */
const run = async (name, fn) => {
  try {
    await fn();
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
await run('① src/index.ts：六个键位字段齐、默认值一致、都标 .volatile()', () => {
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
await run('② src/generate.ts：flattenConfig 与 resolveConfig 两处兜底都与 schema 同值', () => {
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
await run('③ src/live-settings.ts：六键都在 SETTING_SPECS，空串口径正确', () => {
  const ls = read('src/live-settings.ts');
  for (const { key, allowEmpty } of KEYS) {
    const want = allowEmpty ? 'true' : 'false';
    assert.match(ls, new RegExp(`^\\s*${key}: STR\\(${want}\\),`, 'm'),
      `${key} 不在 SETTING_SPECS 里（或 STR 参数不是 ${want}）→ 设置页改了不生效（#19 那一类）`);
  }
});

// ── ④ 设置卡片 ──────────────────────────────────────────────────────────
await run('④ settings-card.tsx：六行卡片都在、可写、且都归进 keybinds 分区', () => {
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
await run('⑤ 两份 README 都写了六个键位字段', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const doc = read(file);
    for (const key of NAMES) assert.ok(doc.includes(key), `${file} 里没有 ${key}`);
  }
});

// ── ⑥ 客户端兜底：旧宿主 / describe 缺席时不许改变键位 ──────────────────
await run('⑥ src/client/index.ts：客户端初值与 live 读取的兜底都与 DEFAULT_* 同值', () => {
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

// ── ⑨ 行状态判据（排版改版新增；本体在 keyspec.ts，所以这里钉得住）──────
await run('⑨ keyRowStateOf：四态齐全，且冲突只按字段实际参与的表算', () => {
  const btf = bindingTableFor;
  // 两张表用真判据组，避免本脚本自己抄一份形状
  // 夹具必须**像卡片那样**把 dismissKey 传进去：卡片是 `tableOf(…, read, switches)`，
  // 六个键全传。第一版这里漏传 ⇒ 表里没有 dismiss 格 ⇒ 判成 off，
  // 看着像判据错了，其实是夹具与调用点不同形（这类假红最费时间）。
  const mk = (over) => ({
    llm: btf({ kind: 'llm', dismissKey: 'Escape', ...over }),
    local: btf({ kind: 'history', dismissKey: 'Escape', ...over }),
  });
  assert.equal(keyRowStateOf(mk({}), ['llm'], 'accept', ''), 'unbound', '留空必须判不接管');
  assert.equal(keyRowStateOf(mk({ wordAccept: false }), ['local'], 'word', 'Right'), 'off',
    '开关关掉后该动作不在表里 ⇒ 必须判已关闭');
  // ★ 本单实测写错过的那一条：local 表内部撞键，不该让只在 llm 表的 acceptKey 亮同键。
  const clashLocal = mk({ localAcceptKey: 'F5', wordAcceptKey: 'F5' });
  assert.equal(keyRowStateOf(clashLocal, ['local'], 'accept', 'Tab'), 'clash',
    'local 表内 accept 与 word 同键 ⇒ 该行该亮同键');
  assert.equal(keyRowStateOf(clashLocal, ['llm'], 'accept', 'Tab'), 'live',
    '★ 只在 llm 表参与的字段，绝不能因为 local 表内部撞键而亮同键（假警告）');
  assert.equal(keyRowStateOf(mk({ regenKey: 'Tab' }), ['llm'], 'accept', 'Tab'), 'clash',
    'llm 表内 accept 与 regen 同键 ⇒ 亮同键');
  assert.equal(keyRowStateOf(mk({}), ['llm', 'local'], 'dismiss', 'Escape'), 'live');
  // ★ 判据只回答「此刻这张表接不接管」，**不回答为什么不接管**：
  // 值非空但表里没有这一格 ⇒ 同样是 off（卡片按有没有开关决定文案，见 kbStateOff / kbStateUnbound）。
  assert.equal(keyRowStateOf(mk({}), ['llm'], 'word', 'Right'), 'off',
    'word 不在 llm 表里 ⇒ 必须判 off（而不是 live）');
});

// ── ⑩ 名字只有一个出口（表格化新增）────────────────────────────────────
run('⑩ 键位警告/拒绝文案引用 kbName，不各自取 label', () => {
  const card = read('src/client/settings-card.tsx');
  const code = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 判据（**第一版太宽，实测抓到了一条不是缺陷的**）：卡片里 `?.label[lang]` 出现一次在
  // 开关自己的 `aria-label` 上——那是故意的：屏幕阅读器念的是控件本身，而这个控件在界面上
  // 没有可见名字，全称才是完整语境。所以这里只禁「**跨字段引用**时用全称」。
  // 要防的形状是：行上印「逐词采纳」，警告里却说「与「逐词采纳快捷键」用了同一个键」——
  // 同一张卡片给同一个东西起两个名字，用户得自己对上。
  const kbBody = /const kbName = [\s\S]*?\n};/.exec(code);
  assert.ok(kbBody !== null, '找不到 kbName 函数体（形状变了，本条判据要跟着改）');
  const crossRefs = [...code.matchAll(/[^\n]*(?:GHOST_FIELDS\.find\([^\n]*\)\??\.label\[lang\]|labelOf\([^\n]*\))[^\n]*/g)]
    .map((m) => m[0].trim())
    .filter((line) => !kbBody[0].includes(line))
    // 放行：控件自身的 aria-label（上面已说明为什么那是故意的，不是漏网）
    .filter((line) => !line.includes('aria-label'));
  assert.deepEqual(crossRefs, [],
    `有 ${crossRefs.length} 处在 kbName 之外拼「别的字段的全称 label」：\n      ${crossRefs.join('\n      ')}`);
  assert.match(code, /t\.keyUnsafe\(kbName\(/, '拒绝文案没走 kbName');
  assert.match(code, /t\.keyConflict\(kbName\(/, '撞键文案没走 kbName');
});

// ── ⑦ 键位表的分组覆盖（排版改版新增）────────────────────────────────────
await run('⑦ 每个键位字段都有 KEY_TABLES 条目（表格分组由它投影）', () => {
  const card = read('src/client/settings-card.tsx');
  const tablesBlock = /const KEY_TABLES: Record<string, readonly \([^)]*\)\[\]> = \{([\s\S]*?)\n\};/.exec(card);
  assert.ok(tablesBlock !== null, '找不到 KEY_TABLES（形状变了？分组投影的判据就断了）');
  const listed = [...tablesBlock[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  // 卡片里 kind==='key' 且归 keybinds 分区的字段集合。
  // ⚠️ 必须**按字段块切**再判，不能用「key: X … 900 字符内出现 section:'keybinds'」——
  // 那种写法会把 llm 组最后一个字段也捞进来（实测误报过 timeoutMs / regenEnabled /
  // historyMinChars：它们自己不是键行，只是**下一个**字段是键行）。
  const blocks = card.split(/\n  \{\n/).slice(1);
  const rowKeys = blocks
    .filter((b) => /^\s*key: '(\w+)',/.test(b)
      && /section: 'keybinds'/.test(b)
      && /kind: 'key'/.test(b))
    .map((b) => /^\s*key: '(\w+)',/.exec(b)[1]);
  assert.ok(rowKeys.length >= 5, `只认出 ${rowKeys.length} 个键行，解析方式大概漂了（应为 6）`);
  const missing = rowKeys.filter((k) => !listed.includes(k));
  assert.deepEqual(missing, [],
    `这些键位字段没有 KEY_TABLES 条目 ⇒ keybindGroups() 会把它静默归进「所有形态」，`
    + `而适用范围是**界面在代替仲裁表说话**：${missing.join(', ')}`);
  const orphan = listed.filter((k) => !rowKeys.includes(k));
  assert.deepEqual(orphan, [], `KEY_TABLES 里有没人用的条目（死登记，删掉或补字段）：${orphan.join(', ')}`);
});

// ── ⑧ 开关必须挂在动作行上，不独立成行 ──────────────────────────────────
await run('⑧ 两个动作开关挂在各自键行（KEYBIND_SWITCH_OF），且没有独立渲染', () => {
  const card = read('src/client/settings-card.tsx');
  for (const [row, sw] of [['wordAcceptKey', 'wordAccept'], ['regenKey', 'regenEnabled']]) {
    assert.match(card, new RegExp(`${row}: '${sw}',`), `开关 ${sw} 没挂到 ${row} 行`);
  }
  assert.match(card,
    /const keybindFields = GHOST_FIELDS\.filter\(f => f\.section === 'keybinds' && f\.kind === 'key'\)/,
    'keybindFields 没有只取键行 ⇒ 开关会作为独立一行混进表里（旧版扫读断裂的原因）');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} keybinding-registration-smoke: ${failed === 0 ? '五处登记点一致' : `${failed} 处漂移`}`);
process.exit(failed === 0 ? 0 : 1);
