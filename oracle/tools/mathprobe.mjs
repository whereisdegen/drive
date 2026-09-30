/** hash each Math function over a fixed input sweep, to find which ones differ between engines */
export function probe() {
  const fns = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
    atan: Math.atan, exp: Math.exp, log: Math.log, sqrt: Math.sqrt, cbrt: Math.cbrt,
    tanh: Math.tanh, sinh: Math.sinh, log2: Math.log2, log10: Math.log10, expm1: Math.expm1,
  };
  const out = {};
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  const mixF = (h, v) => { dv.setFloat64(0, v); h = Math.imul(h ^ dv.getUint32(0), 16777619) >>> 0; return Math.imul(h ^ dv.getUint32(4), 16777619) >>> 0; };
  for (const [name, f] of Object.entries(fns)) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < 200000; i++) {
      const x = (i - 100000) / 7919.0;     // about -12.6 .. 12.6, dense, non-round arguments
      h = mixF(h, f(x));
    }
    out[name] = h.toString(16);
  }
  // two-argument ones
  let hp = 0x811c9dc5 >>> 0, ha = 0x811c9dc5 >>> 0, hh = 0x811c9dc5 >>> 0;
  for (let i = 0; i < 200000; i++) {
    const a = i / 9973.0, b = (i % 997) / 331.0;
    hp = mixF(hp, Math.pow(a, b));
    ha = mixF(ha, Math.atan2(a - 10, b - 1.5));
    hh = mixF(hh, Math.hypot(a - 10, b - 1.5));
  }
  out.pow = hp.toString(16); out.atan2 = ha.toString(16); out.hypot = hh.toString(16);
  return out;
}
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('mathprobe.mjs')) {
  console.log(JSON.stringify(probe(), null, 0));
  console.log('node', process.version, 'v8', process.versions.v8);
}
