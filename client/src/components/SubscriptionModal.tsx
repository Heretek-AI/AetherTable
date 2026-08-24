import React from 'react';
import { Crown, CreditCard, HardDrive, CheckCircle } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

interface SubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({ isOpen, onClose }) => {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="SaaS Account & Subscription"
      subtitle="Manage your subscription plan, asset storage, and billing."
      icon={<Crown className="w-5 h-5" />}
      size="md"
      footer={
        /* Footer Actions */
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            Close
          </button>
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Manage Billing (Stripe)</span>
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Current Plan Card */}
        <div className="vtt-surface rounded-xl p-4 shadow-inner space-y-3 border-tavern-accent/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-[var(--rp-parchment-300)]">ACTIVE PLAN</span>
              {/* Tier chip — printed-book badge */}
              <span className="vtt-badge font-mono font-bold">MASTER TIER GM</span>
            </div>
            <span className="vtt-badge vtt-badge-success font-mono font-semibold">$9.99 / mo</span>
          </div>

          <div className="space-y-1 text-xs text-[var(--rp-parchment-200)]">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-tavern-accent" />
              <span>Unlimited Active Campaigns (3 Active)</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-tavern-accent" />
              <span>3D WebRTC Voice Mesh & Positional Audio</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3.5 h-3.5 text-tavern-accent" />
              <span>Procedural WFC Dungeon Generation</span>
            </div>
          </div>
        </div>

        {/* Asset Cloud Storage Quota */}
        <div className="space-y-2 text-xs font-mono vtt-surface p-4 rounded-xl">
          <div className="flex items-center justify-between text-[var(--rp-parchment-200)]">
            <span className="flex items-center space-x-1.5 font-bold">
              <HardDrive className="w-3.5 h-3.5 text-tavern-accent" />
              <span>Cloud Asset Quota</span>
            </span>
            <span className="text-[var(--rp-parchment-300)]">12.4 MB / 1,000 MB (1.2%)</span>
          </div>

          <div className="w-full h-2 bg-tavern-bg rounded-full overflow-hidden border border-tavern-border">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[var(--tavern-accent)] to-[var(--tavern-accent-deep)]"
              style={{ width: '1.2%' }}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
