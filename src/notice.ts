// License Lens · 声明输出 —— 只对“判定层放行”的归属条目做格式化，不自行决定谁该进声明。

import type { Contributor, LedgerState } from './types';
import { buildAttributions } from './engine';

/** 生成 Markdown 归属声明；冲突未复核的文件不会出现在这里 */
export function buildNoticeMarkdown(state: LedgerState): string {
  const entries = buildAttributions(state);
  const byRepo = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo)!.push(e);
  }

  const nameOf = new Map(state.contributors.map(c => [c.id, c]));
  const lines: string[] = [];
  lines.push('# 第三方贡献归属声明 (NOTICE)');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　来源：License Lens 贡献归属台账`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('_当前没有可进入声明的归属条目：可能全部撤下，或仍有冲突待复核。_');
    return lines.join('\n');
  }

  for (const [repo, list] of Array.from(byRepo).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${repo}`);
    lines.push('');
    // 同仓库按贡献者归并，避免漏人也避免重复署名
    const byPerson = new Map<string, typeof list>();
    for (const e of list) {
      if (!byPerson.has(e.contributorId)) byPerson.set(e.contributorId, []);
      byPerson.get(e.contributorId)!.push(e);
    }
    for (const [cid, items] of byPerson) {
      const person: Contributor | undefined = nameOf.get(cid);
      const header = person?.claSigned
        ? `${person.name}${person.email ? ` <${person.email}>` : ''}`
        : `${person?.name ?? '（未知贡献者）'}（CLA 状态未确认，请补登记后再发布）`;
      lines.push(`### ${header}`);
      for (const it of items.sort((a, b) => a.path.localeCompare(b.path))) {
        const tag = it.resolvedByReview ? '（条款冲突经复核裁定）' : '';
        lines.push(`- \`${it.path}\` — ${it.license}${tag}（提交 ${it.commit.slice(0, 12)}）`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
