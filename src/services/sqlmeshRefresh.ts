import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execute = promisify(execFile);

/** Explicit refresh only; no shell interpolation, no plan/application commands. */
export async function refreshSqlmesh(options: {
  root: string; semanticDir: string; exporter: string; python?: string; gateway?: string; config?: string; environment?: string;
}): Promise<string> {
  const localPython = path.join(options.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = options.python || (fs.existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));
  const args = [options.exporter, '--project', options.root, '--semantic-dir', options.semanticDir];
  if (options.gateway) args.push('--gateway', options.gateway);
  if (options.config) args.push('--config', options.config);
  if (options.environment) args.push('--environment', options.environment);
  try {
    const { stdout } = await execute(python, args, { cwd: options.root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string; killed?: boolean };
    throw new Error(`SQLMesh export failed${err.killed ? ' (timed out)' : ''}. Check erdStudio.sqlmesh.pythonPath and the project environment. ${err.stderr?.slice(-2500) || err.message}`);
  }
}
