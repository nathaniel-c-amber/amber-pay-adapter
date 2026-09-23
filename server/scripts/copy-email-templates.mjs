// copy-email-templates.mjs
// Cross-platform build step: copies the Handlebars sources from
// src/services/shared/email into dist/services/shared/email so the compiled
// server can find them in production. `tsc` only emits JavaScript, and the
// runtime image ships `dist` alone (no `src`), so without this the engine would
// have nothing to render.
//
// Mirrors scripts/copy-migrations.mjs: uses fs.cpSync (Node 16.7+), so it works
// on Windows and POSIX.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const emailRoot = path.join(serverRoot, 'src', 'services', 'shared', 'email');
const assetDirs = ['partials', 'messages'];

for (const assetDir of assetDirs) {
  const srcDir = path.join(emailRoot, assetDir);
  if (!existsSync(srcDir)) {
    console.error(`[copy-email-templates] Source folder not found: ${srcDir}`);
    process.exit(1);
  }
  const distDir = path.join(serverRoot, 'dist', 'services', 'shared', 'email', assetDir);
  mkdirSync(distDir, { recursive: true });
  cpSync(srcDir, distDir, { recursive: true });
  console.log(`[copy-email-templates] Copied ${srcDir} -> ${distDir}`);
}
