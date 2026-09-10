// copy-migrations.mjs
// Cross-platform build step: copies the SQL migrations from src/db/migrations
// into dist/db/migrations so the compiled server can find them in production
// (M3). Uses fs.cpSync (Node 16.7+), so it works on Windows and POSIX.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const srcDir = path.join(serverRoot, 'src', 'db', 'migrations');
const distDir = path.join(serverRoot, 'dist', 'db', 'migrations');

if (!existsSync(srcDir)) {
  console.error(`[copy-migrations] Source migrations dir not found: ${srcDir}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
cpSync(srcDir, distDir, { recursive: true });

console.log(`[copy-migrations] Copied ${srcDir} -> ${distDir}`);