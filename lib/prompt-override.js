/**
 * 自定义提示词的展开规则（纯函数，零依赖）。
 *
 * ## 为什么单独成一个模块
 *
 * 两条生成路径（下一条建议 / 停顿续写）都要做同一件事：拿用户填的模板展开成
 * system 提示词。这件事的**判据必须只有一份**——「留空算不算自定义」「哪个占位符展开成
 * 什么」「超长上限是多少」。写两遍就是两份真相，而这个仓里两份真相的代价已经付过
 * 好几次（`ops-schema-coverage-smoke.mjs` 与 `reasoning-effort-smoke.mjs` 防的都是它）。
 *
 * 本模块**不 import 任何东西**（连类型都不引），所以：
 *  - 宿主侧 `generate.ts` 直接用它（`using` 声明不影响这里）；
 *  - 设置卡片（`src/client/settings-card.tsx`）也能引它来判超长，
 *    上限常量因此不需要在客户端抄一份；
 *  - 冒烟脚本可以直接 `node scripts/…` 驱动源文件，不必先构建 `lib/`。
 *
 * ## 语义（完整推导见 docs/editable-prompt-design.md §3）
 *
 *  - 留空 / 纯空白 ⇒ 返回内置模板**同一个字符串**，一字不改。默认发布形态就是两个键
 *    都为空串，于是今天的所有回归基线（`systemPrompt()` 本体、README 的 42 次实测口径）
 *    继续成立。
 *  - 填了内容 ⇒ 以填的那段为模板做占位符替换。`{{builtin}}` 把内置模板放回去，
 *    因此「在内置前后加自己的规则」不需要抄一份全文，也不会因为整段替换丢掉内置的禁令。
 *  - 未识别的 `{{xxx}}` **原样保留**：吞掉会让用户以为生效了，抛错会让整次生成静默失败，
 *    两者都比「照原样发给模型」更难排查。
 * @module dsh-suggest-ghost/prompt-override
 */
/**
 * 单个模板的字符上限。
 *
 * 判的是**模板**长度，不是展开后的长度：`{{builtin}}` 展开进去的内置模板约 1.9KB，
 * 那是用户显式要求保留的，不该反过来把用户的额度吃掉。
 *
 * 宿主侧的强制点是 `src/index.ts` 里 schema 的 `.max(PROMPT_MAX_CHARS)`；
 * 卡片在保存之前用同一个常量先挡一道——内核 zod 拒绝时卡片的 `save()` 看不到失败
 * （它不读 mutate 的结论），界面表现是「点了保存、值没变」，所以超长必须在客户端拦。
 */
export const PROMPT_MAX_CHARS = 6000;
/** 内置模板的占位符。命名上刻意与另外两个同族，不引入 `$` / `%` 之类第二套语法。 */
export const BUILTIN_TOKEN = '{{builtin}}';
/** 本次判定出的输出语言（`简体中文` / `English` …），与建议/续写共用同一份判定结果。 */
export const LANGUAGE_TOKEN = '{{language}}';
/** 该路径的可见字符上限（建议 = `maxSuggestionChars`，续写 = `inlineMaxChars`）。 */
export const MAX_CHARS_TOKEN = '{{maxChars}}';
/**
 * 用户填的模板是否算「自定义」。
 *
 * 纯空白算留空：一段只有空格/换行的模板展开出来是纯空白 system，模型会拿到一句
 * 没有任何指令的提示词，表现是「乱答但不报错」，比回落到内置难查得多。
 * 而设置项本身允许写空串（`z.string()`，空串 = 内置），所以这里不能用 `!= null`。
 */
export function isCustomPrompt(override) {
    return typeof override === 'string' && override.trim() !== '';
}
/** 留痕用的读数：`prompt=custom` / `prompt=builtin`。 */
export function promptSource(override) {
    return isCustomPrompt(override) ? 'custom' : 'builtin';
}
/**
 * 按占位符展开模板（不做「留空」判断，那是 {@link resolveSystemPrompt} 的事）。
 *
 * 用 `split/join` 而不是 `replaceAll`：语义完全一致（全量替换、非正则），
 * 但不依赖 ES2021 的 `String.prototype.replaceAll`，宿主侧与客户端侧同一份实现都成立。
 */
export function expandPrompt(template, builtin, vars) {
    return template
        .split(BUILTIN_TOKEN).join(builtin)
        .split(LANGUAGE_TOKEN).join(vars.language)
        .split(MAX_CHARS_TOKEN).join(String(vars.maxChars));
}
/**
 * 本次生成真正发给模型的 system 提示词。
 *
 * @param override - 用户填的模板（`suggestionPrompt` / `completionPrompt` 之一）。
 * @param builtin - 内置模板（调用处现算：`systemPrompt(...)` / `inlinePrompt(...)`）。
 * @param vars - 占位符的取值。
 * @returns 留空 ⇒ `builtin` 本身（同一字符串，不是拷贝后相等）；否则展开结果。
 */
export function resolveSystemPrompt(override, builtin, vars) {
    if (!isCustomPrompt(override))
        return builtin;
    return expandPrompt(override, builtin, vars);
}
