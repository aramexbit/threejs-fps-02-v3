// palette.js — FROSTLINE palette (snowy industrial warzone, cold daylight).
// One source of truth for every colour in the game: HUD, map, sky, lights.
// Cold steel blues and snow whites dominate; warm orange fire is the single
// contrasting accent, exactly like the reference mood (snow + industry + fire).
export const PALETTE = {
  canvas: '#0d1117', // page / backdrop behind the canvas
  surface: '#1c222b', // panels, HUD cards
  hairline: '#4a5568', // borders, grid lines
  ink: '#eef2f6', // primary text
  muted: '#9aa8b8', // secondary text
  accent: '#ff7a2f', // fire orange / highlights / Solara
  teal: '#6fc3d8', // cold steel-blue accent / Bastion
  snow: '#e8edf2',
  snowShadow: '#b9c4d0',
  steel: '#5a6673',
  rust: '#8a4a2a',
  craneRed: '#a33327',
  enemy: '#e05a4e',
  ally: '#6fc3d8',
};
export const TEAM_COLORS = { solara: 0xe0352b, bastion: 0x2f6fd8 };
// v3.10 "TERANG SEIMBANG" (user pick, middle panel): vivid red vs vivid
// royal blue — the TERORIS merah vs POLISI biru of the user's team-select
// design. Was fire orange 0xff7a2f / pale steel teal 0x6fc3d8 — too muted
// against bright snow; the vests, nameplates and minimap dots all read
// from here, so the teams stay identifiable at range.
