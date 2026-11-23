#!/usr/bin/env node
// Smoke test of a running server command (a checkout, an installed package or the Docker image):
//   node packages/mcp/scripts/smoke.js --host-dir DIR [--container-dir /work] -- <command> [args...]
// Starts the command as an MCP server over stdio, lists its tools, renders one document with its 835 and a degraded
// copy, and an EOB with its provider's statement, and checks that the result carries a page image and that the PDF,
// its ground truth, its 835 and the statement arrived in DIR (the folder the server writes to, seen from this machine;
// for a container, the host side of its /work mount).
// Exit 0 on success.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { watermarkCells, WATERMARK_COLOR } from '../../core/src/render.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) { console.error('usage: smoke.js --host-dir DIR [--container-dir DIR] -- <command> [args...]'); process.exit(2); }
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && i < sep ? argv[i + 1] : dflt; };
const hostDir = path.resolve(opt('--host-dir', '.'));
const containerDir = opt('--container-dir', null);
const [command, ...args] = argv.slice(sep + 1);

const client = new Client({ name: 'claimseed-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command, args, env: process.env, stderr: 'inherit' }));
try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort().join(',');
  if (names !== 'degrade_document,describe_document_type,generate_data,get_answer_key,list_document_types,render_blind,render_document,verify_document') throw new Error(`unexpected tools: ${names}`);
  const r = await client.callTool({ name: 'render_document', arguments: { type: 'msn', scenario: 'duplicate-office-visit', seed: 'smoke-1', also: '835' } }, undefined, { timeout: 120000 });
  if (r.isError) throw new Error(`render_document failed: ${r.content?.[0]?.text}`);
  const out = r.structuredContent;
  const local = (p) => path.join(hostDir, containerDir ? path.relative(containerDir, p) : path.relative(hostDir, p));
  const pdf = fs.readFileSync(local(out.pdf));
  if (crypto.createHash('sha256').update(pdf).digest('hex') !== out.sha256) throw new Error('the PDF on disk does not match the reported SHA-256');
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not a PDF');
  const gt = JSON.parse(fs.readFileSync(local(out.groundTruthFile), 'utf-8'));
  if (gt.errors.map((e) => e.kind).join() !== 'duplicate-charge') throw new Error('unexpected ground truth');
  const image = r.content.find((c) => c.type === 'image');
  if (!image || image.mimeType !== 'image/png' || !Buffer.from(image.data, 'base64').subarray(1, 4).equals(Buffer.from('PNG'))) throw new Error('no page image in the result');
  const remittance = fs.readFileSync(local(out.remittance.file));
  if (crypto.createHash('sha256').update(remittance).digest('hex') !== out.remittance.sha256 || !remittance.subarray(0, 3).equals(Buffer.from('ISA'))) throw new Error('the 835 on disk does not match the reported SHA-256');
  // the client checks each structured result against the tool's output schema (it has listed the tools)
  const d = await client.callTool({ name: 'degrade_document', arguments: { type: 'msn', scenario: 'duplicate-office-visit', seed: 'smoke-1', preset: 'low-res', preview: 'none' } }, undefined, { timeout: 180000 });
  if (d.isError) throw new Error(`degrade_document failed: ${d.content?.[0]?.text}`);
  if (d.structuredContent.degradation !== 'low-res' || !fs.existsSync(local(d.structuredContent.pdf))) throw new Error('the degraded copy is missing');
  // a provider's statement beside an EOB: its PDF and key arrive beside the EOB's, and the PDF matches its SHA-256
  const p = await client.callTool({ name: 'render_document', arguments: { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'smoke-1', also: ['835', 'bill'], preview: 'none' } }, undefined, { timeout: 180000 });
  if (p.isError) throw new Error(`render_document with a statement failed: ${p.content?.[0]?.text}`);
  const bill = p.structuredContent.bill;
  if (!bill || !bill.pdf || !bill.groundTruthFile) throw new Error('the statement is missing');
  const billPdf = fs.readFileSync(local(bill.pdf));
  if (crypto.createHash('sha256').update(billPdf).digest('hex') !== bill.sha256) throw new Error('the statement on disk does not match the reported SHA-256');
  if (JSON.parse(fs.readFileSync(local(bill.groundTruthFile), 'utf-8')).documents[0].type !== 'provider-statement') throw new Error('unexpected statement key');
  // insurer a prints one claim in the top of each later page: the watermark is drawn up there, over it, not in the middle
  const c = await client.callTool({ name: 'render_document', arguments: { type: 'commercial-eob', scenario: 'surprise-balance-bill', seed: 'example', insurer: 'a', preview: 'none' } }, undefined, { timeout: 180000 });
  if (c.isError) throw new Error(`render_document of a commercial EOB failed: ${c.content?.[0]?.text}`);
  const doc = await PDFDocument.load(fs.readFileSync(local(c.structuredContent.pdf)), { updateMetadata: false }); const page2 = doc.getPage(1);
  const k = page2.node.Contents(); const streams = (k instanceof PDFArray ? k.asArray() : [k]).map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1')).join('\n');
  const w = WATERMARK_COLOR; const at = new RegExp(`${w.red} ${w.green} ${w.blue} rg\\n0 w\\n\\[\\] 0 d\\n1 0 0 1 (-?[\\d.]+) (-?[\\d.]+) cm`).exec(streams);
  const middle = watermarkCells(page2.getWidth(), page2.getHeight(), { fy: 0.5 })[0][0];
  if (!at || !(Number(at[2]) > middle[1] + 36)) throw new Error(`the commercial EOB's page 2 watermark is not over its claim (${at ? at[2] : 'none'} against the middle's ${middle[1].toFixed(1)})`);
  console.log(`smoke: ok — ${tools.length} tools; rendered ${path.basename(out.pdf)} (${out.pages} pages, ${pdf.length} bytes), its 835, a low-res copy and a provider's statement into ${hostDir}`);
} finally { await client.close(); }
