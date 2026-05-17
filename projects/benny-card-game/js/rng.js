// Crypto-backed RNG utilities. No Math.random anywhere in the app.

const cryptoObj = (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues)
  ? globalThis.crypto
  : null;

if (!cryptoObj) {
  // Hard fail loudly: requirements forbid Math.random fallback.
  throw new Error("crypto.getRandomValues is required and not available in this browser.");
}

// Unbiased integer in [0, max). Uses rejection sampling on Uint32 values.
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomInt requires a positive integer bound");
  }
  if (max === 1) return 0;
  const limit = 0xffffffff;
  const threshold = limit - (limit % max) - 1;
  const buf = new Uint32Array(1);
  let n;
  do {
    cryptoObj.getRandomValues(buf);
    n = buf[0];
  } while (n > threshold);
  return n % max;
}

// Fisher-Yates shuffle in place using crypto randomness.
export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    if (i !== j) {
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
  return arr;
}

export function pickRandom(arr) {
  if (!arr.length) return undefined;
  return arr[randomInt(arr.length)];
}
