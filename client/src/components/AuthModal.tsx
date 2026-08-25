import React, { useState } from 'react';
import {
  Sparkles,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Zap,
} from 'lucide-react';
import { User, DEMO_ACCOUNTS, UserRole } from '../types/auth';
import { ModalShell } from './ui/ModalShell';

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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="AetherTable Identity Portal"
      subtitle="Sign in to join active campaigns or create a new adventurer account."
      icon={<Sparkles className="w-5 h-5" />}
      size="md"
    >
      <div className="space-y-5">
        {/* Tab Switcher */}
        <div className="vtt-tabbar w-full font-display text-xs">
          <button
            onClick={() => {
              setTab('signin');
              setError(null);
            }}
            data-active={tab === 'signin'}
            className="vtt-tab flex-1 text-center"
          >
            Sign In
          </button>
          <button
            onClick={() => {
              setTab('signup');
              setError(null);
            }}
            data-active={tab === 'signup'}
            className="vtt-tab flex-1 text-center"
          >
            Create Account
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg border border-[color-mix(in_srgb,var(--state-danger)_55%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] text-xs text-[var(--rp-crimson-400)] font-mono">
            {error}
          </div>
        )}

        {/* Sign In Form */}
        {tab === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)] flex items-center space-x-1.5">
                <Mail className="w-3.5 h-3.5 text-tavern-accent" />
                <span>Email or Username</span>
              </label>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@aethertable.io or thorin"
                className="vtt-input w-full text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)] flex items-center space-x-1.5">
                <Lock className="w-3.5 h-3.5 text-tavern-accent" />
                <span>Password</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="vtt-input w-full pr-9 text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-2.5 text-[var(--rp-parchment-300)] hover:text-tavern-accent"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="vtt-btn vtt-btn-primary w-full font-display tracking-wide"
            >
              Sign In to Tabletop
            </button>
          </form>
        )}

        {/* Sign Up Form */}
        {tab === 'signup' && (
          <form onSubmit={handleSignUp} className="space-y-3.5">
            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Lord Valen Shadowbane"
                className="vtt-input w-full text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="valen@adventurers.org"
                className="vtt-input w-full text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="vtt-input w-full text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Primary Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="vtt-select w-full text-xs"
              >
                {/* Self-service roles only (server _SELF_SERVICE_ROLES): the
                    gateway 422s any attempt to self-assign 'gm' or 'admin' —
                    staff roles are bootstrapped via VTT_ADMIN_EMAILS. */}
                <option value="player">Player Character (Hero)</option>
                <option value="spectator">Spectator / Viewer</option>
              </select>
              <p className="text-[10px] text-[var(--rp-parchment-300)] mt-1">
                GM and admin seats are provisioned by your table's operator, not self-assigned.
              </p>
            </div>

            <button
              type="submit"
              className="vtt-btn vtt-btn-primary w-full font-display tracking-wide"
            >
              Create Account & Launch
            </button>
          </form>
        )}

        {/* 1-Click Fast Demo Accounts Switcher */}
        <div className="pt-3 border-t border-tavern-border space-y-2">
          <div className="flex items-center justify-between">
            <span className="vtt-section-header text-[11px] font-bold">
              <Zap className="w-3 h-3 shrink-0 text-tavern-accent" />
              <span>Instant Fast Demo Logins (Multi-User)</span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((demo) => (
              <button
                key={demo.user.id}
                onClick={() => handleQuickDemoLogin(demo)}
                className="p-2.5 vtt-surface rounded-xl text-left transition-all group cursor-pointer flex flex-col justify-between hover:border-tavern-accent hover:bg-[color-mix(in_srgb,var(--tavern-accent)_8%,transparent)]"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--rp-parchment-100)] group-hover:text-tavern-accent transition-colors font-display">
                      {demo.user.displayName.split(' ')[0]}
                    </span>
                    <span className="vtt-badge">{demo.user.role.toUpperCase()}</span>
                  </div>
                  <p className="text-[10px] text-[var(--rp-parchment-300)] line-clamp-1 mt-0.5">{demo.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
