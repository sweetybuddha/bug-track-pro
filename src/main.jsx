import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertCircle, BarChart3, Bug, CheckCircle2, ChevronDown, CircleUserRound, Download, Eye, EyeOff, FileText, LayoutDashboard, LogOut, Menu, Plus, Search, Settings, ShieldCheck, TestTube2, Trash2, X, ScanLine } from 'lucide-react';
import './styles.css';

let sessionExpiredHandler = null;
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
const getApiBaseUrl = () => {
  if (typeof window !== 'undefined' && window.__BUGTRACK_API_URL__) {
    return String(window.__BUGTRACK_API_URL__).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  }
  const envUrl = (import.meta.env.VITE_API_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (envUrl) return envUrl;

  // Auto-connect to your live Render backend when running on Vercel or other cloud frontends
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host.endsWith('.vercel.app') || host.endsWith('.netlify.app') || host.endsWith('.github.io')) {
      return 'https://bug-track-pro.onrender.com';
    }
  }
  return '';
};
const resolveApiUrl = (url) => {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) {
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      return url.replace('http://', 'https://');
    }
    return url;
  }
  const path = url.startsWith('/') ? url : `/${url}`;
  let base = getApiBaseUrl();
  if (base && typeof window !== 'undefined' && window.location.protocol === 'https:' && base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
    base = base.replace('http://', 'https://');
  }
  return base ? `${base}${path}` : path;
};
const api = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutMs = options.timeout || 25_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fullUrl = resolveApiUrl(url);

  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('bugtrack_token') : null;
  const headers = {
    ...(options.headers || {}),
  };
  if (token && !headers['Authorization'] && !headers['authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(fullUrl, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`The request to ${fullUrl} timed out after ${timeoutMs / 1000}s. Check the server logs and try again.`);
    }
    const targetDesc = fullUrl.startsWith('http') ? fullUrl : `${typeof window !== 'undefined' ? window.location.origin : ''}${fullUrl}`;
    throw new Error(`Cannot connect to the application server (${targetDesc}). Ensure the backend is running, CORS allows this origin, and VITE_API_URL is configured.`);
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') || '';
  const rawBody = await response.text();
  let body = null;
  if (rawBody && contentType.includes('application/json')) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error(`The server at ${fullUrl} returned invalid JSON (HTTP ${response.status}).`);
    }
  } else if (rawBody && (rawBody.trim().startsWith('<!DOCTYPE html>') || rawBody.trim().startsWith('<html'))) {
    if (!response.ok) {
      throw new ApiError(`Server returned HTTP ${response.status} with an HTML error page. Verify your backend route and deployment.`, response.status);
    }
    throw new Error(`API route ${url} returned an HTML page instead of JSON. Ensure your API server is running and handling this route.`);
  }

  if (!response.ok) {
    if (response.status === 401 && sessionExpiredHandler && !url.includes('/api/login') && !url.includes('/api/register') && !url.includes('/api/password-reset')) {
      sessionExpiredHandler();
    }
    throw new ApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }

  if (response.status === 204) return null;
  if (body === null) {
    throw new Error('The server returned an empty or invalid response.');
  }
  return body;
};
const statuses = ['Open','In Progress','Fixed','Retesting','Closed','Reopened'];
const emptyBug = { title:'', description:'', module:'', severity:'Major', priority:'P1', status:'Open', assignee:'', steps:'', expected:'', actual:'' };
const passwordChecks = [
  { message: 'Password must contain at least 8 characters.', test: password => password.length >= 8 },
  { message: 'Include at least one uppercase letter.', test: password => /[A-Z]/.test(password) },
  { message: 'Include at least one lowercase letter.', test: password => /[a-z]/.test(password) },
  { message: 'Include at least one number.', test: password => /\d/.test(password) },
  { message: 'Include at least one special character.', test: password => /[^A-Za-z0-9]/.test(password) },
];

function PasswordField({ label, value, onChange, placeholder, autoComplete, onBlur }) {
  const [visible, setVisible] = useState(false);
  return <label>{label}<span className="password-input"><input value={value} onChange={onChange} onBlur={onBlur} placeholder={placeholder} type={visible ? 'text' : 'password'} autoComplete={autoComplete} required/><button type="button" className="password-toggle" onClick={() => setVisible(current => !current)} aria-label={visible ? 'Hide password' : 'Show password'} title={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span></label>;
}

function Login({ onLogin, notice = '' }) {
  const resetTokenFromUrl = new URLSearchParams(window.location.search).get('resetToken') || '';
  const [mode, setMode] = useState(resetTokenFromUrl ? 'reset' : 'login'), [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState(''), [role, setRole] = useState('Tester'), [code, setCode] = useState(''), [pendingEmail, setPendingEmail] = useState(''), [maskedEmail, setMaskedEmail] = useState(''), [expiresAt, setExpiresAt] = useState(0), [error, setError] = useState(notice), [loading, setLoading] = useState(false), [countdown, setCountdown] = useState(0), [resetToken] = useState(resetTokenFromUrl);
  useEffect(() => {
    if (mode !== 'verify' || !expiresAt) return undefined;
    const timer = setInterval(() => setCountdown(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [mode, expiresAt]);
  useEffect(() => {
    if (mode !== 'reset' || !resetToken) return undefined;
    api('/api/password-reset/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:resetToken}) }).catch(resetError => setError(resetError.message));
    return undefined;
  }, [mode, resetToken]);
  const login = async (event) => {
    event.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      if (mode === 'forgot') {
        const trimmedEmail = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
          setError('Please enter a valid email address.');
          return;
        }
        try {
          const result = await api('/api/password-reset/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: trimmedEmail }),
          });
          setError(result?.message || 'If an account exists for this email, password reset instructions will be sent.');
        } catch (resetErr) {
          setError(resetErr.message || 'If an account exists for this email, password reset instructions will be sent.');
        }
        return;
      }
      if (mode === 'reset') {
        if (!resetToken) {
          setError('No reset token found. Please use the link sent to your email.');
          return;
        }
        const unmetRequirements = passwordChecks.filter(check => !check.test(password)).map(check => check.message);
        if (unmetRequirements.length) {
          setError(unmetRequirements.join(' '));
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match.');
          return;
        }
        const result = await api('/api/password-reset/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password }),
        });
        setError(result.message || 'Your password has been reset successfully.');
        setMode('reset-success');
        setPassword('');
        setConfirmPassword('');
        return;
      }
      if (mode === 'verify') {
        const result = await api('/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingEmail, code }),
        });
        if (result?.user) {
          onLogin(result.user);
        } else {
          setMode('login');
          setPassword('');
          setCode('');
          setError(result.message || 'Email verified successfully. Please sign in.');
        }
        return;
      }
      if (mode === 'register') {
        const trimmedName = name.trim();
        const trimmedEmail = email.trim();
        if (!trimmedName) {
          setError('Please enter your name.');
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
          setError('Please enter a valid email address.');
          return;
        }
        const unmetRequirements = passwordChecks.filter(check => !check.test(password)).map(check => check.message);
        if (unmetRequirements.length) {
          setError(unmetRequirements.join(' '));
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match.');
          return;
        }
        const result = await api('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, email: trimmedEmail, password, role }),
        });
        if (result?.verificationRequired) {
          setPendingEmail(result.email);
          setMaskedEmail(result.maskedEmail || result.email);
          setExpiresAt(result.expiresAt || (Date.now() + 10 * 60 * 1000));
          setCountdown(Math.max(1, Math.ceil(((result.expiresAt || (Date.now() + 10 * 60 * 1000)) - Date.now()) / 1000)));
          setCode('');
          setMode('verify');
          setError('');
        } else {
          onLogin(result);
        }
        return;
      }
      // Mode === 'login'
      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) {
        setError('Enter your email and password.');
        return;
      }
      const result = await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      onLogin(result);
    } catch (authError) {
      setError(authError.message || 'Authentication request failed.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (notice) setError(notice); }, [notice]);
  const resend = async () => {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const result = await api('/api/verify/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail }),
      });
      setExpiresAt(result.expiresAt);
      setCountdown(Math.ceil((result.expiresAt - Date.now()) / 1000));
      setError('A new verification code was sent.');
    } catch (resendError) {
      setError(resendError.message);
    } finally {
      setLoading(false);
    }
  };
  const verificationPage = <><div className="brand-mark"><Bug size={22}/></div><h1>Verify Your Email</h1><p className="muted">We have sent a verification code to your email address.</p><p className="muted">{maskedEmail}</p><label>Six-digit verification code<input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" placeholder="000000" required/></label>{error&&<div className={error.includes('successfully')||error.includes('sent')?'login-success':'login-error'}>{error}</div>}<button className="primary full" disabled={loading||code.length!==6}>{loading?'Verifying...':'Verify Email'}</button><button type="button" className="auth-switch" onClick={resend} disabled={loading||countdown>0}>Resend OTP {countdown>0&&`(${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,'0')})`}</button><button type="button" className="auth-switch" onClick={()=>{setMode('register');setError('')}}>Back to Registration</button></>;
  const registrationPage = <><div className="brand-mark"><Bug size={22}/></div><h1>Create your BugTrack <span>Pro</span></h1><p className="muted">Register your quality workspace account</p><label>Name<input value={name} onChange={e=>setName(e.target.value)} placeholder="Enter your name" autoComplete="name" required/></label><label>Email<input value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" type="email" autoComplete="email" required/></label><PasswordField label="Password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password"/>{password&&<ul className="password-requirements">{passwordChecks.map(check=><li key={check.message} className={check.test(password)?'valid':''}>{check.message}</li>)}</ul>}<PasswordField label="Confirm password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} placeholder="Repeat your password" autoComplete="new-password"/>{confirmPassword&&<div className={password === confirmPassword ? 'password-match' : 'password-mismatch'}>{password === confirmPassword ? 'Passwords match' : 'Passwords do not match'}</div>}<label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option>Developer</option><option>Tester</option><option>Viewer</option></select></label></>;
  const loginPage = <><div className="brand-mark"><Bug size={22}/></div><h1>Welcome to BugTrack <span>Pro</span></h1><p className="muted">Sign in to your quality workspace</p><label>Email<input value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" type="email" autoComplete="email" required/></label><PasswordField label="Password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="current-password"/><button type="button" className="forgot-link" onClick={()=>{setMode('forgot');setError('')}}>Forgot Password?</button></>;
  const forgotPage = <><div className="brand-mark"><Bug size={22}/></div><h1>Forgot Your Password?</h1><p className="muted">Enter your registered email address to reset your password.</p><label>Email<input value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" type="email" autoComplete="email" required/></label></>;
  const resetPage = <><div className="brand-mark"><Bug size={22}/></div><h1>Reset Your Password</h1><p className="muted">Choose a new password for your BugTrack Pro account.</p><PasswordField label="New password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password"/>{password&&<ul className="password-requirements">{passwordChecks.map(check=><li key={check.message} className={check.test(password)?'valid':''}>{check.message}</li>)}</ul>}<PasswordField label="Confirm new password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} placeholder="Repeat your password" autoComplete="new-password"/>{confirmPassword&&<div className={password === confirmPassword ? 'password-match' : 'password-mismatch'}>{password === confirmPassword ? 'Passwords match' : 'Passwords do not match'}</div>}</>;
  const successPage = <><div className="brand-mark"><CheckCircle2 size={22}/></div><h1>Password Reset Complete</h1><p className="login-success">{error}</p><button type="button" className="primary full" onClick={()=>{window.history.replaceState({},'',window.location.pathname);setMode('login');setError('')}}>Go to Login</button></>;
  const page = mode === 'verify' ? verificationPage : mode === 'register' ? registrationPage : mode === 'forgot' ? forgotPage : mode === 'reset' ? resetPage : mode === 'reset-success' ? successPage : loginPage;
  const buttonLabel = mode === 'login' ? 'Sign in to workspace' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send Reset Link' : 'Reset Password';
  return <div className="login-shell"><form className="login-card" onSubmit={login}>{page}{mode !== 'reset-success'&&mode !== 'verify'&&error&&<div className={error.includes('successfully')||error.includes('If an account')?'login-success':'login-error'}>{error}</div>}{mode !== 'verify'&&mode !== 'reset-success'&&<button className="primary full" disabled={loading}>{loading?(mode === 'login'?'Signing in...':mode === 'forgot'?'Sending...':mode === 'reset'?'Resetting...':'Creating account...'):buttonLabel}</button>}{mode === 'forgot'&&<button type="button" className="auth-switch" onClick={()=>{setMode('login');setError('')}}>Back to Login</button>}{mode === 'reset'&&<button type="button" className="auth-switch" onClick={()=>{window.history.replaceState({},'',window.location.pathname);setMode('login');setError('')}}>Back to Login</button>}{mode === 'login'&&<button type="button" className="auth-switch" onClick={()=>{setMode('register');setError('')}}>Need an account? Register</button>}{mode === 'register'&&<button type="button" className="auth-switch" onClick={()=>{setMode('login');setError('')}}>Already have an account? Sign in</button>}{mode === 'login'&&<div className="demo-note"><ShieldCheck size={16}/> Demo account: maya@acme.test</div>}</form></div>;
}
function Nav({ icon:Icon, label, active, count, onClick }) { return <button className={`nav-item ${active?'active':''}`} onClick={onClick}><Icon size={18}/><span>{label}</span>{count>0&&<em>{count}</em>}</button>; }
function Stat({ label, value, delta, tone, icon:Icon }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}><Icon size={18}/></div><div><span className="muted">{label}</span><div className="stat-value">{value}</div><small className={delta?.startsWith('+')?'positive':'negative'}>{delta} <span>vs last month</span></small></div></div>; }
function PanelTitle({ title, action, onClick }) { return <div className="panel-title"><h3>{title}</h3>{action&&<button onClick={onClick}>{action} →</button>}</div>; }
function App() {
  const [user,setUser]=useState(null), [authNotice,setAuthNotice]=useState(''), [page,setPage]=useState('Dashboard'), [bugs,setBugs]=useState([]), [summary,setSummary]=useState({}), [cases,setCases]=useState([]), [selected,setSelected]=useState(null), [modal,setModal]=useState(null), [query,setQuery]=useState(''), [status,setStatus]=useState('All'), [severity,setSeverity]=useState('All'), [toast,setToast]=useState('');
  const canEdit=user?.role!=='Viewer';

  useEffect(() => {
    const savedUser = localStorage.getItem('bugtrack_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {}
      api('/api/me')
        .then(currentUser => {
          setUser(currentUser);
          localStorage.setItem('bugtrack_user', JSON.stringify(currentUser));
        })
        .catch(() => {
          localStorage.removeItem('bugtrack_user');
          localStorage.removeItem('bugtrack_token');
          setUser(null);
          setAuthNotice('Your session expired. Please sign in again.');
        });
    }
  }, []);

  useEffect(() => {
    sessionExpiredHandler = () => {
      setUser(current => {
        if (!current) return current;
        localStorage.removeItem('bugtrack_user');
        localStorage.removeItem('bugtrack_token');
        setAuthNotice('Your session expired. Please sign in again.');
        return null;
      });
    };
    return () => { sessionExpiredHandler = null; };
  }, []);

  const handleLogin = (userData) => {
    if (userData?.token) {
      localStorage.setItem('bugtrack_token', userData.token);
    }
    localStorage.setItem('bugtrack_user', JSON.stringify(userData));
    setUser(userData);
    setAuthNotice('');
  };

  const refresh=async()=>{try{const p=new URLSearchParams({search:query,status,severity});const [b,s,c]=await Promise.all([api(`/api/bugs?${p}`),api('/api/summary'),api('/api/test-cases')]);setBugs(b);setSummary(s);setCases(c)}catch(e){if(e.status !== 401)setToast(e.message)}};
  useEffect(()=>{if(user) refresh()},[user,query,status,severity]);
  const notify=m=>{setToast(m);setTimeout(()=>setToast(''),2500)};
  if(!user)return <Login onLogin={handleLogin} notice={authNotice}/>;
  const logout=async()=>{try{await api('/api/logout',{method:'POST'})}finally{localStorage.removeItem('bugtrack_user');localStorage.removeItem('bugtrack_token');setUser(null);setAuthNotice('');setBugs([]);setCases([]);setSummary({});setSelected(null);setPage('Dashboard')}};
  const saveBug=async(data,file)=>{try{const required=['title','description','module','severity','priority','status','assignee'];const missing=required.find(key=>!String(data[key]||'').trim());if(missing)throw new Error(`Please complete the ${missing} field.`);let payload={...data};if(file){const form=new FormData();form.append('file',file);const uploaded=await api('/api/uploads',{method:'POST',body:form});payload.screenshot=uploaded.url}await api(data.id?`/api/bugs/${data.id}`:'/api/bugs',{method:data.id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});setModal(null);await refresh();notify(data.id?'Bug updated':'Bug created')}catch(e){notify(e.message)}};
  const moveBug=async(id,status)=>{try{const updated=await api(`/api/bugs/${id}/workflow`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,actor:user.name})});setSelected(updated);refresh();notify(`Bug moved to ${status}`)}catch(e){notify(e.message)}};
  const removeBug=async(id)=>{if(!confirm('Delete this bug report?'))return;await api(`/api/bugs/${id}`,{method:'DELETE'});setSelected(null);refresh();notify('Bug deleted')};
  const initials=user.name.split(/\s+/).map(part=>part[0]).join('').slice(0,2).toUpperCase();
  return <div className="app-shell"><aside className="sidebar"><div className="logo"><span className="logo-icon"><Bug size={20}/></span><b>BugTrack</b><strong>Pro</strong></div><div className="workspace"><span className="workspace-dot"/> Acme QA Workspace <ChevronDown size={14}/></div><nav><Nav icon={LayoutDashboard} label="Dashboard" active={page==='Dashboard'} onClick={()=>setPage('Dashboard')}/><Nav icon={Bug} label="Bug Reports" count={summary.open} active={page==='Bug Reports'} onClick={()=>setPage('Bug Reports')}/><Nav icon={TestTube2} label="Test Cases" active={page==='Test Cases'} onClick={()=>setPage('Test Cases')}/><Nav icon={ScanLine} label="Automated Bug Analyzer" active={page==='Automated Bug Analyzer'} onClick={()=>setPage('Automated Bug Analyzer')}/><Nav icon={BarChart3} label="Analytics" active={page==='Analytics'} onClick={()=>setPage('Analytics')}/></nav><div className="nav-section">WORKSPACE</div><Nav icon={FileText} label="Reports" onClick={()=>window.location.href=resolveApiUrl('/api/export')}/><Nav icon={Settings} label="Settings" active={page==='Settings'} onClick={()=>setPage('Settings')}/><div className="sidebar-bottom"><div className="help-card"><b>Need help?</b><small>Check the documentation</small><button>View docs →</button></div><button className="user-row" onClick={logout}><CircleUserRound/><span><b>{user.name}</b><small>{user.role}</small></span><LogOut size={15}/></button></div></aside><main className="main"><header><button className="mobile-menu"><Menu/></button><div><h2>{page}</h2><p className="muted">{page==='Dashboard'?`Good morning, ${user.name.split(' ')[0]}. Here is your quality overview.`:page==='Settings'?'Manage your workspace preferences and account settings.':page==='Automated Bug Analyzer'?'Analyze evidence safely and review proposed fixes.':'Track, prioritize, and resolve product quality.'}</p></div><div className="header-actions"><div className="avatar">{initials}</div></div></header>{page==='Dashboard'&&<Dashboard summary={summary} bugs={bugs} setPage={setPage} openBug={()=>setModal({type:'bug',data:emptyBug})}/>} {page==='Bug Reports'&&  <BugReports bugs={bugs} query={query} setQuery={setQuery} status={status} setStatus={setStatus} severity={severity} setSeverity={setSeverity} openBug={b=>setModal({type:'bug',data:b||emptyBug})} selected={selected} setSelected={setSelected} canEdit={canEdit} removeBug={removeBug} moveBug={moveBug} user={user}/>} {page==='Test Cases'&&<TestCases cases={cases} refresh={refresh} canEdit={canEdit} notify={notify}/>}   {page==='Automated Bug Analyzer'&&    <AutomatedAnalyzerV3 notify={notify} onIntegrated={refresh}/>} {page==='Analytics'&&<Analytics summary={summary} bugs={bugs} cases={cases}/>} {page==='Settings'&&<SettingsPage user={user} notify={notify}/>}</main>{modal&&<BugModal data={modal.data} close={()=>setModal(null)} save={saveBug}/>} {toast&&<div className="toast"><CheckCircle2 size={17}/>{toast}</div>}</div>;
}
function Dashboard({summary,bugs,setPage,openBug}) { const severityRows=[['Critical','red'],['Major','orange'],['Minor','yellow'],['Trivial','gray']].map(([label,tone])=>[label,bugs.filter(b=>b.severity===label).length,tone]); return <section className="content"><div className="welcome-row"><div><span className="eyebrow">OVERVIEW · OCTOBER 26, 2026</span><h1>Quality at a glance</h1></div><div><button className="secondary" onClick={()=>window.location.href=resolveApiUrl('/api/export')}><Download size={16}/> Export report</button><button className="primary" onClick={openBug}><Plus size={17}/> New bug report</button></div></div><div className="stats-grid"><Stat label="Total bugs" value={summary.total||0} delta="" tone="blue" icon={Bug}/><Stat label="Open bugs" value={summary.open||0} delta="" tone="orange" icon={AlertCircle}/><Stat label="In progress" value={summary.inProgress||0} delta="" tone="purple" icon={Activity}/><Stat label="Resolved" value={summary.resolved||0} delta="" tone="green" icon={CheckCircle2}/></div><div className="grid-two"><div className="panel chart-panel"><PanelTitle title="Bug trend" action="Current records"/><div className="chart-placeholder">{bugs.length?<><svg viewBox="0 0 640 180" preserveAspectRatio="none"><path className="gridline" d="M0 30H640M0 90H640M0 150H640"/><path className="area-blue" d={`M0 150L160 ${150-Math.min(100,bugs.length*8)}L320 ${150-Math.min(100,summary.open*8)}L480 ${150-Math.min(100,summary.inProgress*8)}L640 ${150-Math.min(100,summary.resolved*8)}V180H0Z`}/><path className="line-blue" d={`M0 150L160 ${150-Math.min(100,bugs.length*8)}L320 ${150-Math.min(100,summary.open*8)}L480 ${150-Math.min(100,summary.inProgress*8)}L640 ${150-Math.min(100,summary.resolved*8)}`}/></svg><div className="x-axis"><span>Total</span><span>Open</span><span>In progress</span><span>Resolved</span></div></>:<p className="muted empty">No bug history found.</p>}</div></div><div className="panel"><PanelTitle title="Bugs by severity" action="View all" onClick={()=>setPage('Bug Reports')}/><div className="severity-chart"><div className="donut"><span>{summary.total||0}<small>Total</small></span></div><div className="severity-list">{severityRows.map(([x,n,c])=><div className="severity-row" key={x}><span><i className={`dot ${c}`}/>{x}</span><b>{n}</b><div className="severity-bar"><i className={c} style={{width:`${summary.total?Math.max(4,n/summary.total*100):0}%`}}/></div></div>)}</div></div></div></div><div className="panel recent-panel"><PanelTitle title="Recent bug reports" action="View all bugs" onClick={()=>setPage('Bug Reports')}/><BugTable bugs={bugs.slice(0,4)} setSelected={undefined}/></div></section>; }
function BugReports({bugs,query,setQuery,status,setStatus,severity,setSeverity,openBug,selected,setSelected,canEdit,removeBug,moveBug,user}) { return <section className="content"><div className="page-toolbar"><div><span className="eyebrow">ISSUE MANAGEMENT</span><h1>All bug reports <span className="count-pill">{bugs.length}</span></h1></div>{canEdit&&<button className="primary" onClick={()=>openBug()}><Plus size={17}/> New bug report</button>}</div><div className="filter-bar"><div className="search"><Search size={17}/><input placeholder="Search by ID, title, module..." value={query} onChange={e=>setQuery(e.target.value)}/></div><select value={status} onChange={e=>setStatus(e.target.value)}><option>All</option>{statuses.map(s=><option key={s}>{s}</option>)}</select><select value={severity} onChange={e=>setSeverity(e.target.value)}><option>All</option>{['Critical','Major','Minor','Trivial'].map(s=><option key={s}>{s}</option>)}</select></div><div className="panel table-panel"><BugTable bugs={bugs} selected={selected} setSelected={setSelected}/>{selected&&<BugDetail bug={selected} close={()=>setSelected(null)} canEdit={canEdit} openBug={openBug} removeBug={removeBug} moveBug={moveBug} user={user}/>}</div></section>; }
function BugTable({bugs,selected,setSelected}) { return <div className="table-wrap"><table><thead><tr><th>Bug ID</th><th>Title</th><th>Module</th><th>Severity</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>{bugs.map(b=><tr key={b.id} className={selected?.id===b.id?'selected':''} onClick={()=>setSelected?.(b)}><td><b className="bug-id">{b.bug_key}</b>{b.is_demo?<span className="demo-tag">DEMO</span>:null}</td><td><strong>{b.title}</strong><small>{b.description?.slice(0,55)}…</small></td><td>{b.module}</td><td><span className={`severity ${b.severity.toLowerCase()}`}>{b.severity}</span></td><td><span className="priority">{b.priority}</span></td><td><span className={`status ${b.status.toLowerCase().replace(' ','-')}`}><i/>{b.status}</span></td><td>{b.assignee}</td><td className="muted">{new Date(b.updated_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td></tr>)}{!bugs.length&&<tr><td colSpan="8" className="empty">No bugs match your filters.</td></tr>}</tbody></table></div>; }
function BugDetail({bug,close,canEdit,openBug,removeBug,moveBug,user}) { const next={Open:'In Progress',Reopened:'In Progress','In Progress':'Fixed',Fixed:'Retesting',Retesting:'Closed'}[bug.status]; const canMove=next&&canEdit&&((next==='Fixed'&&user.role==='Developer')||(next==='Retesting'&&['Developer','QA Manager'].includes(user.role))||(next==='Closed'&&['Tester','QA Manager'].includes(user.role))||(next==='In Progress'&&['Developer','QA Manager'].includes(user.role))); return <div className="detail-drawer"><div className="drawer-head"><div><span className="bug-id">{bug.bug_key}</span><h2>{bug.title}</h2></div><button className="icon-btn" onClick={close}><X size={18}/></button></div><div className="workflow"><div className={`workflow-step ${['Open','Reopened'].includes(bug.status)?'current':''}`}>1<span>Reported</span></div><i/><div className={`workflow-step ${['In Progress'].includes(bug.status)?'current':''}`}>2<span>In progress</span></div><i/><div className={`workflow-step ${['Fixed'].includes(bug.status)?'current':''}`}>3<span>Fixed</span></div><i/><div className={`workflow-step ${['Retesting'].includes(bug.status)?'current':''}`}>4<span>Retesting</span></div><i/><div className={`workflow-step ${bug.status==='Closed'?'current':''}`}>5<span>{bug.status==='Reopened'?'Reopened':'Closed'}</span></div></div><div className="detail-meta"><span className={`severity ${bug.severity.toLowerCase()}`}>{bug.severity}</span><span className="priority">{bug.priority}</span><span className={`status ${bug.status.toLowerCase().replace(' ','-')}`}><i/>{bug.status}</span></div><p>{bug.description}</p><div className="detail-grid"><div><label>Module</label><b>{bug.module}</b></div><div><label>Assignee</label><b>{bug.assignee}</b></div><div><label>Steps to reproduce</label><pre>{bug.steps||'Not provided'}</pre></div><div><label>Expected result</label><p>{bug.expected||'Not provided'}</p></div><div><label>Actual result</label><p>{bug.actual||'Not provided'}</p></div><div><label>Source location</label><b>{bug.source_file||'Not linked'}{bug.source_line?`:${bug.source_line}`:''}</b></div><div><label>Recommended fix</label><p>{bug.recommendation||'No recommendation saved.'}</p></div></div><div className="workflow-actions">{canMove&&<button className="primary" onClick={()=>moveBug(bug.id,next)}>{next==='In Progress'?'Start investigation':next==='Fixed'?'Mark as fixed':next==='Retesting'?'Send to retesting':'Close bug'}</button>}{bug.status==='Retesting'&&canEdit&&['Tester','QA Manager'].includes(user.role)&&<button className="danger" onClick={()=>moveBug(bug.id,'Reopened')}>Reopen bug</button>}</div>{canEdit&&<div className="drawer-actions"><button className="secondary" onClick={()=>openBug(bug)}>Edit bug</button><button className="danger" onClick={()=>removeBug(bug.id)}><Trash2 size={15}/> Delete</button></div>}</div>; }
function TestCases({cases,refresh,canEdit,notify}) {
  const [form,setForm]=useState(false),[selected,setSelected]=useState(null),[visible,setVisible]=useState(cases),[query,setQuery]=useState(''),[priority,setPriority]=useState('All'),[status,setStatus]=useState('All');
  const [data,setData]=useState({title:'',module:'',steps:'',expected:'',objective:'',preconditions:'',input_data:'',priority:'P1',assignee:''});
  const set=(key,value)=>setData({...data,[key]:value});
  const load=()=>api(`/api/test-cases?${new URLSearchParams({search:query,priority,status})}`).then(items=>{setVisible(items);return items}).catch(e=>notify(e.message));
  const save=async()=>{try{const missing=['title','module','steps','expected'].find(key=>!data[key].trim());if(missing)throw new Error(`Please complete the ${missing} field.`);await api('/api/test-cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});setForm(false);setData({title:'',module:'',steps:'',expected:'',objective:'',preconditions:'',input_data:'',priority:'P1',assignee:'Maya Chen'});await refresh();notify('Test case created')}catch(e){notify(e.message)}};
  const update=async(id,changes)=>{try{const updated=await api(`/api/test-cases/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});setSelected(updated);await refresh();notify('Test case updated')}catch(e){notify(e.message)}};
  const remove=async(id)=>{if(!confirm('Delete this test case?'))return;try{await api(`/api/test-cases/${id}`,{method:'DELETE'});setSelected(null);await refresh();notify('Test case deleted')}catch(e){notify(e.message)}};
  useEffect(()=>{load().then(items=>{if(items)setSelected(selected&&items.find(item=>item.id===selected.id)||null)})},[query,priority,status,cases]);
  return <section className="content"><div className="page-toolbar"><div><span className="eyebrow">QUALITY COVERAGE</span><h1>Test cases <span className="count-pill">{cases.length}</span></h1></div>{canEdit&&<button className="primary" onClick={()=>setForm(!form)}><Plus size={17}/> New test case</button>}</div><div className="test-summary"><Stat label="Total cases" value={cases.length} delta="" tone="blue" icon={FileText}/><Stat label="Passed" value={cases.filter(c=>c.status==='Passed').length} delta="" tone="green" icon={CheckCircle2}/><Stat label="Failed" value={cases.filter(c=>c.status==='Failed').length} delta="" tone="orange" icon={AlertCircle}/><Stat label="Not run" value={cases.filter(c=>c.status==='Not Run').length} delta="" tone="purple" icon={BarChart3}/></div><div className="filter-bar"><div className="search"><Search size={17}/><input placeholder="Search ID, title, or bug ID..." value={query} onChange={e=>setQuery(e.target.value)}/></div><select value={priority} onChange={e=>setPriority(e.target.value)}><option>All</option><option>P0</option><option>P1</option><option>P2</option></select><select value={status} onChange={e=>setStatus(e.target.value)}><option>All</option><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select></div>{form&&<div className="panel case-form"><h3>Create test case</h3><div className="form-grid">{[['title','Title'],['module','Affected code/module'],['objective','Test objective'],['preconditions','Preconditions'],['input_data','Input data'],['steps','Test steps'],['expected','Expected result']].map(([key,label])=><label key={key}>{label}{['steps','expected','preconditions'].includes(key)?<textarea value={data[key]} onChange={e=>set(key,e.target.value)}/>:<input value={data[key]} onChange={e=>set(key,e.target.value)}/>}</label>)}<label>Priority<select value={data.priority} onChange={e=>set('priority',e.target.value)}><option>P0</option><option>P1</option><option>P2</option></select></label></div><button className="primary" onClick={save}>Create case</button></div>}<div className="panel table-panel"><div className="panel-title"><h3>Saved test suite</h3><span className="muted">Only executed or explicitly verified results may be Passed.</span></div><div className="table-wrap"><table><thead><tr><th>Case ID</th><th>Title</th><th>Related bug</th><th>Priority</th><th>Expected result</th><th>Status</th><th>Actions</th></tr></thead>  <tbody>{visible.map(c=><tr key={c.id} onClick={()=>setSelected(c)}><td><b className="bug-id">{c.case_key}</b></td><td><strong>{c.title}</strong><small>{c.objective||c.steps}</small></td><td>{c.related_bug_id?`BUG-${c.related_bug_id}`:'General validation'}</td><td><span className="priority">{c.priority||'P1'}</span></td><td>{c.expected}</td><td><span className={`test-result ${c.status.toLowerCase().replace(' ','-')}`}>{c.status}</span></td><td>{canEdit&&<button className="secondary" onClick={e=>{e.stopPropagation();update(c.id,{status:'Passed',actual:prompt('Observed actual result')||'',execution_notes:prompt('Execution notes')||''})}}>Record result</button>}{canEdit&&<button className="icon-btn" onClick={e=>{e.stopPropagation();remove(c.id)}}><Trash2 size={14}/></button>}</td></tr>)}</tbody></table></div></div>{selected&&<div className="panel detail-drawer"><div className="drawer-head"><div><span className="bug-id">{selected.case_key}</span><h2>{selected.title}</h2></div><button className="icon-btn" onClick={()=>setSelected(null)}><X size={18}/></button></div><div className="detail-grid"><div><label>Objective</label><p>{selected.objective||'Not provided'}</p></div><div><label>Preconditions</label><p>{selected.preconditions||'Not provided'}</p></div><div><label>Input data</label><p>{selected.input_data||'Not provided'}</p></div><div><label>Steps</label><pre>{selected.steps}</pre></div><div><label>Expected result</label><p>{selected.expected}</p></div><div><label>Actual result</label><textarea value={selected.actual||''} onChange={e=>setSelected({...selected,actual:e.target.value})}/></div><div><label>Execution notes</label><textarea value={selected.execution_notes||''} onChange={e=>setSelected({...selected,execution_notes:e.target.value})}/></div></div>{canEdit&&<div className="drawer-actions"><button className="primary" onClick={()=>update(selected.id,{actual:selected.actual||'',execution_notes:selected.execution_notes||'',status:selected.status})}>Save execution details</button><button className="danger" onClick={()=>remove(selected.id)}>Delete</button></div>}</div>}</section>;
}
function Analytics({summary,bugs,cases}) { return <section className="content"><div className="page-toolbar"><div><span className="eyebrow">INSIGHTS</span><h1>Quality analytics</h1></div><button className="secondary" onClick={()=>window.location.href=resolveApiUrl('/api/export')}><Download size={16}/> Download report</button></div><div className="stats-grid"><Stat label="Resolution rate" value={`${summary.total?Math.round(summary.resolved/summary.total*100):0}%`} delta="+8.4%" tone="green" icon={CheckCircle2}/><Stat label="Test pass rate" value={`${cases.length?Math.round(cases.filter(c=>c.status==='Passed').length/Math.max(1,cases.filter(c=>c.status!=='Not Run').length)*100):0}%`} delta="+5.2%" tone="blue" icon={TestTube2}/><Stat label="Critical bugs" value={bugs.filter(b=>b.severity==='Critical').length} delta="-12%" tone="orange" icon={AlertCircle}/><Stat label="Avg. time to fix" value="2.4d" delta="-0.6d" tone="purple" icon={Activity}/></div><div className="grid-two"><div className="panel"><PanelTitle title="Bugs by module"/>{[...new Set(bugs.map(b=>b.module))].map(m=><div className="module-row" key={m}><span>{m}</span><div><i style={{width:`${Math.max(20,bugs.filter(b=>b.module===m).length/bugs.length*100)}%`}}/></div><b>{bugs.filter(b=>b.module===m).length}</b></div>)}</div><div className="panel"><PanelTitle title="Execution summary"/><div className="execution"><div className="donut green-donut"><span>{summary.passed||0}<small>Passed</small></span></div><div><h2>{summary.tests?Math.round((summary.passed/summary.tests)*100):0}%</h2><p className="muted">overall pass rate</p></div></div></div></div></section>; }
function AutomatedAnalyzer({ notify }) {
  const [form,setForm]=useState({report:'',logs:'',steps:'',expected:'',actual:'',language:'Python'}), [files,setFiles]=useState([]), [result,setResult]=useState(null), [loading,setLoading]=useState(false), [fixes,setFixes]=useState({});
  const update=(key,value)=>setForm({...form,[key]:value});
  const analyze=async()=>{if(!form.report.trim()&&!form.logs.trim()&&!files.length){notify('Add a report, log, or source/project file first.');return}setLoading(true);try{const body=new FormData();Object.entries(form).forEach(([key,value])=>body.append(key,value));files.forEach(file=>body.append('files',file));const data=await api('/api/analyzer/analyze',{method:'POST',body});setResult(data);notify('Analysis completed')}catch(e){notify(e.message)}finally{setLoading(false)}};
  const generateFix=async(item)=>{try{const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item})});setFixes({...fixes,[item.id]:data})}catch(e){notify(e.message)}};
  const verify=async()=>{try{const data=await api(`/api/analyzer/${result.id}/verify`,{method:'POST'});setResult({...result,verification:data})}catch(e){notify(e.message)}};
  const reset=()=>{setForm({report:'',logs:'',steps:'',expected:'',actual:'',language:'Python'});setFiles([]);setResult(null);setFixes({})};
  return <section className="content analyzer-page"><div className="page-toolbar"><div><span className="eyebrow">STATIC ANALYSIS · SAFE WORKSPACE</span><h1>Automated Bug Analyzer</h1><p className="muted analyzer-subtitle">Submit evidence, inspect supported source, and review fixes before anything is changed.</p></div><div><button className="secondary" onClick={reset}>Reset</button>  <button className="primary" onClick={analyze} disabled={loading}><ScanLine size={16}/>{loading?'Analyzing...':'Analyze Code'}</button></div></div><div className="analyzer-grid"><div className="panel"><h3>Evidence and reproduction</h3><p className="muted helper">Supported: text reports, logs, screenshots, source files, and ZIP projects. Originals are preserved.</p><label className="analyzer-label">Bug report<textarea value={form.report} onChange={e=>update('report',e.target.value)} placeholder="Describe the suspected bug and impact..."/></label><div className="form-grid"><label>Error log / stack trace<textarea value={form.logs} onChange={e=>update('logs',e.target.value)} placeholder="Paste traceback or error output"/></label><label>Reproduction steps<textarea value={form.steps} onChange={e=>update('steps',e.target.value)} placeholder="1. Open login&#10;2. Click Submit"/></label><label>Expected result<textarea value={form.expected} onChange={e=>update('expected',e.target.value)}/></label><label>Actual result<textarea value={form.actual} onChange={e=>update('actual',e.target.value)}/></label></div><div className="form-grid"><label>Language<select value={form.language} onChange={e=>update('language',e.target.value)}><option>Python</option><option>JavaScript</option><option>TypeScript</option><option>Java</option></select></label><label>Source, screenshot, or ZIP<input type="file" multiple accept=".py,.js,.jsx,.ts,.tsx,.java,.json,.txt,.log,.html,.css,.zip,image/*" onChange={e=>setFiles([...e.target.files])}/><small className="field-help">25 MB request limit · ZIP paths are validated</small></label></div>{files.length>0&&<div className="file-list">{files.map(file=><span key={file.name}>{file.name}</span>)}</div>}</div><div className="panel analyzer-info"><h3>How analysis works</h3><div className="analysis-step"><b>01</b><span><strong>Validate</strong><small>Inputs and archive paths are checked before analysis.</small></span></div><div className="analysis-step"><b>02</b><span><strong>Inspect</strong><small>Python AST checks and safe pattern analysis run without executing uploads.</small></span></div><div className="analysis-step"><b>03</b><span><strong>Review</strong><small>Findings are labeled confirmed, potential, or unverified.</small></span></div><div className="analysis-step"><b>04</b><span><strong>Verify</strong><small>Verification remains separate from generated fix suggestions.</small></span></div></div></div>{result&&<div className="analysis-results"><div className="panel results-summary"><div><span className="eyebrow">ANALYSIS RESULT</span><h2>{result.findings.length?'Review detected issues':'No issues detected from available evidence'}</h2></div><div className="result-counts">    <b>{result.summary.total ?? result.summary.confirmed+result.summary.potential}<small>Issues found</small></b><b>{result.summary.confirmed}<small>Confirmed</small></b><b>{result.summary.potential}<small>Potential</small></b><b>{result.summary.incomplete}<small>Needs evidence</small></b><button className="secondary" onClick={verify}>Run verification</button><a className="secondary" href={`/api/analyzer/${result.id}/report`}>Download report</a></div></div>{result.findings.map(item=><div className="panel finding" key={item.id}><div className="finding-head"><div><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="verification-badge">{item.verification} · {Math.round(item.confidence*100)}% confidence</span><h3>{item.title}</h3><small>{item.id}{item.file?` · ${item.file}:${item.line||'?'}`:''}</small></div>  <button className="primary" onClick={()=>generateFix(item)}>Fix Code</button></div><div className="finding-grid"><span><strong>Category</strong>{item.category}</span><span><strong>Explanation</strong>{item.explanation}</span><span><strong>Evidence</strong>{item.evidence}</span><span><strong>Expected / actual</strong>{item.expected}<br/>{item.actual}</span><span><strong>Recommendation</strong>{item.recommendation}</span></div>{fixes[item.id]&&<div className="fix-review"><h4>Proposed fix · review required</h4><div className="code-columns"><pre>{fixes[item.id].original}</pre><pre>{fixes[item.id].proposed}</pre></div><p>{fixes[item.id].explanation}</p><button className="secondary" onClick={()=>notify('Fix approval is recorded in the controlled workspace; original uploads are unchanged.')}>Approve fix</button></div>}</div>)}{result.verification&&<div className="panel verification-panel"><h3>{result.verification.status}</h3>{result.verification.checks.map(check=><p key={check.name}>{check.name}: {check.status} — {check.output}</p>)}</div>}</div>}</section>;
}
function AutomatedAnalyzerV2({ notify }) {
  const [form,setForm]=useState({report:'',logs:'',steps:'',expected:'',actual:'',language:'Python'}),[files,setFiles]=useState([]),[result,setResult]=useState(null),[reports,setReports]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[fixes,setFixes]=useState({});
  const verdictFor=(summary)=>summary?.verdict||(summary?.confirmed||summary?.potential?'BUGS FOUND':summary?.incomplete?'ANALYSIS INCOMPLETE':'NO BUGS DETECTED');
  const detectLanguage=(file)=>({py:'Python',js:'JavaScript',jsx:'JavaScript',ts:'JavaScript',tsx:'JavaScript',html:'HTML',htm:'HTML',css:'CSS',java:'Java'}[file.name.split('.').pop()?.toLowerCase()]);
  const update=(key,value)=>setForm({...form,[key]:value});
  const loadReports=async()=>{try{setReports(await api('/api/analyzer/reports'))}catch(e){setError(e.message)}};
  useEffect(()=>{loadReports()},[]);
  const analyze=async()=>{setError('');if(!form.report.trim()&&!form.logs.trim()&&!files.length){setError('Paste source code, upload a source file, or provide an error log first.');return}setLoading(true);try{const body=new FormData();Object.entries(form).forEach(([key,value])=>body.append(key,value));files.forEach(file=>body.append('files',file));const data=await api('/api/analyzer/analyze',{method:'POST',body});setResult({...data,summary:{...data.summary,verdict:verdictFor(data.summary)}});await loadReports();notify('Static analysis completed.')}catch(e){setError(e.message);notify(`Analysis failed: ${e.message}`)}finally{setLoading(false)}};
  const resetForm=()=>{if(!window.confirm('Clear only the current form? Saved reports will not be deleted.'))return;setForm({report:'',logs:'',steps:'',expected:'',actual:'',language:'Python'});setFiles([])};
  const openReport=async(id)=>{try{const data=await api(`/api/analyzer/${id}`);setResult({...data,summary:{...data.summary,verdict:verdictFor(data.summary)}})}catch(e){setError(e.message)}};
  const deleteReport=async(id)=>{if(!window.confirm('Delete this saved analysis report and its uploaded workspace?'))return;try{await api(`/api/analyzer/${id}`,{method:'DELETE'});if(result?.id===id)setResult(null);await loadReports();notify('Report deleted')}catch(e){setError(e.message)}};
  const generateFix=async(item)=>{try{notify('Generating proposed fix...');const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item,source,language})});setFixes({...fixes,[item.id]:data});notify(data.is_valid?'Fix generated and validated.':'Fix generated (requires review).');}catch(e){setError(e.message);notify(`Fix generation failed: ${e.message}`);}};

  const copyFix=async(fix)=>{await navigator.clipboard.writeText(fix.proposed);notify('Proposed fix copied')};
  const approveFix=async(fix,item)=>{try{const data=await api(`/api/analyzer/fixes/${fix.id}/apply`,{method:'POST'});setFixes({...fixes,[item.id]:{...fix,status:data.status}});notify('Fix approved in the controlled workspace; original files remain unchanged.')}catch(e){setError(e.message)}};
  const verify=async()=>{try{const data=await api(`/api/analyzer/${result.id}/verify`,{method:'POST'});setResult({...result,verification:data})}catch(e){setError(e.message)}};
  return <section className="content analyzer-page"><div className="page-toolbar"><div><span className="eyebrow">STATIC ANALYSIS · PERSISTENT REPORTS</span><h1>Automated Bug Analyzer</h1><p className="muted analyzer-subtitle">Paste code in the bug report box or upload a source file. The result below tells you whether a bug was found.</p></div><div><button className="secondary" onClick={resetForm}>Reset form</button><button className="primary" onClick={analyze} disabled={loading}><ScanLine size={16}/>{loading?'Analyzing...':'Analyze bugs'}</button></div></div>{error&&<div className="analyzer-error">{error}</div>}<div className="analyzer-grid"><div className="panel"><h3>Evidence and reproduction</h3><p className="muted helper">Supported: text reports, logs, screenshots, source files, and ZIP projects.</p><label className="analyzer-label">Bug report<textarea value={form.report} onChange={e=>update('report',e.target.value)}/></label><div className="form-grid"><label>Error log / stack trace<textarea value={form.logs} onChange={e=>update('logs',e.target.value)}/></label><label>Reproduction steps<textarea value={form.steps} onChange={e=>update('steps',e.target.value)}/></label><label>Expected result<textarea value={form.expected} onChange={e=>update('expected',e.target.value)}/></label><label>Actual result<textarea value={form.actual} onChange={e=>update('actual',e.target.value)}/></label></div><div className="form-grid"><label>Language<select value={form.language} onChange={e=>update('language',e.target.value)}><option>Python</option><option>JavaScript</option><option>TypeScript</option><option>Java</option></select></label><label>Source, screenshot, or ZIP  <input type="file" multiple accept=".py,.js,.jsx,.ts,.tsx,.java,.html,.css,.zip" onChange={e=>{const selected=[...e.target.files];setFiles(selected);if(selected[0]&&detectLanguage(selected[0]))update('language',detectLanguage(selected[0]))}}/><small className="field-help">25 MB request limit · ZIP paths are validated</small></label></div>{files.length>0&&<div className="file-list">{files.map(file=><span key={file.name}>{file.name}</span>)}</div>}</div><div className="panel"><h3>Saved reports</h3>{!reports.length&&<p className="muted empty-report">No saved analyses yet.</p>}{reports.map(report=><div className="saved-report" key={report.id}><button onClick={()=>openReport(report.id)}><b>{new Date(report.created_at).toLocaleString()}</b><small>{report.language} · {report.summary.confirmed} confirmed · {report.summary.potential} potential</small></button><button className="delete-report" onClick={()=>deleteReport(report.id)}><Trash2 size={14}/></button></div>)}</div></div>{result&&<div className="analysis-results"><div className="panel results-summary"><div><span className="eyebrow">ANALYSIS RESULT</span>    <h2>{result.summary.verdict||'ANALYSIS INCOMPLETE'}</h2><p className="muted">{result.summary.verdict==='BUGS FOUND'?'Issues were found by the configured static checks.':result.summary.verdict==='NO BUGS DETECTED'?'No issues were detected by the configured analysis tools. This does not guarantee that the code is completely bug-free.':'The analysis could not make a complete determination. Correct the input or provide supported source code and retry.'}</p></div>  <div className="result-counts"><b>{result.summary.total ?? result.summary.confirmed+result.summary.potential}<small>Issues found</small></b><b>{result.summary.confirmed}<small>Confirmed</small></b><b>{result.summary.potential}<small>Potential</small></b><b>{result.summary.incomplete}<small>Needs evidence</small></b><button className="secondary" onClick={verify}>Verify fix</button><a className="secondary" href={`/api/analyzer/${result.id}/report`}>Download report</a></div></div>{result.findings.map(item=><div className="panel finding" key={item.id}><div className="finding-head"><div><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="verification-badge">{item.verification} · {Math.round(item.confidence*100)}% confidence</span><h3>{item.title}</h3><small>{item.id}{item.file?` · ${item.file}:${item.line||'?'}`:''}</small></div><button className="primary" onClick={()=>generateFix(item)}>Generate fix</button></div><div className="finding-grid"><span><strong>Root cause</strong>{item.explanation}</span><span><strong>Evidence</strong>{item.evidence}</span><span><strong>Expected / actual</strong>{item.expected}<br/>{item.actual}</span><span><strong>Steps to reproduce</strong>{result.inputs?.steps||'Not provided'}</span></div>{fixes[item.id]&&<div className="fix-review"><h4>Proposed fix · approval required</h4><div className="code-columns"><pre>{fixes[item.id].original}</pre><pre>{fixes[item.id].proposed}</pre></div><p>{fixes[item.id].explanation}</p>  <button className="secondary" onClick={()=>copyFix(fixes[item.id])}>Copy fix</button><button className="secondary" onClick={()=>{const blob=new Blob([fixes[item.id].proposed],{type:'text/plain'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${item.id}-proposed-fix.txt`;link.click();URL.revokeObjectURL(link.href)}}>Download fix</button><button className="primary" onClick={()=>approveFix(fixes[item.id],item)}>Approve fix</button></div>}</div>)}{result.verification&&<div className="panel verification-panel"><h3>{result.verification.status}</h3>{result.verification.checks.map(check=><p key={check.name}>{check.name}: {check.status} — {check.output}</p>)}</div>}</div>}</section>;
}
function AutomatedAnalyzerV3({ notify, onIntegrated }) {
  const [source,setSource]=useState(''),[filename,setFilename]=useState('main.py'),[language,setLanguage]=useState('Python'),[report,setReport]=useState(''),[files,setFiles]=useState([]),[result,setResult]=useState(null),[fixes,setFixes]=useState({}),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const detectLanguage=file=>({py:'Python',js:'JavaScript',jsx:'JavaScript',ts:'JavaScript',tsx:'JavaScript',java:'Java',html:'HTML',htm:'HTML',css:'CSS'}[file.name.split('.').pop()?.toLowerCase()]);
  const selectFiles=event=>{const selected=[...event.target.files];const detected=[...new Set(selected.map(detectLanguage).filter(Boolean))];setFiles(selected);if(selected[0])setFilename(selected[0].name);if(detected.length===1)setLanguage(detected[0]);};
  const analyze=async()=>{if(!source.trim()&&!files.length&&!report.trim()){setError('Paste source code, upload a source/ZIP file, or enter a report.');return}setLoading(true);setError('');try{const body=new FormData();body.append('source',source);body.append('source_filename',filename);body.append('language',language);body.append('report',report);files.forEach(file=>body.append('files',file));const data=await api('/api/analyzer/analyze',{method:'POST',body});if(data.summary?.verdict==='BUGS FOUND'){const integrated=await api('/api/analyzer/integrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysis_id:data.id,findings:data.findings,source_filename:filename,language})});await onIntegrated?.();notify(`${integrated.bugs.length} bug report(s) and ${integrated.test_cases.length} test case(s) saved.`)}setResult(data)}catch(e){setError(e.message);notify(`Analysis failed: ${e.message}`)}finally{setLoading(false)}};
  const generateFix=async(item)=>{try{const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item})});setFixes({...fixes,[item.id]:data})}catch(e){setError(e.message)}};
  const reset=()=>{if(confirm('Clear the current form? Saved reports are not deleted.')){setSource('');setReport('');setFiles([]);setResult(null);setFixes({})}};
  return <section className="content analyzer-page"><div className="page-toolbar"><div><span className="eyebrow">SOURCE ANALYSIS</span><h1>Automated Bug Analyzer</h1><p className="muted analyzer-subtitle">Paste code or upload a project. Results are based on the submitted source and configured checks.</p></div><div><button className="secondary" onClick={reset}>Reset form</button><button className="primary" onClick={analyze} disabled={loading}><ScanLine size={16}/>{loading?'Analyzing...':'Analyze code'}</button></div></div>{error&&<div className="analyzer-error">{error}</div>}<div className="analyzer-grid"><div className="panel"><h3>Code and evidence</h3><label className="analyzer-label">Source code<textarea className="source-editor" value={source} onChange={e=>setSource(e.target.value)} placeholder="Paste Python, JavaScript, Java, HTML, or CSS here..."/></label><div className="form-grid"><label>Filename<input value={filename} onChange={e=>setFilename(e.target.value)}/></label><label>Language<select value={language} onChange={e=>setLanguage(e.target.value)}><option>Python</option><option>JavaScript</option><option>Java</option><option>HTML</option><option>CSS</option></select></label></div><label className="analyzer-label">Bug report or logs<textarea value={report} onChange={e=>setReport(e.target.value)} placeholder="Optional error message, stack trace, expected and actual behavior"/></label><label className="analyzer-label">Upload source file, ZIP, or screenshot<input type="file" multiple accept=".py,.js,.jsx,.ts,.tsx,.java,.html,.css,.zip,image/*" onChange={selectFiles}/></label>{files.length>0&&<div className="file-list">{files.map(f=><span key={f.name}>{f.name}</span>)}</div>}</div><div className="panel"><h3>Analysis scope</h3><div className="analysis-step"><b>01</b><span><strong>Parse</strong><small>Syntax and language-specific source checks.</small></span></div><div className="analysis-step"><b>02</b><span><strong>Inspect</strong><small>Runtime-risk and suspicious-pattern checks without executing uploads.</small></span></div><div className="analysis-step"><b>03</b><span><strong>Classify</strong><small>Confirmed, potential, and unverified findings.</small></span></div></div></div>{result&&<div className="analysis-results"><div className="panel results-summary"><div><span className="eyebrow">ANALYSIS RESULT</span><h2>{result.summary.verdict}</h2><p className="muted">{result.summary.total} issue(s) returned by the analyzer.</p></div><div className="result-counts"><b>{result.summary.total}<small>Issues</small></b><b>{result.summary.confirmed}<small>Confirmed</small></b><b>{result.summary.potential}<small>Potential</small></b><b>{result.summary.incomplete}<small>Needs evidence</small></b></div></div>{result.findings.map(item=><div className="panel finding" key={item.id}><div className="finding-head"><div><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="verification-badge">{item.verification} · {Math.round(item.confidence*100)}%</span><h3>{item.title}</h3>  <small>{item.file||'Pasted source'}{item.line?`:${item.line}`:''}</small></div>{!['Informational','Unverified'].includes(item.verification)&&<button className="primary" onClick={()=>generateFix(item)}>Generate fix</button>}</div><div className="finding-grid"><span><strong>Root cause</strong>{item.explanation}</span><span><strong>Evidence</strong>{item.evidence}</span><span><strong>Suggested correction</strong>{item.recommendation}</span>  <span><strong>Original / corrected code</strong><pre>{item.original_code||'Not available'}{'\n--- suggested ---\n'}{item.corrected_code||'Review recommendation above.'}</pre></span></div>{fixes[item.id]&&<div className="fix-review"><h4>Proposed fix · {fixes[item.id].is_valid?'Validated ✓':'Validation review required'}</h4><div className="code-columns"><pre>{fixes[item.id].original||item.original_code||'Not available'}</pre><pre>{fixes[item.id].proposed||item.corrected_code||'No patch generated'}</pre></div><p>{fixes[item.id].explanation}</p>{fixes[item.id].validation&&<small className="field-help" style={{display:'block',marginTop:'0.4rem',color:fixes[item.id].is_valid?'#10b981':'#f59e0b'}}>Validation: {fixes[item.id].validation.message}</small>}</div>}</div>)}{!result.findings.filter(item=>!['Informational','Unverified'].includes(item.verification)).length&&<div className="panel empty-report"><h3>No confirmed or potential issues detected</h3><p className="muted">The submitted source completed the configured checks. Informational warnings are shown above; this is not a guarantee of runtime correctness.</p></div>}</div>}</section>;
}
function SettingsPage({ user, notify }) {
  const [tab, setTab] = useState('Profile'), [profile, setProfile] = useState({ name:user.name, email:user.email });
  const [notifications, setNotifications] = useState({ assigned:true, comments:true, digest:false });
  const save = (event) => { event.preventDefault(); notify('Settings saved successfully'); };
  const panel = tab === 'Profile' ? <div className="settings-section"><h3>Profile information</h3><p className="muted">Update the details associated with your BugTrack Pro account.</p><div className="settings-avatar"><span>MC</span><div><b>{user.role}</b><small>Account role is managed by your workspace administrator.</small></div></div><div className="form-grid"><label>Full name<input value={profile.name} onChange={e=>setProfile({...profile,name:e.target.value})}/></label><label>Email address<input value={profile.email} onChange={e=>setProfile({...profile,email:e.target.value})} type="email"/></label></div></div> : tab === 'Notifications' ? <div className="settings-section"><h3>Notification preferences</h3><p className="muted">Choose which updates you want to receive.</p><Toggle label="Bug assignments" description="Notify me when a bug is assigned to me." checked={notifications.assigned} onChange={()=>setNotifications({...notifications,assigned:!notifications.assigned})}/><Toggle label="Comments and mentions" description="Notify me when someone comments on my bugs." checked={notifications.comments} onChange={()=>setNotifications({...notifications,comments:!notifications.comments})}/><Toggle label="Weekly quality digest" description="Receive a summary of workspace activity every Monday." checked={notifications.digest} onChange={()=>setNotifications({...notifications,digest:!notifications.digest})}/></div> : tab === 'Security' ? <div className="settings-section"><h3>Security</h3><p className="muted">Password and session controls.</p><button type="button" className="secondary" onClick={()=>notify('Password reset instructions sent to your email')}>Send password reset link</button></div> : <div className="settings-section"><h3>Workspace</h3><p className="muted">Manage the workspace connected to your account.</p><div className="workspace-setting"><span className="workspace-dot"/> <div><b>Acme QA Workspace</b><small>Shared bug and test case workspace</small></div></div><label className="workspace-label">Workspace name<input defaultValue="Acme QA Workspace" /></label></div>;
  return <section className="content settings-page"><div className="page-toolbar"><div><span className="eyebrow">WORKSPACE CONFIGURATION</span><h1>Settings</h1></div><button className="primary" onClick={()=>notify('Settings saved successfully')}>Save changes</button></div><div className="settings-layout"><div className="settings-menu">{['Profile','Notifications','Security','Workspace'].map(item=><button key={item} className={`settings-tab ${tab===item?'active':''}`} onClick={()=>setTab(item)}>{item}</button>)}</div><form className="panel settings-card" onSubmit={save}>{panel}</form></div></section>;
}
function Toggle({ label, description, checked, onChange }) { return <label className="toggle-row"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={onChange}/><i/></label>; }
function BugModal({data:initial,close,save}) { const [data,setData]=useState(initial),[file,setFile]=useState(null), set=(k,v)=>setData({...data,[k]:v}); return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><span className="eyebrow">{data.id?'EDIT BUG':'NEW BUG REPORT'}</span><h2>{data.id?data.bug_key:'Create a bug report'}</h2></div><button className="icon-btn" onClick={close}><X size={18}/></button></div><div className="form-grid"><label>Title *<input value={data.title} onChange={e=>set('title',e.target.value)}/></label><label>Module *<select value={data.module} onChange={e=>set('module',e.target.value)}><option value="">Select module</option>{['Checkout','Authentication','Profile','Reports','Dashboard','Mobile'].map(x=><option key={x}>{x}</option>)}</select></label><label className="wide">Description *<textarea value={data.description} onChange={e=>set('description',e.target.value)}/></label><label>Severity<select value={data.severity} onChange={e=>set('severity',e.target.value)}>{['Critical','Major','Minor','Trivial'].map(x=><option key={x}>{x}</option>)}</select></label><label>Priority<select value={data.priority} onChange={e=>set('priority',e.target.value)}>{['P0','P1','P2','P3'].map(x=><option key={x}>{x}</option>)}</select></label><label>Status<select value={data.status} onChange={e=>set('status',e.target.value)}>{statuses.map(x=><option key={x}>{x}</option>)}</select></label><label>Assignee<select value={data.assignee} onChange={e=>set('assignee',e.target.value)}><option value="">Select assignee</option><option>Maya Chen</option><option>Alex Morgan</option><option>Jordan Lee</option></select></label><label className="wide">Steps to reproduce<textarea value={data.steps} onChange={e=>set('steps',e.target.value)}/></label><label>Expected result<textarea value={data.expected} onChange={e=>set('expected',e.target.value)}/></label><label>Actual result<textarea value={data.actual} onChange={e=>set('actual',e.target.value)}/></label><label className="wide">Screenshot<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setFile(e.target.files?.[0]||null)}/><small className="field-help">PNG, JPG, or WEBP up to 5 MB {file ? `· ${file.name}` : ''}</small></label></div><div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" onClick={()=>save(data,file)}>{data.id?'Save changes':'Create bug report'}</button></div></div></div>; }
createRoot(document.getElementById('root')).render(<App/>);
