import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { HttpError } from './schema.mjs';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT_LIMIT = 131_072;

async function groupActive(pid, deadline) {
  try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'linux') return true;
  const self = await readFile('/proc/self/stat', 'utf8');
  if (Number(self.slice(0, self.indexOf(' '))) !== process.pid) return true;
  // SIGKILL delivery is asynchronous. On a matching Linux PID view, a zombie has already closed its
  // descriptors, even while the host's init is still reaping the orphan.
  for (const entry of await readdir('/proc')) {
    if (performance.now() >= deadline) throw new Error('worker group inspection budget exhausted');
    if (!/^[0-9]+$/.test(entry)) continue;
    let text;
    try { text = await readFile(`/proc/${entry}/stat`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
  }
  return false;
}

async function waitForGroupStop(pid) {
  const deadline = performance.now() + 400;
  do {
    if (!await groupActive(pid, deadline)) return;
    await delay(10);
  } while (performance.now() < deadline);
  throw new Error('worker group did not stop');
}

export class WorkerRunner {
  constructor({ python = 'python3', args = ['-m', 'ghost_replay.web_worker'], cwd = APP_ROOT } = {}) {
    // Constructor options are operator/test code only; never populated from HTTP input.
    this.python = python; this.args = args; this.cwd = cwd; this.children = new Set(); this.pending = new Set(); this.healthy = true;
  }
  get activePids() { return [...this.children].map(child => child.pid).filter(Boolean); }
  execute(data, { signal, timeoutMs = 8_000, check = false } = {}) {
    if (!this.healthy) return Promise.reject(new HttpError(503, 'worker_unavailable', 'The experiment worker is unavailable.'));
    if (signal?.aborted) return Promise.reject(new HttpError(503, 'cancelled', 'The operation was cancelled.'));
    const completion = new Promise((resolve, reject) => {
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
      child.on('close', async code => {
        if (settled) return; settled = true;
        signalGroup('SIGKILL');
        try { if (child.pid && process.platform !== 'win32') await waitForGroupStop(child.pid); }
        catch {
          this.healthy = false;
          stopped = new HttpError(503, 'worker_cleanup', 'The experiment worker is unavailable.');
        }
        cleanup();
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
    this.pending.add(completion);
    completion.then(() => this.pending.delete(completion), () => this.pending.delete(completion));
    return completion;
  }
  async shutdown() {
    const pending = [...this.pending];
    for (const child of this.children) child.stop(new HttpError(503, 'shutting_down', 'The service is shutting down.'));
    await Promise.allSettled(pending);
  }
}
