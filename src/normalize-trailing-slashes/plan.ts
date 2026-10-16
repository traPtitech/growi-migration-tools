import { createHash } from 'node:crypto';
import { PageGrant } from './page-grant.ts';

import type { Merge, MigrationPlan, PageState, Snapshot } from './types.ts';

const canonicalPath = (path: string): string => path.replace(/\/+$/, '') || '/';

function permissions(page: PageState): string {
  // Legacy public pages can retain grantedUsers without restricting access.
  const users =
    page.grant === PageGrant.GRANT_OWNER ||
    page.grant === PageGrant.GRANT_SPECIFIED
      ? [...(page.grantedUsers ?? [])].sort()
      : [];
  const groups =
    page.grant === PageGrant.GRANT_USER_GROUP
      ? (page.grantedGroups ?? [])
          .map((g) => `${g.type ?? 'UserGroup'}:${g.item}`)
          .sort()
      : [];
  return JSON.stringify([page.grant, users, groups]);
}

function rejectionReason(
  pages: PageState[],
  snapshot: Snapshot,
): string | null {
  const target = canonicalPath(pages[0].path);
  if (target === '/' || !target.startsWith('/')) return 'invalid-or-root-path';
  if (pages.filter((p) => !p.isEmpty).length > 1) return 'multiple-real-pages';
  if (pages.some((p) => p.status !== 'published' || p.parent == null)) {
    return 'not-on-published-tree';
  }
  if (pages.some((p) => p.isEmpty && p.revision != null)) {
    return 'empty-page-has-revision';
  }
  if (
    pages.some(
      (p) =>
        p.grant == null ||
        !Object.values(PageGrant).some((grant) => grant === p.grant) ||
        permissions(p) !== permissions(pages[0]),
    )
  ) {
    return 'different-permissions';
  }
  if (new Set(pages.map((p) => p.parent)).size !== 1)
    return 'different-parents';
  const paths = new Set(pages.map((p) => p.path));
  if (
    snapshot.redirects.some(
      (r) => paths.has(r.fromPath) || r.fromPath === target,
    )
  ) {
    return 'existing-redirect-at-page-path';
  }
  return null;
}

function chooseMerge(pages: PageState[]): Merge {
  const target = canonicalPath(pages[0].path);
  const real = pages.find((p) => !p.isEmpty);
  const keep = real ?? pages.find((p) => p.path === target) ?? pages[0];
  return {
    keepId: keep.id,
    removeIds: pages.filter((p) => p.id !== keep.id).map((p) => p.id),
    fromPaths: [...new Set(pages.map((p) => p.path))].filter(
      (p) => p !== target,
    ),
    toPath: target,
  };
}

function descendantCounts(pages: PageState[]): Map<string, number> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map<string, PageState[]>();
  for (const page of pages) {
    if (page.parent == null) continue;
    if (!byId.has(page.parent))
      throw new Error(`Missing parent for ${page.id}`);
    children.set(page.parent, [...(children.get(page.parent) ?? []), page]);
  }
  const counts = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (visiting.has(id)) throw new Error(`Cycle in page tree at ${id}`);
    const cached = counts.get(id);
    if (cached != null) return cached;
    visiting.add(id);
    const count = (children.get(id) ?? []).reduce(
      (sum, child) => sum + (child.isEmpty ? 0 : 1) + visit(child.id),
      0,
    );
    visiting.delete(id);
    counts.set(id, count);
    return count;
  };
  for (const page of pages)
    if (page.parent != null || page.path === '/') visit(page.id);
  return counts;
}

function buildUpdates(
  snapshot: Snapshot,
  merges: Merge[],
): MigrationPlan['pageUpdates'] {
  if (merges.length === 0) return [];
  const replacements = new Map(
    merges.flatMap((m) => m.removeIds.map((id) => [id, m.keepId])),
  );
  const paths = new Map(merges.map((m) => [m.keepId, m.toPath]));
  const projected = snapshot.pages
    .filter((p) => !replacements.has(p.id))
    .map((p) => ({
      ...p,
      path: paths.get(p.id) ?? p.path,
      parent:
        p.parent == null ? p.parent : (replacements.get(p.parent) ?? p.parent),
    }));
  const counts = descendantCounts(projected);
  const original = new Map(snapshot.pages.map((p) => [p.id, p]));
  return projected.flatMap((page) => {
    const before = original.get(page.id);
    const count = counts.get(page.id);
    const set = {
      ...(page.path !== before?.path ? { path: page.path } : {}),
      ...(page.parent != null && page.parent !== before?.parent
        ? { parent: page.parent }
        : {}),
      ...(count != null && count !== (before?.descendantCount ?? 0)
        ? { descendantCount: count }
        : {}),
    };
    return Object.keys(set).length === 0 ? [] : [{ id: page.id, set }];
  });
}

export function buildPlan(snapshot: Snapshot, database: string): MigrationPlan {
  if (snapshot.pendingOperations !== 0)
    throw new Error('Pending page operations must be resolved first');
  const ordered = {
    ...snapshot,
    pages: [...snapshot.pages].sort((a, b) => a.id.localeCompare(b.id)),
    redirects: [...snapshot.redirects].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const groups = new Map<string, PageState[]>();
  for (const page of ordered.pages) {
    const path = canonicalPath(page.path);
    groups.set(path, [...(groups.get(path) ?? []), page]);
  }
  const merges: Merge[] = [];
  const skipped: MigrationPlan['skipped'] = [];
  for (const [path, pages] of groups) {
    if (!pages.some((p) => p.path !== path)) continue;
    const reason = rejectionReason(pages, snapshot);
    if (reason != null)
      skipped.push({ path, pageIds: pages.map((p) => p.id), reason });
    else merges.push(chooseMerge(pages));
  }
  const aliases = merges.flatMap((m) =>
    m.fromPaths.map((fromPath) => ({ fromPath, toPath: m.toPath })),
  );
  const aliasMap = new Map(aliases.map((a) => [a.fromPath, a.toPath]));
  return {
    version: 1,
    database,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(ordered))
      .digest('hex'),
    merges,
    skipped,
    pageUpdates: buildUpdates(snapshot, merges),
    aliases,
    redirectUpdates: ordered.redirects.flatMap((r) => {
      const toPath = aliasMap.get(r.toPath);
      return toPath == null ? [] : [{ id: r.id, toPath }];
    }),
  };
}
