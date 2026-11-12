// Direct TCP connector for running the client in Node (tests).
import net from 'node:net';
import { ChunkQueue, type Stream } from '../../src/core/net/stream';
import type { Connector } from '../../src/core/smp/client';

export function tcpStream(host: string, port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const q = new ChunkQueue();
    const sock = net.connect({ host, port }, () => {
      resolve({
        read: () => q.read(),
        write: (b) => {
          sock.write(b);
        },
        close: () => sock.destroy(),
      });
    });
    sock.on('data', (d) => q.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()));
    sock.on('error', (e) => {
      q.end(e);
      reject(e);
    });
    sock.on('close', () => q.end());
  });
}

export const tcpConnector: Connector = { connect: tcpStream };
