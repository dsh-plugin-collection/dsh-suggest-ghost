/**
 * 快捷键规格（spec）与 KeyboardEvent 互转工具。
 *
 * spec 格式：修饰键（按 Alt/Ctrl/Meta/Shift 固定顺序）+ '+' + 主键名，
 * 如 "Tab"、"Alt+Slash"、"Ctrl+Enter"、"Alt+S"、"F2"、"Up"。
 * 主键名集合由 KEY_CODES / keyCodeOf / keyNameOfCode 三者共同定义，
 * 设置卡片的录制端（keyEventToSpec）与幽灵的匹配端（parseAcceptKey）
 * 均引用本模块，保证写入的 spec 一定可被匹配。
 * @module dsh-suggest-ghost/client/keyspec
 */

/** 主键名（小写）-> KeyboardEvent.code 匹配表。 */
export const KEY_CODES: Readonly<Record<string, string>> = {
  tab: 'Tab',
  enter: 'Enter',
  // `dismissKey` 的默认值是 `Escape`，而匹配端（`specMatches` → `keyCodeOf`）与录制端
  // （`keyNameOfCode`）都只认这张表：漏登记 ⇒ 默认值**静默不生效**（本仓踩过的同一个坑，
  // 见 `accept-key.ts` 头部注释）。钉在 `scripts/keyspec-smoke.mjs` 的默认值断言。
  escape: 'Escape',
  slash: 'Slash',
  space: 'Space',
  comma: 'Comma',
  period: 'Period',
  minus: 'Minus',
  equal: 'Equal',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backquote: 'Backquote',
  backslash: 'Backslash',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** 解析 spec 的主键名为 KeyboardEvent.code；支持字母/数字简写（"s" -> "KeyS"）。 */
export function keyCodeOf(spec: string): string | undefined {
  const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const key = parts[parts.length - 1];
  const direct = key === undefined ? undefined : KEY_CODES[key];
  if (direct !== undefined) return direct;
  if (key !== undefined && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== undefined && /^[0-9]$/.test(key)) return `Digit${key}`;
  return undefined;
}

/** KeyboardEvent.code -> 主键显示名（keyCodeOf 的逆映射）。 */
export function keyNameOfCode(code: string): string | undefined {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  const arrows: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  if (code in arrows) return arrows[code]!;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return undefined;
}

/** 纯修饰键的 event.key 集合（按下时等待后续主键，不成 spec）。 */
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'Fn', 'FnLock']);

/** 从键盘事件构造规范 spec；纯修饰键或不受支持的主键返回 undefined。 */
export function keyEventToSpec(event: KeyboardEvent): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const key = keyNameOfCode(event.code);
  if (key === undefined) return undefined;
  const mods: string[] = [];
  if (event.altKey) mods.push('Alt');
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.metaKey) mods.push('Meta');
  if (event.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

// ── 键位归属表与安全判据（Gitea #157 续：按键操作全部可自定义）────────────────
//
// 下面这一组都是**零 DOM 的纯判据**，与 `keyEventToSpec` 同一张主键表 ⇒ 录制端写进去的
// spec 一定可被匹配端命中（这正是本文件存在的理由）。拆在本文件而不是 `index.ts`：
// `.tsx`/大文件载不动，而这几条判据必须能被冒烟直接驱动（`docs/keybinding-settings-design.md` §6）。

/** 一个可自定义的按键动作。设置项、运行时、卡片文案共用这一套标识。 */
export type KeyAction = 'accept' | 'word' | 'regen' | 'dismiss' | 'forget';

/**
 * 一次按键**最多归一个动作**，数组顺序即优先级。
 *
 * 为什么是这个顺序（`docs/keybinding-settings-design.md` §3.3）：
 *  - `accept` 第一：采纳是本插件的主操作，且 `index.ts:3339` 的注释一直声称
 *    「同键时采纳优先」——而旧代码里 regen 支写在采纳之前，注释与执行顺序是**反的**，
 *    还连带让 `regenKey='Tab'` 把历史/续写形态的采纳整条挡死。这张表把那句话变成事实。
 *  - `word` 在 `regen` 前：逐词是采纳的一部分（同一目标文本，只是分段写入）。
 *  - `dismiss` 在 `forget` 前：关掉幽灵**不动数据**，忽略则是一条**不可撤销的持久写**
 *    （要用户去设置页才能恢复）⇒ 同键时先关掉（代价可忽略），别让一次误按变成数据变更。
 *  - `forget` 最后：它是本表里代价最大的一格（会永久改变「以后补什么」），
 *    任何同键竞争都该由别人赢。
 */
export const KEY_ACTION_PRIORITY: readonly KeyAction[] = Object.freeze(['accept', 'word', 'regen', 'dismiss', 'forget']);

/** 键位表：动作 -> spec。缺省或空串 = 该动作不接管任何键（永不命中）。 */
export type BindingTable = Readonly<Partial<Record<KeyAction, string>>>;

/** 匹配一下按键所需的全部事实（不引 `KeyboardEvent` 类型，冒烟可直造）。 */
export interface KeyFacts {
  readonly code: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** KeyboardEvent -> `KeyFacts`。**唯一**的取事实入口，别在调用处散着摸字段。 */
export function keyFactsOf(event: KeyboardEvent): KeyFacts {
  return {
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

/** spec 的规范键（主键 code + 排序后的修饰集合）；认不出主键 ⇒ undefined。 */
function specIndex(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const code = keyCodeOf(spec);
  if (code === undefined) return undefined;
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = parts.slice(0, -1).filter((p) => p === 'alt' || p === 'ctrl' || p === 'meta' || p === 'shift');
  return `${[...new Set(mods)].sort().join(',')}|${code}`;
}

/**
 * 该 spec 是否命中这一下按键。
 *
 * 修饰键**逐一相等**：spec 没写 Shift 而用户按了 Shift ⇒ 不命中。
 * 这一条取代旧 `index.ts` 的 `parseAcceptKey` 闭包（同一判据只许有一处）。
 */
export function specMatches(facts: KeyFacts, spec: string | undefined): boolean {
  const index = specIndex(spec);
  if (index === undefined) return false;
  const [mods, code] = index.split('|') as [string, string];
  const set = new Set(mods === '' ? [] : mods.split(','));
  return code === facts.code
    && facts.alt === set.has('alt')
    && facts.ctrl === set.has('ctrl')
    && facts.meta === set.has('meta')
    && facts.shift === set.has('shift');
}

/**
 * 这一键此刻归哪个动作。
 *
 * @returns 优先级最高且命中的动作；无人认领 ⇒ `null`（调用方**不得吞键**，见 §1.2 不假装规则）。
 */
export function ownerOfKey(table: BindingTable, facts: KeyFacts): KeyAction | null {
  for (const action of KEY_ACTION_PRIORITY) {
    if (specMatches(facts, table[action])) return action;
  }
  return null;
}

/**
 * 会不会往输入框**打字**的主键。
 *
 * 字母、数字，以及 `KEY_CODES` 里那批标点/空白主键。方向键、`Tab`、`Enter`、`Esc`、
 * `F1–F12` 不打字 —— 这正是它们能配给「边打字边显示」的形态的原因。
 */
export function isTextKey(code: string): boolean {
  if (/^Key[A-Z]$/u.test(code) || /^Digit[0-9]$/u.test(code)) return true;
  const TEXT_CODES = new Set([
    'Space', 'Comma', 'Period', 'Minus', 'Equal', 'Semicolon', 'Quote', 'Backquote',
    'Backslash', 'BracketLeft', 'BracketRight',
  ]);
  return TEXT_CODES.has(code);
}

/** spec 里是否带了 Alt/Ctrl/Meta（**Shift 不算**：`Shift+A` 照样打出大写 A）。 */
function hasDisarmingModifier(spec: string): boolean {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.slice(0, -1).some((p) => p === 'alt' || p === 'ctrl' || p === 'meta');
}

/** 方向键与 Esc 的键帽字形（提示行与卡片摘要共用，别再拼第二份映射）。 */
const KEYCAPS: Readonly<Record<string, string>> = {
  Right: '→',
  Left: '←',
  Up: '↑',
  Down: '↓',
  Escape: 'Esc',
};

/**
 * spec -> 界面键帽。主键认不出（不在 `KEY_CODES` 表里）⇒ `undefined`。
 *
 * 返回 `undefined` 而不是原串，是为了让调用方**跳过**这一段：
 * 提示行宁可少写一条，也不在屏幕上印一个按不动的键名（#167 那条不变量的另一半）。
 */
export function specKeycap(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods = parts.slice(0, -1);
  const main = parts[parts.length - 1]!;
  if (keyCodeOf(main) === undefined) return undefined;
  return [...mods, KEYCAPS[main] ?? main].join('+');
}
/**
 * 该 spec 能否配给「边打字边显示」的形态（历史补全 / 停顿续写）。
 *
 * 判据：主键本身不打字，**或**带了 Alt/Ctrl/Meta 把它从「打字」里摘出去。
 * 这是 Gitea #167 留下的前置条件（「要扩范围必须先定字母键在本地即时形态上是否禁用」），
 * 补上它才敢把 `localAcceptKey` / `wordAcceptKey` 开放给用户配。
 * 认不出的 spec 一律**不安全**（它永不命中，属于配置错误，不该被当成合法值保存）。
 */
export function isSafeActionKey(spec: string): boolean {
  const code = keyCodeOf(spec);
  if (code === undefined) return false;
  return hasDisarmingModifier(spec) || !isTextKey(code);
}

/**
 * 该 spec 会不会顶掉输入框原有的「发送」语义。
 *
 * 只对**零修饰的裸 `Enter`** 为真。为什么不把 `Shift+Enter` 也算进来、也不把
 * 「DSH 输入框里 Enter 到底是不是发送」写成断言：那属于宿主输入框的行为，本单
 * **没有取证**（`dsh-client-ui-conversation` 里搜不到 Enter/shiftKey 的直接判据），
 * 而多数聊天输入框里 `Shift+Enter` 是换行、`Enter` 才是发送。所以这里只拦最没
 * 争议的那一格——宁可少一句警告，也不写一句没有依据的承诺。
 *
 * 裸 Enter **允许**配（§7.2 拍板：不替用户决定），但卡片必须警告。
 * 判据与警告文案同一来源，不许在卡片里再拼一份「是不是 Enter」。
 */
export function isSendCollisionKey(spec: string): boolean {
  if (keyCodeOf(spec) !== 'Enter') return false;
  return spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean).length === 1;
}

/**
 * 与 `action` 配成**同一个键**的其他动作（用于卡片冲突提示）。
 *
 * 比的是解析后的 `specIndex`，所以 `Alt+G` 与 `G+Alt`、大小写差异都算同一个键；
 * 认不出的 spec 与空串**不参与**比对（它们都不接管按键，不构成歧义）。
 */
export function bindingConflicts(table: BindingTable, action: KeyAction): KeyAction[] {
  const mine = specIndex(table[action]);
  if (mine === undefined) return [];
  return KEY_ACTION_PRIORITY.filter((other) => other !== action && specIndex(table[other]) === mine);
}

/**
 * 两个 spec 是否是**同一个键**（比解析后的规范键，不比原始串）。
 *
 * 给设置卡片做「键位字段两两撞键」的检查：`Alt+G` 与 `G+Alt`、大小写差异、多余空格
 * 都算同一个键。空串与认不出的主键 ⇒ `false`（它们不接管任何按键，不构成歧义）。
 * 与 {@link specMatches} 共用 `specIndex`，所以卡片看到的「同一个键」与
 * 仲裁端看到的「同一个键」是同一个定义——这条不能有两份。
 */
export function sameSpec(a: string | undefined, b: string | undefined): boolean {
  const x = specIndex(a);
  const y = specIndex(b);
  return x !== undefined && x === y;
}

/** 提示行的一段：已经解析成键帽的动作。 */
export interface HintSegment {
  readonly action: KeyAction;
  readonly keycap: string;
}

/**
 * 键位表 -> 提示行要显示的那几段（顺序 = 仲裁优先级，认不出的键直接丢掉）。
 *
 * 收在这里而不是让文案模块自己排：`KEY_ACTION_PRIORITY` 与 `specKeycap` 都在本文件，
 * 让 `key-hint-text.ts` 运行时 import 它们会把那条「零依赖叶子模块」的性质弄丢
 * ——它必须能被 `node --experimental-strip-types` 直载，而带 `.js` 后缀的相对导入
 * 在 type-stripping 下**不做 `.js → .ts` 回退**（本仓既有先例见 `tsconfig.client.json`
 * 对 TS5097 的归因）。所以这里算好段，那边只负责拼字。
 */
export function hintSegments(table: BindingTable): readonly HintSegment[] {
  const out: HintSegment[] = [];
  for (const action of KEY_ACTION_PRIORITY) {
    const keycap = specKeycap(table[action]);
    if (keycap !== undefined) out.push({ action, keycap });
  }
  return out;
}

/**
 * spec -> 一次「按对了」的 `KeyFacts`；主键认不出 ⇒ `undefined`。
 *
 * 有了它，「这张表会把这一键判给谁」在任何一侧都能直接问 `ownerOfKey`：
 * 运行时用真事件的 `keyFactsOf`，设置卡片与冒烟用这里。判据仍然只有 `ownerOfKey` 一处。
 */
export function factsOfSpec(spec: string | undefined): KeyFacts | undefined {
  const code = keyCodeOf(spec ?? '');
  if (code === undefined) return undefined;
  const parts = (spec ?? '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return {
    code,
    alt: mods.has('alt'),
    ctrl: mods.has('ctrl'),
    meta: mods.has('meta'),
    shift: mods.has('shift'),
  };
}

/** 键位表一行的状态（设置卡片用它决定标什么、要不要灰显）。 */
export type KeyRowState = 'live' | 'off' | 'unbound' | 'clash';

/**
 * 一行键位此刻的状态。判据收在这里而不是写在 `.tsx` 里，是因为 `.tsx` 不在
 * 类型检查范围内（`tsconfig.client.json` 只 include `.ts`），写在卡片里就**没有
 * 一条冒烟能钉它**——本单实测过：卡片里那版把两张仲裁表混着算冲突，
 * 会让只在 `llm` 表生效的字段因为 `local` 表内部撞键而亮「同键」，
 * 而构建、冒烟、名称闸全都不会红。
 *
 * @param tables  两张仲裁表（`llm` = 下一条建议，`local` = 历史补全 / 停顿续写）
 * @param scopes  该字段**实际参与**的表（来自 `KEY_TABLES`，不是「两张都算」）
 * @param action  该字段承载的动作
 * @param value   当前 spec
 */
export function keyRowStateOf(
  tables: Partial<Record<'llm' | 'local', BindingTable>>,
  scopes: readonly ('llm' | 'local')[],
  action: KeyAction,
  value: string,
): KeyRowState {
  if (value.trim() === '') return 'unbound';
  const inAny = scopes.some((w) => tables[w]?.[action] !== undefined);
  if (!inAny) return 'off';
  return scopes.some((w) => {
    const table = tables[w];
    return table !== undefined && bindingConflicts(table, action).length > 0;
  }) ? 'clash' : 'live';
}
