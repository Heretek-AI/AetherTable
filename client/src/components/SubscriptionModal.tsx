import React from 'react';
import { Crown, CreditCard, HardDrive, FlaskConical } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

/**
 * PREVIEW SURFACE — not wired to any payment, billing, or entitlement backend.
 *
 * There is no payment provider in this repository (no stripe/payment/checkout
 * routes exist in the orchestrator) and no subscription or quota API. Nothing
 * shown here reflects a real account state:
 *   - The "plan" and its price are illustrative samples; no entitlement check
 *     backs them, so nothing may be described as active, owned, or unlocked.
 *   - The storage quota figure is a static sample, not real usage.
 *   - There is no billing action to take.
 */

interface SubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SAMPLE_PLAN_FEATURES = [
  'Unlimited Active Campaigns',
  '3D WebRTC Voice Mesh & Positional Audio',
  'Procedural WFC Dungeon Generation',
];

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({ isOpen, onClose }) => {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="SaaS Account & Subscription"
      subtitle="Preview only — not wired to a payment provider; nothing can be bought."
      icon={<Crown className="w-5 h-5" />}
      size="md"
      footer={
        /* Footer Actions — no billing CTA: no provider exists to bill through. */
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            Close
          </button>
          <button
            disabled
            aria-disabled="true"
            title="Not wired to a payment provider — billing cannot be managed in this build."
            className="vtt-btn vtt-btn-primary opacity-50 cursor-not-allowed font-display tracking-wide"
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Billing Unavailable in Preview</span>
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Honesty banner */}
        <div className="vtt-surface rounded-xl p-3 border border-amber-500/40 flex items-start space-x-2.5">
          <FlaskConical className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs font-prose text-[var(--rp-parchment-200)] leading-relaxed">
            <span className="font-bold text-amber-300">Sample display.</span> This build has no
            subscription, billing, or entitlement backend. The plan, price, feature list, and
            quota below are illustrative samples — they do not describe an account you hold or
            anything you have purchased.
          </p>
        </div>

        {/* Sample Plan Card — explicitly not an active entitlement */}
        <div className="vtt-surface rounded-xl p-4 shadow-inner space-y-3 border-tavern-accent/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-[var(--rp-parchment-300)]">SAMPLE PLAN</span>
              <span
                className="vtt-badge font-mono font-bold"
                title="Illustrative tier name — no entitlement check backs this label."
              >
                MASTER TIER GM
              </span>
            </div>
            <span
              className="vtt-badge font-mono font-semibold"
              title="Sample price only — no purchase flow exists."
            >
              $9.99 / mo (sample)
            </span>
          </div>

          <p className="text-[11px] text-[var(--rp-parchment-300)] font-prose">
            What this tier would include if it existed:
          </p>

          <ul className="space-y-1 text-xs text-[var(--rp-parchment-200)] list-none">
            {SAMPLE_PLAN_FEATURES.map((feature) => (
              <li key={feature} className="flex items-center space-x-2">
                <FlaskConical className="w-3.5 h-3.5 text-[var(--rp-parchment-300)] shrink-0" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Sample Storage Quota — static numbers, not connected to any storage backend */}
        <div className="space-y-2 text-xs font-mono vtt-surface p-4 rounded-xl">
          <div className="flex items-center justify-between text-[var(--rp-parchment-200)]">
            <span className="flex items-center space-x-1.5 font-bold">
              <HardDrive className="w-3.5 h-3.5 text-tavern-accent" />
              <span>Cloud Asset Quota</span>
              <span className="vtt-badge" title="Static sample figures — not measured usage.">
                sample
              </span>
            </span>
            <span className="text-[var(--rp-parchment-300)]">12.4 MB / 1,000 MB (1.2%)</span>
          </div>

          <div className="w-full h-2 bg-tavern-bg rounded-full overflow-hidden border border-tavern-border">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[var(--tavern-accent)] to-[var(--tavern-accent-deep)] opacity-60"
              style={{ width: '1.2%' }}
            />
          </div>

          <p className="text-[10px] text-[var(--rp-parchment-300)] font-prose">
            Static sample figures — no quota API or asset-storage accounting is wired up.
          </p>
        </div>
      </div>
    </ModalShell>
  );
};
