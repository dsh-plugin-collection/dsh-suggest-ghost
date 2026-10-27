#!/usr/bin/env node
/**
 * 读沙箱里本插件的 volatile 证据（判据 ② `_push` 与 ⑤ `_hot`）。
 *
 * ## 为什么要单独一个工具（而不是 grep profile patch）
 * volatile 值的**落点随内核代次不同**，本轮实测：
 *  - 0.1.7-rc.1 → `<home>/profiles/web/cordis.patch.yml` 里本插件条目的 `config._push`
 *  - 0.1.5-rc.3 → `<home>/settings.yaml`（老内核的 settings 存储），profile patch 里**没有**
 * 只读 profile patch 会把后者判成"没有证据"，那是**读错了地方**，不是插件没写。
 *
 * ## 值形状
 * 跨多行的单引号标量（本仓 `_push` 实测 16~35 行），里面存着建议正文 ⇒ 解析要走到
 * **行尾的闭合引号**，不能按行截。
 *
 * 用法：node scripts/cross-kernel/volatile-evidence.mjs --home ~/dsh-sbx-xkg-0153 [--gen 0.1.5-rc.3]
 * 退出码：0 至少读到一个键 / 1 一个都没读到。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const GEN = opt('gen', '?');
const PLUGIN = 'dsh-suggest-ghost';
const ENTRY_ID = opt('entry', 'suggest-ghost');   // ⚠️ 条目 id ≠ 包名（实测 id=suggest-ghost）

/** 从文本里取 `key: '…'`（值可跨行，单引号内 `''` 是转义）。 */
function grabScalar(text, key) {
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*'`, 'm');
  const m = re.exec(text);
  if (m === null) return null;
  let i = m.index + m[0].length;
  let raw = '';
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      if (text[i + 1] === "'") { raw += "'"; i += 2; continue; }
      break;
    }
    raw += c;
    i += 1;
  }
  // YAML 折叠：换行 + 缩进 → 空格
  const one = raw.replace(/\n\s*/g, ' ').trim();
  if (one === '' || one === 'null') return null;
  try { return JSON.parse(one); } catch { return { __parseFail: one.slice(0, 70) }; }
}

const sources = [
  { label: 'profiles/web/cordis.patch.yml', path: join(HOME_, 'profiles', 'web', 'cordis.patch.yml'), scoped: true },
  { label: 'settings.yaml', path: join(HOME_, 'settings.yaml'), scoped: false },
];

const found = {};
const where = {};
for (const src of sources) {
  if (!existsSync(src.path)) continue;
  const text = readFileSync(src.path, 'utf8');
  // profile patch 里要限定在本插件条目范围内，避免读到别的插件同名键
  let scope = text;
  if (src.scoped) {
    const at = text.search(new RegExp(`^-\\s+id:\\s*${ENTRY_ID}\\s*$`, 'm'));
    if (at < 0) continue;
    const rest = text.slice(at + 1);
    const next = rest.search(/^-\s+id:\s*\S+$/m);
    scope = next < 0 ? rest : rest.slice(0, next);
  }
  for (const k of ['_push', '_hot', '_ops']) {
    if (found[k] !== undefined) continue;
    const v = grabScalar(scope, k);
    if (v !== undefined && v !== null) { found[k] = v; where[k] = src.label; }
  }
}

const push = found._push;
const hot = found._hot;
const report = {
  gen: GEN,
  push: push === undefined ? null : {
    rev: push.rev ?? null,
    final: push.suggestion?.final ?? null,
    frame: push.suggestion?.frame ?? null,
    textChars: (push.suggestion?.text ?? '').length,
    hasSessionId: !!push.suggestionSessionId,
    source: where._push,
  },
  hot: hot === undefined ? null : {
    total: hot.total ?? null,
    entries: (hot.hot ?? []).length,
    rev: hot.rev ?? null,
    source: where._hot,
  },
};
report.judge2 = report.push != null && report.push.rev != null && report.push.final === true
  && report.push.textChars > 0 && report.push.hasSessionId;
report.judge5 = report.hot != null && (report.hot.total ?? 0) > 0;
console.log(JSON.stringify(report, null, 1));
process.exitCode = (report.push == null && report.hot == null) ? 1 : 0;
