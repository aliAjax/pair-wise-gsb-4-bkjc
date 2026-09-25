import { strict as assert } from 'node:assert';
import { derive, fingerprintFor, buildNoticeMarkdown, fileKey } from '../src/engine';
import { sampleRecords } from '../src/sample';
import type { Decisions, Records } from './src/types';

let passed = 0;
const ok = (name: string) => { passed++; console.log('  ✓', name); };

// 场景 1：示例数据初始状态 —— parser.ts 冲突、legacy_diff.py 已撤下、Omar 未签 CLA
{
  const decisions: Decisions = { reviews: [] };
  const d = derive(sampleRecords, decisions);
  const parserKey = fileKey('license-lens/web', 'src/parser.ts');
  const parser = d.groupMap.get(parserKey)!;
  assert.equal(parser.state, 'conflict');
  assert.deepEqual(parser.licenses, ['Apache-2.0', 'MIT']);
  ok('同文件不同条款 -> 冲突，停待复核');

  const md = buildNoticeMarkdown(sampleRecords, d);
  assert.ok(!md.includes('src/parser.ts'), '冲突文件不得进入声明');
  assert.ok(md.includes('src/exporter.ts'), '无冲突文件进入声明');
  ok('冲突未复核时不进归属声明');

  // legacy_diff.py 已撤下：不产生归属；但 tools/scan.sh 保留两人归属
  const diffKey = fileKey('license-lens/core', 'tools/legacy_diff.py');
  assert.equal(d.groupMap.get(diffKey)!.activeEntries.length, 0);
  const omarAttrs = d.attributions.filter(a => a.contributorId === 'c_omar');
  assert.deepEqual(omarAttrs.map(a => a.path), ['tools/scan.sh']);
  const weiAttrs = d.attributions.filter(a => a.contributorId === 'c_wei');
  assert.deepEqual(weiAttrs.map(a => a.path), ['tools/scan.sh']);
  ok('撤下文件只撤回该文件归属，贡献者另有文件则保留');

  const claGaps = d.gaps.filter(g => g.kind === 'claMissing');
  assert.ok(claGaps.some(g => g.contributorId === 'c_omar'));
  assert.ok(!claGaps.some(g => g.contributorId === 'c_wei'));
  ok('未签 CLA 的归属进缺口，已签者不报');
}

// 场景 2：复核冲突文件后进入声明
{
  const decisions: Decisions = { reviews: [{
    id: 'rv1', fileKey: fileKey('license-lens/web', 'src/parser.ts'),
    fingerprint: '', chosenLicense: 'MIT', note: '', reviewer: '法务', decidedAt: new Date().toISOString(),
  }]};
  const groups = derive(sampleRecords, decisions).groups;
  const g = groups.find(x => x.path === 'src/parser.ts')!;
  decisions.reviews[0].fingerprint = g.fingerprint;
  const d2 = derive(sampleRecords, decisions);
  const g2 = d2.groupMap.get(decisions.reviews[0].fileKey)!;
  assert.equal(g2.state, 'resolved');
  assert.equal(g2.effectiveLicense, 'MIT');
  assert.equal(d2.gaps.filter(x => x.kind === 'conflict').length, 0);
  const md = buildNoticeMarkdown(sampleRecords, d2);
  assert.ok(md.includes('src/parser.ts'));
  ok('复核采用条款后解除停留并进入声明');
}

// 场景 3：复核后改提交号 -> 复核失效
{
  const decisions: Decisions = { reviews: [] };
  const base = derive(sampleRecords, decisions);
  const key = fileKey('license-lens/web', 'src/parser.ts');
  const g0 = base.groupMap.get(key)!;
  const fp0 = g0.fingerprint;

  const changed: Records = JSON.parse(JSON.stringify(sampleRecords));
  changed.submissions.find(s => s.id === 's_1')!.commit = 'ffff9999';
  const d3 = derive(changed, { reviews: [{
    id: 'rv1', fileKey: key, fingerprint: fp0, chosenLicense: 'MIT',
    note: '', reviewer: '法务', decidedAt: new Date().toISOString(),
  }]});
  const g3 = d3.groupMap.get(key)!;
  assert.equal(g3.state, 'conflict');
  assert.equal(g3.reviewStale, true);
  assert.ok(d3.gaps.some(x => x.kind === 'reviewStale'));
  ok('提交号改动后复核失效');
}

// 场景 4：复核后文件清单改动（给 s_1 增加文件、改条款）-> 指纹变化
{
  const key = fileKey('license-lens/web', 'src/parser.ts');
  const fp0 = derive(sampleRecords, { reviews: [] }).groupMap.get(key)!.fingerprint;
  const changed: Records = JSON.parse(JSON.stringify(sampleRecords));
  const s2 = changed.submissions.find(s => s.id === 's_2')!;
  s2.files.find(f => f.path === 'src/parser.ts')!.license = 'MPL-2.0';
  const d4 = derive(changed, { reviews: [{
    id: 'rv1', fileKey: key, fingerprint: fp0, chosenLicense: 'MIT',
    note: '', reviewer: '', decidedAt: '',
  }]});
  assert.equal(d4.groupMap.get(key)!.reviewStale, true);
  ok('文件清单（条款）改动后复核失效');
}

// 场景 5：恢复撤下文件 -> 冲突重新出现（若条款不同）；删光提交 -> 孤儿复核
{
  const key = fileKey('license-lens/core', 'tools/legacy_diff.py');
  const decisions: Decisions = { reviews: [{
    id: 'rvx', fileKey: key, fingerprint: 'old', chosenLicense: 'GPL-3.0',
    note: '', reviewer: '', decidedAt: '',
  }]};
  const d = derive(sampleRecords, decisions);
  assert.ok(d.gaps.some(g => g.kind === 'orphanReview'));
  ok('文件全撤下/提交删除后，对应判定成为孤儿复核缺口');

  const restored: Records = JSON.parse(JSON.stringify(sampleRecords));
  const f = restored.submissions.find(s => s.id === 's_3')!.files.find(x => x.path === 'tools/legacy_diff.py')!;
  delete f.withdrawn; delete f.withdrawnAt;
  f.license = 'MIT';
  const d2 = derive(restored, decisions);
  assert.equal(d2.groupMap.get(key)!.activeEntries.length, 1);
  assert.equal(d2.groupMap.get(key)!.state, 'resolved');
  ok('撤下恢复后重新参与归属计算');
}

// 场景 6：缺许可条款
{
  const records: Records = {
    contributors: [{ id: 'c1', name: '甲', claSigned: true }],
    submissions: [{
      id: 's1', repo: 'r', commit: 'abc', contributorIds: ['c1'],
      files: [{ path: 'a.txt', license: '' }], createdAt: '',
    }],
  };
  const d = derive(records, { reviews: [] });
  assert.equal(d.groupMap.get(fileKey('r', 'a.txt'))!.state, 'missingLicense');
  assert.equal(d.attributions.length, 0);
  assert.ok(d.gaps.some(g => g.kind === 'missingLicense'));
  ok('缺条款文件不产生归属并提示');
}

// 场景 7：同贡献者跨提交对同一文件只记一次归属
{
  const records: Records = {
    contributors: [{ id: 'c1', name: '甲', claSigned: true }],
    submissions: [
      { id: 's1', repo: 'r', commit: 'a1', contributorIds: ['c1'], files: [{ path: 'x.ts', license: 'MIT' }], createdAt: '' },
      { id: 's2', repo: 'r', commit: 'a2', contributorIds: ['c1'], files: [{ path: 'x.ts', license: 'MIT' }], createdAt: '' },
    ],
  };
  const d = derive(records, { reviews: [] });
  assert.equal(d.attributions.length, 1);
  assert.deepEqual(d.attributions[0].fromSubmissionIds, ['s1', 's2']);
  ok('同贡献者×同文件归属去重，保留来源提交链');
}

console.log(`\n全部通过：${passed} 项`);
