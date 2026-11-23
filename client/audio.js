// Tiny WebAudio sound effects (no assets). Ripples are panned by direction so you can hear where noise came from.
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.15, pan = 0, slide = 0 }) {
  try {
    const a = ac();
    const o = a.createOscillator(), g = a.createGain(), p = a.createStereoPanner();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g).connect(p).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur + 0.02);
  } catch {}
}

export const sfx = {
  unlock: () => { try { ac(); } catch {} },
  heartbeat: (level) => {
    tone({ freq: 60, dur: 0.12, type: 'sine', gain: 0.25 + level * 0.3 });
    setTimeout(() => tone({ freq: 52, dur: 0.14, type: 'sine', gain: 0.18 + level * 0.25 }), 150);
  },
  ripple: (pan, vol, kind) => tone({ freq: kind === 'heart' ? 90 : kind === 'door' ? 220 : 160 + Math.random() * 40, dur: 0.08, type: kind === 'door' ? 'sawtooth' : 'triangle', gain: 0.02 + vol * 0.09, pan, slide: kind === 'door' ? -80 : 0 }),
  caught: () => { tone({ freq: 520, dur: 0.15, type: 'square', gain: 0.06 }); setTimeout(() => tone({ freq: 330, dur: 0.25, type: 'square', gain: 0.06 }), 140); },
  pickup: () => tone({ freq: 880, dur: 0.12, type: 'sine', gain: 0.08, slide: 400 }),
  use: () => tone({ freq: 300, dur: 0.15, type: 'triangle', gain: 0.08, slide: 300 }),
  tick: () => tone({ freq: 1000, dur: 0.04, type: 'square', gain: 0.03 }),
  start: () => { tone({ freq: 440, dur: 0.2, gain: 0.08 }); setTimeout(() => tone({ freq: 660, dur: 0.3, gain: 0.08 }), 200); },
};
