/**
 * 输出安全管线：转录脱敏、输出净化、语义过滤与截断。
 * 参考 @studyzy/dsh-suggest-prompt（MIT 许可）的安全设计，重写为精简实现。
 *
 * ## 判据分两组：prefixSafe 与 finalOnly（#37）
 *
 * 每个判据要么**只看输入前缀就能定论**，要么**依赖结尾或全长**。这不是修辞：宿主逐条 delta
 * 收文本，中途帧若跑了尾锚/全长判据，该帧输出就不再是终态结果的前缀——用户看到的是
 * 「先少一截、再自己长回来」，而长回来那截里可能含被误剥的围栏与被误判成回显的草稿。
 * `scripts/sanitize-monotonic-smoke.mjs` 把「帧 ⊑ 终态」变成断言，并钉住三类反例。
 *
 * ### A. prefixSafe —— 只看前缀即可定论（`prefixSafeClean()` 只做这些）
 *
 * | 判据 | 锚点（形如 L行:标记，冒烟逐条核对） | 为什么前缀可判 |
 * | --- | --- | --- |
 * | 围栏**头**行剥离 | L74:FENCE_HEAD_BACKTICK / L75:FENCE_HEAD_TILDE | 锚在 `^`：帧开头若干字符就是全部依据 |
 * | 控制序列/控制符/双向覆盖符剥离 | L68:ESCAPE_RE L67:CONTROL_RE L70:BIDI_RE | 逐字符删除；删完仍是终态删除结果的前缀 |
 * | **已闭合**空白段 `\s+` 折叠 | L344:collapseClosedWhitespace | 折叠成单个空格与后文无关；未闭合尾段扣住 |
 * | **头**引号串剥离 | L80:QUOTE_HEAD_RE | 同锚 `^`；终态只可能剥得更多，不会少剥 |
 * | 首部 `trimStart` | L452:trimStart （prefixSafeClean 内联） | 前导空白终态必被 `trim()` 去掉 |
 * | 草稿回显的**头锚**一支 | L384:prefixSafeStripEcho | `startsWith(draft)` 一旦成立就不会翻转 |
 *
 * ### B. finalOnly —— 只能在终帧成立（`prefixSafeClean()` 一律不判，只**扣住**尾巴）
 *
 * | # | 判据 | 锚点 | 中途跑会怎样 |
 * | --- | --- | --- | --- |
 * | 1 | 围栏**尾**行 | L77:FENCE_TAIL_BACKTICK L78:FENCE_TAIL_TILDE （在 L90:stripFenceTail） | 尾锚命中「本帧最后一行」，但下一帧可能是新一行开头 → 终态不剥 → 反例① 围栏尾行误剥 |
 * | 2 | 尾引号串 | L82:QUOTE_TAIL_RE | `hi"` 帧里剥掉，终态 `hi" there` 又把引号还回来 |
 * | 3 | `trim()` 的尾随空白 | L114:.trim(); （另见 L117:.trim(); ） | 尾随空白会不会被后文接上，是全长信息 |
 * | 4 | `>200` 过长丢弃 | L180:SUGGESTION_MAX_CHARS / L200:SUGGESTION_MAX_CHARS | 帧永远 ≤200 → 中途一律放行，反例② |
 * | 5 | 尾问句 | L164:QUESTION_TAIL_RE （在 L185:QUESTION_RE.test 使用） | `[?？]\s*$` 需要「句子到此为止」 |
 * | 6 | 绝对量门限 `<40` | L269:CONVERSATION_MIN_CHARS | 短帧一律不到 40 字 → 判放行，反例②另一半 |
 * | 7 | 草稿 ×3 比值 | L274:CONVERSATION_RATIO_TRIGGER | 分子是本帧长度而非终态长度 → 中途判低倍率放过 |
 * | 8 | 回显窗口 `idx < 全长*0.3` | L296:completion.length * 0.3 | 窗口按全长算，帧里算窄 → 反例③ 按总长误判 |
 * | 9 | `maxChars` 词边界截断 | L133:text.slice 起的 end 取舍 | `lastSpace` 要等前 maxChars 个字符收全 |
 *
 * `prefixSafeClean()` 是**可以**每帧跑的极大子集；表 B 的判据一律改成「把可能被终态改写的
 * 最短尾段扣住不输出」（L320:withholdFenceTail / L405:withholdPartialEscape /
 * L414:withholdTrailingQuotesAndWs）。代价是尾巴晚一帧出现，远便宜过「先少显示再长回来」。
 * 扣住必须发生在删控制符**之前**：`\n` 本身是 C0 控制符，删掉之后「哪一行是最后一行」就没了。
 *
 * @module dsh-suggest-ghost/sanitize
 */
/** 密钥形状脱敏：发送给建议模型前掩蔽常见凭据，避免泄漏到辅助请求与日志。 */
const SECRET_PATTERNS = [
    { label: 'AWS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { label: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
    { label: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
    { label: 'SLACK_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { label: 'STRIPE_KEY', re: /\bsk_live_[0-9A-Za-z]{24,}\b/g },
    { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    { label: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { label: 'BEARER', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
];
/** 把文本中的密钥形状替换为占位标签。 */
export function redactSecrets(text) {
    let out = text;
    for (const { label, re } of SECRET_PATTERNS) {
        out = out.replace(re, `[REDACTED:${label}]`);
    }
    return out;
}
/** ANSI/OSC/CSI/DCS 转义序列与 C0/C1 控制符。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
/** Unicode 双向覆盖符。 */
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;
// ── 围栏与引号：头锚（prefixSafe）与尾锚（finalOnly）分成两条正则，别再混在一个函数里 ──
/** prefixSafe：markdown 围栏**头**行（``` 与 ~~~），锚在 `^`，只看前缀即可定论。 */
const FENCE_HEAD_BACKTICK = /^```[^\n]*\n?/;
const FENCE_HEAD_TILDE = /^~~~[^\n]*\n?/;
/** finalOnly：围栏**尾**行，锚在 `$`——只有终帧才知道这一行是不是最后一行。 */
const FENCE_TAIL_BACKTICK = /\n?```[^\n]*$/;
const FENCE_TAIL_TILDE = /\n?~~~[^\n]*$/;
/** prefixSafe：外层引号的**头**串。 */
const QUOTE_HEAD_RE = /^["'“”‘’]+/;
/** finalOnly：外层引号的**尾**串。 */
const QUOTE_TAIL_RE = /["'“”‘’]+$/;
/** prefixSafe：剥围栏头行（``` 与 ~~~ 各一次，顺序与既有实现一致）。 */
function stripFenceHead(text) {
    return text.replace(FENCE_HEAD_BACKTICK, '').replace(FENCE_HEAD_TILDE, '');
}
/** finalOnly：剥围栏尾行。**只在终帧调用**——中途调用会误剥尚未结束的最后一行。 */
function stripFenceTail(text) {
    return text.replace(FENCE_TAIL_BACKTICK, '').replace(FENCE_TAIL_TILDE, '');
}
/**
 * 净化模型输出：剥离控制序列与覆盖符、去除引号与围栏、压缩为单行。
 * 注意顺序：**先剥围栏再删控制符**——若先删 `\n`（属于 C0 控制符），围栏标记
 * 与正文会连成无空白的一串，`\S*` 会一路吞到底（```json\n{...}\n``` 变空串）。
 *
 * 本函数是**终态**净化（表 B 的尾锚判据 1/2/3 全在里面），不得用于流式中途帧；
 * 中途帧请用 `prefixSafeClean()`。链序：头围栏 → 尾围栏 → 控制符 → 空白折叠 →
 * trim → 头引号 → 尾引号 → trim。
 * @returns 净化后的单行文本（不截断）。
 */
export function cleanSuggestion(text) {
    // ① 趁换行还在先剥围栏：` ```lang` 头行与 ` ``` ` 尾行逐行识别。
    let out = stripFenceHead(text);
    out = stripFenceTail(out);
    // ② 再删控制序列/控制符/双向覆盖符，压缩为单行。
    out = out
        .replace(ESCAPE_RE, '')
        .replace(CONTROL_RE, '')
        .replace(BIDI_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
    // ③ 去掉外层引号（单/双/弯引号）。
    out = out.replace(QUOTE_HEAD_RE, '').replace(QUOTE_TAIL_RE, '');
    return out.trim();
}
/**
 * 建议可见字符上限截断；返回截断标记。
 *
 * **finalOnly（表 B #9）**：`lastSpace` 取的是「前 maxChars 个字符里的最后一个空格」，
 * 而 `end` 会在词边界与 `maxChars` 之间二选一——本帧长度没到 maxChars 之前，这个
 * 取舍随时可能被后文改写。流式中途帧的截断口径见 `prefixSafeCap()`。
 */
export function sanitizeSuggestion(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    // 优先在词边界截断，避免半截单词。
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    const end = lastSpace > Math.floor(maxChars * 0.6) ? lastSpace : maxChars;
    return { text: cut.slice(0, end).trimEnd(), truncated: true };
}
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export function hasCJK(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}
/** 检测文本是否含西里尔字母（俄语等）。 */
export function hasCyrillic(text) {
    return /[\u0400-\u04ff]/.test(text);
}
/** 语义过滤：这些回复被当作「无建议」丢弃。 */
const META_RE = /\b(?:no suggestion|nothing|stay silent|no response|n\/a)\b/i;
const ERROR_ECHO_RE = /\b(?:error|exception|failed)\b.*\b(?:occurred|thrown|raised)\b/i;
// `\b` 只认识 ASCII \w：中文词不会有词边界，若把 CJK 备选也包进 \b…\b 会永远
// 不命中（既有 bug：好的/可以/不错/谢谢 从未被过滤）。故拆分：
// 英文词用词边界，中文词不锚定（短文本内子串匹配足够）。
const THANKS_RE = /\b(?:thanks|thank you|looks good|looks great|great job|well done)\b|(?:不错|谢谢|好的|可以)/i;
const ASSISTANT_VOICE_RE = /\b(?:let me|i'?ll|i will|here'?s|i can|我来|我帮你|我来帮你|让我)\b/i;
/**
 * 对话式回应的形态判据。**头锚**那一支（以 `¿?？` 开头）是 prefixSafe；
 * **尾锚**那一支（以 `?？` 收尾、后面只跟空白）是 finalOnly（表 B #5）——
 * 「这句到此为止是问句」只有终帧成立。两支拆开命名，是为了让
 * `prefixSafeClean()` 的调用方能只用前者，而不是整条丢掉。
 */
const QUESTION_HEAD_RE = /^[¿?？]/;
const QUESTION_TAIL_RE = /[?？]\s*$/;
const QUESTION_RE = new RegExp(`${QUESTION_HEAD_RE.source}|(?:${QUESTION_TAIL_RE.source})`);
/**
 * 判为「对话式回答」的形态阈值（续写专用，取值理由见 `shouldFilterCompletionFor`）。
 * 两个条件**同时**满足才算回答：输出够长（绝对量）且远超草稿（相对量）。
 */
const CONVERSATION_MIN_CHARS = 40;
const CONVERSATION_RATIO_TRIGGER = 3;
/** 建议文本的绝对长度上限（超过即判为多句/过长回复）。 */
const SUGGESTION_MAX_CHARS = 200;
/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export function shouldFilterSuggestion(text) {
    if (text.length === 0)
        return true;
    if (text.length > SUGGESTION_MAX_CHARS)
        return true; // 多句/过长回复（finalOnly，表 B #4）
    if (META_RE.test(text))
        return true;
    if (ERROR_ECHO_RE.test(text))
        return true;
    if (THANKS_RE.test(text))
        return true;
    if (ASSISTANT_VOICE_RE.test(text))
        return true;
    if (QUESTION_RE.test(text))
        return true; // 尾问句一支是 finalOnly（表 B #5）
    // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留——
    // 中文里「继续」「好的」「开始」是常见且有用的确认式建议，不超过滤。
    const words = text.split(/\s+/);
    if (words.length === 1) {
        const word = words[0];
        if (word.length <= 1)
            return true;
        if (/^[\p{P}\p{S}]+$/u.test(word))
            return true;
    }
    return false;
}
/** 续写场景的过滤：比建议场景更宽松，问句/感谢/助手口吻在续写语境下是合理续写。 */
export function shouldFilterCompletion(text) {
    if (text.length === 0)
        return true;
    if (text.length > SUGGESTION_MAX_CHARS)
        return true; // 多句/过长回复（finalOnly，表 B #4）
    if (META_RE.test(text))
        return true;
    if (ERROR_ECHO_RE.test(text))
        return true;
    // 续写场景不过滤 THANKS_RE / ASSISTANT_VOICE_RE / QUESTION_RE
    // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留
    const words = text.split(/\s+/);
    if (words.length === 1) {
        const word = words[0];
        if (word.length <= 1)
            return true;
        if (/^[\p{P}\p{S}]+$/u.test(word))
            return true;
    }
    return false;
}
/**
 * "续写变成了回答"的形态兜底判据。
 *
 * ## 为什么需要它
 *
 * `shouldFilterCompletion` 只做语义过滤，且**故意**放行助手口吻与问句（见上一行的注释，
 * `scripts/inline-smoke.mjs` 有断言钉着这个决定）。于是当模型把「用户正在输入的草稿」
 * 当成「发给它的消息」去**回答**时，链路上没有任何拦截 —— 用户看到的就是幽灵位置冒出一段
 * 回复而不是下半句。
 *
 * ## 为什么用形态而不是语义正则
 *
 * 想靠 `ASSISTANT_VOICE_RE` / `QUESTION_RE` 去拦，就会误杀中文正常续写：这两个正则里有
 * `我来|我帮你|让我` 和 `？`，而中文草稿的续写里"你""吗""？"极其常见 —— 拦掉它们等于把
 * 这个功能的常用场景一起砍掉。所以改用**与语言无关的形态特征**：真正的续写是"接着你的话
 * 往下写半句"，而回答是"成段、且相对草稿显著更长"。
 *
 * ## 阈值怎么来的（线上实测，非拍脑袋）
 *
 * 数据源：`/tmp/dsh-web-now.log` 单次会话的 42 次 `completion generated`，字段只有长度
 * （正文受隐私约束不落盘），分布：
 *
 * ```
 * 输出长度  min=2  中位=31.5  p90=67  max=135
 * 12/42 次 输出 > 草稿 3 倍；最极端 5 字草稿 → 94 字输出（18.8x）
 * ```
 *
 * - `>200` 的绝对上限已由 `shouldFilterCompletion` 承担，这里不重复。
 * - 取 **输出 > 草稿 × 3**（`CONVERSATION_RATIO_TRIGGER`）并叠加 **输出 ≥ 40 字**
 *   （`CONVERSATION_MIN_CHARS`）：两个条件同时满足才判为对话式回答。
 *   比值取 3 的经过（两次都靠冒烟/复核抓出来，不是拍的）：
 *   首版写 8x → 冒烟当场漏掉实测的 6→46（7.7x）；改 5x 后复核发现仍有 3.0~4.2x 那批
 *   （16→67、34→135、22→79、18→54）会被放过，而 9→54 恰好卡在等号上被 `>` 漏掉。
 *   取 3x 后拦下 8/42（5x 时 5/42），且正例全安全。
 *   不再往下压到 2.5x（能到 10/42）：2.5x 已经进入"短草稿正常续写"的常见区间，
 *   继续压会开始误杀；而下面的绝对量门限保证短输出不参与判定。
 *   - 既有正例（`What about the tests?` 21 字、`thanks for asking!` 18 字、
 *     `Let me look into that for you` 29 字）都**不到 40 字**，绝对安全；
 *   - 实测里 `174 字草稿 → 125 字输出`（0.7x）这类**长草稿正常续写**也不会被拦（0.7x，远小于 3）。
 *
 * 用**字符数**而非词数：中文没有空格，`text.split(/\s+/)` 对中文几乎无效（既有实现里那句
 * 孤立词判定对中文基本是空转），比值必须按字符算。
 *
 * ## 流式口径（#37）
 *
 * 本判据两个条件都是 **finalOnly**（表 B #6/#7）：`<40` 与 `> 草稿 ×3` 的分子是本帧
 * 输出长度，中途帧必然偏小，于是「中途放行、终帧才丢弃」。所以它只能在终帧跑，
 * `prefixSafeClean()` 不调它。
 *
 * @param text 净化后的续写输出
 * @param draft 生成这份续写时客户端提交的草稿
 * @returns true = 判为对话式回答，应当丢弃
 */
export function shouldFilterCompletionFor(text, draft) {
    if (shouldFilterCompletion(text))
        return true;
    if (text.length < CONVERSATION_MIN_CHARS)
        return false; // finalOnly（表 B #6）
    const draftChars = draft.trim().length;
    // 空草稿不该走到这里（续写要求草稿非空），但真出现时一律按"可疑"处理：
    // 没有任何草稿还输出成段文本，只可能是回答。
    if (draftChars === 0)
        return true;
    return text.length > draftChars * CONVERSATION_RATIO_TRIGGER; // finalOnly（表 B #7）
}
/**
 * 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。
 *
 * **finalOnly（表 B #8）**：部分回显的判定窗口 `idx < completion.length * 0.3`
 * 用的是**全长**的 30%。中途帧的 `completion.length` 小于终态全长，窗口按比例
 * 算窄，于是「本帧判不出回显 → 整段放行 → 终帧全长后判据翻转又剥掉」。
 * 这正是幽灵文本「先重复用户草稿、再吞掉草稿」的来源。`prefixSafeClean()`
 * 里对应的处理是把窗口宽度按**终态长度下界**（= 本帧长度）之外的可能性扣住。
 */
export function stripDraftEcho(completion, draft) {
    if (completion.length === 0 || draft.length === 0)
        return completion;
    // 如果续写以草稿开头，剥离它
    const lowerCompletion = completion.toLowerCase();
    const lowerDraft = draft.toLowerCase();
    if (lowerCompletion.startsWith(lowerDraft)) {
        return completion.slice(draft.length).trim();
    }
    // 如果续写包含草稿（部分回显），尝试剥离
    const idx = lowerCompletion.indexOf(lowerDraft);
    if (idx >= 0 && idx < completion.length * 0.3) {
        return (completion.slice(0, idx) + completion.slice(idx + draft.length)).trim();
    }
    return completion;
}
// ───────────────────────────────────────────────────────────────────────────────
// prefixSafe 组：流式中途帧可用的净化（#37）
// ───────────────────────────────────────────────────────────────────────────────
/**
 * 扣住「可能被终态尾锚判据改写」的最短尾段（表 B #1 的对应物）。
 *
 * 终态的围栏尾行判据是 `/\n?(```|~~~)[^\n]*$/`：**先匹配到的那处**围栏串到行尾全删。
 * 中途帧既不能照它删（下一个字符一到，`[^\n]*$` 就不再成立，终态反而**不删**——
 * 这就是「围栏尾行误剥」），也不能留着（万一终态真删，已经显示的字符要被撤回）。
 * 所以：从本帧能看到的**最早一处**可能被剥的位置起，整段不显示。
 *
 * 两种位置：
 *  1. 已凑齐 ` ``` `/` ~~~ ` 且其后到帧尾没有换行 → 终态删不删取决于后面还会不会来换行，未定 → 扣。
 *  2. 帧尾是 1~2 个围栏字符的**残串**（`` ` ``/`` `` ``/`~`/`~~`）→ 下一帧可能凑齐 → 扣。
 *
 * 扣住只会让文本晚一帧出现，永远不会撤回已出现的字符，因此单调性成立。
 */
function withholdFenceTail(text) {
    let w = text;
    for (;;) {
        // 换行是 C0 控制符，终态一定会删掉它 → 「扣住尾随换行」不损失任何可见字符，
        // 而必须扣：上一行的围栏串只有在本行被剥掉之后才成为尾锚命中点。
        w = w.replace(/\n+$/, '');
        const lineStart = w.lastIndexOf('\n') + 1;
        const line = w.slice(lineStart);
        // 1. 本行里最早出现的完整围栏串 → 从那里切开（终态删不删它取决于后面还会不会来换行）。
        const hit = line.search(/(```|~~~)/);
        if (hit >= 0) {
            w = w.slice(0, lineStart + hit);
            continue;
        }
        // 2. 帧尾的围栏字符残串（`` ` ``/`` `` ``/`~`/`~~`）：下一帧可能凑齐 → 扣住。
        const partial = /[`~]{1,2}$/.exec(w);
        if (partial) {
            w = w.slice(0, w.length - partial[0].length);
            continue;
        }
        break;
    }
    return w;
}
/**
 * prefixSafe 版空白折叠：只折叠**已闭合**的空白段（其后紧跟非空白字符）。
 * 未闭合的尾段交给 `withholdTrailingQuotesAndWs()` 扣住，因为「这段空白后面还有没有
 * 东西」正是全长信息。
 */
function collapseClosedWhitespace(text) {
    return text.replace(/\s+/g, (run, offset, whole) => (offset + run.length < whole.length ? ' ' : ''));
}
/**
 * prefixSafe 版长度截断（表 B #9 的保守下界版）。
 *
 * 终态 `sanitizeSuggestion()` 的两种取值：`end = lastSpace`（要求 `> floor(max·0.6)`）
 * 或 `end = maxChars`，两者都 **≥ floor(max·0.6)+1**；`text.length ≤ maxChars` 时不截。
 * 所以本帧只要不超过 `floor(max·0.6)+1` 这个下界，就一定是终态结果的前缀——
 * 词边界回退（可能把末尾几个字符收掉）是全长判据，帧里跟着下界走即可。
 */
function prefixSafeCap(text, maxChars) {
    if (!Number.isFinite(maxChars))
        return text;
    if (maxChars <= 0)
        return '';
    const guaranteed = Math.floor(maxChars * 0.6) + 1;
    // 截在下界处可能落在空白上，而终态截完有 `trimEnd()` → 本帧同样把尾随空白收掉。
    return text.slice(0, guaranteed).replace(/\s+$/, '');
}
/**
 * prefixSafe 版的草稿回显剥离——只做 `stripDraftEcho()` 里**头锚**那一支，并且
 * 只在「本帧已经能定论」时定论（表 B #8 的对应物）。
 *
 * `stripDraftEcho()` 有两支：
 *   1. `lowerCompletion.startsWith(lowerDraft)` → 整段剥掉草稿（头锚，可判）；
 *   2. `idx >= 0 && idx < completion.length * 0.3` → 剥中间的回显（**全长判据**，不可判）。
 *
 * 中途帧的三种定论：
 *   - 帧文本比草稿短且与草稿**对得上**：是不是回显未定 → 整段扣住返回空串。回显进行中
 *     本来就该什么都不显示（显示出来就是重复用户的草稿）。不扣的话，本帧显示的字符会
 *     在终态被剥掉，单调性当场破。
 *   - 帧文本盖过草稿且同前缀：回显**成立且不会翻转**（后文再多只加长，不改开头）→ 与
 *     终态一致地剥掉草稿长度。命中这一支时 `stripDraftEcho` 直接 return，不会再剥第二处，
 *     所以剥完不必再查残串。
 *   - 帧文本与草稿的头已对不上：头锚永假；但终态可能改判「中间回显」（窗口按全长算，
 *     帧里算窄）→ 从**最早那处回显**切开，或从「草稿残串的可能起点」切开。剥与不剥两种
 *     终态都以这一段为前缀，所以安全。
 */
function prefixSafeStripEcho(out, draft) {
    if (draft.length === 0 || out.length === 0)
        return out;
    const lowerOut = out.toLowerCase();
    const lowerDraft = draft.toLowerCase();
    if (lowerOut.length < lowerDraft.length) {
        return lowerDraft.startsWith(lowerOut) ? '' : withholdEchoResidual(out, lowerOut, lowerDraft);
    }
    if (lowerOut.startsWith(lowerDraft))
        return out.slice(draft.length);
    const idx = lowerOut.indexOf(lowerDraft);
    if (idx >= 0)
        return out.slice(0, idx);
    return withholdEchoResidual(out, lowerOut, lowerDraft);
}
/** 帧尾是草稿的**残串**（`xyab` + 草稿 `abc`）：下一帧可能凑成完整回显 → 从残串起点扣住。 */
function withholdEchoResidual(out, lowerOut, lowerDraft) {
    for (let i = 1; i < out.length; i += 1) {
        if (lowerDraft.startsWith(lowerOut.slice(i)))
            return out.slice(0, i);
    }
    return out;
}
function withholdPartialEscape(text) {
    const at = text.lastIndexOf('\x1b');
    if (at < 0)
        return text;
    // 已经收全的转义序列（终态会整条删掉，本帧也整条删掉）→ 不用扣。
    if (new RegExp(`^(?:${ESCAPE_RE.source})`).test(text.slice(at)))
        return text;
    return text.slice(0, at);
}
/** 尾引号 + 尾随空白（表 B #2/#3 的对应物）：可能被后文接上，先不显示。 */
function withholdTrailingQuotesAndWs(text) {
    return text.replace(/["'“”‘’]+$/, '').replace(/\s+$/, '');
}
/**
 * 净化链里**只看前缀就能定论**的那个子集——流式中途帧专用的 `cleanSuggestion()`。
 * 签名与 `src/inline.ts` 的 `sanitizeCompletion(raw, draft, maxChars)` 对齐，
 * 因此单调性断言可以直接写成：
 * `sanitizeCompletion(raw, d, m)` 的终态结果，必须以 `prefixSafeClean(raw.slice(0, k), d, m)`
 * 为前缀（终态存在时）。这条性质由 `scripts/sanitize-monotonic-smoke.mjs` 钉住。
 *
 * 做的事（模块头表 A）：剥围栏**头**行、删转义/控制符/双向覆盖符、折叠**已闭合**
 * 空白段、剥**头**引号、`trimStart`、按终态下界做长度截断。
 * 不做的事（模块头表 B，全部交给终帧）：围栏**尾**行、尾引号、尾随空白 `trim`、
 * `>200`、尾问句、`<40` 与草稿 ×3、回显的 `0.3` 全长窗口、`maxChars` 的词边界回退。
 * 取而代之的是三个 withhold：`withholdFenceTail()` / `withholdPartialEscape()` /
 * `withholdTrailingQuotesAndWs()`——可能被终态改写的最短尾段先不输出。
 * 顺序有讲究：围栏与转义的扣住必须发生在删控制符**之前**，因为 `\n` 本身就是 C0 控制符，
 * 删掉之后「哪一行是最后一行」这个信息就没了（与 `cleanSuggestion()` 先剥围栏同理）。
 *
 * @param text 本帧已收到的原始输出（未净化）
 * @param draft 本次续写的草稿（建议场景传空串）
 * @param maxChars 长度上限（`Infinity` = 不截断）
 * @returns 保证是终态结果前缀的净化文本
 */
export function prefixSafeClean(text, draft = '', maxChars = Infinity) {
    let out = stripFenceHead(text); // A: 头锚围栏
    out = withholdFenceTail(out); // B: 扣住尾锚围栏
    out = withholdPartialEscape(out); // B: 扣住半截转义序列
    out = out.replace(ESCAPE_RE, '').replace(CONTROL_RE, '').replace(BIDI_RE, '');
    out = collapseClosedWhitespace(out); // A: 只折叠已闭合的空白段
    // A: 头锚引号。两侧都要 trimStart——终态在剥完头/尾引号后还有**最后一次** `trim()`
    // （[L119]），`" " 文本"` 这种「引号后面紧跟空格」的形状，剥掉头引号会**露出**新的
    // 前导空白；前导空白在终态必然被 trim 掉，所以本帧跟着 trimStart 是前缀安全的。
    out = out.trimStart().replace(QUOTE_HEAD_RE, '').trimStart();
    out = prefixSafeStripEcho(out, draft); // A: 头锚回显（能定论的一支）
    out = withholdTrailingQuotesAndWs(out); // B: 扣住尾引号与尾随空白
    out = out.trimStart();
    return prefixSafeCap(out, maxChars); // B 的保守下界版
}
