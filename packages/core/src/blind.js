// blind.js — documents that tell the tool reading them nothing about what was planted in them.
//
// A blind document is generated from a seed derived from a secret salt, named by an opaque id drawn from the same salt,
// and written apart from its answer key: its specimen band, PDF title, file names and page-image markers carry the id
// and nothing of the type's scenario or the seed asked for. The salt is 128 random bits per set unless the caller passes
// one (from an earlier set's answer key, to make the same set again); without it, nobody can rebuild a document from a
// guessed scenario and seed and match it to a printed claim number. The answer key records the salt, the seed asked for
// and the id, so the key alone reproduces the document.
import crypto from 'crypto'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';

export const BLIND_STRINGS = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/blind.json'), 'utf-8'));
// a message with its {who} filled in
export const blindMessage = (key, who) => BLIND_STRINGS.messages[key].replace('{who}', who);

// The folder options as a caller gives them: absent (null or undefined) or a path written as text, 1 to 4,096
// characters with no NUL. Anything else is refused before it is converted or reaches the file system, so a refused
// value makes no folder; the message names no value.
const FOLDER_MAX = 4096;
const folderText = (v) => v === null || v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= FOLDER_MAX && !v.includes('\u0000'));
export function checkFolders({ outDir = null, keysDir = null }, who) {
  if (!folderText(outDir)) throw new Error(blindMessage('outDirText', who));
  if (!folderText(keysDir)) throw new Error(blindMessage('keysDirText', who));
}

export const SALT = /^[0-9a-f]{32}$/;
export const BLIND_ID = /^doc-[0-9a-f]{16}$/;

// A blind option as a caller gives it: true (a new random salt) or { salt } (an earlier set's salt). Anything else is
// refused; the message names no value.
export function blindSalt(blind) {
  if (blind === true) return crypto.randomBytes(16).toString('hex');
  if (blind && typeof blind === 'object' && !Array.isArray(blind) && Object.keys(blind).length === 1 && typeof blind.salt === 'string' && SALT.test(blind.salt)) return blind.salt;
  throw new Error(BLIND_STRINGS.messages.blindOption);
}

const mac = (salt, ...parts) => crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(parts.map(String).join('\u0000')).digest('hex');
const jobParts = ({ type, scenario, seed, layoutVariant = null }) => [type, scenario, seed, layoutVariant ?? ''];

// The seed a blind document is generated from: 32 characters, a valid seed, unguessable without the salt.
export function blindSeed(salt, job) { return `b${mac(salt, 'seed', ...jobParts(job)).slice(0, 31)}`; }

// The document's id (a degraded copy gets its own, blindCopyId, so a document and its copy share nothing visible).
export function blindId(salt, job) { return `doc-${mac(salt, 'id', ...jobParts(job)).slice(0, 16)}`; }

// The jobs of a set in an order drawn from the salt, so the order files are written in (and their times) says nothing
// about the order of scenarios they were planned in.
export function blindOrder(salt, jobs) {
  return jobs.map((job, i) => ({ job, k: mac(salt, 'order', i, ...jobParts(job)) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((x) => x.job);
}

// A degraded copy's id, drawn from the salt and the clean document's id.
export function blindCopyId(salt, id, preset) { return `doc-${mac(salt, 'copy', id, preset).slice(0, 16)}`; }

// What the answer key of a blind document records beside its own fields (the id, the salt, and the seed and layout
// variant as asked, which with the type and scenario rebuild it), and the schema version it is written at. A degraded
// copy also records the id of the document it was made from.
export const BLIND_SCHEMA_VERSION = '1.5';
export function blindRecord(salt, job, id) { return { id, salt, seed: String(job.seed), layoutVariant: job.layoutVariant ?? null }; }
