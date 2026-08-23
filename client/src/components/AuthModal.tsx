import React, { useState } from 'react';
import {
  Sparkles,
  Shield,
  Crown,
  UserCheck,
  Eye,
  EyeOff,
  X,
  ArrowRight,
  Lock,
  Mail,
  User as UserIcon,
  CheckCircle2,
  Zap,
} from 'lucide-react';
import { User, DEMO_ACCOUNTS, UserRole } from '../types/auth';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: User) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const [tab, setTab] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('player');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please enter your email and password.');
      return;
    }
    // Server-backed login first; fall back to the demo directory when the
    // orchestrator is unreachable so the tabletop never hard-blocks.
    fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
      .then(async (resp) => {
        if (resp.ok) {
          const data = await resp.json();
          sessionStorage.setItem('aethertable_token', data.token);
          onLoginSuccess({ ...data.user, avatarUrl: 'fighter', diceTheme: 'gold', bio: undefined } as User);
          onClose();
        } else {
          setError((await resp.json()).detail || 'Invalid email or password.');
        }
      })
      .catch(() => {
        const matched = DEMO_ACCOUNTS.find(
          (d) =>
            d.user.email.toLowerCase() === email.toLowerCase() ||
            d.user.username.toLowerCase() === email.toLowerCase()
        );
        if (matched) {
          onLoginSuccess(matched.user);
          onClose();
        } else {
          setError('Auth server unavailable and no matching demo account.');
        }
      });
  };

  const handleSignUp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !displayName) {
      setError('All fields are required for sign up.');
      return;
    }
    fetch('/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        username: email.split('@')[0],
        display_name: displayName,
        password,
        role,
      }),
    })
      .then(async (resp) => {
        if (resp.ok) {
          const data = await resp.json();
          sessionStorage.setItem('aethertable_token', data.token);
          onLoginSuccess({ ...data.user, avatarUrl: 'fighter', diceTheme: 'gold', bio: undefined } as User);
          onClose();
        } else {
          setError((await resp.json()).detail || 'Sign up failed.');
        }
      })
      .catch(() => {
        // Offline fallback: local-only account.
        const newUser: User = {
          id: `usr_${Date.now()}`,
          username: email.split('@')[0],
          email,
          displayName,
          avatarUrl: role === 'admin' ? 'crown' : role === 'gm' ? 'crown' : role === 'spectator' ? 'scout' : 'fighter',
          role,
          subscriptionTier: role === 'admin' ? 'master' : 'hero',
          assignedTokenIds: role === 'admin' || role === 'gm' ? ['*'] : ['thorin_1'],
          diceTheme: 'gold',
          createdAt: new Date().toISOString(),
        };
        onLoginSuccess(newUser);
        onClose();
      });
  };

  const handleQuickDemoLogin = (demo: typeof DEMO_ACCOUNTS[0]) => {
    onLoginSuccess(demo.user);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-500 to-red-600 rounded-xl text-white shadow-lg shadow-amber-950/50">
              <Sparkles className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif tracking-wide text-slate-100">
                AetherTable Identity Portal
              </h2>
              <p className="text-xs text-slate-400">
                Sign in to join active campaigns or create a new adventurer account.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
                        className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
              <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 font-mono text-xs">
          <button
            onClick={() => {
              setTab('signin');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-md font-bold transition cursor-pointer ${
              tab === 'signin' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => {
              setTab('signup');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-md font-bold transition cursor-pointer ${
              tab === 'signup' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Account
          </button>
        </div>

        {error && (
          <div className="p-3 bg-rose-950/80 border border-rose-600/50 rounded-lg text-xs text-rose-300 font-mono">
            {error}
          </div>
        )}

        {/* Sign In Form */}
        {tab === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-slate-300 flex items-center space-x-1.5">
                <Mail className="w-3.5 h-3.5 text-amber-400" />
                <span>Email or Username</span>
              </label>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@aethertable.io or thorin"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-slate-300 flex items-center space-x-1.5">
                <Lock className="w-3.5 h-3.5 text-amber-400" />
                <span>Password</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-3 pr-9 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white font-bold text-xs rounded-lg shadow-lg shadow-amber-950/60 transition cursor-pointer"
            >
              Sign In to Tabletop
            </button>
          </form>
        )}

        {/* Sign Up Form */}
        {tab === 'signup' && (
          <form onSubmit={handleSignUp} className="space-y-3.5">
            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Lord Valen Shadowbane"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="valen@adventurers.org"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-300">Primary Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 font-mono"
              >
                <option value="player">Player Character (Hero)</option>
                <option value="gm">Dungeon Master (GM)</option>
                <option value="admin">Platform Administrator</option>
                <option value="spectator">Spectator / Viewer</option>
              </select>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white font-bold text-xs rounded-lg shadow-lg shadow-amber-950/60 transition cursor-pointer"
            >
              Create Account & Launch
            </button>
          </form>
        )}

        {/* 1-Click Fast Demo Accounts Switcher */}
        <div className="pt-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider flex items-center space-x-1">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>Instant Fast Demo Logins (Multi-User)</span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((demo) => (
              <button
                key={demo.user.id}
                onClick={() => handleQuickDemoLogin(demo)}
                className="p-2.5 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/50 rounded-xl text-left transition-all group cursor-pointer flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-200 group-hover:text-amber-300 transition-colors">
                      {demo.user.displayName.split(' ')[0]}
                    </span>
                    <span className="text-[9px] font-mono px-1.5 py-0.2 bg-slate-900 border border-slate-700 rounded text-slate-400">
                      {demo.user.role.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 line-clamp-1 mt-0.5">{demo.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
