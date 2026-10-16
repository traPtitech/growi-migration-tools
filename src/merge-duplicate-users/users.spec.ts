import { ObjectId } from 'mongodb';
import { normalizeUsers, parseAliases, planUsers } from './users.ts';

const old = new ObjectId('000000000000000000000001');
const recent = new ObjectId('000000000000000000000002');
const users = [
  {
    _id: old,
    username: 'alice',
    email: 'alice@example.invalid',
    status: 2,
    admin: false,
    name: 'Original profile',
  },
  {
    _id: recent,
    username: 'alice',
    email: 'alice@example.invalid',
    status: 2,
    admin: false,
    name: 'alice',
  },
];

describe('duplicate user identity planning', () => {
  it('keeps the oldest ID without mutating profile data', () => {
    expect(planUsers([...users].reverse())).toEqual([
      { username: 'alice', keepId: String(old), removeIds: [String(recent)] },
    ]);
    expect(users[0].name).toBe('Original profile');
  });
  it.each([
    'email',
    'status',
    'admin',
    'readOnly',
    'apiToken',
    'image',
  ])('rejects conflicting %s instead of losing access or credentials', (field) => {
    expect(() =>
      planUsers([
        users[0],
        {
          ...users[1],
          [field]:
            field === 'status'
              ? 3
              : field === 'admin' || field === 'readOnly'
                ? true
                : 'different',
        },
      ]),
    ).toThrow(/Conflicting|requires review/);
  });
  it('only recovers aliases whose actual values match the explicit mapping', () => {
    const aliases = parseAliases([
      {
        id: String(old),
        field: 'username',
        original: 'alice',
        replacement: 'temporary',
      },
    ]);
    expect(
      normalizeUsers([{ ...users[0], username: 'temporary' }], aliases)[0]
        .username,
    ).toBe('alice');
    expect(() =>
      normalizeUsers([{ ...users[0], username: 'changed' }], aliases),
    ).toThrow('Alias does not match');
    expect(() => parseAliases([...aliases, ...aliases])).toThrow(
      'Duplicate alias',
    );
  });
  it('rejects shared email across unrelated usernames', () => {
    expect(() =>
      planUsers([users[0], { ...users[1], username: 'bob' }]),
    ).toThrow('Email collision');
  });
});
