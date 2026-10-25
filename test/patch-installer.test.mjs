import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, link, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyQqbridgePatch } from '../scripts/apply-qqbridge-patch.mjs';

const before = "// QQBridge fixture\nexport const mode = 'dsh';\n";
const after = "// QQBridge fixture\nexport const mode = 'dot';\n";
const patch = `diff --git a/src/bridge.js b/src/bridge.js
--- a/src/bridge.js
+++ b/src/bridge.js
@@ -1,2 +1,2 @@
 // QQBridge fixture
-export const mode = 'dsh';
+export const mode = 'dot';
`;
const expectedCode = code => error => error.code === code;
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qqbridge-installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'upstream');
  const overlayDir = join(root, 'overlay');
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await mkdir(join(sourceDir, 'data'));
  await mkdir(join(overlayDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, 'src/bridge.js'), before);
  await writeFile(join(sourceDir, 'config.json'), '{"keep":"user-config"}\n');
  await writeFile(join(sourceDir, 'data/state.json'), '{"keep":"user-state"}\n');
  await writeFile(join(overlayDir, 'src/adapter.mjs'), 'export const adapter = true;\n');
  await writeFile(join(overlayDir, 'src/lifecycle.mjs'), 'export const lifecycle = true;\n');
  const manifestPath = join(root, 'baseline.json');
  const patchPath = join(root, 'change.patch');
  // Independently obtained with git hash-object --stdin for the exact fixture above.
  const originalSha = '3c00ae39f514ba41f211fe66f61c7868fcfb1bd4';
  await writeFile(manifestPath, JSON.stringify({ schema_version: 1,
    upstream: { commit: 'a'.repeat(40) }, reviewed_files: [{ path: 'src/bridge.js', blob_sha: originalSha }] }));
  await writeFile(patchPath, patch);
  return { root, options: { sourceDir, overlayDir, manifestPath, patchPath } };
}

async function tree(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const stat = await lstat(path);
    result[name] = stat.isDirectory() ? await tree(path) : stat.isSymbolicLink() ? '<symlink>' : (await readFile(path)).toString('base64');
  }
  return result;
}

test('check 不写目标；apply 可重复识别 already-applied，config/state 保持不变', async t => {
  const { options } = await fixture(t);
  await chmod(join(options.sourceDir, 'src/bridge.js'), 0o770);
  const originalTree = await tree(options.sourceDir);
  assert.equal((await applyQqbridgePatch({ ...options, check: true })).status, 'check-passed');
  assert.deepEqual(await tree(options.sourceDir), originalTree);
  assert.equal((await applyQqbridgePatch(options)).status, 'applied');
  assert.equal(await readFile(join(options.sourceDir, 'src/bridge.js'), 'utf8'), after);
  assert.equal((await lstat(join(options.sourceDir, 'src/bridge.js'))).mode & 0o777, 0o770);
  const installed = await tree(options.sourceDir);
  assert.equal(installed['config.json'], originalTree['config.json']);
  assert.deepEqual(installed.data, originalTree.data);
  assert.equal((await applyQqbridgePatch(options)).status, 'already-applied');
  assert.equal((await applyQqbridgePatch({ ...options, check: true })).status, 'already-applied');
  assert.deepEqual(await tree(options.sourceDir), installed);
});

test('原文件漂移和伪装成已打补丁的额外改动都被拒绝', async t => {
  const { options } = await fixture(t);
  await writeFile(join(options.sourceDir, 'src/bridge.js'), before + '// local edit\n');
  const originalTree = await tree(options.sourceDir);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('BASELINE_MISMATCH'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
  await writeFile(join(options.sourceDir, 'src/bridge.js'), after + '// unrelated edit\n');
  const modifiedTree = await tree(options.sourceDir);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('BASELINE_MISMATCH'));
  assert.deepEqual(await tree(options.sourceDir), modifiedTree);
});

test('补丁缺失清晰失败，dry-run 冲突不改变任何源文件', async t => {
  const { options } = await fixture(t);
  const originalTree = await tree(options.sourceDir);
  await rm(options.patchPath);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('PATCH_MISSING'));
  // Change the hunk's expected source while keeping the fixture baseline correct.
  await writeFile(options.patchPath, patch.replace("mode = 'dsh'", "mode = 'missing'"));
  await assert.rejects(applyQqbridgePatch(options), expectedCode('PATCH_REJECTED'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
});

test('既有不同 overlay 不覆盖；已打补丁但缺 overlay 不冒充安装完成', async t => {
  const { options } = await fixture(t);
  await writeFile(join(options.sourceDir, 'src/adapter.mjs'), '// user-owned different code\n');
  const originalTree = await tree(options.sourceDir);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('OVERLAY_CONFLICT'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
  await rm(join(options.sourceDir, 'src/adapter.mjs'));
  await writeFile(join(options.sourceDir, 'src/bridge.js'), after);
  const incompleteTree = await tree(options.sourceDir);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('INCOMPLETE_INSTALL'));
  assert.deepEqual(await tree(options.sourceDir), incompleteTree);
});

test('拒绝补丁改动 config 等范围外文件', async t => {
  const { options } = await fixture(t);
  const originalTree = await tree(options.sourceDir);
  await writeFile(options.patchPath, patch + `diff --git a/config.json b/config.json
--- a/config.json
+++ b/config.json
@@ -1 +1 @@
-{"keep":"user-config"}
+{"keep":"overwritten"}
`);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('PATCH_SCOPE'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
});

test('发布第二个 overlay 出错，已改 bridge 和已创建 overlay 都回滚', async t => {
  const { options } = await fixture(t);
  const originalTree = await tree(options.sourceDir);
  let creations = 0;
  await assert.rejects(applyQqbridgePatch(options, {
    createFile: async (from, to) => {
      if (++creations === 2) throw Object.assign(new Error('simulated disk error'), { code: 'EIO' });
      await link(from, to);
    },
  }), expectedCode('INSTALL_FAILED'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
  assert.equal((await applyQqbridgePatch(options)).status, 'applied');
});

test('目标 symlink 不能让安装写出源码树，遗留安装锁不会被本次调用删除', async t => {
  const { options, root } = await fixture(t);
  const outside = join(root, 'outside.mjs');
  await writeFile(outside, 'outside must stay unchanged\n');
  await symlink(outside, join(options.sourceDir, 'src/adapter.mjs'));
  await assert.rejects(applyQqbridgePatch(options), expectedCode('UNSAFE_PATH'));
  assert.equal(await readFile(outside, 'utf8'), 'outside must stay unchanged\n');
  await rm(join(options.sourceDir, 'src/adapter.mjs'));
  const lock = join(options.sourceDir, '.qqbridge-dot-install.lock');
  await mkdir(lock);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('INSTALL_LOCKED'));
  assert.equal((await lstat(lock)).isDirectory(), true);
  assert.equal(await readFile(join(options.sourceDir, 'src/bridge.js'), 'utf8'), before);
});

test('真实 git checkout 即使 bridge blob 相同，HEAD 不匹配仍拒绝', async t => {
  const { options } = await fixture(t);
  await exec('git', ['init', '--quiet'], { cwd: options.sourceDir, timeout: 10_000 });
  await exec('git', ['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'local fixture'],
  { cwd: options.sourceDir, timeout: 10_000 });
  const originalTree = await tree(options.sourceDir);
  await assert.rejects(applyQqbridgePatch(options), expectedCode('HEAD_MISMATCH'));
  assert.deepEqual(await tree(options.sourceDir), originalTree);
});
