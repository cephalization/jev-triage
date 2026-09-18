/**
 * A streaming tar reader for a gzipped GitHub tarball: 512-byte headers, ustar prefixes, pax
 * and GNU long names, bodies padded to 512. Only the entries the caller wants are buffered;
 * everything else is skipped by counting bytes, so memory stays flat however big the repo is.
 */

export interface TarEntry {
  path: string;
  size: number;
  bytes: Uint8Array;
}

export interface TarOptions {
  /** Decide from the path and size before the body is read; false skips without buffering. */
  want: (path: string, size: number) => boolean;
  onEntry: (entry: TarEntry) => void;
}

const decoder = new TextDecoder();

function field(block: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && block[end] !== 0) end += 1;
  return decoder.decode(block.subarray(start, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const s = field(block, start, length).trim();
  return s ? parseInt(s, 8) : 0;
}

interface Body {
  path: string;
  size: number;
  /** Bytes still to consume, padding included. */
  left: number;
  /** "file" buffers for onEntry; "longname"/"pax" buffer for the next header; "skip" drops. */
  kind: "file" | "longname" | "pax" | "skip";
  chunks: Uint8Array[];
  got: number;
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Reads every entry; resolves to the number of entries handed to onEntry. */
export async function readTar(
  stream: ReadableStream<Uint8Array>,
  opts: TarOptions,
): Promise<number> {
  const reader = stream.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let entries = 0;
  let body: Body | null = null;
  let nextName: string | null = null;
  let zeroBlocks = 0;

  const finish = (b: Body) => {
    if (b.kind === "file") {
      opts.onEntry({ path: b.path, size: b.size, bytes: join(b.chunks, b.size) });
      entries += 1;
    } else if (b.kind === "longname") {
      nextName = decoder.decode(join(b.chunks, b.size)).replace(/\0+$/, "");
    } else if (b.kind === "pax") {
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(decoder.decode(join(b.chunks, b.size)));
      if (m?.[1] !== undefined) nextName = m[1];
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (pending.length === 0) pending = value;
    else {
      const next = new Uint8Array(pending.length + value.length);
      next.set(pending);
      next.set(value, pending.length);
      pending = next;
    }
    for (;;) {
      if (body) {
        const take = Math.min(pending.length, body.left);
        if (body.kind !== "skip") {
          const useful = Math.min(take, body.size - body.got);
          if (useful > 0) {
            body.chunks.push(pending.slice(0, useful));
            body.got += useful;
          }
        }
        pending = pending.subarray(take);
        body.left -= take;
        if (body.left > 0) break;
        finish(body);
        body = null;
        continue;
      }
      if (pending.length < 512) break;
      const block = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (block.every((b) => b === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) return entries;
        continue;
      }
      zeroBlocks = 0;
      const type = String.fromCharCode(block[156]!);
      const size = octal(block, 124, 12);
      const left = Math.ceil(size / 512) * 512;
      let name = field(block, 0, 100);
      if (field(block, 257, 6).startsWith("ustar")) {
        const prefix = field(block, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (nextName !== null) {
        name = nextName;
        nextName = null;
      }
      const kind: Body["kind"] =
        type === "L"
          ? "longname"
          : type === "x"
            ? "pax"
            : (type === "0" || type === "\0" || type === "") && opts.want(name, size)
              ? "file"
              : "skip";
      body = { path: name, size, left, kind, chunks: [], got: 0 };
      if (left === 0) {
        finish(body);
        body = null;
      }
    }
  }
  return entries;
}
