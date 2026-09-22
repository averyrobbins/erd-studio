import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execute = promisify(execFile);

/** The same explicit command is used by the editor and source-plan assistants. */
export function sqlmeshRefreshCommand(options: {
  root: string; semanticDir: string; exporter: string; python?: string; gateway?: string; config?: string; environment?: string;
}): { executable: string; args: string[] } {
  const localPython = path.join(options.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const executable = options.python || (fs.existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));
  const args = [options.exporter, '--project', options.root, '--semantic-dir', options.semanticDir];
  if (options.gateway) args.push('--gateway', options.gateway);
  if (options.config) args.push('--config', options.config);
  if (options.environment) args.push('--environment', options.environment);
  return { executable, args };
}

/** Default for `erdStudio.sqlmesh.exportTimeoutSeconds`; the setting's floor keeps a typo from killing every export. */
export const DEFAULT_EXPORT_TIMEOUT_SECONDS = 600;
export const MIN_EXPORT_TIMEOUT_SECONDS = 30;

/** The timeout the exporter runs under, in milliseconds, from the setting's raw value. */
export function exportTimeoutMs(seconds: unknown): number {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_EXPORT_TIMEOUT_SECONDS;
  return Math.max(MIN_EXPORT_TIMEOUT_SECONDS, Math.floor(value)) * 1000;
}

/**
 * Explicit refresh only; no shell interpolation, no plan/application commands.
 *
 * `signal` aborts the exporter (the progress notification's Cancel); `timeoutMs`
 * kills it after that long — loading a project and inferring every model's
 * columns is unbounded work on a large project, which is why it is a setting.
 */
export async function refreshSqlmesh(options: {
  root: string; semanticDir: string; exporter: string; python?: string; gateway?: string; config?: string; environment?: string;
  timeoutMs?: number; signal?: AbortSignal;
}): Promise<string> {
  const { executable: python, args } = sqlmeshRefreshCommand(options);
  const timeout = options.timeoutMs ?? exportTimeoutMs(undefined);
  try {
    const { stdout } = await execute(python, args, {
      cwd: options.root, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...(options.signal ? { signal: options.signal } : {}),
    });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string; killed?: boolean; code?: unknown; name?: string };
    if (options.signal?.aborted) throw new Error('SQLMesh export cancelled. The previous metadata is unchanged.');
    const timedOut = err.killed && !options.signal?.aborted;
    const reason = timedOut
      ? ` (timed out after ${Math.round(timeout / 1000)} s — raise erdStudio.sqlmesh.exportTimeoutSeconds for a large project)`
      : '';
    throw new Error(`SQLMesh export failed${reason}. Check erdStudio.sqlmesh.pythonPath and the project environment. ${err.stderr?.slice(-2500) || err.message}`);
  }
}
