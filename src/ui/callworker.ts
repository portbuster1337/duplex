// The worker that encrypts and decrypts call media frames in browsers with RTCRtpScriptTransform
// (Firefox, Safari), or with streams transferred from createEncodedStreams.
import { pipeTransform, type TransformOperation } from './callcrypto';

interface TransformOptions {
  operation: TransformOperation;
  aesKey: string;
}

const ctx = self as unknown as {
  addEventListener(type: string, f: (e: any) => void): void;
  postMessage(m: unknown): void;
  RTCTransformEvent?: unknown;
};

// streams transferred from the page
ctx.addEventListener('message', ({ data }) => {
  if (data?.readable && data?.writable) void pipeTransform(data.operation, data.aesKey, data.readable, data.writable).catch(() => {});
});

if ('RTCTransformEvent' in self) {
  ctx.addEventListener('rtctransform', ({ transformer }) => {
    const { operation, aesKey } = transformer.options as TransformOptions;
    void pipeTransform(operation, aesKey, transformer.readable, transformer.writable).catch(() => {});
  });
}

// a module worker loads asynchronously: the transforms are attached once it listens
ctx.postMessage({ ready: true });
