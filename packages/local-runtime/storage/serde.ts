import { createHash, randomUUID } from 'node:crypto';

// Canonical JSON helpers shared by the store and its extracted subsystems.
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const encode = (v: unknown) => JSON.stringify(v);
export const decode = <T = any>(v: unknown): T => JSON.parse(String(v));
export function canonical(v: any): string {
  return JSON.stringify(
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : Object.fromEntries(
            Object.keys(v)
              .filter((k) => v[k] !== undefined)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))]),
          )
      : v,
  );
}
