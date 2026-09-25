// 保存层：只负责持久化，不做任何业务判定。
// 资料与判定分开存储（两个键），重开应用时由引擎重新推导全部缺口。
import type { Decisions, Records } from './types';

const RECORDS_KEY = 'license-lens:records:v1';
const DECISIONS_KEY = 'license-lens:decisions:v1';

const emptyRecords: Records = { contributors: [], submissions: [] };
const emptyDecisions: Decisions = { reviews: [] };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export const storage = {
  loadRecords(): Records {
    return read(RECORDS_KEY, emptyRecords);
  },
  saveRecords(records: Records): void {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  },
  loadDecisions(): Decisions {
    return read(DECISIONS_KEY, emptyDecisions);
  },
  saveDecisions(decisions: Decisions): void {
    localStorage.setItem(DECISIONS_KEY, JSON.stringify(decisions));
  },
  clearAll(): void {
    localStorage.removeItem(RECORDS_KEY);
    localStorage.removeItem(DECISIONS_KEY);
  },
};

export interface BackupBundle {
  app: 'license-lens';
  version: 1;
  exportedAt: string;
  records: Records;
  decisions: Decisions;
}

export function downloadFile(filename: string, content: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
