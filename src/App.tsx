import { useMemo, useState } from 'react';
import { parseDataset, type ParseIssue } from './engine/normalize';
import { DEFAULT_CONTRACT, reconcile } from './engine/reconcile';
import { evaluate, type EvalResult } from './engine/evaluate';
import type {
  AiRun, AnswerKey, Dataset, FeeContract, Mode, ReconResult, RecException, Severity,
} from './engine/types';
import answerKeyJson from './sample/answer-key.json';
import aiRunJson from './sample/ai-run.json';

const SAMPLE_KEY = answerKeyJson as AnswerKey;
const SAMPLE_AI = aiRunJson as AiRun | null;
const USD_INR = 88; // display only, approximate
// Set this to your public repo URL before deploying.
const REPO_URL = 'https://github.com/maushook/settlematch';

const inr = (n: number, dp = 0) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const MODE_LABEL: Record<Mode, string> = { rules: 'Exact rules', heuristic: 'Rules + heuristics', ai: 'Rules + heuristics + AI' };
const SEV_LABEL: Record<Severity, string> = { loss: 'Money at risk', liability: 'Owed to customers', review: 'Needs review' };
const METHOD_LABEL: Record<string, string> = {
  'rule:payment_ref': 'Rule: payment ref', 'rule:order_receipt': 'Rule: order receipt', 'rule:utr': 'Rule: UTR',
  heuristic: 'Heuristic', ai: 'AI',
};

type Source = { kind: 'sample' | 'upload'; name: string; data: Dataset };

export default function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [contract, setContract] = useState<FeeContract>(DEFAULT_CONTRACT);
  const [aiRun, setAiRun] = useState<(AiRun & { live?: boolean }) | null>(null);
  const [mode, setMode] = useState<Mode>('heuristic');
  const [showUpload, setShowUpload] = useState(false);

  async function runSample() {
    setLoading(true); setIssues([]);
    const get = (f: string) => fetch(`/sample/${f}`).then((r) => r.text());
    const [orders, gateway, bank] = await Promise.all([get('shopify_orders.csv'), get('razorpay_settlement_report.csv'), get('bank_statement.csv')]);
    const { data, issues } = parseDataset({ orders, gateway, bank });
    setIssues(issues);
    setSource({ kind: 'sample', name: 'Kalakriti Home, September 2026 (synthetic)', data });
    setAiRun(SAMPLE_AI);
    setMode(SAMPLE_AI ? 'ai' : 'heuristic');
    setLoading(false);
    requestAnimationFrame(() => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function runUpload(files: { orders: string; gateway: string; bank: string }) {
    const { data, issues } = parseDataset(files);
    setIssues(issues);
    if (issues.length) return;
    setSource({ kind: 'upload', name: 'Your files', data });
    setAiRun(null);
    setMode('heuristic');
    requestAnimationFrame(() => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }));
  }

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/"><span className="brand-mark">₹</span> SettleMatch</a>
        <nav className="top-nav" aria-label="Main">
          <a className="top-link" href="/why">Why it matters</a>
          {REPO_URL && <a className="top-link" href={REPO_URL} target="_blank" rel="noreferrer">Source</a>}
        </nav>
      </header>

      <section className="hero">
        <h1>Shopify says one number. Your bank says another. SettleMatch explains the difference, rupee by rupee.</h1>
        <p className="lede">
          Upload your Shopify orders, Razorpay settlement report and bank statement. Exact rules match what they can,
          scored heuristics take the clear cases, and AI decides only the messy leftovers. Every gap comes back typed,
          sized in rupees and explained.
        </p>
        <div className="cta-row">
          <button className="btn primary" onClick={runSample} disabled={loading}>
            {loading ? 'Reconciling…' : 'Run on sample data'}
          </button>
          <button className="btn ghost" onClick={() => setShowUpload((v) => !v)}>Upload your CSVs</button>
        </div>
        <p className="hint">Sample: 300 orders, 289 gateway rows and 36 bank lines for a fictional wall-art brand, with 25 problems planted on purpose.</p>
        {showUpload && <UploadPanel onRun={runUpload} />}
        {issues.length > 0 && (
          <div className="issues" role="alert">
            <strong>Some columns could not be found.</strong>
            <ul>{issues.map((i, k) => <li key={k}>{i.file}: {i.message}</li>)}</ul>
          </div>
        )}
      </section>

      {source && !issues.length && (
        <Results
          source={source} contract={contract} setContract={setContract}
          aiRun={aiRun} setAiRun={setAiRun} mode={mode} setMode={setMode}
        />
      )}

      <footer className="foot">
        Built for the Razorpay AI Builders challenge. Data in the sample is synthetic. Files you upload are processed in your browser; only ambiguous records are sent to the AI, and only when you ask.
      </footer>
    </div>
  );
}

// ---------------- upload ----------------
function UploadPanel({ onRun }: { onRun: (f: { orders: string; gateway: string; bank: string }) => void }) {
  const [files, setFiles] = useState<{ orders?: string; gateway?: string; bank?: string }>({});
  const slot = (k: 'orders' | 'gateway' | 'bank', label: string, sample: string) => (
    <label className="upload-slot">
      <span className="upload-label">{label}</span>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const text = await f.text(); setFiles((s) => ({ ...s, [k]: text }));
      }} />
      <a href={`/sample/${sample}`} download>Download template</a>
      {files[k] && <span className="ok">Loaded</span>}
    </label>
  );
  const ready = files.orders && files.gateway && files.bank;
  return (
    <div className="upload">
      {slot('orders', 'Shopify orders export', 'shopify_orders.csv')}
      {slot('gateway', 'Razorpay settlement report', 'razorpay_settlement_report.csv')}
      {slot('bank', 'Bank statement (CSV)', 'bank_statement.csv')}
      <button className="btn primary" disabled={!ready} onClick={() => onRun(files as any)}>Reconcile my files</button>
    </div>
  );
}

// ---------------- results ----------------
interface ResultsProps {
  source: Source; contract: FeeContract; setContract: (c: FeeContract) => void;
  aiRun: (AiRun & { live?: boolean }) | null; setAiRun: (r: (AiRun & { live?: boolean }) | null) => void;
  mode: Mode; setMode: (m: Mode) => void;
}

function Results({ source, contract, setContract, aiRun, setAiRun, mode, setMode }: ResultsProps) {
  const { data } = source;
  const isSample = source.kind === 'sample';
  const runs = useMemo(() => {
    const out: Partial<Record<Mode, ReconResult>> = {
      rules: reconcile(data, { mode: 'rules', contract }),
      heuristic: reconcile(data, { mode: 'heuristic', contract }),
    };
    if (aiRun) out.ai = reconcile(data, { mode: 'ai', contract, ai: aiRun.decisions });
    return out;
  }, [data, contract, aiRun]);
  const evals = useMemo(() => {
    if (!isSample) return null;
    const e: Partial<Record<Mode, EvalResult>> = {};
    for (const m of Object.keys(runs) as Mode[]) e[m] = evaluate(runs[m]!, SAMPLE_KEY);
    return e;
  }, [runs, isSample]);

  const active = runs[mode] ?? runs.heuristic!;
  const pending = runs.heuristic!.pendingPackets;

  const [aiState, setAiState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  async function runAiLive() {
    setAiState({ busy: true });
    try {
      const res = await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packets: pending }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setAiRun({ ...body, live: true });
      setMode('ai');
      setAiState({ busy: false });
    } catch (e) {
      setAiState({ busy: false, error: e instanceof Error ? e.message : 'AI request failed' });
    }
  }

  return (
    <main id="results" className="results">
      <div className="results-head">
        <div>
          <h2>{source.name}</h2>
          <p className="meta">
            {active.counts.orders} orders, {active.counts.payments} gateway payments, {active.counts.settlements} settlements,
            {' '}{active.counts.bankCredits} gateway credits in the bank. Reconciled in {active.runtimeMs} ms in your browser.
          </p>
        </div>
      </div>

      <ModeSwitch runs={runs} evals={evals} mode={mode} setMode={setMode} aiRun={aiRun}
        pendingCount={pending.length} onRunAi={runAiLive} aiState={aiState} />

      {mode === 'ai' && aiRun && <AiDecisions r={active} aiRun={aiRun} data={data} />}
      <Leaks r={active} />
      <Waterfall r={active} />
      <Exceptions list={active.exceptions} />
      <Pipeline r={active} />
      <Records r={active} data={data} />
      <ContractEditor contract={contract} setContract={setContract} />
    </main>
  );
}

function ModeSwitch({ runs, evals, mode, setMode, aiRun, pendingCount, onRunAi, aiState }: {
  runs: Partial<Record<Mode, ReconResult>>; evals: Partial<Record<Mode, EvalResult>> | null; mode: Mode; setMode: (m: Mode) => void;
  aiRun: (AiRun & { live?: boolean }) | null; pendingCount: number; onRunAi: () => void; aiState: { busy: boolean; error?: string };
}) {
  const modes: Mode[] = ['rules', 'heuristic', 'ai'];
  return (
    <section className="block">
      <h3>How much does each stage earn its place?</h3>
      <p className="sub">
        {evals
          ? 'Every planted problem has a known answer, so each stage is scored. Pick a column to see its results below.'
          : 'Pick a column to see its results below. Accuracy is shown only for the sample, where the right answers are known.'}
      </p>
      <div className="modes" role="tablist">
        {modes.map((m) => {
          const r = runs[m]; const e = evals?.[m];
          const available = !!r;
          return (
            <button key={m} role="tab" aria-selected={mode === m} disabled={!available}
              className={`mode ${mode === m ? 'on' : ''}`} onClick={() => available && setMode(m)}>
              <span className="mode-name">{MODE_LABEL[m]}</span>
              {r ? (
                <dl>
                  {e && <><dt>Records matched correctly</dt><dd className="big">{e.linkAccuracy}%</dd></>}
                  {e && <><dt>Wrong matches</dt><dd>{e.wrongLinks}</dd></>}
                  {e && <><dt>False alarms</dt><dd>{e.exceptions.fp}</dd></>}
                  {e && <><dt>Planted problems found</dt><dd>{e.exceptions.tp} of {e.exceptions.tp + e.exceptions.fn}</dd></>}
                  {!e && <><dt>Exceptions raised</dt><dd className="big">{r.exceptions.length}</dd></>}
                  <dt>Sent to AI</dt>
                  <dd>{m === 'ai' ? `${pendingCount} records` : 'none'}</dd>
                  {m === 'ai' && aiRun && <><dt>AI cost</dt><dd>${aiRun.usage.costUsd.toFixed(4)} (about {inr(aiRun.usage.costUsd * USD_INR, 2)})</dd></>}
                </dl>
              ) : (
                <p className="mode-empty">{pendingCount} ambiguous records are waiting for the AI stage.</p>
              )}
            </button>
          );
        })}
      </div>
      <div className="ai-bar">
        <button className="btn" onClick={onRunAi} disabled={aiState.busy || pendingCount === 0}>
          {aiState.busy ? 'Asking Claude…' : aiRun?.live ? 'Run AI again' : 'Run the AI stage live'}
        </button>
        <span className="ai-note">
          {aiState.error ? <span className="err">{aiState.error}</span>
            : aiRun ? <>{aiRun.live ? 'Live run' : 'Precomputed run'}: {aiRun.usage.model}, {aiRun.usage.inputTokens.toLocaleString()} input and {aiRun.usage.outputTokens.toLocaleString()} output tokens, {(aiRun.usage.latencyMs / 1000).toFixed(1)} s.</>
              : <>Sends only the {pendingCount} records heuristics refused to decide, each with up to 5 candidates.</>}
        </span>
      </div>
    </section>
  );
}

function Leaks({ r }: { r: ReconResult }) {
  const count = (s: Severity) => r.exceptions.filter((e) => e.severity === s).length;
  return (
    <section className="leaks">
      <div className="leak loss">
        <span className="leak-label">Money at risk</span>
        <span className="leak-num">{inr(r.money.atRisk)}</span>
        <span className="leak-foot">{count('loss')} items: overcharged fees, missing payments and settlements, chargebacks</span>
      </div>
      <div className="leak liability">
        <span className="leak-label">Owed to customers</span>
        <span className="leak-num">{inr(r.money.owedToCustomers)}</span>
        <span className="leak-foot">{count('liability')} items: duplicate charges and refunds never sent</span>
      </div>
      <div className="leak review">
        <span className="leak-label">Needs a human look</span>
        <span className="leak-num">{r.money.reviewCount}</span>
        <span className="leak-foot">records the engine would not guess on</span>
      </div>
    </section>
  );
}

function Waterfall({ r }: { r: ReconResult }) {
  const m = r.money;
  const notInBank = Math.max(0, m.netSettled - m.receivedInBank);
  type Step = { label: string; amount: number; kind: 'total' | 'minus' | 'gap'; note?: string };
  const steps: Step[] = [
    { label: 'Captured by Razorpay', amount: m.captured, kind: 'total', note: `Prepaid orders in Shopify: ${inr(m.prepaidOrderValue)}` },
    { label: 'Gateway fees incl. GST', amount: m.fees, kind: 'minus', note: `${inr(m.feeGst)} is GST on fees, claimable as input credit` },
    { label: 'Refunds', amount: m.refunds, kind: 'minus' },
    { label: 'Chargebacks', amount: m.adjustments, kind: 'minus' },
    { label: 'Settled to your account', amount: m.netSettled, kind: 'total' },
    { label: 'Not received in bank', amount: notInBank, kind: 'gap' },
    { label: 'Received in bank', amount: m.receivedInBank, kind: 'total' },
  ];
  // Deductions are small next to the totals, so the axis starts just below the smallest total.
  const floor = Math.floor((Math.min(m.receivedInBank, m.netSettled) * 0.9) / 10000) * 10000;
  const span = Math.max(1, m.captured - floor);
  const pos = (v: number) => Math.max(0, ((v - floor) / span) * 100);
  let running = 0;
  return (
    <section className="block">
      <h3>Where the money went</h3>
      <p className="sub">Scale starts at {inr(floor)} so the deductions stay visible.</p>
      <div className="wf">
        {steps.map((s, i) => {
          let left = 0; let width = 0;
          if (s.kind === 'total') { running = s.amount; width = pos(s.amount); }
          else { left = pos(running - s.amount); width = pos(running) - left; running -= s.amount; }
          if (s.amount > 0) width = Math.max(width, 0.5);
          return (
            <div className={`wf-row ${s.kind}`} key={i}>
              <div className="wf-label">{s.label}{s.note && <small>{s.note}</small>}</div>
              <div className="wf-track"><div className="wf-bar" style={{ marginLeft: `${left}%`, width: `${width}%` }} /></div>
              <div className="wf-amt">{s.kind === 'total' ? '' : '−'}{inr(s.amount, 2)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const SEV_ORDER: Severity[] = ['loss', 'liability', 'review'];

function Exceptions({ list }: { list: RecException[] }) {
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const groups = new Map<string, RecException[]>();
  for (const e of list) {
    if (filter !== 'all' && e.severity !== filter) continue;
    groups.set(e.type, [...(groups.get(e.type) ?? []), e]);
  }
  const sorted = [...groups.entries()].sort(([, a], [, b]) =>
    SEV_ORDER.indexOf(a[0].severity) - SEV_ORDER.indexOf(b[0].severity) ||
    b.reduce((s, x) => s + x.amount, 0) - a.reduce((s, x) => s + x.amount, 0));
  return (
    <section className="block">
      <h3>What needs action</h3>
      <div className="chips">
        {(['all', ...SEV_ORDER] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'Everything' : SEV_LABEL[f]} ({f === 'all' ? list.length : list.filter((e) => e.severity === f).length})
          </button>
        ))}
      </div>
      {sorted.length === 0 ? <p className="empty">Nothing in this group. Every record here reconciled cleanly.</p> : (
        <ul className="ex-groups">
          {sorted.map(([type, items]) => {
            const isOpen = open === type;
            const total = items.reduce((s, x) => s + x.amount, 0);
            return (
              <li key={type} className={`ex-group ${items[0].severity}`}>
                <button className="ex-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : type)}>
                  <span className="ex-title">{items[0].title}</span>
                  <span className="ex-count">{items.length}</span>
                  <span className="ex-amt">{inr(total, 2)}</span>
                  <span className="ex-caret" aria-hidden>{isOpen ? '−' : '+'}</span>
                </button>
                {isOpen && (
                  <ul className="ex-list">
                    {items.sort((a, b) => b.amount - a.amount).map((e) => (
                      <li key={e.key} className="ex">
                        <div className="ex-top"><code>{e.key}</code><span className="ex-amt">{inr(e.amount, 2)}</span></div>
                        <p className="ex-body">{e.explanation}</p>
                        <div className="ex-ev">{e.evidence.map((v, i) => <span key={i}>{v}</span>)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AiDecisions({ r, aiRun, data }: { r: ReconResult; aiRun: AiRun; data: Dataset }) {
  const pay = new Map(data.gateway.map((g) => [g.entityId, g]));
  const ord = new Map(data.orders.map((o) => [o.id, o]));
  const applied = new Set(r.aiApplied.map((d) => d.id));
  return (
    <section className="block">
      <h3>What the AI decided, and why</h3>
      <p className="sub">These are the records heuristics refused to guess on. A decision is applied only if it picks one of the offered candidates with strong or moderate evidence.</p>
      <ul className="ai-list">
        {aiRun.decisions.map((d) => {
          const p = pay.get(d.id); const o = d.match ? ord.get(d.match) : undefined;
          return (
            <li key={d.id} className={applied.has(d.id) ? '' : 'rejected'}>
              <div className="ai-note-text">“{p?.notes || d.id}”</div>
              <div className="ai-arrow">
                {o ? <>{o.id}, {o.items.replace(/ x1/g, '')}, {o.customerName}</> : d.match ?? 'No match: left for review'}
              </div>
              <div className="ai-why">{d.reason} <span className="conf">{d.strength ? `${d.strength} evidence` : `confidence ${d.confidence.toFixed(2)}`}{!applied.has(d.id) && d.match ? ', not applied' : ''}</span></div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Pipeline({ r }: { r: ReconResult }) {
  return (
    <section className="block">
      <h3>How this run was reconciled</h3>
      <ol className="pipe">
        {r.stages.map((s, i) => (
          <li key={i}><span className="pipe-stage">{s.stage}</span><span className="pipe-detail">{s.detail}</span><span className="pipe-n">{s.resolved}</span></li>
        ))}
      </ol>
    </section>
  );
}

function Records({ r, data }: { r: ReconResult; data: Dataset }) {
  const [tab, setTab] = useState<'payments' | 'settlements'>('payments');
  const [onlyInteresting, setOnlyInteresting] = useState(true);
  const links = new Map(r.paymentLinks.map((l) => [l.paymentId, l]));
  const payments = data.gateway.filter((g) => g.type === 'payment')
    .map((p) => ({ p, l: links.get(p.entityId) }))
    .filter(({ l }) => !onlyInteresting || !l || !l.method.startsWith('rule'));
  const bl = new Map(r.bankLinks.map((l) => [l.settlementId, l]));
  const bank = new Map(data.bank.map((b) => [b.tranId, b]));
  const sets = r.settlements.map((s) => ({ s, l: bl.get(s.id) })).filter(({ l }) => !onlyInteresting || !l || !l.method.startsWith('rule'));
  return (
    <section className="block">
      <h3>Every match, with its reason</h3>
      <div className="chips">
        <button className={`chip ${tab === 'payments' ? 'on' : ''}`} onClick={() => setTab('payments')}>Payments to orders</button>
        <button className={`chip ${tab === 'settlements' ? 'on' : ''}`} onClick={() => setTab('settlements')}>Settlements to bank</button>
        <label className="toggle"><input type="checkbox" checked={onlyInteresting} onChange={(e) => setOnlyInteresting(e.target.checked)} /> Hide exact rule matches</label>
      </div>
      <div className="table-wrap">
        {tab === 'payments' ? (
          <table>
            <thead><tr><th>Payment</th><th className="num">Amount</th><th>Order</th><th>Matched by</th><th>Why</th></tr></thead>
            <tbody>
              {payments.map(({ p, l }) => (
                <tr key={p.entityId}>
                  <td><code>{p.entityId}</code>{p.notes && <small>“{p.notes}”</small>}</td>
                  <td className="num">{inr(p.amount, 2)}</td>
                  <td>{l?.orderId ?? '-'}</td>
                  <td><span className={`tag ${l ? l.method.split(':')[0] : 'none'}`}>{l ? METHOD_LABEL[l.method] : 'Unmatched'}</span></td>
                  <td className="why">{l?.reason ?? (l ? 'exact identifier match' : 'no candidate was strong enough')}</td>
                </tr>
              ))}
              {payments.length === 0 && <tr><td colSpan={5} className="empty">Every payment matched on an exact identifier.</td></tr>}
            </tbody>
          </table>
        ) : (
          <table>
            <thead><tr><th>Settlement</th><th>Date</th><th className="num">Net</th><th>Bank credit</th><th>Matched by</th><th>Why</th></tr></thead>
            <tbody>
              {sets.map(({ s, l }) => {
                const b = l ? bank.get(l.tranId) : undefined;
                return (
                  <tr key={s.id}>
                    <td><code>{s.id}</code><small>UTR {s.utr}</small></td>
                    <td>{s.settledAt}</td>
                    <td className="num">{inr(s.net, 2)}</td>
                    <td>{b ? <>{b.tranId}<small>{inr(b.deposit, 2)} on {b.date}</small></> : '-'}</td>
                    <td><span className={`tag ${l ? l.method.split(':')[0] : 'none'}`}>{l ? METHOD_LABEL[l.method] : 'Not in bank'}</span></td>
                    <td className="why">{l?.reason ?? (l ? 'UTR found in narration' : 'no bank credit matches')}</td>
                  </tr>
                );
              })}
              {sets.length === 0 && <tr><td colSpan={6} className="empty">Every settlement matched on its UTR.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function ContractEditor({ contract, setContract }: { contract: FeeContract; setContract: (c: FeeContract) => void }) {
  const fields: [keyof FeeContract, string][] = [
    ['upi', 'UPI'], ['card', 'Cards (Visa, Mastercard, RuPay)'], ['amex', 'Amex and Diners'], ['netbanking', 'Netbanking'], ['wallet', 'Wallets'], ['gstOnFee', 'GST on fee'],
  ];
  return (
    <section className="block">
      <h3>Your gateway contract</h3>
      <p className="sub">The fee check recomputes every payment's fee from these rates. Change one and the overcharges update instantly.</p>
      <div className="contract">
        {fields.map(([k, label]) => (
          <label key={k}>
            <span>{label}</span>
            <span className="pct"><input type="number" step="0.01" min="0" max="30" value={contract[k]}
              onChange={(e) => setContract({ ...contract, [k]: Number(e.target.value) || 0 })} />%</span>
          </label>
        ))}
        <button className="btn ghost small" onClick={() => setContract(DEFAULT_CONTRACT)}>Reset</button>
      </div>
    </section>
  );
}
