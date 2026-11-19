import { directiveFromMarkdown } from 'mdast-util-directive';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';

type Node = {
  type: string;
  name?: string;
  value?: string;
  children?: Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};
type Edit = { start: number; end: number; value: string };

const LEGACY_LINK = /(?<!\[)\[(\/[^\]\n]+)\](?!\])|<\/\/([^>\s]+)>/g;

const isSafePath = (path: string): boolean =>
  path.startsWith('/') &&
  !path.startsWith('//') &&
  ![...path].some(
    (character) => character === '\\' || character.charCodeAt(0) < 0x20,
  );

export function convertBody(body: string): string {
  const tree = fromMarkdown(body, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as unknown as Node;
  const edits: Edit[] = [];

  const addTextLinkEdits = (node: Node): void => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return;
    const source = body.slice(start, end);
    for (const match of source.matchAll(LEGACY_LINK)) {
      const path = match[1] ?? `/${match[2]}`;
      if (!isSafePath(path)) continue;
      const index = match.index ?? 0;
      edits.push({
        start: start + index,
        end: start + index + match[0].length,
        value: `[[${path}]]`,
      });
    }
  };

  const visit = (node: Node, insideLink = false): void => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return;

    if (
      node.type === 'containerDirective' &&
      node.name?.toLowerCase() === 'success'
    ) {
      const source = body.slice(start, end);
      const marker = /^([ \t]*:::)[ \t]*success(?=[ \t{]|\r?\n|$)/i.exec(
        source,
      );
      if (marker != null) {
        const nameOffset = marker[0].toLowerCase().lastIndexOf('success');
        edits.push({
          start: start + nameOffset,
          end: start + nameOffset + 'success'.length,
          value: 'tip',
        });
      }
    }

    if (node.type === 'code' || node.type === 'inlineCode') return;

    if (node.type === 'html') {
      const match = /^<\/\/([^>\s]+)>$/.exec(node.value ?? '');
      if (match != null) {
        const path = `/${match[1]}`;
        if (isSafePath(path)) edits.push({ start, end, value: `[[${path}]]` });
      }
      return;
    }

    if (node.type === 'text' && !insideLink) addTextLinkEdits(node);

    const childIsLink =
      insideLink || node.type === 'link' || node.type === 'image';
    for (const child of node.children ?? []) visit(child, childIsLink);
  };
  visit(tree);

  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.value + text.slice(edit.end),
      body,
    );
}
