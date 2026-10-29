// @claimseed/mcp — an MCP server over claimseed's engine. It lists, generates and renders synthetic specimen
// documents. With a workspace folder, rendered files go into that folder and nowhere else (see workspace.js); without
// one, no file is saved and each document comes back in the tool result (page images, and the PDF on request).
// Nothing here reads files a client names, reaches the network, or needs a key. The renderer reports progress with
// console.log, so a host serving this over stdio must send console output to stderr, as cli.js does.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateData, listScenarios, loadScenario, render, launchBrowser, verifyFromSeed, RENDERERS, SLUG, SEED } from '@claimseed/core';
import { DOCUMENT_TYPES } from './types.js';
import { openWorkspace } from './workspace.js';
import { createGate, withTimeout, createBrowserPool } from './limits.js';
import { previewPages } from './preview.js';
import { VIEW_URI, VIEW_MIME, VIEW_HTML } from './view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(here, '../resources');
const PKG = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf-8'));
export const VERSION = PKG.version;
export const TYPES = Object.keys(RENDERERS).filter((t) => DOCUMENT_TYPES[t] && listScenarios(t).length);

const json = (o) => JSON.stringify(o, null, 2);
const text = (t) => ({ type: 'text', text: t });

// Scenario facts for listings. The error kinds come from the scenario's own ground truth (generated, no browser),
// so the listing cannot drift from what a render actually injects.
function scenarioFacts(type, slug) {
  const s = loadScenario(type, slug);
  const { groundTruth } = generateData({ type, scenario: slug, seed: 'describe' });
  const kinds = [...new Map(groundTruth.errors.map((e) => [e.kind, { kind: e.kind, severity: e.severity, rule: e.rule }])).values()];
  const decoys = [...new Map((groundTruth.decoys || []).map((d) => [d.kind, { kind: d.kind, rule: d.rule }])).values()];
  return { scenario: slug, status: s.status, description: s.description, period: s.period, claimCount: s.claimCount, injectedErrors: kinds, decoys,
    cleanControl: !kinds.length && !decoys.length, sources: s.sources };
}
function catalog() {
  return Object.fromEntries(TYPES.map((t) => [t, { ...DOCUMENT_TYPES[t], scenarios: listScenarios(t).map((s) => scenarioFacts(t, s)) }]));
}
function mutationCatalog() {
  const ops = {}; const decoyOps = {};
  for (const t of TYPES) for (const s of listScenarios(t)) {
    const sc = loadScenario(t, s);
    const muts = sc.mutations || [];
    const gt = generateData({ type: t, scenario: s, seed: 'describe' }).groundTruth;
    const kinds = gt.errors.map((e) => e.kind);
    const aligned = kinds.length === muts.length;   // one recorded error per mutation, in order
    muts.forEach((m, i) => {
      const o = (ops[m.op] ||= { op: m.op, errorKinds: new Set(), usedBy: [] });
      if (aligned) o.errorKinds.add(kinds[i]);
      o.usedBy.push(`${t}/${s}`);
    });
    (sc.decoys || []).forEach((d, i) => {
      const o = (decoyOps[d.op] ||= { op: d.op, decoyKinds: new Set(), usedBy: [] });
      if (gt.decoys[i]) o.decoyKinds.add(gt.decoys[i].kind);
      o.usedBy.push(`${t}/${s}`);
    });
  }
  return { note: 'Mutation ops inject errors into a scenario; decoy ops plant correct lines that look wrong. docs://error-taxonomy describes every error and decoy kind and the rule behind it.',
    ops: Object.values(ops).map((o) => ({ ...o, errorKinds: [...o.errorKinds] })),
    decoyOps: Object.values(decoyOps).map((o) => ({ ...o, decoyKinds: [...o.decoyKinds] })) };
}
const resourceText = (f) => fs.readFileSync(path.join(RESOURCES, f), 'utf-8');
const { $schema: _s, $id: _i, title: _t, ...REPORT_SCHEMA } = JSON.parse(resourceText('extractor-output.schema.json'));
REPORT_SCHEMA.description = `the extractor's report (schema://extractor-output). ${REPORT_SCHEMA.description}`;

const INSTRUCTIONS_BASE = `claimseed generates synthetic U.S. medical-billing specimen documents (Medicare Summary Notices, hospital itemized
statements, Medicare Advantage explanations of benefits) with a ground truth that lists every deliberately injected
error. Start with list_document_types; describe_document_type shows the scenarios of one type. generate_data returns
the data and ground truth without rendering. verify_document scores what an extractor or bill auditor reported about
a document against its answer key: fields read, errors found and missed, and false alarms, including decoys (lines that
look wrong but follow the rules).`;
const INSTRUCTIONS_WORKSPACE = `${INSTRUCTIONS_BASE} render_document writes a PDF and its ground-truth JSON into the
server's workspace folder, returns their paths and shows the first page as an image (preview "all" shows every page).
Every value is synthetic and every page carries specimen markers.`;
const INSTRUCTIONS_INLINE = `${INSTRUCTIONS_BASE} This server has no workspace folder and saves no files: render_document returns the
document's pages as images (shown in the conversation by clients that display images or MCP Apps), its ground truth,
and, with include_pdf, the PDF itself. When a document has more pages than fit in one result, render it again with
from_page to see the rest; the same type, scenario and seed always give the same document. Every value is synthetic
and every page carries specimen markers.`;

// `workspace`: the folder rendered files go to, or null for none (no file is saved; documents come back in the
// result). `previewKB`: the most page-image data, as base64, one render_document result carries (with the PDF when
// include_pdf is set); the first requested page is always included, drawn smaller if it alone would not fit.
export function createClaimseedServer({ workspace = null, quotaMB = 500, maxFiles = 2000, concurrency = 2, maxQueue = 4, timeoutMs = 30000, idleMs = 60000, previewKB = 800, log = (m) => process.stderr.write(`claimseed-mcp: ${m}\n`) } = {}) {
  const ws = workspace ? openWorkspace(workspace, { quotaBytes: Math.round(quotaMB * 2 ** 20), maxFiles, log }) : null;
  const gate = createGate({ concurrency, maxQueue });
  const pool = createBrowserPool({ launch: () => launchBrowser(), idleMs });
  const server = new McpServer({ name: 'claimseed', version: VERSION }, { instructions: ws ? INSTRUCTIONS_WORKSPACE : INSTRUCTIONS_INLINE });

  const Type = z.enum(TYPES).describe(`document type: ${TYPES.join(', ')}`);
  const Scenario = z.string().regex(SLUG).describe('scenario slug, e.g. baseline-clean (see describe_document_type)');
  const Seed = z.string().regex(SEED).default('claimseed').describe('any short string (letters, digits, . _ -); the same seed always gives the same document');
  const needScenario = (type, scenario) => {
    if (!listScenarios(type).includes(scenario)) throw new Error(`no scenario "${scenario}" for ${type}; scenarios: ${listScenarios(type).join(', ')}`);
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool('list_document_types', {
    title: 'List document types',
    description: 'List the document types claimseed can render, each with a short description and its scenario slugs.',
    inputSchema: {},
    outputSchema: { types: z.array(z.object({ type: z.string(), title: z.string(), description: z.string(), orientation: z.string(), scenarios: z.array(z.string()) })) },
    annotations: readOnly,
  }, async () => {
    const types = TYPES.map((t) => ({ type: t, ...DOCUMENT_TYPES[t], scenarios: listScenarios(t) }));
    return { content: [text(json({ types }))], structuredContent: { types } };
  });

  server.registerTool('describe_document_type', {
    title: 'Describe a document type',
    description: 'Describe one document type: every scenario with its description, period, number of claims, the errors it injects (kind, severity, rule), its decoys (lines that look wrong but follow the rules) and its public sources. A scenario with neither errors nor decoys is a clean control.',
    inputSchema: { type: Type },
    outputSchema: { type: z.string(), title: z.string(), description: z.string(), orientation: z.string(), groundTruthSchema: z.string(), scenarios: z.array(z.record(z.string(), z.unknown())) },
    annotations: readOnly,
  }, async ({ type }) => {
    const out = { type, ...DOCUMENT_TYPES[type], groundTruthSchema: 'schema://ground-truth', scenarios: listScenarios(type).map((s) => scenarioFacts(type, s)) };
    return { content: [text(json(out))], structuredContent: out };
  });

  server.registerTool('generate_data', {
    title: 'Generate document data',
    description: 'Generate the data and ground truth of one document without rendering it (no file is saved). The same type, scenario and seed always give the same result. Every value is synthetic.',
    inputSchema: { type: Type, scenario: Scenario, seed: Seed },
    outputSchema: { data: z.record(z.string(), z.unknown()), groundTruth: z.record(z.string(), z.unknown()) },
    annotations: readOnly,
  }, async ({ type, scenario, seed }) => {
    needScenario(type, scenario);
    const out = generateData({ type, scenario, seed });
    return { content: [text(json(out))], structuredContent: out };
  });

  const Preview = z.enum(['none', 'first', 'all']).default(ws ? 'first' : 'all')
    .describe(`pages returned as images: none, the first (from from_page), or all from from_page on, as many as fit in one result (default ${ws ? 'first' : 'all'})`);
  const PreviewOut = z.object({ pages: z.array(z.number()), omitted: z.number(), next: z.number().nullable() });
  server.registerTool('render_document', {
    title: 'Render a document to PDF',
    description: ws
      ? 'Render one document to PDF in the workspace folder, with its ground-truth JSON beside it, and return both paths, the PDF\'s SHA-256 and page count, the ground truth, and page images (the first page by default). The server names the files itself. When the workspace quota is reached it deletes its own oldest outputs from the current run (never any other file, nor outputs of earlier runs). Every page carries specimen markers.'
      : 'Render one document and return it in the result: its pages as images (as many as fit; from_page shows the rest), the ground truth, the PDF\'s SHA-256 and page count, and the PDF itself when include_pdf is set and it fits within the size limit. No file is saved. Every page carries specimen markers.',
    inputSchema: {
      type: Type, scenario: Scenario, seed: Seed, preview: Preview,
      from_page: z.number().int().min(1).max(999).default(1).describe('first page to return as an image (default 1)'),
      include_pdf: z.boolean().default(false).describe('also return the PDF itself, embedded in the result; it counts toward the same size limit as the page images and is left out, with a note, when it alone is over it'),
    },
    outputSchema: { type: z.string(), scenario: z.string(), seed: z.string(), pdf: z.string().nullable(), groundTruthFile: z.string().nullable(), sha256: z.string(), pages: z.number(), bytes: z.number(), pdfEmbedded: z.boolean(), groundTruth: z.record(z.string(), z.unknown()), preview: PreviewOut },
    annotations: ws ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: VIEW_URI }, 'ui/resourceUri': VIEW_URI },
  }, async ({ type, scenario, seed, preview = ws ? 'first' : 'all', from_page: fromPage = 1, include_pdf: includePdf = false }, extra) => {
    needScenario(type, scenario);
    const out = await gate.run(async () => {
      const browser = await pool.acquire();
      const gen = pool.generation;
      try {
        return await withTimeout((async () => {
          const r = await render({ type, scenario, seed, browser });
          // the PDF, when asked for, counts toward the same limit: it goes in only when it fits, and the pictures then
          // take what room is left (none forced in); a PDF over the limit is left out and the result says so
          r.pdfBase64Bytes = 4 * Math.ceil(r.bytes.length / 3);
          r.embedPdf = includePdf && r.pdfBase64Bytes <= previewKB * 1024;
          const budget = previewKB * 1024 - (r.embedPdf ? r.pdfBase64Bytes : 0);
          // the document stands without its pictures: if they cannot be drawn, the result says so and carries none
          if (preview !== 'none') {
            try { r.preview = await previewPages(browser, r.bytes, { pages: preview, from: fromPage, budget, forceFirst: !r.embedPdf, label: `${type} / ${scenario} / seed ${seed}` }); }
            catch (e) { r.previewError = String(e.message).split('\n')[0].slice(0, 200); log(`page images failed: ${r.previewError}`); }
          }
          return r;
        })(), timeoutMs, () => pool.kill());
      } catch (e) {
        if (/timed out/.test(e.message)) throw new Error(`${e.message}; the browser was restarted`);
        if (pool.generation !== gen) throw new Error('render stopped: the shared browser was restarted after another render timed out; try again');
        throw e;
      } finally { pool.release(); }
    }, extra?.signal);
    if (extra?.signal?.aborted) throw new Error('request cancelled');
    let saved = null;
    if (ws) {
      const gtBytes = Buffer.from(JSON.stringify(out.groundTruth, null, 2));
      saved = ws.save(`${type}_${scenario}_${seed}`, [{ ext: 'pdf', bytes: out.bytes }, { ext: 'ground-truth.json', bytes: gtBytes }]);
      if (saved.evicted) log(`quota: removed ${saved.evicted} older output file(s)`);
    }
    const doc = out.groundTruth.documents[0];
    const images = out.preview?.images || [];
    const shown = images.map((i) => i.page);
    const last = shown.length ? shown[shown.length - 1] : (preview === 'none' ? doc.pages : Math.min(fromPage - 1, doc.pages));
    const omitted = Math.max(0, doc.pages - last);
    const result = { type, scenario, seed, pdf: saved ? saved.paths.pdf : null, groundTruthFile: saved ? saved.paths['ground-truth.json'] : null,
      sha256: crypto.createHash('sha256').update(out.bytes).digest('hex'), pages: doc.pages, bytes: out.bytes.length, pdfEmbedded: !!out.embedPdf, groundTruth: out.groundTruth,
      preview: { pages: shown, omitted: preview === 'none' || out.previewError ? 0 : omitted, next: preview !== 'none' && !out.previewError && omitted ? last + 1 : null } };
    const errs = out.groundTruth.errors.map((e) => e.kind);
    const range = (a) => (a.length > 1 ? `pages ${a[0]}-${a[a.length - 1]}` : `page ${a[0]}`);
    const lines = [`Rendered ${type} / ${scenario} / seed ${seed}: ${doc.pages} page(s), ${out.bytes.length} bytes, ${errs.length ? `injected errors: ${errs.join(', ')}` : 'no injected errors'}.`];
    if (out.previewError) lines.push(`Page images could not be drawn (${out.previewError}); the document itself is unaffected.`);
    else if (preview !== 'none') {
      if (shown.length) lines.push(`Shown below as images: ${range(shown)} of ${doc.pages}.${result.preview.next ? ` ${omitted} more: call render_document again with from_page ${result.preview.next}.` : ''}`);
      else if (fromPage > doc.pages) lines.push(`No page images: the document has ${doc.pages} page(s) and from_page was ${fromPage}.`);
      else lines.push(`No page images: the embedded PDF left no room within this server's limit for one result; call render_document again without include_pdf to see the pages.`);
    }
    if (saved) lines.push(`PDF: ${result.pdf}`, `Ground truth: ${result.groundTruthFile}`);
    if (includePdf && !out.embedPdf) lines.push(`The PDF (${Math.ceil(out.pdfBase64Bytes / 1024)} KB as base64) is larger than this server's limit for one result (${previewKB} KB, CLAIMSEED_MCP_PREVIEW_KB) and was left out; raise the limit or run the server with a workspace.`);
    if (!saved) lines.push(out.embedPdf ? 'The PDF is embedded in this result. No file was saved.' : `No file was saved${includePdf ? '' : '; set include_pdf to get the PDF in the result'}.`);
    lines.push('Ground truth (expected findings and field values) is in the structured result.');
    const content = [text(lines.join('\n'))];
    for (const i of images) content.push({ type: 'image', mimeType: i.mimeType, data: i.data });
    if (out.embedPdf) content.push({ type: 'resource', resource: { uri: `claimseed://document/${type}/${scenario}/${seed}.pdf`, mimeType: 'application/pdf', blob: out.bytes.toString('base64') } });
    if (saved) content.push(
      { type: 'resource_link', uri: pathToFileURL(result.pdf).href, name: path.basename(result.pdf), mimeType: 'application/pdf', description: 'synthetic specimen PDF' },
      { type: 'resource_link', uri: pathToFileURL(result.groundTruthFile).href, name: path.basename(result.groundTruthFile), mimeType: 'application/json', description: 'ground truth for the PDF' });
    return { content, structuredContent: result };
  });

  server.registerTool('verify_document', {
    title: 'Score an extractor against a document',
    description: 'Score what an extractor or bill auditor reported about one document against its answer key, rebuilt from the type, scenario and seed with this version of claimseed. The report uses the answer key\'s vocabulary (schema://extractor-output): `fields` maps field paths of documents[0].fields to the values read; `errors` lists flagged errors as { kind, fieldRef or lineRef }. Returns field accuracy with the paths read wrong or missed, error recall and precision, false alarms, and which decoys were flagged. The result names only answer-key paths, kinds and decoy ids, never the text sent. Nothing is rendered or written.',
    inputSchema: {
      type: Type, scenario: Scenario, seed: Seed,
      // the report reaches the shared check exactly as the client sent it: an object schema would copy it and silently
      // drop an own "__proto__" key, which the check must see and refuse as the command line does (without echoing it).
      // Clients are shown the extractor-output schema.
      output: z.unknown().meta(REPORT_SCHEMA),
    },
    outputSchema: { answerKey: z.object({ scenario: z.string(), seed: z.string(), schemaVersion: z.string() }), fields: z.record(z.string(), z.unknown()).nullable(), errors: z.record(z.string(), z.unknown()).nullable() },
    annotations: readOnly,
  }, async ({ type, scenario, seed, output }) => {
    needScenario(type, scenario);
    const r = verifyFromSeed({ type, scenario, seed, output });
    const f = r.fields ? `fields ${r.fields.correct}/${r.fields.expected} correct (${r.fields.wrong} wrong, ${r.fields.missing} missing)` : 'fields not scored';
    const e = r.errors ? `errors ${r.errors.found}/${r.errors.expected} found, ${r.errors.falseAlarms} false alarm(s)${r.errors.decoysFlagged.length ? ` incl. ${r.errors.decoysFlagged.length} decoy(s)` : ''}` : 'errors not scored';
    return { content: [text(`${type} / ${scenario} / seed ${seed}: ${f}; ${e}.\n${json(r)}`)], structuredContent: r };
  });

  server.registerResource('ground-truth-schema', 'schema://ground-truth', { title: 'Ground-truth JSON schema', description: 'JSON Schema (2020-12) of every ground-truth file and of the ground truth the tools return', mimeType: 'application/schema+json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: resourceText('ground-truth.schema.json') }] }));
  server.registerResource('extractor-output-schema', 'schema://extractor-output', { title: 'Extractor-output JSON schema', description: 'JSON Schema (2020-12) of the report verify_document scores: fields read and errors flagged, in the answer key\'s vocabulary', mimeType: 'application/schema+json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: resourceText('extractor-output.schema.json') }] }));
  server.registerResource('scenarios', 'catalog://scenarios', { title: 'Scenario catalog', description: 'Every document type and scenario, with the errors each injects and its public sources', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: json(catalog()) }] }));
  server.registerResource('mutations', 'catalog://mutations', { title: 'Mutation ops', description: 'The error-injection and decoy operations, the kinds they produce and the scenarios that use them', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: json(mutationCatalog()) }] }));
  server.registerResource('error-taxonomy', 'docs://error-taxonomy', { title: 'Error taxonomy', description: 'Every error kind, what is wrong, and the public rule it breaks', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resourceText('error-taxonomy.md') }] }));
  server.registerResource('synthetic-data-policy', 'policy://synthetic-data', { title: 'Synthetic data policy', description: 'How every value is made synthetic, and acceptable use of the output', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resourceText('synthetic-data-policy.md') }] }));

  server.registerResource('preview-view', VIEW_URI, { title: 'Document preview', description: 'MCP Apps view of render_document: the page images and injected errors of a rendered document', mimeType: VIEW_MIME },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: VIEW_MIME, text: VIEW_HTML, _meta: { ui: { prefersBorder: true } } }] }));

  server.registerPrompt('build_test_case', {
    title: 'Build a test case',
    description: 'Plan and render a small set of specimen documents, with expected results, for a testing goal.',
    argsSchema: { goal: z.string().min(1).max(500).describe('what the test should check, e.g. "an extractor reads every claim line of an MSN"'), type: Type.optional() },
  }, ({ goal, type }) => ({
    messages: [{ role: 'user', content: text(`Build a test case with the claimseed tools for this goal: ${goal}
${type ? `Use the ${type} document type.\n` : ''}
1. Call ${type ? `describe_document_type for ${type}` : 'list_document_types, then describe_document_type for the types that fit'}, and choose the scenarios whose injected errors match the goal. Scenarios with neither errors nor decoys are clean controls, and scenarios with decoys hold lines that look wrong but follow the rules; include one of each so the test also checks for false alarms.
2. Render each chosen scenario with render_document using two or three different seeds, so the test does not depend on one set of names and amounts. Pass preview "none" for the renders you do not need to look at.
3. Use each document's ground truth as the expected result: errors[] lists what a reviewer should flag (kind, location, expected and actual values), decoys[] what it should not flag, and documents[0].fields the values an extractor should read. verify_document scores a report against it.
4. Finish with a table of the documents rendered (${ws ? 'the files are in the server\'s workspace folder' : 'type, scenario, seed and SHA-256; the server saves no files, and include_pdf returns a PDF in the result'}) and the expected result for each.
Every document is synthetic and carries specimen markers on every page; keep them on. Do not add real people's information to the workspace or to the test.`) }],
  }));

  return {
    server, workspace: ws, gate, pool,
    async close() { await pool.kill(); await server.close().catch(() => {}); },
  };
}
