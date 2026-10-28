// Layout -> render function. Every render function takes (data, stock, workDir, { band, title }) and returns the
// path of a finished PDF: merged, stamped with the specimen band and watermark on every page (pdf-lib, inside
// mergePdfs) and carrying the specimen metadata. The CLI (src/cli.js) and the library API share this path.
// Adding a type: add its assembler to generate/index.js ASSEMBLERS, its stock content to
// data/<type>/stock-content.json, its templates under templates/<type>/, and one line here.
import { renderMsn, renderItemizedBill } from './render.js';
import { renderPpoEob, renderHmoEob } from './render-ma.js';

export const RENDERERS = {
  'msn': renderMsn,
  'itemized-bill': renderItemizedBill,
  'ppo-eob': renderPpoEob,
  'hmo-eob': renderHmoEob,
};
