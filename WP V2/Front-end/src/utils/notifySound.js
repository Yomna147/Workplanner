let sharedContext = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioCtx();
  }
  return sharedContext;
}

/**
 * Short two-tone chime for attention toasts (no asset file required).
 */
export async function playNotifySound({ volume = 0.18 } = {}) {
  const context = getAudioContext();
  if (!context) return;

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }
  } catch {
    return;
  }

  const now = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(volume, now + 0.02);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  master.connect(context.destination);

  const tones = [
    { frequency: 880, start: 0, duration: 0.16 },
    { frequency: 1174.7, start: 0.14, duration: 0.28 },
  ];

  tones.forEach(({ frequency, start, duration }) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now + start);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(1, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.02);
  });
}
