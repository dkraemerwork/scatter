import { describe, test, expect } from 'bun:test';
import {
  RAW_CODEC,
  NUMBER_CODEC,
  STRING_CODEC,
  JSON_CODEC,
  STRUCTURED_CODEC,
  resolveCodec,
  createCodec,
} from '../../src/memory/codec.js';

describe('Codec', () => {
  describe('raw', () => {
    test('identity round-trip', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = RAW_CODEC.encode(data);
      expect(encoded).toBe(data); // same reference
      const decoded = RAW_CODEC.decode(encoded);
      expect(decoded).toBe(encoded);
    });
  });

  describe('number', () => {
    test('round-trip Pi', () => {
      const encoded = NUMBER_CODEC.encode(Math.PI);
      expect(NUMBER_CODEC.decode(encoded)).toBe(Math.PI);
    });

    test('round-trip NaN', () => {
      const encoded = NUMBER_CODEC.encode(NaN);
      expect(Number.isNaN(NUMBER_CODEC.decode(encoded))).toBe(true);
    });

    test('round-trip Infinity', () => {
      const encoded = NUMBER_CODEC.encode(Infinity);
      expect(NUMBER_CODEC.decode(encoded)).toBe(Infinity);
    });

    test('round-trip negative zero', () => {
      const encoded = NUMBER_CODEC.encode(-0);
      expect(Object.is(NUMBER_CODEC.decode(encoded), -0)).toBe(true);
    });

    test('round-trip zero', () => {
      const encoded = NUMBER_CODEC.encode(0);
      expect(NUMBER_CODEC.decode(encoded)).toBe(0);
    });
  });

  describe('string', () => {
    test('round-trip empty string', () => {
      const encoded = STRING_CODEC.encode('');
      expect(STRING_CODEC.decode(encoded)).toBe('');
    });

    test('round-trip ASCII', () => {
      const encoded = STRING_CODEC.encode('hello world');
      expect(STRING_CODEC.decode(encoded)).toBe('hello world');
    });

    test('round-trip Unicode', () => {
      const encoded = STRING_CODEC.encode('こんにちは');
      expect(STRING_CODEC.decode(encoded)).toBe('こんにちは');
    });

    test('round-trip emoji', () => {
      const encoded = STRING_CODEC.encode('🎉🚀💯');
      expect(STRING_CODEC.decode(encoded)).toBe('🎉🚀💯');
    });
  });

  describe('json', () => {
    test('round-trip nested object', () => {
      const obj = { a: 1, b: { c: [1, 2, 3] }, d: null };
      const encoded = JSON_CODEC.encode(obj);
      expect(JSON_CODEC.decode(encoded)).toEqual(obj);
    });

    test('round-trip array', () => {
      const arr = [1, 'two', true, null];
      const encoded = JSON_CODEC.encode(arr);
      expect(JSON_CODEC.decode(encoded)).toEqual(arr);
    });

    test('round-trip null', () => {
      const encoded = JSON_CODEC.encode(null);
      expect(JSON_CODEC.decode(encoded)).toBeNull();
    });
  });

  describe('structured', () => {
    const hasBunSerialize = typeof Bun !== 'undefined' && typeof (Bun as any).serialize === 'function';

    test('round-trip object', () => {
      const obj = { x: 1, y: 'test' };
      const encoded = STRUCTURED_CODEC.encode(obj);
      expect(STRUCTURED_CODEC.decode(encoded)).toEqual(obj);
    });

    test('round-trip array', () => {
      const arr = [1, 'two', true, null];
      const encoded = STRUCTURED_CODEC.encode(arr);
      expect(STRUCTURED_CODEC.decode(encoded)).toEqual(arr);
    });

    test.skipIf(!hasBunSerialize)('round-trip Map (Bun.serialize)', () => {
      const map = new Map([['key', 1], ['other', 2]]);
      const encoded = STRUCTURED_CODEC.encode(map);
      const decoded = STRUCTURED_CODEC.decode(encoded);
      expect(decoded).toBeInstanceOf(Map);
      expect((decoded as Map<string, number>).get('key')).toBe(1);
    });

    test.skipIf(!hasBunSerialize)('round-trip Set (Bun.serialize)', () => {
      const set = new Set([1, 2, 3]);
      const encoded = STRUCTURED_CODEC.encode(set);
      const decoded = STRUCTURED_CODEC.decode(encoded);
      expect(decoded).toBeInstanceOf(Set);
      expect((decoded as Set<number>).has(2)).toBe(true);
    });

    test.skipIf(!hasBunSerialize)('round-trip Date (Bun.serialize)', () => {
      const date = new Date('2025-01-01T00:00:00Z');
      const encoded = STRUCTURED_CODEC.encode(date);
      const decoded = STRUCTURED_CODEC.decode(encoded);
      expect(decoded).toBeInstanceOf(Date);
      expect((decoded as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });
  });

  describe('resolveCodec', () => {
    test('resolves by name', () => {
      expect(resolveCodec('raw').name).toBe('raw');
      expect(resolveCodec('number').name).toBe('number');
      expect(resolveCodec('string').name).toBe('string');
      expect(resolveCodec('json').name).toBe('json');
      expect(resolveCodec('structured').name).toBe('structured');
    });

    test('passes through Codec instance', () => {
      const custom = createCodec({
        name: 'test',
        encode: (v: string) => new TextEncoder().encode(v),
        decode: (b: Uint8Array) => new TextDecoder().decode(b),
      });
      expect(resolveCodec(custom)).toBe(custom);
    });

    test('throws for unknown name', () => {
      expect(() => resolveCodec('bogus' as any)).toThrow(TypeError);
    });
  });

  describe('createCodec', () => {
    test('custom codec round-trip', () => {
      const codec = createCodec<number>({
        name: 'double',
        encode: (v) => {
          const buf = new Float64Array(1);
          buf[0] = v * 2;
          return new Uint8Array(buf.buffer);
        },
        decode: (b) => {
          return new Float64Array(b.buffer, b.byteOffset, 1)[0] / 2;
        },
      });
      expect(codec.name).toBe('double');
      const encoded = codec.encode(21);
      expect(codec.decode(encoded)).toBe(21);
    });
  });
});
