// Vendored from the repository's CC0 fractional-indexing package.
// New ranks grow only when a repeatedly edited gap needs more precision.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LEGACY_RANK = /^[0-9a-f]{64}$/;
const LEGACY_MAX = (1n << 256n) - 1n;

const midpoint = (a: string, b: string | null): string => {
  const zero = DIGITS[0]!;
  if (b !== null && a >= b) {
    throw new Error("Rank neighbors are not ordered");
  }
  if (a.endsWith(zero) || b?.endsWith(zero)) {
    throw new Error("Invalid fractional rank");
  }
  if (b) {
    let prefixLength = 0;
    while ((a[prefixLength] || zero) === b[prefixLength]) {
      prefixLength += 1;
    }
    if (prefixLength > 0) {
      return (
        b.slice(0, prefixLength) +
        midpoint(a.slice(prefixLength), b.slice(prefixLength))
      );
    }
  }
  const lower = a ? DIGITS.indexOf(a[0]!) : 0;
  const upper = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (upper - lower > 1) {
    return DIGITS[Math.round(0.5 * (lower + upper))]!;
  }
  if (b && b.length > 1) {
    return b[0]!;
  }
  return DIGITS[lower]! + midpoint(a.slice(1), null);
};

const integerLength = (head: string) => {
  if (head >= "a" && head <= "z") {
    return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  }
  if (head >= "A" && head <= "Z") {
    return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new Error("Invalid fractional rank");
};

const integerPart = (rank: string) => {
  const length = integerLength(rank[0]!);
  if (length > rank.length) {
    throw new Error("Invalid fractional rank");
  }
  return rank.slice(0, length);
};

const validateInteger = (integer: string) => {
  if (integer.length !== integerLength(integer[0]!)) {
    throw new Error("Invalid fractional rank");
  }
};

const validateRank = (rank: string) => {
  if (
    rank === `A${DIGITS[0]!.repeat(26)}` ||
    [...rank].some((character) => !DIGITS.includes(character))
  ) {
    throw new Error("Invalid fractional rank");
  }
  const integer = integerPart(rank);
  if (rank.slice(integer.length).endsWith(DIGITS[0]!)) {
    throw new Error("Invalid fractional rank");
  }
};

const incrementInteger = (integer: string): string | null => {
  validateInteger(integer);
  const [head, ...digits] = integer.split("");
  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index]!) + 1;
    if (next === DIGITS.length) {
      digits[index] = DIGITS[0]!;
    } else {
      digits[index] = DIGITS[next]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") {
      return `a${DIGITS[0]}`;
    }
    if (head === "z") {
      return null;
    }
    const nextHead = String.fromCharCode(head!.charCodeAt(0) + 1);
    if (nextHead > "a") {
      digits.push(DIGITS[0]!);
    } else {
      digits.pop();
    }
    return nextHead + digits.join("");
  }
  return head! + digits.join("");
};

const decrementInteger = (integer: string): string | null => {
  validateInteger(integer);
  const [head, ...digits] = integer.split("");
  let borrow = true;
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const previous = DIGITS.indexOf(digits[index]!) - 1;
    if (previous === -1) {
      digits[index] = DIGITS.at(-1)!;
    } else {
      digits[index] = DIGITS[previous]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") {
      return `Z${DIGITS.at(-1)}`;
    }
    if (head === "A") {
      return null;
    }
    const nextHead = String.fromCharCode(head!.charCodeAt(0) - 1);
    if (nextHead < "Z") {
      digits.push(DIGITS.at(-1)!);
    } else {
      digits.pop();
    }
    return nextHead + digits.join("");
  }
  return head! + digits.join("");
};

const fractionalRankBetween = (
  before: string | null,
  after: string | null,
): string => {
  if (before !== null) {
    validateRank(before);
  }
  if (after !== null) {
    validateRank(after);
  }
  if (before !== null && after !== null && before >= after) {
    throw new Error("Rank neighbors are not ordered");
  }
  if (before === null) {
    if (after === null) {
      return `a${DIGITS[0]}`;
    }
    const afterInteger = integerPart(after);
    const afterFraction = after.slice(afterInteger.length);
    if (afterInteger === `A${DIGITS[0]!.repeat(26)}`) {
      return afterInteger + midpoint("", afterFraction);
    }
    if (afterInteger < after) {
      return afterInteger;
    }
    const result = decrementInteger(afterInteger);
    if (result === null) {
      throw new Error("Rank space is exhausted");
    }
    return result;
  }
  if (after === null) {
    const beforeInteger = integerPart(before);
    const beforeFraction = before.slice(beforeInteger.length);
    const result = incrementInteger(beforeInteger);
    return result === null
      ? beforeInteger + midpoint(beforeFraction, null)
      : result;
  }
  const beforeInteger = integerPart(before);
  const beforeFraction = before.slice(beforeInteger.length);
  const afterInteger = integerPart(after);
  const afterFraction = after.slice(afterInteger.length);
  if (beforeInteger === afterInteger) {
    return beforeInteger + midpoint(beforeFraction, afterFraction);
  }
  const result = incrementInteger(beforeInteger);
  if (result === null) {
    throw new Error("Rank space is exhausted");
  }
  return result < after
    ? result
    : beforeInteger + midpoint(beforeFraction, null);
};

const legacyRankBetween = (before: string | null, after: string | null) => {
  const lower = before === null ? 0n : BigInt(`0x${before}`);
  const upper = after === null ? LEGACY_MAX : BigInt(`0x${after}`);
  if (lower >= upper) {
    throw new Error("Rank neighbors are not ordered");
  }
  if (upper - lower <= 1n) {
    throw new Error("Legacy rank space is exhausted");
  }
  return (lower + (upper - lower) / 2n).toString(16).padStart(64, "0");
};

export const createRankBetween = (
  before: string | null,
  after: string | null,
) => {
  const hasLegacyNeighbor =
    (before !== null && LEGACY_RANK.test(before)) ||
    (after !== null && LEGACY_RANK.test(after));
  if (hasLegacyNeighbor) {
    if (
      (before !== null && !LEGACY_RANK.test(before)) ||
      (after !== null && !LEGACY_RANK.test(after))
    ) {
      throw new Error("Mixed rank formats are not allowed");
    }
    return legacyRankBetween(before, after);
  }
  return fractionalRankBetween(before, after);
};

export const initialRank = () => fractionalRankBetween(null, null);
