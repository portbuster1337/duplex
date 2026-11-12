// Drives the official SimpleX Chat CLI (simplex-chat -p PORT) through its WebSocket API, for
// interoperability tests.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_BIN = process.env.SIMPLEX_CHAT_BIN ?? 'simplex-chat';
const DATA_DIR = process.env.CLI_DATA_DIR ?? path.join(os.tmpdir(), 'duplex-cli');

export interface CliEvent {
  corrId?: string;
  resp: any;
}

export class Cli {
  private proc!: ChildProcess;
  private ws!: WebSocket;
  private corr = 0;
  private pending = new Map<string, (r: any) => void>();
  events: any[] = [];
  private waiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = [];
  log: string[] = [];

  constructor(
    readonly name: string,
    readonly port: number,
    readonly dir: string,
  ) {}

  /** server: the SMP server for new queues, or undefined for the preset servers of the SimpleX network */
  static async start(name: string, port: number, server: string | undefined, extra: string[] = []): Promise<Cli> {
    const dir = path.join(DATA_DIR, `${name}-${port}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const c = new Cli(name, port, dir);
    const net = server ? ['-s', server, '--smp-proxy', 'never', '--smp-web-port-servers', 'off'] : [];
    const args = ['-d', path.join(dir, 'db'), '-p', String(port), '--user-display-name', name, ...net, ...extra];
    c.proc = spawn(CLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    c.proc.stdout!.on('data', (d) => c.log.push(String(d)));
    c.proc.stderr!.on('data', (d) => c.log.push(String(d)));
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        await c.open();
        return c;
      } catch {
        // not listening yet
      }
    }
    throw new Error(`CLI ${name} did not start: ${c.log.join('')}`);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (process.env.DEBUG_CLI) console.log(`[cli ${this.name}]`, JSON.stringify(m).slice(0, 400));
        if (m.corrId && this.pending.has(m.corrId)) {
          this.pending.get(m.corrId)!(m.resp);
          this.pending.delete(m.corrId);
          return;
        }
        this.events.push(m.resp);
        for (const w of this.waiters.splice(0)) {
          if (w.pred(m.resp)) w.resolve(m.resp);
          else this.waiters.push(w);
        }
      };
    });
  }

  cmd(cmd: string): Promise<any> {
    const corrId = String(++this.corr);
    return new Promise((resolve) => {
      this.pending.set(corrId, resolve);
      this.ws.send(JSON.stringify({ corrId, cmd }));
    });
  }

  wait(pred: (e: any) => boolean, ms = 30000, label = 'event'): Promise<any> {
    const i = this.events.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CLI ${this.name}: timeout waiting for ${label}; recent events: ${this.events.map((e) => e.type).join(',')}`)), ms);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          const j = this.events.indexOf(e);
          if (j >= 0) this.events.splice(j, 1);
          resolve(e);
        },
      });
    });
  }

  waitType(type: string, ms?: number, pred: (e: any) => boolean = () => true): Promise<any> {
    return this.wait((e) => e?.type === type && pred(e), ms, type);
  }

  stop(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.proc?.kill('SIGTERM');
  }
}

/** text of the received chat items in a newChatItems event */
export function itemTexts(e: any): string[] {
  return (e?.chatItems ?? []).map((ci: any) => ci?.chatItem?.content?.msgContent?.text ?? ci?.chatItem?.meta?.itemText);
}
