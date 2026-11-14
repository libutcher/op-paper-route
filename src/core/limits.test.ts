import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_FITS_BYTES,
  MAX_ENCODED_BYTES,
  NEVER_FITS_BYTES,
  checkFits,
  encodedSize,
  sizeHint,
} from "./limits.js";

/** The ground truth the SDK actually produces (types.js ReplacerFunc). */
const sdkEncoded = (bytes: Uint8Array) => JSON.stringify(Array.from(bytes)).length;

describe("encodedSize", () => {
  const cases: Record<string, Uint8Array> = {
    "empty file": new Uint8Array(0),
    "one byte": Uint8Array.of(7),
    "all single-digit bytes": new Uint8Array(1000),
    "all three-digit bytes": new Uint8Array(1000).fill(255),
    "digit boundaries": Uint8Array.of(0, 9, 10, 99, 100, 255),
    "utf-8 text": new TextEncoder().encode("Paper Route test — ünïcödé\n".repeat(200)),
    "random 256 KiB": new Uint8Array(randomBytes(256 * 1024)),
  };

  for (const [name, bytes] of Object.entries(cases)) {
    it(`matches JSON.stringify for ${name}`, () => {
      expect(encodedSize(bytes)).toBe(sdkEncoded(bytes));
    });
  }
});

describe("checkFits", () => {
  it("accepts the largest all-zero file that fits and rejects one byte more", () => {
    // All zeros is the best case: encoded = 2n + 1.
    const n = Math.floor((MAX_ENCODED_BYTES - 1) / 2);
    const fits = checkFits(new Uint8Array(n));
    expect(fits).toEqual({ fits: true, encoded: 2 * n + 1, limit: MAX_ENCODED_BYTES });
    expect(fits.encoded).toBeLessThanOrEqual(MAX_ENCODED_BYTES);

    const tooBig = checkFits(new Uint8Array(n + 1));
    expect(tooBig.fits).toBe(false);
    expect(tooBig.encoded).toBeGreaterThan(MAX_ENCODED_BYTES);
  });

  it("accepts ALWAYS_FITS_BYTES of worst-case bytes and rejects one byte more", () => {
    expect(checkFits(new Uint8Array(ALWAYS_FITS_BYTES).fill(255)).fits).toBe(true);
    expect(checkFits(new Uint8Array(ALWAYS_FITS_BYTES + 1).fill(255)).fits).toBe(false);
  });

  it("puts the practical ceiling for random data around 14 MB", () => {
    // 1 MiB of random bytes averages ~3.57 encoded bytes per byte.
    const sample = new Uint8Array(randomBytes(1 << 20));
    const ratio = encodedSize(sample) / sample.byteLength;
    const ceilingMB = MAX_ENCODED_BYTES / ratio / 1024 / 1024;
    expect(ceilingMB).toBeGreaterThan(13.5);
    expect(ceilingMB).toBeLessThan(14.5);
  });
});

describe("sizeHint", () => {
  it("is consistent with checkFits at the boundaries", () => {
    expect(sizeHint(0)).toBe("fits");
    expect(sizeHint(ALWAYS_FITS_BYTES)).toBe("fits");
    expect(sizeHint(ALWAYS_FITS_BYTES + 1)).toBe("unknown");
    expect(sizeHint(NEVER_FITS_BYTES - 1)).toBe("unknown");
    expect(sizeHint(NEVER_FITS_BYTES)).toBe("too-large");
  });

  it("never says 'fits' for a file that could fail", () => {
    // The worst-case file at ALWAYS_FITS_BYTES + 1 must not fit, or the hint lies.
    expect(checkFits(new Uint8Array(ALWAYS_FITS_BYTES + 1).fill(255)).fits).toBe(false);
  });

  it("never says 'too-large' for a file that could succeed", () => {
    // The best-case file at NEVER_FITS_BYTES - 1 must fit, or the hint lies.
    expect(checkFits(new Uint8Array(NEVER_FITS_BYTES - 1)).fits).toBe(true);
  });
});
