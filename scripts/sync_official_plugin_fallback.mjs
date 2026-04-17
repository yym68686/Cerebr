import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const marketRepoRoot = path.resolve(projectRoot, '..', 'cerebr-plugins');
const syncScriptPath = path.join(marketRepoRoot, 'scripts', 'sync-cerebr-fallback.mjs');

const child = spawnSync(
    process.execPath,
    [syncScriptPath, '--target', projectRoot, ...process.argv.slice(2)],
    {
        stdio: 'inherit',
    }
);

if (child.error) {
    console.error(child.error.message);
    process.exitCode = 1;
} else {
    process.exitCode = child.status ?? 1;
}
