import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseFragment } from 'parse5';

export interface AttachmentRef {
  id: string;
  filePath: string;
}

const legacyKey = /^attachment\/[a-f0-9]{24}\/[a-f0-9]{32}\.[a-zA-Z0-9]+$/;
export const isLegacyKey = (key: string): boolean => legacyKey.test(key);

export function createUrlResolver(
  attachments: readonly AttachmentRef[],
  wikiOrigin: string,
  swiftBase: string,
): (url: string) => string | undefined {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const byPath = new Map(attachments.map((a) => [a.filePath, a]));
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url, wikiOrigin);
    } catch {
      return;
    }
    if (parsed.search || parsed.hash || parsed.username || parsed.password)
      return;
    const oldId = /^\/files\/([a-f0-9]{24})$/.exec(parsed.pathname)?.[1];
    if (parsed.origin === wikiOrigin && oldId && byId.has(oldId)) {
      if (url !== `/files/${oldId}` && url !== `${wikiOrigin}/files/${oldId}`)
        return;
      return `/attachment/${oldId}`;
    }
    if (!url.startsWith(swiftBase)) return;
    const key = url.slice(swiftBase.length);
    if (!isLegacyKey(key)) return;
    const attachment = byPath.get(key);
    return attachment ? `/attachment/${attachment.id}` : undefined;
  };
}

interface Edit {
  start: number;
  end: number;
  value: string;
}

export function convertBody(
  body: string,
  resolveUrl: (url: string) => string | undefined,
): string {
  const edits: Edit[] = [];
  const protectedRanges = [
    ...body.matchAll(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi),
  ].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const tree = fromMarkdown(body);
  function visit(node: typeof tree | (typeof tree.children)[number]): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      start != null &&
      end != null &&
      protectedRanges.some((r) => start >= r.start && end <= r.end)
    )
      return;
    if (start != null && end != null) {
      if (
        node.type === 'link' ||
        node.type === 'image' ||
        node.type === 'definition'
      ) {
        const replacement = resolveUrl(node.url);
        if (replacement) {
          const source = body.slice(start, end);
          if (node.type === 'link' && source === `<${node.url}>`) {
            edits.push({ start, end, value: `[${node.url}](${replacement})` });
            return;
          }
          const offset = source.lastIndexOf(node.url);
          // Ambiguous or escaped destinations are left untouched.
          if (offset >= 0 && source.indexOf(node.url) === offset) {
            edits.push({
              start: start + offset,
              end: start + offset + node.url.length,
              value: replacement,
            });
          }
        }
      } else if (node.type === 'html') {
        const html = node.value;
        const htmlStart = start;
        const fragment = parseFragment(html, {
          sourceCodeLocationInfo: true,
        });
        function htmlVisit(
          n: typeof fragment | (typeof fragment.childNodes)[number],
        ): void {
          if (
            'tagName' in n &&
            !['script', 'style', 'code', 'pre'].includes(n.tagName)
          ) {
            for (const attr of n.attrs) {
              if (attr.name !== 'src' && attr.name !== 'href') continue;
              const value = resolveUrl(attr.value);
              const loc = n.sourceCodeLocation?.attrs?.[attr.name];
              if (!value || !loc) continue;
              const original = html.slice(loc.startOffset, loc.endOffset);
              const match =
                /^[^=]+=(\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s>]+))$/.exec(
                  original,
                );
              if (!match || (match[2] ?? match[3] ?? match[4]) !== attr.value)
                continue;
              const offset =
                original.indexOf('=') +
                1 +
                match[1].length +
                (match[4] == null ? 1 : 0);
              edits.push({
                start: htmlStart + loc.startOffset + offset,
                end: htmlStart + loc.startOffset + offset + attr.value.length,
                value,
              });
            }
          }
          if (
            'tagName' in n &&
            ['script', 'style', 'code', 'pre'].includes(n.tagName)
          )
            return;
          if ('childNodes' in n)
            for (const child of n.childNodes) htmlVisit(child);
        }
        htmlVisit(fragment);
      }
    }
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.value + text.slice(edit.end),
      body,
    );
}
