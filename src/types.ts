// License Lens · 贡献归属台账 —— 资料层类型定义
// 这里只描述“登记了什么”，不包含任何判定结论。

/** 贡献者：CLA 签署状态独立登记，与提交记录分开维护 */
export interface Contributor {
  id: string;
  name: string;
  email?: string;
  claSigned: boolean;
  claSignedAt?: string; // ISO 日期
}

/** 单条文件级贡献声明（一条提交里每个文件一行） */
export interface FileClaim {
  id: string;
  path: string;
  license: string; // 该贡献者在此文件上声明的许可条款，如 MIT / Apache-2.0
  withdrawn: boolean; // 文件撤下：仅撤回“这一条”归属
  withdrawnAt?: string;
  withdrawnReason?: string;
}

/** 提交记录：仓库 + 提交号 + 贡献者 + 文件清单 */
export interface Submission {
  id: string;
  repo: string;
  commit: string; // 提交号
  contributorId: string;
  message?: string;
  createdAt: string;
  files: FileClaim[];
}

/**
 * 复核记录：同一文件出现互斥条款时，人工裁定后才允许进声明。
 * groupSig 是复核时该文件全部有效声明的指纹快照；
 * 提交号或文件清单（含条款）改动后指纹变化 → 复核自动失效。
 */
export interface ConflictReview {
  id: string;
  repo: string;
  path: string;
  groupSig: string; // 复核时锁定的快照指纹
  chosenLicense: string; // 裁定采用的条款
  reviewer: string;
  note?: string;
  reviewedAt: string;
}

/** 持久化根对象：资料与复核结论分开存放 */
export interface LedgerState {
  version: 1;
  contributors: Contributor[];
  submissions: Submission[];
  reviews: ConflictReview[];
}

/** 同一文件聚在一起的一条有效声明 */
export interface ActiveClaim {
  submissionId: string;
  repo: string;
  commit: string;
  contributorId: string;
  file: FileClaim;
  fingerprint: string; // 该 (提交, 文件) 声明的指纹
}

/** 按 (仓库, 文件路径) 聚合出的一个文件节点 */
export interface FileGroup {
  key: string;
  repo: string;
  path: string;
  claims: ActiveClaim[];
  licenses: string[]; // 去重后的条款集合
  conflicting: boolean; // 条款数 > 1
  groupSig: string; // 当前快照指纹
  review?: ConflictReview; // 关联的复核记录（可能已失效）
  /** 复核与当前快照是否对得上 */
  reviewFresh: boolean;
}

export type GapKind =
  | 'submission-incomplete' // 提交缺仓库/提交号/贡献者
  | 'file-incomplete' // 文件缺路径或许可条款
  | 'cla-unsigned' // 贡献者未签 CLA
  | 'conflict-open' // 条款冲突待复核，挡住声明
  | 'review-stale'; // 资料改动后旧复核失效

export interface Gap {
  kind: GapKind;
  label: string;
  detail: string;
  target?: { submissionId?: string; repo?: string; path?: string; contributorId?: string };
}
