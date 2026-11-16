// settings.js — persistent player settings for FROSTLINE (v3.10).
// One shared singleton: every module reads `settings` live, the HUD panel
// writes it and calls saveSettings(). No imports (no cycles).
export const SETTINGS_KEY = 'frostline-settings-v1';

export const DEFAULT_SETTINGS = {
  sensitivity: 1.0, // mouse sensitivity multiplier, 0.2–3.0
  volume: 0.8, // master volume 0–1
  muted: false,
  fov: 74, // base field of view, 60–100 (ADS 58, Longbow scope 22)
  invertY: false,
  quality: 'high', // 'low' | 'high' — perf budgets, see QUALITY
  difficulty: 'normal', // v3.13: 'easy' | 'normal' | 'hard' — bot skill, see DIFFICULTY
};

// v3.13: difficulty levels. Bots read the multipliers at spawn (see
// bots.js spawnAt) so a change applies from the next round on.
// easy: bots miss more, react slower, hit softer, die faster.
// normal: the v3.12 baseline (accuracy 0.55, reaction 0.25–0.6 s).
// hard: sharper aim, faster reactions, harder hits, tougher bodies.
export const DIFFICULTY = {
  easy: { label: 'MUDAH', accMult: 0.7, reactMult: 1.6, dmgMult: 0.7, hp: 80 },
  normal: { label: 'NORMAL', accMult: 1.0, reactMult: 1.0, dmgMult: 1.0, hp: 100 },
  hard: { label: 'SULIT', accMult: 1.3, reactMult: 0.65, dmgMult: 1.3, hp: 120 },
};
export const DIFFICULTY_IDS = ['easy', 'normal', 'hard'];

// Perf budgets per quality tier. Low halves the pixel ratio, turns the sun
// shadow map off, and cuts particle/snow counts — the three biggest costs
// on a weak machine (Grok v3.9: 700 particles + 800 snow + 2048 shadows
// + pixelRatio 2 was heavy).
export const QUALITY = {
  high: { pixelRatio: 2, shadows: true, particles: 700, snow: 800 },
  low: { pixelRatio: 1, shadows: false, particles: 300, snow: 350 },
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const s = { ...DEFAULT_SETTINGS, ...parsed };
    s.sensitivity = clamp(+s.sensitivity || 1, 0.2, 3);
    s.volume = clamp(+s.volume || 0, 0, 1);
    s.muted = !!s.muted;
    s.fov = clamp(+s.fov || 74, 60, 100);
    s.invertY = !!s.invertY;
    s.quality = s.quality === 'low' ? 'low' : 'high';
    s.difficulty = DIFFICULTY[s.difficulty] ? s.difficulty : 'normal';
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// The live singleton. Modules read `settings` directly so a change in the
// panel applies on the next frame without a reload.
export const settings = loadSettings();

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode etc: settings still work for the session */ }
}
