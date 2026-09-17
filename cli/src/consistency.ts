import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';

export interface GateCheck { name: string; checked: string; passed: boolean; violation?: string }
const check = (name: string, checked: string, passed: boolean, violation: string): GateCheck => ({ name, checked, passed, ...(passed ? {} : { violation }) });

export function reportSections(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let key: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(FILES CHANGED|COMMANDS RUN|VERIFICATION|VERDICT|GAP|EVIDENCE|BUILT SHA)(?:\*\*)?\s*(?::|—|-)?\s*(.*)$/i);
    if (heading) { key = heading[1]!.toUpperCase(); result[key] = heading[2] ?? ''; }
    else if (key !== undefined) result[key] += '\n' + line;
  }
  return result;
}

export function reportChecks(cwd: string, report: string, command: string, touched?: readonly string[]): GateCheck[] {
  const sections = reportSections(report), checks: GateCheck[] = [];
  const names: string[] = [];
  for (const row of (sections['FILES CHANGED'] ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (/^(?:none|no files changed|```)/i.test(row)) continue;
    const clean = row.replace(/^[-*]\s+/, '');
    const path = (clean.match(/`([^`]+)`/)?.[1] ?? clean.replace(/\s+(?:—|–| - |\().*$/, '')).replace(/\s*\(deleted\)\s*$/i, '').trim();
    const absolute = resolve(cwd, path);
    const safe = !isAbsolute(path) && !relative(cwd, absolute).startsWith('..');
    const deleted = /\bdeleted\b/i.test(row);
    names.push(path.replaceAll('\\', '/'));
    checks.push(check('report.path', path, safe && (deleted ? !existsSync(absolute) : existsSync(absolute)), 'reported path does not match disk: ' + path));
  }
  checks.push(check('report.files', 'FILES CHANGED section', sections['FILES CHANGED'] !== undefined, 'FILES CHANGED is missing'));
  const commands = (sections['COMMANDS RUN'] ?? '').split('\n').map((s) => s.trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, ''));
  checks.push(check('report.command', command, command.length > 0 && commands.includes(command), 'COMMANDS RUN must include the exact Task Spec verification command'));
  const output = (sections['VERIFICATION'] ?? '').replace(/```[^\n]*\n?/g, '').trim();
  checks.push(check('report.output', 'verbatim verification output', output.length > 0, 'VERIFICATION must contain verbatim output'));
  const failure = /(?:^|\n)\s*(?:✖|not ok\b|FAIL\b|(?:#|ℹ)\s*fail\s+[1-9])|\bexit(?:ed)?(?: code)?\s*[:=]?\s*[1-9]\d*/im.test(output);
  checks.push(check('report.outcome', 'verification permits proceeding to judging', !failure, 'verification shows failure; correct the report or the candidate before proceeding'));
  if (touched !== undefined) {
    const actual = [...new Set(touched)].sort(), claimed = [...new Set(names)].sort();
    checks.push(check('report.touched', 'snapshot touched-set versus FILES CHANGED', JSON.stringify(actual) === JSON.stringify(claimed), 'FILES CHANGED differs from the ownership snapshot: actual ' + actual.join(', ')));
  }
  return checks;
}

export function verdictChecks(text: string): GateCheck[] {
  const sections = reportSections(text);
  const verdict = sections['VERDICT']?.trim().match(/^(WIN|LOSS|BLOCKED)\b/)?.[1];
  const gap = sections['GAP']?.trim() ?? '';
  const finding = gap.length > 0 && !/^(?:none|clean|n\/a|no (?:gaps|findings))[.!]?$/i.test(gap);
  return [
    check('verdict.shape', 'VERDICT heading', verdict !== undefined, 'VERDICT must be WIN, LOSS, or BLOCKED'),
    check('verdict.loss', 'LOSS has a finding', verdict !== 'LOSS' || finding, 'LOSS has no finding'),
    check('verdict.blocked', 'BLOCKED names missing perception capability', verdict !== 'BLOCKED' || /(?:missing|unavailable|cannot|no access|lack).*(?:browser|screen|render|platform|capability|tool|perceiv)/i.test(gap), 'BLOCKED must name the missing perception capability'),
    check('verdict.win', 'WIN has no confirmed blocking finding', verdict !== 'WIN' || !/(?:hard gate|\b[CG]\d+\b).*(?:fail|unmet|violat|missing)|\bconfirmed\b|(?:fail|unmet|violat).*(?:hard gate|\b[CG]\d+\b)/i.test(gap + '\n' + (sections['EVIDENCE'] ?? '')), 'WIN contradicts a confirmed finding or unmet hard gate'),
  ];
}

export interface Finding { text: string; criterion: string }
/** Findings stay prose: retain each nonempty GAP line and its cited gate. */
export function reportFindings(text: string): Finding[] {
  const sections = reportSections(text);
  if (!/^LOSS\b/.test(sections['VERDICT']?.trim() ?? '')) return [];
  return (sections['GAP'] ?? '').split(/\r?\n/).map((row) => row.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).map((row) => ({ text: row, criterion: row.match(/\b(?:[CRG]\d+|criterion\s+\d+|gate\s+\w+)\b/i)?.[0] ?? 'uncited' }));
}
export interface FindingRound { fingerprints: string[]; diff: string }
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function fingerprintRound(findings: readonly Finding[], diff: string): FindingRound {
  const normalize = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return { fingerprints: [...new Set(findings.map((f) => hash(normalize(f.criterion) + '\n' + normalize(f.text))))].sort(), diff: hash(diff) };
}
export function findingSignals(history: readonly FindingRound[]): string[] {
  if (history.length < 2) return [];
  const b = history.at(-1)!, a = history.at(-2)!, c = history.at(-3);
  const signals: string[] = [];
  const same = JSON.stringify(a.fingerprints) === JSON.stringify(b.fingerprints) && b.fingerprints.length > 0;
  if (same && a.diff === b.diff) signals.push('duplicate-round');
  if (a.diff !== b.diff && b.fingerprints.some((f) => a.fingerprints.includes(f))) signals.push('gap-survives');
  if (c && a.diff !== b.diff && c.diff !== a.diff && b.fingerprints.some((f) => c.fingerprints.includes(f) && !a.fingerprints.includes(f)) && a.fingerprints.some((f) => !c.fingerprints.includes(f) && !b.fingerprints.includes(f))) signals.push('see-saw');
  return signals;
}
