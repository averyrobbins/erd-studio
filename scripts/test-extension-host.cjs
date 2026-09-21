// Local integration tests against an installed VS Code. No downloads, user
// settings, user projects, installed extensions, or GitHub Actions are touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const esbuild = require('esbuild');

async function main() {
  const repo = path.resolve(__dirname, '..');
  const code = process.env.VSCODE_EXECUTABLE || 'code';
  const python = process.env.SQLMESH_PYTHON || path.join(repo, '.venv-sqlmesh', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('Set SQLMESH_PYTHON to an absolute Python executable with integrations/sqlmesh/requirements-test.txt installed.');
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(repo, 'test/integration/tsconfig.json')], { cwd: repo, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(repo, 'esbuild.js')], { cwd: repo, stdio: 'inherit' });
  const suite = path.join(repo, 'out', 'integration', 'index.js');
  await esbuild.build({ entryPoints: [path.join(repo, 'test/integration/index.ts')], outfile: suite,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] });
  fs.copyFileSync(path.join(repo, 'dist/manifestWorker.js'), path.join(path.dirname(suite), 'manifestWorker.js'));
  for (const provider of ['sqlmesh', 'dbt']) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `erd-host-${provider}-`));
    const workspace = path.join(temp, 'project');
    const profile = path.join(temp, 'profile');
    fs.cpSync(path.join(repo, 'test/fixtures', `${provider}-project`), workspace, { recursive: true });
    if (provider === 'sqlmesh') fs.rmSync(path.join(workspace, '.erd-studio/sqlmesh.json'));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
      'erdStudio.provider': provider, 'erdStudio.sqlmesh.pythonPath': python,
      'erdStudio.feedback.aiAssist': false, 'erdStudio.feedback.trackReports': false,
      'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
      'extensions.autoUpdate': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    }));
    const log = fs.openSync(path.join(temp, 'host.log'), 'w');
    console.log(`Running ${provider} in an isolated VS Code profile; logs: ${temp}`);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(code, ['--new-window', '--wait', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${profile}`, `--extensions-dir=${path.join(temp, 'extensions')}`,
        `--extensionDevelopmentPath=${repo}`, `--extensionTestsPath=${suite}`, workspace], {
        cwd: repo, stdio: ['ignore', log, log],
        env: { ...process.env, ERD_HOST_TEST_REPO: repo, ERD_HOST_TEST_ROOT: temp, ERD_HOST_TEST_PROVIDER: provider, ERD_HOST_TEST_PYTHON: python },
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`VS Code host timed out; inspect ${temp}/host.log`)); }, 180_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    fs.closeSync(log);
    const reportPath = path.join(temp, 'results.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined;
    if (report) console.log(JSON.stringify(report, null, 2));
    if (result !== 0 || !report?.passed) throw new Error(`${provider} host checks failed; inspect ${temp}/host.log`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
