// License Lens · 判定层 —— 纯函数引擎
// 输入资料（提交 / 贡献者 / 复核），输出分组、缺口、可进声明的归属。
// 本文件不读写存储、不碰 React，保证“资料 / 判定 / 保存”三者分离。

import type {
  ActiveClaim, ConflictReview, FileClaim, FileGroup, Gap,
  LedgerState, Submission,
} from './types';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * 单条 (提交, 文件) 声明指纹：
 * 覆盖 提交号 + 文件路径 + 许可条款 ——
 * 提交号改动、文件清单增删改、条款改动，都会使依赖它的复核失效。
 */
export function claimFingerprint(commit: string, file: FileClaim): string {
  return hashStr(`${commit}::${file.path}::${file.license}`);
}

/**
 * 文件分组快照指纹：把该文件当前全部有效声明（含各自提交号）排序后拼哈希。
 * 任何一个成员的提交号/路径/条款变化、声明增删，都会改变快照。
 */
export function groupSignature(claims: ActiveClaim[]): string {
  const snap = claims
    .map(c => `${c.commit}|${c.contributorId}|${c.file.path}|${c.file.license}`)
    .sort()
    .join(';;');
  return hashStr(snap);
}

export function fileGroupKey(repo: string, path: string) {
  return `${repo}::${path}`;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 取出全部未撤下的文件声明 */
export function activeClaims(submissions: Submission[]): ActiveClaim[] {
  const out: ActiveClaim[] = [];
  for (const sub of submissions) {
    for (const file of sub.files) {
      if (file.withdrawn) continue;
      out.push({
        submissionId: sub.id,
        repo: sub.repo,
        commit: sub.commit,
        contributorId: sub.contributorId,
        file,
        fingerprint: claimFingerprint(sub.commit, file),
      });
    }
  }
  return out;
}

/** 按 (仓库, 文件路径) 聚合，并挂上复核状态 */
export function groupFiles(state: LedgerState): FileGroup[] {
  const map = new Map<string, FileGroup>();
  for (const c of activeClaims(state.submissions)) {
    const key = fileGroupKey(c.repo, c.file.path);
    if (!map.has(key)) map.set(key, {
      key, repo: c.repo, path: c.file.path, claims: [],
      licenses: [], conflicting: false, groupSig: '', reviewFresh: false,
    });
    map.get(key)!.claims.push(c);
  }
  for (const g of map.values()) {
    g.licenses = Array.from(new Set(g.claims.map(c => c.file.license))).sort();
    g.conflicting = g.licenses.length > 1;
    g.groupSig = groupSignature(g.claims);
    const review = state.reviews.find(
      r => fileGroupKey(r.repo, r.path) === g.key,
    );
    if (review) {
      g.review = review;
      // 指纹对得上才有效；提交号或文件清单（含条款）改动后必然不一致
      g.reviewFresh = review.groupSig === g.groupSig;
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

/** 缺口清单：资料不完整、CLA 未签、冲突待复核、复核失效。重开后重算即可查缺口。 */
export function findGaps(state: LedgerState): Gap[] {
  const gaps: Gap[] = [];
  const contributorIds = new Set(state.contributors.map(c => c.id));

  for (const sub of state.submissions) {
    if (!sub.repo.trim() || !sub.commit.trim() || !sub.contributorId) {
      gaps.push({
        kind: 'submission-incomplete',
        label: '提交资料不完整',
        detail: `${sub.repo || '（缺仓库）'} · ${sub.commit || '（缺提交号）'} 缺仓库、提交号或贡献者`,
        target: { submissionId: sub.id, repo: sub.repo },
      });
    }
    if (sub.contributorId && !contributorIds.has(sub.contributorId)) {
      gaps.push({
        kind: 'submission-incomplete',
        label: '贡献者档案缺失',
        detail: `提交 ${sub.commit || '（无提交号）'} 指向已删除的贡献者`,
        target: { submissionId: sub.id },
      });
    }
    for (const f of sub.files) {
      if (f.withdrawn) continue;
      if (!f.path.trim() || !f.license.trim()) {
        gaps.push({
          kind: 'file-incomplete',
          label: '文件声明不完整',
          detail: `提交 ${sub.commit || '（无提交号）'} 中存在缺路径或许可条款的文件`,
          target: { submissionId: sub.id, repo: sub.repo, path: f.path },
        });
      }
    }
  }

  // 有在档（未撤下）贡献、但没签 CLA 的贡献者
  const liveContributorIds = new Set(
    state.submissions
      .filter(s => s.files.some(f => !f.withdrawn))
      .map(s => s.contributorId),
  );
  for (const c of state.contributors) {
    if (liveContributorIds.has(c.id) && !c.claSigned) {
      gaps.push({
        kind: 'cla-unsigned',
        label: '贡献者未签 CLA',
        detail: `${c.name} 名下仍有未撤下的文件，但未登记 CLA 签署`,
        target: { contributorId: c.id },
      });
    }
  }

  for (const g of groupFiles(state)) {
    if (!g.conflicting) continue;
    if (!g.review) {
      gaps.push({
        kind: 'conflict-open',
        label: '条款冲突 · 待复核',
        detail: `${g.repo} · ${g.path} 同时声明 ${g.licenses.join(' / ')}，已暂停进入归属声明`,
        target: { repo: g.repo, path: g.path },
      });
    } else if (!g.reviewFresh) {
      gaps.push({
        kind: 'review-stale',
        label: '复核已失效 · 需重新复核',
        detail: `${g.repo} · ${g.path} 的提交号或文件清单改动后，原复核（${g.review.reviewedAt.slice(0, 10)}）不再对应当前资料`,
        target: { repo: g.repo, path: g.path },
      });
    }
  }

  const order: Record<Gap['kind'], number> = {
    'conflict-open': 0, 'review-stale': 1,
    'submission-incomplete': 2, 'file-incomplete': 3, 'cla-unsigned': 4,
  };
  return gaps.sort((a, b) => order[a.kind] - order[b.kind]);
}

export interface AttributionEntry {
  repo: string;
  path: string;
  contributorId: string;
  commit: string;
  license: string;
  /** 冲突文件经复核裁定时，记录采用裁定条款 */
  resolvedByReview?: boolean;
}

/**
 * 最终可进入归属声明的条目：
 * - 无冲突文件：直接进声明
 * - 冲突文件：必须有与当前快照一致的有效复核，采用裁定条款
 * - 资料不全的声明不产出
 */
export function buildAttributions(state: LedgerState): AttributionEntry[] {
  const groups = groupFiles(state);
  const out: AttributionEntry[] = [];
  for (const g of groups) {
    // 路径/条款/仓库缺失的组不算有效产出
    if (!g.repo.trim() || !g.path.trim()) continue;
    const validClaims = g.claims.filter(c => c.file.license.trim());
    if (validClaims.length === 0) continue;

    if (!g.conflicting) {
      for (const c of validClaims) {
        out.push({
          repo: g.repo, path: g.path, contributorId: c.contributorId,
          commit: c.commit, license: c.file.license,
        });
      }
      continue;
    }

    // 冲突未复核或复核已失效 → 停，不进声明
    if (!g.review || !g.reviewFresh) continue;

    const chosen = g.review.chosenLicense;
    for (const c of validClaims) {
      // 所有贡献者都出现在声明里，条款统一用裁定结果；未被采用的条款留在复核记录中可查
      out.push({
        repo: g.repo, path: g.path, contributorId: c.contributorId,
        commit: c.commit, license: chosen, resolvedByReview: true,
      });
    }
  }
  return out;
}

export function findReview(reviews: ConflictReview[], repo: string, path: string) {
  return reviews.find(r => fileGroupKey(r.repo, r.path) === fileGroupKey(repo, path));
}
