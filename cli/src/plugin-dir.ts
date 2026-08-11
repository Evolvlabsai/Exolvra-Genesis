import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './exit.js';
import { pathKind } from './input.js';

/**
 * The plugin markdown, read from disk at runtime.
 *
 * Constraint C3: the loop lives in these files and nowhere else. The CLI is
 * transport — it loads them, it never restates them.
 */
export interface PluginSources {
  runMd: string;
  builderMd: string;
  criticMd: string;
  dir: string;
}

/** Paths, relative to the plugin directory, of the files that must be present. */
export const PLUGIN_FILES = {
  runMd: 'commands/run.md',
  builderMd: 'agents/builder.md',
  criticMd: 'agents/critic.md',
} as const;

export const PLUGIN_DIR_ENV = 'GAUNTLET_PLUGIN_DIR';

/**
 * Where the published package carries its copy of the markdown, relative to the
 * compiled modules. The files are copied here by the build and shipped by
 * `files: ["dist"]`, so an installed package has them without depending on
 * anything outside itself.
 */
export const PACKAGED_PLUGIN_SUBDIR = 'plugin';

/**
 * Directories to try, in order: the `GAUNTLET_PLUGIN_DIR` override (and nothing
 * else, when it is set), then the installed package root, then the repository
 * root when running from source, then the copy the package ships.
 *
 * The repository comes before the shipped copy on purpose: when both exist —
 * which is only ever true inside this repo — the files being edited win over a
 * copy taken at build time, so what runs can never lag what is on disk.
 */
export function pluginDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env[PLUGIN_DIR_ENV]?.trim();
  if (override !== undefined && override !== '') return [resolve(override)];

  const moduleDir = dirname(fileURLToPath(import.meta.url)); // <package>/dist
  const packageRoot = dirname(moduleDir); //                    <package>
  const repoRoot = dirname(packageRoot); //                     <repo>, package lives at <repo>/cli
  return [packageRoot, repoRoot, join(moduleDir, PACKAGED_PLUGIN_SUBDIR)];
}

/**
 * Why `dir` cannot serve as the plugin directory, or undefined when it can.
 * The reason is specific — a path that is absent, a path that is a file, and a
 * directory that is simply missing one of the three files are different faults
 * and are reported as different faults.
 */
function unusableReason(dir: string): string | undefined {
  const kind = pathKind(dir);
  if (kind === 'missing') return 'does not exist';
  if (kind !== 'directory') return 'is not a directory';

  for (const relative of Object.values(PLUGIN_FILES)) {
    if (pathKind(join(dir, relative)) !== 'file') return 'missing ' + relative;
  }
  return undefined;
}

/**
 * Reads one of the three files, or says which one could not be read and why.
 *
 * A file that exists is not a file that can be read: a permission bit, a broken
 * link, or a directory that lost its contents mid-read all fail here. Each is a
 * configuration fault the user has to fix — exit 2 — and none of them may leave
 * this module as a bare errno for something further out to guess at.
 */
function readPluginFile(dir: string, relative: string): string {
  try {
    return readFileSync(join(dir, relative), 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      [
        'could not read the Gauntlet plugin markdown',
        '',
        `${relative} is in ${dir} but could not be read:`,
        `  ${reason}`,
        '',
        `Check that the file is readable, or point ${PLUGIN_DIR_ENV}, or --plugin-dir,`,
        'at another directory that holds the three files.',
      ].join('\n'),
    );
  }
}

export function loadPluginSources(
  env: NodeJS.ProcessEnv = process.env,
): PluginSources {
  const candidates = pluginDirCandidates(env);
  const misses: string[] = [];

  for (const dir of candidates) {
    const unusable = unusableReason(dir);
    if (unusable === undefined) {
      return {
        dir,
        runMd: readPluginFile(dir, PLUGIN_FILES.runMd),
        builderMd: readPluginFile(dir, PLUGIN_FILES.builderMd),
        criticMd: readPluginFile(dir, PLUGIN_FILES.criticMd),
      };
    }
    misses.push(`  ${dir} (${unusable})`);
  }

  const wanted = Object.values(PLUGIN_FILES).join(', ');
  throw new ConfigError(
    [
      'could not load the Gauntlet plugin markdown',
      '',
      `${wanted} were not all found in:`,
      ...misses,
      '',
      `Point ${PLUGIN_DIR_ENV}, or --plugin-dir, at the directory that holds them.`,
    ].join('\n'),
  );
}
