#!/usr/bin/env node
// Smoke test of a running server command (a checkout, an installed package or the Docker image):
//   node packages/mcp/scripts/smoke.js --host-dir DIR [--container-dir /work] -- <command> [args...]
// Starts the command as an MCP server over stdio, lists its tools, renders one document with its 835 and a degraded
// copy, and checks that the result carries a page image and that the PDF, its ground truth and its 835 arrived in DIR
// (the folder the server writes to, seen from this machine; for a container, the host side of its /work mount).
// Exit 0 on success.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  if (names !== 'degrade_document,describe_document_type,generate_data,list_document_types,render_document,verify_document') throw new Error(`unexpected tools: ${names}`);
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
  console.log(`smoke: ok — ${tools.length} tools; rendered ${path.basename(out.pdf)} (${out.pages} pages, ${pdf.length} bytes), its 835 and a low-res copy into ${hostDir}`);
} finally { await client.close(); }
