#!/usr/bin/env node
// pnpm native:build — build the native programs with the pinned Rust toolchain (native/rust-toolchain.toml,
// Cargo.lock --locked) and the fixed BPF object with clang; print versions and a sha256 manifest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const N = path.join(ROOT, "native");
// Path-independent output: the checkout path and the cargo home are remapped, so the same commit builds byte-identical
// binaries and BPF object from any directory (debug info / panic locations otherwise embed absolute paths).
const CARGO_HOME = process.env.CARGO_HOME ?? `${process.env.HOME}/.cargo`;
const RUSTFLAGS = [process.env.RUSTFLAGS ?? "", `--remap-path-prefix=${N}=/agentos/native`, `--remap-path-prefix=${CARGO_HOME}=/cargo`].join(" ").trim();
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`, RUSTFLAGS, SOURCE_DATE_EPOCH: "0" };
const sh = (cmd, args, cwd = N) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
sh("cargo", ["build", "--release", "--locked", "--workspace"]);
sh("clang", ["-O2", "-g", `-ffile-prefix-map=${N}=/agentos/native`, "-fdebug-compilation-dir=/agentos/native", "-target", "bpf", "-D__TARGET_ARCH_x86", "-I/usr/include/x86_64-linux-gnu", "-c", "bpf/exec_exit.bpf.c", "-o", "bpf/exec_exit.bpf.o"]);
const files = ["target/release/agentos-broker", "target/release/agentos-worker", "target/release/agentos-provider-user", "target/release/agentos-telemetry", "target/release/agentos-serial-sim", "bpf/exec_exit.bpf.o"];
const manifest = {
  builtAt: new Date().toISOString(),
  rustc: sh("rustc", ["--version"]).trim(),
  cargo: sh("cargo", ["--version"]).trim(),
  clang: sh("clang", ["--version"]).split("\n")[0],
  cargoLockSha256: createHash("sha256").update(fs.readFileSync(path.join(N, "Cargo.lock"))).digest("hex"),
  files: Object.fromEntries(files.map((f) => [f, createHash("sha256").update(fs.readFileSync(path.join(N, f))).digest("hex")])),
};
fs.writeFileSync(path.join(N, "target", "release", "NATIVE_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
