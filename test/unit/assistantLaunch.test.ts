import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assistantEnvironment, findVenvBinDir, resolveExecutable } from '../../src/services/assistantLaunch';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-launch-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveExecutable', () => {
  it('finds the first matching file on the search path', () => {
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'claude'), '');
    expect(resolveExecutable('claude', [a, b].join(path.delimiter), 'linux')).toBe(path.join(b, 'claude'));
    expect(resolveExecutable('nope', [a, b].join(path.delimiter), 'linux')).toBeUndefined();
    expect(resolveExecutable('claude', '', 'linux')).toBeUndefined();
  });

  it('ignores a directory of the same name and empty path entries', () => {
    const a = path.join(root, 'a');
    fs.mkdirSync(path.join(a, 'claude'), { recursive: true });
    expect(resolveExecutable('claude', ['', a, ''].join(path.delimiter), 'linux')).toBeUndefined();
  });

  it('honours PATHEXT on Windows, where claude is claude.cmd', () => {
    const a = path.join(root, 'a');
    fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, 'claude.cmd'), '');
    expect(resolveExecutable('claude', a, 'win32', '.COM;.EXE;.BAT;.CMD')).toBe(path.join(a, 'claude.cmd'));
    expect(resolveExecutable('claude', a, 'win32', '.EXE')).toBeUndefined();
    expect(resolveExecutable('claude', a, 'linux')).toBeUndefined();
  });

  it('accepts an absolute path that exists', () => {
    const file = path.join(root, 'claude');
    fs.writeFileSync(file, '');
    expect(resolveExecutable(file, '', 'linux')).toBe(file);
    expect(resolveExecutable(path.join(root, 'missing'), '', 'linux')).toBeUndefined();
  });
});

describe('assistantEnvironment', () => {
  it('is empty when the project has no environment to offer', () => {
    expect(assistantEnvironment({ workspaceRoot: root, basePath: '/usr/bin', platform: 'linux' })).toEqual({});
    expect(findVenvBinDir(root, 'linux')).toBeUndefined();
  });

  it('puts the configured interpreter and the project venv first on PATH', () => {
    fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
    const env = assistantEnvironment({ workspaceRoot: root, pythonPath: '/opt/py/bin/python', basePath: '/usr/bin', platform: 'linux' });
    expect(env.PATH.split(path.delimiter)).toEqual(['/opt/py/bin', path.join(root, '.venv', 'bin'), '/usr/bin']);
    expect(env.VIRTUAL_ENV).toBe(path.join(root, '.venv'));
  });

  it('does not list the venv twice when the configured interpreter lives in it', () => {
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    const env = assistantEnvironment({ workspaceRoot: root, pythonPath: path.join(root, 'venv', 'bin', 'python'), basePath: '', platform: 'linux' });
    expect(env.PATH.split(path.delimiter)).toEqual([path.join(root, 'venv', 'bin')]);
  });

  it('ignores a relative pythonPath such as python3', () => {
    const env = assistantEnvironment({ workspaceRoot: root, pythonPath: 'python3', basePath: '/usr/bin', platform: 'linux' });
    expect(env).toEqual({});
  });
});
