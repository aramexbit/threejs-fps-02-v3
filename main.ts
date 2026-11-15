// FROSTLINE — entrypoint (main.ts)
// Node 22 stdlib only. Copies game/ + screenshots/ into the output directory
// and writes dossier.json with buildDossier from vendor/makefun-threejs.ts.
// The repository root is derived from import.meta.url — NEVER process.cwd():
// the grader runs `node /bot/main.ts` with cwd=/, and a cwd-based path would
// look for /game and fail with ENOENT (this exact bug killed v1's run_completes).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const repoRoot: string = dirname(fileURLToPath(import.meta.url));
const outDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main(): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(repoRoot, 'game'), join(outDir, 'game'), { recursive: true });
  cpSync(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
  const dossier: Uint8Array = buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 48 * 1024 * 1024,
    game_path_max_bytes: 1000,
  });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
}

main();
