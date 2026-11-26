#!/usr/bin/env node
/**
 * 自定义提示词的**热生效**真回合 e2e（Gitea #182）。
 *
 * ## 这条脚本证明的是别的脚本证不到的那一层
 *
 * `prompt-override-smoke.mjs` 驱动的是纯函数与源码文本（登记点、展开规则、留痕在场）；
 * 它**不经过** cordis、不经过 settings 服务、不经过 `settings/document-updated`。
 * 「设置页改完不用重启」这句话的真正判据在那条链上：
 *
 * ```
 * settings.update(NS, {suggestionPrompt}) → 内核换 fiber 的 config 引用
 *   → emit settings/document-updated(ns, revision) → 宿主 invalidate() 标脏
 *   → 下一次 effective() 现读 describe() → 下一次生成的 system 就是新提示词
 * ```
 *
 * 本脚本用真 `Context` + 真 `dsh-session` + 内存 settings 面 + 注入假 `llm` 服务，
 * 在**同一个进程、不重启**的前提下跑三回合，逐回合核两件事：
 *  ① 假 llm 收到的 `options.system` 是什么（模型实际看到的那份，不是配置值）；
 *  ② 留痕行尾的 `prompt=` 读数对不对（用户在日志里唯一能自己查到的证据）。
 *
 * ## 回合编排（每一步都对应一条断言）
 *
 *  1. **回合 1**：两键都没配 ⇒ system 必须与内置模板**逐字节相同**、留痕 `prompt=builtin`；
 *  2. 中途 `settings.update` 写 `suggestionPrompt`（含 `{{maxChars}}` / `{{language}}`）；
 *  3. **回合 2**：不重启，system 必须等于展开结果、留痕 `prompt=custom`；
 *  4. 再写 `completionPrompt` 并发一条 `complete` op ⇒ 续写的 system 换成自定义，
 *     而**建议路径不受影响**（分键）；
 *  5. 把 `suggestionPrompt` 清空回 `''` ⇒ **回合 3** 的 system 必须与回合 1 那份**完全相同**
 *     （「清空后回落到旧值」这个形状在 provider/model 上出过事，见 `mergeLiveConfig` 的注释）。
 *
 * ## 三态口径（docs/gitea-workflow.md §5）
 *  - 产物缺失 → NOT-COVERED（谈不上行为）；
 *  - 事件链读数缺失（`live settings refreshed` 不在场）→ **单独一条 NOT-COVERED**，
 *    不许把它算成「热生效已验证」；system 确实变了仍算主判据通过；
 *  - system / 留痕与期望不符 → FAIL，期望与实际都打出来。
 *
 * 用法：`node scripts/prompt-override-real-e2e.mjs [--repo <dir>]`
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { systemPrompt } from '../lib/generate.js';
import { LANGUAGE_TOKEN, MAX_CHARS_TOKEN } from '../lib/prompt-override.js';

// 留痕默认只到 warn；本脚本要抓 debug 级心跳行，**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

const argv = process.argv.slice(2);
const argvRepo = argv.indexOf('--repo');
const repo = resolve(argvRepo >= 0 && argv[argvRepo + 1] !== undefined
  ? argv[argvRepo + 1]
  : dirname(dirname(fileURLToPath(import.meta.url))));
const libDir = join(repo, 'lib');
const NS = 'suggest-ghost';

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const results = [];

/**
 * 记一条结果。**入参是 boolean**，第三个参数是证据不是装饰。
 *
 * 为什么不像 `ghost-frame-real-e2e.mjs` 那样收 STATUS 常量：那一份的签名是
 * `record(name, status, detail)`，把 boolean 传进去会**两个分支都不命中** ⇒ 打 ⚪、
 * 不计失败、退出码 0 —— 一条永远绿的闸（§6 说的「加一道闸之前先证这道闸是活的」）。
 * 本脚本因此只认 boolean，NC 走 `recordNC` 显式记，杜绝"漏一个分支就静默"。
 */
function record(name, ok, detail) {
  const status = ok === true ? STATUS.PASS : STATUS.FAIL;
  results.push({ name, status, detail });
  console.log(`${status === STATUS.PASS ? '✅' : '❌'} [${status}] ${name}${detail ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
}
function recordNC(name, detail) {
  results.push({ name, status: STATUS.NC, detail });
  console.log(`⚪ [${STATUS.NC}] ${name}${detail ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`prompt-override-real-e2e：产物来源 ${repo}`);

if (!existsSync(join(libDir, 'index.js')) || !existsSync(join(libDir, 'generate.js'))) {
  recordNC('宿主产物就位（lib/index.js + lib/generate.js）',
    `缺前置：${libDir} 里缺编译产物。先跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`);
  finish();
  process.exit(0);
}

// ── 留痕捕获（四条产出行走 debug，与 ghost-frame-real-e2e 同一取舍）────────────
const traceLines = [];
const swallow = (line) => line.includes('[ops-trace]') || line.includes('[suggest-ghost]');
for (const key of ['log', 'warn', 'debug', 'info']) {
  const real = console[key].bind(console);
  console[key] = (...args) => {
    const line = args.map(String).join(' ');
    if (swallow(line)) traceLines.push(line);
    else real(line);
  };
}
const lastLineWith = (needle) => traceLines.filter((l) => l.includes(needle)).pop() ?? null;

// ── 内存 settings 面 + 假 llm 服务（与 ghost-frame-real-e2e 同一形状）──────────
function installSettingsService(root) {
  class MemorySettings extends Service {
    revision = 0;
    value = {};
    constructor(ctx) { super(ctx, 'settings'); }
    describe() { return [{ ns: NS, revision: this.revision, value: structuredClone(this.value) }]; }
    update(ns, patch) {
      Object.assign(this.value, structuredClone(patch));
      this.revision += 1;
      this.ctx.emit('settings/document-updated', ns, this.revision);
      return Promise.resolve();
    }
  }
  return new MemorySettings(root);
}

const SUGGESTION_TEXT = '跑一下测试';
function installFakeLlm(root) {
  const requests = [];
  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
    stream(options) {
      requests.push(options);
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: SUGGESTION_TEXT },
        { type: 'block-end', index: 0, block: { type: 'text', text: SUGGESTION_TEXT } },
        { type: 'usage', usage: { input: 24, output: 1 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* emit() {
        for (const chunk of chunks) { await sleep(2); yield chunk; }
      })();
    }
  }
  return { service: new FakeLlm(root), requests };
}

// ── 装配：显式路由对 + 固定字符上限，便于逐字节比对内置模板 ────────────────────
const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = installSettingsService(root);
const { service: fakeLlm, requests: llmRequests } = installFakeLlm(root);
void fakeLlm;

const { apply: applyHost } = await import(pathToFileURL(join(libDir, 'index.js')).href);

const MAX_SUGGESTION_CHARS = 120;
const INLINE_MAX_CHARS = 120;
applyHost(root, {
  provider: 'fake-provider',
  model: 'fake-model',
  maxInputBytes: 4096,
  maxOutputTokens: 256,
  timeoutMs: 8000,
  maxTranscriptChars: 4000,
  maxSuggestionChars: MAX_SUGGESTION_CHARS,
  inlineDelayMs: 50,
  inlineMinChars: 2,
  inlineMaxChars: INLINE_MAX_CHARS,
  llmEnabled: true,
  // 关掉历史补全：`complete` op 才稳定走 LLM 续写那一条支（历史命中会直接返回，不产生请求）。
  historyEnabled: false,
  inlineEnabled: true,
});

const SESSION = 'prompt-round-session';
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });

/** 跑一个真回合，等建议留痕出现，返回**这一次**发给 llm 的 options。 */
async function runTurn(turn, userText, assistantText) {
  const before = llmRequests.length;
  const beforeTrace = traceLines.filter((l) => l.includes('suggestion generated')).length;
  session.append('turn/start', { turn });
  session.append('user/message', {
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  for (let t = 0; t < 200 && llmRequests.length === before; t += 1) await sleep(25);
  for (let t = 0; t < 80
    && traceLines.filter((l) => l.includes('suggestion generated')).length === beforeTrace; t += 1) await sleep(25);
  return {
    options: llmRequests[before],
    trace: traceLines.filter((l) => l.includes('suggestion generated')).slice(beforeTrace).pop() ?? null,
  };
}

/** 发一条 `complete` op 触发停顿续写，返回这一次发给 llm 的 options。 */
async function runCompletion(draft) {
  const before = llmRequests.length;
  await settings.update(NS, {
    _ops: JSON.stringify({ rev: Date.now(), ops: [{ op: 'complete', sessionId: SESSION, draft }] }),
  });
  for (let t = 0; t < 200 && llmRequests.length === before; t += 1) await sleep(25);
  return llmRequests[before];
}

// ── 回合 1：内置基线 ─────────────────────────────────────────────────────────
const round1 = await runTurn(1, '这个插件怎么构建', '在仓根跑 node build.mjs。');
const sys1 = round1.options?.system;
// 回合 1 的判定语言从内置模板自己的 `OUTPUT LANGUAGE:` 那句读——那是唯一不依赖实现的取法。
const lang1 = /OUTPUT LANGUAGE: ([^.]+)\./.exec(String(sys1 ?? ''))?.[1]?.trim();

record('回合 1：留痕带 prompt=builtin',
  typeof round1.trace === 'string' && /prompt=builtin/.test(round1.trace),
  round1.trace === null ? '没抓到 suggestion generated 行' : round1.trace.slice(-150));

record('回合 1：system 与内置模板逐字节相同（默认形态一字未改）',
  typeof sys1 === 'string' && lang1 !== undefined && sys1 === systemPrompt(MAX_SUGGESTION_CHARS, lang1),
  `判定语言=${String(lang1)}｜实测 system 前 60 字：${String(sys1).slice(0, 60)}`);

// ── 中途改设置（**不重启**）：自定义建议提示词 ────────────────────────────────
const CUSTOM_SUGGEST = `只回一句待办，不要解释。语言 {{language}}，上限 {{maxChars}} 字。`;
await settings.update(NS, { suggestionPrompt: CUSTOM_SUGGEST });
const refreshed = lastLineWith('live settings refreshed');

const round2 = await runTurn(2, '再跑一次冒烟', '全绿，已经推上去了。');
const sys2 = round2.options?.system;
const expected2 = CUSTOM_SUGGEST
  .split(LANGUAGE_TOKEN).join(String(lang1))
  .split(MAX_CHARS_TOKEN).join(String(MAX_SUGGESTION_CHARS));

record('回合 2：不重启，system 就是自定义模板的展开结果',
  typeof sys2 === 'string' && sys2 === expected2,
  `期望：${expected2}\n     实际：${String(sys2)}`);

record('回合 2：留痕带 prompt=custom',
  typeof round2.trace === 'string' && /prompt=custom/.test(round2.trace),
  round2.trace === null ? '没抓到第二轮的 suggestion generated 行' : round2.trace.slice(-150));

if (refreshed === null) {
  recordNC('宿主重读实时值的事件链读数（live settings refreshed 在场）',
    '没看到该行 ⇒ 「不重启」只能由上一条 system 变化**间接**证明；事件链本身未验。\n'
    + `（该读数在本仓默认留痕档位下是 debug 级，本脚本已开档；仍缺就是没打，不是没捕到。）`);
} else {
  record('宿主重读实时值的事件链读数（live settings refreshed 在场）', true, refreshed.slice(0, 140));
}

// ── 续写自定义 + 建议不受影响（分键）────────────────────────────────────────
const CUSTOM_COMPLETE = `Continue the draft only, max {{maxChars}} chars, language {{language}}.`;
await settings.update(NS, { completionPrompt: CUSTOM_COMPLETE });
const sysC = (await runCompletion('这个插件怎么'))?.system;
// 续写那次的语言取值：从**模板自己的位置**读（`language {{language}}.` 展开后的那一段）。
// 不从内置模板 grep——自定义模板里没有 `MUST be in` 那句话，那正是初版误判的来源。
const langC = /language (.+?)\.$/.exec(String(sysC ?? ''))?.[1]?.trim();
const expectedC = CUSTOM_COMPLETE
  .split(LANGUAGE_TOKEN).join(String(langC))
  .split(MAX_CHARS_TOKEN).join(String(INLINE_MAX_CHARS));

record('续写读 completionPrompt，且不含建议的自定义（分键）',
  typeof sysC === 'string' && sysC === expectedC && !String(sysC).includes('只回一句待办'),
  `实际续写 system：${String(sysC)}`);

record('两条路径同轮判定出的语言一致（自定义没有把语言判定绕过去）',
  langC !== undefined && langC !== '' && lang1 !== undefined && langC === lang1,
  `回合 1 内置模板里的语言：${String(lang1)}｜续写模板展开用的语言：${String(langC)}`);

// ── 清空回内置 ───────────────────────────────────────────────────────────────
await settings.update(NS, { suggestionPrompt: '' });
const round3 = await runTurn(3, '把改动提交上去', '已经 commit 了。');
const sys3 = round3.options?.system;

record('清空回内置：回合 3 的 system 与回合 1 那份完全相同，留痕回到 builtin',
  typeof sys3 === 'string' && sys3 === sys1
    && typeof round3.trace === 'string' && /prompt=builtin/.test(round3.trace),
  `回合 3 system 前 60 字：${String(sys3).slice(0, 60)}\n     留痕尾部：${String(round3.trace).slice(-90)}`);

function finish() {
  const fails = results.filter((r) => r.status === STATUS.FAIL).length;
  const ncs = results.filter((r) => r.status === STATUS.NC).length;
  console.log(`\n结果：${results.length - fails - ncs} 通过 / ${fails} 失败 / ${ncs} NOT-COVERED`);
  if (ncs > 0) console.log('⚠️ NOT-COVERED 不计入通过（本仓口径见 docs/gitea-workflow.md §5）。');
}
finish();
process.exit(results.some((r) => r.status === STATUS.FAIL) ? 1 : 0);
