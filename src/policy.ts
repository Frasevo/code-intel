import { extname } from 'node:path';

// Deliberately conservative. This is an inventory, not a general-purpose file crawler.
const DENIED_DIRS = new Set([
  '.git', '.next', '.nuxt', '.output', '.cache', '.turbo', '.venv', '.ssh',
  '.pnpm-store', '.yarn', 'node_modules', 'vendor', 'dist', 'build', 'out',
  'coverage', 'tmp', 'temp', '__pycache__', '.idea', '.vscode', '.vercel',
  '.wrangler', '.serverless', 'target', 'artifacts',
]);
const DENIED_SEGMENT = /(^|[._-])(secret|secrets|credential|credentials|private[-_]?key|access[-_]?token)([._-]|$)/i;
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.html', '.css', '.scss', '.sql', '.py', '.yaml', '.yml',
]);
const DENIED_SUFFIXES = [
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.asc', '.gpg',
  '.sqlite', '.sqlite3', '.db', '.log', '.map', '.lock',
];

export function normalizedRelativePath(raw: string): string | null {
  if (!raw || raw.length > 2048 || raw.includes('\0')) return null;
  // A normalized artifact path must be a relative POSIX path; never fix attacker input silently.
  if (raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function permittedPath(relative: string): boolean {
  const path = normalizedRelativePath(relative);
  if (path === null) return false;
  const segments = path.split('/');
  if (segments.slice(0, -1).some((x) => DENIED_DIRS.has(x.toLowerCase()) || DENIED_SEGMENT.test(x) || x.toLowerCase().startsWith('.env'))) return false;
  const base = segments.at(-1)!.toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env-')) return false;
  if (base.startsWith('.npmrc') || base === '.pypirc' || base === '.netrc') return false;
  if (base === 'id_rsa' || base === 'id_ed25519' || base === 'credentials.json') return false;
  if (DENIED_SEGMENT.test(base)) return false;
  if (DENIED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return false;
  if (base === 'pnpm-lock.yaml' || base === 'package-lock.json' || base === 'yarn.lock') return false;
  return SOURCE_EXTENSIONS.has(extname(base));
}

export function permittedDirectory(relative: string): boolean {
  const path = normalizedRelativePath(relative);
  return path !== null && path.split('/').every((part) => !DENIED_DIRS.has(part.toLowerCase()) && !DENIED_SEGMENT.test(part) && !part.toLowerCase().startsWith('.env'));
}

export function languageFor(path: string): string {
  const extension = extname(path).toLowerCase();
  const families: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.md': 'markdown', '.mdx': 'markdown', '.html': 'html',
    '.css': 'css', '.scss': 'css', '.sql': 'sql', '.py': 'python',
    '.yaml': 'yaml', '.yml': 'yaml',
  };
  return families[extension] ?? 'unknown';
}
