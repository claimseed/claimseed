// The one folder the server writes to.
//
// - The folder is fixed at startup (resolved to its real path) and re-checked before every write, so it cannot be
//   swapped for a link to somewhere else while the server runs.
// - The server chooses every file name itself; nothing a client sends becomes part of a path except the validated
//   type, scenario and seed slugs.
// - Files are created exclusively and without following links: an existing file or symbolic link at the chosen
//   name makes the write fail rather than be overwritten or followed.
// - Every file the server writes is recorded in a ledger (.claimseed-mcp.json in the folder) with its size and
//   SHA-256. To stay under the quota the server deletes its own oldest outputs, and only those whose bytes are still
//   exactly what it wrote; any other file in the folder, or an output someone has since changed, is never deleted.
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';

export const LEDGER = '.claimseed-mcp.json';
const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;   // not defined on Windows, where O_EXCL alone refuses an existing link
const NAME = /^[a-z0-9][a-z0-9-]{0,63}_[a-z0-9][a-z0-9-]{0,63}_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{12}\.(pdf|ground-truth\.json)$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function openWorkspace(dir, { quotaBytes = 500 * 2 ** 20, maxFiles = 2000, log = () => {} } = {}) {
  if (!dir) throw new Error('no workspace folder: set CLAIMSEED_WORKSPACE or pass --workspace DIR');
  const given = path.resolve(dir);
  let st;
  try { st = fs.statSync(given); } catch { throw new Error(`workspace folder ${given} does not exist`); }
  if (!st.isDirectory()) throw new Error(`workspace ${given} is not a folder`);
  const root = fs.realpathSync(given);
  if (root === path.parse(root).root || root === fs.realpathSync(os.homedir())) {
    throw new Error(`refusing ${root} as the workspace: give the server a folder of its own (for example ~/claimseed-out)`);
  }

  function checkRoot() {
    let real;
    try { real = fs.realpathSync(root); } catch { throw new Error('the workspace folder is gone'); }
    if (real !== root || !fs.lstatSync(root).isDirectory()) throw new Error('the workspace folder was moved or replaced by a link; restart the server');
  }

  // The ledger is read without following links and only entries with a server-made name are kept, so a hand-edited
  // ledger can at most make the server forget files, never delete a file it did not write.
  function readLedger() {
    const p = path.join(root, LEDGER);
    let raw;
    try {
      if (!fs.lstatSync(p).isFile()) { log(`ignoring ${LEDGER}: not a regular file`); return []; }
      raw = fs.readFileSync(p, 'utf-8');
    } catch { return []; }
    try {
      const j = JSON.parse(raw);
      return (Array.isArray(j.files) ? j.files : []).filter((e) => e && NAME.test(String(e.name)) && Number.isSafeInteger(e.bytes) && e.bytes >= 0
        && /^[0-9a-f]{64}$/.test(String(e.sha256)) && Number.isFinite(e.at));
    } catch { log(`ignoring ${LEDGER}: not valid JSON (earlier outputs will not be cleaned up automatically)`); return []; }
  }
  function writeLedger(files) {
    const tmp = path.join(root, `${LEDGER}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    writeExclusive(tmp, Buffer.from(JSON.stringify({ note: 'files written by the claimseed MCP server; it deletes only these, oldest first, to stay under its quota', files }, null, 1)));
    fs.renameSync(tmp, path.join(root, LEDGER));   // replaces the name itself; a link at that name is replaced, not followed
  }
  function writeExclusive(p, bytes) {
    const fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, bytes); } finally { fs.closeSync(fd); }
  }
  // Delete one ledger entry's file if, and only if, it is still the regular file the server wrote.
  function evict(e) {
    const p = path.join(root, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { return 0; }
    if (!st.isFile() || st.size !== e.bytes) return 0;
    if (sha256(fs.readFileSync(p)) !== e.sha256) return 0;
    fs.unlinkSync(p);
    return e.bytes;
  }

  return {
    root,
    quotaBytes, maxFiles,
    // Write one output set (e.g. a PDF and its ground truth) under a fresh server-chosen base name.
    // files: [{ ext: 'pdf' | 'ground-truth.json', bytes: Buffer }]; returns { base, paths: { [ext]: absolutePath }, evicted }.
    save(stem, files) {
      const total = files.reduce((n, f) => n + f.bytes.length, 0);
      if (total > quotaBytes) throw new Error(`output of ${total} bytes is larger than the workspace quota of ${quotaBytes} bytes`);
      const base = `${stem}_${crypto.randomBytes(6).toString('hex')}`;
      const names = files.map((f) => `${base}.${f.ext}`);
      if (!names.every((n) => NAME.test(n))) throw new Error('internal: unexpected output name');
      checkRoot();
      let ledger = readLedger().sort((a, b) => a.at - b.at);
      let used = ledger.reduce((n, e) => n + e.bytes, 0);
      let evicted = 0;
      while (ledger.length && (used + total > quotaBytes || ledger.length + files.length > maxFiles)) {
        const e = ledger.shift(); used -= e.bytes; evicted += evict(e) ? 1 : 0;
      }
      const paths = {}; const written = [];
      try {
        for (const [i, f] of files.entries()) {
          const name = names[i];
          const p = path.join(root, name);
          writeExclusive(p, f.bytes);
          written.push(p); paths[f.ext] = p;
          ledger.push({ name, bytes: f.bytes.length, sha256: sha256(f.bytes), at: Date.now() });
        }
        writeLedger(ledger);
      } catch (e) {
        for (const p of written) { try { fs.unlinkSync(p); } catch {} }
        throw e;
      }
      return { base, paths, evicted };
    },
    usage() { const l = readLedger(); return { files: l.length, bytes: l.reduce((n, e) => n + e.bytes, 0) }; },
  };
}
