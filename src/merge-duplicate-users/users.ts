import type { Document } from 'mongodb';
import type { Alias, UserMerge } from './types.ts';

export function parseAliases(value: unknown): Alias[] {
  if (!Array.isArray(value)) throw new Error('Aliases must be an array');
  const keys = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{24}$/.test(item.id) ||
      !['username', 'email'].includes(item.field) ||
      typeof item.original !== 'string' ||
      typeof item.replacement !== 'string'
    ) {
      throw new Error('Invalid alias entry');
    }
    const key = `${item.id}.${item.field}`;
    if (keys.has(key)) throw new Error('Duplicate alias entry');
    keys.add(key);
    return {
      id: item.id,
      field: item.field,
      original: item.original,
      replacement: item.replacement,
    };
  });
}

export function normalizeUsers(
  users: Document[],
  aliases: Alias[],
): Document[] {
  return users.map((user) => {
    const normalized = { ...user };
    for (const alias of aliases.filter((a) => a.id === String(user._id))) {
      if (![alias.original, alias.replacement].includes(user[alias.field])) {
        throw new Error(
          `Alias does not match stored user: ${alias.id}.${alias.field}`,
        );
      }
      normalized[alias.field] = alias.original;
    }
    return normalized;
  });
}

export function planUsers(users: Document[]): UserMerge[] {
  const groups = new Map<string, Document[]>();
  for (const user of users) {
    if (typeof user.username !== 'string' || !user.username)
      throw new Error('Missing username');
    groups.set(user.username, [...(groups.get(user.username) ?? []), user]);
  }
  const merges: UserMerge[] = [];
  for (const [username, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) =>
      String(a._id).localeCompare(String(b._id)),
    );
    const keep = sorted[0];
    for (const member of sorted) {
      if (
        member._id?._bsontype !== 'ObjectID' &&
        member._id?._bsontype !== 'ObjectId'
      )
        throw new Error('User IDs must be ObjectIds');
      if (
        typeof member.email !== 'string' ||
        member.email !== keep.email ||
        member.status !== keep.status ||
        Boolean(member.admin) !== Boolean(keep.admin) ||
        Boolean(member.readOnly) !== Boolean(keep.readOnly)
      ) {
        throw new Error(`Conflicting email/status/roles in group: ${username}`);
      }
      if (member !== keep) {
        for (const field of [
          'apiToken',
          'googleId',
          'githubId',
          'userId',
          'slackMemberId',
          'image',
          'imageAttachment',
          'introduction',
        ]) {
          if (
            member[field] &&
            String(member[field]) !== String(keep[field] ?? '')
          ) {
            throw new Error(
              `Additional credential/profile requires review: ${username}.${field}`,
            );
          }
        }
      }
    }
    merges.push({
      username,
      keepId: String(keep._id),
      removeIds: sorted.slice(1).map((u) => String(u._id)),
    });
  }
  const removed = new Set(merges.flatMap((m) => m.removeIds));
  const emails = new Set<string>();
  for (const user of users.filter((u) => !removed.has(String(u._id)))) {
    if (user.email === undefined) continue;
    if (emails.has(user.email))
      throw new Error('Email collision across different usernames');
    emails.add(user.email);
  }
  return merges.sort((a, b) => a.username.localeCompare(b.username));
}
