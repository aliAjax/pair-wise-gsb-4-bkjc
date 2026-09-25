import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  AlertTriangle, BookOpenCheck, CheckCircle2, ClipboardList, FileDown, FileUp,
  FolderGit2, GitCommitHorizontal, Pencil, Plus, RotateCcw,
  Scale, Trash2, TriangleAlert, Upload, Users, X,
} from 'lucide-react';
import type { ConflictReview, Contributor, Decisions, Records, Submission, SubmissionFile } from './types';
import { storage, downloadFile, type BackupBundle } from './storage';
import { sampleRecords } from './sample';
import {
  buildNoticeMarkdown, derive, fileKey, fmtTime, normalizePath, uid,
  type FileGroup, type Gap,
} from './engine';

type Tab = 'gaps' | 'submissions' | 'reviews' | 'contributors' | 'notice';

const emptyDraft = (): Submission => ({
  id: uid('s'), repo: '', commit: '', contributorIds: [], files: [{ path: '', license: '' }],
  note: '', createdAt: new Date().toISOString(),
});

export default function App() {
  const [records, setRecords] = useState<Records>(() => storage.loadRecords());
  const [decisions, setDecisions] = useState<Decisions>(() => storage.loadDecisions());
  const [tab, setTab] = useState<Tab>('gaps');
  const [draft, setDraft] = useState<Submission | null>(null);
  const [focusFileKey, setFocusFileKey] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  // 保存层只持久化资料与判定；界面状态不入库
  useEffect(() => storage.saveRecords(records), [records]);
  useEffect(() => storage.saveDecisions(decisions), [decisions]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); }, [toast]);

  const derived = useMemo(() => derive(records, decisions), [records, decisions]);
  const contributorMap = useMemo(
    () => new Map(records.contributors.map(c => [c.id, c])), [records.contributors]);

  const patchRecords = (fn: (r: Records) => void) =>
    setRecords(prev => { const next: Records = structuredClone(prev); fn(next); return next; });

  const goGap = (gap: Gap) => {
    setFocusFileKey(gap.fileKey ?? null);
    if (gap.kind === 'submissionIncomplete' && gap.submissionId) {
      const sub = records.submissions.find(s => s.id === gap.submissionId);
      if (sub) { setDraft(structuredClone(sub)); setTab('submissions'); return; }
    }
    if (gap.kind === 'conflict' || gap.kind === 'reviewStale' || gap.kind === 'orphanReview') {
      setTab('reviews');
    } else if (gap.kind === 'claMissing') {
      setTab('contributors');
    } else if (gap.kind === 'missingLicense') {
      const sub = records.submissions.find(s =>
        s.files.some(f => !f.withdrawn && fileKey(s.repo, f.path) === gap.fileKey));
      if (sub) { setDraft(structuredClone(sub)); setTab('submissions'); } else setTab('submissions');
    }
  };

  // ---- 提交登记 ----
  const saveDraft = () => {
    if (!draft) return;
    const files = draft.files
      .map(f => ({ ...f, path: normalizePath(f.path), license: f.license.trim() }))
      .filter((f, i, arr) => f.path && arr.findIndex(o => o.path === f.path) === i);
    const cleaned: Submission = { ...draft, repo: draft.repo.trim(), commit: draft.commit.trim(), files };
    if (!cleaned.repo || !cleaned.commit || cleaned.contributorIds.length === 0 || files.length === 0) {
      setToast('请补全仓库、提交号、至少一位贡献者和一个文件'); return;
    }
    patchRecords(r => {
      const idx = r.submissions.findIndex(s => s.id === cleaned.id);
      if (idx >= 0) {
        // 保留既有撤下状态与时间（表单不允许编辑撤下行）
        const oldFiles = r.submissions[idx].files;
        cleaned.files = cleaned.files.map(f => {
          const old = oldFiles.find(o => o.path === f.path);
          return old?.withdrawn ? { ...f, withdrawn: true, withdrawnAt: old.withdrawnAt } : f;
        });
        r.submissions[idx] = cleaned;
      } else {
        r.submissions.unshift(cleaned);
      }
    });
    setDraft(null);
    setToast('提交登记已保存；如改动了提交号或文件清单，相关复核将自动标记失效');
  };

  const toggleWithdrawn = (sub: Submission, path: string) => patchRecords(r => {
    const s = r.submissions.find(x => x.id === sub.id)!;
    const f = s.files.find(x => x.path === path)!;
    if (f.withdrawn) { delete f.withdrawn; delete f.withdrawnAt; }
    else { f.withdrawn = true; f.withdrawnAt = new Date().toISOString(); }
  });

  const deleteSubmission = (sub: Submission) => {
    if (!confirm(`确定删除提交 ${sub.commit} 的全部登记？相关复核会在缺口页提示。`)) return;
    patchRecords(r => { r.submissions = r.submissions.filter(s => s.id !== sub.id); });
  };

  // ---- 冲突复核 ----
  const saveReview = (g: FileGroup, license: string, note: string, reviewer: string) => {
    if (!license.trim()) { setToast('请选择或填写采用的许可条款'); return; }
    setDecisions(prev => {
      const next: Decisions = structuredClone(prev);
      const existing = next.reviews.find(r => r.fileKey === g.key);
      const review: ConflictReview = existing ?? {
        id: uid('rv'), fileKey: g.key, fingerprint: '', chosenLicense: '', note: '', reviewer: '', decidedAt: '',
      };
      review.fingerprint = g.fingerprint;
      review.chosenLicense = license.trim();
      review.note = note.trim();
      review.reviewer = reviewer.trim() || '未署名';
      review.decidedAt = new Date().toISOString();
      if (!existing) next.reviews.push(review);
      return next;
    });
    setToast('复核已保存，文件进入归属声明');
  };
  const deleteReview = (g: FileGroup) => {
    if (!confirm('删除该复核结论后文件将重新停待复核，确定？')) return;
    setDecisions(prev => ({ ...prev, reviews: prev.reviews.filter(r => r.fileKey !== g.key) }));
  };

  // ---- 贡献者 / CLA ----
  const upsertContributor = (c: Contributor) => patchRecords(r => {
    const idx = r.contributors.findIndex(x => x.id === c.id);
    if (idx >= 0) r.contributors[idx] = c; else r.contributors.push(c);
  });
  const deleteContributor = (c: Contributor) => {
    const used = derived.attributions.some(a => a.contributorId === c.id);
    if (used && !confirm(`${c.name} 仍有归属记录，删除后相关归属会进入缺口。确定删除？`)) return;
    patchRecords(r => {
      r.contributors = r.contributors.filter(x => x.id !== c.id);
      r.submissions.forEach(s => { s.contributorIds = s.contributorIds.filter(id => id !== c.id); });
    });
  };
  const importClaTsv = (text: string) => {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const split = (l: string) => l.includes('\t') ? l.split('\t') : l.split(',').map(s => s.trim());
    const header = split(lines[0]).map(h => h.toLowerCase());
    const hasHeader = /name|姓名|邮箱|email|cla|签/.test(lines[0]);
    const col = (row: string[], ...keys: string[]) => {
      if (hasHeader) { const i = header.findIndex(h => keys.some(k => h.includes(k))); return i >= 0 ? row[i]?.trim() : ''; }
      return '';
    };
    const signed = (v: string) => /^(1|true|yes|y|已签|签署|signed)$/i.test(v.trim());
    let added = 0;
    patchRecords(r => {
      lines.slice(hasHeader ? 1 : 0).forEach(line => {
        const row = split(line);
        const name = col(row, 'name', '姓名') || row[0];
        const email = col(row, 'email', '邮箱') || (hasHeader ? '' : row[1]);
        const cla = col(row, 'cla', '签', 'status', '状态');
        const claSigned = hasHeader ? signed(cla) : signed(row[2] ?? '');
        const claNote = col(row, 'note', '备注') || (hasHeader ? '' : row[3]);
        if (!name) return;
        const existing = r.contributors.find(c => c.email && email && c.email === email);
        if (existing) { existing.claSigned = existing.claSigned || claSigned; if (claNote) existing.claNote = claNote; }
        else { r.contributors.push({ id: uid('c'), name, email: email || undefined, claSigned, claNote: claNote || undefined }); added++; }
      });
    });
    setToast(`CLA 表格已导入，新增 ${added} 位贡献者`);
  };

  // ---- 备份 / 示例 ----
  const exportBackup = () => {
    const bundle: BackupBundle = {
      app: 'license-lens', version: 1, exportedAt: new Date().toISOString(), records, decisions,
    };
    downloadFile('license-lens-backup.json', JSON.stringify(bundle, null, 2), 'application/json');
  };
  const importBackup = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bundle = JSON.parse(String(reader.result)) as BackupBundle;
        if (bundle.app !== 'license-lens' || !bundle.records) throw new Error('bad');
        setRecords({ contributors: bundle.records.contributors ?? [], submissions: bundle.records.submissions ?? [] });
        setDecisions({ reviews: bundle.decisions?.reviews ?? [] });
        setToast('备份已恢复');
      } catch { setToast('文件不是 License Lens 备份'); }
    };
    reader.readAsText(file);
  };
  const loadSample = () => {
    if (records.submissions.length && !confirm('将用示例资料覆盖当前台账，确定？')) return;
    setRecords(structuredClone(sampleRecords));
    setDecisions({ reviews: [] });
    setToast('示例资料已载入');
  };
  const clearAll = () => {
    if (!confirm('清空全部资料与判定？此操作不可恢复（可先用 JSON 备份）。')) return;
    setRecords({ contributors: [], submissions: [] });
    setDecisions({ reviews: [] });
  };

  const gapsByKind = useMemo(() => {
    const order: Gap['kind'][] = ['conflict', 'reviewStale', 'missingLicense', 'claMissing', 'submissionIncomplete', 'orphanReview'];
    return order.map(kind => ({ kind, items: derived.gaps.filter(g => g.kind === kind) }))
      .filter(x => x.items.length > 0);
  }, [derived.gaps]);

  const gapMeta: Record<Gap['kind'], { label: string; icon: ReactElement }> = {
    conflict: { label: '条款冲突 · 待复核', icon: <Scale size={15} /> },
    reviewStale: { label: '复核已失效（提交号/文件清单改动）', icon: <RotateCcw size={15} /> },
    missingLicense: { label: '缺许可条款', icon: <AlertTriangle size={15} /> },
    claMissing: { label: 'CLA 未签署', icon: <FileUp size={15} /> },
    submissionIncomplete: { label: '提交资料不全', icon: <ClipboardList size={15} /> },
    orphanReview: { label: '判定无对应资料', icon: <TriangleAlert size={15} /> },
  };

  const conflictGroups = derived.groups.filter(g => g.activeEntries.length > 0 && g.licenses.length > 1);
  const readyCount = derived.attributions.length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOpenCheck size={19} /></div>
          <div><strong>License Lens</strong><span>贡献归属台账</span></div>
        </div>
        <nav>
          <NavBtn active={tab === 'gaps'} onClick={() => setTab('gaps')} icon={<AlertTriangle size={17} />}
            label="待办缺口" badge={derived.gaps.length} danger />
          <NavBtn active={tab === 'submissions'} onClick={() => setTab('submissions')} icon={<GitCommitHorizontal size={17} />}
            label="提交登记" badge={records.submissions.length} />
          <NavBtn active={tab === 'reviews'} onClick={() => setTab('reviews')} icon={<Scale size={17} />}
            label="冲突复核" badge={conflictGroups.filter(g => g.state === 'conflict').length} danger />
          <NavBtn active={tab === 'contributors'} onClick={() => setTab('contributors')} icon={<Users size={17} />}
            label="贡献者 / CLA" badge={records.contributors.length} />
          <NavBtn active={tab === 'notice'} onClick={() => setTab('notice')} icon={<FolderGit2 size={17} />}
            label="归属声明" badge={readyCount} />
        </nav>
        <div className="sidebar-foot">
          <p className="foot-hint">资料、判定、保存三层分离：<br />重开后自动重算全部缺口。</p>
          <button className="ghost-btn" onClick={loadSample}><RotateCcw size={14} />载入示例</button>
          <button className="ghost-btn" onClick={exportBackup}><FileDown size={14} />导出 JSON 备份</button>
          <label className="ghost-btn file-btn"><FileUp size={14} />恢复备份
            <input type="file" accept="application/json" hidden onChange={e => e.target.files?.[0] && importBackup(e.target.files[0])} />
          </label>
          <button className="ghost-btn danger-text" onClick={clearAll}><Trash2 size={14} />清空台账</button>
        </div>
      </aside>

      <main className="main">
        {tab === 'gaps' && (
          <GapsTab derived={derived} records={records} gapsByKind={gapsByKind} gapMeta={gapMeta} onGo={goGap}
            onOpenNotice={() => setTab('notice')} />
        )}
        {tab === 'submissions' && (
          <SubmissionsTab records={records} contributorMap={contributorMap} derived={derived}
            onNew={() => setDraft(emptyDraft())} onEdit={s => setDraft(structuredClone(s))}
            onDelete={deleteSubmission} onToggleWithdrawn={toggleWithdrawn} />
        )}
        {tab === 'reviews' && (
          <ReviewsTab records={records} conflictGroups={conflictGroups}
            allGroups={derived.groups} decisions={decisions} focusFileKey={focusFileKey}
            onSave={saveReview} onDelete={deleteReview} />
        )}
        {tab === 'contributors' && (
          <ContributorsTab records={records} attributions={derived.attributions}
            onUpsert={upsertContributor} onDelete={deleteContributor} onImportTsv={importClaTsv} />
        )}
        {tab === 'notice' && (
          <NoticeTab records={records} derived={derived} />
        )}
      </main>

      {draft && (
        <SubmissionModal draft={draft} setDraft={setDraft} records={records} onClose={() => setDraft(null)} onSave={saveDraft} />
      )}
      {toast && <div className="toast"><CheckCircle2 size={15} />{toast}</div>}
    </div>
  );
}

/* ---------------- 通用小组件 ---------------- */

function NavBtn(props: { active: boolean; onClick: () => void; icon: ReactElement; label: string; badge?: number; danger?: boolean }) {
  return (
    <button className={`side-link${props.active ? ' active' : ''}`} onClick={props.onClick}>
      {props.icon}{props.label}
      {props.badge !== undefined && props.badge > 0 && <b className={props.danger ? 'bad' : ''}>{props.badge}</b>}
    </button>
  );
}

function Badge(props: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  return <span className={`badge ${props.tone}`}>{props.children}</span>;
}

/* ---------------- 待办缺口 ---------------- */

function GapsTab(props: {
  derived: ReturnType<typeof derive>; records: Records;
  gapsByKind: { kind: Gap['kind']; items: Gap[] }[];
  gapMeta: Record<Gap['kind'], { label: string; icon: ReactElement }>;
  onGo: (g: Gap) => void; onOpenNotice: () => void;
}) {
  const { derived, records, gapsByKind, gapMeta, onGo, onOpenNotice } = props;
  const blockedFiles = new Set(derived.groups.filter(g => g.state !== 'resolved' && g.activeEntries.length > 0).map(g => g.key)).size;
  const unsigned = new Set(derived.attributions
    .filter(a => !records.contributors.find(c => c.id === a.contributorId)?.claSigned)
    .map(a => a.contributorId)).size;
  return (
    <>
      <header className="topbar">
        <div><p className="eyebrow">ATTRIBUTION LEDGER</p><h1>待办缺口</h1>
          <p className="sub">冲突未复核、复核失效、缺条款、未签 CLA 的问题都会在这里汇总，重开不丢。</p></div>
      </header>
      <section className="stats">
        <div className="metric"><small>登记提交</small><b>{records.submissions.length}</b></div>
        <div className="metric"><small>待处理缺口</small><b className={derived.gaps.length ? 'bad' : 'good'}>{derived.gaps.length}</b></div>
        <div className="metric"><small>受阻文件</small><b className={blockedFiles ? 'warn' : ''}>{blockedFiles}</b></div>
        <div className="metric"><small>可进声明归属</small><b className="good">{derived.attributions.length}</b>
          <button className="link-btn" onClick={onOpenNotice}>查看声明 →</button></div>
      </section>
      {gapsByKind.length === 0 ? (
        <div className="panel empty-panel"><CheckCircle2 size={26} /><h3>没有缺口</h3>
          <p>所有文件条款一致、复核有效、贡献者均已签署 CLA，归属可以进入声明。</p></div>
      ) : (
        <div className="gap-stack">
          {gapsByKind.map(({ kind, items }) => (
            <section className="panel" key={kind}>
              <div className="panel-head"><h3>{gapMeta[kind].icon}{gapMeta[kind].label}</h3>
                <Badge tone={kind === 'conflict' || kind === 'reviewStale' ? 'bad' : 'warn'}>{items.length}</Badge></div>
              <div className="gap-list">
                {items.map((g, i) => (
                  <button className="gap-row" key={i} onClick={() => onGo(g)}>
                    {g.repo && <code className="repo-tag">{g.repo}</code>}
                    <span>{g.message}</span><Pencil size={14} className="gap-go" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {unsigned > 0 && <p className="foot-note">另有 {unsigned} 位贡献者的 CLA 尚未签署，其归属暂不建议对外发布。</p>}
    </>
  );
}

/* ---------------- 提交登记 ---------------- */

function SubmissionsTab(props: {
  records: Records; contributorMap: Map<string, Contributor>; derived: ReturnType<typeof derive>;
  onNew: () => void; onEdit: (s: Submission) => void; onDelete: (s: Submission) => void;
  onToggleWithdrawn: (s: Submission, path: string) => void;
}) {
  const { records, contributorMap, onNew, onEdit, onDelete, onToggleWithdrawn } = props;
  return (
    <>
      <header className="topbar">
        <div><p className="eyebrow">SUBMISSIONS</p><h1>提交登记</h1>
          <p className="sub">每次提交记录仓库、提交号、贡献者与文件清单（含许可条款）。</p></div>
        <button className="primary" onClick={onNew}><Plus size={16} />登记提交</button>
      </header>
      {records.submissions.length === 0 ? (
        <div className="panel empty-panel"><GitCommitHorizontal size={26} /><h3>还没有登记</h3>
          <p>点击「登记提交」开始，或在左下角载入示例资料。</p></div>
      ) : (
        <div className="card-stack">
          {records.submissions.map(s => {
            const conflictFiles = s.files.filter(f => !f.withdrawn &&
              props.derived.groupMap.get(fileKey(s.repo, f.path))?.state === 'conflict').length;
            return (
              <section className="panel submission-card" key={s.id}>
                <div className="sub-head">
                  <div className="sub-id">
                    <code className="repo-tag">{s.repo || '（缺仓库）'}</code>
                    <code className="commit">{s.commit || '（缺提交号）'}</code>
                    {conflictFiles > 0 && <Badge tone="bad">{conflictFiles} 文件待复核</Badge>}
                    {(!s.repo || !s.commit || s.contributorIds.length === 0) && <Badge tone="warn">资料不全</Badge>}
                  </div>
                  <div className="row-actions">
                    <button className="icon-btn" onClick={() => onEdit(s)} title="编辑"><Pencil size={15} /></button>
                    <button className="icon-btn danger" onClick={() => onDelete(s)} title="删除"><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="sub-contributors">
                  {s.contributorIds.length === 0
                    ? <span className="muted">未指派贡献者</span>
                    : s.contributorIds.map(id => {
                      const c = contributorMap.get(id);
                      return <span key={id} className="contrib-chip">
                        {c?.name ?? '（已删除）'}
                        {c && !c.claSigned && <i title="未签 CLA" className="dot-warn" />}
                        {c?.claSigned && <i title="已签 CLA" className="dot-ok" />}
                      </span>;
                    })}
                </div>
                <table className="file-table">
                  <thead><tr><th>文件</th><th style={{ width: 180 }}>许可条款</th><th style={{ width: 190 }}>归属状态</th><th style={{ width: 90 }}></th></tr></thead>
                  <tbody>
                    {s.files.map(f => {
                      const g = props.derived.groupMap.get(fileKey(s.repo, f.path));
                      return (
                        <tr key={f.path} className={f.withdrawn ? 'withdrawn' : ''}>
                          <td className="path-cell">{f.path}</td>
                          <td><code>{f.license || '—'}</code></td>
                          <td>
                            {f.withdrawn
                              ? <Badge tone="muted">已撤下 · {fmtTime(f.withdrawnAt)}</Badge>
                              : g?.state === 'conflict'
                                ? <Badge tone="bad">{g.reviewStale ? '复核失效，重审' : '冲突，待复核'}</Badge>
                                : g?.state === 'missingLicense'
                                  ? <Badge tone="warn">缺条款</Badge>
                                  : <Badge tone="ok">计入归属</Badge>}
                          </td>
                          <td className="td-actions">
                            {f.withdrawn
                              ? <button className="mini-btn" onClick={() => onToggleWithdrawn(s, f.path)}>恢复</button>
                              : <button className="mini-btn warn" onClick={() => onToggleWithdrawn(s, f.path)}>撤下</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {s.note && <p className="sub-note">{s.note}</p>}
                <p className="sub-time">登记于 {fmtTime(s.createdAt)}</p>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ---------------- 提交编辑弹窗 ---------------- */

function SubmissionModal(props: {
  draft: Submission; setDraft: (s: Submission) => void; onClose: () => void; onSave: () => void;
  records: Records;
}) {
  const { draft, setDraft, onClose, onSave, records } = props;
  const set = (patch: Partial<Submission>) => setDraft({ ...draft, ...patch });
  const setFile = (i: number, patch: Partial<SubmissionFile>) =>
    set({ files: draft.files.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) });
  const toggleContributor = (id: string) =>
    set({ contributorIds: draft.contributorIds.includes(id)
      ? draft.contributorIds.filter(x => x !== id) : [...draft.contributorIds, id] });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>登记提交</h2><button className="icon-btn" onClick={onClose}><X size={17} /></button></div>
        <div className="form-grid">
          <label>仓库<input value={draft.repo} onChange={e => set({ repo: e.target.value })} placeholder="例如：license-lens/web" /></label>
          <label>提交号<input value={draft.commit} onChange={e => set({ commit: e.target.value })} placeholder="例如：a1b2c3d4" /></label>
        </div>
        <label className="block-label">贡献者（可多选；CLA 状态见「贡献者」页）
          <div className="picker">
            {records.contributors.length === 0 && <span className="muted">还没有贡献者，请先到「贡献者 / CLA」页添加。</span>}
            {records.contributors.map(c => (
              <button key={c.id} type="button"
                className={`pick-chip${draft.contributorIds.includes(c.id) ? ' on' : ''}`}
                onClick={() => toggleContributor(c.id)}>
                {c.name}{c.claSigned ? ' · 已签' : ' · 未签'}
              </button>
            ))}
          </div>
        </label>
        <label className="block-label">文件与许可条款
          <div className="file-editor">
            {draft.files.map((f, i) => {
              const locked = !!f.withdrawn;
              return (
                <div className={`file-row${locked ? ' locked' : ''}`} key={i}>
                  <input value={f.path} disabled={locked}
                    placeholder="路径，例如 src/parser.ts"
                    onChange={e => setFile(i, { path: e.target.value })} />
                  <input value={f.license} disabled={locked} list="license-options"
                    placeholder="许可证，例如 MIT"
                    onChange={e => setFile(i, { license: e.target.value })} />
                  <datalist id="license-options">
                    {['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'CC-BY-4.0'].map(l =>
                      <option key={l} value={l} />)}
                  </datalist>
                  {locked
                    ? <span className="muted">已撤下（在列表页恢复）</span>
                    : <button type="button" className="icon-btn danger"
                        onClick={() => set({ files: draft.files.filter((_, idx) => idx !== i) })}><Trash2 size={15} /></button>}
                </div>
              );
            })}
            <button type="button" className="secondary" onClick={() => set({ files: [...draft.files, { path: '', license: '' }] })}>
              <Plus size={15} />添加文件
            </button>
          </div>
        </label>
        <label className="block-label">备注（不参与复核指纹）
          <input value={draft.note ?? ''} onChange={e => set({ note: e.target.value })} placeholder="可选" />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>取消</button>
          <button className="primary" onClick={onSave}>保存登记</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 冲突复核 ---------------- */

function ReviewsTab(props: {
  records: Records; conflictGroups: FileGroup[]; allGroups: FileGroup[];
  decisions: Decisions; focusFileKey: string | null;
  onSave: (g: FileGroup, license: string, note: string, reviewer: string) => void;
  onDelete: (g: FileGroup) => void;
}) {
  const { conflictGroups, allGroups, focusFileKey, onSave, onDelete, records } = props;
  const decidedGroups = allGroups.filter(g => g.activeEntries.length > 0 && g.licenses.length > 1 && g.state === 'resolved');
  const orphans = props.decisions.reviews.filter(r => !allGroups.some(g => g.key === r.fileKey && g.activeEntries.length > 0));
  const namesOf = (g: FileGroup, ids: string[]) =>
    ids.map(id => records.contributors.find(c => c.id === id)?.name ?? '（已删除）').join('、') || '—';

  return (
    <>
      <header className="topbar">
        <div><p className="eyebrow">CONFLICT REVIEW</p><h1>条款冲突复核</h1>
          <p className="sub">同一文件在不同提交中出现不一致条款时停在这里；复核采用条款后才进入归属声明。</p></div>
      </header>
      {conflictGroups.length === 0 && decidedGroups.length === 0 && orphans.length === 0 && (
        <div className="panel empty-panel"><Scale size={26} /><h3>没有冲突文件</h3>
          <p>登记的文件条款均一致。若后续提交带来不同条款，会自动出现在这里。</p></div>
      )}
      <div className="card-stack">
        {conflictGroups.map(g => (
          <ReviewCard key={g.key} group={g} nameOf={ids => namesOf(g, ids)} focus={focusFileKey === g.key}
            onSave={onSave} onDelete={onDelete} />
        ))}
        {decidedGroups.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h3><CheckCircle2 size={15} />已复核（{decidedGroups.length}）</h3></div>
            {decidedGroups.map(g => (
              <div className="resolved-row" key={g.key}>
                <div><code className="repo-tag">{g.repo}</code><span className="path-text">{g.path}</span></div>
                <div>采用 <code>{g.effectiveLicense}</code>
                  <span className="muted"> · {g.review?.reviewer} · {fmtTime(g.review?.decidedAt)}</span></div>
                <button className="mini-btn" onClick={() => onDelete(g)}>撤销复核</button>
              </div>
            ))}
          </section>
        )}
        {orphans.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h3><TriangleAlert size={15} />失效判定（{orphans.length}）</h3></div>
            {orphans.map(r => (
              <div className="resolved-row" key={r.id}>
                <div><span className="path-text">{r.fileKey}</span></div>
                <div className="muted">文件已全部撤下或提交被删除，该判定不再产生归属</div>
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

function ReviewCard(props: {
  group: FileGroup; nameOf: (ids: string[]) => string; focus: boolean;
  onSave: (g: FileGroup, license: string, note: string, reviewer: string) => void;
  onDelete: (g: FileGroup) => void;
}) {
  const { group: g, nameOf, focus, onSave, onDelete } = props;
  const [license, setLicense] = useState(g.review?.chosenLicense ?? g.licenses[0] ?? '');
  const [note, setNote] = useState(g.review?.note ?? '');
  const [reviewer, setReviewer] = useState(g.review?.reviewer ?? '');

  return (
    <section className={`panel conflict-card${focus ? ' focus' : ''}${g.reviewStale ? ' stale' : ''}`} id={`rv-${g.key}`}>
      <div className="panel-head">
        <h3>{g.reviewStale ? <RotateCcw size={15} /> : <Scale size={15} />}
          <code className="repo-tag">{g.repo}</code>{g.path}</h3>
        <Badge tone="bad">{g.reviewStale ? '复核失效，需重新复核' : '冲突，待复核'}</Badge>
      </div>
      {g.reviewStale && (
        <p className="conflict-alert">提交号或文件清单在复核后发生改动（提交号/文件清单改动即失效），请重新确认采用条款。</p>
      )}
      <table className="evidence-table">
        <thead><tr><th>来源提交</th><th>登记条款</th><th>贡献者</th></tr></thead>
        <tbody>
          {g.activeEntries.map((e, i) => (
            <tr key={i}><td><code>{e.submission.commit.slice(0, 10)}</code></td>
              <td><code>{e.file.license || '（空）'}</code></td>
              <td>{nameOf(e.submission.contributorIds)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="review-form">
        <div className="license-options">
          {g.licenses.map(l => (
            <button key={l} type="button" className={`pick-chip${license === l ? ' on' : ''}`} onClick={() => setLicense(l)}>{l}</button>
          ))}
          <input className="custom-license" value={license} onChange={e => setLicense(e.target.value)}
            placeholder="或填写采用的条款" />
        </div>
        <div className="form-grid">
          <input value={reviewer} onChange={e => setReviewer(e.target.value)} placeholder="复核人" />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="复核依据 / 说明（可选）" />
        </div>
        <div className="modal-actions">
          {g.review && <button className="secondary danger" onClick={() => onDelete(g)}><Trash2 size={14} />删除旧复核</button>}
          <button className="primary" onClick={() => onSave(g, license, note, reviewer)}>
            <CheckCircle2 size={15} />确认采用「{license}」并解除停留</button>
        </div>
      </div>
    </section>
  );
}

/* ---------------- 贡献者 / CLA ---------------- */

function ContributorsTab(props: {
  records: Records; attributions: ReturnType<typeof derive>['attributions'];
  onUpsert: (c: Contributor) => void; onDelete: (c: Contributor) => void;
  onImportTsv: (text: string) => void;
}) {
  const { records, attributions, onUpsert, onDelete, onImportTsv } = props;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tsv, setTsv] = useState('');
  const [editing, setEditing] = useState<Contributor | null>(null);

  const fileCount = (id: string) => new Set(attributions.filter(a => a.contributorId === id).map(a => a.fileKey)).size;
  const add = () => {
    if (!name.trim()) return;
    onUpsert({ id: uid('c'), name: name.trim(), email: email.trim() || undefined, claSigned: false });
    setName(''); setEmail('');
  };

  return (
    <>
      <header className="topbar">
        <div><p className="eyebrow">CONTRIBUTORS &amp; CLA</p><h1>贡献者 / CLA</h1>
          <p className="sub">CLA 签署情况散在表格里时，可在此逐条登记或整表粘贴导入；归属中的未签署者会进缺口。</p></div>
      </header>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head"><h3><Users size={15} />贡献者名录（{records.contributors.length}）</h3></div>
          {records.contributors.length === 0 && <p className="muted">暂无贡献者。</p>}
          <table className="file-table">
            <thead><tr><th>姓名</th><th>邮箱</th><th>CLA</th><th>归属文件</th><th></th></tr></thead>
            <tbody>
              {records.contributors.map(c => (
                <tr key={c.id}>
                  <td>{c.name}{c.claNote && <small className="cla-note"> {c.claNote}</small>}</td>
                  <td className="muted">{c.email ?? '—'}</td>
                  <td>{c.claSigned
                    ? <Badge tone="ok">已签署</Badge>
                    : <Badge tone="warn">未签署</Badge>}</td>
                  <td>{fileCount(c.id)}</td>
                  <td className="td-actions">
                    <button className="mini-btn" onClick={() => onUpsert({ ...c, claSigned: !c.claSigned })}>
                      {c.claSigned ? '标记未签' : '标记已签'}
                    </button>
                    <button className="mini-btn" onClick={() => setEditing(c)}><Pencil size={13} /></button>
                    <button className="mini-btn warn" onClick={() => onDelete(c)}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inline-add">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="新贡献者姓名" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱（可选）" />
            <button className="primary" onClick={add}><Plus size={15} />添加</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h3><Upload size={15} />粘贴 CLA 表格</h3></div>
          <p className="hint">支持 TSV/CSV。首行可为表头（含 姓名/name、邮箱/email、CLA/签署、备注 列）；
            无表头时按 <code>姓名, 邮箱, 是否签署, 备注</code> 顺序解析。签署列填 <code>已签 / signed / 1 / yes</code>。</p>
          <textarea className="textarea" rows={8} value={tsv} onChange={e => setTsv(e.target.value)}
            placeholder={'姓名\t邮箱\tCLA\t备注\n陈一帆\tchen@example.com\t已签\t2026-03 表格登记'} />
          <button className="primary" style={{ marginTop: 10 }}
            onClick={() => { onImportTsv(tsv); setTsv(''); }} disabled={!tsv.trim()}>导入表格</button>
        </section>
      </div>
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h2>编辑贡献者</h2><button className="icon-btn" onClick={() => setEditing(null)}><X size={17} /></button></div>
            <label className="block-label">姓名<input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="block-label">邮箱<input value={editing.email ?? ''} onChange={e => setEditing({ ...editing, email: e.target.value })} /></label>
            <label className="block-label">CLA 备注<input value={editing.claNote ?? ''} onChange={e => setEditing({ ...editing, claNote: e.target.value })} placeholder="如：2026-03 表格登记" /></label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={() => { onUpsert(editing); setEditing(null); }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- 归属声明 ---------------- */

function NoticeTab(props: { records: Records; derived: ReturnType<typeof derive> }) {
  const { records, derived } = props;
  const [onlySigned, setOnlySigned] = useState(false);
  const markdown = useMemo(
    () => buildNoticeMarkdown(records, derived, !onlySigned),
    [records, derived, onlySigned]);
  const blockedCount = derived.groups.filter(g => g.state !== 'resolved' && g.activeEntries.length > 0).length;

  return (
    <>
      <header className="topbar">
        <div><p className="eyebrow">NOTICE GENERATOR</p><h1>归属声明</h1>
          <p className="sub">仅收录条款已确定（一致或复核完成）的文件；冲突未清的文件不会出现，避免漏人或错条。</p></div>
        <div className="top-actions">
          <label className="check-line"><input type="checkbox" checked={onlySigned} onChange={e => setOnlySigned(e.target.checked)} />
            仅含已签 CLA</label>
          <button className="primary" onClick={() => downloadFile('NOTICE.md', markdown, 'text/markdown')}>
            <FileDown size={16} />导出 Markdown</button>
        </div>
      </header>
      {blockedCount > 0 && (
        <div className="notice-banner"><AlertTriangle size={16} />
          {blockedCount} 个文件因条款冲突或缺条款被排除；处理完缺口后再导出，声明才完整。</div>
      )}
      <div className="two-col notice-cols">
        <section className="panel">
          <div className="panel-head"><h3><ClipboardList size={15} />归属明细（{derived.attributions.length}）</h3></div>
          <table className="file-table">
            <thead><tr><th>仓库</th><th>文件</th><th>贡献者</th><th>条款</th></tr></thead>
            <tbody>
              {derived.attributions.map(a => {
                const c = records.contributors.find(x => x.id === a.contributorId);
                return (
                  <tr key={`${a.contributorId}::${a.fileKey}`}>
                    <td className="muted">{a.repo}</td>
                    <td className="path-cell">{a.path}</td>
                    <td>{c?.name ?? '（已删除）'}
                      {c && !c.claSigned && <Badge tone="warn">CLA 未签</Badge>}</td>
                    <td><code>{a.license}</code></td>
                  </tr>
                );
              })}
              {derived.attributions.length === 0 && (
                <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 22 }}>
                  暂无可用归属——先去登记提交并处理缺口。</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <div className="panel-head"><h3><FileDown size={15} />声明预览（Markdown）</h3></div>
          <pre className="markdown-preview">{markdown}</pre>
          <button className="secondary" style={{ marginTop: 10 }}
            onClick={() => navigator.clipboard?.writeText(markdown)}>复制全文</button>
        </section>
      </div>
    </>
  );
}
