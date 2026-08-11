/**
 * Handing a file to whatever the operating system opens it with.
 *
 * One job, and one rule about it: opening the progress page is a convenience,
 * so failing to open it is a notice and never an error. A run that spends
 * minutes doing real work must not end because a browser was missing, a desktop
 * session was headless, or a handler was not registered — so nothing here
 * throws, and every outcome comes back as a value the caller reports.
 *
 * No file is read, written, or inspected here. The path is handed to the
 * platform's own handler exactly as given.
 */
import { spawn } from 'node:child_process';

/** The program that opens a file on this platform, and the arguments before it. */
export interface Opener {
  command: string;
  /** Arguments that precede the path. */
  args: string[];
}

export type OpenOutcome =
  | { opened: true; command: string }
  | { opened: false; command: string; reason: string };

export interface OpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * The handler for a platform, in the spelling each one uses.
 *
 * Windows has no opener program: `start` is a builtin of the command
 * interpreter, so the interpreter is what runs, and the empty argument after
 * `start` is the window title it would otherwise take the path for — a path in
 * quotes is read as a title and nothing opens. The interpreter is taken from
 * the environment rather than assumed, because a system that moved it has moved
 * it for everything.
 */
export function openerFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): Opener {
  if (platform === 'win32') {
    const shell = env['ComSpec'];
    return {
      command: shell === undefined || shell.trim() === '' ? 'cmd.exe' : shell,
      args: ['/c', 'start', ''],
    };
  }
  if (platform === 'darwin') return { command: 'open', args: [] };
  return { command: 'xdg-open', args: [] };
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : code;
  }
  return String(error);
}

/**
 * Opens `target` with the platform's handler and answers with what happened.
 *
 * Detached and with its streams thrown away, so a handler that outlives this
 * process — which every one of them does — neither keeps the run waiting nor
 * writes into the run's own output. The answer is not the handler's: it is
 * whether the handler could be started at all, which is the only part of this
 * the CLI is in a position to know.
 */
export async function openPath(
  target: string,
  options: OpenOptions = {},
): Promise<OpenOutcome> {
  const platform = options.platform ?? process.platform;
  const { command, args } = openerFor(platform, options.env ?? process.env);

  return new Promise<OpenOutcome>((resolve) => {
    let settled = false;
    const answer = (outcome: OpenOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child;
    try {
      child = spawn(command, [...args, target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      // A synchronous refusal: the arguments themselves were unusable.
      answer({ opened: false, command, reason: reasonOf(error) });
      return;
    }

    // A handler that is not installed fails after the call returns, as an
    // event. Both endings are listened for, so neither one can reach the
    // process as an unhandled error over a page nobody has to see.
    child.once('error', (error: unknown) => {
      answer({ opened: false, command, reason: reasonOf(error) });
    });
    child.once('spawn', () => {
      child.unref();
      answer({ opened: true, command });
    });
  });
}
