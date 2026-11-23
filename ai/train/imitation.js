// Supervised fine-tuning of the residual networks on human samples (behaviour cloning).
import { G_SIZE, C_SIZE } from '../features.js';
import { softmax } from '../mlp.js';

/**
 * samples: [{ role, g, c:[[...]], priors:[...], chosen, mode (0..2|-1), use (0|1|-1) }]
 * Returns mean loss. Mutates brain.
 */
export function imitationEpoch(brain, samples, { lr = 0.01, batch = 16, modeWeight = 0.2, useWeight = 0.2 } = {}) {
  let loss = 0, n = 0, inBatch = 0;
  const x = new Float64Array(G_SIZE + C_SIZE);
  const order = samples.map((_, i) => i).sort(() => Math.random() - 0.5);
  const step = () => {
    for (const role of ['hider', 'seeker']) {
      brain.nets[role].score.sgdStep(lr, inBatch);
      brain.nets[role].head.sgdStep(lr, inBatch);
    }
    inBatch = 0;
  };
  for (const i of order) {
    const s = samples[i];
    if (!s.c?.length || s.chosen < 0 || s.chosen >= s.c.length) continue;
    const net = brain.nets[s.role].score;
    // forward all candidates to get logits
    const logits = s.c.map((cf, k) => {
      x.set(s.g, 0);
      x.set(cf, G_SIZE);
      return s.priors[k] + net.forward(x)[0];
    });
    const p = softmax(logits);
    loss += -Math.log(Math.max(1e-9, p[s.chosen]));
    // backward: dL/dlogit_k = p_k - y_k ; recompute forward per candidate for cached activations
    s.c.forEach((cf, k) => {
      const gk = p[k] - (k === s.chosen ? 1 : 0);
      if (Math.abs(gk) < 1e-4) return;
      x.set(s.g, 0);
      x.set(cf, G_SIZE);
      net.forward(x, true);
      net.backward([gk]);
    });
    // mode + item-use head
    const head = brain.nets[s.role].head;
    const out = head.forward(s.g, true);
    const gOut = [0, 0, 0, 0];
    if (s.mode >= 0) {
      const pm = softmax([out[0], out[1], out[2]]);
      for (let k = 0; k < 3; k++) gOut[k] = modeWeight * (pm[k] - (k === s.mode ? 1 : 0));
      loss += modeWeight * -Math.log(Math.max(1e-9, pm[s.mode]));
    }
    if (s.use >= 0) {
      const pu = 1 / (1 + Math.exp(-out[3]));
      gOut[3] = useWeight * (pu - s.use);
    }
    head.backward(gOut);
    n++;
    if (++inBatch >= batch) step();
  }
  if (inBatch) step();
  return n ? loss / n : 0;
}
