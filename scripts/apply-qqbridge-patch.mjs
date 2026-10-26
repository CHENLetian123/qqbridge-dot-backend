#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir, realpath, rename, link, unlink, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = 'src/bridge.js';
const gitEnv = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];

export class PatchInstallError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PatchInstallError';
    this.code = code;
  }
}
const fail = (code, message, cause) => { throw new PatchInstallError(code, message, { cause }); };
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function regularFile(path, missingCode) {
  const stat = await statIfPresent(path);
  if (!stat) fail(missingCode, `Required file is missing: ${path}`);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', `Expected a regular file, not a link or directory: ${path}`);
  return { bytes: await readFile(path), mode: stat.mode & 0o777 };
}

async function directory(path, missingCode) {
  const stat = await statIfPresent(path);
  if (!stat) fail(missingCode, `Required directory is missing: ${path}`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', `Expected a real directory: ${path}`);
}

async function git(args, cwd) {
  try {
    // Temporary staging directories do not inherit the source checkout's Git
    // settings. Preserve exact baseline bytes even on Windows installations
    // whose global core.autocrlf is true.
    return (await exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: gitEnv, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') fail('GIT_REQUIRED', 'Install Git before using the patch installer.', error);
    throw error;
  }
}

async function inputs({ manifestPath, patchPath, overlayDir }) {
  const manifestFile = await regularFile(manifestPath, 'MANIFEST_MISSING');
  let manifest;
  try { manifest = JSON.parse(manifestFile.bytes.toString('utf8')); }
  catch (error) { fail('MANIFEST_INVALID', 'The baseline manifest is not valid JSON.', error); }
  const originalSha = Array.isArray(manifest?.reviewed_files)
    ? manifest.reviewed_files.find(file => file?.path === bridgePath)?.blob_sha : undefined;
  if (manifest?.schema_version !== 1 || !/^[a-f0-9]{40}$/.test(originalSha ?? '') ||
      !/^[a-f0-9]{40}$/.test(manifest?.upstream?.commit ?? '')) {
    fail('MANIFEST_INVALID', 'Baseline must name an upstream commit and the original src/bridge.js blob SHA.');
  }
  const patch = (await regularFile(patchPath, 'PATCH_MISSING')).bytes;
  // Modes, copies, renames, and any path other than bridge.js are outside this installer contract.
  if (/^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to) /m.test(patch.toString('utf8'))) {
    fail('PATCH_SCOPE', 'The patch may only change the contents of src/bridge.js.');
  }
  await directory(overlayDir, 'OVERLAY_MISSING');
  await directory(join(overlayDir, 'src'), 'OVERLAY_MISSING');
  const overlays = [];
  for (const name of (await readdir(join(overlayDir, 'src'))).sort()) {
    if (!/^[A-Za-z0-9_.-]+\.mjs$/.test(name)) fail('OVERLAY_SCOPE', `Unsupported overlay entry: src/${name}`);
    const file = await regularFile(join(overlayDir, 'src', name), 'OVERLAY_MISSING');
    overlays.push({ relative: `src/${name}`, ...file });
  }
  if (!overlays.length) fail('OVERLAY_MISSING', 'No overlay/src/*.mjs files were supplied.');
  return { manifest, originalSha, patch, overlays };
}

async function assertUnchanged(sourceDir, item) {
  const target = join(sourceDir, item.relative);
  const stat = await statIfPresent(target);
  if (!item.original) {
    if (stat) fail('SOURCE_CHANGED', `A target appeared during installation: ${item.relative}`);
  } else if (!stat?.isFile() || stat.isSymbolicLink() ||
      !(await readFile(target)).equals(item.original.bytes) || (stat.mode & 0o777) !== item.original.mode) {
    fail('SOURCE_CHANGED', `A target changed during installation: ${item.relative}`);
  }
}

/** Per-file atomic publication with rollback on caught failures. Stop QQBridge first.
 * This is not a filesystem-wide transaction or protection against power loss/SIGKILL.
 * Backups are retained and their location reported if rollback itself fails.
 */
async function commitPlan(sourceDir, plan, { replaceFile = rename, createFile = link } = {}) {
  const transactionDir = await mkdtemp(join(sourceDir, '.qqbridge-dot-install-'));
  const applied = [];
  let keepBackups = false;
  try {
    for (const [index, item] of plan.entries()) {
      item.staged = join(transactionDir, `new-${index}`);
      item.backup = join(transactionDir, `old-${index}`);
      const mode = item.original?.mode ?? item.mode ?? 0o644;
      await writeFile(item.staged, item.bytes, { flag: 'wx', mode });
      await chmod(item.staged, mode); // writeFile's creation mode alone is reduced by the process umask.
      if (item.original) {
        await writeFile(item.backup, item.original.bytes, { flag: 'wx', mode: item.original.mode });
        await chmod(item.backup, item.original.mode);
      }
    }
    for (const item of plan) await assertUnchanged(sourceDir, item);
    for (const item of plan) {
      await assertUnchanged(sourceDir, item);
      const target = join(sourceDir, item.relative);
      if (item.original) await replaceFile(item.staged, target);
      else await createFile(item.staged, target); // hard-link creation is atomic and refuses an existing target.
      applied.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of applied.reverse()) {
      try {
        const target = join(sourceDir, item.relative);
        const current = await regularFile(target, 'ROLLBACK_TARGET_MISSING');
        if (!current.bytes.equals(item.bytes)) fail('ROLLBACK_TARGET_CHANGED', `Refusing to overwrite a concurrent edit: ${item.relative}`);
        if (item.original) await rename(item.backup, target);
        else await unlink(target);
      } catch (rollbackError) { rollbackErrors.push(`${item.relative}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) {
      keepBackups = true;
      fail('ROLLBACK_FAILED', `Install failed; recover from ${transactionDir}. ${rollbackErrors.join('; ')}`, error);
    }
    fail('INSTALL_FAILED', `Install failed and changes were rolled back: ${error.message}`, error);
  } finally {
    if (!keepBackups) await rm(transactionDir, { recursive: true, force: true });
  }
}

/** Apply only the pinned bridge.js patch and shipped src/*.mjs overlays.
 * The second argument is an I/O fault-injection seam for offline rollback tests.
 */
export async function applyQqbridgePatch({
  sourceDir,
  manifestPath = join(projectDir, 'compat/qqbridge/baseline.json'),
  patchPath = join(projectDir, 'compat/qqbridge/qqbridge-dot.patch'),
  overlayDir = join(projectDir, 'compat/qqbridge/overlay'),
  check = false,
} = {}, io = {}) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) fail('SOURCE_REQUIRED', 'Use --source <QQBridge directory> or set QQBRIDGE_SOURCE_DIR.');
  const supplied = await inputs({ manifestPath, patchPath, overlayDir });
  try { sourceDir = await realpath(resolve(sourceDir)); }
  catch (error) { fail('SOURCE_MISSING', `QQBridge directory is unavailable: ${sourceDir}`, error); }
  await directory(sourceDir, 'SOURCE_MISSING');
  await directory(join(sourceDir, 'src'), 'SOURCE_MISSING');
  const lockDir = join(sourceDir, '.qqbridge-dot-install.lock');
  let lockOwned = false;
  let stageDir;
  try {
    if (!check) {
      try { await mkdir(lockDir, { mode: 0o700 }); lockOwned = true; }
      catch (error) {
        if (error.code === 'EEXIST') fail('INSTALL_LOCKED', 'Another installation or an interrupted install holds .qqbridge-dot-install.lock.', error);
        throw error;
      }
    }
    // Extracted source archives are allowed, but a real checkout must also have the pinned HEAD.
    if (await statIfPresent(join(sourceDir, '.git'))) {
      const head = (await git(['rev-parse', 'HEAD'], sourceDir)).trim();
      if (head !== supplied.manifest.upstream.commit) fail('HEAD_MISMATCH', `Expected upstream HEAD ${supplied.manifest.upstream.commit}; found ${head}.`);
    }
    const original = await regularFile(join(sourceDir, bridgePath), 'BRIDGE_MISSING');
    stageDir = await mkdtemp(join(tmpdir(), 'qqbridge-dot-patch-'));
    await mkdir(join(stageDir, 'src'));
    await writeFile(join(stageDir, bridgePath), original.bytes, { mode: original.mode });
    await writeFile(join(stageDir, 'change.patch'), supplied.patch);
    try {
      const stat = await git(['apply', '--numstat', '-z', 'change.patch'], stageDir);
      if (!/^\d+\t\d+\tsrc\/bridge\.js\0$/.test(stat)) fail('PATCH_SCOPE', 'The patch must modify exactly src/bridge.js.');
    } catch (error) {
      if (error instanceof PatchInstallError) throw error;
      fail('PATCH_INVALID', 'Git could not parse the supplied patch.', error);
    }
    const alreadyPatched = blobSha(original.bytes) !== supplied.originalSha;
    if (alreadyPatched) {
      try {
        await git(['apply', '--reverse', '--check', '--whitespace=nowarn', 'change.patch'], stageDir);
        await git(['apply', '--reverse', '--whitespace=nowarn', 'change.patch'], stageDir);
      } catch (error) {
        if (error instanceof PatchInstallError) throw error;
        fail('BASELINE_MISMATCH', `src/bridge.js is neither baseline ${supplied.originalSha} nor this exact patched version.`, error);
      }
      if (blobSha(await readFile(join(stageDir, bridgePath))) !== supplied.originalSha) {
        fail('BASELINE_MISMATCH', 'Reversing the patch did not recover the pinned original blob.');
      }
    }
    try {
      await git(['apply', '--check', '--whitespace=nowarn', 'change.patch'], stageDir);
      await git(['apply', '--whitespace=nowarn', 'change.patch'], stageDir);
    } catch (error) {
      if (error instanceof PatchInstallError) throw error;
      fail('PATCH_REJECTED', 'The patch dry-run failed against the verified baseline; source was not modified.', error);
    }
    const patched = (await regularFile(join(stageDir, bridgePath), 'PATCH_INVALID')).bytes;
    if (alreadyPatched && !patched.equals(original.bytes)) fail('BASELINE_MISMATCH', 'The installed bridge differs from this patch version.');
    const plan = alreadyPatched ? [] : [{ relative: bridgePath, bytes: patched, original }];
    for (const overlay of supplied.overlays) {
      const target = join(sourceDir, overlay.relative);
      const stat = await statIfPresent(target);
      if (stat) {
        const existing = await regularFile(target, 'OVERLAY_MISSING');
        if (!existing.bytes.equals(overlay.bytes)) fail('OVERLAY_CONFLICT', `Refusing to overwrite a different existing overlay: ${overlay.relative}`);
      } else {
        if (alreadyPatched) fail('INCOMPLETE_INSTALL', `Patched bridge is missing ${overlay.relative}; investigate the incomplete installation.`);
        plan.push({ ...overlay, original: null });
      }
    }
    const result = { status: alreadyPatched ? 'already-applied' : check ? 'check-passed' : 'applied',
      checkOnly: check, sourceDir, upstreamCommit: supplied.manifest.upstream.commit,
      files: [bridgePath, ...supplied.overlays.map(file => file.relative)] };
    if (!check && !alreadyPatched) await commitPlan(sourceDir, plan, io);
    return result;
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
    if (lockOwned) await rm(lockDir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, check: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/apply-qqbridge-patch.mjs --source <QQBridge directory> [--check]\nStop QQBridge before applying. Config/state are never modified.');
    return;
  }
  console.log(JSON.stringify(await applyQqbridgePatch({
    sourceDir: values.source ?? process.env.QQBRIDGE_SOURCE_DIR, check: values.check,
  }), null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`${error.code ?? 'INSTALL_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
