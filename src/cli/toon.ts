import { encode } from '@toon-format/toon';

/** Encodes a JSON-compatible value as TOON for LLM prompt consumption. */
export function encodeToon(value: unknown): string {
    return encode(value);
}
