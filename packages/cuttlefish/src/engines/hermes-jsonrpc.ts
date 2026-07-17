// packages/cuttlefish/src/engines/hermes-jsonrpc.ts
import type { Writable, Readable } from "node:stream";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class HermesRpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifyCb?: (method: string, params: Record<string, unknown>) => void;
  private serverReqCb?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  private buf = "";

  constructor(private stdin: Writable, stdout: Readable) {
    stdout.on("data", (d: Buffer) => this.onData(d));
  }

  request<T = unknown>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.stdin.write(line);
    return p;
  }

  notify(method: string, params: object): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  onNotification(cb: (method: string, params: Record<string, unknown>) => void): void { this.notifyCb = cb; }
  onServerRequest(cb: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): void { this.serverReqCb = cb; }

  rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onData(d: Buffer): void {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as number | undefined;
    if (typeof id === "number" && (("result" in msg) || ("error" in msg))) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg && msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (typeof id === "number" && typeof msg.method === "string") {
      // server→client request: answer it
      try {
        const result = this.serverReqCb ? await this.serverReqCb(msg.method, (msg.params ?? {}) as Record<string, unknown>) : null;
        this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      } catch (e) {
        // Don't fake success on a failed server→client turn: send a real
        // JSON-RPC error response so the caller can tell the turn failed.
        const message = e instanceof Error ? e.message : String(e);
        this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
      }
      return;
    }
    if (typeof msg.method === "string") {
      this.notifyCb?.(msg.method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }
}
