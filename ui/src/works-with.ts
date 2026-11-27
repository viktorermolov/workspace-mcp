const WORK_KIND: Record<string, [string, string]> = {
  assigned: ['gave tasks to ', 'got tasks from '],
  commented: ['commented on tasks of ', 'got comments from '],
  claimed: ['claimed a task of ', 'had a task claimed by '],
  delegates_to: ['delegates to ', 'is delegated to by '],
  reviews: ['reviews ', 'is reviewed by '],
  works_with: ['works with ', 'works with '],
  reports_to: ['reports to ', 'is reported to by '],
};

/** Lines such as "gave tasks to @builder (3)" for one role, from the links and recorded interactions of the map. */
export function worksWith(
  slug: string,
  links: { from: string; to: string; type: string }[],
  interactions: { from: string; to: string; kind: string; count: number }[],
): { before: string; other: string; after: string }[] {
  const out: { before: string; other: string; after: string }[] = [];
  const word = (kind: string, outgoing: boolean) => WORK_KIND[kind]?.[outgoing ? 0 : 1] ?? `${kind.replace(/_/g, ' ')}${outgoing ? ' ' : ' (from) '}`;
  for (const l of links) {
    // The reporting line is shown at the top of the page for the role itself; here only who reports to it.
    if (l.type === 'parent') {
      if (l.to === slug) out.push({ before: '', other: l.from, after: ' reports to it' });
      continue;
    }
    if (l.from === slug) out.push({ before: word(l.type, true), other: l.to, after: '' });
    else if (l.to === slug) out.push({ before: word(l.type, false), other: l.from, after: '' });
  }
  for (const i of interactions) {
    if (i.from === slug) out.push({ before: word(i.kind, true), other: i.to, after: ` (${i.count})` });
    else if (i.to === slug && i.from !== 'owner') out.push({ before: word(i.kind, false), other: i.from, after: ` (${i.count})` });
  }
  return out;
}
