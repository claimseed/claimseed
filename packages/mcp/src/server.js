// @claimseed/mcp — an MCP server over claimseed's engine. It lists, generates and renders synthetic specimen
// documents; rendered files go into one workspace folder and nowhere else (see workspace.js). Nothing here reads
// files a client names, reaches the network, or needs a key. The renderer reports progress with console.log, so a
// host serving this over stdio must send console output to stderr, as cli.js does.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateData, listScenarios, loadScenario, render, launchBrowser, RENDERERS, SLUG, SEED } from '@claimseed/core';
import { DOCUMENT_TYPES } from './types.js';
import { openWorkspace } from './workspace.js';
import { createGate, withTimeout, createBrowserPool } from './limits.js';

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
  return { scenario: slug, status: s.status, description: s.description, period: s.period, claimCount: s.claimCount, injectedErrors: kinds, sources: s.sources };
}
function catalog() {
  return Object.fromEntries(TYPES.map((t) => [t, { ...DOCUMENT_TYPES[t], scenarios: listScenarios(t).map((s) => scenarioFacts(t, s)) }]));
}
function mutationCatalog() {
  const ops = {};
  for (const t of TYPES) for (const s of listScenarios(t)) {
    const sc = loadScenario(t, s);
    const muts = sc.mutations || [];
    const kinds = generateData({ type: t, scenario: s, seed: 'describe' }).groundTruth.errors.map((e) => e.kind);
    const aligned = kinds.length === muts.length;   // one recorded error per mutation, in order
    muts.forEach((m, i) => {
      const o = (ops[m.op] ||= { op: m.op, errorKinds: new Set(), usedBy: [] });
      if (aligned) o.errorKinds.add(kinds[i]);
      o.usedBy.push(`${t}/${s}`);
    });
  }
  return { note: 'Mutation ops inject errors into a scenario; docs://error-taxonomy describes every error kind and the rule it breaks.',
    ops: Object.values(ops).map((o) => ({ ...o, errorKinds: [...o.errorKinds] })) };
}
const resourceText = (f) => fs.readFileSync(path.join(RESOURCES, f), 'utf-8');

const INSTRUCTIONS = `claimseed generates synthetic U.S. medical-billing specimen documents (Medicare Summary Notices, hospital itemized
statements, Medicare Advantage explanations of benefits) with a ground truth that lists every deliberately injected
error. Start with list_document_types; describe_document_type shows the scenarios of one type. generate_data returns
the data and ground truth without rendering; render_document writes a PDF and its ground-truth JSON into the
server's workspace folder and returns their paths. Every value is synthetic and every page carries specimen markers.`;

export function createClaimseedServer({ workspace, quotaMB = 500, maxFiles = 2000, concurrency = 2, maxQueue = 4, timeoutMs = 30000, idleMs = 60000, log = (m) => process.stderr.write(`claimseed-mcp: ${m}\n`) } = {}) {
  const ws = openWorkspace(workspace, { quotaBytes: Math.round(quotaMB * 2 ** 20), maxFiles, log });
  const gate = createGate({ concurrency, maxQueue });
  const pool = createBrowserPool({ launch: () => launchBrowser(), idleMs });
  const server = new McpServer({ name: 'claimseed', version: VERSION }, { instructions: INSTRUCTIONS });

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
    description: 'Describe one document type: every scenario with its description, period, number of claims, the errors it injects (kind, severity, rule) and its public sources. A scenario with no injected errors is a clean control.',
    inputSchema: { type: Type },
    outputSchema: { type: z.string(), title: z.string(), description: z.string(), orientation: z.string(), groundTruthSchema: z.string(), scenarios: z.array(z.record(z.string(), z.unknown())) },
    annotations: readOnly,
  }, async ({ type }) => {
    const out = { type, ...DOCUMENT_TYPES[type], groundTruthSchema: 'schema://ground-truth', scenarios: listScenarios(type).map((s) => scenarioFacts(type, s)) };
    return { content: [text(json(out))], structuredContent: out };
  });

  server.registerTool('generate_data', {
    title: 'Generate document data',
    description: 'Generate the data and ground truth of one document without rendering it (nothing is written). The same type, scenario and seed always give the same result. Every value is synthetic.',
    inputSchema: { type: Type, scenario: Scenario, seed: Seed },
    outputSchema: { data: z.record(z.string(), z.unknown()), groundTruth: z.record(z.string(), z.unknown()) },
    annotations: readOnly,
  }, async ({ type, scenario, seed }) => {
    needScenario(type, scenario);
    const out = generateData({ type, scenario, seed });
    return { content: [text(json(out))], structuredContent: out };
  });

  server.registerTool('render_document', {
    title: 'Render a document to PDF',
    description: 'Render one document to PDF in the workspace folder, with its ground-truth JSON beside it, and return both paths, the PDF\'s SHA-256 and page count, and the ground truth. The server names the files itself. When the workspace quota is reached it deletes its own oldest outputs (never any other file). Every page carries specimen markers.',
    inputSchema: { type: Type, scenario: Scenario, seed: Seed },
    outputSchema: { pdf: z.string(), groundTruthFile: z.string(), sha256: z.string(), pages: z.number(), bytes: z.number(), groundTruth: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ type, scenario, seed }, extra) => {
    needScenario(type, scenario);
    const out = await gate.run(async () => {
      const browser = await pool.acquire();
      const gen = pool.generation;
      try {
        return await withTimeout(render({ type, scenario, seed, browser }), timeoutMs, () => pool.kill());
      } catch (e) {
        if (/timed out/.test(e.message)) throw new Error(`${e.message}; the browser was restarted`);
        if (pool.generation !== gen) throw new Error('render stopped: the shared browser was restarted after another render timed out; try again');
        throw e;
      } finally { pool.release(); }
    }, extra?.signal);
    if (extra?.signal?.aborted) throw new Error('request cancelled');
    const gtBytes = Buffer.from(JSON.stringify(out.groundTruth, null, 2));
    const saved = ws.save(`${type}_${scenario}_${seed}`, [{ ext: 'pdf', bytes: out.bytes }, { ext: 'ground-truth.json', bytes: gtBytes }]);
    if (saved.evicted) log(`quota: removed ${saved.evicted} older output file(s)`);
    const doc = out.groundTruth.documents[0];
    const result = { pdf: saved.paths.pdf, groundTruthFile: saved.paths['ground-truth.json'], sha256: crypto.createHash('sha256').update(out.bytes).digest('hex'),
      pages: doc.pages, bytes: out.bytes.length, groundTruth: out.groundTruth };
    const errs = out.groundTruth.errors.map((e) => e.kind);
    return {
      content: [
        text(`Rendered ${type} / ${scenario} / seed ${seed}: ${doc.pages} page(s), ${out.bytes.length} bytes, ${errs.length ? `injected errors: ${errs.join(', ')}` : 'no injected errors'}.\nPDF: ${result.pdf}\nGround truth: ${result.groundTruthFile}`),
        { type: 'resource_link', uri: pathToFileURL(result.pdf).href, name: path.basename(result.pdf), mimeType: 'application/pdf', description: 'synthetic specimen PDF' },
        { type: 'resource_link', uri: pathToFileURL(result.groundTruthFile).href, name: path.basename(result.groundTruthFile), mimeType: 'application/json', description: 'ground truth for the PDF' },
      ],
      structuredContent: result,
    };
  });

  server.registerResource('ground-truth-schema', 'schema://ground-truth', { title: 'Ground-truth JSON schema', description: 'JSON Schema (2020-12) of every ground-truth file and of the ground truth the tools return', mimeType: 'application/schema+json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: resourceText('ground-truth.schema.json') }] }));
  server.registerResource('scenarios', 'catalog://scenarios', { title: 'Scenario catalog', description: 'Every document type and scenario, with the errors each injects and its public sources', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: json(catalog()) }] }));
  server.registerResource('mutations', 'catalog://mutations', { title: 'Mutation ops', description: 'The error-injection operations, the error kinds they produce and the scenarios that use them', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: json(mutationCatalog()) }] }));
  server.registerResource('error-taxonomy', 'docs://error-taxonomy', { title: 'Error taxonomy', description: 'Every error kind, what is wrong, and the public rule it breaks', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resourceText('error-taxonomy.md') }] }));
  server.registerResource('synthetic-data-policy', 'policy://synthetic-data', { title: 'Synthetic data policy', description: 'How every value is made synthetic, and acceptable use of the output', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resourceText('synthetic-data-policy.md') }] }));

  server.registerPrompt('build_test_case', {
    title: 'Build a test case',
    description: 'Plan and render a small set of specimen documents, with expected results, for a testing goal.',
    argsSchema: { goal: z.string().min(1).max(500).describe('what the test should check, e.g. "an extractor reads every claim line of an MSN"'), type: Type.optional() },
  }, ({ goal, type }) => ({
    messages: [{ role: 'user', content: text(`Build a test case with the claimseed tools for this goal: ${goal}
${type ? `Use the ${type} document type.\n` : ''}
1. Call ${type ? `describe_document_type for ${type}` : 'list_document_types, then describe_document_type for the types that fit'}, and choose the scenarios whose injected errors match the goal. Scenarios with no injected errors are clean controls; include one so the test also checks for false alarms.
2. Render each chosen scenario with render_document using two or three different seeds, so the test does not depend on one set of names and amounts.
3. Use each document's ground truth as the expected result: errors[] lists what a reviewer should flag (kind, location, expected and actual values); documents[0].fields lists the values an extractor should read.
4. Finish with a table of the files written (they are in the server's workspace folder) and the expected result for each.
Every document is synthetic and carries specimen markers on every page; keep them on. Do not add real people's information to the workspace or to the test.`) }],
  }));

  return {
    server, workspace: ws, gate, pool,
    async close() { await pool.kill(); await server.close().catch(() => {}); },
  };
}
