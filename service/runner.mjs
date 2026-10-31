import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './schema.mjs';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT_LIMIT = 131_072;

export class WorkerRunner {
  constructor({ python = 'python3', args = ['-m', 'ghost_replay.web_worker'], cwd = APP_ROOT } = {}) {
    // Constructor options are operator/test code only; never populated from HTTP input.
    this.python = python; this.args = args; this.cwd = cwd; this.children = new Set();
  }
  get activePids() { return [...this.children].map(child => child.pid).filter(Boolean); }
  execute(data, { signal, timeoutMs = 8_000, check = false } = {}) {
    if (signal?.aborted) return Promise.reject(new HttpError(503, 'cancelled', 'The operation was cancelled.'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [...this.args, ...(check ? ['--check'] : [])], {
        cwd: this.cwd, detached: process.platform !== 'win32', shell: false,
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      let chunks = [], bytes = 0, stderrBytes = 0, stopped = null, killer, settled = false;
      const signalGroup = signal => {
        if (!child.pid) return;
        try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {}
      };
      const terminate = () => {
        if (!child.pid) return;
        // A reaped group leader does not imply that its descendants or inherited
        // pipes are gone. Always signal the process group, including after exit.
        signalGroup('SIGTERM');
        killer ??= setTimeout(() => {
          signalGroup('SIGKILL');
        }, 250);
      };
      const stop = error => { stopped ??= error; terminate(); };
      child.stop = stop;
      const abort = () => stop(signal?.reason instanceof HttpError ? signal.reason : new HttpError(503, 'cancelled', 'The operation was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(new HttpError(504, 'run_timeout', 'The experiment exceeded its time budget.')), Math.min(8_000, timeoutMs));
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', abort); this.children.delete(child);
      };
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) stop(new HttpError(502, 'worker_output', 'The experiment could not produce a bounded result.'));
        else chunks.push(chunk);
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > 8_192) stop(new HttpError(502, 'worker_failed', 'The experiment could not complete.'));
      });
      child.stdin.on('error', () => {});
      child.on('error', () => {
        stopped ??= new HttpError(503, 'worker_unavailable', 'The experiment worker is unavailable.');
      });
      // No work may survive the fixed worker's main process, even if a future
      // adapter creates descendants that close or retain the stdio pipes.
      child.on('exit', () => signalGroup('SIGKILL'));
      child.on('close', code => {
        if (settled) return; settled = true; cleanup();
        if (stopped) return reject(stopped);
        if (code !== 0) return reject(new HttpError(502, 'worker_failed', 'The experiment could not complete.'));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (check ? parsed.ready !== true : !parsed.buggy?.result?.complete || !parsed.fixed?.result?.complete) throw new Error('bad worker envelope');
          resolve(parsed);
        } catch { reject(new HttpError(502, 'worker_output', 'The experiment returned an invalid result.')); }
      });
      child.stdin.end(check ? '' : JSON.stringify(data));
      if (signal?.aborted) abort();
    });
  }
  async shutdown() {
    const children = [...this.children];
    await Promise.all(children.map(child => new Promise(resolve => {
      child.once('close', resolve);
      child.stop(new HttpError(503, 'shutting_down', 'The service is shutting down.'));
    })));
  }
}
