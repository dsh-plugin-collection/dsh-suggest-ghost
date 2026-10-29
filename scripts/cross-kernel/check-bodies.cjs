// 注入体逐个语法检查（§8 那条纪律的机械版）：
// 朴素正则会停在"注释里的反引号"上，所以这里配对扫描；把 ${} 插值换成字面量后
// 用 new Function 真编译一遍 —— 语法过不了就是页面会抛的错，别等实跑才发现。
const fs = require('node:fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// 把一个表达式里的 ${...} 插值（含嵌套花括号）换成字面量 0
const subst = (text) => {
  let out = '';
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '$' && text[k + 1] === '{') {
      let d = 1; let j = k + 2;
      while (j < text.length && d > 0) { if (text[j] === '{') d += 1; else if (text[j] === '}') d -= 1; j += 1; }
      out += '0'; k = j - 1; continue;
    }
    out += text[k];
  }
  return out;
};
const bodies = [];
const hm = src.match(/const HELPERS = `([\s\S]*?)\n`;/);
if (hm) bodies.push({ line: 'HELPERS', body: hm[1] });
const hm2 = src.match(/const BLOCK = `([\s\S]*?)\n`;/);
if (hm2) bodies.push({ line: 'BLOCK', body: hm2[1] });

let i = 0;
while ((i = src.indexOf('evaluate(`', i)) >= 0) {
  let j = i + 'evaluate(`'.length;
  let depth = 0;
  let out = '';
  let inStr = null;
  while (j < src.length) {
    const c = src[j];
    const prev = src[j - 1];
    if (inStr !== null) {
      if (c === inStr && prev !== '\\') inStr = null;
      out += c; j += 1; continue;
    }
    if (c === '"' || c === "'") { inStr = c; out += c; j += 1; continue; }
    if (c === '`') { if (depth === 0) break; depth -= 1; out += c; j += 1; continue; }
    if (c === '$' && src[j + 1] === '{') { depth += 1; out += '${'; j += 2; continue; }
    out += c; j += 1;
  }
  bodies.push({ line: src.slice(0, i).split('\n').length, body: out });
  i = j + 1;
}

let bad = 0;
for (const b of bodies) {
  const probe = subst(b.body);
  try { new Function('(async () => { ' + probe + ' })()'); }
  catch (e) { bad += 1; console.log('  X 第 ' + b.line + ' 行注入体: ' + e.message.slice(0, 90)); }
}
console.log('injected bodies: ' + bodies.length + ', syntax failures: ' + bad);
process.exit(bad ? 1 : 0);
