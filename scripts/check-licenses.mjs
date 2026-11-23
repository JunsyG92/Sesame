// Fails when a production dependency uses a license outside the allow-list.
// Runtime code shipped in the app is what matters: dev tooling is not distributed.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Python-2.0',
  'Unlicense',
  'GPL-3.0-or-later',
]);

const require = createRequire(import.meta.url);
const bin = require.resolve('license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js');
const output = execFileSync(
  process.execPath,
  [bin, '--production', '--json', '--excludePrivatePackages'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
const packages = JSON.parse(output);
const problems = [];
for (const [name, info] of Object.entries(packages)) {
  const licenses = Array.isArray(info.licenses) ? info.licenses : [info.licenses];
  // SPDX expressions such as "(MIT OR Apache-2.0)" pass when one alternative is allowed.
  const ok = licenses.some((expression) =>
    String(expression)
      .replace(/[()*]/g, '')
      .split(/\s+OR\s+|\s+AND\s+/)
      .some((id) => ALLOWED.has(id.trim())),
  );
  if (!ok && !name.startsWith('sesame@')) problems.push(`${name}: ${String(info.licenses)}`);
}
if (problems.length > 0) {
  process.stderr.write(`Disallowed licenses:\n${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${String(Object.keys(packages).length)} production packages checked.\n`);
}
