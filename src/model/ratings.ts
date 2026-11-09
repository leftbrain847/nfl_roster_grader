/**
 * The optional ratings slot (off in this build). A ratings source may be switched on only if its terms let us
 * republish it on a public page; the refresh refuses to build otherwise.
 */
import type { RatingsSourceConfig } from './config.ts';

export function assertRatingsAllowed(cfg: RatingsSourceConfig): void {
  if (!cfg.enabled) return;
  if (!cfg.republishAllowed) {
    throw new Error(`ratings source "${cfg.label || '(unnamed)'}" is enabled but republishAllowed is false: only data we may republish can go on the page`);
  }
  if (!cfg.label || !cfg.license) throw new Error('ratings source needs a label and a license line for the footer credit');
  if (!(cfg.compositeProductionWeight >= 0 && cfg.compositeProductionWeight <= 1)) throw new Error('compositeProductionWeight must be 0-1');
}

/** Parse a ratings file: { "<gsis_id>": number 0-100 }. Anything else is dropped. */
export function parseRatings(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{2}-\d{7}$/.test(k) && typeof v === 'number' && v >= 0 && v <= 100) out[k] = v;
  }
  return out;
}
