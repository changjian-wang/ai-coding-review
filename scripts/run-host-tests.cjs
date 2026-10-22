const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { access, mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
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
  const driver = path.join(root, 'driver');
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'test', 'snapshotHostIntegration.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], logLevel: 'warning',
    });
    // extensionTestsPath forces in-memory storage; use an isolated development-host driver for disk persistence.
    await mkdir(driver);
    await writeFile(path.join(driver, 'package.json'), JSON.stringify({
      name: 'review-host-driver', publisher: 'codereview-fixture', version: '0.0.0',
      engines: { vscode: '^1.90.0' }, activationEvents: ['onStartupFinished'], main: './driver.cjs',
      extensionDependencies: ['changjian-wang.ai-coding-review'],
    }));
    await writeFile(path.join(driver, 'driver.cjs'), `
      const vscode = require('vscode');
      exports.activate = async () => {
        try { await require(${JSON.stringify(bundle)}).run(); }
        catch (error) { console.error(error); }
        finally { await vscode.commands.executeCommand('workbench.action.quit'); }
      };
    `);
    const launch = async (phase) => {
      const { stdout, stderr } = await promisify(execFile)(executable, [
        '--new-window', '--disable-extensions', '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${path.join(root, 'profile')}`,
        `--extensions-dir=${path.join(root, 'extensions')}`,
        `--extensionDevelopmentPath=${path.resolve(__dirname, '..')}`,
        `--extensionDevelopmentPath=${driver}`, workspace,
      ], {
        timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CODEREVIEW_HOST_TEST_ROOT: workspace, CODEREVIEW_HOST_TEST_RESULT: output, CODEREVIEW_HOST_TEST_PHASE: phase },
      });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const result = JSON.parse(await readFile(output, 'utf8'));
      if (result.status !== 'passed') throw new Error(JSON.stringify(result));
      return result.checks;
    };
    const checks = [...await launch('initial'), ...await launch('restore')];
    console.log(`Real VS Code host: ${checks.join('; ')}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
