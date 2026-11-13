// Errors and small helpers shared by the chat client and groups.
import type { Profile } from '../core/chat/protocol';

export class ChatError extends Error {}

/** the file is on servers that the user does not use: it is downloaded after the user agrees, as in the apps */
export class FileApprovalError extends ChatError {
  constructor(readonly servers: string[]) {
    super(`the file is on a server you do not use: ${servers.join(', ')}`);
    this.name = 'FileApprovalError';
  }
}

export function localId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function randomIndex(n: number): number {
  const b = new Uint32Array(1);
  const limit = Math.floor(2 ** 32 / n) * n;
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0] < limit) return b[0] % n;
  }
}

export function profileName(p?: Profile): string {
  return p?.displayName?.trim() || 'unknown';
}
