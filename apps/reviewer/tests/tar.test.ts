import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vite-plus/test";
import { wanted } from "../src/snapshot-rules.ts";
import { readTar, type TarEntry } from "../src/tar.ts";

/** A minimal ustar writer, enough to exercise long names and skipped bodies. */
function header(name: string, size: number, type = "0"): Uint8Array {
  const b = new Uint8Array(512);
  const put = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
  put(0, name.slice(0, 100));
  put(100, "0000644\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  b.fill(32, 148, 156);
  let sum = 0;
  for (const x of b) sum += x;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return b;
}

function entry(name: string, body: string, type = "0"): Uint8Array[] {
  const bytes = new TextEncoder().encode(body);
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return [header(name, bytes.length, type), padded];
}

function tarball(parts: Uint8Array[][]): ReadableStream<Uint8Array> {
  const all = [...parts.flat(), new Uint8Array(1024)];
  const raw = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    raw.set(p, at);
    at += p.length;
  }
  const gz = gzipSync(raw);
  // Feed it in awkward chunk sizes so header and body boundaries land mid-chunk.
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < gz.length; i += 700) c.enqueue(gz.subarray(i, i + 700));
      c.close();
    },
  }).pipeThrough(new DecompressionStream("gzip"));
}

describe("tar reader", () => {
  test("reads wanted files, skips the rest, handles GNU long names and pax paths", async () => {
    const longPath = `root/${"deep/".repeat(30)}file.ts`;
    const parts = [
      entry("root/src/a.ts", "export const a = 1;\n"),
      entry("root/big.bin", "x".repeat(2000)),
      entry("root/dir/", "", "5"),
      entry("././@LongLink", `${longPath}\0`, "L"),
      entry(longPath.slice(0, 100), "long\n"),
      entry(
        "./PaxHeaders/x",
        `${`00 path=root/pax/named.py\n`.length + 3} path=root/pax/named.py\n`,
        "x",
      ),
      entry("root/pax/x", "print(1)\n"),
    ];
    const seen: TarEntry[] = [];
    const n = await readTar(tarball(parts), {
      want: (path, size) => size < 1000 && !path.endsWith("/"),
      onEntry: (e) => seen.push(e),
    });
    expect(n).toBe(3);
    expect(seen.map((e) => e.path)).toEqual(["root/src/a.ts", longPath, "root/pax/named.py"]);
    expect(new TextDecoder().decode(seen[0]!.bytes)).toBe("export const a = 1;\n");
    expect(new TextDecoder().decode(seen[2]!.bytes)).toBe("print(1)\n");
  });

  test("wanted() keeps source and drops vendored trees, binaries, lockfiles and big files", () => {
    expect(wanted("src/app.ts", 100)).toBe(true);
    expect(wanted("docs/guide.md", 100)).toBe(true);
    expect(wanted("node_modules/x/index.js", 100)).toBe(false);
    expect(wanted("assets/logo.png", 100)).toBe(false);
    expect(wanted("pnpm-lock.yaml", 100)).toBe(false);
    expect(wanted("src/huge.ts", 300 * 1024)).toBe(false);
    expect(wanted("src/empty.ts", 0)).toBe(false);
  });
});
