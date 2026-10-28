#!/usr/bin/env node
// Smoke test of a running server command (a checkout, an installed package or the Docker image):
//   node packages/mcp/scripts/smoke.js --host-dir DIR [--container-dir /work] -- <command> [args...]
// Starts the command as an MCP server over stdio, lists its tools, renders one document and checks that the PDF and
// its ground truth arrived in DIR (the folder the server writes to, seen from this machine; for a container, the
// host side of its /work mount). Exit 0 on success.
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
  if (names !== 'describe_document_type,generate_data,list_document_types,render_document') throw new Error(`unexpected tools: ${names}`);
  const r = await client.callTool({ name: 'render_document', arguments: { type: 'msn', scenario: 'duplicate-office-visit', seed: 'smoke-1' } }, undefined, { timeout: 120000 });
  if (r.isError) throw new Error(`render_document failed: ${r.content?.[0]?.text}`);
  const out = r.structuredContent;
  const local = (p) => path.join(hostDir, containerDir ? path.relative(containerDir, p) : path.relative(hostDir, p));
  const pdf = fs.readFileSync(local(out.pdf));
  if (crypto.createHash('sha256').update(pdf).digest('hex') !== out.sha256) throw new Error('the PDF on disk does not match the reported SHA-256');
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not a PDF');
  const gt = JSON.parse(fs.readFileSync(local(out.groundTruthFile), 'utf-8'));
  if (gt.errors.map((e) => e.kind).join() !== 'duplicate-charge') throw new Error('unexpected ground truth');
  console.log(`smoke: ok — ${tools.length} tools; rendered ${path.basename(out.pdf)} (${out.pages} pages, ${pdf.length} bytes) into ${hostDir}`);
} finally { await client.close(); }
