import { Variant } from './types';

export function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

export function assignVariant(experimentId: string, userId: string, variants: Variant[]): Variant {
  const bucket = fnv1a(experimentId + '::' + userId) % 100;
  let accumulated = 0;
  for (const variant of variants) {
    accumulated += variant.weight;
    if (bucket < accumulated) return variant;
  }
  return variants[variants.length - 1];
}
