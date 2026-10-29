// safe-read.js — read a file whose name came from outside (a manifest, a report folder, a command-line argument)
// without the ways a plain read goes wrong: a symbolic link at the last component is refused unless `follow` is set,
// a FIFO, socket or device is refused instead of blocking, and no more than `max` bytes are ever read, whatever the
// file claims its size to be. The open, the check and the read use one descriptor, so the file cannot be swapped
// between them. Errors carry code 'NOT_REGULAR' or 'TOO_LARGE', or the system's code (ENOENT and the rest).
import fs from 'fs';

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;   // not on Windows: a link is then refused by an lstat first
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const fail = (message, code) => Object.assign(new Error(message), { code });

export function readRegularFile(file, max, { follow = false } = {}) {
  if (!follow && !O_NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) throw fail('a symbolic link', 'NOT_REGULAR');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | O_NONBLOCK | (follow ? 0 : O_NOFOLLOW)); }
  catch (e) { if (e.code === 'ELOOP' || e.code === 'EMLINK') throw fail('a symbolic link', 'NOT_REGULAR'); throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail('not a regular file', 'NOT_REGULAR');
    if (st.size > max) throw fail(`over ${max} bytes`, 'TOO_LARGE');
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (;;) {
      if (n === buf.length) throw fail(`over ${max} bytes`, 'TOO_LARGE');   // it grew past its size while being read
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) throw fail(`over ${max} bytes`, 'TOO_LARGE');
    }
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
