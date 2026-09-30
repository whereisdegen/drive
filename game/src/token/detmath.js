/**
 * DRIVE  src/token/detmath.js  (owner: token)
 *
 * Transcendental functions that give the same bits on every JavaScript engine.
 *
 * WHY THIS FILE EXISTS
 *
 * ECMAScript pins the arithmetic operators to IEEE-754 - +, -, *, / and Math.sqrt are exact and
 * reproducible everywhere - but it explicitly does NOT specify the accuracy of Math.sin, cos,
 * tan, atan, atan2, exp, log or pow. Engines are free to use any implementation within roughly
 * an ulp, and they do. Measured on this project (oracle/mathprobe.mjs), Chrome 148 and Node 23's
 * V8 disagree on FOURTEEN of eighteen Math functions, sqrt, cbrt, log2 and hypot being the
 * exceptions.
 *
 * One ulp is nothing. A kart race is a chaotic system, and over 15 000 ticks nothing becomes
 * everything: before this module existed, about half of all runs verified on the oracle diverged
 * from the browser that drove them, typically around the 100-second mark, with the replay taking
 * a different line into a corner and sometimes failing to finish at all. A staking system cannot
 * reject half of its honest players, so the simulation cannot be allowed to call the host's Math.
 *
 * WHAT THIS BUYS AND WHAT IT COSTS
 *
 * Every routine below is built from +, -, *, /, Math.sqrt, Math.floor, Math.round and Math.abs -
 * all exactly specified - so two engines executing them produce identical doubles by
 * construction, not by luck. The kernels are the classic fdlibm ones (the same lineage as most
 * libm implementations), accurate to well under an ulp, so the game's handling is unchanged in
 * any way a human could perceive; only the last bit or two of any given result moves.
 *
 * These are used by the physics, the spline and the collision world for EVERY race, not only
 * staked ones. Having one physics that behaves identically everywhere is the point; a second
 * "verified mode" physics would just be a second thing to keep in agreement.
 *
 * Accuracy is checked against the host Math in oracle/dev-detmath.mjs, and cross-engine equality
 * is checked by comparing that script's hashes against the browser's.
 */

// ---------------------------------------------------------------- constants (fdlibm)
const PIO2_1  = 1.57079632673412561417e+00;   // pi/2, first 33 bits - exact in a double
const PIO2_1T = 6.07710050650619224932e-11;   // pi/2 - PIO2_1
const INVPIO2 = 6.36619772367581382433e-01;   // 2/pi
export const PI = 3.14159265358979311600e+00;
const TWO_PI = 6.28318530717958623200e+00;

/** |x| beyond this loses the exactness of k * PIO2_1; headings in this game stay far below it */
const REDUCE_LIMIT = 1048576;                 // 2^20

// sin kernel on [-pi/4, pi/4]
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
      S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
      S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
// cos kernel on [-pi/4, pi/4]
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
      C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
      C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function kernelSin(x) {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + x * z * (S1 + z * r);
}

function kernelCos(x) {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1.0 - (0.5 * z - z * r);
}

/**
 * Reduce x to r in about [-pi/4, pi/4] plus a quadrant 0..3.
 * k * PIO2_1 is exact because PIO2_1 carries only 33 significant bits and |k| < 2^20, so the
 * product fits in a double with room to spare - that exactness is what makes this reproducible.
 */
function reduce(x) {
  if (!(Math.abs(x) < REDUCE_LIMIT)) {
    // far out of the range anything here should reach; wrap with the same two-word trick so the
    // result is still engine-independent, at reduced accuracy
    const n = Math.round(x / TWO_PI);
    x = x - n * 6.28318530717958623200e+00;
  }
  const k = Math.round(x * INVPIO2);
  let r = x - k * PIO2_1;
  r = r - k * PIO2_1T;
  return { q: ((k % 4) + 4) % 4, r };
}

export function dsin(x) {
  if (!Number.isFinite(x)) return NaN;
  const { q, r } = reduce(x);
  switch (q) {
    case 0: return kernelSin(r);
    case 1: return kernelCos(r);
    case 2: return -kernelSin(r);
    default: return -kernelCos(r);
  }
}

export function dcos(x) {
  if (!Number.isFinite(x)) return NaN;
  const { q, r } = reduce(x);
  switch (q) {
    case 0: return kernelCos(r);
    case 1: return -kernelSin(r);
    case 2: return -kernelCos(r);
    default: return kernelSin(r);
  }
}

export function dtan(x) {
  const c = dcos(x);
  return c === 0 ? (dsin(x) > 0 ? Infinity : -Infinity) : dsin(x) / c;
}

// ---------------------------------------------------------------- atan / atan2 (fdlibm)
const aT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];
const atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];

export function datan(x) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : (x > 0 ? atanhi[3] + atanlo[3] : -(atanhi[3] + atanlo[3]));
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  let id;
  if (x < 0.4375) {
    id = -1;
  } else if (x < 1.1875) {
    if (x < 0.6875) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
    else { id = 1; x = (x - 1.0) / (x + 1.0); }
  } else if (x < 2.4375) {
    id = 2; x = (x - 1.5) / (1.0 + 1.5 * x);
  } else {
    id = 3; x = -1.0 / x;
  }
  const z = x * x, w = z * z;
  const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) return sign * (x - x * (s1 + s2));
  return sign * (atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x));
}

export function datan2(y, x) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 0) return (x >= 0 && !Object.is(x, -0)) ? (Object.is(y, -0) ? -0 : 0) : (Object.is(y, -0) ? -PI : PI);
  if (x === 0) return y > 0 ? PI / 2 : -PI / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (!Number.isFinite(x) && !Number.isFinite(y)) {
      const a = x > 0 ? PI / 4 : 3 * PI / 4;
      return y > 0 ? a : -a;
    }
    if (!Number.isFinite(y)) return y > 0 ? PI / 2 : -PI / 2;
    return x > 0 ? (y > 0 ? 0 : -0) : (y > 0 ? PI : -PI);
  }
  const a = datan(y / x);
  if (x > 0) return a;
  return y >= 0 ? a + PI : a - PI;
}

// ---------------------------------------------------------------- exp / log / pow (fdlibm)
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
const INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
      P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06,
      P5 = 4.13813679705723846039e-08;

export function dexp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = Math.round(x * INVLN2);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const z = r * r;
  const c = r - z * (P1 + z * (P2 + z * (P3 + z * (P4 + z * P5))));
  const y = 1.0 + (r * c / (2.0 - c) + r);
  return scalb(y, k);
}

const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01,
      LG3 = 2.857142874366239149e-01, LG4 = 2.222219843214978396e-01,
      LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01,
      LG7 = 1.479819860511658591e-01;

export function dlog(x) {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (!Number.isFinite(x)) return Infinity;
  // x = 2^k * f with f in [sqrt(2)/2, sqrt(2))
  let k = 0;
  while (x >= 2) { x = x * 0.5; k++; }
  while (x < 1) { x = x * 2; k--; }
  if (x > 1.41421356237309514547) { x = x * 0.5; k++; }
  const f = x - 1.0;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t1 + t2;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}

/** 2^n by repeated exact doubling; ldexp without touching the host's Math */
function scalb(y, n) {
  while (n > 1000) { y *= 8.98846567431158e+307; n -= 1023; }
  while (n < -1000) { y *= 1.1125369292536007e-308; n += 1022; }
  return y * pow2(n);
}
function pow2(n) {
  let r = 1, b = n < 0 ? 0.5 : 2, e = n < 0 ? -n : n;
  while (e > 0) { if (e & 1) r *= b; b *= b; e >>= 1; }
  return r;
}

export function dpow(x, y) {
  if (y === 0) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  // exact integer exponents by squaring: no logarithm, no rounding, and this is the hot path
  // (KART.accel calls dpow every tick, kart/physics.js line 40)
  if (Number.isInteger(y) && Math.abs(y) <= 1024) {
    let r = 1, b = x, e = Math.abs(y);
    while (e > 0) { if (e & 1) r *= b; b *= b; e >>= 1; }
    return y < 0 ? 1 / r : r;
  }
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;              // fractional power of a negative: the game never asks
  return dexp(y * dlog(x));
}

/**
 * exp(x) - 1 without the cancellation that (dexp(x) - 1) suffers as x approaches 0.
 * Kahan's formula: the relative error of exp is carried through log, and the two cancel.
 */
export function dexpm1(x) {
  const u = dexp(x);
  if (u === 1) return x;                 // x is small enough that exp(x) rounds to 1
  if (u - 1 === -1) return -1;
  return (u - 1) * x / dlog(u);
}

/**
 * hypot without the host's. Math.hypot is not pinned by the spec either (it happens to agree
 * between Chrome and Node, which is not a guarantee for Firefox or Safari). The scaling by the
 * larger magnitude keeps a*a from overflowing or underflowing, and every operation here -
 * divide, multiply, add, sqrt - is exactly specified.
 */
export function dhypot(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  if (a < b) { const t = a; a = b; b = t; }
  if (a === 0) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return (a === Infinity || b === Infinity) ? Infinity : NaN;
  const r = b / a;
  return a * Math.sqrt(1 + r * r);
}

export function dasin(x) {
  if (x >= 1) return PI / 2;
  if (x <= -1) return -PI / 2;
  return datan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function dacos(x) {
  if (x >= 1) return 0;
  if (x <= -1) return PI;
  return datan2(Math.sqrt((1 - x) * (1 + x)), x);
}

export function dtanh(x) {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax > 22) return x > 0 ? 1 : -1;
  let z;
  if (ax < 1) {
    const t = dexpm1(-2 * ax);
    z = -t / (t + 2);
  } else {
    const t = dexpm1(2 * ax);
    z = 1 - 2 / (t + 2);
  }
  return x > 0 ? z : -z;
}

/** everything the simulation is allowed to call, in one object for a quick audit */
export const DM = { sin: dsin, cos: dcos, tan: dtan, atan: datan, asin: dasin, acos: dacos, atan2: datan2,
                    exp: dexp, expm1: dexpm1, log: dlog, pow: dpow, tanh: dtanh, hypot: dhypot };
