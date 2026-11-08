// Temporary CI diagnostic sink. A marker is not proof of redaction: revalidate
// exact fields against the closed vocabulary before writing anything to stdout.
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseHostDiagnostic } from './diagnostics.mjs';
export function diagnosticLines(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('invalid-diagnostic-file');
  const lines = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const safe = parseHostDiagnostic(line);
    if (safe && lines.length < 2) lines.push(safe);
  }
  return lines;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { for (const line of diagnosticLines(process.argv[2])) process.stdout.write(line + '\n'); }
  catch { process.exitCode = 2; }
}
