// 判定引擎：纯函数，只读资料 + 判定，不碰存储。
// 资料、判定、保存三者分开，重开应用时重新推导，即可复查全部缺口。
import type { ConflictReview, Decisions, Records, Submission, SubmissionFile } from './types';

let seq = 0;
export function uid(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 路径归一化：去前导 ./ 与多余斜杠，统一分隔符 */
export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** 文件在台账中的归属键：仓库 + 路径。同一路径跨提交视为同一文件 */
export function fileKey(repo: string, path: string): string {
  return `${repo.trim()}::${normalizePath(path)}`;
}

export function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type GroupState = 'resolved' | 'conflict' | 'missingLicense';

/** 跨提交聚合后的单个文件状态 */
export interface FileGroup {
  key: string;
  repo: string;
  path: string;
  licenses: string[];
  /** 仍在产生归属的文件条目（未撤下） */
  activeEntries: { submission: Submission; file: SubmissionFile }[];
  withdrawnEntries: { submission: Submission; file: SubmissionFile }[];
  state: GroupState;
  /** 最终采用的许可条款（冲突时取复核结论） */
  effectiveLicense?: string;
  review?: ConflictReview;
  reviewStale?: boolean;
  fingerprint: string;
}

/** 单条贡献归属：贡献者 × 文件，去重后只记一次 */
export interface Attribution {
  contributorId: string;
  fileKey: string;
  repo: string;
  path: string;
  license: string;
  fromSubmissionIds: string[];
}

export type GapKind =
  | 'conflict'        // 同文件条款冲突，待复核
  | 'reviewStale'     // 复核后提交号/文件清单改动，复核失效
  | 'missingLicense'  // 文件缺许可条款
  | 'claMissing'      // 归属中的贡献者未签 CLA
  | 'submissionIncomplete' // 提交资料不全
  | 'orphanReview';   // 判定层的复核在资料里已找不到对应文件

export interface Gap {
  kind: GapKind;
  message: string;
  repo?: string;
  path?: string;
  fileKey?: string;
  submissionId?: string;
  contributorId?: string;
}

export interface Derived {
  groups: FileGroup[];
  attributions: Attribution[];
  gaps: Gap[];
  /** 按文件键索引，便于界面取数 */
  groupMap: Map<string, FileGroup>;
}

/**
 * 文件资料指纹：提交号 + 文件清单（路径|条款|是否撤下）。
 * 按需求，只有提交号或文件清单改动才使复核失效；备注等字段不参与。
 */
export function fingerprintFor(entries: { submission: Submission; file: SubmissionFile }[]): string {
  const parts = entries
    .map(({ submission, file }) => `${submission.commit}@${file.path}|${file.license}|${file.withdrawn ? 1 : 0}`)
    .sort();
  return JSON.stringify(parts);
}

export function derive(records: Records, decisions: Decisions): Derived {
  const gaps: Gap[] = [];
  const groupIndex = new Map<string, FileGroup>();

  // 1) 资料完整性检查 + 按文件聚合（撤下的条目不参与聚合）
  for (const sub of records.submissions) {
    if (!sub.repo.trim() || !sub.commit.trim() || sub.contributorIds.length === 0) {
      gaps.push({
        kind: 'submissionIncomplete',
        message: `提交 ${sub.commit.slice(0, 10) || '（缺提交号）'} 资料不全：仓库、提交号、贡献者均需填写`,
        repo: sub.repo, submissionId: sub.id,
      });
    }
    for (const file of sub.files) {
      if (file.withdrawn) continue;
      if (!normalizePath(file.path)) continue; // 空白行不处理
      const key = fileKey(sub.repo, file.path);
      let g = groupIndex.get(key);
      if (!g) {
        g = {
          key, repo: sub.repo.trim(), path: normalizePath(file.path),
          licenses: [], activeEntries: [], withdrawnEntries: [], state: 'resolved',
          fingerprint: '',
        };
        groupIndex.set(key, g);
      }
      g.activeEntries.push({ submission: sub, file });
    }
  }

  // 2) 汇总撤下条目（供界面展示"仍由其它提交保留"）
  for (const sub of records.submissions) {
    for (const file of sub.files) {
      if (!file.withdrawn || !normalizePath(file.path)) continue;
      const key = fileKey(sub.repo, file.path);
      let target = groupIndex.get(key);
      // 即使所有条目都撤下，也建一个仅含撤下记录的组，便于追溯
      if (!target) {
        target = {
          key, repo: sub.repo.trim(), path: normalizePath(file.path),
          licenses: [], activeEntries: [], withdrawnEntries: [], state: 'resolved',
          fingerprint: '',
        };
        groupIndex.set(key, target);
      }
      target.withdrawnEntries.push({ submission: sub, file });
    }
  }

  // 3) 逐文件判定：条款集合 → 冲突 / 缺条款 / 已解决，并校验复核
  for (const g of groupIndex.values()) {
    g.licenses = Array.from(new Set(g.activeEntries.map(e => e.file.license.trim()).filter(Boolean))).sort();
    g.fingerprint = fingerprintFor([...g.activeEntries, ...g.withdrawnEntries]);

    if (g.activeEntries.length === 0) continue; // 全部撤下：不产生归属

    if (g.licenses.length === 0) {
      g.state = 'missingLicense';
      gaps.push({
        kind: 'missingLicense',
        message: `文件 ${g.path} 缺少许可条款，无法进入声明`,
        repo: g.repo, path: g.path, fileKey: g.key,
      });
      continue;
    }

    const review = decisions.reviews.find(r => r.fileKey === g.key);
    if (g.licenses.length > 1) {
      if (!review) {
        g.state = 'conflict';
        gaps.push({
          kind: 'conflict',
          message: `文件 ${g.path} 存在条款冲突：${g.licenses.join(' / ')}，需复核后才能进入声明`,
          repo: g.repo, path: g.path, fileKey: g.key,
        });
      } else {
        g.review = review;
        const stale =
          review.fingerprint !== g.fingerprint ||
          !g.licenses.includes(review.chosenLicense.trim());
        if (stale) {
          g.state = 'conflict';
          g.reviewStale = true;
          gaps.push({
            kind: 'reviewStale',
            message: `文件 ${g.path} 的复核已失效（提交号或文件清单已改动），请重新复核`,
            repo: g.repo, path: g.path, fileKey: g.key,
          });
        } else {
          g.state = 'resolved';
          g.effectiveLicense = review.chosenLicense.trim();
        }
      }
    } else {
      // 条款一致：直接采用；即使存在旧复核也以唯一条款为准
      g.state = 'resolved';
      g.effectiveLicense = g.licenses[0];
    }
  }

  // 4) 判定层孤儿复核：资料里对应文件已不存在或已全部撤下
  for (const review of decisions.reviews) {
    const g = groupIndex.get(review.fileKey);
    if (!g || g.activeEntries.length === 0) {
      gaps.push({
        kind: 'orphanReview',
        message: `复核记录「${review.fileKey}」对应的文件已撤下或不存在，该判定不再生效`,
        fileKey: review.fileKey,
      });
    }
  }

  // 5) 生成归属：文件撤下只撤回该文件产生的归属；贡献者另有文件则保留
  const attributions: Attribution[] = [];
  const attrIndex = new Map<string, Attribution>();
  for (const g of groupIndex.values()) {
    if (g.state !== 'resolved' || !g.effectiveLicense) continue;
    for (const entry of g.activeEntries) {
      for (const cid of entry.submission.contributorIds) {
        const aKey = `${cid}::${g.key}`;
        const existing = attrIndex.get(aKey);
        if (existing) {
          if (!existing.fromSubmissionIds.includes(entry.submission.id)) {
            existing.fromSubmissionIds.push(entry.submission.id);
          }
        } else {
          const attr: Attribution = {
            contributorId: cid,
            fileKey: g.key,
            repo: g.repo,
            path: g.path,
            license: g.effectiveLicense,
            fromSubmissionIds: [entry.submission.id],
          };
          attrIndex.set(aKey, attr);
          attributions.push(attr);
        }
      }
    }
  }

  // 6) CLA 缺口：已进入归属的贡献者未签 CLA，声明前需补签
  for (const attr of attributions) {
    const contributor = records.contributors.find(c => c.id === attr.contributorId);
    if (!contributor) {
      gaps.push({
        kind: 'claMissing',
        message: `归属中的贡献者已被删除，请重新指派：${attr.path}`,
        repo: attr.repo, path: attr.path, fileKey: attr.fileKey,
        submissionId: attr.fromSubmissionIds[0], contributorId: attr.contributorId,
      });
    } else if (!contributor.claSigned) {
      gaps.push({
        kind: 'claMissing',
        message: `贡献者 ${contributor.name} 尚未签署 CLA，涉及文件 ${attr.path}`,
        repo: attr.repo, path: attr.path, fileKey: attr.fileKey,
        submissionId: attr.fromSubmissionIds[0], contributorId: contributor.id,
      });
    }
  }

  return {
    groups: Array.from(groupIndex.values()).sort((a, b) => a.key.localeCompare(b.key)),
    attributions: attributions.sort((a, b) =>
      a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.contributorId.localeCompare(b.contributorId)),
    gaps,
    groupMap: groupIndex,
  };
}

/** 生成归属声明 Markdown：只收录判定通过的归属；未签 CLA 的条目标注待补签 */
export function buildNoticeMarkdown(records: Records, derived: Derived, includeUnsigned = true): string {
  const lines: string[] = [];
  lines.push('# 第三方贡献归属声明');
  lines.push('');
  lines.push(`> 由 License Lens 依据登记资料生成，共 ${derived.attributions.length} 条归属。`);
  if (derived.gaps.length > 0) {
    lines.push(`> ⚠ 存在 ${derived.gaps.length} 项待处理缺口，声明内容可能不完整，详见「待办缺口」。`);
  }
  lines.push('');

  const byLicense = new Map<string, Attribution[]>();
  for (const attr of derived.attributions) {
    const list = byLicense.get(attr.license) ?? [];
    list.push(attr);
    byLicense.set(attr.license, list);
  }
  for (const license of Array.from(byLicense.keys()).sort()) {
    const list = byLicense.get(license)!;
    const visible = list.filter(a => {
      if (includeUnsigned) return true;
      return records.contributors.find(c => c.id === a.contributorId)?.claSigned;
    });
    if (visible.length === 0) continue;
    lines.push(`## ${license}`);
    lines.push('');
    for (const repo of Array.from(new Set(visible.map(a => a.repo))).sort()) {
      lines.push(`- 仓库 \`${repo}\``);
      for (const a of visible.filter(x => x.repo === repo)) {
        const c = records.contributors.find(x => x.id === a.contributorId);
        const name = c?.name ?? '（未知贡献者）';
        const unsigned = c && !c.claSigned;
        lines.push(`  - \`${a.path}\` — ${name}${unsigned ? '（⚠ CLA 待补签，暂缓对外发布）' : ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
