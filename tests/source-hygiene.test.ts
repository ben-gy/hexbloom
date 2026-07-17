/**
 * source-hygiene.test.ts — no literal control bytes in source files.
 *
 * This exists because it has already happened twice. A control character typed
 * straight into a source file (a NUL as a map-key separator, an escape byte in a
 * test fixture) compiles and runs perfectly — and then:
 *
 *   - `file` reports the source as "data" and `git` shows it as Bin,
 *   - `diff` refuses it as "Binary files differ",
 *   - and plain `grep` SILENTLY MATCHES NOTHING in it.
 *
 * That last one is the dangerous part: an audit that greps the file gets an
 * all-clear it did not earn. Write the escape sequence (\x00, \u001b) instead —
 * it is the same value to the compiler and stays readable to every tool.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    // dictionary.txt is data, not source, and is huge — skip the asset files.
    else if (/\.(ts|css|html|json|webmanifest)$/.test(name)) out.push(path);
  }
  return out;
}

/** Tab, newline and carriage return are the only control bytes text may hold. */
function controlBytes(buf: Buffer): number[] {
  const at: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) at.push(i);
  }
  return at;
}

describe('source hygiene', () => {
  it('has no literal control bytes in src/ or tests/', () => {
    const offenders: string[] = [];
    for (const path of [...sourceFiles('src'), ...sourceFiles('tests')]) {
      const at = controlBytes(readFileSync(path));
      if (at.length) offenders.push(`${path} (${at.length} at offset ${at[0]})`);
    }
    expect(offenders, 'write \\x00-style escapes instead of raw control bytes').toEqual([]);
  });
});
