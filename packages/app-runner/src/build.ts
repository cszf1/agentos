/**
 * Trusted builder entry (spec §12.2). Runs in the no-network builder container with the candidate's source mounted
 * read-only at /src. Platform-fixed TypeScript check and esbuild bundle; no tsconfig, plugins, scripts or env from
 * the app. The single output file goes back to the host over the bridge socket; nothing is written outside tmpfs.
 */
import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { connect } from "./frames.js";

const SOCKET = process.env.AGENTOS_SOCKET ?? "/run/agentos/host.sock";
const SRC_ROOT = "/src";
const ENTRY = "/src/src/app.ts";
const require = createRequire("/node_modules/");
const ts = require("typescript") as typeof import("typescript");
const esbuild = require("esbuild") as typeof import("esbuild");
const approved = JSON.parse(readFileSync("/opt/agentos/approved.json", "utf8")) as { specifiers: string[]; lockId: string };
const allowed = new Set<string>(["@agentos/app-sdk", ...approved.specifiers]);
const MAX_OUTPUT = 2 * 1024 * 1024;

const conn = await connect(SOCKET, 1024 * 1024, 4 * 1024 * 1024);

function fail(stage: string, diagnostics: { path: string; code: string; message: string }[]): never {
  conn.send("buildFailed", { stage, diagnostics: diagnostics.slice(0, 20) });
  setTimeout(() => process.exit(1), 100);
  throw new Error("build failed");
}

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail("source", [{ path: p.slice(SRC_ROOT.length), code: "SOURCE_PATH_INVALID", message: "symbolic links are not allowed" }]);
    if (st.isDirectory()) listSources(p, out);
    else if (st.isFile()) out.push(p);
    else fail("source", [{ path: p.slice(SRC_ROOT.length), code: "SOURCE_PATH_INVALID", message: "only regular files are allowed" }]);
  }
  return out;
}

try {
  const files = listSources(path.join(SRC_ROOT, "src"));
  if (!files.includes(ENTRY) || !statSync(ENTRY).isFile()) fail("source", [{ path: "/code/files/src/app.ts", code: "SOURCE_PATH_INVALID", message: "missing entry" }]);

  // 1. TypeScript check with fixed options.
  const options: import("typescript").CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts"],
    types: [],
    skipLibCheck: true,
    isolatedModules: true,
    noFallthroughCasesInSwitch: true,
    allowJs: false,
    resolveJsonModule: false,
    allowImportingTsExtensions: false,
    noImplicitOverride: true,
  };
  const program = ts.createProgram(files, options);
  const diags = ts.getPreEmitDiagnostics(program);
  if (diags.length > 0) {
    fail(
      "typecheck",
      diags.slice(0, 20).map((d) => {
        let where = "/code/files";
        if (d.file) {
          const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
          where = `/code/files/${d.file.fileName.replace(/^\/src\//, "")}:${line + 1}:${character + 1}`;
        }
        return { path: where, code: `TS${d.code}`, message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 500) };
      }),
    );
  }

  // 2. Bundle with esbuild; approved modules and the SDK stay external (supplied by the runtime image).
  const guard: import("esbuild").Plugin = {
    name: "agentos-import-guard",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        const spec = args.path;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const base = path.dirname(args.importer);
          let resolved = path.resolve(base, spec);
          if (!resolved.endsWith(".ts")) resolved = `${resolved}.ts`;
          if (!resolved.startsWith(`${SRC_ROOT}/src/`)) {
            return { errors: [{ text: `relative import "${spec}" leaves the bundle source` }] };
          }
          return { path: resolved };
        }
        if (allowed.has(spec)) return { path: spec, external: true };
        return { errors: [{ text: `DEPENDENCY_NOT_ALLOWED: import "${spec}" is not approved for ${approved.lockId}` }] };
      });
    },
  };
  let out: import("esbuild").BuildResult;
  try {
    out = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
      outfile: "/tmp/out/app.mjs",
      plugins: [guard],
      logLevel: "silent",
      minify: false,
      sourcemap: false,
      legalComments: "none",
      charset: "utf8",
      treeShaking: true,
      absWorkingDir: SRC_ROOT,
    });
  } catch (e) {
    const errs = (e as { errors?: { text: string; location?: { file: string; line: number; column: number } }[] }).errors ?? [];
    fail(
      "bundle",
      errs.slice(0, 20).map((x) => ({
        path: x.location ? `/code/files/${x.location.file.replace(/^src\//, "src/")}:${x.location.line}:${x.location.column}` : "/code/files",
        code: x.text.startsWith("DEPENDENCY_NOT_ALLOWED") ? "DEPENDENCY_NOT_ALLOWED" : "BUILD_FAILED",
        message: x.text.slice(0, 500),
      })),
    );
  }
  const files_ = out.outputFiles ?? [];
  if (files_.length !== 1) fail("bundle", [{ path: "/", code: "BUILD_FAILED", message: `expected one output file, got ${files_.length}` }]);
  const bytes = Buffer.from(files_[0]!.contents);
  if (bytes.length > MAX_OUTPUT) fail("bundle", [{ path: "/", code: "BUILD_FAILED", message: `output exceeds ${MAX_OUTPUT} bytes` }]);
  conn.send("buildOutput", {
    files: { "app.mjs": bytes.toString("base64") },
    compiler: { typescript: ts.version, esbuild: esbuild.version },
  });
  setTimeout(() => process.exit(0), 100);
} catch (e) {
  if ((e as Error).message !== "build failed") {
    conn.send("buildFailed", { stage: "internal", diagnostics: [{ path: "/", code: "BUILD_FAILED", message: String((e as Error).message).slice(0, 500) }] });
    setTimeout(() => process.exit(1), 100);
  }
}
