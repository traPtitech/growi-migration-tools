export interface PageState {
  id: string;
  path: string;
  parent?: string | null;
  revision?: string | null;
  isEmpty?: boolean;
  status?: string;
  grant?: number;
  grantedUsers?: string[];
  grantedGroups?: { type?: string; item: string }[] | null;
  descendantCount?: number;
}

export interface RedirectState {
  id: string;
  fromPath: string;
  toPath: string;
}

export interface Snapshot {
  pages: PageState[];
  redirects: RedirectState[];
  pendingOperations: number;
}

export interface Merge {
  keepId: string;
  removeIds: string[];
  fromPaths: string[];
  toPath: string;
}

export interface PageUpdate {
  id: string;
  set: { path?: string; parent?: string; descendantCount?: number };
}

export interface MigrationPlan {
  version: 1;
  database: string;
  fingerprint: string;
  merges: Merge[];
  skipped: { path: string; pageIds: string[]; reason: string }[];
  pageUpdates: PageUpdate[];
  aliases: { fromPath: string; toPath: string }[];
  redirectUpdates: { id: string; toPath: string }[];
}
