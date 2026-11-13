// File contents in the encrypted vault, in pieces of about 1 MB (one padded record each), so that
// large files are never held in memory at once.
import { concat, type Bytes } from '../core/util/bytes';
import type { FileSource } from '../core/xftp/file';
import type { Vault } from './vault';

/** with the 4-byte length of the record padding, a piece fills a 1 MB record */
export const PIECE_SIZE = 1048576 - 16;

const pieceName = (id: string, i: number) => `file:${id}:${i}`;

export const piecesFor = (size: number): number => Math.max(1, Math.ceil(size / PIECE_SIZE));

/** collects written bytes into pieces and stores each piece when it is full */
export class PieceWriter {
  private buf = new Uint8Array(PIECE_SIZE);
  private len = 0;
  pieces = 0;
  size = 0;

  constructor(
    private vault: Vault,
    private id: string,
  ) {}

  async write(b: Bytes): Promise<void> {
    for (let off = 0; off < b.length; ) {
      const n = Math.min(PIECE_SIZE - this.len, b.length - off);
      this.buf.set(b.subarray(off, off + n), this.len);
      this.len += n;
      off += n;
      this.size += n;
      if (this.len === PIECE_SIZE) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (!this.len) return;
    await this.vault.putBytes(pieceName(this.id, this.pieces), this.buf.slice(0, this.len));
    this.pieces++;
    this.len = 0;
  }

  /** stores the last piece; returns the number of pieces */
  async end(): Promise<number> {
    await this.flush();
    return this.pieces;
  }
}

/** stores a blob (a file chosen to send) */
export async function storeBlob(vault: Vault, id: string, blob: Blob): Promise<number> {
  const w = new PieceWriter(vault, id);
  for (let off = 0; off < blob.size; off += PIECE_SIZE) {
    await w.write(new Uint8Array(await blob.slice(off, off + PIECE_SIZE).arrayBuffer()));
  }
  return w.end();
}

/** reads a stored file as a source for uploading */
export function storedSource(vault: Vault, id: string, size: number): FileSource {
  let cached: { i: number; b: Bytes } | undefined;
  const piece = async (i: number): Promise<Bytes> => {
    if (cached?.i === i) return cached.b;
    const b = await vault.getBytes(pieceName(id, i));
    if (!b) throw new Error('the file is not stored in this browser');
    cached = { i, b };
    return b;
  };
  return {
    size,
    async read(offset: number, length: number): Promise<Bytes> {
      const parts: Bytes[] = [];
      for (let pos = offset; pos < offset + length; ) {
        const i = Math.floor(pos / PIECE_SIZE);
        const b = await piece(i);
        const start = pos - i * PIECE_SIZE;
        const n = Math.min(b.length - start, offset + length - pos);
        if (n <= 0) break;
        parts.push(b.subarray(start, start + n));
        pos += n;
      }
      return parts.length === 1 ? parts[0] : concat(...parts);
    },
  };
}

/** the stored pieces as blobs, so that the browser can keep large files out of memory */
export async function readPieceBlobs(vault: Vault, id: string, pieces: number): Promise<Blob[]> {
  const out: Blob[] = [];
  for (let i = 0; i < pieces; i++) {
    const b = await vault.getBytes(pieceName(id, i));
    if (!b) throw new Error('the file is not stored in this browser');
    out.push(new Blob([b as BlobPart]));
  }
  return out;
}

export async function deletePieces(vault: Vault, id: string, pieces: number): Promise<void> {
  for (let i = 0; i < pieces; i++) await vault.delBytes(pieceName(id, i));
}
