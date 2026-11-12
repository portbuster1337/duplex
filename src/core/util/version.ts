// Version ranges (Simplex.Messaging.Version)
import { Decoder, Encoder, ParseError } from './encoding';

export interface VersionRange {
  min: number;
  max: number;
}

export const vr = (min: number, max: number = min): VersionRange => {
  if (min > max) throw new Error('invalid version range');
  return { min, max };
};

export function encVR(e: Encoder, r: VersionRange): Encoder {
  return e.word16(r.min).word16(r.max);
}

export function decVR(d: Decoder): VersionRange {
  const min = d.word16();
  const max = d.word16();
  if (min > max) throw new ParseError('invalid version range');
  return { min, max };
}

export function strVR(r: VersionRange): string {
  return r.min === r.max ? String(r.min) : `${r.min}-${r.max}`;
}

export function parseVR(s: string): VersionRange {
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new ParseError(`bad version range: ${s}`);
  const min = Number(m[1]);
  const max = m[2] ? Number(m[2]) : min;
  if (min > max || max > 65535) throw new ParseError(`bad version range: ${s}`);
  return { min, max };
}

/** intersection of two ranges (compatibleVRange) */
export function compatibleVRange(a: VersionRange, b: VersionRange): VersionRange | undefined {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min <= max ? { min, max } : undefined;
}

/** the highest common version (compatibleVersion) */
export function compatibleVersion(a: VersionRange, b: VersionRange): number | undefined {
  return a.min <= b.max && b.min <= a.max ? Math.min(a.max, b.max) : undefined;
}

export function isCompatible(v: number, r: VersionRange): boolean {
  return r.min <= v && v <= r.max;
}
