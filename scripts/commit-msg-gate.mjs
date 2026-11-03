#!/usr/bin/env node
/**
 * commit message 关键字门禁（Gitea issue #128）。
 *
 * ## 它挡的是哪一类事故
 *
 * 本仓有两个远端：`origin`（Gitea，权威）与 `github`（镜像）。两仓的工单编号是**两套独立序列**，
 * 而 commit 会经镜像传播到 GitHub 那个编号空间里 ⇒ commit message 里的 GitHub/Gitea 关闭关键字
 * 会在**另一个仓**的编号上生效。实测已发生：
 *
 *   `e1fd49e feat: add long session context summary (closes #3)`
 *     · `#3` 指的是 Gitea #3「长会话上下文能力」——实现做的就是这件事；
 *     · 该 commit 进了 `refs/remotes/github/main` ⇒ GitHub 按关键字把它自己的 #3
 *       「好东西，但是功能方面可以优化」判为 `closed this as completed in e1fd49e`，
 *       而那条反馈从未被实现。
 *
 * 近 40 条 commit 引用工单的形式是裸 `#121`（例：`d5ca3a8`），不带关键字，因此谁都触发不了；
 * `e1fd49e` 是这个约定里唯一的例外，也是唯一出事的。⇒ 约定没错，漏的是「关键字」这一族。
 *
 * ## 判据
 *
 * 命中 `\b(closes|fixes|resolves|fix|closed)\s+#\d+`（大小写不敏感）⇒ 退出码非 0，并**原样打印命中的那一行**。
 * 裸 `#N` 不在判据里，那是本仓的正确写法。
 *
 * ## 三条口径（都是本仓为「静默失效」付过学费的地方，见 docs/gitea-workflow.md §6）
 *
 * 1. **范围判据，不是末条 commit**：`--range` 扫范围内**每一条** commit。本仓有 cherry-pick 进
 *    main 的历史（§4 讨论过「cherry-pick 进去的分支不是 main 的祖先」），只查 HEAD 会漏。
 * 2. **历史条目不可变**：闸只管新提交，绝不去改写 `e1fd49e` 或任何历史。跑全量历史只会看到它，
 *    看到的是事实，不是要修的东西——所以 `check:loop` 用的是 `origin/main..HEAD`。
 * 3. **闸必须可证伪**：`--self-test` 四条注入断言——① 含 `closes #999` 的样例必须**退出码 1 且打出原因那句
 *    与原样的命中行**；② 合法样例（裸 `#999`）必须**退出码 0**，否则判据过宽、人会绕过它；
 *    ③ 范围路径跑不通时必须是 `2` 不是 `1`（坏掉的闸不许伪装成违规）；④ 命中刻意构造在范围的
 *    **非末条** commit 上 ⇒ 「只查末条」的实现会判绿、这条当场红。
 *    四条都跑**真 CLI 子进程**、读它自己的 stdout 与退出码——不是调用方自己判一下正则。
 *    「锚点写错的字符串替换是空操作 ⇒ 门禁静默不红」是本仓实测过的坑（§6），所以自证必须是子进程级。
 *
 * ## 用法与退出码契约
 *
 * ```bash
 * node scripts/commit-msg-gate.mjs --message "<text>"        # 校验一段文本
 * node scripts/commit-msg-gate.mjs --range origin/main..HEAD  # 校验范围内每一条 commit
 * node scripts/commit-msg-gate.mjs --self-test                # 自证这道闸是活的
 * ```
 *
 * `0` = 干净；`1` = 命中关键字；`2` = 用法/环境错误（缺参数、range 解析不了、不在 git 仓库里）。
 * ⇒ `1` 与 `2` 分开：闸「坏了」不许伪装成「违规了」，反之亦然。
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 判据本体。改这里之前先想清楚：`--self-test` 的注入样例必须仍然能命中它。 */
export const KEYWORD_RE = /\b(closes|fixes|resolves|fix|closed)\s+#\d+/i;

/**
 * 扫一段文本，返回每一个命中行。
 *
 * 纯逻辑、无 IO、无 git：这是为了 `--self-test` 之外也能被别的脚本直接 import 断言。
 * @param {string} text commit message 全文（可多行）
 * @param {string} source 命中行的来源标签，仅用于打印
 * @returns {Array<{source: string, lineNo: number, line: string, match: string}>}
 */
export function findKeywordHits(text, source = 'message') {
  const hits = [];
  if (typeof text !== 'string') return hits;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = KEYWORD_RE.exec(lines[i]);
    if (m) hits.push({ source, lineNo: i + 1, line: lines[i], match: m[0] });
  }
  return hits;
}

/**
 * 把命中渲染成打印行。首行**原样带上命中的那一行**（验收要求「打印命中的那一行」）。
 * @param {Array<{source: string, lineNo: number, line: string, match: string}>} hits
 * @param {string} origin 扫描对象（`--message` / `--range <r>` / `<短 hash>`）
 * @returns {string[]}
 */
export function renderHits(hits, origin) {
  const out = [];
  out.push(
    `✗ [commit-msg-gate] ${origin} 命中关键字引用 ${hits.length} 处 —— 命中判据：${KEYWORD_RE.source}`,
  );
  for (const h of hits) {
    out.push(`  ${h.source}:${h.lineNo}: ${h.line}`);
  }
  out.push('  ⇒ 本仓 commit 会经 GitHub 镜像传播，关键字会在**另一个编号序列**上触发自动关闭（Gitea #128，实测 e1fd49e 误关 GitHub #3）。');
  out.push('  ⇒ 改法：引用工单写裸 `#N`；要表达「已完成」写 `Gitea #N` 明文 + 在 issue 里留一条带 commit 短链的评论（评论才是关联的权威点，commit 不是）。');
  return out;
}

/**
 * 读取一段 commit message 文本（--message 入口的取文逻辑）。
 * @param {string[]} argv
 * @returns {string | null} null = 缺参数
 */
function readMessageArg(argv) {
  const i = argv.indexOf('--message');
  if (i === -1) return null;
  const v = argv[i + 1];
  return typeof v === 'string' ? v : '';
}

/**
 * 取范围内每一条 commit 的完整 message。
 * @param {string} range git 修订范围，例 `origin/main..HEAD`
 * @returns {Array<{hash: string, subject: string, body: string}>}
 */
export function commitsInRange(range) {
  const sep = '\x1e';
  const field = '\x1f';
  const r = spawnSync('git', ['log', '--format=%h' + field + '%s' + field + '%b' + sep, range], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n')[0] || `git log 退出码 ${r.status}`;
    const e = new Error(`无法扫描范围 ${range}：${msg}`);
    // @ts-ignore
    e.usageError = true;
    throw e;
  }
  return r.stdout
    .split(sep)
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim() !== '')
    .map((rec) => {
      const [hash, subject = '', body = ''] = rec.split(field);
      return { hash, subject, body };
    });
}

// ── 入口：扫描 ────────────────────────────────────────────────────────────────

/**
 * 跑一次扫描并打印。返回退出码。
 * @param {string[]} argv
 * @param {(s: string) => void} print
 * @returns {number}
 */
export function run(argv, print = (s) => console.log(s)) {
  const msg = readMessageArg(argv);
  if (msg !== null) {
    const hits = findKeywordHits(msg, '--message');
    if (hits.length > 0) {
      for (const l of renderHits(hits, '--message')) print(l);
      return 1;
    }
    print(`✅ commit-msg-gate: --message 无关键字引用（${msg.split(/\r?\n/).length} 行）`);
    return 0;
  }

  const ri = argv.indexOf('--range');
  if (ri !== -1) {
    const range = argv[ri + 1];
    if (typeof range !== 'string' || range === '') {
      print('❌ commit-msg-gate: --range 需要一个参数，例 `--range origin/main..HEAD`');
      return 2;
    }
    /** @type {Array<{hash: string, subject: string, body: string}>} */
    let commits;
    try {
      commits = commitsInRange(range);
    } catch (e) {
      print(`❌ commit-msg-gate: ${(e && e.message) || e}`);
      return 2;
    }
    const all = [];
    for (const c of commits) {
      const full = `${c.subject}\n${c.body}`;
      all.push(...findKeywordHits(full, c.hash));
    }
    if (all.length > 0) {
      for (const l of renderHits(all, `--range ${range}`)) print(l);
      print(`  （共扫 ${commits.length} 条 commit）`);
      return 1;
    }
    if (commits.length === 0) {
      // 空范围是真·无内容可扫，不是闸没跑——必须说出来，否则「绿」会被误读成「扫过了」。
      print(`✅ commit-msg-gate: 范围 ${range} 内 0 条 commit（空范围，无可扫）`);
      return 0;
    }
    print(`✅ commit-msg-gate: 范围 ${range} 内 ${commits.length} 条 commit 均无关键字引用`);
    return 0;
  }

  print('用法: node scripts/commit-msg-gate.mjs --message "<text>" | --range <git 范围> | --self-test');
  return 2;
}

// ── 入口：自证 ────────────────────────────────────────────────────────────────

/**
 * 起一个真 CLI 子进程跑**本文件**，读它自己的 stdout 与退出码。
 * 用子进程而不是直接调用函数：只有这样才能证明「退出码非 0 + 打出原因那句」这条链路是活的，
 * 而不只是正则活得很好。路径固定取 `import.meta.url`（本文件自身）：被别的脚本 import 时
 * `process.argv[1]` 是那个调用方，拿它起子进程就自证错对象了；突变实验在副本上跑也才跑得对。
 * @param {string[]} cliArgs
 */
function runCli(cliArgs) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [self, ...cliArgs], { encoding: 'utf8' });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    spawnError: r.error ? String(r.error.message) : null,
  };
}

/**
 * `--self-test`：四条注入断言，证明这道闸**该红的时候红、该绿的时候绿、且扫的是范围不是末条**。
 * 每条都跑真 CLI 子进程。任一失败 ⇒ 退出码 1（=「这道闸是瞎的，不许合」）。
 * @param {(s: string) => void} print
 * @returns {number}
 */
export function selfTest(print = (s) => console.log(s)) {
  const results = [];
  const push = (name, ok, detail) => {
    results.push({ name, ok, detail });
    print(`${ok ? '✓' : '✗'} [self-test] ${name}`);
    for (const d of detail) print(`      ${d}`);
  };

  // 注入 1：违规样例。判据 = 退出码必须是 1（不是 2、不是 0），且子进程**自己打出的 stdout** 里
  // 有那句原因、有原样的命中行。断言只读子进程输出，不读 spawn 的错误信息（那会把参数回显成假阳性）。
  const bad = 'feat: add X (closes #999)';
  const rBad = runCli(['--message', bad]);
  const badOk =
    rBad.status === 1 &&
    rBad.out.includes('命中关键字引用') &&
    rBad.out.includes(bad);
  push('注入违规样例 ⇒ 退出码 1 且打出原因那句 + 命中行原文', badOk, [
    `样例：${bad}`,
    `退出码：${rBad.status}${rBad.spawnError ? `（spawn 失败：${rBad.spawnError}）` : ''}`,
    '子进程输出：',
    ...rBad.out.split('\n').filter((l) => l !== '').map((l) => `| ${l}`),
  ]);

  // 注入 2：合法样例（裸 #999，本仓的正确写法）。它必须过——否则判据过宽，
  // 「谁都被拦」的闸同样是一条都拦不住：人会绕过它，等于没有闸。
  const good = 'fix(projection): #999 加一道裸编号引用的闸';
  const rGood = runCli(['--message', good]);
  const goodOk = rGood.status === 0;
  push('注入合法样例（裸 #999，无关键字）⇒ 退出码 0', goodOk, [
    `样例：${good}`,
    `退出码：${rGood.status}`,
    ...rGood.out.split('\n').filter((l) => l !== '').map((l) => `| ${l}`),
  ]);

  // 注入 3：范围路径也必须是活的，且用法错误得是 2 而不是 1（坏掉的闸不许伪装成违规）。
  // 环境不满足（不在 git 仓库里）时如实标 NOT-COVERED，不写成通过（docs §5 的三态口径）。
  const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
  if (inRepo) {
    const rRange = runCli(['--range', 'selftest-definitely-not-a-ref..HEAD']);
    const rangeOk = rRange.status === 2;
    push('范围路径可跑通且 range 解析不了时退出码 2（用法错误 ≠ 违规）', rangeOk, [
      '样例：--range selftest-definitely-not-a-ref..HEAD',
      `退出码：${rRange.status}`,
      ...rRange.out.split('\n').filter((l) => l !== '').map((l) => `| ${l}`),
    ]);
  } else {
    push('NOT-COVERED：不在 git 仓库里，范围路径这条断言没跑到', false, ['补齐前置：在一个 git 工作区内执行 --self-test']);
  }

  // 注入 4：范围路径必须**扫全部 commit**，不是只查末条。本仓有 cherry-pick 进 main 的历史
  // （docs/gitea-workflow.md §4：「cherry-pick 进去的分支不是 main 的祖先」），只查 HEAD 会漏。
  // 构造：以历史事故 `e1fd49e` 为命中点，沿子孙链找**第一条干净的** commit 当范围右端 ⇒
  // 命中必定**不在**末条 ⇒ 「只查末条」的实现会判绿，这条断言当场红。
  // 依赖仓库历史 ⇒ 找不到合适样本时如实标 NOT-COVERED，不写成通过（§5 的三态口径）。
  const probe = spawnSync('git', ['rev-list', '--ancestry-path', 'e1fd49e..HEAD'], { encoding: 'utf8' });
  const descendants = probe.status === 0
    ? (probe.stdout || '').trim().split('\n').filter((l) => l !== '').reverse()
    : [];
  let cleanTip = null;
  for (const h of descendants) {
    const one = spawnSync('git', ['log', '-1', '--format=%B', h], { encoding: 'utf8' });
    if (one.status !== 0) continue;
    if (findKeywordHits(`${one.stdout}`, h).length === 0) {
      // 用 git 自己的短 hash，保证它和 --range 输出里 `%h` 打出来的形态一致（长度会随仓库变）
      const short = spawnSync('git', ['rev-parse', '--short', h], { encoding: 'utf8' });
      if (short.status !== 0) continue;
      cleanTip = (short.stdout || '').trim();
      break;
    }
  }
  if (cleanTip) {
    const rRange = runCli(['--range', `e1fd49e~1..${cleanTip}`]);
    const scanned = Number((rRange.out.match(/共扫 (\d+) 条 commit/) || [])[1] ?? 0);
    // 只看**命中列表那几行**（`  <hash>:<n>: <原文>`）——标题行本身带着范围字符串，
    // 拿整段输出做 includes 会把「范围里含这个短 hash」误读成「它被命中了」。
    const reported = [...rRange.out.matchAll(/^ {2}([0-9a-f]+):\d+: /gm)].map((m) => m[1]);
    const rangeOk =
      rRange.status === 1 &&
      rRange.out.includes('closes #3') &&
      scanned >= 2 &&
      !reported.includes(cleanTip); // 末条是干净的 ⇒ 它不该出现在命中列表里
    push('范围路径扫**全部** commit（命中刻意不在末条）⇒ 只查末条的实现会判绿，这里必须红', rangeOk, [
      `样例：--range e1fd49e~1..${cleanTip}（右端是干净的子孙，命中在它之前）`,
      `退出码：${rRange.status}｜解析到的扫描条数：${scanned}｜命中列表：${reported.join(', ') || '(空)'}｜末条 ${cleanTip} 是否被误报：${reported.includes(cleanTip)}`,
      ...rRange.out.split('\n').filter((l) => l !== '').map((l) => `| ${l}`),
    ]);
  } else {
    push('NOT-COVERED：本仓库历史里找不到「e1fd49e 之后第一条干净的子孙」，范围完整性这条断言没跑到', false, [
      '补齐前置：在 dsh-suggest-ghost 的工作区内执行 --self-test',
    ]);
  }

  const failed = results.filter((r) => !r.ok);
  print('');
  if (failed.length > 0) {
    print(`❌ commit-msg-gate --self-test: ${failed.length}/${results.length} 条注入断言失败 ⇒ 这道闸是瞎的，**不许合**。`);
    return 1;
  }
  print(`✅ commit-msg-gate --self-test: ${results.length} 条注入断言全过 ⇒ 这道闸是活的（判据 ${KEYWORD_RE.source}）。`);
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  process.exit(run(argv));
}
