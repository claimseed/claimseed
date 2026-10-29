// browser.js — one place that knows how to find and launch Chrome.
// Order: $CLAIMSEED_CHROME, $PUPPETEER_EXECUTABLE_PATH, then common install paths. No download ever happens
// at install time (we depend on puppeteer-core); the error message says what to install.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
const require = createRequire(import.meta.url);

const CANDIDATES = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
export function findChrome() {
  for (const p of [process.env.CLAIMSEED_CHROME, process.env.PUPPETEER_EXECUTABLE_PATH, ...CANDIDATES]) {
    if (p && fs.existsSync(p)) return p;
  }
  // Playwright's bundled Chromium, if present (dev containers)
  try { const pw = require('playwright'); const p = pw.chromium.executablePath(); if (fs.existsSync(p)) return p; } catch {}
  return null;
}
// A fontconfig that sees exactly one font: fonts/ClaimseedNotdef-Regular.ttf (a box glyph and a space). Chrome
// needs at least one installed font to lay out text at all; with only this one, every character is drawn from the
// bundled web fonts, and a character they lack shows as a box rather than a machine-dependent system glyph.
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fonts');
let fontconfigDir = null; // one private temp dir per process (mkdtemp: not shared with or writable by other users)
function isolatedFontconfig() {
  if (!fontconfigDir) {
    fontconfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-fc-'));
    fs.mkdirSync(path.join(fontconfigDir, 'cache'));
    fs.writeFileSync(path.join(fontconfigDir, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONTS_DIR}</dir><cachedir>${fontconfigDir}/cache</cachedir></fontconfig>\n`);
    process.on('exit', () => { try { fs.rmSync(fontconfigDir, { recursive: true, force: true }); } catch {} });
  }
  return path.join(fontconfigDir, 'fonts.conf');
}
// A capture hook for the repository's own provenance check (scripts/verify-stock-sources.js): when set, print.js
// hands every page's hardened HTML to it and writes a blank page instead of printing, and no browser is launched at
// all. Not part of the public API.
export const printHooks = { capture: null };
export async function launchBrowser(opts = {}) {
  if (printHooks.capture) return { close: async () => {}, newPage: async () => { throw new Error('capture mode: no browser'); } };
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('No Chrome/Chromium found. Set CLAIMSEED_CHROME to a Chrome binary, or install Chrome/Chromium, or use the Docker image (Dockerfile in the claimseed repository).');
  }
  // Network is dead at the process level (every host routes to a closed loopback port, DNS prefetch and
  // speculative loading off) in addition to the per-page interception and CSP in render.js.
  const args = ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--disable-default-apps', '--disable-component-update', '--metrics-recording-only', '--no-pings',
    '--proxy-server=127.0.0.1:1', '--proxy-bypass-list=<-loopback>', '--dns-prefetch-disable', '--disable-features=Prerender2,SpeculationRulesPrefetchFuture,NetworkPrediction,PreconnectToSearch'];
  if (process.env.CLAIMSEED_NO_SANDBOX === '1') args.push('--no-sandbox'); // only inside the locked-down container image
  // Isolated fontconfig (Linux; macOS and Windows do not use fontconfig): the only installed font Chrome sees is the
  // two-glyph fallback in fonts/, so text is drawn from the bundled web fonts alone. Set CLAIMSEED_SYSTEM_FONTS=1 to
  // opt out (debugging only). Byte-for-byte reproducibility therefore holds on Linux for a given Chrome build; on
  // other platforms the content is identical but the embedded fallback for a missing glyph could differ.
  const env = { ...process.env };
  if (process.env.CLAIMSEED_SYSTEM_FONTS !== '1' && process.platform === 'linux') env.FONTCONFIG_FILE = isolatedFontconfig();
  // Chrome's working files go to one private folder per launch in the system temp folder: its profile, and what it
  // would otherwise write under the user's home or the temp folder (settings, caches, crash-report settings, temporary
  // files), redirected there through HOME, the XDG folders and TMPDIR. The folder is removed when the browser process exits, or failing that when this
  // process exits.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-chrome-'));
  workDirs.add(work);
  if (!exitHook) { exitHook = true; process.on('exit', () => { for (const d of [...workDirs]) removeWorkDir(d); }); }
  for (const d of ['profile', 'home', 'config', 'cache', 'tmp']) fs.mkdirSync(path.join(work, d));
  const tmp = path.join(work, 'tmp');
  Object.assign(env, { HOME: path.join(work, 'home'), XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache'), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GSETTINGS_BACKEND: 'memory' });
  let browser;
  try { browser = await puppeteer.launch({ headless: true, executablePath, args, env, userDataDir: path.join(work, 'profile'), ...opts }); }
  catch (e) { removeWorkDir(work); throw e; }
  const proc = browser.process?.();
  if (!proc) browser.once('disconnected', () => removeWorkDir(work));
  else if (proc.exitCode !== null) removeWorkDir(work);
  else proc.once('exit', () => removeWorkDir(work));
  return browser;
}
const workDirs = new Set(); let exitHook = false;
function removeWorkDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} workDirs.delete(d); }
