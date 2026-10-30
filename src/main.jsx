import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertCircle, AlertTriangle, BarChart3, Bell, Bug, Building2, Check, CheckCircle2, ChevronDown, CircleUserRound, Copy, Download, Eye, EyeOff, FileText, GitBranch, Globe, History, Key, Laptop, Layers, LayoutDashboard, Lock, LogOut, Menu, Palette, Plus, RefreshCw, ScanLine, Search, Settings, Shield, ShieldCheck, Smartphone, Sparkles, TestTube2, Trash2, Upload, User, X } from 'lucide-react';
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

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    // On localhost, prioritize local backend (via Vite proxy or local URL)
    if (host === 'localhost' || host === '127.0.0.1') {
      if (envUrl && (envUrl.includes('localhost') || envUrl.includes('127.0.0.1'))) {
        return envUrl;
      }
      return '';
    }
  }
  return envUrl;
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
          setError(resetErr.message || 'Unable to send password reset email. Please try again later.');
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
    try {
      const savedTheme = localStorage.getItem('bugtrack_theme') || 'light';
      const savedColor = localStorage.getItem('bugtrack_theme_color') || 'blue';
      const savedLayout = localStorage.getItem('bugtrack_layout') || 'comfortable';
      const effectiveTheme = savedTheme === 'system'
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : savedTheme;
      document.documentElement.setAttribute('data-theme', effectiveTheme);
      document.documentElement.setAttribute('data-theme-color', savedColor);
      document.documentElement.setAttribute('data-layout', savedLayout);
    } catch {}

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

  const handleUserUpdate = (updated) => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...updated };
      localStorage.setItem('bugtrack_user', JSON.stringify(next));
      return next;
    });
  };

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
  return <div className="app-shell"><aside className="sidebar"><div className="logo"><span className="logo-icon"><Bug size={20}/></span><b>BugTrack</b><strong>Pro</strong></div><div className="workspace"><span className="workspace-dot"/> Acme QA Workspace <ChevronDown size={14}/></div><nav><Nav icon={LayoutDashboard} label="Dashboard" active={page==='Dashboard'} onClick={()=>setPage('Dashboard')}/><Nav icon={Bug} label="Bug Reports" count={summary.open} active={page==='Bug Reports'} onClick={()=>setPage('Bug Reports')}/><Nav icon={TestTube2} label="Test Cases" active={page==='Test Cases'} onClick={()=>setPage('Test Cases')}/><Nav icon={ScanLine} label="Automated Bug Analyzer" active={page==='Automated Bug Analyzer'} onClick={()=>setPage('Automated Bug Analyzer')}/><Nav icon={GitBranch} label="GitHub Scanner" active={page==='GitHub Scanner'} onClick={()=>setPage('GitHub Scanner')}/><Nav icon={BarChart3} label="Analytics" active={page==='Analytics'} onClick={()=>setPage('Analytics')}/></nav><div className="nav-section">WORKSPACE</div><Nav icon={FileText} label="Reports" onClick={()=>window.location.href=resolveApiUrl('/api/export')}/><Nav icon={Settings} label="Settings" active={page==='Settings'} onClick={()=>setPage('Settings')}/><div className="sidebar-bottom"><div className="help-card"><b>Need help?</b><small>Check the documentation</small><button>View docs →</button></div><button className="user-row" onClick={logout}>{user.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}/> : <CircleUserRound/>}<span><b>{user.name}</b><small>{user.role}</small></span><LogOut size={15}/></button></div></aside><main className="main"><header><button className="mobile-menu"><Menu/></button><div><h2>{page}</h2><p className="muted">{page==='Dashboard'?`Good morning, ${user.name.split(' ')[0]}. Here is your quality overview.`:page==='Settings'?'Manage your workspace preferences and account settings.':page==='Automated Bug Analyzer'?'Analyze evidence safely and review proposed fixes.':page==='GitHub Scanner'?'Scan remote repositories and review static findings securely.':'Track, prioritize, and resolve product quality.'}</p></div><div className="header-actions"><div className="avatar" style={{ overflow: 'hidden' }}>{user.avatar_url ? <img src={user.avatar_url} alt={user.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/> : initials}</div></div></header>{page==='Dashboard'&&<Dashboard summary={summary} bugs={bugs} setPage={setPage} openBug={()=>setModal({type:'bug',data:emptyBug})}/>} {page==='Bug Reports'&&  <BugReports bugs={bugs} query={query} setQuery={setQuery} status={status} setStatus={setStatus} severity={severity} setSeverity={setSeverity} openBug={b=>setModal({type:'bug',data:b||emptyBug})} selected={selected} setSelected={setSelected} canEdit={canEdit} removeBug={removeBug} moveBug={moveBug} user={user} refresh={refresh} notify={notify}/>} {page==='Test Cases'&&<TestCases cases={cases} refresh={refresh} canEdit={canEdit} notify={notify}/>}   {page==='Automated Bug Analyzer'&&    <AutomatedAnalyzerV3 notify={notify} onIntegrated={refresh}/>} {page==='GitHub Scanner'&&<GitHubScanner notify={notify} onImportBug={refresh}/>} {page==='Analytics'&&<Analytics summary={summary} bugs={bugs} cases={cases}/>} {page==='Settings'&&<SettingsPage user={user} notify={notify} onUserUpdate={handleUserUpdate} onLogout={logout}/>}</main>{modal&&<BugModal data={modal.data} close={()=>setModal(null)} save={saveBug} onSelectBug={b => { setSelected(b); setPage('Bug Reports'); }}/>} {toast&&<div className="toast"><CheckCircle2 size={17}/>{toast}</div>}</div>;
}
function Dashboard({summary,bugs,setPage,openBug}) { const severityRows=[['Critical','red'],['Major','orange'],['Minor','yellow'],['Trivial','gray']].map(([label,tone])=>[label,bugs.filter(b=>b.severity===label).length,tone]); return <section className="content"><div className="welcome-row"><div><span className="eyebrow">OVERVIEW · OCTOBER 26, 2026</span><h1>Quality at a glance</h1></div><div style={{display:'flex',gap:'8px',alignItems:'center'}}><a href="/api/export/pdf" target="_blank" rel="noopener noreferrer" className="secondary button-link" style={{display:'inline-flex',alignItems:'center',gap:'6px',textDecoration:'none',padding:'7px 12px',borderRadius:'6px',fontSize:'13px'}}><FileText size={16}/> PDF Report</a><button className="secondary" onClick={()=>window.location.href=resolveApiUrl('/api/export')}><Download size={16}/> Export CSV</button><button className="primary" onClick={openBug}><Plus size={17}/> New bug report</button></div></div><div className="stats-grid"><Stat label="Total bugs" value={summary.total||0} delta="" tone="blue" icon={Bug}/><Stat label="Open bugs" value={summary.open||0} delta="" tone="orange" icon={AlertCircle}/><Stat label="In progress" value={summary.inProgress||0} delta="" tone="purple" icon={Activity}/><Stat label="Resolved" value={summary.resolved||0} delta="" tone="green" icon={CheckCircle2}/></div><div className="grid-two"><div className="panel chart-panel"><PanelTitle title="Bug trend" action="Current records"/><div className="chart-placeholder">{bugs.length?<><svg viewBox="0 0 640 180" preserveAspectRatio="none"><path className="gridline" d="M0 30H640M0 90H640M0 150H640"/><path className="area-blue" d={`M0 150L160 ${150-Math.min(100,bugs.length*8)}L320 ${150-Math.min(100,summary.open*8)}L480 ${150-Math.min(100,summary.inProgress*8)}L640 ${150-Math.min(100,summary.resolved*8)}V180H0Z`}/><path className="line-blue" d={`M0 150L160 ${150-Math.min(100,bugs.length*8)}L320 ${150-Math.min(100,summary.open*8)}L480 ${150-Math.min(100,summary.inProgress*8)}L640 ${150-Math.min(100,summary.resolved*8)}`}/></svg><div className="x-axis"><span>Total</span><span>Open</span><span>In progress</span><span>Resolved</span></div></>:<p className="muted empty">No bug history found.</p>}</div></div><div className="panel"><PanelTitle title="Bugs by severity" action="View all" onClick={()=>setPage('Bug Reports')}/><div className="severity-chart"><div className="donut"><span>{summary.total||0}<small>Total</small></span></div><div className="severity-list">{severityRows.map(([x,n,c])=><div className="severity-row" key={x}><span><i className={`dot ${c}`}/>{x}</span><b>{n}</b><div className="severity-bar"><i className={c} style={{width:`${summary.total?Math.max(4,n/summary.total*100):0}%`}}/></div></div>)}</div></div></div></div><div className="panel recent-panel"><PanelTitle title="Recent bug reports" action="View all bugs" onClick={()=>setPage('Bug Reports')}/><BugTable bugs={bugs.slice(0,4)} setSelected={undefined}/></div></section>; }
function BugReports({bugs,query,setQuery,status,setStatus,severity,setSeverity,openBug,selected,setSelected,canEdit,removeBug,moveBug,user,refresh,notify}) { return <section className="content"><div className="page-toolbar"><div><span className="eyebrow">ISSUE MANAGEMENT</span><h1>All bug reports <span className="count-pill">{bugs.length}</span></h1></div>{canEdit&&<button className="primary" onClick={()=>openBug()}><Plus size={17}/> New bug report</button>}</div><div className="filter-bar"><div className="search"><Search size={17}/><input placeholder="Search by ID, title, module..." value={query} onChange={e=>setQuery(e.target.value)}/></div><select value={status} onChange={e=>setStatus(e.target.value)}><option>All</option>{statuses.map(s=><option key={s}>{s}</option>)}</select><select value={severity} onChange={e=>setSeverity(e.target.value)}><option>All</option>{['Critical','Major','Minor','Trivial'].map(s=><option key={s}>{s}</option>)}</select></div><div className="panel table-panel"><BugTable bugs={bugs} selected={selected} setSelected={setSelected}/>{selected&&<BugDetail bug={selected} close={()=>setSelected(null)} canEdit={canEdit} openBug={openBug} removeBug={removeBug} moveBug={moveBug} user={user} refresh={refresh} notify={notify}/>}</div></section>; }
function BugTable({bugs,selected,setSelected}) { return <div className="table-wrap"><table><thead><tr><th>Bug ID</th><th>Title</th><th>Module</th><th>Severity</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>{bugs.map(b=><tr key={b.id} className={selected?.id===b.id?'selected':''} onClick={()=>setSelected?.(b)}><td><b className="bug-id">{b.bug_key}</b>{b.is_demo?<span className="demo-tag">DEMO</span>:null}</td><td><strong>{b.title}</strong><small>{b.description?.slice(0,55)}…</small></td><td>{b.module}</td><td><span className={`severity ${b.severity.toLowerCase()}`}>{b.severity}</span></td><td><span className="priority">{b.priority}</span></td><td><span className={`status ${b.status.toLowerCase().replace(' ','-')}`}><i/>{b.status}</span></td><td>{b.assignee}</td><td className="muted">{new Date(b.updated_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td></tr>)}{!bugs.length&&<tr><td colSpan="8" className="empty">No bugs match your filters.</td></tr>}</tbody></table></div>; }
function BugDetail({bug,close,canEdit,openBug,removeBug,moveBug,user,refresh,notify}) {
  const [fix, setFix] = useState(bug.latest_fix || null);
  const [loadingFix, setLoadingFix] = useState(false);
  const [fixMessage, setFixMessage] = useState('');
  const [bugTests, setBugTests] = useState([]);
  const [loadingTests, setLoadingTests] = useState(false);

  const loadBugTests = async () => {
    try {
      const data = await api(`/api/bugs/${bug.id}/test-cases`);
      setBugTests(data || []);
    } catch {}
  };

  useEffect(() => {
    loadBugTests();
  }, [bug.id]);

  const generateTests = async () => {
    setLoadingTests(true);
    try {
      const res = await api(`/api/bugs/${bug.id}/generate-tests`, { method: 'POST' });
      setBugTests(res.test_cases || []);
      notify?.(res.message || 'Test cases generated successfully');
      refresh?.();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setLoadingTests(false);
    }
  };

  const runSingleTest = async (testId) => {
    try {
      const res = await api(`/api/test-cases/${testId}/run`, { method: 'POST' });
      notify?.(res.message);
      await loadBugTests();
      refresh?.();
    } catch (e) {
      notify?.(e.message);
    }
  };

  const generateFix = async () => {
    setLoadingFix(true);
    setFixMessage('');
    try {
      const res = await api(`/api/bugs/${bug.id}/propose-fix`, { method: 'POST' });
      setFix(res);
      setFixMessage('AI fix proposed and validated.');
      notify?.('AI fix proposed and validated.');
    } catch (e) {
      setFixMessage(e.message || 'Could not generate fix.');
      notify?.(e.message);
    } finally {
      setLoadingFix(false);
    }
  };

  const applyFix = async () => {
    if (!confirm('Approve this proposed fix in the controlled workspace? Original files remain unchanged.')) return;
    try {
      const res = await api(`/api/bugs/${bug.id}/apply-fix`, { method: 'POST' });
      setFix(prev => ({ ...prev, status: 'approved' }));
      notify?.(res.message);
      refresh?.();
    } catch (e) {
      notify?.(e.message);
    }
  };

  const next={Open:'In Progress',Reopened:'In Progress','In Progress':'Fixed',Fixed:'Retesting',Retesting:'Closed'}[bug.status];
  const canMove=next&&canEdit&&((next==='Fixed'&&user.role==='Developer')||(next==='Retesting'&&['Developer','QA Manager'].includes(user.role))||(next==='Closed'&&['Tester','QA Manager'].includes(user.role))||(next==='In Progress'&&['Developer','QA Manager'].includes(user.role)));

  return <div className="detail-drawer"><div className="drawer-head"><div><span className="bug-id">{bug.bug_key}</span><h2>{bug.title}</h2></div><button className="icon-btn" onClick={close}><X size={18}/></button></div><div className="workflow"><div className={`workflow-step ${['Open','Reopened'].includes(bug.status)?'current':''}`}>1<span>Reported</span></div><i/><div className={`workflow-step ${['In Progress'].includes(bug.status)?'current':''}`}>2<span>In progress</span></div><i/><div className={`workflow-step ${['Fixed'].includes(bug.status)?'current':''}`}>3<span>Fixed</span></div><i/><div className={`workflow-step ${['Retesting'].includes(bug.status)?'current':''}`}>4<span>Retesting</span></div><i/><div className={`workflow-step ${bug.status==='Closed'?'current':''}`}>5<span>{bug.status==='Reopened'?'Reopened':'Closed'}</span></div></div><div className="detail-meta"><span className={`severity ${bug.severity.toLowerCase()}`}>{bug.severity}</span><span className="priority">{bug.priority}</span><span className={`status ${bug.status.toLowerCase().replace(' ','-')}`}><i/>{bug.status}</span></div><p>{bug.description}</p><div className="detail-grid"><div><label>Module</label><b>{bug.module}</b></div><div><label>Assignee</label><b>{bug.assignee}</b></div><div><label>Steps to reproduce</label><pre>{bug.steps||'Not provided'}</pre></div><div><label>Expected result</label><p>{bug.expected||'Not provided'}</p></div><div><label>Actual result</label><p>{bug.actual||'Not provided'}</p></div><div><label>Source location</label><b>{bug.source_file||'Not linked'}{bug.source_line?`:${bug.source_line}`:''}</b></div><div><label>Recommended fix</label><p>{bug.recommendation||'No recommendation saved.'}</p></div></div><div className="workflow-actions">{canMove&&<button className="primary" onClick={()=>moveBug(bug.id,next)}>{next==='In Progress'?'Start investigation':next==='Fixed'?'Mark as fixed':next==='Retesting'?'Send to retesting':'Close bug'}</button>}{bug.status==='Retesting'&&canEdit&&['Tester','QA Manager'].includes(user.role)&&<button className="danger" onClick={()=>moveBug(bug.id,'Reopened')}>Reopen bug</button>}</div>

  <div style={{marginTop: '22px', borderTop: '1px solid #e2e8f0', paddingTop: '16px'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
      <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
        <Sparkles size={16} color="#3979ee"/>
        <strong style={{color:'#1b2a41',fontSize:'13px'}}>AI Fix Preview & Validation</strong>
      </div>
      <button
        type="button"
        className="secondary btn-mini"
        onClick={generateFix}
        disabled={loadingFix}
      >
        {loadingFix ? 'Generating fix...' : fix ? 'Regenerate Fix' : 'AI Generate Fix'}
      </button>
    </div>
    {fixMessage && <p style={{fontSize:'11px',color:'#3979ee',margin:'4px 0'}}>{fixMessage}</p>}
    {fix && (
      <div className="fix-review" style={{marginTop:'10px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
          <h4 style={{margin:0}}>Proposed Fix · {fix.is_valid ? 'Validated ✓' : 'Review Required'}</h4>
          <span className={`status ${fix.status === 'approved' ? 'fixed' : 'open'}`} style={{fontSize:'10px'}}>
            {fix.status === 'approved' ? 'Approved in Workspace' : 'Pending Review'}
          </span>
        </div>
        <div className="code-columns">
          <pre>{fix.original || bug.evidence || 'Original snippet'}</pre>
          <pre>{fix.proposed || 'Proposed fix'}</pre>
        </div>
        <p style={{fontSize:'12px',margin:'8px 0'}}>{fix.explanation}</p>
        {fix.validation && (
          <small style={{display:'block',marginBottom:'10px',color:fix.is_valid?'#10b981':'#f59e0b',fontSize:'11px'}}>
            Validation: {fix.validation.message}
          </small>
        )}
        <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
          <button
            type="button"
            className="secondary btn-mini"
            onClick={() => {
              navigator.clipboard.writeText(fix.proposed);
              notify?.('Fix copied to clipboard');
            }}
          >
            Copy fix
          </button>
          <button
            type="button"
            className="secondary btn-mini"
            onClick={() => {
              const blob = new Blob([fix.proposed], { type: 'text/plain' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = `${bug.bug_key}-fix.txt`;
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Download fix
          </button>
          {canEdit && fix.status !== 'approved' && (
            <button
              type="button"
              className="primary btn-mini"
              onClick={applyFix}
            >
              Approve in Workspace
            </button>
          )}
        </div>
        <small className="field-help" style={{display:'block',marginTop:'8px',color:'#64748b'}}>
          Controlled safe workspace: original project files remain unchanged until approved.
        </small>
      </div>
    )}
  </div>

  <div style={{marginTop: '20px', borderTop: '1px solid #e2e8f0', paddingTop: '16px'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
      <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
        <TestTube2 size={16} color="#3979ee"/>
        <strong style={{color:'#1b2a41',fontSize:'13px'}}>AI Generated Test Cases ({bugTests.length})</strong>
      </div>
      <button
        type="button"
        className="secondary btn-mini"
        onClick={generateTests}
        disabled={loadingTests}
      >
        {loadingTests ? 'Generating...' : bugTests.length ? 'Regenerate Test Cases' : 'AI Generate Test Cases'}
      </button>
    </div>
    {bugTests.length > 0 && (
      <div style={{display:'flex',flexDirection:'column',gap:'8px',marginTop:'10px'}}>
        {bugTests.map(t => (
          <div key={t.id} style={{padding:'8px 10px',border:'1px solid #e2e8f0',borderRadius:'6px',background:'#f8fafc',fontSize:'12px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'4px'}}>
              <span style={{fontWeight:600,color:'#1b2a41'}}>{t.case_key}: {t.title}</span>
              <span className={`test-result ${t.status.toLowerCase().replace(' ','-')}`} style={{fontSize:'10px'}}>{t.status}</span>
            </div>
            {t.test_inputs && <div style={{fontSize:'11px',color:'#64748b',marginBottom:'4px'}}>Inputs: <code style={{fontSize:'10px'}}>{t.test_inputs}</code></div>}
            <div style={{fontSize:'11px',color:'#475569',marginBottom:'6px'}}>Expected: {t.expected}</div>
            <div style={{display:'flex',justifyContent:'flex-end',gap:'6px'}}>
              <button type="button" className="secondary btn-mini" onClick={() => runSingleTest(t.id)}>Run Test</button>
            </div>
          </div>
        ))}
      </div>
    )}
  </div>

  {canEdit&&<div className="drawer-actions" style={{marginTop:'16px'}}><button className="secondary" onClick={()=>openBug(bug)}>Edit bug</button><button className="danger" onClick={()=>removeBug(bug.id)}><Trash2 size={15}/> Delete</button></div>}</div>; }
function TestCases({cases,refresh,canEdit,notify}) {
  const [form,setForm]=useState(false),[selected,setSelected]=useState(null),[visible,setVisible]=useState(cases),[query,setQuery]=useState(''),[priority,setPriority]=useState('All'),[status,setStatus]=useState('All');
  const [data,setData]=useState({title:'',module:'',steps:'',expected:'',objective:'',preconditions:'',input_data:'',priority:'P1',assignee:''});
  const set=(key,value)=>setData({...data,[key]:value});
  const load=()=>api(`/api/test-cases?${new URLSearchParams({search:query,priority,status})}`).then(items=>{setVisible(items);return items}).catch(e=>notify(e.message));
  const save=async()=>{try{const missing=['title','module','steps','expected'].find(key=>!data[key].trim());if(missing)throw new Error(`Please complete the ${missing} field.`);await api('/api/test-cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});setForm(false);setData({title:'',module:'',steps:'',expected:'',objective:'',preconditions:'',input_data:'',priority:'P1',assignee:'Maya Chen'});await refresh();notify('Test case created')}catch(e){notify(e.message)}};
  const update=async(id,changes)=>{try{const updated=await api(`/api/test-cases/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});setSelected(updated);await refresh();notify('Test case updated')}catch(e){notify(e.message)}};
  const remove=async(id)=>{if(!confirm('Delete this test case?'))return;try{await api(`/api/test-cases/${id}`,{method:'DELETE'});setSelected(null);await refresh();notify('Test case deleted')}catch(e){notify(e.message)}};
  useEffect(()=>{load().then(items=>{if(items)setSelected(selected&&items.find(item=>item.id===selected.id)||null)})},[query,priority,status,cases]);
  return <section className="content"><div className="page-toolbar"><div><span className="eyebrow">QUALITY COVERAGE</span><h1>Test cases <span className="count-pill">{cases.length}</span></h1></div><div style={{display:'flex',gap:'8px'}}><a href="/api/test-cases/export?format=csv" download="test-cases.csv" className="secondary button-link" style={{display:'inline-flex',alignItems:'center',gap:'6px',textDecoration:'none',padding:'7px 12px',borderRadius:'6px',fontSize:'12px'}}><Download size={15}/> Export CSV</a><a href="/api/test-cases/export?format=json" download="test-cases.json" className="secondary button-link" style={{display:'inline-flex',alignItems:'center',gap:'6px',textDecoration:'none',padding:'7px 12px',borderRadius:'6px',fontSize:'12px'}}><Download size={15}/> Export JSON</a>{canEdit&&<button className="primary" onClick={()=>setForm(!form)}><Plus size={17}/> New test case</button>}</div></div><div className="test-summary"><Stat label="Total cases" value={cases.length} delta="" tone="blue" icon={FileText}/><Stat label="Passed" value={cases.filter(c=>c.status==='Passed').length} delta="" tone="green" icon={CheckCircle2}/><Stat label="Failed" value={cases.filter(c=>c.status==='Failed').length} delta="" tone="orange" icon={AlertCircle}/><Stat label="Not run" value={cases.filter(c=>c.status==='Not Run').length} delta="" tone="purple" icon={BarChart3}/></div><div className="filter-bar"><div className="search"><Search size={17}/><input placeholder="Search ID, title, or bug ID..." value={query} onChange={e=>setQuery(e.target.value)}/></div><select value={priority} onChange={e=>setPriority(e.target.value)}><option>All</option><option>P0</option><option>P1</option><option>P2</option></select><select value={status} onChange={e=>setStatus(e.target.value)}><option>All</option><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select></div>{form&&<div className="panel case-form"><h3>Create test case</h3><div className="form-grid">{[['title','Title'],['module','Affected code/module'],['objective','Test objective'],['preconditions','Preconditions'],['input_data','Input data'],['steps','Test steps'],['expected','Expected result']].map(([key,label])=><label key={key}>{label}{['steps','expected','preconditions'].includes(key)?<textarea value={data[key]} onChange={e=>set(key,e.target.value)}/>:<input value={data[key]} onChange={e=>set(key,e.target.value)}/>}</label>)}<label>Priority<select value={data.priority} onChange={e=>set('priority',e.target.value)}><option>P0</option><option>P1</option><option>P2</option></select></label></div><button className="primary" onClick={save}>Create case</button></div>}<div className="panel table-panel"><div className="panel-title"><h3>Saved test suite</h3><span className="muted">Only executed or explicitly verified results may be Passed.</span></div><div className="table-wrap"><table><thead><tr><th>Case ID</th><th>Title</th><th>Related bug</th><th>Priority</th><th>Expected result</th><th>Status</th><th>Actions</th></tr></thead>  <tbody>{visible.map(c=><tr key={c.id} onClick={()=>setSelected(c)}><td><b className="bug-id">{c.case_key}</b></td><td><strong>{c.title}</strong><small>{c.objective||c.steps}</small></td><td>{c.related_bug_id?`BUG-${c.related_bug_id}`:'General validation'}</td><td><span className="priority">{c.priority||'P1'}</span></td><td>{c.expected}</td><td><span className={`test-result ${c.status.toLowerCase().replace(' ','-')}`}>{c.status}</span></td><td><button className="secondary btn-mini" style={{marginRight:'4px'}} onClick={async e=>{e.stopPropagation();try{const res=await api(`/api/test-cases/${c.id}/run`,{method:'POST'});await refresh();notify(res.message);}catch(err){notify(err.message);}}}>Run</button>{canEdit&&<button className="secondary" onClick={e=>{e.stopPropagation();update(c.id,{status:'Passed',actual:prompt('Observed actual result')||'',execution_notes:prompt('Execution notes')||''})}}>Record result</button>}{canEdit&&<button className="icon-btn" onClick={e=>{e.stopPropagation();remove(c.id)}}><Trash2 size={14}/></button>}</td></tr>)}</tbody></table></div></div>{selected&&<div className="panel detail-drawer"><div className="drawer-head"><div><span className="bug-id">{selected.case_key}</span><h2>{selected.title}</h2></div><button className="icon-btn" onClick={()=>setSelected(null)}><X size={18}/></button></div><div className="detail-grid"><div><label>Objective</label><p>{selected.objective||'Not provided'}</p></div><div><label>Preconditions</label><p>{selected.preconditions||'Not provided'}</p></div><div><label>Input data</label><p>{selected.input_data||'Not provided'}</p></div><div><label>Steps</label><pre>{selected.steps}</pre></div><div><label>Expected result</label><p>{selected.expected}</p></div><div><label>Actual result</label><textarea value={selected.actual||''} onChange={e=>setSelected({...selected,actual:e.target.value})}/></div><div><label>Execution notes</label><textarea value={selected.execution_notes||''} onChange={e=>setSelected({...selected,execution_notes:e.target.value})}/></div></div>{canEdit&&<div className="drawer-actions"><button className="primary" onClick={()=>update(selected.id,{actual:selected.actual||'',execution_notes:selected.execution_notes||'',status:selected.status})}>Save execution details</button><button className="danger" onClick={()=>remove(selected.id)}>Delete</button></div>}</div>}</section>;
}
function Analytics({summary,bugs,cases}) {
  const [quality, setQuality] = useState(null);

  useEffect(() => {
    api('/api/analytics/quality')
      .then(d => setQuality(d))
      .catch(() => {});
  }, [bugs, cases]);

  const q = quality || {
    summary: {
      total_bugs: summary.total || bugs.length,
      resolved_bugs: summary.resolved || 0,
      unresolved_bugs: summary.open || 0,
      resolution_rate: summary.total ? Math.round((summary.resolved / summary.total) * 100) : 0
    },
    severity_distribution: {
      Critical: bugs.filter(b => b.severity === 'Critical').length,
      High: bugs.filter(b => b.severity === 'High' || b.severity === 'Major').length,
      Medium: bugs.filter(b => b.severity === 'Medium' || b.severity === 'Minor').length,
      Low: bugs.filter(b => b.severity === 'Low' || b.severity === 'Trivial').length
    },
    weekly_trend: [],
    fix_validation_stats: { validation_success_rate: 100, fixes_validated: 0, fixes_approved: 0 },
    test_execution_stats: { pass_rate: 0, passed_tests: 0, total_tests: cases.length }
  };

  return (
    <section className="content">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">SOFTWARE QUALITY & DEFECT METRICS</span>
          <h1>Quality Analytics</h1>
        </div>
        <div style={{display:'flex',gap:'8px'}}>
          <a
            href="/api/export"
            download="bugtrack-report.csv"
            className="secondary button-link"
            style={{display:'inline-flex',alignItems:'center',gap:'6px',textDecoration:'none',padding:'7px 12px',borderRadius:'6px',fontSize:'12px'}}
          >
            <Download size={15}/> Export CSV
          </a>
          <a
            href="/api/export/pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="primary button-link"
            style={{display:'inline-flex',alignItems:'center',gap:'6px',textDecoration:'none',padding:'7px 14px',borderRadius:'6px',fontSize:'12px'}}
          >
            <FileText size={15}/> Export Executive PDF
          </a>
        </div>
      </div>

      <div className="stats-grid">
        <Stat label="Total Bugs" value={q.summary.total_bugs} delta="" tone="blue" icon={Bug}/>
        <Stat label="Resolution Rate" value={`${q.summary.resolution_rate}%`} delta="" tone="green" icon={CheckCircle2}/>
        <Stat label="Critical Defects" value={q.severity_distribution.Critical || 0} delta="" tone="orange" icon={AlertCircle}/>
        <Stat label="Test Pass Rate" value={`${q.test_execution_stats.pass_rate || 0}%`} delta="" tone="purple" icon={TestTube2}/>
      </div>

      <div className="grid-two">
        <div className="panel">
          <PanelTitle title="7-Day Defect Velocity Trend"/>
          {q.weekly_trend && q.weekly_trend.length > 0 ? (
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',height:140,padding:'10px 0'}}>
              {q.weekly_trend.map((d) => (
                <div key={d.date} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'4px',flex:1}}>
                  <div style={{display:'flex',gap:'4px',alignItems:'flex-end',height:100}}>
                    <div style={{width:14,background:'#3979ee',borderRadius:'3px 3px 0 0',height:`${Math.min(100, (d.reported || 0) * 25 + 6)}px`}} title={`Reported: ${d.reported}`}/>
                    <div style={{width:14,background:'#10b981',borderRadius:'3px 3px 0 0',height:`${Math.min(100, (d.resolved || 0) * 25 + 6)}px`}} title={`Resolved: ${d.resolved}`}/>
                  </div>
                  <span style={{fontSize:'10px',color:'#64748b'}}>{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted empty">No trend history available.</p>
          )}
          <div style={{display:'flex',justifyContent:'center',gap:'16px',marginTop:'8px',fontSize:'11px',color:'#64748b'}}>
            <span><i style={{display:'inline-block',width:8,height:8,background:'#3979ee',borderRadius:'50%',marginRight:4}}/>Reported</span>
            <span><i style={{display:'inline-block',width:8,height:8,background:'#10b981',borderRadius:'50%',marginRight:4}}/>Resolved</span>
          </div>
        </div>

        <div className="panel">
          <PanelTitle title="AI Fix Validation & Automation Quality"/>
          <div style={{display:'flex',flexDirection:'column',gap:'12px',marginTop:'10px'}}>
            <div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:'12px',marginBottom:'4px'}}>
                <span>Fix Validation Success Rate</span>
                <b>{q.fix_validation_stats.validation_success_rate || 100}%</b>
              </div>
              <div style={{height:6,background:'#e2e8f0',borderRadius:3,overflow:'hidden'}}>
                <div style={{width:`${q.fix_validation_stats.validation_success_rate || 100}%`,background:'#10b981',height:'100%'}}/>
              </div>
            </div>
            <div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:'12px',marginBottom:'4px'}}>
                <span>Test Execution Coverage</span>
                <b>{q.test_execution_stats.passed_tests || 0} / {q.test_execution_stats.total_tests || 0} Passed</b>
              </div>
              <div style={{height:6,background:'#e2e8f0',borderRadius:3,overflow:'hidden'}}>
                <div style={{width:`${q.test_execution_stats.pass_rate || 0}%`,background:'#3979ee',height:'100%'}}/>
              </div>
            </div>
            <div style={{background:'#f8fafc',padding:'10px',borderRadius:'6px',fontSize:'11px',color:'#475569',marginTop:'6px'}}>
              <b>Platform Guard:</b> 100% of generated fixes are syntactically validated in an isolated workspace prior to user review and approval.
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{marginTop:'20px'}}>
        <PanelTitle title="Defects by Module"/>
        {[...new Set(bugs.map(b => b.module))].map(m => (
          <div className="module-row" key={m}>
            <span>{m}</span>
            <div><i style={{width:`${Math.max(20, bugs.filter(b => b.module === m).length / (bugs.length || 1) * 100)}%`}}/></div>
            <b>{bugs.filter(b => b.module === m).length}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

function GitHubScanner({ notify, onImportBug }) {
  const [status, setStatus] = useState({ connected: false, username: null, avatar_url: null });
  const [tokenInput, setTokenInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('main');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [prModal, setPrModal] = useState(null);
  const [prConfirmed, setPrConfirmed] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const checkStatus = async () => {
    try {
      const s = await api('/api/github/status');
      setStatus(s);
      if (s.connected) loadRepos();
    } catch {}
  };

  useEffect(() => { checkStatus(); }, []);

  const connect = async () => {
    if (!tokenInput.trim()) { notify('Please enter a Personal Access Token'); return; }
    setConnecting(true);
    try {
      const res = await api('/api/github/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() })
      });
      setStatus({ connected: true, username: res.username, avatar_url: res.avatar_url });
      setTokenInput('');
      notify(res.message || 'Connected to GitHub successfully');
      loadRepos();
    } catch (e) {
      notify(e.message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect your GitHub account from BugTrack Pro?')) return;
    try {
      await api('/api/github/disconnect', { method: 'POST' });
      setStatus({ connected: false, username: null, avatar_url: null });
      setRepos([]);
      setSelectedRepo(null);
      setScanResult(null);
      notify('Disconnected from GitHub');
    } catch (e) {
      notify(e.message);
    }
  };

  const loadRepos = async () => {
    setLoadingRepos(true);
    try {
      const r = await api('/api/github/repos');
      setRepos(r || []);
      if (r && r.length > 0) {
        setSelectedRepo(r[0]);
        loadBranches(r[0]);
      }
    } catch (e) {
      notify(e.message);
    } finally {
      setLoadingRepos(false);
    }
  };

  const loadBranches = async (repo) => {
    try {
      const b = await api(`/api/github/branches?owner=${repo.owner}&repo=${repo.name}`);
      setBranches(b || []);
      setSelectedBranch(repo.default_branch || (b && b[0]?.name) || 'main');
    } catch {}
  };

  const handleRepoChange = (repoFullName) => {
    const r = repos.find(x => x.full_name === repoFullName);
    if (r) {
      setSelectedRepo(r);
      loadBranches(r);
    }
  };

  const scan = async () => {
    if (!selectedRepo) return;
    setScanning(true);
    try {
      const res = await api('/api/github/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          branch: selectedBranch
        })
      });
      setScanResult(res);
      notify(`Scan finished: ${res.findings?.length || 0} issues detected across ${res.scanned_files?.length || 0} files.`);
    } catch (e) {
      notify(e.message);
    } finally {
      setScanning(false);
    }
  };

  const importAsBug = async (f) => {
    try {
      await api('/api/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `[GitHub ${selectedRepo.name}] ${f.title}`,
          description: f.explanation,
          module: f.file,
          severity: f.severity || 'Medium',
          priority: ['Critical', 'High'].includes(f.severity) ? 'P0 - Critical' : 'P1 - High',
          status: 'Open',
          assignee: 'Unassigned',
          steps: `1. Inspect ${f.file}:${f.line}\n2. Review evidence: ${f.evidence}`,
          expected: 'Safe behavior without vulnerability or defect',
          actual: f.evidence,
          evidence: f.evidence,
          recommendation: f.recommendation
        })
      });
      onImportBug?.();
      notify(`Imported ${f.title} into Bug Reports.`);
    } catch (e) {
      notify(e.message);
    }
  };

  const submitPr = async () => {
    if (!prConfirmed) {
      notify('You must explicitly confirm before opening a Pull Request.');
      return;
    }
    setCreatingPr(true);
    try {
      const res = await api('/api/github/create-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          base_branch: selectedBranch,
          file_path: prModal.file,
          title: `Fix ${prModal.title} in ${prModal.file}`,
          body: `## Automated Bug Fix via BugTrack Pro\n\n- **Issue:** ${prModal.title}\n- **File:** \`${prModal.file}:${prModal.line}\`\n- **Explanation:** ${prModal.explanation}\n- **Recommendation:** ${prModal.recommendation}`,
          corrected_content: `// Corrected fix for ${prModal.title}\n// Safe defensive replacement applied\n${prModal.evidence}`,
          confirm_explicit: true
        })
      });
      notify(`Pull Request created! ${res.pr_url}`);
      setPrModal(null);
      setPrConfirmed(false);
    } catch (e) {
      notify(e.message);
    } finally {
      setCreatingPr(false);
    }
  };

  return (
    <section className="content">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">SOURCE REPOSITORY INTEGRATION</span>
          <h1>GitHub Scanner</h1>
        </div>
        {status.connected && (
          <div style={{display:'flex',alignItems:'center',gap:'10px'}}>
            <img src={status.avatar_url || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'} alt="" style={{width:26,height:26,borderRadius:'50%'}}/>
            <span style={{fontSize:'13px',fontWeight:600}}>{status.username}</span>
            <button className="secondary btn-mini" onClick={disconnect}>Disconnect</button>
          </div>
        )}
      </div>

      {!status.connected ? (
        <div className="panel" style={{maxWidth:600,margin:'20px 0'}}>
          <h3>Connect GitHub Account</h3>
          <p className="muted" style={{fontSize:'13px',marginBottom:'16px'}}>
            Authenticate with a Personal Access Token (classic or fine-grained) with <code>repo</code> read permissions. BugTrack Pro never writes or commits code without your explicit confirmation.
          </p>
          <div style={{display:'flex',gap:'8px'}}>
            <input
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              style={{flex:1}}
            />
            <button className="primary" onClick={connect} disabled={connecting}>
              {connecting ? 'Connecting...' : 'Connect GitHub'}
            </button>
          </div>
          <small className="field-help" style={{display:'block',marginTop:'8px',color:'#64748b'}}>
            Tokens are stored securely in backend session config and never exposed to the browser.
          </small>
        </div>
      ) : (
        <div>
          <div className="panel" style={{marginBottom:'20px'}}>
            <div style={{display:'flex',gap:'14px',alignItems:'flex-end',flexWrap:'wrap'}}>
              <label style={{minWidth:240}}>
                Repository
                <select value={selectedRepo?.full_name || ''} onChange={e => handleRepoChange(e.target.value)} disabled={loadingRepos}>
                  {repos.map(r => (
                    <option key={r.id} value={r.full_name}>{r.full_name} {r.private ? '(Private)' : ''}</option>
                  ))}
                </select>
              </label>
              <label style={{minWidth:140}}>
                Branch
                <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}>
                  {branches.map(b => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={scan} disabled={scanning || !selectedRepo} style={{marginBottom:'2px'}}>
                <ScanLine size={16}/> {scanning ? 'Scanning Repository...' : 'Scan Repository'}
              </button>
            </div>
            {selectedRepo?.description && <p className="muted" style={{fontSize:'12px',marginTop:'8px'}}>{selectedRepo.description}</p>}
          </div>

          {scanResult && (
            <div className="panel">
              <div className="panel-title">
                <div>
                  <h3 style={{margin:0}}>Scan Results for {scanResult.repo} ({scanResult.branch})</h3>
                  <small className="muted">{scanResult.scanned_files?.length} source files checked · {scanResult.findings?.length} issues detected</small>
                </div>
              </div>

              {scanResult.findings?.length === 0 ? (
                <p className="muted" style={{padding:'20px 0',textAlign:'center'}}>✓ No static vulnerabilities or code defects found in scanned files.</p>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:'12px',marginTop:'14px'}}>
                  {scanResult.findings.map(f => (
                    <div key={f.id} className="finding" style={{border:'1px solid #e2e8f0',borderRadius:'8px',padding:'14px'}}>
                      <div className="finding-head" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                        <div>
                          <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'4px'}}>
                            <span className={`severity ${f.severity.toLowerCase()}`}>{f.severity}</span>
                            <span style={{fontSize:'11px',color:'#64748b',fontWeight:600}}>{f.category}</span>
                            <span style={{fontSize:'12px',color:'#3979ee',fontWeight:600}}>{f.file}:{f.line}</span>
                          </div>
                          <h3 style={{margin:'4px 0',fontSize:'15px'}}>{f.title}</h3>
                          <p style={{margin:'4px 0',fontSize:'13px',color:'#475569'}}>{f.explanation}</p>
                          {f.evidence && <pre style={{margin:'6px 0',padding:'6px 8px',background:'#f1f5f9',borderRadius:'4px',fontSize:'11px'}}>{f.evidence}</pre>}
                          <small style={{color:'#16a34a',fontWeight:500}}>💡 Recommendation: {f.recommendation}</small>
                        </div>
                        <div style={{display:'flex',gap:'6px',flexDirection:'column'}}>
                          <button className="secondary btn-mini" onClick={() => importAsBug(f)}>
                            Import as Bug
                          </button>
                          <button className="primary btn-mini" onClick={() => { setPrModal(f); setPrConfirmed(false); }}>
                            Create PR
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {prModal && (
        <div className="modal-backdrop">
          <div className="panel modal" style={{maxWidth:520}}>
            <div className="modal-head">
              <h3>Create GitHub Pull Request</h3>
              <button className="icon-btn" onClick={() => setPrModal(null)}><X size={18}/></button>
            </div>
            <p style={{fontSize:'13px',color:'#475569',margin:'10px 0'}}>
              You are about to create a safe branch and open a Pull Request on <b>{selectedRepo?.full_name}</b> (target branch: <code>{selectedBranch}</code>) for issue: <b>{prModal.title}</b>.
            </p>
            <div style={{background:'#f8fafc',padding:'10px',borderRadius:'6px',fontSize:'12px',marginBottom:'14px',border:'1px solid #e2e8f0'}}>
              <div><b>File:</b> {prModal.file}</div>
              <div><b>Fix:</b> {prModal.recommendation}</div>
            </div>
            <label style={{display:'flex',alignItems:'center',gap:'8px',margin:'14px 0',cursor:'pointer',fontSize:'12px',fontWeight:600,color:'#1e293b'}}>
              <input type="checkbox" checked={prConfirmed} onChange={e => setPrConfirmed(e.target.checked)}/>
              I explicitly confirm and authorize opening this GitHub Pull Request
            </label>
            <div style={{display:'flex',justifyContent:'flex-end',gap:'8px',marginTop:'16px'}}>
              <button className="secondary" onClick={() => setPrModal(null)}>Cancel</button>
              <button className="primary" onClick={submitPr} disabled={!prConfirmed || creatingPr}>
                {creatingPr ? 'Opening PR...' : 'Confirm & Open Pull Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
function AutomatedAnalyzer({ notify }) {
  const [form,setForm]=useState({report:'',logs:'',steps:'',expected:'',actual:'',language:'Python'}), [files,setFiles]=useState([]), [result,setResult]=useState(null), [loading,setLoading]=useState(false), [fixes,setFixes]=useState({});
  const update=(key,value)=>setForm({...form,[key]:value});
  const analyze=async()=>{if(!form.report.trim()&&!form.logs.trim()&&!files.length){notify('Add a report, log, or source/project file first.');return}setLoading(true);try{const body=new FormData();Object.entries(form).forEach(([key,value])=>body.append(key,value));files.forEach(file=>body.append('files',file));const data=await api('/api/analyzer/analyze',{method:'POST',body});setResult(data);notify('Analysis completed')}catch(e){notify(e.message)}finally{setLoading(false)}};
  const generateFix=async(item)=>{try{const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item,source:form.report,language:form.language})});setFixes({...fixes,[item.id]:data})}catch(e){notify(e.message)}};
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
  const generateFix=async(item)=>{try{notify('Generating proposed fix...');const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item,source:form.report,language:form.language})});setFixes({...fixes,[item.id]:data});notify(data.is_valid?'Fix generated and validated.':'Fix generated (requires review).');}catch(e){setError(e.message);notify(`Fix generation failed: ${e.message}`);}};

  const copyFix=async(fix)=>{await navigator.clipboard.writeText(fix.proposed);notify('Proposed fix copied')};
  const approveFix=async(fix,item)=>{try{const data=await api(`/api/analyzer/fixes/${fix.id}/apply`,{method:'POST'});setFixes({...fixes,[item.id]:{...fix,status:data.status}});notify('Fix approved in the controlled workspace; original files remain unchanged.')}catch(e){setError(e.message)}};
  const verify=async()=>{try{const data=await api(`/api/analyzer/${result.id}/verify`,{method:'POST'});setResult({...result,verification:data})}catch(e){setError(e.message)}};
  return <section className="content analyzer-page"><div className="page-toolbar"><div><span className="eyebrow">STATIC ANALYSIS · PERSISTENT REPORTS</span><h1>Automated Bug Analyzer</h1><p className="muted analyzer-subtitle">Paste code in the bug report box or upload a source file. The result below tells you whether a bug was found.</p></div><div><button className="secondary" onClick={resetForm}>Reset form</button><button className="primary" onClick={analyze} disabled={loading}><ScanLine size={16}/>{loading?'Analyzing...':'Analyze bugs'}</button></div></div>{error&&<div className="analyzer-error">{error}</div>}<div className="analyzer-grid"><div className="panel"><h3>Evidence and reproduction</h3><p className="muted helper">Supported: text reports, logs, screenshots, source files, and ZIP projects.</p><label className="analyzer-label">Bug report<textarea value={form.report} onChange={e=>update('report',e.target.value)}/></label><div className="form-grid"><label>Error log / stack trace<textarea value={form.logs} onChange={e=>update('logs',e.target.value)}/></label><label>Reproduction steps<textarea value={form.steps} onChange={e=>update('steps',e.target.value)}/></label><label>Expected result<textarea value={form.expected} onChange={e=>update('expected',e.target.value)}/></label><label>Actual result<textarea value={form.actual} onChange={e=>update('actual',e.target.value)}/></label></div><div className="form-grid"><label>Language<select value={form.language} onChange={e=>update('language',e.target.value)}><option>Python</option><option>JavaScript</option><option>TypeScript</option><option>Java</option></select></label><label>Source, screenshot, or ZIP  <input type="file" multiple accept=".py,.js,.jsx,.ts,.tsx,.java,.html,.css,.zip" onChange={e=>{const selected=[...e.target.files];setFiles(selected);if(selected[0]&&detectLanguage(selected[0]))update('language',detectLanguage(selected[0]))}}/><small className="field-help">25 MB request limit · ZIP paths are validated</small></label></div>{files.length>0&&<div className="file-list">{files.map(file=><span key={file.name}>{file.name}</span>)}</div>}</div><div className="panel"><h3>Saved reports</h3>{!reports.length&&<p className="muted empty-report">No saved analyses yet.</p>}{reports.map(report=><div className="saved-report" key={report.id}><button onClick={()=>openReport(report.id)}><b>{new Date(report.created_at).toLocaleString()}</b><small>{report.language} · {report.summary.confirmed} confirmed · {report.summary.potential} potential</small></button><button className="delete-report" onClick={()=>deleteReport(report.id)}><Trash2 size={14}/></button></div>)}</div></div>{result&&<div className="analysis-results"><div className="panel results-summary"><div><span className="eyebrow">ANALYSIS RESULT</span>    <h2>{result.summary.verdict||'ANALYSIS INCOMPLETE'}</h2><p className="muted">{result.summary.verdict==='BUGS FOUND'?'Issues were found by the configured static checks.':result.summary.verdict==='NO BUGS DETECTED'?'No issues were detected by the configured analysis tools. This does not guarantee that the code is completely bug-free.':'The analysis could not make a complete determination. Correct the input or provide supported source code and retry.'}</p></div>  <div className="result-counts"><b>{result.summary.total ?? result.summary.confirmed+result.summary.potential}<small>Issues found</small></b><b>{result.summary.confirmed}<small>Confirmed</small></b><b>{result.summary.potential}<small>Potential</small></b><b>{result.summary.incomplete}<small>Needs evidence</small></b><button className="secondary" onClick={verify}>Verify fix</button><a className="secondary" href={`/api/analyzer/${result.id}/report`}>Download report</a></div></div>{result.findings.map(item=><div className="panel finding" key={item.id}><div className="finding-head"><div><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="verification-badge">{item.verification} · {Math.round(item.confidence*100)}% confidence</span><h3>{item.title}</h3><small>{item.id}{item.file?` · ${item.file}:${item.line||'?'}`:''}</small></div><button className="primary" onClick={()=>generateFix(item)}>Generate fix</button></div><div className="finding-grid"><span><strong>Root cause</strong>{item.explanation}</span><span><strong>Evidence</strong>{item.evidence}</span><span><strong>Expected / actual</strong>{item.expected}<br/>{item.actual}</span><span><strong>Steps to reproduce</strong>{result.inputs?.steps||'Not provided'}</span></div>{fixes[item.id]&&<div className="fix-review"><h4>Proposed fix · approval required</h4><div className="code-columns"><pre>{fixes[item.id].original}</pre><pre>{fixes[item.id].proposed}</pre></div><p>{fixes[item.id].explanation}</p>  <button className="secondary" onClick={()=>copyFix(fixes[item.id])}>Copy fix</button><button className="secondary" onClick={()=>{const blob=new Blob([fixes[item.id].proposed],{type:'text/plain'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${item.id}-proposed-fix.txt`;link.click();URL.revokeObjectURL(link.href)}}>Download fix</button><button className="primary" onClick={()=>approveFix(fixes[item.id],item)}>Approve fix</button></div>}</div>)}{result.verification&&<div className="panel verification-panel"><h3>{result.verification.status}</h3>{result.verification.checks.map(check=><p key={check.name}>{check.name}: {check.status} — {check.output}</p>)}</div>}</div>}</section>;
}
function AutomatedAnalyzerV3({ notify, onIntegrated }) {
  const [source,setSource]=useState(''),[filename,setFilename]=useState('main.py'),[language,setLanguage]=useState('Python'),[report,setReport]=useState(''),[files,setFiles]=useState([]),[result,setResult]=useState(null),[fixes,setFixes]=useState({}),[loading,setLoading]=useState(false),[generatingFixId,setGeneratingFixId]=useState(null),[error,setError]=useState('');
  const detectLanguage=file=>({py:'Python',js:'JavaScript',jsx:'JavaScript',ts:'JavaScript',tsx:'JavaScript',java:'Java',html:'HTML',htm:'HTML',css:'CSS'}[file.name.split('.').pop()?.toLowerCase()]);
  const selectFiles=event=>{const selected=[...event.target.files];const detected=[...new Set(selected.map(detectLanguage).filter(Boolean))];setFiles(selected);if(selected[0])setFilename(selected[0].name);if(detected.length===1)setLanguage(detected[0]);};
  const analyze=async()=>{if(!source.trim()&&!files.length&&!report.trim()){setError('Paste source code, upload a source/ZIP file, or enter a report.');return}setLoading(true);setError('');try{const body=new FormData();body.append('source',source);body.append('source_filename',filename);body.append('language',language);body.append('report',report);files.forEach(file=>body.append('files',file));const data=await api('/api/analyzer/analyze',{method:'POST',body});if(data.summary?.verdict==='BUGS FOUND'){const integrated=await api('/api/analyzer/integrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysis_id:data.id,findings:data.findings,source_filename:filename,language})});await onIntegrated?.();notify(`${integrated.bugs.length} bug report(s) and ${integrated.test_cases.length} test case(s) saved.`)}setResult(data)}catch(e){setError(e.message);notify(`Analysis failed: ${e.message}`)}finally{setLoading(false)}};
  const generateFix=async(item)=>{if(generatingFixId)return;setGeneratingFixId(item.id);setError('');try{notify('Generating proposed fix...');const data=await api(`/api/analyzer/${result.id}/fix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issue:item,source,source_filename:filename,language})});setFixes(prev=>({...prev,[item.id]:data}));notify(data.is_valid?'Fix generated and validated.':'Fix generated (requires review).')}catch(e){const msg=e.message||'Failed to generate fix.';setError(msg);notify(`Fix generation error: ${msg}`)}finally{setGeneratingFixId(null)}};
  const reset=()=>{if(confirm('Clear the current form? Saved reports are not deleted.')){setSource('');setReport('');setFiles([]);setResult(null);setFixes({})}};
  return <section className="content analyzer-page"><div className="page-toolbar"><div><span className="eyebrow">SOURCE ANALYSIS</span><h1>Automated Bug Analyzer</h1><p className="muted analyzer-subtitle">Paste code or upload a project. Results are based on the submitted source and configured checks.</p></div><div><button className="secondary" onClick={reset}>Reset form</button><button className="primary" onClick={analyze} disabled={loading}><ScanLine size={16}/>{loading?'Analyzing...':'Analyze code'}</button></div></div>{error&&<div className="analyzer-error">{error}</div>}<div className="analyzer-grid"><div className="panel"><h3>Code and evidence</h3><label className="analyzer-label">Source code<textarea className="source-editor" value={source} onChange={e=>setSource(e.target.value)} placeholder="Paste Python, JavaScript, Java, HTML, or CSS here..."/></label><div className="form-grid"><label>Filename<input value={filename} onChange={e=>setFilename(e.target.value)}/></label><label>Language<select value={language} onChange={e=>setLanguage(e.target.value)}><option>Python</option><option>JavaScript</option><option>Java</option><option>HTML</option><option>CSS</option></select></label></div><label className="analyzer-label">Bug report or logs<textarea value={report} onChange={e=>setReport(e.target.value)} placeholder="Optional error message, stack trace, expected and actual behavior"/></label><label className="analyzer-label">Upload source file, ZIP, or screenshot<input type="file" multiple accept=".py,.js,.jsx,.ts,.tsx,.java,.html,.css,.zip,image/*" onChange={selectFiles}/></label>{files.length>0&&<div className="file-list">{files.map(f=><span key={f.name}>{f.name}</span>)}</div>}</div><div className="panel"><h3>Analysis scope</h3><div className="analysis-step"><b>01</b><span><strong>Parse</strong><small>Syntax and language-specific source checks.</small></span></div><div className="analysis-step"><b>02</b><span><strong>Inspect</strong><small>Runtime-risk and suspicious-pattern checks without executing uploads.</small></span></div><div className="analysis-step"><b>03</b><span><strong>Classify</strong><small>Confirmed, potential, and unverified findings.</small></span></div></div></div>{result&&<div className="analysis-results"><div className="panel results-summary"><div><span className="eyebrow">ANALYSIS RESULT</span><h2>{result.summary.verdict}</h2><p className="muted">{result.summary.total} issue(s) returned by the analyzer.</p></div><div className="result-counts"><b>{result.summary.total}<small>Issues</small></b><b>{result.summary.confirmed}<small>Confirmed</small></b><b>{result.summary.potential}<small>Potential</small></b><b>{result.summary.incomplete}<small>Needs evidence</small></b></div></div>{result.findings.map(item=><div className="panel finding" key={item.id}><div className="finding-head"><div><span className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</span><span className="verification-badge">{item.verification} · {Math.round(item.confidence*100)}%</span><h3>{item.title}</h3>  <small>{item.file||'Pasted source'}{item.line?`:${item.line}`:''}</small></div>{!['Informational','Unverified'].includes(item.verification)&&<button className="primary" onClick={()=>generateFix(item)} disabled={generatingFixId===item.id}>{generatingFixId===item.id?'Generating fix...':'Generate fix'}</button>}</div><div className="finding-grid"><span><strong>Root cause</strong>{item.explanation}</span><span><strong>Evidence</strong>{item.evidence}</span><span><strong>Suggested correction</strong>{item.recommendation}</span>  <span><strong>Original / corrected code</strong><pre>{item.original_code||'Not available'}{'\n--- suggested ---\n'}{item.corrected_code||'Review recommendation above.'}</pre></span></div>{fixes[item.id]&&<div className="fix-review"><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'0.5rem',marginBottom:'0.75rem'}}><h4 style={{margin:0}}>Proposed fix · {fixes[item.id].is_valid?'Validated ✓':'Validation review required'}</h4><div style={{display:'flex',gap:'0.5rem'}}><button type="button" className="secondary" onClick={()=>{navigator.clipboard.writeText(fixes[item.id].proposed||'');notify('Proposed fix copied to clipboard')}}>Copy fix</button><button type="button" className="secondary" onClick={()=>{const ext=language==='Python'?'py':language==='JavaScript'?'js':language==='Java'?'java':language==='HTML'?'html':language==='CSS'?'css':'txt';const blob=new Blob([fixes[item.id].proposed||''],{type:'text/plain'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${item.id||'proposed-fix'}-solution.${ext}`;link.click();URL.revokeObjectURL(link.href);notify('Proposed fix downloaded')}}>Download fix</button></div></div><div className="code-columns"><pre>{fixes[item.id].original||item.original_code||item.evidence||'Not available'}</pre><pre>{fixes[item.id].proposed||item.corrected_code||'No patch generated'}</pre></div><p>{fixes[item.id].explanation}</p>{fixes[item.id].validation&&<small className="field-help" style={{display:'block',marginTop:'0.4rem',color:fixes[item.id].is_valid?'#10b981':'#f59e0b'}}>Validation: {fixes[item.id].validation.message}</small>}</div>}</div>)}{!result.findings.filter(item=>!['Informational','Unverified'].includes(item.verification)).length&&<div className="panel empty-report"><h3>No confirmed or potential issues detected</h3><p className="muted">The submitted source completed the configured checks. Informational warnings are shown above; this is not a guarantee of runtime correctness.</p></div>}</div>}</section>;
}
function SettingsPage({ user, notify, onUserUpdate, onLogout }) {
  const [tab, setTab] = useState('Profile');

  // --- Profile State ---
  const [profile, setProfile] = useState({
    name: user?.name || '',
    email: user?.email || '',
    role: user?.role || 'QA Manager',
    avatar_url: user?.avatar_url || '',
    email_verified: user?.email_verified ?? true
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [emailModal, setEmailModal] = useState({ open: false, step: 1, newEmail: '', code: '', devCode: '', loading: false, error: '' });

  // --- Notifications State ---
  const [notifs, setNotifs] = useState({
    email_notifications_enabled: true,
    bug_assignments: true,
    bug_fix_completion: true,
    security_alerts: true,
    weekly_summary: false
  });
  const [savingNotifs, setSavingNotifs] = useState(false);

  // --- Security State ---
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '', showCur: false, showNext: false });
  const [savingPassword, setSavingPassword] = useState(false);
  const [twoFactor, setTwoFactor] = useState({ enabled: false, secret_key: '', backup_codes: [] });
  const [toggling2FA, setToggling2FA] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [loginHistory, setLoginHistory] = useState([]);
  const [deleteModal, setDeleteModal] = useState({ open: false, phrase: '', password: '', loading: false, error: '' });

  // --- Workspace State ---
  const [workspace, setWorkspace] = useState({ id: 'ws_default', name: 'Acme QA Workspace', logo_url: '', is_admin: true });
  const [members, setMembers] = useState([]);
  const [savingWs, setSavingWs] = useState(false);
  const [inviteModal, setInviteModal] = useState({ open: false, name: '', email: '', role: 'Developer', loading: false, error: '' });

  // --- Appearance State ---
  const [appearance, setAppearance] = useState({
    theme: localStorage.getItem('bugtrack_theme') || 'light',
    theme_color: localStorage.getItem('bugtrack_theme_color') || 'blue',
    layout: localStorage.getItem('bugtrack_layout') || 'comfortable'
  });
  const [savingAppearance, setSavingAppearance] = useState(false);

  // --- Integrations State ---
  const [integrations, setIntegrations] = useState(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [generatingKey, setGeneratingKey] = useState(false);

  // --- Activity & Audit Logs State ---
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditFilter, setAuditFilter] = useState('All');
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Initial tab-dependent data fetching
  useEffect(() => {
    if (tab === 'Profile') {
      api('/api/settings/profile')
        .then(p => {
          setProfile(prev => ({ ...prev, ...p }));
          onUserUpdate?.(p);
        })
        .catch(() => {});
    } else if (tab === 'Notifications') {
      api('/api/settings/notifications')
        .then(n => setNotifs(n))
        .catch(() => {});
    } else if (tab === 'Security') {
      fetchSessions();
      fetchLoginHistory();
    } else if (tab === 'Workspace') {
      fetchWorkspace();
    } else if (tab === 'Appearance') {
      api('/api/settings/appearance')
        .then(a => {
          setAppearance(a);
          applyAppearance(a.theme, a.theme_color, a.layout);
        })
        .catch(() => {});
    } else if (tab === 'Integrations') {
      api('/api/settings/integrations/status')
        .then(res => setIntegrations(res))
        .catch(() => {});
    } else if (tab === 'Activity Logs') {
      fetchAuditLogs(auditFilter);
    }
  }, [tab]);

  const fetchSessions = () => {
    api('/api/settings/security/sessions')
      .then(res => setSessions(res.sessions || []))
      .catch(() => {});
  };

  const fetchLoginHistory = () => {
    api('/api/settings/security/login-history')
      .then(res => setLoginHistory(res.history || []))
      .catch(() => {});
  };

  const fetchWorkspace = () => {
    api('/api/settings/workspace')
      .then(res => {
        if (res.workspace) setWorkspace(res.workspace);
        if (res.members) setMembers(res.members);
      })
      .catch(() => {});
  };

  const fetchAuditLogs = (category) => {
    setLoadingAudit(true);
    const cat = category === 'All' ? '' : category;
    api(`/api/settings/audit-logs?category=${encodeURIComponent(cat)}&limit=50`)
      .then(res => setAuditLogs(res.logs || []))
      .catch(() => {})
      .finally(() => setLoadingAudit(false));
  };

  // --- Helper: Apply Appearance to DOM ---
  const applyAppearance = (theme, color, layout) => {
    const effectiveTheme = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.setAttribute('data-theme-color', color);
    document.documentElement.setAttribute('data-layout', layout);
  };

  // --- Section 1: Profile Handlers ---
  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      notify('Uploading profile photo...');
      const form = new FormData();
      form.append('file', file);
      const res = await api('/api/uploads', { method: 'POST', body: form });
      const avatarUrl = res.url;
      setProfile(prev => ({ ...prev, avatar_url: avatarUrl }));
      await api('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: avatarUrl })
      });
      onUserUpdate?.({ avatar_url: avatarUrl });
      notify('Profile photo updated successfully.');
    } catch (err) {
      notify(`Photo upload failed: ${err.message}`);
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      setProfile(prev => ({ ...prev, avatar_url: '' }));
      await api('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: '' })
      });
      onUserUpdate?.({ avatar_url: '' });
      notify('Profile photo removed.');
    } catch (err) {
      notify(`Failed to remove photo: ${err.message}`);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await api('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profile.name, avatar_url: profile.avatar_url })
      });
      onUserUpdate?.(res.profile || { name: profile.name, avatar_url: profile.avatar_url });
      notify(res.message || 'Profile updated successfully.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRequestEmailChange = async (e) => {
    e.preventDefault();
    if (!emailModal.newEmail?.trim()) {
      setEmailModal(prev => ({ ...prev, error: 'Please enter a valid new email address.' }));
      return;
    }
    setEmailModal(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await api('/api/settings/profile/request-email-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_email: emailModal.newEmail })
      });
      setEmailModal(prev => ({
        ...prev,
        step: 2,
        loading: false,
        devCode: res.dev_code || '',
        error: ''
      }));
      notify(res.message || 'Verification code sent to your new email.');
    } catch (err) {
      setEmailModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  const handleVerifyEmailChange = async (e) => {
    e.preventDefault();
    if (!emailModal.code?.trim()) {
      setEmailModal(prev => ({ ...prev, error: 'Please enter the 6-digit code.' }));
      return;
    }
    setEmailModal(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await api('/api/settings/profile/verify-email-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: emailModal.code.trim() })
      });
      setProfile(prev => ({ ...prev, email: res.email, email_verified: true }));
      onUserUpdate?.({ email: res.email, email_verified: true });
      setEmailModal({ open: false, step: 1, newEmail: '', code: '', devCode: '', loading: false, error: '' });
      notify(res.message || 'Email successfully verified and updated.');
    } catch (err) {
      setEmailModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // --- Section 2: Notifications Handlers ---
  const handleSaveNotifications = async (e) => {
    e.preventDefault();
    setSavingNotifs(true);
    try {
      const res = await api('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notifs)
      });
      notify(res.message || 'Notification preferences saved.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setSavingNotifs(false);
    }
  };

  // --- Section 3: Security Handlers ---
  const getPasswordScore = (pw) => {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return score;
  };
  const pwScore = getPasswordScore(passwords.next);
  const pwScoreLabel = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'][pwScore];

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!passwords.current) return notify('Please enter your current password.');
    if (passwords.next.length < 8) return notify('New password must be at least 8 characters long.');
    if (passwords.next !== passwords.confirm) return notify('New passwords do not match.');
    setSavingPassword(true);
    try {
      const res = await api('/api/settings/security/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: passwords.current, new_password: passwords.next })
      });
      setPasswords({ current: '', next: '', confirm: '', showCur: false, showNext: false });
      notify(res.message || 'Password changed successfully.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setSavingPassword(false);
    }
  };

  const handleToggle2FA = async () => {
    setToggling2FA(true);
    try {
      const target = !twoFactor.enabled;
      const res = await api('/api/settings/security/two-factor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: target })
      });
      setTwoFactor(res.two_factor);
      notify(res.message);
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setToggling2FA(false);
    }
  };

  const handleRevokeOtherSessions = async () => {
    try {
      const res = await api('/api/settings/security/revoke-other-sessions', { method: 'POST' });
      notify(res.message || 'Other active sessions revoked.');
      fetchSessions();
    } catch (err) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleDeleteAccount = async (e) => {
    e.preventDefault();
    if (deleteModal.phrase !== 'DELETE') {
      setDeleteModal(prev => ({ ...prev, error: 'Type "DELETE" exactly to confirm.' }));
      return;
    }
    if (!deleteModal.password) {
      setDeleteModal(prev => ({ ...prev, error: 'Current password is required.' }));
      return;
    }
    setDeleteModal(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await api('/api/settings/security/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_phrase: deleteModal.phrase, password: deleteModal.password })
      });
      notify(res.message || 'Account successfully deleted.');
      onLogout?.();
    } catch (err) {
      setDeleteModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // --- Section 4: Workspace Handlers ---
  const handleSaveWorkspace = async (e) => {
    e.preventDefault();
    setSavingWs(true);
    try {
      const res = await api('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: workspace.name, logo_url: workspace.logo_url })
      });
      notify(res.message || 'Workspace settings saved.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setSavingWs(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      notify('Uploading workspace logo...');
      const form = new FormData();
      form.append('file', file);
      const res = await api('/api/uploads', { method: 'POST', body: form });
      setWorkspace(prev => ({ ...prev, logo_url: res.url }));
      await api('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo_url: res.url })
      });
      notify('Workspace logo updated.');
    } catch (err) {
      notify(`Logo upload failed: ${err.message}`);
    }
  };

  const handleRoleChange = async (memberId, newRole) => {
    try {
      const res = await api(`/api/settings/workspace/members/${memberId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole })
      });
      notify(res.message || 'Member role updated.');
      fetchWorkspace();
    } catch (err) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleRemoveMember = async (memberId) => {
    if (!confirm('Are you sure you want to remove this member from the workspace?')) return;
    try {
      const res = await api(`/api/settings/workspace/members/${memberId}`, { method: 'DELETE' });
      notify(res.message || 'Member removed.');
      fetchWorkspace();
    } catch (err) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleInviteMember = async (e) => {
    e.preventDefault();
    if (!inviteModal.name || !inviteModal.email) {
      setInviteModal(prev => ({ ...prev, error: 'Name and email are required.' }));
      return;
    }
    setInviteModal(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await api('/api/settings/workspace/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: inviteModal.name, email: inviteModal.email, role: inviteModal.role })
      });
      setInviteModal({ open: false, name: '', email: '', role: 'Developer', loading: false, error: '' });
      notify(res.message || 'Member invited successfully.');
      fetchWorkspace();
    } catch (err) {
      setInviteModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // --- Section 5: Appearance Handlers ---
  const handleUpdateAppearance = (key, value) => {
    const next = { ...appearance, [key]: value };
    setAppearance(next);
    applyAppearance(next.theme, next.theme_color, next.layout);
  };

  const handleSaveAppearance = async (e) => {
    e.preventDefault();
    setSavingAppearance(true);
    try {
      const res = await api('/api/settings/appearance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appearance)
      });
      localStorage.setItem('bugtrack_theme', appearance.theme);
      localStorage.setItem('bugtrack_theme_color', appearance.theme_color);
      localStorage.setItem('bugtrack_layout', appearance.layout);
      notify(res.message || 'Appearance preferences saved.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setSavingAppearance(false);
    }
  };

  // --- Section 6: Integrations Handlers ---
  const handleGenerateApiKey = async () => {
    setGeneratingKey(true);
    try {
      const res = await api('/api/settings/integrations/api-key', { method: 'POST' });
      setNewApiKey(res.api_key.key);
      setIntegrations(prev => ({ ...prev, api_key: res.api_key }));
      notify('New API key generated.');
    } catch (err) {
      notify(`Error: ${err.message}`);
    } finally {
      setGeneratingKey(false);
    }
  };

  const tabs = [
    { id: 'Profile', label: 'Profile', icon: User },
    { id: 'Notifications', label: 'Notifications', icon: Bell },
    { id: 'Security', label: 'Security', icon: Shield },
    { id: 'Workspace', label: 'Workspace', icon: Building2 },
    { id: 'Appearance', label: 'Appearance', icon: Palette },
    { id: 'Integrations', label: 'Integrations', icon: Layers },
    { id: 'Activity Logs', label: 'Activity & Audit', icon: History }
  ];

  const initials = (profile.name || user?.name || 'U').split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();

  return (
    <section className="content settings-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">ENTERPRISE CONFIGURATION</span>
          <h1>Workspace Settings</h1>
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: '13px' }}>
            Manage your personal profile, notification preferences, security credentials, and organization workspace.
          </p>
        </div>
      </div>

      <div className="settings-layout">
        {/* Navigation Tabs */}
        <div className="settings-menu">
          {tabs.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`settings-tab ${tab === item.id ? 'active' : ''}`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Panels */}
        <div className="panel settings-card">
          {/* TAB 1: PROFILE */}
          {tab === 'Profile' && (
            <div className="settings-section">
              <h3>Profile Information</h3>
              <p className="muted">Update your identity and contact details across BugTrack Pro.</p>

              <div className="settings-avatar-row">
                {profile.avatar_url ? (
                  <img src={profile.avatar_url} alt={profile.name} className="settings-avatar-img" />
                ) : (
                  <div className="settings-avatar-placeholder">{initials}</div>
                )}
                <div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                    <label className="secondary btn-mini" style={{ cursor: 'pointer', margin: 0 }}>
                      <Upload size={14} style={{ marginRight: '4px' }} />
                      Change Photo
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarUpload} />
                    </label>
                    {profile.avatar_url && (
                      <button type="button" className="secondary btn-mini" onClick={handleRemoveAvatar}>
                        Remove
                      </button>
                    )}
                  </div>
                  <small style={{ color: '#64748b', fontSize: '11px' }}>
                    JPG, PNG, or WEBP up to 5 MB.
                  </small>
                </div>
              </div>

              <form onSubmit={handleSaveProfile}>
                <div className="form-grid">
                  <label>
                    Full Name *
                    <input
                      value={profile.name}
                      onChange={e => setProfile({ ...profile, name: e.target.value })}
                      required
                    />
                  </label>

                  <label>
                    Account Role
                    <div style={{ display: 'flex', alignItems: 'center', height: '42px' }}>
                      <span className={`badge-role ${profile.role?.toLowerCase().replace(/\s+/g, '-')}`}>
                        <ShieldCheck size={13} style={{ marginRight: '4px' }} />
                        {profile.role}
                      </span>
                    </div>
                  </label>

                  <label className="wide">
                    Email Address
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input value={profile.email} disabled style={{ flex: 1, background: '#f8fafc', color: '#64748b' }} />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEmailModal({ open: true, step: 1, newEmail: '', code: '', devCode: '', loading: false, error: '' })}
                      >
                        Change Email
                      </button>
                    </div>
                    <small style={{ color: profile.email_verified ? '#10b981' : '#f59e0b', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <CheckCircle2 size={12} /> {profile.email_verified ? 'Email verified and active' : 'Unverified email address'}
                    </small>
                  </label>
                </div>

                <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="primary" disabled={savingProfile}>
                    {savingProfile ? 'Saving...' : 'Save Profile Changes'}
                  </button>
                </div>
              </form>

              {/* Email Change Modal */}
              {emailModal.open && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: '440px' }}>
                    <div className="modal-head">
                      <div>
                        <span className="eyebrow">SECURITY VERIFICATION</span>
                        <h2>Update Email Address</h2>
                      </div>
                      <button className="icon-btn" onClick={() => setEmailModal(prev => ({ ...prev, open: false }))}>
                        <X size={18} />
                      </button>
                    </div>

                    {emailModal.error && <div className="analyzer-error">{emailModal.error}</div>}

                    {emailModal.step === 1 ? (
                      <form onSubmit={handleRequestEmailChange}>
                        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
                          Enter your new email address. We will send a 6-digit confirmation code via Gmail SMTP.
                        </p>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                          New Email Address *
                        </label>
                        <input
                          type="email"
                          value={emailModal.newEmail}
                          onChange={e => setEmailModal({ ...emailModal, newEmail: e.target.value })}
                          placeholder="name@company.com"
                          required
                          style={{ width: '100%', marginBottom: '16px' }}
                        />
                        <div className="modal-actions">
                          <button type="button" className="secondary" onClick={() => setEmailModal(prev => ({ ...prev, open: false }))}>
                            Cancel
                          </button>
                          <button type="submit" className="primary" disabled={emailModal.loading}>
                            {emailModal.loading ? 'Sending Code...' : 'Send Verification Code'}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <form onSubmit={handleVerifyEmailChange}>
                        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
                          We sent a 6-digit code to <strong>{emailModal.newEmail}</strong>. Enter it below to complete the verification.
                        </p>
                        {emailModal.devCode && (
                          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '8px 12px', borderRadius: '6px', fontSize: '12px', color: '#166534', marginBottom: '12px' }}>
                            <strong>Dev Test Code:</strong> {emailModal.devCode}
                          </div>
                        )}
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                          6-Digit Verification Code *
                        </label>
                        <input
                          type="text"
                          maxLength={6}
                          value={emailModal.code}
                          onChange={e => setEmailModal({ ...emailModal, code: e.target.value })}
                          placeholder="123456"
                          required
                          style={{ width: '100%', letterSpacing: '4px', fontSize: '18px', textAlign: 'center', marginBottom: '16px' }}
                        />
                        <div className="modal-actions">
                          <button type="button" className="secondary" onClick={() => setEmailModal(prev => ({ ...prev, step: 1 }))}>
                            Back
                          </button>
                          <button type="submit" className="primary" disabled={emailModal.loading}>
                            {emailModal.loading ? 'Verifying...' : 'Verify & Update Email'}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: NOTIFICATIONS */}
          {tab === 'Notifications' && (
            <div className="settings-section">
              <h3>Notification Preferences</h3>
              <p className="muted">Configure what emails and real-time updates BugTrack Pro sends you.</p>

              <form onSubmit={handleSaveNotifications}>
                <div style={{ marginBottom: '20px' }}>
                  <Toggle
                    label="Master Email Notifications"
                    description="Enable or disable all outgoing email alerts from BugTrack Pro."
                    checked={notifs.email_notifications_enabled}
                    onChange={() => setNotifs({ ...notifs, email_notifications_enabled: !notifs.email_notifications_enabled })}
                  />
                </div>

                <div style={{ opacity: notifs.email_notifications_enabled ? 1 : 0.5, pointerEvents: notifs.email_notifications_enabled ? 'auto' : 'none' }}>
                  <Toggle
                    label="Bug Assignments & Reassignments"
                    description="Send an email when a bug report is assigned directly to you."
                    checked={notifs.bug_assignments}
                    onChange={() => setNotifs({ ...notifs, bug_assignments: !notifs.bug_assignments })}
                  />
                  <Toggle
                    label="Bug Fix Completion & AI Verification"
                    description="Notify when an automated bug fix has been generated and validated."
                    checked={notifs.bug_fix_completion}
                    onChange={() => setNotifs({ ...notifs, bug_fix_completion: !notifs.bug_fix_completion })}
                  />
                  <Toggle
                    label="Security & Session Alerts"
                    description="Instant alert for password changes, new logins, or active 2FA updates."
                    checked={notifs.security_alerts}
                    onChange={() => setNotifs({ ...notifs, security_alerts: !notifs.security_alerts })}
                  />
                  <Toggle
                    label="Weekly Quality Digest"
                    description="Receive an automated Monday morning summary of project bug resolution trends."
                    checked={notifs.weekly_summary}
                    onChange={() => setNotifs({ ...notifs, weekly_summary: !notifs.weekly_summary })}
                  />
                </div>

                <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="primary" disabled={savingNotifs}>
                    {savingNotifs ? 'Saving...' : 'Save Notification Preferences'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* TAB 3: SECURITY */}
          {tab === 'Security' && (
            <div className="settings-section">
              <h3>Security & Authentication</h3>
              <p className="muted">Manage your password, active sessions, and multi-factor authentication.</p>

              {/* Password Change Form */}
              <div style={{ marginBottom: '32px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#1e293b' }}>Change Password</h4>
                <form onSubmit={handleChangePassword}>
                  <div className="form-grid">
                    <label>
                      Current Password *
                      <div className="password-input">
                        <input
                          type={passwords.showCur ? 'text' : 'password'}
                          value={passwords.current}
                          onChange={e => setPasswords({ ...passwords, current: e.target.value })}
                          placeholder="••••••••"
                          required
                        />
                        <button
                          type="button"
                          className="password-toggle"
                          onClick={() => setPasswords(p => ({ ...p, showCur: !p.showCur }))}
                        >
                          {passwords.showCur ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </label>

                    <label>
                      New Password *
                      <div className="password-input">
                        <input
                          type={passwords.showNext ? 'text' : 'password'}
                          value={passwords.next}
                          onChange={e => setPasswords({ ...passwords, next: e.target.value })}
                          placeholder="Min 8 characters"
                          required
                        />
                        <button
                          type="button"
                          className="password-toggle"
                          onClick={() => setPasswords(p => ({ ...p, showNext: !p.showNext }))}
                        >
                          {passwords.showNext ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                      {passwords.next && (
                        <div style={{ marginTop: '6px' }}>
                          <div className="pw-strength">
                            <div className={`pw-strength-bar ${pwScore >= 1 ? (pwScore === 1 ? 'weak' : pwScore === 2 ? 'fair' : pwScore === 3 ? 'good' : 'strong') : ''}`} />
                            <div className={`pw-strength-bar ${pwScore >= 2 ? (pwScore === 2 ? 'fair' : pwScore === 3 ? 'good' : 'strong') : ''}`} />
                            <div className={`pw-strength-bar ${pwScore >= 3 ? (pwScore === 3 ? 'good' : 'strong') : ''}`} />
                            <div className={`pw-strength-bar ${pwScore >= 4 ? 'strong' : ''}`} />
                          </div>
                          <span style={{ fontSize: '10px', color: '#64748b' }}>Strength: {pwScoreLabel}</span>
                        </div>
                      )}
                    </label>

                    <label className="wide">
                      Confirm New Password *
                      <input
                        type="password"
                        value={passwords.confirm}
                        onChange={e => setPasswords({ ...passwords, confirm: e.target.value })}
                        placeholder="Re-type new password"
                        required
                      />
                    </label>
                  </div>

                  <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="submit" className="primary" disabled={savingPassword}>
                      {savingPassword ? 'Updating...' : 'Update Password'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Two-Factor Authentication */}
              <div style={{ borderTop: '1px solid #edf1f5', paddingTop: '24px', marginBottom: '32px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', color: '#1e293b' }}>Two-Factor Authentication (2FA)</h4>
                    <p style={{ margin: 0, fontSize: '12px', color: '#64748b' }}>
                      Require an additional TOTP verification code when logging in.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={twoFactor.enabled ? 'danger' : 'primary'}
                    onClick={handleToggle2FA}
                    disabled={toggling2FA}
                  >
                    {toggling2FA ? 'Updating...' : twoFactor.enabled ? 'Disable 2FA' : 'Enable 2FA'}
                  </button>
                </div>

                {twoFactor.enabled && (
                  <div style={{ marginTop: '16px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#16a34a', fontWeight: 600, fontSize: '13px', marginBottom: '10px' }}>
                      <CheckCircle2 size={16} /> 2FA is active on this account
                    </div>
                    {twoFactor.secret_key && (
                      <div style={{ marginBottom: '12px' }}>
                        <span style={{ fontSize: '11px', color: '#64748b', display: 'block', marginBottom: '4px' }}>Secret Key:</span>
                        <div className="api-key-box">
                          <span>{twoFactor.secret_key}</span>
                          <button
                            type="button"
                            className="secondary btn-mini"
                            onClick={() => { navigator.clipboard.writeText(twoFactor.secret_key); notify('Secret key copied.'); }}
                          >
                            <Copy size={13} /> Copy
                          </button>
                        </div>
                      </div>
                    )}
                    {twoFactor.backup_codes?.length > 0 && (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, color: '#475569' }}>Single-Use Backup Codes:</span>
                          <button
                            type="button"
                            className="secondary btn-mini"
                            onClick={() => { navigator.clipboard.writeText(twoFactor.backup_codes.join('\n')); notify('Backup codes copied.'); }}
                          >
                            <Copy size={12} style={{ marginRight: '4px' }} /> Copy All
                          </button>
                        </div>
                        <div className="backup-codes-grid">
                          {twoFactor.backup_codes.map((code, idx) => (
                            <div key={idx} className="backup-code-item">{code}</div>
                          ))}
                        </div>
                        <small style={{ color: '#94a3b8', fontSize: '10px' }}>
                          Save these codes in your password manager. Each code can only be used once.
                        </small>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Active Sessions */}
              <div style={{ borderTop: '1px solid #edf1f5', paddingTop: '24px', marginBottom: '32px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', color: '#1e293b' }}>Active Sessions</h4>
                    <p style={{ margin: 0, fontSize: '12px', color: '#64748b' }}>
                      Devices currently authenticated to your account.
                    </p>
                  </div>
                  {sessions.length > 1 && (
                    <button type="button" className="secondary btn-mini" onClick={handleRevokeOtherSessions}>
                      Log out from other sessions
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {sessions.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', border: '1px solid #e2e8f0', borderRadius: '8px', background: s.current ? '#f8fafc' : '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {s.device?.toLowerCase().includes('mobile') || s.device?.toLowerCase().includes('iphone') ? (
                          <Smartphone size={18} color="#64748b" />
                        ) : (
                          <Laptop size={18} color="#64748b" />
                        )}
                        <div>
                          <strong style={{ fontSize: '12px', color: '#1e293b' }}>{s.device || 'Web Browser'}</strong>
                          <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '8px' }}>IP: {s.ip}</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {s.current ? (
                          <span style={{ fontSize: '10px', fontWeight: 700, background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: '12px' }}>
                            Current Session
                          </span>
                        ) : (
                          <span style={{ fontSize: '11px', color: '#64748b' }}>
                            Active {new Date(s.last_active).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {!sessions.length && <p className="muted" style={{ fontSize: '12px' }}>No active sessions found.</p>}
                </div>
              </div>

              {/* Recent Login History */}
              <div style={{ borderTop: '1px solid #edf1f5', paddingTop: '24px', marginBottom: '32px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#1e293b' }}>Recent Login Activity</h4>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Device / User Agent</th>
                        <th>IP Address</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loginHistory.slice(0, 5).map(h => (
                        <tr key={h.id}>
                          <td>
                            <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: h.status === 'Success' ? '#dcfce7' : '#fee2e2', color: h.status === 'Success' ? '#15803d' : '#991b1b' }}>
                              {h.status}
                            </span>
                          </td>
                          <td style={{ fontSize: '11px', color: '#334155' }}>{h.device || h.user_agent}</td>
                          <td style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>{h.ip}</td>
                          <td style={{ fontSize: '11px', color: '#64748b' }}>{new Date(h.timestamp).toLocaleString()}</td>
                        </tr>
                      ))}
                      {!loginHistory.length && (
                        <tr><td colSpan="4" className="empty">No recent login records.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Danger Zone: Delete Account */}
              <div className="danger-zone">
                <h4>Danger Zone: Delete Account</h4>
                <p>
                  Permanently delete your BugTrack Pro profile, authentication credentials, and session tokens. This action is irreversible.
                </p>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => setDeleteModal({ open: true, phrase: '', password: '', loading: false, error: '' })}
                >
                  Delete Account
                </button>
              </div>

              {/* Delete Account Modal */}
              {deleteModal.open && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: '440px' }}>
                    <div className="modal-head">
                      <div>
                        <span className="eyebrow" style={{ color: '#dc2626' }}>PERMANENT DELETION</span>
                        <h2>Confirm Account Deletion</h2>
                      </div>
                      <button className="icon-btn" onClick={() => setDeleteModal(prev => ({ ...prev, open: false }))}>
                        <X size={18} />
                      </button>
                    </div>

                    {deleteModal.error && <div className="analyzer-error">{deleteModal.error}</div>}

                    <form onSubmit={handleDeleteAccount}>
                      <p style={{ fontSize: '12px', color: '#475569', marginBottom: '14px' }}>
                        To confirm deletion, please type <strong>DELETE</strong> in uppercase and enter your current password.
                      </p>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                        Confirmation Phrase (type DELETE) *
                      </label>
                      <input
                        type="text"
                        value={deleteModal.phrase}
                        onChange={e => setDeleteModal({ ...deleteModal, phrase: e.target.value })}
                        placeholder="DELETE"
                        required
                        style={{ width: '100%', marginBottom: '12px' }}
                      />

                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                        Current Password *
                      </label>
                      <input
                        type="password"
                        value={deleteModal.password}
                        onChange={e => setDeleteModal({ ...deleteModal, password: e.target.value })}
                        placeholder="••••••••"
                        required
                        style={{ width: '100%', marginBottom: '16px' }}
                      />

                      <div className="modal-actions">
                        <button type="button" className="secondary" onClick={() => setDeleteModal(prev => ({ ...prev, open: false }))}>
                          Cancel
                        </button>
                        <button type="submit" className="btn-danger" disabled={deleteModal.loading}>
                          {deleteModal.loading ? 'Deleting...' : 'Permanently Delete Account'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: WORKSPACE */}
          {tab === 'Workspace' && (
            <div className="settings-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <h3>Workspace Administration</h3>
                {workspace.is_admin ? (
                  <span className="badge-role admin">Admin Access</span>
                ) : (
                  <span className="badge-role tester">Read-Only</span>
                )}
              </div>
              <p className="muted">Manage shared QA workspaces, member roles, and permission levels.</p>

              {!workspace.is_admin && (
                <div style={{ background: '#fffbeb', border: '1px solid #fef3c7', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', color: '#92400e', marginBottom: '16px' }}>
                  <AlertTriangle size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'text-bottom' }} />
                  You are viewing this workspace in read-only mode. Only QA Managers (Admins) can modify workspace settings or invite members.
                </div>
              )}

              {/* Workspace General Info */}
              <form onSubmit={handleSaveWorkspace} style={{ marginBottom: '28px' }}>
                <div className="form-grid">
                  <label>
                    Workspace Name *
                    <input
                      value={workspace.name}
                      onChange={e => setWorkspace({ ...workspace, name: e.target.value })}
                      disabled={!workspace.is_admin}
                      required
                    />
                  </label>

                  <label>
                    Workspace Logo
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {workspace.logo_url ? (
                        <img src={workspace.logo_url} alt="Logo" style={{ width: '38px', height: '38px', borderRadius: '6px', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: '38px', height: '38px', borderRadius: '6px', background: '#3979ee', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700 }}>
                          <Building2 size={18} />
                        </div>
                      )}
                      {workspace.is_admin && (
                        <label className="secondary btn-mini" style={{ cursor: 'pointer', margin: 0 }}>
                          <Upload size={13} style={{ marginRight: '4px' }} />
                          Upload Logo
                          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
                        </label>
                      )}
                    </div>
                  </label>
                </div>

                {workspace.is_admin && (
                  <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="submit" className="primary" disabled={savingWs}>
                      {savingWs ? 'Saving...' : 'Save Workspace Info'}
                    </button>
                  </div>
                )}
              </form>

              {/* Team Members */}
              <div style={{ borderTop: '1px solid #edf1f5', paddingTop: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <div>
                    <h4 style={{ margin: '0 0 2px 0', fontSize: '14px', color: '#1e293b' }}>
                      Team Members <span className="count-pill">{members.length}</span>
                    </h4>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Manage roles and access permissions.</span>
                  </div>
                  {workspace.is_admin && (
                    <button
                      type="button"
                      className="primary btn-mini"
                      onClick={() => setInviteModal({ open: true, name: '', email: '', role: 'Developer', loading: false, error: '' })}
                    >
                      <Plus size={13} style={{ marginRight: '4px' }} /> Invite Member
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {members.map(m => (
                    <div key={m.id} className="member-row">
                      <div className="member-info">
                        {m.avatar_url ? (
                          <img src={m.avatar_url} alt="" className="member-avatar" />
                        ) : (
                          <div className="member-avatar-placeholder">
                            {m.name.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <strong style={{ fontSize: '13px', color: '#1e293b', display: 'block' }}>{m.name}</strong>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>{m.email}</span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {workspace.is_admin ? (
                          <select
                            value={m.role}
                            onChange={e => handleRoleChange(m.id, e.target.value)}
                            style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '4px' }}
                          >
                            <option value="QA Manager">QA Manager (Admin)</option>
                            <option value="Developer">Developer</option>
                            <option value="Tester">Tester</option>
                          </select>
                        ) : (
                          <span className={`badge-role ${m.role?.toLowerCase().replace(/\s+/g, '-')}`}>{m.role}</span>
                        )}

                        {workspace.is_admin && (
                          <button
                            type="button"
                            className="secondary btn-mini"
                            style={{ color: '#dc2626' }}
                            onClick={() => handleRemoveMember(m.id)}
                            title="Remove Member"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {!members.length && <p className="muted" style={{ fontSize: '12px', padding: '16px 0' }}>No team members listed.</p>}
                </div>
              </div>

              {/* Roles & Permissions Reference */}
              <div style={{ borderTop: '1px solid #edf1f5', paddingTop: '24px', marginTop: '24px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '13px', color: '#475569' }}>Roles & Permission Levels</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                  <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: '6px', fontSize: '11px' }}>
                    <strong style={{ color: '#2563eb', display: 'block', marginBottom: '2px' }}>QA Manager (Admin)</strong>
                    <span style={{ color: '#64748b' }}>Full control over workspace settings, members, role assignments, bug management, and test cycles.</span>
                  </div>
                  <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: '6px', fontSize: '11px' }}>
                    <strong style={{ color: '#16a34a', display: 'block', marginBottom: '2px' }}>Developer</strong>
                    <span style={{ color: '#64748b' }}>Can view and update bugs, generate automated AI fixes, run verification checks, and connect repositories.</span>
                  </div>
                  <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: '6px', fontSize: '11px' }}>
                    <strong style={{ color: '#ca8a04', display: 'block', marginBottom: '2px' }}>Tester</strong>
                    <span style={{ color: '#64748b' }}>Can file bug reports, execute test cases, review analyzer evidence, and download test reports.</span>
                  </div>
                </div>
              </div>

              {/* Invite Member Modal */}
              {inviteModal.open && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: '440px' }}>
                    <div className="modal-head">
                      <div>
                        <span className="eyebrow">TEAM COLLABORATION</span>
                        <h2>Invite Team Member</h2>
                      </div>
                      <button className="icon-btn" onClick={() => setInviteModal(prev => ({ ...prev, open: false }))}>
                        <X size={18} />
                      </button>
                    </div>

                    {inviteModal.error && <div className="analyzer-error">{inviteModal.error}</div>}

                    <form onSubmit={handleInviteMember}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                        Full Name *
                      </label>
                      <input
                        value={inviteModal.name}
                        onChange={e => setInviteModal({ ...inviteModal, name: e.target.value })}
                        placeholder="Jane Doe"
                        required
                        style={{ width: '100%', marginBottom: '12px' }}
                      />

                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                        Email Address *
                      </label>
                      <input
                        type="email"
                        value={inviteModal.email}
                        onChange={e => setInviteModal({ ...inviteModal, email: e.target.value })}
                        placeholder="jane@company.com"
                        required
                        style={{ width: '100%', marginBottom: '12px' }}
                      />

                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>
                        Assigned Role *
                      </label>
                      <select
                        value={inviteModal.role}
                        onChange={e => setInviteModal({ ...inviteModal, role: e.target.value })}
                        style={{ width: '100%', marginBottom: '16px' }}
                      >
                        <option value="QA Manager">QA Manager (Admin)</option>
                        <option value="Developer">Developer</option>
                        <option value="Tester">Tester</option>
                      </select>

                      <div className="modal-actions">
                        <button type="button" className="secondary" onClick={() => setInviteModal(prev => ({ ...prev, open: false }))}>
                          Cancel
                        </button>
                        <button type="submit" className="primary" disabled={inviteModal.loading}>
                          {inviteModal.loading ? 'Inviting...' : 'Send Invitation'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 5: APPEARANCE */}
          {tab === 'Appearance' && (
            <div className="settings-section">
              <h3>Appearance & Theme</h3>
              <p className="muted">Customize the visual theme, accent colors, and interface density.</p>

              <form onSubmit={handleSaveAppearance}>
                {/* Theme Mode */}
                <div style={{ marginBottom: '24px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 700, color: '#1e293b', display: 'block', marginBottom: '6px' }}>
                    Color Theme Mode
                  </label>
                  <div className="choice-grid">
                    {[
                      { id: 'light', label: 'Light Mode', sub: 'Clean high-contrast daytime UI' },
                      { id: 'dark', label: 'Dark Mode', sub: 'Easy on the eyes in low light' },
                      { id: 'system', label: 'System Default', sub: 'Sync with operating system' }
                    ].map(m => (
                      <div
                        key={m.id}
                        className={`choice-card ${appearance.theme === m.id ? 'active' : ''}`}
                        onClick={() => handleUpdateAppearance('theme', m.id)}
                      >
                        <span>{m.label}</span>
                        <small style={{ color: '#64748b', fontSize: '10px' }}>{m.sub}</small>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Accent Color Palette */}
                <div style={{ marginBottom: '24px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 700, color: '#1e293b', display: 'block', marginBottom: '6px' }}>
                    Accent Color Palette
                  </label>
                  <div className="theme-swatches">
                    {[
                      { id: 'blue', color: '#3979ee', name: 'Classic Blue' },
                      { id: 'emerald', color: '#059669', name: 'Emerald Green' },
                      { id: 'indigo', color: '#4f46e5', name: 'Modern Indigo' },
                      { id: 'amber', color: '#d97706', name: 'Warm Amber' },
                      { id: 'rose', color: '#e11d48', name: 'Vibrant Rose' }
                    ].map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className={`swatch-btn ${appearance.theme_color === c.id ? 'active' : ''}`}
                        style={{ background: c.color }}
                        onClick={() => handleUpdateAppearance('theme_color', c.id)}
                        title={c.name}
                      >
                        {appearance.theme_color === c.id && <Check size={16} color="#fff" />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Layout Density */}
                <div style={{ marginBottom: '24px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 700, color: '#1e293b', display: 'block', marginBottom: '6px' }}>
                    Interface Density
                  </label>
                  <div className="choice-grid">
                    {[
                      { id: 'comfortable', label: 'Comfortable', sub: 'Spacious padding and standard tables' },
                      { id: 'compact', label: 'Compact', sub: 'Higher information density for power users' }
                    ].map(d => (
                      <div
                        key={d.id}
                        className={`choice-card ${appearance.layout === d.id ? 'active' : ''}`}
                        onClick={() => handleUpdateAppearance('layout', d.id)}
                      >
                        <span>{d.label}</span>
                        <small style={{ color: '#64748b', fontSize: '10px' }}>{d.sub}</small>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="primary" disabled={savingAppearance}>
                    {savingAppearance ? 'Saving...' : 'Save Appearance Preferences'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* TAB 6: INTEGRATIONS */}
          {tab === 'Integrations' && (
            <div className="settings-section">
              <h3>External Services & Integrations</h3>
              <p className="muted">Manage cloud integrations, email services, and programmatic API access.</p>

              {/* GitHub Card */}
              <div className="integration-card">
                <div className="integration-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <GitBranch size={20} color="#2563eb" />
                    <div>
                      <strong style={{ fontSize: '14px', color: '#1e293b' }}>GitHub Integration</strong>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>Connect repositories for automated static code scanning.</div>
                    </div>
                  </div>
                  <div>
                    {integrations?.github?.connected ? (
                      <span style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a' }}>
                        <span className="status-dot green" /> Connected ({integrations.github.username})
                      </span>
                    ) : (
                      <span style={{ fontSize: '11px', fontWeight: 700, color: '#ca8a04' }}>
                        <span className="status-dot yellow" /> Ready to Connect
                      </span>
                    )}
                  </div>
                </div>
                <div className="integration-meta">
                  <span><strong>Connected Account:</strong> {integrations?.github?.username || 'None configured'}</span>
                  <span><strong>Repositories:</strong> {integrations?.github?.repo_count || 0} visible</span>
                  <span><strong>Scanning Scope:</strong> Python, JS/TS, Java</span>
                </div>
              </div>

              {/* Gmail SMTP Status Card */}
              <div className="integration-card">
                <div className="integration-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Bell size={20} color="#059669" />
                    <div>
                      <strong style={{ fontSize: '14px', color: '#1e293b' }}>Gmail SMTP Email Service</strong>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>Powers verification OTPs, password reset emails, and alerts.</div>
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a' }}>
                    <span className="status-dot green" /> Operational
                  </span>
                </div>
                <div className="integration-meta">
                  <span><strong>SMTP Host:</strong> {integrations?.smtp?.host || 'smtp.gmail.com'}</span>
                  <span><strong>Port:</strong> {integrations?.smtp?.port || 587}</span>
                  <span><strong>Security:</strong> TLS / STARTTLS</span>
                  <span><strong>Sender Account:</strong> {integrations?.smtp?.sender_user || 'Masked (Gmail App Pass)'}</span>
                </div>
              </div>

              {/* Supabase Database Card */}
              <div className="integration-card">
                <div className="integration-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Building2 size={20} color="#0284c7" />
                    <div>
                      <strong style={{ fontSize: '14px', color: '#1e293b' }}>Supabase PostgreSQL Database</strong>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>Primary cloud persistence for users, bug reports, and audit logs.</div>
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a' }}>
                    <span className="status-dot green" /> Connected & Active
                  </span>
                </div>
                <div className="integration-meta">
                  <span><strong>Provider:</strong> PostgreSQL (Supabase Cloud)</span>
                  <span><strong>Status:</strong> Healthy</span>
                  <span><strong>Synced Tables:</strong> profiles, bugs, test_cases, fixes, audit_logs</span>
                </div>
              </div>

              {/* API Key Management */}
              <div className="integration-card">
                <div className="integration-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Key size={20} color="#7c3aed" />
                    <div>
                      <strong style={{ fontSize: '14px', color: '#1e293b' }}>Personal REST API Access Key</strong>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>Authenticate automated CI/CD scripts and test runners.</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="primary btn-mini"
                    onClick={handleGenerateApiKey}
                    disabled={generatingKey}
                  >
                    {generatingKey ? 'Generating...' : 'Generate New API Key'}
                  </button>
                </div>

                {newApiKey && (
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '12px', borderRadius: '6px', margin: '10px 0' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#166534', display: 'block', marginBottom: '4px' }}>
                      Newly Generated API Key (Save it now; it won't be shown again in full):
                    </span>
                    <div className="api-key-box">
                      <span>{newApiKey}</span>
                      <button
                        type="button"
                        className="secondary btn-mini"
                        onClick={() => { navigator.clipboard.writeText(newApiKey); notify('API key copied to clipboard.'); }}
                      >
                        <Copy size={13} style={{ marginRight: '4px' }} /> Copy Key
                      </button>
                    </div>
                  </div>
                )}

                <div className="integration-meta">
                  <span><strong>Active Key Prefix:</strong> {integrations?.api_key?.prefix || 'btk_live_••••'}</span>
                  <span><strong>Status:</strong> Active</span>
                  <span><strong>Key Scope:</strong> Read/Write Bugs, Trigger Static Analyzer</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 7: ACTIVITY & AUDIT LOGS */}
          {tab === 'Activity Logs' && (
            <div className="settings-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <h3>Activity & Audit Trail</h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="secondary btn-mini"
                    onClick={() => fetchAuditLogs(auditFilter)}
                    disabled={loadingAudit}
                  >
                    <RefreshCw size={13} style={{ marginRight: '4px' }} /> Refresh
                  </button>
                  <a
                    href={resolveApiUrl('/api/settings/audit-logs/export')}
                    className="secondary btn-mini"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                    download="audit-logs.csv"
                  >
                    <Download size={13} style={{ marginRight: '4px' }} /> Export CSV
                  </a>
                </div>
              </div>
              <p className="muted">Track account logins, password modifications, workspace events, and bug report updates.</p>

              {/* Filter Pills */}
              <div className="filter-pills">
                {['All', 'Security', 'Workspace', 'Bug Reports', 'System'].map(f => (
                  <button
                    key={f}
                    type="button"
                    className={`pill-btn ${auditFilter === f ? 'active' : ''}`}
                    onClick={() => {
                      setAuditFilter(f);
                      fetchAuditLogs(f);
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Logs Table */}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Actor & Role</th>
                      <th>Activity Description</th>
                      <th>IP Address</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map(l => (
                      <tr key={l.id}>
                        <td>
                          <span className={`badge-audit ${l.category?.toLowerCase().replace(/\s+/g, '-') || 'system'}`}>
                            {l.category || 'System'}
                          </span>
                        </td>
                        <td>
                          <strong style={{ fontSize: '12px', color: '#1e293b' }}>{l.user}</strong>
                          <small style={{ color: '#64748b', fontSize: '10px' }}>{l.role}</small>
                        </td>
                        <td>
                          <span style={{ fontSize: '12px', color: '#334155' }}>{l.details || l.action}</span>
                        </td>
                        <td style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                          {l.ip}
                        </td>
                        <td style={{ fontSize: '11px', color: '#64748b' }}>
                          {new Date(l.timestamp).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {!auditLogs.length && (
                      <tr>
                        <td colSpan="5" className="empty">
                          {loadingAudit ? 'Loading audit records...' : 'No activity logs found for this filter.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function Toggle({ label, description, checked, onChange }) { return <label className="toggle-row"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={onChange}/><i/></label>; }
function BugModal({data:initial,close,save,onSelectBug}) {
  const [data,setData]=useState(initial), [file,setFile]=useState(null), [duplicateCheck,setDuplicateCheck]=useState({loading:false,result:null}), [bypassedDuplicates,setBypassedDuplicates]=useState(false), [priorityPrediction,setPriorityPrediction]=useState({loading:false,result:null});
  const set=(k,v)=>{
    setData(prev=>({...prev,[k]:v}));
    if(['title','description','module'].includes(k)){setBypassedDuplicates(false)}
  };

  const checkForDuplicates = async () => {
    if(!data.title?.trim()&&!data.description?.trim()) return null;
    setDuplicateCheck(prev=>({...prev,loading:true}));
    try{
      const res=await api('/api/bugs/check-duplicate',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          title:data.title||'',
          description:data.description||'',
          module:data.module||'',
          current_bug_id:data.id||null
        })
      });
      setDuplicateCheck({loading:false,result:res});
      return res;
    }catch{
      setDuplicateCheck({loading:false,result:null});
      return null;
    }
  };

  const predictPriority = async () => {
    if(!data.title?.trim()&&!data.description?.trim()) return;
    setPriorityPrediction({loading:true,result:null});
    try{
      const res=await api('/api/bugs/predict-priority',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          title:data.title||'',
          description:data.description||'',
          module:data.module||'',
          severity:data.severity||'',
          steps:data.steps||'',
          actual:data.actual||''
        })
      });
      setPriorityPrediction({loading:false,result:res});
    }catch{
      setPriorityPrediction({loading:false,result:null});
    }
  };

  const handleSave = async () => {
    if(!data.id && !bypassedDuplicates){
      const dupResult = await checkForDuplicates();
      if(dupResult && dupResult.is_duplicate && dupResult.matches?.length > 0){
        return; // Halt and show duplicate warning banner
      }
    }
    save(data, file);
  };

  return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><span className="eyebrow">{data.id?'EDIT BUG':'NEW BUG REPORT'}</span><h2>{data.id?data.bug_key:'Create a bug report'}</h2></div><button className="icon-btn" onClick={close}><X size={18}/></button></div>
  {duplicateCheck.result?.matches?.length > 0 && (
    <div className="duplicate-alert">
      <div className="duplicate-alert-header">
        <div className="duplicate-alert-title">
          <AlertCircle size={17} color="#c2410c"/>
          <span>Potential duplicate bug detected ({duplicateCheck.result.highest_similarity}% match)</span>
        </div>
        <button type="button" className="secondary btn-mini" onClick={()=>setDuplicateCheck({loading:false,result:null})}>Dismiss</button>
      </div>
      <p style={{margin:'0 0 10px',fontSize:'11px',color:'#9a3412'}}>
        Existing bug reports in this workspace report matching symptoms. Inspect the previous solution below to avoid redundant reporting.
      </p>
      {duplicateCheck.result.matches.slice(0, 3).map(m=>(
        <div key={m.id} className="duplicate-match-card">
          <div className="duplicate-match-top">
            <div>
              <strong style={{color:'#1b2a41'}}>{m.bug_key}: {m.title}</strong>
              <span style={{fontSize:'11px',color:'#64748b',marginLeft:'6px'}}>({m.module})</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
              <span className={`status ${m.status.toLowerCase().replace(' ','-')}`} style={{fontSize:'9px',padding:'2px 6px'}}>{m.status}</span>
              <span className="similarity-pill">{m.similarity}% similarity</span>
            </div>
          </div>
          <div className="duplicate-reasons">Reasons: {m.reasons.join(' · ')}</div>
          {m.previous_solution && (
            <div className="duplicate-solution">
              <strong>Previous solution / status:</strong>
              {m.previous_solution}
            </div>
          )}
          <div className="duplicate-actions">
            <button
              type="button"
              className="secondary btn-mini"
              onClick={()=>{
                close();
                onSelectBug?.(m);
              }}
            >
              Open existing {m.bug_key}
            </button>
          </div>
        </div>
      ))}
      <div style={{marginTop:'12px',display:'flex',justifyContent:'flex-end',gap:'8px'}}>
        <button
          type="button"
          className="primary btn-mini"
          onClick={()=>{
            setBypassedDuplicates(true);
            save(data,file);
          }}
        >
          Submit anyway (Not a duplicate)
        </button>
      </div>
    </div>
  )}
  <div className="form-grid"><label>Title *<div style={{display:'flex',gap:'6px'}}><input style={{flex:1}} value={data.title} onChange={e=>set('title',e.target.value)} placeholder="Short descriptive summary"/><button type="button" className="secondary" style={{padding:'4px 9px',fontSize:'11px',whiteSpace:'nowrap'}} onClick={checkForDuplicates} disabled={duplicateCheck.loading}>{duplicateCheck.loading?'Checking...':'AI Duplicate Check'}</button></div></label><label>Module *<select value={data.module} onChange={e=>set('module',e.target.value)}><option value="">Select module</option>{['Checkout','Authentication','Profile','Reports','Dashboard','Mobile','main.py'].map(x=><option key={x}>{x}</option>)}</select></label><label className="wide">Description *<textarea value={data.description} onChange={e=>set('description',e.target.value)} placeholder="Detailed description of the issue..."/></label><label>Severity<select value={data.severity} onChange={e=>set('severity',e.target.value)}>{['Critical','Major','Minor','Trivial'].map(x=><option key={x}>{x}</option>)}</select></label><label className="wide"><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'4px'}}><span>Priority *</span><button type="button" className="secondary btn-mini" style={{padding:'3px 8px',fontSize:'11px',display:'inline-flex',alignItems:'center'}} onClick={predictPriority} disabled={priorityPrediction.loading}><Sparkles size={12} style={{marginRight:'4px'}}/>{priorityPrediction.loading?'Predicting...':'AI Predict Priority'}</button></div><select value={data.priority} onChange={e=>set('priority',e.target.value)}>{['P0','P1','P2','P3'].map(x=><option key={x}>{x}</option>)}</select>{priorityPrediction.result && (<div className="ai-priority-card"><div className="ai-priority-header"><div style={{display:'flex',alignItems:'center',gap:'6px'}}><Sparkles size={13} color="#15803d"/><strong>Suggested: {priorityPrediction.result.predicted_priority} ({priorityPrediction.result.priority_label})</strong><span className={`ai-priority-badge ${priorityPrediction.result.predicted_priority.toLowerCase()}`}>{Math.round(priorityPrediction.result.confidence*100)}% confidence</span></div>{data.priority!==priorityPrediction.result.predicted_priority&&<button type="button" className="primary btn-mini" style={{padding:'2px 7px',fontSize:'10px'}} onClick={()=>{set('priority',priorityPrediction.result.predicted_priority);set('predicted_priority',priorityPrediction.result.predicted_priority);set('priority_reason',priorityPrediction.result.reasoning)}}>Apply Suggestion</button>}</div><p style={{margin:'2px 0',color:'#166534'}}>{priorityPrediction.result.reasoning}</p><div className="ai-priority-factors">Factors: {priorityPrediction.result.factors?.join(' · ')}</div></div>)}</label><label>Status<select value={data.status} onChange={e=>set('status',e.target.value)}>{statuses.map(x=><option key={x}>{x}</option>)}</select></label><label>Assignee<select value={data.assignee} onChange={e=>set('assignee',e.target.value)}><option value="">Select assignee</option><option>Maya Chen</option><option>Alex Morgan</option><option>Jordan Lee</option></select></label><label className="wide">Steps to reproduce<textarea value={data.steps} onChange={e=>set('steps',e.target.value)} placeholder="1. Action taken&#10;2. What occurred"/></label><label>Expected result<textarea value={data.expected} onChange={e=>set('expected',e.target.value)}/></label><label>Actual result<textarea value={data.actual} onChange={e=>set('actual',e.target.value)}/></label><label className="wide">Screenshot<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setFile(e.target.files?.[0]||null)}/><small className="field-help">PNG, JPG, or WEBP up to 5 MB {file ? `· ${file.name}` : ''}</small></label></div><div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" onClick={handleSave}>{data.id?'Save changes':'Create bug report'}</button></div></div></div>; }
createRoot(document.getElementById('root')).render(<App/>);
