// 示例资料：覆盖正常归属、同文件条款冲突、撤下文件、未签 CLA 等典型场景
import type { Records } from './types';

export const sampleRecords: Records = {
  contributors: [
    { id: 'c_chen', name: '陈一帆', email: 'chen@example.com', claSigned: true },
    { id: 'c_lina', name: 'Lina Park', email: 'lina@example.com', claSigned: true, claNote: '2026-03 表格登记' },
    { id: 'c_omar', name: 'Omar Haddad', email: 'omar@example.com', claSigned: false },
    { id: 'c_wei', name: '魏然', claSigned: true },
  ],
  submissions: [
    {
      id: 's_1', repo: 'license-lens/web', commit: 'a1b2c3d4',
      contributorIds: ['c_chen'],
      files: [
        { path: 'src/parser.ts', license: 'MIT' },
        { path: 'src/exporter.ts', license: 'MIT' },
      ],
      note: '解析器与 Markdown 导出',
      createdAt: '2026-04-02T09:12:00.000Z',
    },
    {
      id: 's_2', repo: 'license-lens/web', commit: 'e5f6a7b8',
      contributorIds: ['c_lina'],
      files: [
        // 与 s_1 同文件不同条款：触发冲突，停待复核
        { path: 'src/parser.ts', license: 'Apache-2.0' },
        { path: 'src/report.css', license: 'MIT' },
      ],
      note: '解析器改用 Apache 头并补充报告样式',
      createdAt: '2026-04-18T14:40:00.000Z',
    },
    {
      id: 's_3', repo: 'license-lens/core', commit: '90ab12cd',
      contributorIds: ['c_omar', 'c_wei'],
      files: [
        { path: 'tools/scan.sh', license: 'BSD-3-Clause' },
        // 已撤下：仅撤回该文件归属；两人在其它文件上的归属保留
        { path: 'tools/legacy_diff.py', license: 'GPL-3.0', withdrawn: true, withdrawnAt: '2026-05-06T02:00:00.000Z' },
      ],
      createdAt: '2026-04-27T08:05:00.000Z',
    },
  ],
};
