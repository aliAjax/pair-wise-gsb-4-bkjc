import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BookLock, CheckCircle2, ClipboardList, Download, FileWarning,
  FolderGit2, GitCommitHorizontal, Inbox, Pencil, Plus, RotateCcw, Scale,
  ShieldCheck, Trash2, Upload, Users, X,
} from 'lucide-react';
import type {
  Contributor, FileClaim, Gap, LedgerState, Submission,
} from './types';
import {
  buildAttributions, fileGroupKey, findGaps, groupFiles, uid,
} from './engine';
import { exportJSON, importJSON, loadState, resetState, saveState } from './storage';
import { buildNoticeMarkdown } from './notice';

type View = 'dashboard' | 'submissions' | 'contributors' | 'reviews' | 'notice';

const navItems: { key: View; label: string; icon: typeof Inbox }[] = [
  { key: 'dashboard', label: '缺口概览', icon: AlertTriangle },
  { key: 'submissions', label: '提交记录', icon: GitCommitHorizontal },
  { key: 'contributors', label: '贡献者 · CLA', icon: Users },
  { key: 'reviews', label: '复核中心', icon: Scale },
  { key: 'notice', label: '归属声明', icon: BookLock },
];

export default function App() {
  const [state, setState] = useState<LedgerState>(() => loadState());
  const [view, setView] = useState<View>('dashboard');
  const [editingSub, setEditingSub] = useState<Submission | null>(null);
  const [editingPerson, setEditingPerson] = useState<Contributor | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ repo: string; path: string } | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => saveState(state), [state]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const groups = useMemo(() => groupFiles(state), [state]);
  const gaps = useMemo(() => findGaps(state), [state]);
  const attributions = useMemo(() => buildAttributions(state), [state]);
  const conflicts = groups.filter(g => g.conflicting);
  const person = (id: string) => state.contributors.find(c => c.id === id);
  const gapCountByView = (v: View) =>
    v === 'reviews'
      ? gaps.filter(g => g.kind === 'conflict-open' || g.kind === 'review-stale').length
      : v === 'contributors'
        ? gaps.filter(g => g.kind === 'cla-unsigned').length
        : 0;

  const patch = (fn: (draft: LedgerState) => void) =>
    setState(prev => {
      const draft: LedgerState = structuredClone(prev);
      fn(draft);
      return draft;
    });

  const saveSubmission = (sub: Submission) => patch(d => {
    const i = d.submissions.findIndex(s => s.id === sub.id);
    if (i >= 0) d.submissions[i] = sub;
    else d.submissions.unshift(sub);
    setToast('提交已保存；若改动涉及冲突文件，对应复核会自动失效');
  });

  const deleteSubmission = (id: string) => patch(d => {
    d.submissions = d.submissions.filter(s => s.id !== id);
  });

  const toggleWithdraw = (subId: string, fileId: string) => patch(d => {
    const sub = d.submissions.find(s => s.id === subId);
    const f = sub?.files.find(x => x.id === fileId);
    if (!f) return;
    f.withdrawn = !f.withdrawn;
    if (f.withdrawn) {
      f.withdrawnAt = new Date().toISOString();
      // 撤回后该组若不再冲突（或已无在档文件），对应的旧复核不再有意义，一并清掉
      const stillConflicting = groupFiles(d).some(
        g => g.key === fileGroupKey(sub!.repo, f.path) && g.conflicting);
      if (!stillConflicting) {
        d.reviews = d.reviews.filter(r => fileGroupKey(r.repo, r.path) !== fileGroupKey(sub!.repo, f.path));
      }
      setToast('该文件产生的归属已撤回；贡献者名下其他文件的归属保留');
    } else {
      f.withdrawnAt = undefined;
      f.withdrawnReason = undefined;
      setToast('文件已恢复，归属重新计入（若与其他条款冲突需重新复核）');
    }
  });

  const savePerson = (p: Contributor) => patch(d => {
    const i = d.contributors.findIndex(c => c.id === p.id);
    if (i >= 0) d.contributors[i] = p;
    else d.contributors.push(p);
    setToast('贡献者资料已保存');
  });

  const deletePerson = (id: string) => patch(d => {
    d.contributors = d.contributors.filter(c => c.id !== id);
  });

  const saveReview = (repo: string, path: string, chosenLicense: string, reviewer: string, note: string) =>
    patch(d => {
      const g = groupFiles(d).find(x => x.key === fileGroupKey(repo, path));
      if (!g) return;
      d.reviews = d.reviews.filter(r => fileGroupKey(r.repo, r.path) !== g.key);
      d.reviews.push({
        id: uid(), repo, path, groupSig: g.groupSig,
        chosenLicense, reviewer: reviewer.trim() || '未署名复核人',
        note: note.trim() || undefined, reviewedAt: new Date().toISOString(),
      });
      setToast('复核完成，文件已按裁定条款进入归属声明');
    });

  const dropReview = (repo: string, path: string) => patch(d => {
    d.reviews = d.reviews.filter(r => fileGroupKey(r.repo, r.path) !== fileGroupKey(repo, path));
    setToast('复核记录已撤回，文件回到待复核状态');
  });

  const onImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = importJSON(String(reader.result));
        setState(next);
        setToast('台账已导入');
      } catch (e) {
        setToast(e instanceof Error ? e.message : '导入失败');
      }
    };
    reader.readAsText(file);
  };

  const liveFilesCount = state.submissions.reduce((n, s) => n + s.files.filter(f => !f.withdrawn).length, 0);
  const withdrawnCount = state.submissions.reduce((n, s) => n + s.files.filter(f => f.withdrawn).length, 0);

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Scale size={18} /></div>
        <div><strong>License Lens</strong><span>贡献归属台账</span></div>
      </div>
      <nav>
        {navItems.map(n => (
          <button key={n.key} className={view === n.key ? 'nav active' : 'nav'} onClick={() => setView(n.key)}>
            <n.icon size={16} />
            {n.label}
            {gapCountByView(n.key) > 0 && <b className="nav-badge">{gapCountByView(n.key)}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className="nav" onClick={() => { const f = document.createElement('input'); f.type = 'file'; f.accept = '.json'; f.onchange = () => f.files?.[0] && onImport(f.files[0]); f.click(); }}>
          <Upload size={16} />导入台账 JSON
        </button>
        <button className="nav" onClick={() => { exportJSON(state); setToast('台账 JSON 已导出'); }}>
          <Download size={16} />导出台账 JSON
        </button>
        <button className="nav danger-text" onClick={() => { if (confirm('恢复为示例资料？当前台账会被覆盖（建议先导出备份）。')) { setState(resetState()); setToast('已恢复示例资料'); } }}>
          <RotateCcw size={16} />恢复示例
        </button>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div>
          <p className="eyebrow">ATTRIBUTION LEDGER</p>
          <h1>{navItems.find(n => n.key === view)?.label}</h1>
        </div>
        {view === 'submissions' && (
          <button className="primary" onClick={() => setEditingSub(blankSubmission(state.contributors[0]?.id ?? ''))}>
            <Plus size={16} />登记提交
          </button>
        )}
        {view === 'contributors' && (
          <button className="primary" onClick={() => setEditingPerson({ id: uid(), name: '', email: '', claSigned: false })}>
            <Plus size={16} />新增贡献者
          </button>
        )}
      </header>

      {view === 'dashboard' && (
        <Dashboard
          state={state} gaps={gaps} conflicts={conflicts.length}
          liveFiles={liveFilesCount} withdrawn={withdrawnCount}
          attributions={attributions.length}
          onJump={setView}
          onOpenReview={(repo, path) => setReviewTarget({ repo, path })}
        />
      )}

      {view === 'submissions' && (
        <SubmissionsView state={state} onEdit={setEditingSub} onDelete={deleteSubmission} onToggleWithdraw={toggleWithdraw} />
      )}

      {view === 'contributors' && (
        <ContributorsView state={state} onEdit={setEditingPerson} onDelete={deletePerson} />
      )}

      {view === 'reviews' && (
        <ReviewsView
          groups={conflicts} person={person}
          onOpen={(repo, path) => setReviewTarget({ repo, path })}
          onDrop={dropReview}
        />
      )}

      {view === 'notice' && (
        <NoticeView state={state} attributions={attributions.length} gaps={gaps.length} />
      )}
    </main>

    {editingSub && (
      <SubmissionModal
        state={state} initial={editingSub}
        onClose={() => setEditingSub(null)}
        onSave={(s) => { saveSubmission(s); setEditingSub(null); }}
      />
    )}
    {editingPerson && (
      <PersonModal
        initial={editingPerson}
        onClose={() => setEditingPerson(null)}
        onSave={(p) => { savePerson(p); setEditingPerson(null); }}
      />
    )}
    {reviewTarget && (
      <ReviewModal
        key={fileGroupKey(reviewTarget.repo, reviewTarget.path)}
        state={state} repo={reviewTarget.repo} path={reviewTarget.path}
        onClose={() => setReviewTarget(null)}
        onSave={(lic, who, note) => {
          saveReview(reviewTarget.repo, reviewTarget.path, lic, who, note);
          setReviewTarget(null);
        }}
      />
    )}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function blankSubmission(contributorId: string): Submission {
  return { id: uid(), repo: '', commit: '', contributorId, message: '', createdAt: new Date().toISOString(), files: [blankFile()] };
}
function blankFile(): FileClaim {
  return { id: uid(), path: '', license: '', withdrawn: false };
}

/* ---------------- 缺口概览 ---------------- */

function Dashboard(props: {
  state: LedgerState; gaps: Gap[]; conflicts: number;
  liveFiles: number; withdrawn: number; attributions: number;
  onJump: (v: View) => void;
  onOpenReview: (repo: string, path: string) => void;
}) {
  const { gaps, conflicts, liveFiles, withdrawn, attributions, onJump, onOpenReview } = props;
  const stats = [
    { label: '在档文件归属', value: liveFiles, icon: FolderGit2, tone: '' },
    { label: '条款冲突待处理', value: conflicts, icon: Scale, tone: conflicts ? 'bad' : 'good' },
    { label: '已撤下文件', value: withdrawn, icon: FileWarning, tone: 'muted' },
    { label: '可进声明条目', value: attributions, icon: ShieldCheck, tone: attributions ? 'good' : '' },
  ];
  return <>
    <section className="stat-grid">
      {stats.map(s => (
        <div key={s.label} className="stat-card">
          <s.icon size={17} />
          <div><b className={s.tone}>{s.value}</b><span>{s.label}</span></div>
        </div>
      ))}
    </section>

    <section className="panel">
      <div className="panel-head">
        <h2>待补缺口</h2>
        <span className="hint">资料、判定、保存分开存放；重开后按当前资料重算，缺口不会被旧状态掩盖</span>
      </div>
      {gaps.length === 0 ? (
        <div className="empty-good"><CheckCircle2 size={18} />没有缺口：在档文件条款一致、CLA 齐备，归属声明已可发布。</div>
      ) : (
        <ul className="gap-list">
          {gaps.map((g, i) => (
            <li key={i} className={`gap ${g.kind}`}>
              <GapIcon kind={g.kind} />
              <div>
                <strong>{g.label}</strong>
                <p>{g.detail}</p>
              </div>
              {(g.kind === 'conflict-open' || g.kind === 'review-stale') && g.target?.repo && g.target?.path && (
                <button className="secondary" onClick={() => onOpenReview(g.target!.repo!, g.target!.path!)}>去复核</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>

    <section className="panel">
      <div className="panel-head"><h2>工作规则</h2></div>
      <ol className="rules">
        <li><b>登记：</b>每条提交记仓库、提交号、贡献者、文件清单及各文件许可条款；CLA 在“贡献者 · CLA”里单独签记。</li>
        <li><b>拦截：</b>同一仓库、同一路径出现两个不同条款时自动标为冲突，<em>暂停进入归属声明</em>，经复核裁定后才放行。</li>
        <li><b>失效：</b>提交号或文件清单（路径、条款、增删）一旦改动，原复核指纹对不上即自动失效，需重新复核。</li>
        <li><b>撤下：</b>撤下文件只撤回该文件产生的归属；贡献者名下还有其他在档文件时，署名继续保留。</li>
      </ol>
      <div className="rule-links">
        <button className="link-btn" onClick={() => onJump('submissions')}>登记/修改提交 →</button>
        <button className="link-btn" onClick={() => onJump('reviews')}>处理条款冲突 →</button>
        <button className="link-btn" onClick={() => onJump('notice')}>查看归属声明 →</button>
      </div>
    </section>
  </>;
}

function GapIcon({ kind }: { kind: Gap['kind'] }) {
  const cls = kind === 'conflict-open' ? 'bad' : kind === 'review-stale' ? 'warn' : kind === 'cla-unsigned' ? 'warn' : '';
  return <span className={`gap-ico ${cls}`}>{kind === 'cla-unsigned' ? <Users size={15} /> : <AlertTriangle size={15} />}</span>;
}

/* ---------------- 提交记录 ---------------- */

function SubmissionsView(props: {
  state: LedgerState;
  onEdit: (s: Submission) => void;
  onDelete: (id: string) => void;
  onToggleWithdraw: (subId: string, fileId: string) => void;
}) {
  const { state, onEdit, onDelete, onToggleWithdraw } = props;
  if (state.submissions.length === 0)
    return <div className="panel"><div className="empty-good">还没有提交记录，点右上角“登记提交”开始建台账。</div></div>;
  return <div className="card-list">
    {state.submissions.map(s => {
      const p = state.contributors.find(c => c.id === s.contributorId);
      return <section key={s.id} className="panel submission">
        <div className="sub-head">
          <div className="sub-title">
            <span className="repo-chip"><FolderGit2 size={13} />{s.repo || <em>缺仓库</em>}</span>
            <code className="commit">{s.commit || '缺提交号'}</code>
            <span className={p?.claSigned ? 'person ok' : 'person warn'}>
              <Users size={13} />{p?.name || '未知贡献者'}{p && !p.claSigned && ' · CLA 未签'}
            </span>
          </div>
          <div className="row-actions">
            <button className="icon-btn" title="编辑（改动提交号/文件会使复核失效）" onClick={() => onEdit(s)}><Pencil size={15} /></button>
            <button className="icon-btn" title="删除整条提交" onClick={() => { if (confirm('删除这条提交及其全部文件归属？')) onDelete(s.id); }}><Trash2 size={15} /></button>
          </div>
        </div>
        {s.message && <p className="sub-msg">{s.message}</p>}
        <ul className="file-list">
          {s.files.map(f => (
            <li key={f.id} className={f.withdrawn ? 'file withdrawn' : 'file'}>
              <code className="path">{f.path || <em>缺路径</em>}</code>
              <span className="license-tag">{f.license || <em>缺条款</em>}</span>
              {f.withdrawn && <span className="withdrawn-tag">已撤下{f.withdrawnAt ? ` · ${f.withdrawnAt.slice(0, 10)}` : ''}</span>}
              <button className="link-btn" onClick={() => onToggleWithdraw(s.id, f.id)}>
                {f.withdrawn ? '恢复' : '撤下'}
              </button>
            </li>
          ))}
        </ul>
      </section>;
    })}
  </div>;
}

/* ---------------- 贡献者 / CLA ---------------- */

function ContributorsView(props: {
  state: LedgerState;
  onEdit: (p: Contributor) => void;
  onDelete: (id: string) => void;
}) {
  const { state, onEdit, onDelete } = props;
  const counts = new Map<string, { live: number; withdrawn: number }>();
  for (const s of state.submissions) {
    const cur = counts.get(s.contributorId) ?? { live: 0, withdrawn: 0 };
    for (const f of s.files) f.withdrawn ? cur.withdrawn++ : cur.live++;
    counts.set(s.contributorId, cur);
  }
  return <div className="card-grid">
    {state.contributors.map(c => {
      const n = counts.get(c.id) ?? { live: 0, withdrawn: 0 };
      return <section key={c.id} className="panel person-card">
        <div className="person-top">
          <div className="avatar">{c.name.slice(0, 1).toUpperCase() || '?'}</div>
          <div>
            <strong>{c.name || '（未命名）'}</strong>
            <span>{c.email || '未登记邮箱'}</span>
          </div>
          <div className="row-actions">
            <button className="icon-btn" onClick={() => onEdit(c)}><Pencil size={15} /></button>
            <button className="icon-btn" onClick={() => { if (confirm('删除该贡献者档案？历史提交会标记为贡献者缺失。')) onDelete(c.id); }}><Trash2 size={15} /></button>
          </div>
        </div>
        <div className={c.claSigned ? 'cla-badge ok' : 'cla-badge warn'}>
          {c.claSigned ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
          {c.claSigned ? `CLA 已签署${c.claSignedAt ? ` · ${c.claSignedAt}` : ''}` : 'CLA 未签署'}
        </div>
        <p className="hint">
          在档文件 {n.live} 个{n.withdrawn > 0 && `；另有 ${n.withdrawn} 个已撤下（不影响保留中的归属）`}
          {n.live === 0 && '，当前不产生归属署名'}
        </p>
      </section>;
    })}
    {state.contributors.length === 0 && <div className="panel"><div className="empty-good">还没有贡献者，点右上角新增。</div></div>}
  </div>;
}

/* ---------------- 复核中心 ---------------- */

function ReviewsView(props: {
  groups: ReturnType<typeof groupFiles>;
  person: (id: string) => Contributor | undefined;
  onOpen: (repo: string, path: string) => void;
  onDrop: (repo: string, path: string) => void;
}) {
  const { groups, person, onOpen, onDrop } = props;
  return <div className="card-list">
    {groups.length === 0 && (
      <section className="panel"><div className="empty-good"><CheckCircle2 size={18} />当前没有条款冲突。同一文件出现两种不同条款时会自动列到这里并暂停进入声明。</div></section>
    )}
    {groups.map(g => {
      const fresh = g.review && g.reviewFresh;
      return <section key={g.key} className="panel conflict">
        <div className="conflict-top">
          <div>
            <h3><code>{g.path}</code></h3>
            <span className="repo-chip"><FolderGit2 size={13} />{g.repo}</span>
          </div>
          {fresh
            ? <span className="status-pill ok"><CheckCircle2 size={14} />已复核 · 采用 {g.review!.chosenLicense}</span>
            : <span className="status-pill bad"><AlertTriangle size={14} />{g.review ? '复核已失效' : '待复核 · 已暂停进入声明'}</span>}
        </div>
        <ul className="claim-list">
          {g.claims.map(c => (
            <li key={c.submissionId + c.file.id}>
              <span className={person(c.contributorId)?.claSigned ? 'person ok' : 'person warn'}>
                <Users size={13} />{person(c.contributorId)?.name ?? '未知贡献者'}
              </span>
              <code className="commit">{c.commit}</code>
              <span className="license-tag">{c.file.license}</span>
            </li>
          ))}
        </ul>
        {g.review && (
          <p className="review-note">
            复核人：{g.review.reviewer} · {g.review.reviewedAt.slice(0, 10)}
            {g.review.note ? ` · ${g.review.note}` : ''}
            {!g.reviewFresh && <em>（提交号或文件清单改动后指纹已变化，此结论失效）</em>}
          </p>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={() => onOpen(g.repo, g.path)}>
            {fresh ? '重新复核' : g.review ? '重新复核（原结论已失效）' : '开始复核'}
          </button>
          {g.review && <button className="secondary" onClick={() => onDrop(g.repo, g.path)}>撤回复核</button>}
        </div>
      </section>;
    })}
  </div>;
}

/* ---------------- 归属声明 ---------------- */

function NoticeView(props: { state: LedgerState; attributions: number; gaps: number }) {
  const { state, attributions, gaps } = props;
  const md = useMemo(() => buildNoticeMarkdown(state), [state]);
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = 'NOTICE.md';
    a.click();
  };
  return <>
    <section className="panel">
      <div className="panel-head">
        <h2>NOTICE 预览</h2>
        <div className="row-actions">
          <button className="secondary" onClick={() => { navigator.clipboard?.writeText(md); }}>复制</button>
          <button className="primary" onClick={download}><Download size={15} />下载 NOTICE.md</button>
        </div>
      </div>
      {gaps > 0 && (
        <div className="banner warn">
          <AlertTriangle size={15} />
          尚有 {gaps} 项缺口；其中条款冲突未复核的文件不会出现在声明中，撤下文件的归属也已自动排除。
        </div>
      )}
      <div className="notice-meta">共 {attributions} 条归属，按仓库、贡献者归并；未被复核采用的条款保留在复核记录中可追溯。</div>
      <pre className="notice-preview">{md}</pre>
    </section>
  </>;
}

/* ---------------- 弹窗：提交 ---------------- */

function SubmissionModal(props: {
  state: LedgerState; initial: Submission;
  onClose: () => void; onSave: (s: Submission) => void;
}) {
  const { state, initial, onClose, onSave } = props;
  const [sub, setSub] = useState<Submission>(structuredClone(initial));
  const update = (patch2: Partial<Submission>) => setSub(s => ({ ...s, ...patch2 }));
  const updateFile = (id: string, p: Partial<FileClaim>) =>
    setSub(s => ({ ...s, files: s.files.map(f => f.id === id ? { ...f, ...p } : f) }));
  const valid = sub.repo.trim() && sub.commit.trim() && sub.contributorId &&
    sub.files.every(f => (!f.path.trim() && !f.license.trim()) || (f.path.trim() && f.license.trim()));

  return <Modal title={state.submissions.some(s => s.id === initial.id) ? '编辑提交' : '登记提交'} onClose={onClose} wide>
    <div className="form-grid">
      <label>仓库<input value={sub.repo} onChange={e => update({ repo: e.target.value })} placeholder="如 web/portal" /></label>
      <label>提交号<input value={sub.commit} onChange={e => update({ commit: e.target.value })} placeholder="如 a1b2c3d" className="mono" /></label>
    </div>
    <label>贡献者
      <select value={sub.contributorId} onChange={e => update({ contributorId: e.target.value })}>
        <option value="">请选择…</option>
        {state.contributors.map(c => <option key={c.id} value={c.id}>{c.name}{c.claSigned ? '' : '（CLA 未签）'}</option>)}
      </select>
    </label>
    <label>提交说明（可选）<input value={sub.message ?? ''} onChange={e => update({ message: e.target.value })} /></label>

    <div className="file-editor-head">
      <span>文件清单与许可条款</span>
      <button className="link-btn" onClick={() => setSub(s => ({ ...s, files: [...s.files, blankFile()] }))}><Plus size={13} />添加文件</button>
    </div>
    <div className="file-editor">
      {sub.files.map((f, i) => (
        <div key={f.id} className="file-row">
          <input value={f.path} onChange={e => updateFile(f.id, { path: e.target.value })} placeholder="文件路径，如 src/auth/validate.ts" />
          <input className="mono license-input" value={f.license} onChange={e => updateFile(f.id, { license: e.target.value })} placeholder="MIT" list="license-options" />
          <datalist id="license-options">
            {['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'ISC', 'MPL-2.0', 'CC-BY-4.0'].map(l => <option key={l} value={l} />)}
          </datalist>
          <button className="icon-btn" onClick={() => setSub(s => ({ ...s, files: s.files.length === 1 ? s.files : s.files.filter(x => x.id !== f.id) }))}>
            <X size={15} />
          </button>
          {i === 0 && <span className="sr-only" />}
        </div>
      ))}
    </div>
    <p className="hint">改动提交号、文件路径或许可条款后，与该文件相关的既有复核会自动标记失效，需要重新裁定。</p>
    <div className="modal-actions">
      <button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={!valid} onClick={() => onSave({
        ...sub,
        files: sub.files.filter(f => f.path.trim() || f.license.trim()),
      })}>保存提交</button>
    </div>
  </Modal>;
}

/* ---------------- 弹窗：贡献者 ---------------- */

function PersonModal(props: { initial: Contributor; onClose: () => void; onSave: (p: Contributor) => void }) {
  const { initial, onClose, onSave } = props;
  const [p, setP] = useState<Contributor>(structuredClone(initial));
  return <Modal title="贡献者资料" onClose={onClose}>
    <label>姓名<input value={p.name} onChange={e => setP({ ...p, name: e.target.value })} placeholder="如 Ada Chen" /></label>
    <label>邮箱（可选）<input value={p.email ?? ''} onChange={e => setP({ ...p, email: e.target.value })} placeholder="name@example.com" /></label>
    <label className="check-row">
      <input type="checkbox" checked={p.claSigned} onChange={e => setP({
        ...p, claSigned: e.target.checked,
        claSignedAt: e.target.checked ? (p.claSignedAt ?? new Date().toISOString().slice(0, 10)) : undefined,
      })} />
      已签署 CLA（贡献者许可协议）
    </label>
    {p.claSigned && <label>签署日期<input type="date" value={p.claSignedAt ?? ''} onChange={e => setP({ ...p, claSignedAt: e.target.value })} /></label>}
    <div className="modal-actions">
      <button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={!p.name.trim()} onClick={() => onSave(p)}>保存</button>
    </div>
  </Modal>;
}

/* ---------------- 弹窗：复核 ---------------- */

function ReviewModal(props: {
  state: LedgerState; repo: string; path: string;
  onClose: () => void;
  onSave: (chosenLicense: string, reviewer: string, note: string) => void;
}) {
  const { state, repo, path, onClose, onSave } = props;
  const g = groupFiles(state).find(x => x.key === fileGroupKey(repo, path));
  const [license, setLicense] = useState(g?.review?.chosenLicense ?? g?.licenses[0] ?? '');
  const [reviewer, setReviewer] = useState(g?.review?.reviewer ?? '');
  const [note, setNote] = useState(g?.review?.note ?? '');
  if (!g) return null;
  const stale = g.review && !g.reviewFresh;
  return <Modal title="条款冲突复核" onClose={onClose}>
    <div className="review-file"><FolderGit2 size={15} /><span>{g.repo}</span><code>{g.path}</code></div>
    {stale && <div className="banner warn"><AlertTriangle size={15} />提交号或文件清单已改动，原复核指纹失效，请按当前资料重新裁定。</div>}
    <div className="review-claims">
      {g.claims.map(c => {
        const who = state.contributors.find(x => x.id === c.contributorId);
        return <div key={c.submissionId + c.file.id} className="review-claim-row">
          <span>{who?.name ?? '未知贡献者'}</span>
          <code>{c.commit}</code>
          <b>{c.file.license}</b>
        </div>;
      })}
    </div>
    <label>裁定采用的条款
      <select value={license} onChange={e => setLicense(e.target.value)}>
        {g.licenses.map(l => <option key={l} value={l}>{l}</option>)}
      </select>
    </label>
    <p className="hint">所有在档贡献者都会保留署名并统一采用裁定条款；未采用的条款留存在复核记录中可追溯。</p>
    <label>复核人<input value={reviewer} onChange={e => setReviewer(e.target.value)} placeholder="姓名或工号" /></label>
    <label>复核说明（可选）<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="依据、沟通结论等" rows={3} /></label>
    <div className="modal-actions">
      <button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={!license} onClick={() => onSave(license, reviewer, note)}>完成复核并进声明</button>
    </div>
  </Modal>;
}

/* ---------------- 通用弹窗 ---------------- */

function Modal(props: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return <div className="backdrop" onClick={props.onClose}>
    <div className={props.wide ? 'modal wide' : 'modal'} onClick={e => e.stopPropagation()}>
      <div className="modal-head">
        <h2>{props.title}</h2>
        <button className="icon-btn" onClick={props.onClose}><X size={17} /></button>
      </div>
      {props.children}
    </div>
  </div>;
}
