// Builds release notes from conventional commits since the previous tag.
import { execFileSync } from 'node:child_process';

const tag = process.argv[2] ?? 'HEAD';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let previous = '';
try {
  previous = git('describe', '--tags', '--abbrev=0', `${tag}^`);
} catch {
  previous = '';
}
/** `feat(scope)!: x` → `feat` */
function commitType(subject) {
  const head = subject.split(':')[0] ?? '';
  return head.split('(')[0]?.replace('!', '') ?? '';
}
const range = previous === '' ? tag : `${previous}..${tag}`;
const subjects = git('log', '--no-merges', '--format=%s', range).split('\n').filter(Boolean);
const sections = [
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['sec', 'Security'],
  ['docs', 'Documentation'],
];
const lines = [`# Sesame ${tag}`, ''];
const used = new Set();
for (const [type, title] of sections) {
  const matching = subjects.filter((subject) => commitType(subject) === type);
  if (matching.length === 0) continue;
  lines.push(`## ${title}`, '', ...matching.map((subject) => `- ${subject}`), '');
  for (const subject of matching) used.add(subject);
}
const breaking = subjects.filter((subject) => subject.split(':')[0]?.endsWith('!') === true);
if (breaking.length > 0)
  lines.push('## Breaking changes', '', ...breaking.map((s) => `- ${s}`), '');
const other = subjects.filter((subject) => !used.has(subject));
if (other.length > 0) lines.push('## Other changes', '', ...other.map((s) => `- ${s}`), '');
lines.push('Verify downloads with `SHA256SUMS.txt`.', '');
process.stdout.write(lines.join('\n'));
