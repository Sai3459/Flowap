import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads a file from the backend, for the drift guards that compare a duplicated constant
 * against the source that owns it.
 *
 * Resolved from this module's own location rather than `process.cwd()`. The working directory
 * is whatever the runner happened to be launched from — `npm test` inside `frontend/` and
 * `vitest --root frontend` from the repository root give different answers — and a guard that
 * silently fails to find its comparison target is worse than no guard at all.
 *
 * Deliberately *not* `new URL('../../../backend/…', import.meta.url)`: Vite rewrites that form
 * into an asset import, and with a dynamic segment it becomes a glob over the whole backend
 * directory, which then fails on the first file outside the allowed serve root.
 */
const here = dirname(fileURLToPath(import.meta.url));

export const backendSource = (path: string): string =>
  readFileSync(resolve(here, '../../../backend', path), 'utf8');
