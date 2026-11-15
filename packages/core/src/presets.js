// The degraded-copy presets (degrade.js draws them), in a module of their own so that every check of a preset name
// (a batch, a set file, a manifest read back) uses this one list without loading the renderer.
export const PRESETS = Object.freeze(['scan', 'fax', 'photo', 'low-res']);
