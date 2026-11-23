// Tiny dependency-free MLP (tanh hidden layers, linear output) with backprop and flat parameter access.
import { mulberry32 } from './rng.js';

export class MLP {
  constructor(sizes, params = null, seed = 1) {
    this.sizes = sizes;
    this.count = 0;
    for (let i = 0; i < sizes.length - 1; i++) this.count += sizes[i] * sizes[i + 1] + sizes[i + 1];
    if (params) {
      if (params.length !== this.count) throw new Error(`param size mismatch ${params.length} != ${this.count}`);
      this.params = Float64Array.from(params);
    } else {
      this.params = new Float64Array(this.count);
      const rnd = mulberry32(seed);
      let o = 0;
      for (let i = 0; i < sizes.length - 1; i++) {
        const fanIn = sizes[i], fanOut = sizes[i + 1];
        const isLast = i === sizes.length - 2;
        const scale = isLast ? 0.01 : Math.sqrt(1 / fanIn); // output starts ~0 => residual starts neutral
        for (let k = 0; k < fanIn * fanOut; k++) this.params[o++] = (rnd() * 2 - 1) * scale;
        o += fanOut; // biases 0
      }
    }
    this.grads = new Float64Array(this.count);
  }

  // Returns output array; keeps activations for backward() when train=true.
  forward(x, train = false) {
    const acts = train ? [Float64Array.from(x)] : null;
    let a = x;
    let o = 0;
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const nIn = this.sizes[l], nOut = this.sizes[l + 1];
      const out = new Float64Array(nOut);
      const W = o, B = o + nIn * nOut;
      for (let j = 0; j < nOut; j++) {
        let s = this.params[B + j];
        const row = W + j * nIn;
        for (let i = 0; i < nIn; i++) s += this.params[row + i] * a[i];
        out[j] = l < this.sizes.length - 2 ? Math.tanh(s) : s;
      }
      o = B + nOut;
      a = out;
      if (train) acts.push(out);
    }
    if (train) this._acts = acts;
    return a;
  }

  // Accumulate gradients for dLoss/dOutput (uses activations from last forward(train=true)).
  backward(gradOut) {
    const acts = this._acts;
    let g = Float64Array.from(gradOut);
    // compute layer offsets
    const offsets = [];
    let o = 0;
    for (let l = 0; l < this.sizes.length - 1; l++) {
      offsets.push(o);
      o += this.sizes[l] * this.sizes[l + 1] + this.sizes[l + 1];
    }
    for (let l = this.sizes.length - 2; l >= 0; l--) {
      const nIn = this.sizes[l], nOut = this.sizes[l + 1];
      const W = offsets[l], B = W + nIn * nOut;
      const aIn = acts[l];
      if (l < this.sizes.length - 2) {
        const aOut = acts[l + 1];
        for (let j = 0; j < nOut; j++) g[j] *= 1 - aOut[j] * aOut[j];
      }
      const gIn = new Float64Array(nIn);
      for (let j = 0; j < nOut; j++) {
        this.grads[B + j] += g[j];
        const row = W + j * nIn;
        for (let i = 0; i < nIn; i++) {
          this.grads[row + i] += g[j] * aIn[i];
          gIn[i] += g[j] * this.params[row + i];
        }
      }
      g = gIn;
    }
    return g;
  }

  zeroGrad() {
    this.grads.fill(0);
  }

  sgdStep(lr, batch = 1, clip = 5) {
    for (let i = 0; i < this.count; i++) {
      const g = Math.max(-clip, Math.min(clip, this.grads[i] / batch));
      this.params[i] -= lr * g;
    }
    this.zeroGrad();
  }
}

export function softmax(logits, temperature = 1) {
  const t = Math.max(1e-3, temperature);
  let max = -Infinity;
  for (const l of logits) max = Math.max(max, l / t);
  const ex = logits.map((l) => Math.exp(l / t - max));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}
