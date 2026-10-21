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
/** 把文本中的密钥形状替换为占位标签。 */
export declare function redactSecrets(text: string): string;
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
export declare function cleanSuggestion(text: string): string;
/**
 * 建议可见字符上限截断；返回截断标记。
 *
 * **finalOnly（表 B #9）**：`lastSpace` 取的是「前 maxChars 个字符里的最后一个空格」，
 * 而 `end` 会在词边界与 `maxChars` 之间二选一——本帧长度没到 maxChars 之前，这个
 * 取舍随时可能被后文改写。流式中途帧的截断口径见 `prefixSafeCap()`。
 */
export declare function sanitizeSuggestion(text: string, maxChars: number): {
    readonly text: string;
    readonly truncated: boolean;
};
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export declare function hasCJK(text: string): boolean;
/** 检测文本是否含西里尔字母（俄语等）。 */
export declare function hasCyrillic(text: string): boolean;
/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export declare function shouldFilterSuggestion(text: string): boolean;
/** 续写场景的过滤：比建议场景更宽松，问句/感谢/助手口吻在续写语境下是合理续写。 */
export declare function shouldFilterCompletion(text: string): boolean;
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
export declare function shouldFilterCompletionFor(text: string, draft: string): boolean;
/**
 * 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。
 *
 * **finalOnly（表 B #8）**：部分回显的判定窗口 `idx < completion.length * 0.3`
 * 用的是**全长**的 30%。中途帧的 `completion.length` 小于终态全长，窗口按比例
 * 算窄，于是「本帧判不出回显 → 整段放行 → 终帧全长后判据翻转又剥掉」。
 * 这正是幽灵文本「先重复用户草稿、再吞掉草稿」的来源。`prefixSafeClean()`
 * 里对应的处理是把窗口宽度按**终态长度下界**（= 本帧长度）之外的可能性扣住。
 */
export declare function stripDraftEcho(completion: string, draft: string): string;
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
export declare function prefixSafeClean(text: string, draft?: string, maxChars?: number): string;
