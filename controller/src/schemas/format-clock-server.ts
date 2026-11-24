// Server-only format clock rules: id minting and cross-row de-duplication, the
// same split (and the same shared use by the strict and lenient paths) as
// show-server.ts. Not mirrored to the browser.
import { mintId } from '../settings/vocab.js';

export function resolveFormatClockIds<T extends { id?: string }>(items: T[]): (T & { id: string })[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id ?? mintId('fc_');
    if (seen.has(id)) id = mintId('fc_');
    seen.add(id);
    return { ...item, id };
  });
}
