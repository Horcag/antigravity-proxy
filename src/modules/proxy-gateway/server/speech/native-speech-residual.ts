const ignored = /[\p{White_Space}\p{P}]/u;
const leadingIgnored = /^[\p{White_Space}\p{P}]+/u;

/** Native ASR can rewrite punctuation/case; retain only the unmatched original suffix. */
export function transcriptionResidual(pending: string, committed: string): string {
  let normalized = '', offset = 0;
  const endOffsets: number[] = [];
  for (const rune of pending) {
    offset += rune.length;
    if (ignored.test(rune)) continue;
    // Unicode simple lowercase maps one rune; JS's expanded lowercase needs its first rune.
    const lower = [...rune.toLowerCase()][0]!;
    normalized += lower;
    for (let unit = 0; unit < lower.length; unit++) endOffsets.push(offset);
  }
  let match = '';
  for (const rune of committed) {
    if (!ignored.test(rune)) match += [...rune.toLowerCase()][0]!;
  }
  if (!match) return '';
  const start = normalized.indexOf(match);
  if (start < 0) return '';
  return pending.slice(endOffsets[start + match.length - 1]).replace(leadingIgnored, '');
}
