import { convertBody, createUrlResolver } from './urls.ts';

const id = '111111111111111111111111';
const key =
  'attachment/222222222222222222222222/33333333333333333333333333333333.png';
const base = 'https://object-storage.example.test/v1/nc_abc/crowi/';
const resolveUrl = createUrlResolver(
  [{ id, filePath: key }],
  'https://wiki.example.test',
  base,
);
const target = `/attachment/${id}`;

it('converts Markdown, reference and HTML destinations without reformatting the body', () => {
  const body = `# Title\r\n![a](/files/${id} "title") [b](https://wiki.example.test/files/${id})\r\n![c][ref]\r\n\r\n[ref]: ${base}${key} "keep"\r\n\r\n<img src='${base}${key}' width="10"><a href="/files/${id}">a</a>`;
  const expected = `# Title\r\n![a](${target} "title") [b](${target})\r\n![c][ref]\r\n\r\n[ref]: ${target} "keep"\r\n\r\n<img src='${target}' width="10"><a href="${target}">a</a>`;
  expect(convertBody(body, resolveUrl)).toBe(expected);
  expect(convertBody(expected, resolveUrl)).toBe(expected);
});

it('leaves unknown, irregular, foreign and already migrated URLs untouched', () => {
  const urls = [
    `/files/444444444444444444444444`,
    `/files/${id}?download=1`,
    `${base}../${key}`,
    `${base.replace('/crowi/', '/wordpress/')}x.png`,
    `${base}${key}#x`,
    `https://other.example.test/files/${id}`,
    `https://evil.test/${base}${key}`,
    target,
  ];
  for (const url of urls)
    expect(convertBody(`![](${url})`, resolveUrl)).toBe(`![](${url})`);
});

it('preserves code, comments and HTML code elements without injecting text', () => {
  const body = `\`![](/files/${id})\`\n\n\`\`\`md\n![](${base}${key})\n\`\`\`\n\n<!-- <img src="/files/${id}"> -->\n\n<code><img src="/files/${id}"></code>\n\n<pre><img src="/files/${id}"></pre>`;
  expect(convertBody(body, resolveUrl)).toBe(body);
});

it('keeps autolinks valid after converting their destination', () => {
  const url = `${base}${key}`;
  expect(convertBody(`<${url}>`, resolveUrl)).toBe(`[${url}](${target})`);
});
