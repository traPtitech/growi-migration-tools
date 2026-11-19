import { convertBody } from './markdown.ts';

describe('convertBody', () => {
  it('converts success containers and both Crowi page link forms', () => {
    const body =
      ':::success{label="OK"}\r\nready\r\n:::\r\n\r\n[/one] and <//two>';
    expect(convertBody(body)).toBe(
      ':::tip{label="OK"}\r\nready\r\n:::\r\n\r\n[[/one]] and [[/two]]',
    );
  });

  it('leaves code, comments, unsafe paths, and unrelated text unchanged', () => {
    const body = [
      '```md',
      ':::success',
      '[/code]',
      '<//code>',
      '```',
      '',
      '`[/inline]` <!-- [/comment] -->',
      '',
      '[//external] [\\bad] [normal text]',
      '<div>[/inside-html]</div>',
    ].join('\n');
    expect(convertBody(body)).toBe(body);
  });

  it('is idempotent', () => {
    const migrated = convertBody(':::success\n[/page] <//other>\n:::');
    expect(convertBody(migrated)).toBe(migrated);
  });
});
