export const PAGE_REFERENCES: {
  collection: string;
  field: string;
  filter?: Record<string, string>;
}[] = [
  { collection: 'revisions', field: 'pageId' },
  { collection: 'comments', field: 'page' },
  { collection: 'attachments', field: 'page' },
  { collection: 'bookmarks', field: 'page' },
  { collection: 'pagetagrelations', field: 'relatedPage' },
  { collection: 'sharelinks', field: 'relatedPage' },
  {
    collection: 'subscriptions',
    field: 'target',
    filter: { targetModel: 'Page' },
  },
  {
    collection: 'inappnotifications',
    field: 'target',
    filter: { targetModel: 'Page' },
  },
];
