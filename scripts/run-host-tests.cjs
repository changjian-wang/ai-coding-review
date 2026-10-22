const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { access, mkdtemp, mkdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const executable = process.env.VSCODE_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error('Set VSCODE_EXECUTABLE to the absolute VS Code executable path; this test does not download or install VS Code.');
  }
  await access(executable);
  const root = await mkdtemp(path.join(tmpdir(), 'codereview-host-tests-'));
  const workspace = path.join(root, 'workspace');
  const output = path.join(root, 'result.json');
  await mkdir(workspace);
  const bundle = path.join(root, 'integration.cjs');
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'test', 'snapshotHostIntegration.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], logLevel: 'warning',
    });
    const { stdout, stderr } = await promisify(execFile)(executable, [
      '--new-window', '--disable-extensions', '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes',
      `--user-data-dir=${path.join(root, 'profile')}`,
      `--extensions-dir=${path.join(root, 'extensions')}`,
      `--extensionDevelopmentPath=${path.resolve(__dirname, '..')}`,
      `--extensionTestsPath=${bundle}`, workspace,
    ], {
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEREVIEW_HOST_TEST_ROOT: workspace, CODEREVIEW_HOST_TEST_RESULT: output },
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const result = JSON.parse(await readFile(output, 'utf8'));
    if (result.status !== 'passed') throw new Error(JSON.stringify(result));
    console.log(`Real VS Code host: ${result.checks.join('; ')}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
