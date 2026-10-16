import {
  buildPlan,
  type MigrationPlan,
  type PageState,
  type Snapshot,
} from './index.ts';

function page(
  id: string,
  path: string,
  extra: Partial<PageState> = {},
): PageState {
  return {
    id,
    path,
    parent: 'root',
    status: 'published',
    grant: 1,
    revision: `revision-${id}`,
    isEmpty: false,
    descendantCount: 0,
    ...extra,
  };
}

const root = page('root', '/', { parent: null });
const empty = (id: string, path: string): PageState =>
  page(id, path, { isEmpty: true, revision: null });
const snapshot = (pages: PageState[]): Snapshot => ({
  pages: [root, ...pages],
  redirects: [],
  pendingOperations: 0,
});

function project(input: Snapshot, plan: MigrationPlan): Snapshot {
  const removed = new Set(plan.merges.flatMap((m) => m.removeIds));
  const updates = new Map(plan.pageUpdates.map((p) => [p.id, p.set]));
  return {
    ...input,
    pages: input.pages
      .filter((p) => !removed.has(p.id))
      .map((p) => ({ ...p, ...updates.get(p.id) })),
    redirects: [
      ...input.redirects,
      ...plan.aliases.map((r, i) => ({ id: `alias-${i}`, ...r })),
    ],
  };
}

describe('trailing slash migration plan', () => {
  it('keeps the real page ID and connects its children, without counting empty hierarchy nodes', () => {
    const input = snapshot([
      page('original', '/teams/', { grantedUsers: ['original-creator'] }),
      empty('placeholder', '/teams'),
      page('child', '/teams/one', { parent: 'placeholder' }),
      page('hierarchy', '/teams/group', {
        parent: 'placeholder',
        isEmpty: true,
        revision: null,
      }),
      page('nested', '/teams/group/two', { parent: 'hierarchy' }),
    ]);
    const plan = buildPlan(input, 'test');
    const result = project(input, plan);

    expect(plan.merges).toEqual([
      {
        keepId: 'original',
        removeIds: ['placeholder'],
        fromPaths: ['/teams/'],
        toPath: '/teams',
      },
    ]);
    expect(result.pages.find((p) => p.id === 'original')).toMatchObject({
      path: '/teams',
      revision: 'revision-original',
      descendantCount: 2,
    });
    expect(result.pages.find((p) => p.id === 'child')?.parent).toBe('original');
    expect(result.pages.find((p) => p.id === 'hierarchy')?.parent).toBe(
      'original',
    );
    expect(result.pages.find((p) => p.id === 'root')?.descendantCount).toBe(3);
    expect(plan.aliases).toContainEqual({
      fromPath: '/teams/',
      toPath: '/teams',
    });
    expect(input.pages.find((p) => p.id === 'original')?.path).toBe('/teams/');
  });

  it('skips real-page collisions, different permissions, and legacy pages while planning other groups', () => {
    const input = snapshot([
      page('a', '/collision'),
      page('b', '/collision/'),
      page('c', '/private/', { grant: 4, grantedUsers: ['owner'] }),
      empty('d', '/private'),
      page('e', '/legacy/', { parent: null }),
      page('f', '/safe/'),
      empty('g', '/safe'),
    ]);
    const plan = buildPlan(input, 'test');

    expect(plan.merges.map((m) => m.toPath)).toEqual(['/safe']);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/collision',
          reason: 'multiple-real-pages',
        }),
        expect.objectContaining({
          path: '/private',
          reason: 'different-permissions',
        }),
        expect.objectContaining({
          path: '/legacy',
          reason: 'not-on-published-tree',
        }),
      ]),
    );
  });

  it('preserves access scopes and reconnects nested merged parents', () => {
    const input = snapshot([
      page('parent', '/teams/'),
      empty('p-empty', '/teams'),
      page('child', '/teams/child/', { parent: 'p-empty' }),
      { ...empty('c-empty', '/teams/child'), parent: 'p-empty' },
      page('grandchild', '/teams/child/leaf', { parent: 'c-empty' }),
    ]);
    const result = project(input, buildPlan(input, 'test'));

    expect(result.pages.find((p) => p.id === 'child')).toMatchObject({
      parent: 'parent',
      grant: 1,
      revision: 'revision-child',
      descendantCount: 1,
    });
    expect(result.pages.find((p) => p.id === 'grandchild')?.parent).toBe(
      'child',
    );
  });

  it('keeps conflicting real pages separate while reconnecting their merged parent', () => {
    const input = snapshot([
      page('parent', '/teams/'),
      empty('placeholder', '/teams'),
      page('a', '/teams/collision', { parent: 'placeholder' }),
      page('b', '/teams/collision/', { parent: 'placeholder' }),
    ]);
    const plan = buildPlan(input, 'test');
    const result = project(input, plan);

    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        path: '/teams/collision',
        reason: 'multiple-real-pages',
      }),
    );
    expect(result.pages.find((p) => p.id === 'a')).toMatchObject({
      path: '/teams/collision',
      parent: 'parent',
      revision: 'revision-a',
    });
    expect(result.pages.find((p) => p.id === 'b')).toMatchObject({
      path: '/teams/collision/',
      parent: 'parent',
      revision: 'revision-b',
    });
  });

  it('renames a single page, updates incoming redirect targets, and is idempotent', () => {
    const input = {
      ...snapshot([page('single', '/single///')]),
      redirects: [{ id: 'redirect', fromPath: '/old', toPath: '/single///' }],
    };
    const plan = buildPlan(input, 'test');
    expect(plan.redirectUpdates).toEqual([
      { id: 'redirect', toPath: '/single' },
    ]);
    const rerun = buildPlan(project(input, plan), 'test');
    expect(rerun.merges).toEqual([]);
    expect(rerun.pageUpdates).toEqual([]);
    expect(rerun.aliases).toEqual([]);
  });

  it('does not overwrite an existing redirect or delete an empty page with a revision', () => {
    const input = {
      ...snapshot([
        page('a', '/one/'),
        empty('b', '/one'),
        page('c', '/two/', { isEmpty: true }),
      ]),
      redirects: [{ id: 'redirect', fromPath: '/one', toPath: '/other' }],
    };
    const plan = buildPlan(input, 'test');
    expect(plan.merges).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining([
        'existing-redirect-at-page-path',
        'empty-page-has-revision',
      ]),
    );
  });

  it('refuses pending operations and cyclic parent relationships', () => {
    expect(() =>
      buildPlan({ ...snapshot([]), pendingOperations: 1 }, 'test'),
    ).toThrow('Pending page operations');
    expect(() =>
      buildPlan(
        snapshot([
          page('a', '/one/', { parent: 'b' }),
          page('b', '/two', { parent: 'a' }),
        ]),
        'test',
      ),
    ).toThrow('Cycle');
  });
});
