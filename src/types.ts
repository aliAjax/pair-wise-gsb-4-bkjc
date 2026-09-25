// 领域模型：贡献归属台账的原始资料与人工判定

/** 贡献者（CLA 签署情况来自外部表格，手工或粘贴登记） */
export interface Contributor {
  id: string;
  name: string;
  email?: string;
  claSigned: boolean;
  claNote?: string;
}

/** 提交中登记的单个文件及其许可条款；撤下后保留记录但不再产生归属 */
export interface SubmissionFile {
  path: string;
  license: string;
  withdrawn?: boolean;
  withdrawnAt?: string;
}

/** 一次提交登记：仓库、提交号、贡献者与文件清单 */
export interface Submission {
  id: string;
  repo: string;
  commit: string;
  contributorIds: string[];
  files: SubmissionFile[];
  note?: string;
  createdAt: string;
}

/** 资料层：只记录事实，不存放判定结论 */
export interface Records {
  contributors: Contributor[];
  submissions: Submission[];
}

/** 同一文件条款冲突后的人工复核结论 */
export interface ConflictReview {
  id: string;
  /** 归属文件键：仓库 + 规范化路径 */
  fileKey: string;
  /** 复核时的资料指纹（提交号 + 文件清单）；资料改动后对不上即失效 */
  fingerprint: string;
  chosenLicense: string;
  note: string;
  reviewer: string;
  decidedAt: string;
}

/** 判定层：与资料分开保存 */
export interface Decisions {
  reviews: ConflictReview[];
}
