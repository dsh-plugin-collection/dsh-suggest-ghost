#!/usr/bin/env node
/**
 * 净化链的**单调性**冒烟（Gitea #37）。
 *
 * ## 要钉住的东西
 * 宿主是一条一条 delta 收模型输出的。中途帧如果跑了「尾锚/全长」判据，该帧的输出就
 * 不再是终态结果的前缀：用户会看到幽灵文本「先少一截、再自己长回来」，甚至先显示一段
 * 被终态判为「这是回答 / 这是草稿回显」而应当丢弃的内容。
 *
 * 本文件从四个方向钉这条线：
 *
 *  1. **差分参照**（第 1 段）——把 #37 之前的六个对外函数逐字抄一份，对 ~5k 条输入
 *     断言新实现与参照**完全相等**。这是「对外行为逐字不变」的最强形式：它不比四条
 *     既有冒烟覆盖面大得多，而且不依赖 git 历史。
 *  2. **产物一致**（第 2 段）——`src/sanitize.ts` 与入库产物 `lib/sanitize.js` 在同一批
 *     输入上必须给出相同结果。冒烟是从 `lib/inline.js` 取 `sanitizeCompletion` 的
 *     （`src/inline.ts` 在 strip-types 下解析不了 `./sanitize.js`，见该文件头注释），
 *     产物陈旧会在这里红，而不是让第 3 段悄悄测一份旧代码。
 *  3. **单调性**（第 3 段）——对每条 raw 的**每个前缀** p：
 *     `prefixSafeClean(p, draft, max)` 必须是 `sanitizeCompletion(raw, draft, max)`
 *     的前缀（终态存在时）。数十万帧，零违规。
 *  4. **三类反例**（第 5 段）——断言**既有终态判据在中途帧会被误放行**，逐条打印实际
 *     输出。这三类正是 `prefixSafeClean()` 不跑它们、只「扣住尾巴」的理由。
 *     外加第 4 段的**活性**断言：单调性可以用「每帧都返回空串」作弊骗过去，所以必须
 *     另外证明收全且无歧义尾巴的帧与终态**逐字相等**。
 *
 * 用法：node scripts/sanitize-monotonic-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cleanSuggestion,
  sanitizeSuggestion,
  shouldFilterSuggestion,
  shouldFilterCompletion,
  shouldFilterCompletionFor,
  stripDraftEcho,
  prefixSafeClean,
} from '../src/sanitize.ts';
import * as libSanitize from '../lib/sanitize.js';
import { sanitizeCompletion } from '../lib/inline.js';

let cases = 0;
let failed = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

// ── 语料：既有冒烟的全部输入 + 生成式样本 ────────────────────────────────────────
const TOK = [
  'a', 'b', 'c', 'd', 'X', 'Y', 'Z', '0', '_', '-', '.', ',', '!', '?', '？', '¿',
  ' ', '  ', '   ', '\n', '\n\n', '\t',
  '```', '```json\n', '~~~', '```js\n```', '``', '`', '~', '~~',
  '"', "'", '“', '”', '‘', '’', '""', "''",
  '\x1b[31m', '\x1b[0m', '\x1b', '\x1b[', '\x1b]8;;u\x07', '\x1b]0;t',
  '‮', '‭', '\u0001', '\u0007', '\u007f', '\u009f',
  '多', '文', '本', '继续', '好的', '谢谢', '我来', '帮你', '部署', '测试',
  'the', 'run', 'tests', 'now', 'build', 'npm', '&&', 'deploy',
];
const HANDPICKED = [
  // 既有四条冒烟里出现过的输入（sanitize-smoke / inline-smoke / completion-answer-filter-smoke）
  '\x1b[31m红色\x1b[0m 建议', 'a‮b‭c', '```json\n{"a":1}\n```', '“继续运行”',
  '  多   行\n文本  ', 'short', 'run the tests now and then commit',
  'no suggestion for now', 'An error occurred during the build.', 'thanks for asking!',
  'Let me look into that for you', 'What about the tests?', 'x'.repeat(300),
  '继续', '好的', 'run the tests', 'yes', 'commit this', '。', 'a', '',
  ' and run the tests', 'npm run build && npm test', 'npm run build', '```\n--watch\n```',
  '并且重新部署服务', '你的意思是', '这样可以吗？', '我来测试一下', '让我想想',
  '答'.repeat(94), '输'.repeat(46), '输'.repeat(54), '输'.repeat(67), '输'.repeat(135),
  '输'.repeat(79), '输'.repeat(25), '输'.repeat(30), '输'.repeat(50), '输'.repeat(60),
  '长'.repeat(201), ' +3m 我重新部署了', 'y'.repeat(125),
];
let seed = 987654321;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const generated = Array.from({ length: 3200 }, () => {
  const n = 1 + Math.floor(rnd() * 9);
  let s = '';
  for (let i = 0; i < n; i += 1) s += pick(TOK);
  return s;
});
const CORPUS = [...HANDPICKED, ...generated, ...HANDPICKED.map((t) => t + '\n```')];
const DRAFTS = ['', 'a', 'ab', 'npm', 'npm run build', '多文', '文本继续', 'the run', 'X', '好的谢谢', '  ', '```', '看看这个'];
const MAXES = [Infinity, 200, 160, 140, 60, 40, 20, 18, 14, 8, 5, 3, 2, 1];

// ── 1. 差分参照：#37 之前的实现逐字抄一份，新实现必须给出**完全相同**的结果 ──────────
// 这段是「对外行为不变」的正身。抄自 main 的 `src/sanitize.ts`（HEAD 前一版），
// 一个字都没改：判据顺序、常量取值、注释里的取舍全部保留。
const REF = {
  CONTROL_RE: /[\u0000-\u001f\u007f-\u009f]/g,
  ESCAPE_RE: /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,
  BIDI_RE: /[\u202a-\u202e\u2066-\u2069]/g,
  META_RE: /\b(?:no suggestion|nothing|stay silent|no response|n\/a)\b/i,
  ERROR_ECHO_RE: /\b(?:error|exception|failed)\b.*\b(?:occurred|thrown|raised)\b/i,
  THANKS_RE: /\b(?:thanks|thank you|looks good|looks great|great job|well done)\b|(?:不错|谢谢|好的|可以)/i,
  ASSISTANT_VOICE_RE: /\b(?:let me|i'?ll|i will|here'?s|i can|我来|我帮你|我来帮你|让我)\b/i,
  QUESTION_RE: /^[¿?？]|(?:[?？]\s*$)/,
  MIN: 40,
  RATIO: 3,
};
const refCleanSuggestion = (text) => {
  let out = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```[^\n]*$/, '')
    .replace(/^~~~[^\n]*\n?/, '')
    .replace(/\n?~~~[^\n]*$/, '');
  out = out
    .replace(REF.ESCAPE_RE, '')
    .replace(REF.CONTROL_RE, '')
    .replace(REF.BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  out = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');
  return out.trim();
};
const refSanitizeSuggestion = (text, maxChars) => {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const end = lastSpace > Math.floor(maxChars * 0.6) ? lastSpace : maxChars;
  return { text: cut.slice(0, end).trimEnd(), truncated: true };
};
const refIsOrphanWord = (text) => {
  const words = text.split(/\s+/);
  if (words.length === 1) {
    const word = words[0];
    if (word.length <= 1) return true;
    if (/^[\p{P}\p{S}]+$/u.test(word)) return true;
  }
  return false;
};
const refShouldFilterSuggestion = (text) => {
  if (text.length === 0) return true;
  if (text.length > 200) return true;
  if (REF.META_RE.test(text)) return true;
  if (REF.ERROR_ECHO_RE.test(text)) return true;
  if (REF.THANKS_RE.test(text)) return true;
  if (REF.ASSISTANT_VOICE_RE.test(text)) return true;
  if (REF.QUESTION_RE.test(text)) return true;
  return refIsOrphanWord(text);
};
const refShouldFilterCompletion = (text) => {
  if (text.length === 0) return true;
  if (text.length > 200) return true;
  if (REF.META_RE.test(text)) return true;
  if (REF.ERROR_ECHO_RE.test(text)) return true;
  return refIsOrphanWord(text);
};
const refShouldFilterCompletionFor = (text, draft) => {
  if (refShouldFilterCompletion(text)) return true;
  if (text.length < REF.MIN) return false;
  const draftChars = draft.trim().length;
  if (draftChars === 0) return true;
  return text.length > draftChars * REF.RATIO;
};
const refStripDraftEcho = (completion, draft) => {
  if (completion.length === 0 || draft.length === 0) return completion;
  const lowerCompletion = completion.toLowerCase();
  const lowerDraft = draft.toLowerCase();
  if (lowerCompletion.startsWith(lowerDraft)) return completion.slice(draft.length).trim();
  const idx = lowerCompletion.indexOf(lowerDraft);
  if (idx >= 0 && idx < completion.length * 0.3) {
    return (completion.slice(0, idx) + completion.slice(idx + draft.length)).trim();
  }
  return completion;
};

run('差分参照：cleanSuggestion 与 #37 之前逐字相等', () => {
  let diffs = 0;
  for (const t of CORPUS) if (cleanSuggestion(t) !== refCleanSuggestion(t)) {
    diffs += 1;
    if (diffs <= 3) console.error(`      输入 ${JSON.stringify(t)}：新 ${JSON.stringify(cleanSuggestion(t))} / 参照 ${JSON.stringify(refCleanSuggestion(t))}`);
  }
  assert.equal(diffs, 0, `cleanSuggestion 有 ${diffs}/${CORPUS.length} 条输入结果变了`);
});

run('差分参照：sanitizeSuggestion 的 text 与 truncated 都不变', () => {
  let diffs = 0;
  for (const t of CORPUS) {
    for (const max of MAXES) {
      const a = sanitizeSuggestion(t, max);
      const b = refSanitizeSuggestion(t, max);
      if (a.text !== b.text || a.truncated !== b.truncated) {
        diffs += 1;
        if (diffs <= 3) console.error(`      输入 ${JSON.stringify(t)} max=${max}：新 ${JSON.stringify(a)} / 参照 ${JSON.stringify(b)}`);
      }
    }
  }
  assert.equal(diffs, 0, `sanitizeSuggestion 有 ${diffs} 组 (输入, maxChars) 结果变了`);
});

run('差分参照：三个过滤器布尔值不变', () => {
  let diffs = 0;
  for (const t of CORPUS) {
    if (shouldFilterSuggestion(t) !== refShouldFilterSuggestion(t)) diffs += 1;
    if (shouldFilterCompletion(t) !== refShouldFilterCompletion(t)) diffs += 1;
    for (const d of DRAFTS) {
      if (shouldFilterCompletionFor(t, d) !== refShouldFilterCompletionFor(t, d)) diffs += 1;
    }
  }
  assert.equal(diffs, 0, `过滤器有 ${diffs} 处判定变了（对外行为不许动）`);
});

run('差分参照：stripDraftEcho 不变', () => {
  let diffs = 0;
  for (const t of CORPUS) {
    for (const d of DRAFTS) {
      if (stripDraftEcho(t, d) !== refStripDraftEcho(t, d)) {
        diffs += 1;
        if (diffs <= 3) console.error(`      completion=${JSON.stringify(t)} draft=${JSON.stringify(d)}：新 ${JSON.stringify(stripDraftEcho(t, d))} / 参照 ${JSON.stringify(refStripDraftEcho(t, d))}`);
      }
    }
  }
  assert.equal(diffs, 0, `stripDraftEcho 有 ${diffs} 组结果变了`);
});

run('差分参照：整条终态链 sanitizeCompletion 输出不变', () => {
  const refChain = (raw, draft, max) => {
    let out = refStripDraftEcho(refCleanSuggestion(raw), draft);
    out = out.trim();
    if (out.length === 0 || refShouldFilterCompletionFor(out, draft)) return undefined;
    return refSanitizeSuggestion(out, max).text;
  };
  let diffs = 0;
  for (const raw of CORPUS) {
    for (const draft of DRAFTS) {
      for (const max of [200, 40, 14]) {
        const a = sanitizeCompletion(raw, draft, max);
        const b = refChain(raw, draft, max);
        if (a !== b) {
          diffs += 1;
          if (diffs <= 3) console.error(`      raw=${JSON.stringify(raw)} draft=${JSON.stringify(draft)} max=${max}：新 ${JSON.stringify(a)} / 参照 ${JSON.stringify(b)}`);
        }
      }
    }
  }
  assert.equal(diffs, 0, `sanitizeCompletion 有 ${diffs} 组结果变了`);
});

// ── 2. 入库产物必须与源码一致（第 3 段要用 lib/inline.js，产物陈旧会悄悄测旧代码）────
run('src/sanitize.ts 与 lib/sanitize.js 在同一批输入上一致', () => {
  const pairs = [
    ['cleanSuggestion', (s) => s.cleanSuggestion, cleanSuggestion],
    ['shouldFilterSuggestion', (s) => s.shouldFilterSuggestion, shouldFilterSuggestion],
    ['shouldFilterCompletion', (s) => s.shouldFilterCompletion, shouldFilterCompletion],
    ['stripDraftEcho', (s) => (t) => s.stripDraftEcho(t, 'npm run build'), (t) => stripDraftEcho(t, 'npm run build')],
    ['prefixSafeClean', (s) => (t) => s.prefixSafeClean(t, 'npm', 200), (t) => prefixSafeClean(t, 'npm', 200)],
  ];
  for (const [name, fromLib, fromSrc] of pairs) {
    assert.equal(typeof fromLib(libSanitize), 'function', `lib/sanitize.js 没有导出 ${name}（产物过期？跑 tsc && node build.mjs）`);
    let diffs = 0;
    for (const t of CORPUS) if (fromLib(libSanitize)(t) !== fromSrc(t)) diffs += 1;
    assert.equal(diffs, 0, `${name}：lib/ 产物与 src/ 源码结果不一致 ${diffs} 条——产物过期了`);
  }
});

// ── 3. 单调性：每个前缀的帧输出必须是终态结果的前缀 ───────────────────────────────
run('单调性：prefixSafeClean(前缀) ⊑ sanitizeCompletion(终态)，全语料全前缀', () => {
  let frames = 0;
  let finals = 0;
  const bad = [];
  for (const raw of CORPUS) {
    for (const draft of DRAFTS) {
      for (const max of [Infinity, 200, 40, 14]) {
        const final = sanitizeCompletion(raw, draft, max);
        if (final === undefined) continue;
        finals += 1;
        for (let k = 1; k <= raw.length; k += 1) {
          const frame = prefixSafeClean(raw.slice(0, k), draft, max);
          frames += 1;
          if (!final.startsWith(frame) && bad.length < 6) bad.push({ raw, draft, max, k, frame, final });
        }
      }
    }
  }
  // 先证明这次真的跑了很多帧：否则「0 违规」可能只是什么都没测。
  assert.ok(frames > 200_000, `帧数太少（${frames}），这条断言没在测东西`);
  assert.ok(finals > 2_000, `有终态的 (raw, draft, max) 组合太少（${finals}）`);
  assert.equal(bad.length, 0, bad.map((b) =>
    `\n      raw=${JSON.stringify(b.raw)} draft=${JSON.stringify(b.draft)} max=${b.max} k=${b.k}`
    + `\n        帧 ${JSON.stringify(b.frame)}\n        终 ${JSON.stringify(b.final)}`).join('\n      ')
    + `\n      ——单调性被破坏：中途帧显示了终态没有的字符`);
  console.log(`      （${frames} 帧 / ${finals} 个终态，0 违规）`);
});

// ── 4. 活性：单调性不能靠「每帧返回空串」作弊 ─────────────────────────────────────
run('活性：收全且尾巴无歧义的帧与终态逐字相等（不是退化成空串）', () => {
  const complete = [
    [' and run the tests', 'npm run build', 200],
    ['npm run build && npm test', 'npm run build', 200],
    ['```json\n{"a":1}\n```', '', 200],
    ['“继续运行”', '', 200],
    ['并且重新部署服务', '修好后再跑一遍测试', 200],
    ['the tests and then commit', 'npm run build', 200],
    ['--watch', 'npm test', 200],
    ['部署到生产环境并检查日志', '我打算把这段改一下', 200],
  ];
  for (const [raw, draft, max] of complete) {
    const final = sanitizeCompletion(raw, draft, max);
    assert.notEqual(final, undefined, `样例本身就不该被过滤：${JSON.stringify(raw)}`);
    const whole = prefixSafeClean(raw, draft, max);
    assert.equal(whole, final, `整帧应当与终态相等：raw=${JSON.stringify(raw)} 帧=${JSON.stringify(whole)} 终=${JSON.stringify(final)}`);
    assert.ok(whole.length > 0, `整帧为空 = 退化实现：${JSON.stringify(raw)}`);
  }
});

run('活性：中途帧确实在长（不是永远空串）', () => {
  const raw = '```python\nprint("hi there")\n```';
  const seen = [];
  for (let k = 1; k <= raw.length; k += 1) seen.push(prefixSafeClean(raw.slice(0, k), '', 200));
  const nonEmpty = seen.filter((s) => s.length > 0).length;
  assert.ok(nonEmpty > raw.length * 0.3, `非空帧只有 ${nonEmpty}/${raw.length}，等于没做前缀净化`);
  const final = sanitizeCompletion(raw, '', 200);
  assert.ok(seen.every((s) => final.startsWith(s)), '每一帧都必须是终态的前缀');
});

// ── 5. 三类反例：既有终态判据跑在中途帧上会**误放行** ─────────────────────────────
// 这三条不是「希望它红」，而是**断言当前行为就是这样**：它们给出 `prefixSafeClean()`
// 为什么不跑这些判据的证据。哪天有人把尾锚/全长判据塞回流式路径，这三条先红。
run('反例① 围栏尾行误剥：尾锚 `$` 把「本帧最后一行」当成闭栏，终态却不剥', () => {
  const frame = 'x```keep';
  const raw = 'x```keep\nmore';
  const naive = cleanSuggestion(frame);            // 既有链跑在帧上
  const final = sanitizeCompletion(raw, '', 200);  // 同一份文本的终态
  const guarded = prefixSafeClean(frame, '', 200); // 新链跑在同一帧上
  console.log(`      帧(既有一整链) = ${JSON.stringify(naive)}`);
  console.log(`      终态          = ${JSON.stringify(final)}`);
  console.log(`      帧(prefixSafe) = ${JSON.stringify(guarded)}`);
  assert.equal(naive, 'x', '既有链在帧上本应「误剥」掉 ```keep —— 这条反例的前提变了，去核对判据');
  assert.ok(final.includes('```'), '终态本应保留围栏字符 —— 这条反例的前提变了');
  assert.notEqual(naive, final, '若两者相等，说明误剥已不存在，本反例失效');
  // 半截围栏头行：既有链把它当正文放行，而终态判「整条丢弃」（净化后为空）。
  const half = cleanSuggestion('`');
  const finalOfFence = sanitizeCompletion('```', '', 200);
  console.log(`      半截围栏帧 = ${JSON.stringify(half)}，终态 = ${JSON.stringify(finalOfFence)}（连建议都没有）`);
  assert.equal(half, '`', '既有链本会把半截围栏当正文留下');
  assert.equal(finalOfFence, undefined, '终态本应整条丢弃（净化后空串）');
  const halfGuarded = prefixSafeClean('`', '', 200);
  assert.equal(halfGuarded, '', 'prefixSafeClean 必须把半截围栏扣住，等后文定论');
  // 尾锚误剥的方向：既有链在帧上「多剥」，把终态会保留的正文一起吃掉。
  assert.ok(final.includes('```') && naive === 'x', '既有链在帧上吃掉了终态保留的围栏与正文');
});

run('反例② >200 与 草稿×3：帧永远够短，中途一律放行', () => {
  // 绝对长度上限：帧 100 字放行，终态 300 字丢弃 → 幽灵先出现再消失。
  const long = '长'.repeat(300);
  const frameText = cleanSuggestion(long.slice(0, 100));
  const naiveFrameVerdict = shouldFilterCompletion(frameText);
  const final = sanitizeCompletion(long, '草稿', 400);
  console.log(`      帧长 ${frameText.length} 字 → shouldFilterCompletion = ${naiveFrameVerdict}（放行）`);
  console.log(`      终态 300 字 → sanitizeCompletion = ${JSON.stringify(final)}（丢弃）`);
  assert.equal(naiveFrameVerdict, false, '帧不该被 >200 判死；变了就核对 SUGGESTION_MAX_CHARS');
  assert.equal(frameText.length, 100);
  assert.equal(final, undefined, '终态必须被 >200 丢弃');
  assert.ok(prefixSafeClean(long.slice(0, 100), '草稿', 400).length > 0, '帧确有文本被显示（误放行成立）');

  // 形态兜底：比值分子是本帧长度，终态全长才翻面。
  const draft = '看看这个';
  const out = '答'.repeat(46);
  const frameVerdict = shouldFilterCompletionFor(out.slice(0, 20), draft);
  const finalVerdict = shouldFilterCompletionFor(out, draft);
  const chainFinal = sanitizeCompletion(out, draft, 200);
  console.log(`      帧 20 字/草稿 4 字 → shouldFilterCompletionFor = ${frameVerdict}（放行）`);
  console.log(`      终 46 字/草稿 4 字 → shouldFilterCompletionFor = ${finalVerdict}（判为回答）`);
  console.log(`      终态 sanitizeCompletion = ${JSON.stringify(chainFinal)}`);
  assert.equal(frameVerdict, false, '帧判据必须放过（这正是被误放行的那一半）');
  assert.equal(finalVerdict, true, '终态判据必须拦下');
  assert.equal(chainFinal, undefined, '终态整条链必须丢弃');
});

run('反例③ 回声窗口按总长误判：同一处回显，帧里不剥、终态剥', () => {
  const draft = 'abc';
  const frame = 'xyabc';                    // idx=2，帧长 5 → 窗口 0.3*5=1.5 → 2 ≥ 1.5 判「不是回显」
  const raw = 'xyabc def gh ij kl mn op';   // 全长 24 → 窗口 7.2 → 2 < 7.2 判「是回显」并剥掉
  const naiveFrame = stripDraftEcho(frame, draft);
  const final = sanitizeCompletion(raw, draft, 200);
  const guarded = prefixSafeClean(frame, draft, 200);
  console.log(`      帧 stripDraftEcho = ${JSON.stringify(naiveFrame)}（回显没剥，草稿字符被当成续写放行）`);
  console.log(`      终态             = ${JSON.stringify(final)}`);
  console.log(`      帧 prefixSafeClean = ${JSON.stringify(guarded)}（扣住不显示）`);
  assert.equal(naiveFrame, frame, '既有窗口在帧上本就不该剥 —— 前提变了就去核对 0.3 窗口');
  assert.equal(final, 'xy def gh ij kl mn op', '终态必须剥掉回显');
  assert.ok(!final.startsWith(naiveFrame), '本反例要点：既有链的帧输出带着回显，根本不是终态前缀');
  assert.ok(final.startsWith(guarded), 'prefixSafeClean 必须把回显起点之后整段扣住');
  // 另一种形状：帧还没收全草稿，`indexOf(draft)` 找不到 → 半个草稿被当续写显示。
  const partial = stripDraftEcho('xx npm ru', 'npm run build');
  const full = sanitizeCompletion('xx npm run build and then some more words here', 'npm run build', 200);
  console.log(`      半截草稿帧 = ${JSON.stringify(partial)}，终态 = ${JSON.stringify(full)}`);
  assert.equal(partial, 'xx npm ru', '草稿没收全时既有链剥不动 —— 误放行');
  assert.ok(full.startsWith('xx '), '终态剥掉了回显');
  assert.ok(!full.startsWith(partial), '半截回显同样破坏单调性');
  assert.ok(full.startsWith(prefixSafeClean('xx npm ru', 'npm run build', 200)), 'prefixSafeClean 把残串扣住');
});

// ── 6. 模块头判据表的锚点自校验：改了代码不改表，这里先红 ──────────────────────────
run('模块头表的 L行:标记 锚点全部对得上实际代码', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/sanitize.ts', import.meta.url)), 'utf8').split('\n');
  const header = src.slice(0, src.findIndex((l) => l === ' */') + 1).join('\n');
  const anchors = [...header.matchAll(/L(\d+):([^ |)）\r\n]+)/g)];
  assert.ok(anchors.length >= 20, `锚点只解析到 ${anchors.length} 处，表大概被改坏了`);
  const bad = [];
  for (const [, lineNo, token] of anchors) {
    const line = src[Number(lineNo) - 1] ?? '';
    if (!line.includes(token)) bad.push(`L${lineNo}:${token} → 该行实际是 ${JSON.stringify(line.trim().slice(0, 70))}`);
  }
  assert.equal(bad.length, 0, `有 ${bad.length} 处锚点指错行（表 B 是「哪些判据只能在终帧成立」的唯一清单，必须与代码同步行号）：\n      ${bad.join('\n      ')}`);
  console.log(`      （核对 ${anchors.length} 处锚点）`);
});

console.log('');
if (failed > 0) {
  console.error(`❌ sanitize-monotonic-smoke: ${failed} 组失败（共 ${cases} 组）`);
  process.exit(1);
}
console.log(`✅ sanitize-monotonic-smoke: ${cases} 组用例全部通过`);
