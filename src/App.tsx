import { useState, useEffect, useRef } from 'react';
import {
  Home, FileText, Bell, Layout,
  Shield, Zap, Cpu, RefreshCw, Activity,
  GitBranch, FileMinus, AlertTriangle, CheckCircle,
  ChevronRight, ChevronLeft, File, Lock, TrendingUp,
  BarChart2, Code, Download, Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { jsPDF } from 'jspdf';
import './App.css';

// ─────────────────────────────── VS Code bridge ───────────────────────────────
declare function acquireVsCodeApi(): { postMessage: (m: unknown) => void };
const vscode = (typeof acquireVsCodeApi !== 'undefined')
  ? acquireVsCodeApi()
  : { postMessage: (m: unknown) => console.log('[Dev]', m) };

const post = (type: string, extra?: Record<string, unknown>) =>
  vscode.postMessage({ type, ...extra });

// ─────────────────────────────── Types ────────────────────────────────────────
interface FileDetail { name: string; path: string; lines: number; size: number; ext: string }
interface SecIssue { file: string; line: number; match: string }
interface PerfIssue { file: string; count: number; type: string }
interface AnalysisData {
  healthScore: number;
  workspaceName: string;
  godFiles: FileDetail[];
  securityIssues: SecIssue[];
  performanceIssues: PerfIssue[];
  unusedFiles: FileDetail[];
  allFiles: FileDetail[];
  totalFiles: number;
  totalLines: number;
  unusedExports: number;
  circularDeps: number;
  scanProgress: number;
  lastScanned: string;
}

type NavView = 'dashboard' | 'summaries' | 'findings';
type DetailView = 'allFiles' | 'godFiles' | 'unusedFiles' | 'securityIssues' | 'performanceIssues' | null;

// ─────────────────────────────── Helpers ──────────────────────────────────────
const extColor: Record<string, string> = {
  ts: '#3b82f6', tsx: '#06b6d4', js: '#facc15', jsx: '#f97316',
  py: '#84cc16', vue: '#22c55e', svelte: '#ff3e00', default: '#8b5cf6'
};

const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
function extBg(ext: string) {
  const c = extColor[ext] ?? extColor.default;
  return { background: `${c}22`, color: c };
}

const EMPTY_DATA: AnalysisData = {
  healthScore: 0, workspaceName: 'CodePulse Engine...',
  godFiles: [], securityIssues: [], performanceIssues: [],
  unusedFiles: [], allFiles: [],
  totalFiles: 0, totalLines: 0, unusedExports: 0,
  circularDeps: 0, scanProgress: 0, lastScanned: 'Never'
};

// ─────────────────────────────── Sub-components ───────────────────────────────
function Ring({ value }: { value: number }) {
  const r = 58, c = 2 * Math.PI * r;
  const col = value >= 80 ? 'var(--green)' : value >= 50 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="ring-wrap" style={{ margin: '20px 0' }}>
      <svg width="140" height="140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
        <motion.circle
          cx="70" cy="70" r={r}
          fill="none" stroke={col} strokeWidth="10"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c - (value / 100) * c }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          strokeLinecap="round" transform="rotate(-90 70 70)"
        />
      </svg>
      <div className="ring-value">
        <span className="ring-num" style={{ color: col }}>{value}</span>
        <span className="ring-sub">/ 100</span>
      </div>
    </div>
  );
}

function SparkLine({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 280, H = 70;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - (v / max) * (H - 10) - 5}`).join(' ');
  const area = `${pts} ${W},${H} 0,${H}`;
  return (
    <div className="spark-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sg" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--blue)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#sg)" />
        <motion.polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth="2" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} />
      </svg>
    </div>
  );
}

function FileRow({ f, onClick }: { f: FileDetail; onClick: () => void }) {
  return (
    <div className="file-item" onClick={onClick}>
      <div className="file-ext" style={extBg(f.ext)}>{f.ext || '?'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="file-name">{f.name}</div>
        <div className="file-path">{f.path}</div>
      </div>
      <div className="file-lines">{f.lines} L</div>
    </div>
  );
}

// ─────────────────────────────── Main App ─────────────────────────────────────
export default function App() {
  const [nav, setNav] = useState<NavView>('dashboard');
  const [detail, setDetail] = useState<DetailView>(null);
  const [data, setData] = useState<AnalysisData>(EMPTY_DATA);
  const [scanning, setScanning] = useState(true);
  const [progress, setProgress] = useState(0);
  const [history, setHistory] = useState<number[]>([70, 75, 82, 80]);
  const [hasAlert, setHasAlert] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    const handler = (e: MessageEvent<{ type: string; data?: AnalysisData; value?: number }>) => {
      const msg = e.data;
      if (msg.type === 'analysisStarted') { setScanning(true); setProgress(0); }
      if (msg.type === 'progress' && msg.value !== undefined) setProgress(msg.value);
      if (msg.type === 'analysisFailed') { setScanning(false); }
      if (msg.type === 'analysisResult' && msg.data) {
        const d = msg.data;
        setData(d);
        // Optimized speed: reduced artificial delay for faster loading feel
        setTimeout(() => { setScanning(false); setScanned(true); }, 800);
        setProgress(100);
        setHistory(h => [...h.slice(-5), d.healthScore]);
        if (d.securityIssues.length > 0) setHasAlert(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const openFile = (path: string) => post('openFile', { path });
  const notify = (v: string) => post('showInfo', { value: v });
  const fixIssue = (id: string) => post('fixIssue', { issueId: id });

  const exportPDF = () => {
    const doc = new jsPDF();
    let y = 20;

    // Header
    doc.setFillColor(8, 13, 23); doc.rect(0, 0, 210, 297, 'F');
    doc.setTextColor(45, 126, 255); doc.setFontSize(26); doc.text("CodePulse Health Audit", 20, y);
    y += 10;
    doc.setDrawColor(45, 126, 255); doc.line(20, y, 190, y);
    y += 15;

    // Project Info
    doc.setTextColor(255, 255, 255); doc.setFontSize(14);
    doc.text(`Project: ${data.workspaceName}`, 20, y); y += 8;
    doc.text(`Generated: ${new Date().toLocaleString()}`, 20, y); y += 8;
    doc.setTextColor(0, 229, 160); doc.text(`Overall Health Score: ${data.healthScore}/100`, 20, y); y += 15;

    // Summary Stats
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.text("Executive Summary", 20, y); y += 10;
    doc.setFontSize(12); doc.setTextColor(200, 200, 200);
    doc.text(`- Total Files Analyzed: ${data.totalFiles}`, 25, y); y += 7;
    doc.text(`- Total Lines of Code: ${data.totalLines}`, 25, y); y += 7;
    doc.text(`- Security Risks Detected: ${data.securityIssues.length}`, 25, y); y += 7;
    doc.text(`- Performance Smells Identified: ${data.performanceIssues.length}`, 25, y); y += 7;
    doc.text(`- God Files (High Complexity): ${data.godFiles.length}`, 25, y); y += 15;

    // Detailed Findings - Security
    if (data.securityIssues.length > 0) {
      doc.setTextColor(255, 45, 85); doc.setFontSize(16); doc.text("Security Findings", 20, y); y += 10;
      doc.setFontSize(10); doc.setTextColor(200, 200, 200);
      data.securityIssues.forEach((s) => {
        if (y > 270) { doc.addPage(); doc.setFillColor(8, 13, 23); doc.rect(0, 0, 210, 297, 'F'); y = 20; }
        doc.text(`[CRITICAL] Hardcoded Token in ${s.file}`, 25, y); y += 6;
      });
      y += 10;
    }

    // Detailed Findings - God Files
    if (data.godFiles.length > 0) {
      doc.setTextColor(255, 184, 0); doc.setFontSize(16); doc.text("Architecture Warnings (God Files)", 20, y); y += 10;
      doc.setFontSize(10); doc.setTextColor(200, 200, 200);
      data.godFiles.forEach((f) => {
        if (y > 270) { doc.addPage(); doc.setFillColor(8, 13, 23); doc.rect(0, 0, 210, 297, 'F'); y = 20; }
        doc.text(`[WARNING] Large File Detected: ${f.name} (${f.lines} lines)`, 25, y); y += 6;
      });
      y += 10;
    }

    // Detailed Findings - Performance
    if (data.performanceIssues.length > 0) {
      doc.setTextColor(0, 242, 254); doc.setFontSize(16); doc.text("Performance Insights", 20, y); y += 10;
      doc.setFontSize(10); doc.setTextColor(200, 200, 200);
      data.performanceIssues.forEach((p) => {
        if (y > 270) { doc.addPage(); doc.setFillColor(8, 13, 23); doc.rect(0, 0, 210, 297, 'F'); y = 20; }
        doc.text(`[ISSUE] ${p.type} in ${p.file}`, 25, y); y += 6;
      });
    }

    doc.save(`CodePulse_Report_${data.workspaceName}.pdf`);
    notify('Full Comprehensive Report Exported!');
  };

  const hColor = data.healthScore >= 80 ? 'var(--green)' : data.healthScore >= 50 ? 'var(--amber)' : 'var(--red)';

  const statCards = [
    { id: 'allFiles', label: 'Total Files', value: fmt(data.totalFiles), icon: <File size={16} />, color: 'var(--blue)', detail: 'allFiles' as DetailView },
    { id: 'godFiles', label: 'God Files', value: String(data.godFiles.length), icon: <Cpu size={16} />, color: 'var(--amber)', detail: 'godFiles' as DetailView },
    { id: 'securityRisks', label: 'Security Risks', value: String(data.securityIssues.length), icon: <Lock size={16} />, color: 'var(--red)', detail: 'securityIssues' as DetailView },
    { id: 'performance', label: 'Perf Smells', value: String(data.performanceIssues.length), icon: <Zap size={16} />, color: 'var(--amber)', detail: 'performanceIssues' as DetailView },
  ];

  // ── DETAIL PAGES ──
  if (detail) {
    let title = ""; let list: any[] = []; let type: 'file' | 'finding' = 'file';
    if (detail === 'allFiles') { title = "All Files"; list = data.allFiles; type = 'file'; }
    if (detail === 'godFiles') { title = "God Files"; list = data.godFiles; type = 'file'; }
    if (detail === 'securityIssues') { title = "Security Issues"; list = data.securityIssues; type = 'finding'; }
    if (detail === 'performanceIssues') { title = "Performance Issues"; list = data.performanceIssues; type = 'finding'; }
    if (detail === 'unusedFiles') { title = "Dead Files"; list = data.unusedFiles; type = 'file'; }

    return (
      <div className="app">
        <div className="topbar">
          <button className="back-btn" onClick={() => setDetail(null)}><ChevronLeft size={18} /> {title}</button>
          <span className="chip chip-blue">{list.length}</span>
        </div>
        <div className="scroll-body">
          {list.length === 0 ? (
            <div style={{ textAlign: 'center', marginTop: 50 }}><CheckCircle size={48} color="var(--green)" opacity={0.3} /><p style={{ color: 'var(--muted)', marginTop: 10 }}>All clean!</p></div>
          ) : list.map((item, i) => (
            type === 'file' ? <FileRow key={i} f={item} onClick={() => openFile(item.path)} /> : (
              <div key={i} className="finding-item" onClick={() => String(detail).includes('security') ? fixIssue(`sec-${i}`) : null}>
                <span className={`dot ${String(detail).includes('security') ? 'dot-red' : 'dot-amber'}`} />
                <div style={{ flex: 1 }}>
                  <div className="finding-title">{item.type || 'Insecure Pattern'}</div>
                  <div className="finding-sub">{item.file || item.path}</div>
                  {item.match && <div style={{ fontSize: '0.6rem', color: 'var(--muted)', fontFamily: 'monospace', marginTop: 4 }}>{item.match}</div>}
                </div>
                <button className="finding-fix" onClick={() => String(detail).includes('security') ? fixIssue(`sec-${i}`) : openFile(item.file)}>
                  {String(detail).includes('security') ? 'Fix' : 'View'}
                </button>
              </div>
            )
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {scanning && !scanned ? (
        <div className="loading-page">
          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 4, ease: "linear" }}><Cpu size={64} color="var(--blue)" /></motion.div>
          <h3 style={{ marginTop: 30 }}>Initializing CodePulse</h3>
          <div className="scan-track" style={{ width: 180, margin: '20px auto' }}><motion.div className="scan-fill" initial={{ width: 0 }} animate={{ width: `${progress}%` }} /></div>
          <p style={{ letterSpacing: 2 }}>{progress}% ENGINE LOADED</p>
        </div>
      ) : (
        <>
          <div className="topbar">
            <div className="topbar-brand"><Activity size={16} color="var(--blue)" /> CODEPULSE</div>
            <div className="topbar-actions">
              <span className="live-pill"><span className="live-dot" /> LIVE</span>
              <Bell size={16} color={hasAlert ? 'var(--red)' : 'var(--muted)'} onClick={() => setHasAlert(false)} />
            </div>
          </div>

          <div className="scroll-body">
            <AnimatePresence mode="wait">
              {nav === 'dashboard' && (
                <motion.div key="dash" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="hero" style={{ background: 'radial-gradient(circle at center, rgba(45,126,255,0.05) 0%, transparent 70%)', padding: '20px 0' }}>
                    <p className="hero-label">{data.workspaceName}</p>
                    <div className="hero-score" style={{ color: hColor, textShadow: `0 0 15px ${hColor}66` }}>{data.healthScore}</div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 15 }}>
                      <span className="chip chip-green">OPTIMIZED: {Math.min(100, data.healthScore + 5)}%</span>
                      <span className="chip chip-red">DEBT: {100 - data.healthScore}%</span>
                    </div>
                    <p className="hero-sub">{data.healthScore >= 80 ? '● Codebase healthy' : '▲ Refactoring advised'}</p>
                  </div>

                  <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>STABILITY INDEX</span><TrendingUp size={14} color="var(--blue)" /></div>
                    <SparkLine values={history} />
                    <div style={{ display: 'flex', gap: 10, marginTop: 15 }}>
                      <button className="btn-secondary" style={{ flex: 1, border: '1px solid var(--blue)', color: 'var(--blue)' }} onClick={exportPDF}><Download size={14} style={{ marginRight: 6 }} /> Full Report</button>
                      <button className="btn-secondary" style={{ flex: 1 }} onClick={() => notify('CodePulse Premium release in late 2026!')}><Sparkles size={14} style={{ marginRight: 6 }} /> Upgrade</button>
                    </div>
                  </div>

                  <div className="stat-grid">
                    {statCards.map(sc => (
                      <div key={sc.id} className="stat-card" onClick={() => sc.detail && setDetail(sc.detail)}>
                        <div className="stat-icon" style={{ background: `${sc.color}15` }}><span style={{ color: sc.color }}>{sc.icon}</span></div>
                        <div className="stat-value">{sc.value}</div>
                        <div className="stat-label">{sc.label}</div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {nav === 'summaries' && (
                <motion.div key="sum" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <p className="section-title" style={{ textAlign: 'center' }}>AI System Audit</p>
                  <Ring value={data.healthScore} />
                  <div className="summary-list">
                    {[
                      { label: 'Security', icon: <Shield size={18} />, count: data.securityIssues.length, view: 'securityIssues' },
                      { label: 'Performance', icon: <Zap size={18} />, count: data.performanceIssues.length, view: 'performanceIssues' },
                      { label: 'Architecture', icon: <Cpu size={18} />, count: data.godFiles.length, view: 'godFiles' }
                    ].map(item => (
                      <div key={item.label} className="summary-row" onClick={() => setDetail(item.view as DetailView)}>
                        <span style={{ color: item.count > 0 ? 'var(--amber)' : 'var(--green)' }}>{item.icon}</span>
                        <div className="summary-row-info"><h4>{item.label}</h4><p>{item.count} detections found</p></div>
                        <ChevronRight size={14} color="var(--muted)" />
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {nav === 'findings' && (
                <motion.div key="find" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <p className="section-title">Final Findings</p>
                  {data.securityIssues.length === 0 && data.performanceIssues.length === 0 ? <p style={{ textAlign: 'center', color: 'var(--muted)', marginTop: 40 }}>All checks passed. System clean 🎉</p> : (
                    <>
                      {data.securityIssues.map((s, i) => (
                        <div key={`s${i}`} className="finding-item" onClick={() => openFile(s.file)}>
                          <span className="dot dot-red" />
                          <div style={{ flex: 1 }}><div className="finding-title">Security Risk</div><div className="finding-sub">{s.file}</div></div>
                          <button className="finding-fix" onClick={(e) => { e.stopPropagation(); fixIssue(`sec-${i}`); }}>Fix</button>
                        </div>
                      ))}
                      {data.performanceIssues.map((p, i) => (
                        <div key={`p${i}`} className="finding-item" onClick={() => openFile(p.file)}>
                          <span className="dot dot-amber" />
                          <div style={{ flex: 1 }}><div className="finding-title">{p.type}</div><div className="finding-sub">{p.file}</div></div>
                          <button className="finding-fix" onClick={(e) => { e.stopPropagation(); openFile(p.file); }}>Open</button>
                        </div>
                      ))}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <nav className="bottom-nav">
            <button className={`nav-btn ${nav === 'dashboard' ? 'active' : ''}`} onClick={() => setNav('dashboard')}><Home size={20} /><span>Home</span></button>
            <button className={`nav-btn ${nav === 'summaries' ? 'active' : ''}`} onClick={() => setNav('summaries')}><BarChart2 size={20} /><span>Audit</span></button>
            <button className={`nav-btn ${nav === 'findings' ? 'active' : ''}`} onClick={() => setNav('findings')}><AlertTriangle size={20} /><span>Issues</span></button>
          </nav>
        </>
      )}
    </div>
  );
}
