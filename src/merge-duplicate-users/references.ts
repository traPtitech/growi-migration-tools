import { type Document, ObjectId } from 'mongodb';

interface Reference {
  collection: string;
  field: string;
  array?: boolean;
  condition?: Record<string, string>;
}

export const USER_REFERENCES: readonly Reference[] = [
  ...['creator', 'lastUpdateUser', 'deleteUser'].map((field) => ({
    collection: 'pages',
    field,
  })),
  ...['grantedUsers', 'liker', 'seenUsers'].map((field) => ({
    collection: 'pages',
    field,
    array: true,
  })),
  { collection: 'revisions', field: 'author' },
  ...['creator', 'resolvedById'].map((field) => ({
    collection: 'comments',
    field,
  })),
  { collection: 'attachments', field: 'creator' },
  { collection: 'bookmarks', field: 'user' },
  { collection: 'bookmarkfolders', field: 'owner' },
  { collection: 'externalaccounts', field: 'user' },
  { collection: 'usergrouprelations', field: 'relatedUser' },
  { collection: 'externalusergrouprelations', field: 'relatedUser' },
  { collection: 'useruisettings', field: 'user' },
  { collection: 'subscriptions', field: 'user' },
  { collection: 'inappnotifications', field: 'user' },
  { collection: 'activities', field: 'user' },
  { collection: 'contributions', field: 'user' },
  { collection: 'namedqueries', field: 'creator' },
  { collection: 'updateposts', field: 'creator' },
  { collection: 'passwordresetorders', field: 'relatedUser' },
  { collection: 'accesstokens', field: 'user' },
  { collection: 'newsreadstatuses', field: 'userId' },
  ...['pagebulkexportjobs', 'auditlogbulkexportjobs'].map((collection) => ({
    collection,
    field: 'user',
  })),
  ...['activities', 'subscriptions', 'inappnotifications'].map(
    (collection) => ({
      collection,
      field: 'target',
      condition: { targetModel: 'User' },
    }),
  ),
  {
    collection: 'activities',
    field: 'event',
    condition: { eventModel: 'User' },
  },
];

export function mappedId(
  value: unknown,
  mapping: Map<string, string>,
): unknown {
  if (!(value instanceof ObjectId)) return value;
  const target = mapping.get(value.toHexString());
  return target ? new ObjectId(target) : value;
}

export function mappedArray(
  value: unknown[],
  mapping: Map<string, string>,
): unknown[] {
  const mapped = value.map((id) => mappedId(id, mapping));
  return mapped.filter(
    (id, index) =>
      mapped.findIndex((other) => String(id) === String(other)) === index,
  );
}

export function referenceChanges(
  collection: string,
  document: Document,
  mapping: Map<string, string>,
): Document {
  const set: Document = {};
  for (const ref of USER_REFERENCES.filter(
    (r) => r.collection === collection,
  )) {
    if (
      ref.condition &&
      !Object.entries(ref.condition).every(([k, v]) => document[k] === v)
    )
      continue;
    const value = document[ref.field];
    if (ref.array) {
      if (
        !Array.isArray(value) ||
        !value.some((id) => id instanceof ObjectId && mapping.has(String(id)))
      )
        continue;
      set[ref.field] = mappedArray(value, mapping);
    } else if (value instanceof ObjectId && mapping.has(String(value))) {
      set[ref.field] = mappedId(value, mapping);
    }
  }
  return set;
}

export function assertNoUnknownReferences(
  value: unknown,
  mapping: Map<string, string>,
  location: string,
): void {
  if (
    value instanceof ObjectId ||
    (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value))
  ) {
    if (mapping.has(String(value)))
      throw new Error(`Unsupported user reference: ${location}`);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnknownReferences(item, mapping, `${location}[]`);
    }
  } else if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  ) {
    for (const [field, item] of Object.entries(value))
      assertNoUnknownReferences(item, mapping, `${location}.${field}`);
  }
}
