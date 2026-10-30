const MAX_DEPTH = 32;

/** JSON text with duplicate keys, trailing junk, and non-finite numbers rejected. Objects have no prototype. */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const value = parseValue(0);
  skip();
  if (i !== text.length) throw new Error("trailing data");
  return value;

  function skip(): void {
    while (i < text.length) {
      const c = text[i];
      if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") return;
      i++;
    }
  }

  function parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error("nesting too deep");
    skip();
    if (i >= text.length) throw new Error("unexpected end");
    const c = text[i]!;
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "t") return literal("true", true);
    if (c === "f") return literal("false", false);
    if (c === "n") return literal("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    throw new Error("invalid JSON");
  }

  function literal(word: string, value: unknown): unknown {
    if (text.slice(i, i + word.length) !== word) throw new Error("invalid JSON");
    i += word.length;
    return value;
  }

  function parseObject(depth: number): Record<string, unknown> {
    i++;
    const out: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    skip();
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      skip();
      if (text[i] !== '"') throw new Error("object key must be a string");
      const key = parseString();
      if (seen.has(key)) throw new Error("duplicate key");
      seen.add(key);
      skip();
      if (text[i] !== ":") throw new Error("expected colon");
      i++;
      out[key] = parseValue(depth + 1);
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      throw new Error("expected comma or end of object");
    }
  }

  function parseArray(depth: number): unknown[] {
    i++;
    const out: unknown[] = [];
    skip();
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth + 1));
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      throw new Error("expected comma or end of array");
    }
  }

  function parseString(): string {
    i++;
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        i++;
        const e = text[i++];
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("bad unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw new Error("bad escape");
        continue;
      }
      if (c < " ") throw new Error("raw control character in string");
      out += c;
      i++;
    }
    throw new Error("unterminated string");
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (text[i]! >= "1" && text[i]! <= "9") {
      while (text[i]! >= "0" && text[i]! <= "9") i++;
    } else throw new Error("invalid number");
    if (text[i] === ".") {
      i++;
      if (text[i]! < "0" || text[i]! > "9") throw new Error("invalid number");
      while (text[i]! >= "0" && text[i]! <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (text[i]! < "0" || text[i]! > "9") throw new Error("invalid number");
      while (text[i]! >= "0" && text[i]! <= "9") i++;
    }
    const n = Number(text.slice(start, i));
    if (!Number.isFinite(n)) throw new Error("non-finite number");
    return n;
  }
}
