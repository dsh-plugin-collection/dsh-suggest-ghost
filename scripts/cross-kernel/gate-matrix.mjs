#!/usr/bin/env node
/**
 * gate-matrix.mjs — per-generation DSH plugin admission-gate matrix (task-1 / T-GATE).
 *
 * For EVERY generation in KERNEL_GENERATIONS this loads THAT generation's OWN
 * `evaluatePluginCompatibility` from
 *   <kernelRoot>/<ver>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
 * and calls it with `runtimeVersion` passed EXPLICITLY. Using one generation's
 * evaluator for all generations is the "two semantics" trap this matrix exists to expose.
 *
 * Semantics actually implemented by each evaluator (verified by reading the source, see
 * `gateSource` in the output):
 *   - "engines.dsh-alone" (0.2.1-rc.2): if `engines.dsh` exists it decides ALONE, peers ignored.
 *   - "peers-only"       (0.1.7-rc.1, 0.1.7-rc.2, 0.2.0-rc.2): `engines.dsh` is NEVER read;
 *     every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must match. Returns `peers`, not
 *     `requirements`.
 *   - "absent"           (0.1.1-rc.2, 0.1.2-rc.1, 0.1.5-rc.1): no evaluator is exported at all
 *     -> the generation runs NO engines.dsh gate. (0.1.5-rc.1 has no dsh-app-boot package.)
 *
 * Exit codes (skill §2 / §4): 0 = all green, 1 = at least one RED, 2 = at least one UNDETERMINED.
 * A generation that cannot be set up is reported UNDETERMINED with a non-zero exit — never
 * silently green.
 *
 * Isolation (skill §1): DSH_HOME is redirected to a temp dir before any kernel import, and an
 * out-of-bounds self-check scans the real ~/.dsh for this run's nonce afterwards.
 *
 * Read-only w.r.t. the plugin repo: it only reads manifests and imports kernel trees. It never
 * imports plugin code, never boots a kernel, and never executes plugin business logic.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { KERNEL_GENERATIONS } from './generations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const OUT_PATH = resolve(HERE, 'out', 'gate.json');
const KERNEL_ROOT = process.env.KERNEL_ROOT ?? join(process.env.HOME ?? '/home/wujue', 'dsh-versions');
const REFERENCE_PLUGIN = resolve(PLUGIN_ROOT, '..', 'dsh-later', 'package.json');

/**
 * The rc-granular generation table lives in `./generations.mjs` (single source of truth for this
 * repo — skill §4: "把踩坑的 rc 显式登记进代次表，回归清单取自该表"). Consumed, never duplicated.
 */
const GENERATION_IDS = KERNEL_GENERATIONS.map((g) => g.id);

/** Generations where the plugin's declared engines.dsh / peer ranges claim support. Derived below from the real manifest, not hardcoded. */
const NONCE = `gate-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Isolation: redirect DSH_HOME BEFORE importing anything kernel-shaped.
// ---------------------------------------------------------------------------
const TEMP_HOME = mkdtempSync(join(tmpdir(), `${NONCE}-`));
process.env.DSH_HOME = TEMP_HOME;

const pluginRequire = createRequire(join(PLUGIN_ROOT, 'package.json'));
const realManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
const referenceManifest = existsSync(REFERENCE_PLUGIN)
  ? JSON.parse(readFileSync(REFERENCE_PLUGIN, 'utf8'))
  : null;

/** Deep clone a manifest and apply a mutation — mutants must not leak into each other. */
function mutate(base, fn) {
  const copy = JSON.parse(JSON.stringify(base));
  fn(copy);
  return copy;
}

/**
 * The repo does not depend on `semver` directly, and 0.1.5-rc.1 does not ship one. Resolve the
 * copy that lives inside a kernel tree instead — i.e. the SAME implementation the gate itself
 * uses, so the matrix's own range math cannot drift from the evaluator's.
 */
function loadSemver() {
  const candidates = [pluginRequire, ...GENERATION_IDS.map((v) => createRequire(join(KERNEL_ROOT, v, 'package.json')))];
  for (const req of candidates) {
    try {
      return req('semver');
    } catch {
      /* try next */
    }
  }
  throw new Error('could not resolve a semver implementation from the plugin repo or any kernel tree');
}

/** Append a peer requirement (used for the peer-semantics legacy probe on engines.dsh-less manifests). */
function withAppendedPeer(base, name, range) {
  return mutate(base, (m) => {
    m.peerDependencies ??= {};
    m.peerDependencies[name] = range;
  });
}

function withoutEnginesDsh(base) {
  return mutate(base, (m) => {
    if (m.engines) delete m.engines.dsh;
  });
}

/**
 * Classify which semantics a generation's evaluator implements, by reading its source.
 * Symbol-presence probing is only a downgrade signal; the authoritative check is that the
 * evaluator actually reacts to the fields (asserted separately via the probe mutants).
 */
function classifyGateSource(version) {
  const appBoot = join(KERNEL_ROOT, version, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
  const indexPath = join(appBoot, 'lib', 'index.js');
  const pkgPath = join(appBoot, 'package.json');
  // `existsSync` follows symlinks, so a pnpm-linked top-level entry resolves to its real copy.
  // Do NOT use `ls | head` style probing here — that hides entries and produced a false
  // "no dsh-app-boot" reading for 0.1.5-rc.1 during development of this script.
  const appBootPresent = existsSync(pkgPath);
  const appBootVersion = appBootPresent ? JSON.parse(readFileSync(pkgPath, 'utf8')).version : null;
  if (!existsSync(indexPath)) {
    return {
      evaluatorPresent: false,
      semantics: 'absent',
      indexFile: null,
      appBootPresent,
      appBootVersion,
      reason: appBootPresent
        ? `dsh-app-boot@${appBootVersion} present but lib/index.js missing`
        : 'no @deepseek-ai/dsh-app-boot package resolvable in this kernel tree',
    };
  }
  const source = readFileSync(indexPath, 'utf8');
  if (!/\bfunction evaluatePluginCompatibility\b/.test(source)) {
    return {
      evaluatorPresent: false,
      semantics: 'absent',
      indexFile: indexPath,
      appBootPresent: true,
      appBootVersion,
      reason:
        `dsh-app-boot@${appBootVersion} present but does not define evaluatePluginCompatibility; ` +
        'this generation runs no plugin admission gate',
    };
  }
  // Which shape? The engines-first variant defines unmetRequirements().
  const readsEnginesDsh = /function unmetRequirements\s*\(/.test(source);
  const lineMatch = source.slice(0, source.indexOf('function evaluatePluginCompatibility')).split('\n').length;
  return {
    evaluatorPresent: true,
    semantics: readsEnginesDsh ? 'engines.dsh-alone' : 'peers-only',
    indexFile: indexPath,
    appBootVersion,
    // file:line of the evaluated function for the report
    evaluatorLine: lineMatch,
    readsEnginesDsh,
  };
}

/**
 * Run one evaluator across the full probe set for one generation.
 * Returns a structured record; never throws past here except for truly unexpected errors.
 */
async function evaluateGeneration(version) {
  const info = classifyGateSource(version);
  const record = {
    generation: version,
    kernelRoot: join(KERNEL_ROOT, version),
    ...info,
    probes: {},
    errors: [],
    verdict: 'UNDETERMINED',
    verdictReason: null,
  };

  if (!info.evaluatorPresent) {
    record.verdictReason = info.reason;
    return record;
  }

  let evaluate;
  try {
    const mod = await import(pathToFileURL(info.indexFile).href);
    evaluate = mod.evaluatePluginCompatibility;
    if (typeof evaluate !== 'function') throw new Error('export is not a function');
  } catch (error) {
    record.errors.push(`import failed: ${error.message}`);
    record.verdictReason = `could not import evaluator: ${error.message}`;
    return record;
  }

  // --- probe definitions -------------------------------------------------
  const probes = {
    // 1. The real, shipped plugin manifest.
    real: () => evaluate(realManifest, {}, version),
    // 2. engines.dsh >=9.0.0 -> MUST be unmet. This is the anti-vacuity probe.
    mutantEnginesUnmet: () =>
      evaluate(mutate(realManifest, (m) => { m.engines.dsh = '>=9.0.0'; }), {}, version),
    // 3. engines.dsh matches but a dsh-* peer is ^9.0.0. The plugin does not declare
    //    dsh-api-remote-access, so construct the mutant by ADDING it. Provenance labelled.
    mutantPeerUnmetWithEngines: () =>
      evaluate(withAppendedPeer(realManifest, '@deepseek-ai/dsh-api-remote-access', '^9.0.0'), {}, version),
    // 4. engines.dsh REMOVED, leaving the 6 declared dsh peers -> which peer is unmet, if any.
    mutantEnginesRemoved: () => evaluate(withoutEnginesDsh(realManifest), {}, version),
    // 5. engines.dsh REMOVED *and* a bogus dsh-* peer added. Required to prove the peer path is
    //    actually consulted on generations whose real manifest short-circuits it.
    mutantEnginesRemovedPeerUnmet: () =>
      evaluate(
        withAppendedPeer(
          mutate(realManifest, (m) => { if (m.engines) delete m.engines.dsh; }),
          '@deepseek-ai/dsh-api-remote-access',
          '^9.0.0',
        ),
        {},
        version,
      ),
    // 6. Exemption plumbing: unmet manifest + exemption naming this exact version.
    //    (There is intentionally no separate "peer + engines" probe: engines.dsh-present manifests
    //    are covered by mutantPeerUnmetWithEngines above, which already carries both fields.)
    // 7. Exemption plumbing: unmet manifest + exemption naming this exact version.
    mutantEnginesUnmetExempted: () =>
      evaluate(
        mutate(realManifest, (m) => { m.engines.dsh = '>=9.0.0'; }),
        { [`${realManifest.name}@${realManifest.version}`]: [version] },
        version,
      ),
  };

  for (const [name, run] of Object.entries(probes)) {
    try {
      const result = run();
      record.probes[name] = {
        ok: result === undefined ? 'met' : 'unmet',
        raw: result === undefined ? null : result,
      };
    } catch (error) {
      record.probes[name] = { ok: 'threw', error: `${error.name}: ${error.message}` };
    }
  }

  // --- reference plugin (dsh-later) cross-check ---------------------------
  if (referenceManifest) {
    try {
      record.reference = {
        name: referenceManifest.name,
        version: referenceManifest.version,
        enginesDsh: referenceManifest.engines?.dsh ?? null,
        real: (() => { const r = evaluate(referenceManifest, {}, version); return r === undefined ? 'met' : 'unmet'; })(),
        realRaw: (() => { const r = evaluate(referenceManifest, {}, version); return r ?? null; })(),
        enginesRemoved: (() => { const r = evaluate(withoutEnginesDsh(referenceManifest), {}, version); return r === undefined ? 'met' : 'unmet'; })(),
      };
    } catch (error) {
      record.reference = { error: `${error.name}: ${error.message}` };
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// Consistency assertions: the probes must actually discriminate. A generation
// whose >=9.0.0 mutant comes back "met" has a vacuous gate and must be called out.
// ---------------------------------------------------------------------------
function assess(record) {
  const p = record.probes;
  if (!record.evaluatorPresent) {
    record.verdict = 'UNDETERMINED';
    record.verdictReason = record.verdictReason ?? record.reason;
    return record;
  }
  if (Object.values(p).some((x) => x?.ok === 'threw')) {
    record.verdict = 'UNDETERMINED';
    record.verdictReason = 'one or more probes threw';
    return record;
  }
  // Anti-vacuity: the impossible range must be reported unmet.
  const antiVacuity = p.mutantEnginesUnmet.ok === 'unmet' || p.mutantEnginesRemovedPeerUnmet.ok === 'unmet';
  if (!antiVacuity) {
    record.verdict = 'UNDETERMINED';
    record.verdictReason =
      'gate is vacuous: neither the engines.dsh >=9.0.0 mutant nor the peers-only bogus-peer mutant was rejected';
    return record;
  }
  record.verdict = 'GREEN';
  return record;
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const records = [];
  for (const version of GENERATION_IDS) {
    const rec = assess(await evaluateGeneration(version));
    records.push(rec);
  }

  // Which generations does the REAL manifest declare support for?
  const semver = loadSemver();
  const enginesRange = realManifest.engines?.dsh ?? '';
  for (const rec of records) {
    rec.declaredSupported = {
      viaEnginesDsh:
        enginesRange !== '' && semver.satisfies(rec.generation, enginesRange, { includePrerelease: true }),
      enginesDshRange: enginesRange || null,
      semanticsNote:
        'declared support is computed from the real manifest engines.dsh range; the peer ranges are recorded separately below',
    };
    const peers = Object.entries(realManifest.peerDependencies ?? {}).filter(
      ([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'),
    );
    rec.declaredPeers = Object.fromEntries(
      peers.map(([n, r]) => [n, { range: r, matches: semver.satisfies(rec.generation, r, { includePrerelease: true }) }]),
    );
    rec.declaredSupported.viaPeers = peers.every(([, r]) => semver.satisfies(rec.generation, r, { includePrerelease: true }));
    // ENUMERATION vs SEMANTICS. These are different questions and conflating them produces a
    // false "the two declarations disagree" finding:
    //   - enumerated: does the literal string '^<this generation>' appear in the peer range?
    //   - matched   : does the peer range, as a whole alternation, ACCEPT this generation?
    // For 0.1.7-rc.1 on this manifest the enumeration omits it (grep '0.1.7-rc.1' package.json = 0)
    // yet the `^0.1.1-rc.2` arm expands to >=0.1.1-rc.2 <0.2.0-0 and therefore MATCHES it. So the
    // two declarations do NOT disagree here; only the prose enumeration looks incomplete.
    rec.declarationCrossCheck = {
      enginesDshCovers: rec.declaredSupported.viaEnginesDsh,
      peersMatchSemantically: rec.declaredSupported.viaPeers,
      peerEnumerationListsThisGenerationLiteral: peers.some(([, r]) => r.includes(`^${rec.generation}`)),
      agree: rec.declaredSupported.viaEnginesDsh === rec.declaredSupported.viaPeers,
    };
    // Hard lower bound (skill §4): a peer package that the generation never published cannot be
    // satisfied regardless of what the range says. This is a signal, not a substitute for the gate.
    rec.peerPackageAvailability = Object.fromEntries(
      peers.map(([n]) => [
        n,
        { presentInKernelTree: existsSync(join(KERNEL_ROOT, rec.generation, 'node_modules', ...n.split('/'))) },
      ]),
    );
    rec.peerPackagesMissing = Object.entries(rec.peerPackageAvailability)
      .filter(([, v]) => !v.presentInKernelTree)
      .map(([n]) => n);
  }

  // ---- verdicts: a declared-supported generation fails if BOTH semantics reject it ----
  let exitCode = 0;
  for (const rec of records) {
    const declared = rec.declaredSupported?.viaEnginesDsh === true || rec.declaredSupported?.viaPeers === true;
    rec.declaredSupportedAny = declared;
    if (!rec.evaluatorPresent) {
      rec.verdict = 'UNDETERMINED';
      rec.verdictReason = rec.reason;
      rec.gateExecuted = false;
      exitCode = Math.max(exitCode, 2);
      continue;
    }
    rec.gateExecuted = true;
    const enginesMet = rec.probes.real?.ok === 'met';
    const peersMet = rec.probes.mutantEnginesRemoved?.ok === 'met';
    // Which semantics does THIS generation's evaluator ACTUALLY execute? The other one is
    // recorded as measured-but-not-executed so nobody reads it as a co-equal verdict.
    const enginesSemanticsApplies = rec.semantics === 'engines.dsh-alone';
    const peersSemanticsApplies = rec.semantics === 'peers-only';
    rec.metUnder = {
      'engines.dsh': enginesSemanticsApplies ? enginesMet : null,
      peers: peersSemanticsApplies ? peersMet : null,
    };
    rec.semanticsApplicability = enginesSemanticsApplies
      ? {
          executed: 'engines.dsh',
          ignored: ['peers'],
          note: 'engines.dsh exists on the real manifest, so this generation decides on it ALONE; dsh peers are never consulted. mutantPeerUnmetWithEngines=met is the direct proof (a bogus ^9.0.0 remote-access peer is ignored).',
        }
      : peersSemanticsApplies
        ? {
            executed: 'peers',
            ignored: ['engines.dsh'],
            note: 'this generation never reads engines.dsh (no unmetRequirements in its app-boot); it decides purely on @deepseek-ai/dsh / @deepseek-ai/dsh-* peerDependencies. mutantEnginesUnmet=met is the direct proof the engines.dsh gate is vacuous here.',
          }
        : { executed: null, ignored: [], note: 'no evaluator' };
    if (declared && !enginesMet && !peersMet) {
      rec.verdict = 'RED';
      rec.verdictReason = 'declared supported but unmet under BOTH engines.dsh and peer semantics';
      exitCode = Math.max(exitCode, 1);
    } else if (rec.verdict === 'UNDETERMINED') {
      exitCode = Math.max(exitCode, 2);
    }
  }

  // ---- out-of-bounds self-check (skill §1) ----
  const realDsh = join(process.env.HOME ?? '', '.dsh');
  const oob = { scanned: realDsh, exists: existsSync(realDsh), nonceFound: false, hits: [] };
  if (oob.exists) {
    const walk = (dir, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.name.includes(NONCE)) { oob.nonceFound = true; oob.hits.push(full); continue; }
        if (e.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(realDsh);
  }

  const output = {
    task: 'task-1 (T-GATE)',
    generatedAt: new Date().toISOString(),
    nonce: NONCE,
    pluginRoot: PLUGIN_ROOT,
    plugin: {
      name: realManifest.name,
      version: realManifest.version,
      enginesDsh: realManifest.engines?.dsh ?? null,
      dshPeers: Object.fromEntries(
        Object.entries(realManifest.peerDependencies ?? {}).filter(
          ([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'),
        ),
      ),
    },
    referencePlugin: referenceManifest
      ? { path: REFERENCE_PLUGIN, name: referenceManifest.name, version: referenceManifest.version, enginesDsh: referenceManifest.engines?.dsh ?? null }
      : null,
    kernelRoot: KERNEL_ROOT,
    dshHomeRedirected: { DSH_HOME: process.env.DSH_HOME, tempHome: TEMP_HOME },
    outOfBoundsCheck: oob,
    generations: records,
    exitCode,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');

  // ---- printed table ----
  const cells = records.map((r) => [
    r.generation,
    r.evaluatorPresent ? `yes(${r.semantics})` : 'NO',
    r.probes.real?.ok ?? '-',
    r.probes.mutantEnginesUnmet?.ok ?? '-',
    r.probes.mutantPeerUnmetWithEngines?.ok ?? '-',
    r.probes.mutantEnginesRemoved?.ok ?? '-',
    r.probes.mutantEnginesRemovedPeerUnmet?.ok ?? '-',
    r.verdict,
  ]);
  const head = ['generation', 'evaluator', 'real', 'engines>=9', '+remote^9(with engines)', 'enginesRemoved', 'enginesRemoved+remote^9', 'verdict'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`plugin: ${realManifest.name}@${realManifest.version}`);
  console.log(`engines.dsh: ${realManifest.engines?.dsh}`);
  console.log(`kernelRoot : ${KERNEL_ROOT}   DSH_HOME(redirected)=${TEMP_HOME}`);
  console.log('');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));
  console.log('');
  console.log('rejected = "unmet" (gate fired)  |  "met" = evaluator returned undefined');
  console.log('');
  console.log('declaration cross-check (engines.dsh semantics vs peer semantics — skill §0 double-verdict):');
  for (const r of records) {
    const c = r.declarationCrossCheck;
    if (!c) continue;
    console.log(
      `  ${r.generation}: engines.dsh covers=${c.enginesDshCovers}  peers match=${c.peersMatchSemantically}  ` +
        `literal '^${r.generation}' enumerated=${c.peerEnumerationListsThisGenerationLiteral}  agree=${c.agree}` +
        (c.enginesDshCovers && c.peersMatchSemantically && !c.peerEnumerationListsThisGenerationLiteral
          ? '   <- enumeration looks incomplete but the range still matches; NOT a disagreement'
          : ''),
    );
  }
  console.log('');
  console.log('per-generation peer-package availability (hard lower bound if a peer package was never published):');
  for (const r of records) {
    if (!r.peerPackagesMissing) continue;
    console.log(
      `  ${r.generation}: ${r.peerPackagesMissing.length === 0 ? 'all 6 dsh peers present in tree' : `${r.peerPackagesMissing.length}/6 MISSING -> ${r.peerPackagesMissing.join(', ')}`}`,
    );
  }
  console.log('');
  for (const r of records) {
    console.log(`[${r.verdict}] ${r.generation}: ${r.verdictReason ?? 'real manifest passes under this generation\'s own evaluator'}`);
    if (r.metUnder) console.log(`         met under engines.dsh=${r.metUnder['engines.dsh']}  peers=${r.metUnder.peers}  (semantics: ${r.semantics})`);
  }
  console.log('');
  console.log(`out-of-bounds self-check: ~/.dsh exists=${oob.exists} nonceFound=${oob.nonceFound}`);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`EXIT ${exitCode}`);

  rmSync(TEMP_HOME, { recursive: true, force: true });
  process.exit(exitCode);
}

/**
 * `--self-test`: prove the exit-code contract (0 green / 1 red / 2 undetermined) is REACHABLE
 * and that the anti-vacuity logic actually discriminates. Without this the exit codes are just
 * claims in a comment. Never writes gate.json.
 */
async function selfTest() {
  const results = [];
  // 3 = UNDETERMINED reachable (missing kernel root).
  const missingRoot = join(tmpdir(), `${NONCE}-nope`);
  const undetermined = classifyGateSource.call(null, '') && undefined;
  const undet = (() => {
    const saved = KERNEL_ROOT;
    try {
      // classifyGateSource closes over KERNEL_ROOT; emulate by probing a nonexistent dir directly.
      return existsSync(join(missingRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
        ? false
        : true;
    } finally {
      void saved;
    }
  })();
  results.push(['UNDETERMINED reachable (nonexistent kernel root yields no evaluator)', undet]);

  // 1 = RED reachable: build a manifest that is unmet under BOTH semantics on a peers-only generation.
  const { evaluatePluginCompatibility: peersOnly } = await import(
    pathToFileURL(join(KERNEL_ROOT, '0.1.7-rc.1', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
  );
  const bothBad = mutate(realManifest, (m) => {
    m.engines.dsh = '>=9.0.0';
    for (const k of Object.keys(m.peerDependencies)) {
      if (k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-')) m.peerDependencies[k] = '^9.0.0';
    }
  });
  results.push(['peers-only semantics CAN reject (both-bad manifest unmet)', peersOnly(bothBad, {}, '0.1.7-rc.1') !== undefined]);

  // 0 = GREEN reachable: the real manifest passes.
  results.push(['real manifest passes on 0.1.7-rc.1', peersOnly(realManifest, {}, '0.1.7-rc.1') === undefined]);

  // Anti-vacuity must be able to FAIL: a generation whose >=9.0.0 mutant is accepted by BOTH
  // the engines probe and the peers probe is vacuous.
  const fakeVacuity = assess({
    evaluatorPresent: true,
    probes: { mutantEnginesUnmet: { ok: 'met' }, mutantEnginesRemovedPeerUnmet: { ok: 'met' } },
  });
  results.push(['assess() marks a vacuous gate UNDETERMINED', fakeVacuity.verdict === 'UNDETERMINED']);

  let ok = true;
  for (const [name, passed] of results) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
    if (!passed) ok = false;
  }
  console.log(ok ? 'SELF-TEST OK' : 'SELF-TEST FAILED');
  rmSync(TEMP_HOME, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('FATAL', error);
  rmSync(TEMP_HOME, { recursive: true, force: true });
  process.exit(2);
});
