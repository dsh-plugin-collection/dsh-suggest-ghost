#!/usr/bin/env node
/**
 * keyspec 快捷键映射回归测试（`src/client/keyspec.ts`）。
 *
 * 钉住 keyCodeOf / keyNameOfCode / keyEventToSpec 的映射性质：
 * 1. keyCodeOf：spec -> KeyboardEvent.code
 * 2. keyNameOfCode：KeyboardEvent.code -> 显示名
 * 3. keyEventToSpec：KeyboardEvent -> spec
 *
 * 覆盖：单键、修饰键组合、字母/数字简写、特殊键、边界情况。
 *
 * ## 本单加的两段
 *
 *  1. **默认值必须被 `keyCodeOf` 认得**。五个键位的默认值只要有一个写成了表里没有的
 *     主键名，结果就是「设置页显示着那个键、按下去什么都不发生」，而且编译、渲染、
 *     冒烟全都不会红——这条坑本仓真踩过（见 `accept-key.ts` 头部注释），所以把它
 *     从"记得一下"升级成断言。
 *  2. **安全键判据 `isSafeActionKey`**：Gitea #167 当年把 `acceptKey` 的作用域收窄，
 *     留下的前置条件是「先定字母键在边打字边显示的形态上是否禁用」。这道判据就是那个
 *     前置条件，它必须能被人反驳，所以每一类的边界都单独钉一条。
 *
 * 用法：node --experimental-strip-types scripts/keyspec-smoke.mjs
 */
import assert from 'node:assert/strict';
import {
  keyCodeOf,
  keyNameOfCode,
  keyEventToSpec,
  keyFactsOf,
  specMatches,
  specKeycap,
  isTextKey,
  isSafeActionKey,
  isSendCollisionKey,
  sameSpec,
  hintSegments,
  bindingConflicts,
  KEY_ACTION_PRIORITY,
} from '../src/client/keyspec.ts';

console.log('【keyspec 快捷键映射冒烟测试】\n');

// ─── keyCodeOf ───────────────────────────────────────────────────────────

// 1. 单键：Tab
{
  assert.equal(keyCodeOf('Tab'), 'Tab');
  console.log('✅ keyCodeOf("Tab") → "Tab"');
}

// 2. 单键：Enter
{
  assert.equal(keyCodeOf('Enter'), 'Enter');
  console.log('✅ keyCodeOf("Enter") → "Enter"');
}

// 3. 修饰键组合：Alt+S
{
  assert.equal(keyCodeOf('Alt+S'), 'KeyS');
  console.log('✅ keyCodeOf("Alt+S") → "KeyS"');
}

// 4. 修饰键组合：Ctrl+Enter
{
  assert.equal(keyCodeOf('Ctrl+Enter'), 'Enter');
  console.log('✅ keyCodeOf("Ctrl+Enter") → "Enter"');
}

// 5. 修饰键组合：Shift+Tab
{
  assert.equal(keyCodeOf('Shift+Tab'), 'Tab');
  console.log('✅ keyCodeOf("Shift+Tab") → "Tab"');
}

// 6. 字母简写：s -> KeyS
{
  assert.equal(keyCodeOf('s'), 'KeyS');
  console.log('✅ keyCodeOf("s") → "KeyS"');
}

// 7. 数字简写：1 -> Digit1
{
  assert.equal(keyCodeOf('1'), 'Digit1');
  console.log('✅ keyCodeOf("1") → "Digit1"');
}

// 8. 特殊键：F1
{
  assert.equal(keyCodeOf('F1'), 'F1');
  console.log('✅ keyCodeOf("F1") → "F1"');
}

// 9. 特殊键：ArrowUp
{
  assert.equal(keyCodeOf('Up'), 'ArrowUp');
  console.log('✅ keyCodeOf("Up") → "ArrowUp"');
}

// 10. 无效键：undefined
{
  assert.equal(keyCodeOf('InvalidKey'), undefined);
  console.log('✅ keyCodeOf("InvalidKey") → undefined');
}

// 11. 空字符串：undefined
{
  assert.equal(keyCodeOf(''), undefined);
  console.log('✅ keyCodeOf("") → undefined');
}

// 12. 多修饰键：Ctrl+Alt+Delete
{
  assert.equal(keyCodeOf('Ctrl+Alt+Delete'), undefined); // Delete 不在 KEY_CODES 中
  console.log('✅ keyCodeOf("Ctrl+Alt+Delete") → undefined（Delete 不支持）');
}

// ─── keyNameOfCode ───────────────────────────────────────────────────────

// 13. KeyS -> S
{
  assert.equal(keyNameOfCode('KeyS'), 'S');
  console.log('✅ keyNameOfCode("KeyS") → "S"');
}

// 14. Digit1 -> 1
{
  assert.equal(keyNameOfCode('Digit1'), '1');
  console.log('✅ keyNameOfCode("Digit1") → "1"');
}

// 15. ArrowUp -> Up
{
  assert.equal(keyNameOfCode('ArrowUp'), 'Up');
  console.log('✅ keyNameOfCode("ArrowUp") → "Up"');
}

// 16. Tab -> Tab
{
  assert.equal(keyNameOfCode('Tab'), 'Tab');
  console.log('✅ keyNameOfCode("Tab") → "Tab"');
}

// 17. F1 -> F1
{
  assert.equal(keyNameOfCode('F1'), 'F1');
  console.log('✅ keyNameOfCode("F1") → "F1"');
}

// 18. 无效 code -> undefined
{
  assert.equal(keyNameOfCode('InvalidCode'), undefined);
  console.log('✅ keyNameOfCode("InvalidCode") → undefined');
}

// ─── keyEventToSpec ──────────────────────────────────────────────────────

// 19. 单键：Tab
{
  const event = { key: 'Tab', code: 'Tab', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Tab');
  console.log('✅ keyEventToSpec(Tab) → "Tab"');
}

// 20. 修饰键组合：Alt+S
{
  const event = { key: 's', code: 'KeyS', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Alt+S');
  console.log('✅ keyEventToSpec(Alt+S) → "Alt+S"');
}

// 21. 修饰键组合：Ctrl+Enter
{
  const event = { key: 'Enter', code: 'Enter', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Ctrl+Enter');
  console.log('✅ keyEventToSpec(Ctrl+Enter) → "Ctrl+Enter"');
}

// 22. 修饰键组合：Shift+Tab
{
  const event = { key: 'Tab', code: 'Tab', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true };
  assert.equal(keyEventToSpec(event), 'Shift+Tab');
  console.log('✅ keyEventToSpec(Shift+Tab) → "Shift+Tab"');
}

// 23. 多修饰键：Ctrl+Alt+S
{
  const event = { key: 's', code: 'KeyS', altKey: true, ctrlKey: true, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), 'Alt+Ctrl+S');
  console.log('✅ keyEventToSpec(Ctrl+Alt+S) → "Alt+Ctrl+S"');
}

// 24. 纯修饰键：Alt -> undefined
{
  const event = { key: 'Alt', code: 'AltLeft', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), undefined);
  console.log('✅ keyEventToSpec(Alt) → undefined（纯修饰键）');
}

// 25. 不支持的键：Delete -> undefined
{
  const event = { key: 'Delete', code: 'Delete', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyEventToSpec(event), undefined);
  console.log('✅ keyEventToSpec(Delete) → undefined（不支持）');
}


// ─── 26+. 默认值可识别性（五个键位，缺一个就静默不生效）─────────────────
const {
  DEFAULT_ACCEPT_KEY, DEFAULT_WORD_ACCEPT_KEY, DEFAULT_REGEN_KEY, DEFAULT_DISMISS_KEY,
} = await import('../src/client/accept-key.ts');

const DEFAULTS = {
  acceptKey: DEFAULT_ACCEPT_KEY,
  localAcceptKey: DEFAULT_ACCEPT_KEY,
  wordAcceptKey: DEFAULT_WORD_ACCEPT_KEY,
  regenKey: DEFAULT_REGEN_KEY,
  dismissKey: DEFAULT_DISMISS_KEY,
};
for (const [name, spec] of Object.entries(DEFAULTS)) {
  assert.notEqual(keyCodeOf(spec), undefined, `${name} 的默认值 "${spec}" 主键表认不出 ⇒ 会静默不生效`);
  assert.notEqual(specKeycap(spec), undefined, `${name} 的默认值 "${spec}" 印不进提示行`);
  // 「按对了能不能命中」用**真事件替身**过一遍 `keyFactsOf`：
  // 手搓 KeyFacts 会把 keyFactsOf 这层跳过，而它正是 index.ts 唯一的取事实入口
  // （字段名写成 `alt` 而非 `altKey` 时，本条会红 —— 这条断言自己也 got 过一次）。
  const lower = spec.toLowerCase();
  const fakeEvent = {
    key: spec.split('+').pop(),
    code: keyCodeOf(spec),
    altKey: lower.includes('alt'),
    ctrlKey: lower.includes('ctrl'),
    metaKey: lower.includes('meta'),
    shiftKey: lower.includes('shift'),
  };
  assert.ok(specMatches(keyFactsOf(fakeEvent), spec), `${name} 的默认值 "${spec}" 按对了也命不中自己`);
  // 多按一个修饰键必须**不**命中（否则 `Tab` 会连带吃掉 `Shift+Tab` 的反向焦点移动）。
  assert.equal(specMatches({ ...keyFactsOf(fakeEvent), shift: true }, spec), false,
    `${name} 的默认值 "${spec}" 被 Shift 变体误命中`);
}
console.log('✅ 五个键位默认值全部可识别、可打印、可命中');

// Escape 必须在主键表里：它是 dismissKey 的默认值，而 #166 之前这张表没有它。
assert.equal(keyCodeOf('Escape'), 'Escape');
assert.equal(keyNameOfCode('Escape'), 'Escape');
console.log('✅ Escape 已登记进主键表（否则「Esc 关闭」永远命不中）');

// ─── 27+. isTextKey / isSafeActionKey 的边界 ────────────────────────────
assert.equal(isTextKey('KeyF'), true);
assert.equal(isTextKey('Digit3'), true);
assert.equal(isTextKey('Space'), true);
assert.equal(isTextKey('Comma'), true);
assert.equal(isTextKey('Tab'), false);
assert.equal(isTextKey('ArrowRight'), false);
assert.equal(isTextKey('Enter'), false);
assert.equal(isTextKey('F5'), false);
console.log('✅ isTextKey：字母/数字/空白/标点 = 打字键；Tab/方向/Enter/F = 非打字键');

// 安全：非打字主键，或带 Alt/Ctrl/Meta 把它从打字里摘出去。
assert.equal(isSafeActionKey('Tab'), true);
assert.equal(isSafeActionKey('Right'), true);
assert.equal(isSafeActionKey('F5'), true);
assert.equal(isSafeActionKey('Escape'), true);
assert.equal(isSafeActionKey('Alt+F'), true);
assert.equal(isSafeActionKey('Ctrl+Enter'), true);
// 不安全：裸字母 / 裸数字 / 裸标点，以及 Shift+字母（Shift **不**解除打字）。
assert.equal(isSafeActionKey('F'), false);
assert.equal(isSafeActionKey('3'), false);
assert.equal(isSafeActionKey('Space'), false);
assert.equal(isSafeActionKey('Shift+F'), false, 'Shift 不算解除打字：Shift+F 照样打出大写 F');
// 认不出的主键 = 配置错误，一律不安全（不能被当成合法值保存进边打字边显示的那两个形态）。
assert.equal(isSafeActionKey('Delete'), false);
assert.equal(isSafeActionKey(''), false);
console.log('✅ isSafeActionKey：6 类边界（含 Shift 不算解除打字、表外主键不安全）');

// ─── 28+. Enter 的「顶掉发送」警告判据 ──────────────────────────────────
assert.equal(isSendCollisionKey('Enter'), true);
// Shift+Enter **不警告**：宿主输入框里它通常是换行而非发送，而本单没有取证宿主的
// 具体判据 ⇒ 宁可少警告，也不写一句没有依据的承诺（见 isSendCollisionKey 的注释）。
assert.equal(isSendCollisionKey('Shift+Enter'), false);
assert.equal(isSendCollisionKey('Ctrl+Enter'), false);
assert.equal(isSendCollisionKey('Tab'), false);
assert.equal(isSendCollisionKey('Alt+Enter'), false);
console.log('✅ isSendCollisionKey：只有**零修饰**的 Enter 触发警告（Shift/Ctrl/Alt 组合都不警告）');

// ─── 29+. 同一个键的定义只有一份 ───────────────────────────────────────
assert.equal(sameSpec('Alt+G', 'alt+g'), true);
// ⚠️ **修饰键在后**的写法（`G+Alt`）在本格式里不合法：`keyCodeOf` 取**末段**当主键，
// 于是 `G+Alt` 的主键是「alt」⇒ 认不出 ⇒ 永不命中。录制端（`keyEventToSpec`）永远产出
// `Mods+Key` 顺序，所以正常路径碰不到；这里把它钉成断言，是为了让下一个人别以为
// `sameSpec` 会「把任何写法归一化」——它不会，写反的 spec 就是静默失效的那个形状。
assert.equal(sameSpec('Alt+G', 'G+Alt'), false);
assert.equal(keyCodeOf('G+Alt'), undefined);
assert.equal(sameSpec('alt+g', 'Alt+G'), true);
assert.equal(sameSpec('Tab', 'Shift+Tab'), false, '多一个修饰键就是另一个键');
assert.equal(sameSpec('', 'Tab'), false, '空串不接管任何键 ⇒ 不构成撞键');
assert.equal(sameSpec('Delete', 'Delete'), false, '表外主键谁都不接管 ⇒ 不报冲突');
console.log('✅ sameSpec：大小写/空格无关；Shift 差异算不同键；修饰键写在后面 = 不合法（静默不命中）');

// ─── 30+. 冲突与提示段：都从同一张表投影 ────────────────────────────────
assert.deepEqual(bindingConflicts({ accept: 'Tab', word: 'Right', regen: 'Alt+Tab', dismiss: 'Tab' }, 'accept'), ['dismiss']);
assert.deepEqual(bindingConflicts({ accept: 'Tab', regen: 'Tab' }, 'word'), []);
assert.deepEqual(KEY_ACTION_PRIORITY, ['accept', 'word', 'regen', 'dismiss']);
assert.deepEqual(hintSegments({ accept: 'Right', word: 'Tab' }).map((x) => x.action), ['accept', 'word']);
assert.equal(hintSegments({ accept: 'Right' })[0].keycap, '→');
assert.deepEqual(hintSegments({ accept: 'Delete' }), [], '认不出的键不印上屏');
console.log('✅ bindingConflicts / hintSegments / 优先级表');

console.log('\n✅ keyspec 全部用例通过（含本单新增的默认值可识别性与安全键判据）');
