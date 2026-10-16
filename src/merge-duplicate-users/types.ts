import type { Document } from 'mongodb';

export interface Alias {
  id: string;
  field: 'username' | 'email';
  original: string;
  replacement: string;
}
export interface UserMerge {
  username: string;
  keepId: string;
  removeIds: string[];
}
export interface Change {
  collection: string;
  id: string;
  set?: Document;
  delete?: boolean;
}
export interface MergePlan {
  version: 1;
  database: string;
  fingerprint: string;
  groups: UserMerge[];
  changes: Change[];
  referenceUpdates: Record<string, number>;
}
