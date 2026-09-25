// License Lens · 保存层 —— localStorage 持久化 + 示例资料 + 导入导出
// 只负责“存得进、取得出、重开还在”，不含判定逻辑。

import type { LedgerState } from './types';
import { uid } from './engine';

const STORAGE_KEY = 'license-lens-ledger-v1';

/** 示例资料：故意包含一起条款冲突，方便看到“停待复核 → 复核后进声明”的流程 */
export function seedState(): LedgerState {
  const ada = { id: 'u-ada', name: 'Ada Chen', email: 'ada@example.com', claSigned: true, claSignedAt: '2026-03-02' };
  const ben = { id: 'u-ben', name: 'Ben Ortiz', email: 'ben@example.com', claSigned: false };
  const cara = { id: 'u-cara', name: 'Cara Liu', claSigned: true, claSignedAt: '2026-04-18' };

  return {
    version: 1,
    contributors: [ada, ben, cara],
    submissions: [
      {
        id: uid(), repo: 'web/portal', commit: 'a1b2c3d', contributorId: ada.id,
        message: '新增登录页与表单校验', createdAt: '2026-05-10T09:12:00Z',
        files: [
          { id: uid(), path: 'src/auth/Login.tsx', license: 'MIT', withdrawn: false },
          { id: uid(), path: 'src/auth/validate.ts', license: 'MIT', withdrawn: false },
        ],
      },
      {
        id: uid(), repo: 'web/portal', commit: 'e4f5g6h', contributorId: ben.id,
        message: '重构校验逻辑并补充规则', createdAt: '2026-06-02T14:40:00Z',
        files: [
          // 与 Ada 同文件、不同条款 → 冲突，停待复核
          { id: uid(), path: 'src/auth/validate.ts', license: 'Apache-2.0', withdrawn: false },
          { id: uid(), path: 'src/auth/rules.ts', license: 'Apache-2.0', withdrawn: false },
        ],
      },
      {
        id: uid(), repo: 'web/portal', commit: 'i7j8k9l', contributorId: cara.id,
        message: '旧版实验组件（已随版本撤下）', createdAt: '2026-06-20T11:05:00Z',
        files: [
          { id: uid(), path: 'src/experiments/Playground.tsx', license: 'MIT', withdrawn: false },
          {
            id: uid(), path: 'src/experiments/LegacyWidget.tsx', license: 'MIT',
            withdrawn: true, withdrawnAt: '2026-08-15T08:00:00Z', withdrawnReason: '文件随 v2 重构撤下',
          },
        ],
      },
      {
        id: uid(), repo: 'docs/site', commit: '0ff1ce2', contributorId: ada.id,
        message: '补充部署文档', createdAt: '2026-07-11T16:20:00Z',
        files: [
          { id: uid(), path: 'docs/deploy.md', license: 'CC-BY-4.0', withdrawn: false },
        ],
      },
    ],
    reviews: [],
  };
}

export function loadState(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LedgerState;
      if (parsed && parsed.version === 1) return parsed;
    }
  } catch {
    // 损坏数据落到示例，保证可继续使用
  }
  return seedState();
}

export function saveState(state: LedgerState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState(): LedgerState {
  const fresh = seedState();
  saveState(fresh);
  return fresh;
}

export function exportJSON(state: LedgerState): void {
  download(
    `license-lens-ledger-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(state, null, 2),
    'application/json',
  );
}

export function importJSON(text: string): LedgerState {
  const data = JSON.parse(text) as LedgerState;
  if (!data || data.version !== 1 || !Array.isArray(data.submissions) || !Array.isArray(data.contributors)) {
    throw new Error('文件不是有效的 License Lens 台账');
  }
  return {
    version: 1,
    contributors: data.contributors,
    submissions: data.submissions,
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
  };
}

function download(filename: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
