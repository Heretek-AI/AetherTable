import React from 'react';
import {
  Crown,
  Shield,
  CreditCard,
  HardDrive,
  Users,
  CheckCircle,
  X,
  Sparkles,
  Zap,
  Award,
} from 'lucide-react';

interface SubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-500 to-amber-700 rounded-xl text-slate-950 shadow-lg shadow-amber-950/50 font-bold">
              <Crown className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold font-serif text-slate-100">SaaS Account & Subscription</h2>
              <p className="text-xs text-slate-400">Manage your subscription plan, asset storage, and billing.</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Plan Card */}
        <div className="bg-slate-950/80 border border-amber-500/40 rounded-xl p-4 shadow-inner space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-slate-300">ACTIVE PLAN</span>
              <span className="px-2 py-0.5 bg-amber-950 text-amber-300 border border-amber-600/50 text-[10px] font-mono font-bold rounded">
                MASTER TIER GM
              </span>
            </div>
            <span className="text-xs font-mono text-emerald-400 font-semibold">$9.99 / mo</span>
          </div>

          <div className="space-y-1 text-xs text-slate-300">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>Unlimited Active Campaigns (3 Active)</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>3D WebRTC Voice Mesh & Positional Audio</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>Procedural WFC Dungeon Generation</span>
            </div>
          </div>
        </div>

        {/* Asset Cloud Storage Quota */}
        <div className="space-y-2 text-xs font-mono bg-slate-950 p-4 rounded-xl border border-slate-800">
          <div className="flex items-center justify-between text-slate-300">
            <span className="flex items-center space-x-1.5 font-bold">
              <HardDrive className="w-3.5 h-3.5 text-sky-400" />
              <span>Cloud Asset Quota</span>
            </span>
            <span className="text-slate-400">12.4 MB / 1,000 MB (1.2%)</span>
          </div>

          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-sky-500 to-amber-500 rounded-full" style={{ width: '1.2%' }} />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="pt-2 border-t border-slate-800 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg cursor-pointer"
          >
            Close
          </button>
          <button
            onClick={onClose}
            className="flex items-center space-x-1.5 px-4 py-2 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-xs font-bold rounded-lg shadow cursor-pointer"
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Manage Billing (Stripe)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
