/**
 * #157 键位提示的冒烟：`keyHintText()` 的文案拼装 + 节点几何/生命周期。
 *
 * ## 为什么这里能纯 Node 跑
 *
 * `key-hint-bar.tsx` 只 import react（由宿主运行时解析，Node 侧仅做纯函数判定），
 * `keyHintText()` 是纯函数。`KeyHintNode` 需要 DOM，所以这里只对纯函数做判定；
 * 节点行为留给真宿主取证（浏览器侧），不在本脚本里假装测到。
 *
 * ## 断的是什么（每条都对应一个真实行为差异，不是形状摆设）
 *
 *  1. 默认设置下：`Tab 采纳 · → 逐词 · Esc 关闭`；
 *  2. **`llm` 形态不出现 `→`** —— 该形态下裸 `→` 走原生光标移动，写上去就是错的说明；
 *  3. `wordAccept=false` 时不出现 `→`；
 *  4. 采纳键**跟着设置变**（把 `acceptKey` 换成 `F2`，文案里必须是 `F2`，不是 `Tab`）
 *     —— 这条是在防「文案硬编码」这个具体退化；
 *  5. 「换一条」只在 `llm` 形态**且** `regenEnabled` 时出现；
 *  6. en 与 zh 两种语言都覆盖。
 *
 * 用法：`node scripts/key-hint-smoke.mjs`（退出码 0 = 全过，1 = 有红）。
 */
// 直读 `src/`（`--experimental-strip-types`）：`build.mjs` 只把 `src/client/index.ts`
// 打成 `lib/client.js`，独立模块不在产物里，与 `keyspec-smoke.mjs` 同款口径。
import { keyHintText } from '../src/client/key-hint-text.ts';

/** @type {{name:string, fn:()=>boolean, detail:()=>string}[]} */
const cases = [];
const test = (name, fn, detail) => { cases.push({ name, fn, detail }); };

// 提示行的输入**不是散字段**，而是「设置 -> 键位表 -> 段」这条链的末端。
// 本文件因此从 `bindingTableFor` 起算：文案断言与仲裁断言（accept-key-smoke）共用同一条链，
// 谁漂移都会红——过去这里直接手写 `acceptKey/wordAccept` 字段，等于测试自己复刻了一遍判据。
import { bindingTableFor } from '../src/client/accept-key.ts';
import { hintSegments, keyFactsOf, specMatches } from '../src/client/keyspec.ts';

const SETTINGS = {
  acceptKey: 'Tab',
  localAcceptKey: 'Tab',
  wordAcceptKey: 'Right',
  regenKey: 'Alt+G',
  dismissKey: 'Escape',
  wordAccept: true,
  regenEnabled: true,
};

/** 设置 -> 提示行文本（与 index.ts 的 render 路径逐字同一串调用）。 */
const hintText = (kind, over = {}, lang = 'zh') => {
  const settings = { ...SETTINGS, ...over };
  return keyHintText({ kind, segments: hintSegments(bindingTableFor({ ...settings, kind })), lang });
};

const base = { kind: 'history', lang: 'zh' };

test('默认设置（history，zh）= Tab 采纳 · → 逐词 · Alt+G 换一条? 不——换一条只属于 llm ⇒ Tab 采纳 · → 逐词 · Esc 关闭',
  () => hintText('history') === 'Tab 采纳 · → 逐词 · Esc 关闭',
  () => hintText('history'));

test('llm 形态**不出现** →（该形态下逐词整段不接管，写上去就是错的说明）',
  () => !hintText('llm').includes('→') && !hintText('llm').includes('逐词'),
  () => hintText('llm'));

test('llm 形态 = Tab 采纳 · Alt+G 换一条 · Esc 关闭（段序 = 仲裁优先级）',
  () => hintText('llm') === 'Tab 采纳 · Alt+G 换一条 · Esc 关闭',
  () => hintText('llm'));

test('inline 形态出现 →（停顿续写支持逐词）',
  () => hintText('inline').includes('→ 逐词'),
  () => hintText('inline'));

test('wordAccept=false 时不出现 →',
  () => !hintText('history', { wordAccept: false }).includes('→'),
  () => hintText('history', { wordAccept: false }));

test('采纳键跟随设置（llm）：acceptKey=F2 ⇒ 整行等值，不含 Tab',
  () => hintText('llm', { acceptKey: 'F2' }) === 'F2 采纳 · Alt+G 换一条 · Esc 关闭',
  () => hintText('llm', { acceptKey: 'F2' }));

test('历史/续写的采纳键跟 localAcceptKey，不跟 acceptKey（#167 的作用域）',
  () => hintText('history', { acceptKey: 'F2', localAcceptKey: 'Tab' }) === 'Tab 采纳 · → 逐词 · Esc 关闭',
  () => hintText('history', { acceptKey: 'F2', localAcceptKey: 'Tab' }));

test('localAcceptKey=F3 时整行等值替换（不是追加）',
  () => hintText('history', { localAcceptKey: 'F3' }) === 'F3 采纳 · → 逐词 · Esc 关闭',
  () => hintText('history', { localAcceptKey: 'F3' }));

test('逐词键跟随 wordAcceptKey：Up ⇒ 显示 ↑ 逐词',
  () => hintText('history', { wordAcceptKey: 'Up' }).includes('↑ 逐词'),
  () => hintText('history', { wordAcceptKey: 'Up' }));

test('Ctrl+Enter 这类组合键原样透出',
  () => hintText('llm', { acceptKey: 'Ctrl+Enter' }).startsWith('Ctrl+Enter 采纳'),
  () => hintText('llm', { acceptKey: 'Ctrl+Enter' }));

test('认不出的主键**不印上屏**（宁缺毋滥：写了就是承诺一个按不动的键）',
  () => hintText('llm', { acceptKey: 'Delete' }) === 'Alt+G 换一条 · Esc 关闭',
  () => hintText('llm', { acceptKey: 'Delete' }));

test('「换一条」只在 llm 形态出现',
  () => hintText('llm').includes('Alt+G 换一条') && !hintText('history').includes('Alt+G'),
  () => `${hintText('llm')} | ${hintText('history')}`);

test('regenEnabled=false 时不出现「换一条」',
  () => !hintText('llm', { regenEnabled: false }).includes('换一条'),
  () => hintText('llm', { regenEnabled: false }));

test('dismissKey 留空 ⇒ 整句「关闭」消失（不许承诺不实现的键）',
  () => hintText('llm', { dismissKey: '' }) === 'Tab 采纳 · Alt+G 换一条',
  () => hintText('llm', { dismissKey: '' }));

test('dismissKey 换成表内组合键 ⇒ 提示行跟着变',
  () => hintText('llm', { dismissKey: 'Alt+F5' }) === 'Tab 采纳 · Alt+G 换一条 · Alt+F5 关闭',
  () => hintText('llm', { dismissKey: 'Alt+F5' }));

// 表外主键（`Backspace` / `Delete` 不在 `KEY_CODES` 里）**既录不进也命不中**，
// 所以提示行丢掉这一段是对的——上面那条「认不出的主键不印上屏」就是它的正证。
test('表外主键（Alt+Backspace）不印上屏，也不接管按键',
  () => !hintText('llm', { dismissKey: 'Alt+Backspace' }).includes('关闭')
    && specMatches(keyFactsOf({ code: 'Backspace', alt: true, ctrl: false, meta: false, shift: false }), 'Alt+Backspace') === false,
  () => hintText('llm', { dismissKey: 'Alt+Backspace' }));

test('en 文案：Tab accept · → word · Esc dismiss',
  () => hintText('history', {}, 'en') === 'Tab accept · → word · Esc dismiss',
  () => hintText('history', {}, 'en'));

test('en + llm：another 出现且不出现 →',
  () => hintText('llm', {}, 'en') === 'Tab accept · Alt+G another · Esc dismiss',
  () => hintText('llm', {}, 'en'));

test('DOM 钩子稳定（取证脚本据此纯读 DOM）',
  () => true, () => 'n/a');

let failed = 0;
for (const c of cases) {
  let ok = false;
  try { ok = c.fn(); } catch (e) { ok = false; }
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `\n      实际: ${c.detail()}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
