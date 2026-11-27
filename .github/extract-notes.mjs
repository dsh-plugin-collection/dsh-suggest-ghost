#!/usr/bin/env node
/**
 * 生成 GitHub Release 正文，**对齐 dsh-later 的写法**。骨架不是想象出来的，是从
 * dsh-later v1.2.0 / v1.3.0 / v1.4.0 三条已发布 Release 里提出来的：
 *
 *   <package.json 的 description>
 *   ## 安装                     dsh plugin --profile web add <name> + 重启提示
 *   预构建产物随包发布，npm 安装无需本地构建或构建授权。
 *   ## 功能                     跨版本累积的全量能力清单
 *   ## 本版本变更               ### feat / ### fix / ### refactor / …
 *   ## 说明                     License / 仓库 / 完整更新日志 三条
 *
 * 三条来自实测的规则：
 *
 * 1. 「## 功能」优先取**上一条 Release 的同名小节** —— later 的清单就是这样单调累积的
 *    （1.3.0 十条 → 1.4.0 十一条，一条没删），取不到才退回 README 的特性小节。
 *    注意排除"本次这个版本自己"，否则重跑同一条 Release 会把自己的正文当历史累积。
 * 2. 「## 本版本变更」的条数是**取舍**，不由脚本替你决定。约定：在版本小节里写
 *    `### 发布摘要` 子节，脚本只用它、且不改写文字；没有该子节时全量收录并打告警。
 *    参照：later 的 Release 是 3~7 条 / 2.2~2.5k 字，而其 CHANGELOG 条目本身是带嵌套
 *    子条目的长论证 —— 说明 Release 是人工压过的。脚本按 `：` 或首句机械压缩会**压坏
 *    句子**（实测把 `声明 \`pulse: true\`` 从代码段中间切开），所以这里不做任何改写。
 * 3. 版本小节缺失时不许静默出空正文：默认打一条显式警告进正文，`--strict` 直接失败。
 *
 * 支持的 CHANGELOG 约定（三个仓库各一种）：
 *   ## 未发布           +  ## 1.3.0 — 2026-10-10      (dsh-later)
 *   ## [Unreleased]     +  ## [0.5.0] - 2026-10-10    (dsh-suggest-ghost)
 *   ## 未发布           +  ## 0.2.0-rc.2-fork1        (dsh-group-status，无日期)
 *
 * 用法：node .github/extract-notes.mjs <version> [--strict] [--full]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// 顺序要紧：`## 功能摘要` 是给 Release 用的**精简版**（5 条一行式），
// `## 特性一览` 是 README 的完整清单（10~15 条带说明）。有前者就只发前者 ——
// 一条 Release 不需要把整份能力表抄一遍。
const DIGEST_HEADINGS = ['## 功能摘要', '## Feature digest'];

/** 「欢迎外部贡献」的小节：内容原样搬进正文末尾的 `## 致谢`，不参与变更分类。 */
const THANKS_HEADINGS = ['致谢', '感谢', 'Thanks', 'Acknowledgements', 'Acknowledgments'];
const FEATURE_HEADINGS = [...DIGEST_HEADINGS, '## 功能', '## 特性一览', '## Features'];
/** 分组顺序照 later：feat / fix 在前，表外的类型排最后并按名字排序。 */
// breaking 放最前：它是用户最需要先看到的；其余照 later 的习惯 feat/fix 在前。
const TYPE_ORDER = ['breaking', 'feat', 'fix', 'refactor', 'perf', 'a11y', 'docs', 'test', 'chore', 'build', 'ci', 'style', 'i18n'];


/**
 * 类型 → Release 正文的标题（照 DSH 的中文分类）。
 *
 * DSH 用「新增功能 / 体验优化 / 问题修复」三档，但它是产品级；插件用更细的
 * 类型更诚实（perf 归到「性能」而不是笼统的「体验优化」）。没列的类型直接用
 * 类型名，不硬套。
 */
const CHANGELOG_HEADING = {
  breaking: '不兼容变更',
  feat: '新增',
  fix: '修复',
  perf: '性能',
  refactor: '重构',
  a11y: '无障碍',
  docs: '文档',
  test: '测试',
  chore: '其他',
  build: '构建',
  ci: 'CI',
  i18n: '多语言',
};

const [rawVer, ...flags] = process.argv.slice(2);
const ver = String(rawVer || '').replace(/^v/, '');
if (!ver) {
  console.error('用法：extract-notes.mjs <version> [--strict] [--legacy] [--full]');
  process.exit(2);
}

/**
 * 正文形态。默认 `dsh`：只写这一版改了什么 + compare 链接，**不带功能清单**。
 *
 * 照的是 @deepseek-ai/dsh 自己的 Release（实测 0.2.2-rc.5 的常规 rc 正文只有 461 B）：
 * 分类标题 + 每条一句 + `Full Changelog: .../compare/<prev>...<new>`。
 * `--legacy` 保留旧的四节骨架（安装 / 功能 / 本版本变更 / 说明），供需要时回退。
 */
/**
 * DSH 形态的一条：**只留标题**，把 `标题：解释` 里的解释砍掉。
 *
 * `releaseLine` 产出的是 `**标题**：首句`，那是给「四节骨架」用的（那里需要一点
 * 说明才不至于像清单）。DSH 的正文一条一句、后缀 compare 链接，解释反而是噪音。
 *
 * 只在**标题已经是完整句**时才砍：若标题本身过短（< 12 字）而解释里带着关键信息，
 * 保留首句 —— 否则会得到「**跨内核**」这种什么也没说的条目。
 */
function shortLine(text) {
  // releaseLine 的产出形如 `- **标题**：首句`（前缀 `- ` 已经在里面），先摘掉
  const m = /^-\s+\*\*([^*]+)\*\*(.*)$/.exec(text);
  if (!m) return text;

  const title = m[1].trim();
  const rest = (m[2] ?? '').replace(/^[：:]\s*/, '').trim();

  // 标题够长就单独成条；太短则保留解释的首句 —— 否则会得到「**跨内核**」这种
  // 什么也没说的条目（判据 12 字，取自 later 各版条目标题的分布）
  let out;
  if (!rest || title.length >= 12) {
    out = `**${title}**`;
  } else {
    const cut = rest.search(/[，；。]/);
    const first = (cut > 0 ? rest.slice(0, cut) : rest).trim();
    out = first ? `**${title}**：${first}` : `**${title}**`;
  }
  return `- ${out}`;
}

const MODE = flags.includes('--legacy') ? 'legacy' : 'dsh';

/* ─────────── CHANGELOG 解析 ─────────── */

/** 节 = 一行 `## xxx` 到下一条 `## xxx`。`###` 是节内小节，不能当节边界。 */
function sections(md) {
  const lines = md.split('\n');
  const heads = [];
  lines.forEach((l, i) => {
    const h = /^##[ \t]+(?!#)(.*)$/.exec(l);
    if (h) heads.push({ title: h[1], start: i + 1 });
  });
  return heads.map((hd, k) => ({
    title: hd.title,
    lines: lines.slice(hd.start, k + 1 < heads.length ? heads[k + 1].start - 1 : lines.length),
  }));
}

/**
 * 每条顶层条目属于哪个 `###` 小节（序号 → 小节标题）。
 *
 * 三种 CHANGELOG 约定里，只有 later / group-status 把类型写进条目（`- **feat** …`）：
 * dsh-suggest-ghost 用的是 Keep a Changelog 的做法 —— 类型写在 `### 新增 / ### 修复`
 * 这类小节标题上，条目本身是裸的。不认小节就会把整版条目全归进 `other`。
 */
function subheadMap(lines) {
  const map = new Map();
  let cur = null;
  let top = -1;
  for (const l of lines) {
    const h = /^###[ \t]+(.*)$/.exec(l);
    if (h) {
      cur = h[1].trim();
      continue;
    }
    if (/^- /.test(l)) {
      top += 1;
      map.set(top, cur);
    }
  }
  return map;
}

/** `### 新增` / `### 修复` → 类型名。认不出的标题不给映射（会落到 other）。 */
const SUBHEAD_STEMS = {
  新增: 'feat', 功能: 'feat', 新功能: 'feat', 特性: 'feat', Added: 'feat',
  修复: 'fix', 修正: 'fix', 问题修复: 'fix', Fixed: 'fix',
  优化: 'perf', 性能: 'perf', 体验优化: 'perf',
  重构: 'refactor', Changed: 'refactor', 变更: 'refactor',
  文档: 'docs', 测试: 'test', 其他: 'chore', 杂项: 'chore',
  不兼容变更: 'breaking', 移除: 'breaking', Removed: 'breaking',
};

function typeOfSubhead(head) {
  if (!head) return null;
  const key = head.replace(/^[^\p{L}]*/u, '').trim();
  return SUBHEAD_STEMS[key] ?? null;
}

/**
 * 取标题开头的版本 token，剥掉可能的外层方括号：
 *   `1.3.0 — 2026-10-10` → 1.3.0     `[0.5.0] - 2026-10-10` → 0.5.0
 *   `0.2.0-rc.2-fork1` → 原样保留（所以裸 0.2.0 不会误命中它）
 */
function versionOf(title) {
  const m = /^\s*\[?\s*([^\s\]—–]+)/.exec(title);
  return m ? m[1] : null;
}

/** 把一段行切成顶层条目（`- …` 连带其后缩进续行；`###` 与空行不切断条目）。 */
function items(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^- /.test(l)) {
      if (cur) out.push(cur.join('\n'));
      cur = [l];
    } else if (cur && (/^\s+\S/.test(l) || l.trim() === '')) {
      cur.push(l);
    } else if (cur) {
      out.push(cur.join('\n'));
      cur = null;
    }
  }
  if (cur) out.push(cur.join('\n'));
  return out.map((t) => t.replace(/\s+$/, ''));
}

const typeOf = (item, subhead = null) => {
  // 类型名允许数字（a11y / i18n），也允许 Conventional Commits 的 scope 写法：
  // `feat(kernel)` 取基础类型 feat —— 否则整条落进 other（dsh-later 1.11.0 就发生过）。
  const m = /^-\s+\*\*([a-zA-Z0-9]+)(?:\(([a-zA-Z0-9-]+)\))?\*\*/.exec(item);
  if (m) return m[1].toLowerCase();
  // 裸条目：类型在小节标题里（Keep a Changelog 约定，suggest-ghost 就是这种）
  return typeOfSubhead(subhead) ?? 'other';
};

/** 只去掉 `- **feat** ` 这个类型前缀，其余文字一字不改。 */
const stripType = (item) => item.replace(/^-\s+\*\*[a-zA-Z0-9]+(?:\([a-zA-Z0-9-]+\))?\*\*\s*/, '- ');

/**
 * 把一条 CHANGELOG 条目收成 Release 里的一行：**取条目自带结构里的 `标题：首句`，
 * 丢弃嵌套子条目**。不改写、不换词，只是不搬运论证部分。
 *
 * 为什么这么做（实测出来的）：later 的 CHANGELOG 条目本身就是 `- **type** 标题：一句话`
 * （约 120 字），而 group-status 的条目是带 5 个嵌套子条的 459 字论证 —— Release 只是
 * 忠实继承了源头的密度。拿这条规则回测 later 的 1.3.0：生成的 7 条与他们**已发布**的 7 条
 * 几乎逐条对应（4 条一致，3 条他们只是手工把标题再缩几字、并把两条调了序）。
 *
 * 安全边界：只在**全角** `：` 与 `。` 处切；若冒号前有奇数个反引号，说明它落在代码段里
 * （如 `pulse: true` 用的是半角冒号，或全角冒号写在 code span 内），不切 —— 上一版我按
 * 半角 `:` 切并在外面重建加粗，把句子压坏了，已撤销。
 */
function releaseLine(item) {
  // 先把条目**自己的段落**拼起来：CHANGELOG 里的条目常常折行（续行缩进两格），
  // 只取首行会把句子从中间切断 —— dsh-later 1.8.0 的 breaking 条就断在「…的」，
  // 发布出去成了一条读不通的句子。嵌套子条目（缩进的 `- ` 论证）仍然丢弃。
  // 首行 + 其后的折行续行；**遇到第一个嵌套子条目（缩进的 `- `）就停** ——
  // 子条目连同它自己的续行都是论证，不进 Release。
  const paraLines = [];
  for (const l of item.split('\n')) {
    if (/^\s+-\s/.test(l)) break;
    paraLines.push(l);
  }
  // 折行拼接：中文与中文之间不插空格（否则「…的 类型面…」这种断裂式空格会进 Release），
  // 其余情况按空格拼。
  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  const para = paraLines.map((l) => l.trim()).filter(Boolean).reduce((acc, cur) => {
    if (!acc) return cur;
    // 边界字符要跳过强调/代码符号：续行常以 `**` 开头，直接比会误判成"非中文"
    const a = acc.replace(/[*_~`]+$/, '').slice(-1);
    const b = cur.replace(/^[*_~`]+/, '')[0] ?? '';
    return acc + (CJK.test(a) && CJK.test(b) ? '' : ' ') + cur;
  }, '');
  const line = para
    .replace(/^-\s+(?:\*\*[a-zA-Z0-9]+(?:\([a-zA-Z0-9-]+\))?\*\*\s*)?/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const inCode = (t, i) => ((t.slice(0, i).match(/`/g) ?? []).length) % 2 === 1;

  const ci = line.indexOf('：');
  const pi = line.indexOf('。');
  let head;
  let rest = '';
  if (ci > 0 && ci <= 70 && !inCode(line, ci)) {
    head = line.slice(0, ci);
    rest = line.slice(ci + 1);
  } else if (pi > 0) {
    head = line.slice(0, pi);
  } else {
    head = line;
  }

  let expl = '';
  if (rest.trim()) {
    const k = rest.indexOf('。');
    expl = (k >= 0 ? rest.slice(0, k + 1) : rest).trim();
    // 解释句太长时优先在第一处分句处收住：group-status 自己的 Release 平均条目 95 字，
    // 我们照搬 CHANGELOG 会把平均拉到 130+ 且更多条目撞上 240 字截断。
    if (expl.length > 120) {
      const m2 = expl.search(/[，；]/);
      if (m2 > 40) expl = expl.slice(0, m2 + 1);
    }
  }
  // 标题里若已有 `**`（如 `跨插件状态改为**协议**：…`），整段再加粗会产出
  // `**…****…**` 这种断掉的加粗。剥掉标题内部的重音符后再整体加粗——词一字不改。
  const headPlain = head.replaceAll('*'.repeat(2), '').trim();
  let out = head ? `**${headPlain}**${expl ? `：${expl}` : ''}` : `- ${line}`;
  if (out.length > 240) {
    let t = out.slice(0, 240);
    // 括号感知：截断点若落在没闭合的「（」里，回溯到那个括号之前再收尾 ——
    // 否则会产出「（搜索 wire 常量、拖拽状态机、…」这种半截括号。
    const open = t.lastIndexOf('（');
    if (open > 60 && (t.slice(open).match(/（/g) ?? []).length > (t.slice(open).match(/）/g) ?? []).length) {
      t = t.slice(0, open);
    }
    const at = Math.max(t.lastIndexOf('、'), t.lastIndexOf('，'), t.lastIndexOf('）'));
    out = (at > 90 ? t.slice(0, at + 1) : t).replace(/[、，]$/, '') + '…';
  }
  return '- ' + out;
}

/* ─────────── 素材 ─────────── */

let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
} catch { /* 没有 package.json 就少几行固定文案 */ }

let sectionLines = null;
try {
  const hit = sections(fs.readFileSync('CHANGELOG.md', 'utf8')).find((s) => versionOf(s.title) === ver);
  sectionLines = hit ? hit.lines : null;
} catch {
  sectionLines = null;
}

let missingSection = false;
if (sectionLines === null) {
  if (flags.includes('--strict')) {
    console.error(`CHANGELOG 里没有 ${ver} 小节 —— 发版要先跑：rel.mjs rename ${ver}`);
    process.exit(2);
  }
  // 占位文字**不能**塞进 sectionLines：下面按 `^- ` 取条目会把它过滤掉，正文就只剩
  // 「本版无条目」—— 最该喊的地方反而不喊。单独记一个标记。
  missingSection = true;
  sectionLines = [];
}

/** 上一条 Release 的「## 功能」小节（排除本次自己，避免自我吞并）。 */
function previousReleaseFeatures(currentVersion) {
  const gh = (args) =>
    // 必须带超时：把取历史 tag 改成 gh api 之后，遇到不可达/虚构的 github remote
    // 会无限等网络（测试里就挂死过整轮）。8s 足够正常情况，且失败会被上层 catch。
    execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 24,
      timeout: 8000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
  try {
    // 取历史 tag 用 API 而不是 `gh release list --json`：本机这版 gh 的 release list
    // 不支持 --json，会抛错 → 被 catch 吞掉 → 静默退化到 README 的特性小节（少继承几条）。
    // 实测后果：dsh-later 1.5.0 第一次生成时功能清单只有 8 条，而 v1.4.0 那条有 11 条。
    let tags;
    try {
      tags = JSON.parse(gh(['api', 'repos/{owner}/{repo}/releases?per_page=20', '--jq',
        '[.[].tag_name]'])).map(String);
    } catch {
      tags = gh(['release', 'list', '--limit', '20']).split('\n')
        .map((l) => (l.match(/^\S+\s+\S*\s*(v[0-9][^\s]*)/) ?? [])[1])
        .filter(Boolean);
    }
    const prev = tags.map((t) => String(t).replace(/^v/, '')).find((t) => t && t !== currentVersion);
    if (!prev) return [];
    const body = gh(['release', 'view', 'v' + prev, '--json', 'body', '--jq', '.body']);
    const lines = body.split('\n');
    const start = lines.findIndex((l) => /^##\s+功能\s*$/.test(l.trim()));
    if (start < 0) return [];
    const res = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{2,3} /.test(lines[i])) break;
      if (/^- /.test(lines[i])) res.push(lines[i]);
    }
    return res;
  } catch (e) {
    process.stderr.write(`· 取不到上一条 Release 的功能清单（${String(e.message).split('\n')[0]}），退化到 README\n`);
    return [];
  }
}

/** README 的特性小节（上一条 Release 取不到时兜底）。 */
function readmeFeatures() {
  for (const f of ['README.md', 'README.en.md']) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const start = lines.findIndex((l) => FEATURE_HEADINGS.some((h) => l.trim().startsWith(h)));
    if (start < 0) continue;
    const out = [];
    let prose = null; // 没有 bullet、直接写成一整段的摘要（「一行」形态）
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{2,3} /.test(lines[i])) break;
      // 顶层条目，以及**它下面的缩进续行 / 子项** —— 只收顶层会把「两档都成立：」
      // 这类带子项的文字留成一个悬空冒号（dsh-later 就这样错了好几版）。
      if (/^- /.test(lines[i])) out.push(lines[i]);
      else if (/^\s+- /.test(lines[i]) && out.length) out.push(lines[i]);
      else if (/^\s+\S/.test(lines[i]) && out.length) out.push(lines[i]);
      else if (lines[i].trim() && !prose) prose = lines[i].trim();
    }
    // 一段散文形态的摘要（不含 bullet）：整段照用，**不再压缩**
    if (!out.length && prose) {
      return { lines: [prose], heading: lines[start].trim(), digest: true };
    }
    if (out.length) return { lines: out, heading: lines[start].trim(), digest: DIGEST_HEADINGS.some((h) => lines[start].trim().startsWith(h)) };
  }
  return { lines: [], heading: null, digest: false };
}

/* ─────────── 本版本变更的取材 ─────────── */

/**
 * 从本版小节里抽出 `### 致谢` 那一段（内容原样保留，含 bullet/散文）。
 * 它不进变更分类：署名不是"改了什么"，压成一条 ``- **@xxx**`` 就只剩链接。
 */
function thanksBlock(lines) {
  const start = lines.findIndex((l) => {
    const h = /^###[ \t]+(.*)$/.exec(l);
    return h && THANKS_HEADINGS.includes(h[1].trim().replace(/[：:].*$/, '').trim());
  });
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const body = out.join('\n').trim();
  if (!body) return '';
  return body.startsWith('- ') ? body : body;
}

const thanks = thanksBlock(sectionLines);
let changeItems = items(sectionLines).filter((t) => /^-\s/.test(t));
// `### 致谢` 里的条目不是变更，从分类素材里剔掉
if (thanks) {
  changeItems = changeItems.filter((t) => !thanks.split('\n\n').some((p) => p.includes(t.slice(0, 24).trim())));
}

const subheadOfEntry = subheadMap(sectionLines);
// `### 发布摘要` 子节是给人做的取舍：有就只用它，且不改写一个字。
const summaryIdx = sectionLines.findIndex((l) => /^###\s+发布摘要\s*$/.test(l));
if (summaryIdx >= 0) {
  const block = [];
  for (let i = summaryIdx + 1; i < sectionLines.length; i++) {
    if (/^#{2,4}\s/.test(sectionLines[i])) break;
    block.push(sectionLines[i]);
  }
  const picked = items(block).filter((t) => /^-\s/.test(t));
  if (picked.length) {
    changeItems = picked;
    process.stderr.write(`· 「## 本版本变更」取自「### 发布摘要」子节：${picked.length} 条（未改写文字）。\n`);
  }
} else if (changeItems.length > 10) {
  process.stderr.write(
    `⚠ 没有「### 发布摘要」子节，Release 将收录全部 ${changeItems.length} 条 CHANGELOG 条目。\n` +
      `  同组织参照：later 的 Release 是 3~7 条 / 2.2~2.5k 字。要压到那个密度，请在本版本小节\n` +
      `  里加「### 发布摘要」并写入选要的条目 —— 脚本不替你删，也不改写句子（机械压缩实测会\n` +
      '  把「声明 pulse: true」这类写法从代码段中间切开）。\n',
  );
}

const groups = new Map();
for (let idx = 0; idx < changeItems.length; idx++) {
  const it = changeItems[idx];
  const k = typeOf(it, subheadOfEntry.get(idx) ?? null);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(flags.includes('--full') ? stripType(it) : releaseLine(it));
}
const orderedTypes = [
  ...TYPE_ORDER.filter((t) => groups.has(t)),
  ...[...groups.keys()].filter((t) => !TYPE_ORDER.includes(t)).sort(),
];

/* ─────────── 功能清单 ─────────── */

/**
 * 把 README 的特性条目压成**一行摘要**（2026-11-26 折中方案）。
 *
 * 背景：功能清单曾是「每版都抄一遍完整描述」，于是 later 的正文里 `## 功能`
 * 占到 17 行 / 2.6 KB，比「本版本变更」还长；而它讲的是这个插件一直能做什么，
 * 与这一版无关。另一头彻底删掉又会让人点进来只看到增量、看不到产品。
 *
 * 折中：**标题全留、说明砍到一句话**（截在第一个句读或 MAX_TAIL 字），子项全部丢掉
 * （子项是 README 的详细说明，Release 里不需要）。README 保持完整，正文只做索引。
 */

function condenseFeature(line) {
  // `- **标题**：说明…` / `- **标题**` / `- 裸标题：说明…`
  const m = /^-\s+\*\*([^*]+)\*\*\s*[：:]?\s*(.*)$/.exec(line);
  if (!m) {
    const plain = line.replace(/^-\s+/, '').trim();
    return `- ${truncTail(plain)}`;
  }
  const title = m[1].trim();
  const tail = truncTail(m[2] ?? '');
  return tail ? `- **${title}**：${tail}` : `- **${title}**`;
}

/**
 * 说明截到一句话。
 *
 * 三条约束（都是实测踩出来的）：
 *   1. **优先在句读处切**（`，` `；` `。` `（`），但最多 48 字 —— 再长就截；
 *   2. **绝不切在代码段或加粗标记中间**：`从 \`0.1.2-rc.1\` 到 \`0.2.…\`` 这种
 *      半个版本号比不截还糟（beta 正文第一版就这样，看不出说的是哪个代次）；
 *   3. 截断时补 `…`，并往前退到最近的空白，避免把词切成两半。
 */
const FEATURE_TAIL_MAX = 48;

function truncTail(text0) {
  let t = String(text0).replace(/\*\*/g, '').trim();
  if (!t) return '';

  let end = t.length;
  const cut = t.search(/[，；。（(]/);
  if (cut > 0) end = cut;
  if (end > FEATURE_TAIL_MAX) end = FEATURE_TAIL_MAX;

  // 不许落在反引号对内：`0.2.2-rc.5` 被切成 `0.2.` 是最难看的形态
  const before = t.slice(0, end);
  const ticks = (before.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const close = t.indexOf('`', end);
    if (close > 0) end = close + 1;
  }

  let out = t.slice(0, end).replace(/[，；。、\s]+$/, '');
  if (end < t.length) {
    // 往前退到空白，别把词切半
    const sp = out.lastIndexOf(' ');
    if (sp > FEATURE_TAIL_MAX - 12 && sp > 0) out = out.slice(0, sp);
    out += '…';
  }
  return out;
}

/** README 特性小节 → Release 的一行摘要清单（丢子项、压说明）。 */
function condensedFeatures(lines) {
  return lines
    .filter((l) => /^- /.test(l))      // 只保留顶层条目
    .map(condenseFeature);
}



// **README 优先**（2026-11-26 反转）：README 的「特性一览」是唯一事实来源，每条 Release
// 都从它现算。过去是「优先继承上一条 Release」，于是清单一旦写错就被永久继承 ——
// dsh-later 的「十一个代次 / 中英两门语言」被 v1.12.2 → 1.15.0 连续抄了四版，
// 直到有人肉眼比对 README 才发现。继承只保留兜底作用（README 里没有特性小节时）。
const readme = readmeFeatures();
const fromReadme = readme.lines;
const fromPrev = fromReadme.length ? [] : previousReleaseFeatures(ver);
const featureLines = fromReadme.length ? fromReadme : fromPrev;
// 已经写过摘要的 README 节（`## 功能摘要`）**不再二次压缩** —— 作者压过了，
// 再截一次会得到「**送得到**：服务端驱动…」这种只剩开头的残句。
const alreadyDigest = Boolean(readme.digest) && fromReadme.length > 0;
const featureSource = fromReadme.length
  ? `README ${readme.heading ?? '特性小节'}${alreadyDigest ? '（已是摘要，不再压缩）' : ''}`
  : '上一条 Release';
const feats = items(sectionLines).filter((t) => /^-\s+\*\*feat\*\*/.test(t));

/**
 * 功能节里凡是写了「N 个代次 / N 代」的数字，必须等于实际的代次数。
 *
 * 为什么需要：这段清单**跨版本复用**，能力变了而清单没跟上是这类文档最常见的腐烂方式
 * （dsh-later 的「十一个代次」在扩到 15 代之后还连抄了四版）。数字是机器能核的，不该靠人记。
 *
 * 实际代次数从 `lib/upstream-compat.js`（或 `src/upstream-compat.ts`）里的 `id:` 条目数得出；
 * 拿不到就跳过 —— 不是每个插件都有"代次"这个概念。
 */
function assertGenerationCount(featureLines) {
  const actual = generationCount();
  if (!actual) return;

  const text = featureLines.join('\n');
  const CN = { 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 };
  const hits = [];
  for (const m of text.matchAll(/(\d+)\s*\*{0,2}\s*(?:个)?代次|共\s*([一二三四五六七八九十]+)\s*个?代次/g)) {
    const n = m[1] ? Number(m[1]) : CN[m[2]];
    if (Number.isFinite(n)) hits.push(n);
  }
  const wrong = [...new Set(hits.filter((n) => n !== actual))];
  if (wrong.length) {
    process.stderr.write(
      `\u26a0 功能清单里的代次数写成 ${wrong.join(' / ')}，实际是 ${actual} 代 —— ` +
        `这条会被每个版本复制下去，请改 README 的特性小节。\n`,
    );
  }
}

/** 从 upstream-compat 里数代次条目；两个文件都找不到就返回 null。 */
function generationCount() {
  for (const rel of ['lib/upstream-compat.js', 'src/upstream-compat.ts']) {
    const f = rel; // 引擎全程以仓库根为 cwd，用相对路径即可
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // 代次 id 形如 `id: '0.2.2-rc.5'`
    const ids = [...src.matchAll(/id:\s*'([0-9][0-9A-Za-z.-]+)'/g)]
      .map((m) => m[1])
      .filter((x) => /^[0-9]+\.[0-9]+\.[0-9]+-(?:rc|alpha|beta)\./i.test(x));
    const uniq = new Set(ids);
    if (uniq.size) return uniq.size;
  }
  return null;
}
if (feats.length) {
  process.stderr.write(
    `· 「## 功能」来源=${featureSource}，共 ${featureLines.length} 条。本版有 ${feats.length} 条 feat\n` +
      `  尚未出现在功能清单里 —— 请把**面向使用者的说法**（不是 CHANGELOG 原句）并进 README 的\n` +
      `  特性小节或上一条 Release，否则功能清单会一直落后。\n`,
  );
}

// 功能清单可能跨版本复用，动手组装前先核对里面的代次数
assertGenerationCount(featureLines);

/* ─────────── 组装 ─────────── */

const repoUrl = (() => {
  const u = pkg.homepage || pkg.repository?.url || '';
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(u);
  return m ? `https://github.com/${m[1]}/${m[2]}` : u;
})();

/**
 * 上一版的 tag（compare 链接的左端）。
 *
 * 先试 git（离线可用、不受 gh 的 tag 支持情况影响），再退回 `gh api releases`。
 * 找不到就是 null —— compare 链接省掉，而不是给一个指向 `HEAD` 的假链接。
 */
function previousTag(version) {
  const candidates = [...gitTags().filter((t) => t !== `v${version}`), ...ghReleaseTags(version)];
  for (const t of candidates) {
    if (/^v?[0-9]/.test(t) && !t.includes(version)) return t.startsWith('v') ? t : `v${t}`;
  }
  return null;
}

function gitTags() {
  try {
    return execFileSync('git', ['tag', '-l', 'v*', '--sort=-v:refname'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ghReleaseTags(version) {
  try {
    return JSON.parse(
      gh(['api', 'repos/{owner}/{repo}/releases?per_page=20', '--jq', '[.[].tag_name]']),
    ).map(String).filter((t) => t !== `v${version}`);
  } catch {
    return [];
  }
}

/* ─────────── 组装 ─────────── */

const block = [];
if (pkg.description) block.push(pkg.description, '');

if (MODE === 'dsh') {
  // 只写这一版改了什么。CHANGELOG 的 40 字标题已经是"面向使用者的一句话"，
  // 不再搬运，也不再附功能清单 —— 想看全量 diff 就点 compare。
  for (const t of orderedTypes) {
    // DSH 的正文每条都是「一句话就够」。CHANGELOG 条目的 `标题：解释` 结构里，
    // 标题已经说清了改了什么，解释是论证 —— 正文不再搬（要看就点 compare）。
    const lines = groups.get(t).map(shortLine);
    block.push(`## ${CHANGELOG_HEADING[t] ?? t}`, '', ...lines, '');
  }
  if (!orderedTypes.length && !missingSection) block.push('_(本版无条目)_', '');

  if (thanks) block.push('## 致谢', '', thanks, '');

  const prev = previousTag(ver);
  if (prev && repoUrl) {
    block.push(`Full Changelog: ${repoUrl}/compare/${prev}...v${ver}`, '');
  } else if (repoUrl) {
    block.push(`完整更新日志：${repoUrl}/blob/main/CHANGELOG.md`, '');
  }
} else {
block.push(
  '## 安装',
  '',
  '```sh',
  `dsh plugin --profile web add ${pkg.name ?? '<pkg>'}`,
  '# 重启 dsh web 后生效',
  '```',
  '',
  '预构建产物随包发布，npm 安装无需本地构建或构建授权。',
  '',
  '## 功能',
  '',
  featureLines.length
    ? (alreadyDigest ? featureLines.join('\n') : condensedFeatures(featureLines).join('\n')) +
      `\n\n_逐条细节见 [README](${repoUrl}#特性一览)。_`
    : '- _(README 特性小节与上一条 Release 都取不到：请补功能清单)_',
  '',
  '## 本版本变更',
  '',
);

if (missingSection) {
  block.push(
    `> ⚠️ **CHANGELOG 里没有 ${ver} 这一小节。** 正文因此不完整：把「未发布」小节改名为 ${ver}` +
      '（跑 release-infra/bin/rel.mjs rename ' + ver + '）后重跑本脚本并更新这条 Release。',
    '',
  );
}
for (const t of orderedTypes) block.push(`### ${t}`, '', ...groups.get(t), '');
if (!orderedTypes.length && !missingSection) block.push('_(本版无条目)_', '');

if (thanks) block.push('## 致谢', '', thanks, '');
block.push('## 说明', '', `- License: ${pkg.license ?? '—'}`);
if (repoUrl) block.push(`- 仓库：${repoUrl}`, `- 完整更新日志：${repoUrl}/blob/main/CHANGELOG.md`);
}

process.stdout.write(block.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
