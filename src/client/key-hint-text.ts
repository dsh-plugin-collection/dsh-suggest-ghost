/**
 * 键位提示的**文案拼装**（纯函数，零依赖）。
 *
 * 单独成文件是为了让 `scripts/key-hint-smoke.mjs` 能用
 * `--experimental-strip-types` 直接读它做判定 —— `.tsx` 不能被 strip-types 加载，
 * 而这里确实没有任何 JSX（与 `keyspec.ts` 同款拆法）。
 *
 * ## 输入是一张表，不是三个散字段（Gitea #157 续）
 *
 * 旧版收的是 `acceptKey / regenKey / wordAccept / regenEnabled` 四个散值，于是
 * 「这一段要不要出现」的判断在文案里**又写了一遍**：`wordAccept` 判一次、`kind !== 'llm'`
 * 判一次、`regenEnabled` 判一次，而 `onKeyDown` 那边是另一套。今天两边恰好一致。
 * 现在文案读 `bindingTableFor()` 产出的**同一张表**：表里没有这一格 ⇒ 这一句不出现。
 * 「显示的键 == 生效的键」从两条实现的对齐，变成同一个数据源的两次投影。
 *
 * ## 段序 = 仲裁序
 *
 * 各段按 `KEY_ACTION_PRIORITY`（采纳 → 逐词 → 换一条 → 关闭）排列。这不是排版选择：
 * 提示行读起来就是「这一键被谁先用」，与 `ownerOfKey` 的判定顺序逐字同构。
 *
 * @module dsh-suggest-ghost/client/key-hint-text
 */

// **只 import 类型**：type-only 会被 strip-types 整条抹掉，于是本模块仍然是零运行时依赖的
// 叶子（冒烟要能直载它，见 keyspec.ts 里 hintSegments 那条注释）。
// 排序与键帽由调用方从 `hintSegments()` 取好传进来——判据不在这个文件里重复。
import type { HintSegment, KeyAction } from './keyspec.js';

/** 拼提示行需要的最小输入。 */
export interface KeyHintInput {
  /** 幽灵形态。**只**用于选词（`逐词` 只在本地即时形态说得出人话），不用于重新判键。 */
  kind: 'llm' | 'history' | 'inline';
  /**
   * 提示行的段（已排序、已换成键帽、已滤掉认不出的键）。
   *
   * ⚠️ 必须是 `keyspec.ts` 的 `hintSegments(bindingTableFor(...))` 的返回值，
   * 不要在调用处另拼一份：`hintSegments` 里已经做了「主键认不出 ⇒ 不出现」，
   * 自己拼的那一份只会表现为「屏幕上写着 `F2 采纳`、按下去没有反应」。
   */
  segments: readonly HintSegment[];
  /** 界面语言。 */
  lang: 'zh' | 'en';
}

/** 每个动作的中文/英文措辞。`dismiss` 的中文是「关闭」，与旧文案逐字相同。 */
const WORDING: Record<KeyAction, { zh: string; en: string }> = {
  accept: { zh: '采纳', en: 'accept' },
  word: { zh: '逐词', en: 'word' },
  regen: { zh: '换一条', en: 'another' },
  dismiss: { zh: '关闭', en: 'dismiss' },
};

/**
 * 拼出提示行文本。
 *
 * 每一条的出现条件都**来自表里有没有这一格**，而表由 `bindingTableFor()` 决定：
 *  - `word` 不会出现在 `llm` 形态（形态闸在表那一侧，不在这里重复）；
 *  - `dismiss` 在 `dismissKey` 留空时不出现 —— 这一条同时兑现了「不许承诺我们不实现的键」，
 *    空 = 本插件确实不接管；
 *  - `regen` 只出现在 `llm`，且 `regenEnabled` 关时消失。
 *
 * @param input - 当前形态与生效键位表。
 * @returns 提示行文本；分隔符用 `·`（与同类插件一致的密集写法）。
 */
export function keyHintText(input: KeyHintInput): string {
  return input.segments
    .map((seg) => (input.lang === 'en'
      ? `${seg.keycap} ${WORDING[seg.action].en}`
      : `${seg.keycap} ${WORDING[seg.action].zh}`))
    .join(' · ');
}
