import net from "node:net";

/** Minimal copy of the host frame protocol (contracts/v2/runtime.ts); the images carry no host packages. */
export const PROTOCOL_VERSION = 1;
export interface Frame {
  protocolVersion: number;
  messageId: string;
  replyTo?: string;
  type: string;
  payload: unknown;
}

let seq = 0;
export function nextId(prefix: string): string {
  seq++;
  return `${prefix}-${process.pid}-${seq}`;
}

export function encode(f: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(f), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class Conn {
  #buf: Buffer = Buffer.alloc(0);
  #handlers: ((f: Frame) => void)[] = [];
  constructor(readonly sock: net.Socket, readonly maxIn: number, readonly maxOut: number) {
    sock.on("data", (chunk: Buffer) => {
      this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
      for (;;) {
        if (this.#buf.length < 4) break;
        const len = this.#buf.readUInt32BE(0);
        if (len > this.maxIn) {
          process.exit(70);
        }
        if (this.#buf.length < 4 + len) break;
        const text = this.#buf.subarray(4, 4 + len).toString("utf8");
        this.#buf = this.#buf.subarray(4 + len);
        let f: Frame;
        try {
          f = JSON.parse(text) as Frame;
        } catch {
          process.exit(70);
        }
        for (const h of this.#handlers) h(f);
      }
    });
  }
  onFrame(h: (f: Frame) => void): void {
    this.#handlers.push(h);
  }
  send(type: string, payload: unknown, replyTo?: string): boolean {
    const f: Frame = { protocolVersion: PROTOCOL_VERSION, messageId: nextId("r"), type, payload };
    if (replyTo !== undefined) f.replyTo = replyTo;
    const buf = encode(f);
    if (buf.length - 4 > this.maxOut) return false;
    this.sock.write(buf);
    return true;
  }
}

export function connect(path: string, maxIn: number, maxOut: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path });
    s.once("connect", () => resolve(new Conn(s, maxIn, maxOut)));
    s.once("error", reject);
  });
}
