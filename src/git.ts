import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// Git is read-only; disable repository-configured fsmonitor command execution.
function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', [
      '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args,
    ], {
      encoding: 'utf8', timeout: 8_000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch { return null; }
}

export function gitIdentity(root: string): { commitSha: string | null; dirty: boolean | null } {
  // A nested directory may inherit metadata from a parent repository; never claim it as its own.
  const detected = git(root, ['rev-parse', '--show-toplevel']);
  if (!detected) return { commitSha: null, dirty: null };
  try { if (realpathSync(detected) !== realpathSync(root)) return { commitSha: null, dirty: null }; }
  catch { return { commitSha: null, dirty: null }; }
  const commit = git(root, ['rev-parse', '--verify', 'HEAD']);
  const commitSha = commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
  return { commitSha, dirty: status === null ? null : status.length > 0 };
}
