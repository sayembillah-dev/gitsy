import { describe, expect, it } from 'vitest';
import { sha256Hex, utf8Encode } from '@/core/sha256';

describe('sha256Hex', () => {
  it('matches published test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes multibyte UTF-8 deterministically', () => {
    const text = 'héllo wörld ✓';
    expect(sha256Hex(text)).toBe(sha256Hex(text));
    expect(sha256Hex(text)).not.toBe(sha256Hex('hello world'));
    expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('utf8Encode', () => {
  it('encodes ASCII, 2-byte, 3-byte, and surrogate-pair input', () => {
    expect([...utf8Encode('a')]).toEqual([0x61]);
    expect([...utf8Encode('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8Encode('€')]).toEqual([0xe2, 0x82, 0xac]);
    expect([...utf8Encode('😀')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});
