import net from "node:net";
/** Minimal copy of the host frame protocol (contracts/v2/runtime.ts); the images carry no host packages. */
export const PROTOCOL_VERSION = 1;
let seq = 0;
export function nextId(prefix) {
    seq++;
    return `${prefix}-${process.pid}-${seq}`;
}
export function encode(f) {
    const body = Buffer.from(JSON.stringify(f), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return Buffer.concat([head, body]);
}
export class Conn {
    sock;
    maxIn;
    maxOut;
    #buf = Buffer.alloc(0);
    #handlers = [];
    constructor(sock, maxIn, maxOut) {
        this.sock = sock;
        this.maxIn = maxIn;
        this.maxOut = maxOut;
        sock.on("data", (chunk) => {
            this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
            for (;;) {
                if (this.#buf.length < 4)
                    break;
                const len = this.#buf.readUInt32BE(0);
                if (len > this.maxIn) {
                    process.exit(70);
                }
                if (this.#buf.length < 4 + len)
                    break;
                const text = this.#buf.subarray(4, 4 + len).toString("utf8");
                this.#buf = this.#buf.subarray(4 + len);
                let f;
                try {
                    f = JSON.parse(text);
                }
                catch {
                    process.exit(70);
                }
                for (const h of this.#handlers)
                    h(f);
            }
        });
    }
    onFrame(h) {
        this.#handlers.push(h);
    }
    send(type, payload, replyTo) {
        const f = { protocolVersion: PROTOCOL_VERSION, messageId: nextId("r"), type, payload };
        if (replyTo !== undefined)
            f.replyTo = replyTo;
        const buf = encode(f);
        if (buf.length - 4 > this.maxOut)
            return false;
        this.sock.write(buf);
        return true;
    }
}
export function connect(path, maxIn, maxOut) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({ path });
        s.once("connect", () => resolve(new Conn(s, maxIn, maxOut)));
        s.once("error", reject);
    });
}
