import React, { useState } from 'react';
import {
  Sparkles,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ArrowRight,
} from 'lucide-react';

interface LandingPageViewProps {
  onEnterApp: (targetView?: string) => void;
  onOpenPricing?: () => void;
  onOpenAuth?: (initialTab?: 'signin' | 'signup') => void;
}

export const LandingPageView: React.FC<LandingPageViewProps> = ({
  onEnterApp,
  onOpenPricing,
  onOpenAuth,
}) => {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [expandedFaq, setExpandedFaq] = useState<number | null>(0);

  const faqs = [
    {
      q: 'How does the AI Dungeon Master maintain 100% mechanical accuracy?',
      a: 'Unlike standard LLM chatbots that hallucinate dice math, our platform uses a Pre-Commit Invariant Auditor. The LLM acts purely as a narrative generator, while all modifiers, armor classes, saving throws, and line-of-sight checks execute deterministically in our zero-allocation Rust Core Engine (crates/vtt-core).',
    },
    {
      q: 'Can I import my existing D&D Beyond characters and homebrew monsters?',
      a: 'Yes! You can import Homebrewery markdown, paste standard 5e stat blocks, or import full campaign bundles (.vttbundle). Our parser automatically extracts AC, HP, actions, and spell slots with typed Pydantic models.',
    },
    {
      q: 'How does 3D Spatial Audio & Voice Radar work in the browser?',
      a: 'We leverage the Web Audio API with stereo panners and biquad filter distance attenuation. When a dragon roars on the right side of the canvas or a token is 40ft away, the audio is spatialized in real-time. Our WebRTC voice mesh lets players hear each other relative to their token coordinates.',
    },
    {
      q: 'What is Wave Function Collapse (WFC) Dungeon Generation?',
      a: 'WFC is a procedural synthesis algorithm that matches socket constraints to carve coherent, playable dungeon layouts with perimeter walls, corridors, altars, and loot chests in under 5 milliseconds.',
    },
  ];

  return (
    <main className="w-full h-full overflow-y-auto bg-tavern-bg text-[var(--rp-parchment-200)] selection:bg-tavern-accent selection:text-[var(--rp-ink-900)]">
      {/* Hero Section */}
      <section className="relative overflow-hidden pt-12 pb-20 px-6 max-w-7xl mx-auto text-center flex flex-col items-center">
        {/* Dark iron candle-glow backdrop (replaces the cold blur-gradient blobs) */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] rounded-full pointer-events-none bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--rp-leather-700)_30%,transparent),transparent_70%)]" />

        {/* Hero Pill Badge */}
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-tavern-surface border border-tavern-border text-tavern-accent text-xs font-mono mb-6 animate-fadeIn">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Next-Generation D&amp;D 5e SRD 5.1 &amp; Multi-Agent Virtual Tabletop</span>
        </div>

        {/* Main Headline */}
        <h1 className="vtt-engraved text-4xl sm:text-5xl md:text-6xl font-extrabold font-display max-w-4xl leading-tight">
          Where Legendary Narratives Meet Authoritative Precision.
        </h1>

        {/* Sub-headline */}
        <p className="mt-6 text-sm sm:text-base text-[var(--rp-parchment-300)] max-w-2xl font-prose leading-relaxed">
          The all-in-one Tabletop RPG SaaS platform combining the heroic character depth of{' '}
          <strong className="text-tavern-accent font-semibold">D&amp;D Beyond</strong> with the high-performance tactical canvas of{' '}
          <strong className="text-[var(--rp-crimson-400)] font-semibold">Roll20</strong>, powered by an AI Dungeon Master with zero hallucination.
        </p>

        {/* Hero CTAs */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={() => onEnterApp('tabletop')}
            className="vtt-btn vtt-btn-primary px-7 py-3.5 font-display tracking-wide text-sm"
          >
            <span>START FREE CAMPAIGN</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => onEnterApp('compendium')}
            className="vtt-btn vtt-btn-secondary px-6 py-3.5 text-sm"
          >
            <BookOpen className="w-4 h-4 text-tavern-accent" />
            <span>Explore 5e Compendium</span>
          </button>
        </div>

        {/* Trust Badges */}
        <div className="mt-14 grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-4xl text-left text-xs">
          <div className="vtt-card-elevated rounded-xl p-4">
            <div className="text-tavern-accent font-bold font-display">Zero-Allocation</div>
            <div className="text-[var(--rp-parchment-100)] font-prose font-bold text-sm mt-0.5">Pure Rust Core</div>
            <div className="text-[11px] text-[var(--rp-parchment-300)] mt-1">Floored ability scores, 7 AC derivations &amp; LoS raycasting.</div>
          </div>
          <div className="vtt-card-elevated rounded-xl p-4">
            <div className="text-[var(--rp-crimson-400)] font-bold font-display">WebRTC Mesh</div>
            <div className="text-[var(--rp-parchment-100)] font-prose font-bold text-sm mt-0.5">3D Audio Radar</div>
            <div className="text-[11px] text-[var(--rp-parchment-300)] mt-1">Stereo azimuth panning &amp; distance sound reverberation.</div>
          </div>
          <div className="vtt-card-elevated rounded-xl p-4">
            <div className="text-emerald-400 font-bold font-display">Zero-Trust</div>
            <div className="text-[var(--rp-parchment-100)] font-prose font-bold text-sm mt-0.5">Invariant Auditor</div>
            <div className="text-[11px] text-[var(--rp-parchment-300)] mt-1">Pre-commit state interception with 2-pass retry controller.</div>
          </div>
          <div className="vtt-card-elevated rounded-xl p-4">
            <div className="text-[var(--rp-parchment-200)] font-bold font-display">WFC Engine</div>
            <div className="text-[var(--rp-parchment-100)] font-prose font-bold text-sm mt-0.5">Procedural Maps</div>
            <div className="text-[11px] text-[var(--rp-parchment-300)] mt-1">Wave function collapse dungeon synthesis in &lt;5ms.</div>
          </div>
        </div>
      </section>

      {/* Pricing Matrix Section */}
      <section className="py-16 px-6 bg-black/20 border-t border-tavern-border relative">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xs font-display font-bold uppercase tracking-widest text-tavern-accent">
            TRANSPARENT SAAS SUBSCRIPTIONS
          </div>
          <h2 className="vtt-engraved text-3xl sm:text-4xl font-bold font-display mt-2">
            Choose Your Adventuring Tier
          </h2>
          <p className="text-xs sm:text-sm text-[var(--rp-parchment-300)] max-w-xl mx-auto mt-3 font-prose">
            Upgrade your tabletop experience with unlimited campaigns, GPU AI inference, and 3D WebRTC voice radar.
          </p>

          {/* Billing Switcher */}
          <div className="mt-8 inline-flex items-center space-x-3 text-xs font-mono">
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`vtt-btn ${billingCycle === 'monthly' ? 'vtt-btn-primary' : 'vtt-btn-secondary'} text-xs`}
            >
              Monthly Billing
            </button>
            <button
              onClick={() => setBillingCycle('yearly')}
              className={`vtt-btn ${billingCycle === 'yearly' ? 'vtt-btn-primary' : 'vtt-btn-secondary'} text-xs`}
            >
              <span>Annual</span>
              <span className="text-[10px] px-1.5 py-0.2 bg-tavern-accent text-[var(--rp-ink-900)] rounded font-bold">
                Save 20%
              </span>
            </button>
          </div>

          {/* Pricing Cards */}
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto text-left">
            {/* Free Adventurer */}
            <div className="vtt-card-elevated rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-display text-[var(--rp-parchment-100)]">Adventurer</h3>
                  <span className="vtt-badge">
                    FREE
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-[var(--rp-parchment-100)]">$0</span>
                  <span className="text-xs text-[var(--rp-parchment-300)] ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-[var(--rp-parchment-300)] font-prose">Essential tools for individual players and casual one-shots.</p>

                <div className="mt-6 space-y-2.5 text-xs text-[var(--rp-parchment-200)] font-prose">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Up to 3 Active Characters</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Official D&amp;D 5e SRD 5.1 Compendium</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Real-Time Dice Rolling &amp; Physics</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Standard Battlemap Canvas</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="vtt-btn vtt-btn-secondary mt-8 w-full text-xs"
              >
                Get Started Free
              </button>
            </div>

            {/* Hero Tier (Most Popular) */}
            <div className="relative rounded-2xl p-6 flex flex-col justify-between bg-tavern-surface border-2 border-tavern-accent vtt-glow-border">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-tavern-accent text-[var(--rp-ink-900)] text-[10px] font-display font-extrabold uppercase rounded-full shadow">
                MOST POPULAR
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-display text-tavern-accent">Hero Tier</h3>
                  <span className="vtt-badge">
                    PRO DM
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-[var(--rp-parchment-100)]">
                    {billingCycle === 'monthly' ? '$9.99' : '$7.99'}
                  </span>
                  <span className="text-xs text-[var(--rp-parchment-300)] ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-[var(--rp-parchment-300)] font-prose">Everything needed to run rich autonomous campaigns.</p>

                <div className="mt-6 space-y-2.5 text-xs text-[var(--rp-parchment-200)] font-prose">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-tavern-accent shrink-0" />
                    <span><strong>Unlimited</strong> Characters &amp; Campaigns</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-tavern-accent shrink-0" />
                    <span>Dynamic Line-of-Sight &amp; Fog of War</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-tavern-accent shrink-0" />
                    <span>3D Spatial Audio &amp; Voice Radar</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-tavern-accent shrink-0" />
                    <span>WFC Procedural Dungeon Generator</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-tavern-accent shrink-0" />
                    <span>Pre-Commit Invariant Auditor DM</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="vtt-btn vtt-btn-primary mt-8 w-full font-display tracking-wide"
              >
                Upgrade to Hero Tier
              </button>
            </div>

            {/* Master Guild (Enterprise/Guilds) */}
            <div className="vtt-card-elevated rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-display text-[var(--rp-parchment-100)]">Master Guild</h3>
                  <span className="vtt-badge">
                    GUILD
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-[var(--rp-parchment-100)]">
                    {billingCycle === 'monthly' ? '$24.99' : '$19.99'}
                  </span>
                  <span className="text-xs text-[var(--rp-parchment-300)] ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-[var(--rp-parchment-300)] font-prose">For professional DMs, streamer tables, and gaming conventions.</p>

                <div className="mt-6 space-y-2.5 text-xs text-[var(--rp-parchment-200)] font-prose">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0" />
                    <span>All Hero Features + Priority GPU Inference</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0" />
                    <span>Campaign Bundles (.vttbundle) Commercial Export</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0" />
                    <span>Live Streamer Clean HUD &amp; Discord Relay</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0" />
                    <span>Dedicated Cluster SLA &amp; SLA Metrics</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="vtt-btn vtt-btn-secondary mt-8 w-full text-xs"
              >
                Join Master Guild
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-16 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <div className="text-xs font-display font-bold uppercase tracking-widest text-tavern-accent">
            KNOWLEDGE BASE
          </div>
          <h2 className="vtt-engraved text-3xl font-bold font-display mt-2">
            Frequently Asked Questions
          </h2>
        </div>

        {/* Accordion rows separated by hairline leather rules */}
        <div className="border-y border-tavern-border divide-y divide-tavern-border font-prose">
          {faqs.map((faq, index) => {
            const isExpanded = expandedFaq === index;
            return (
              <div key={index}>
                <button
                  onClick={() => setExpandedFaq(isExpanded ? null : index)}
                  aria-expanded={isExpanded}
                  className="w-full p-4 text-left flex items-center justify-between gap-4 hover:bg-[color-mix(in_srgb,var(--rp-leather-700)_25%,transparent)] transition cursor-pointer"
                >
                  <span className="text-sm font-bold text-[var(--rp-parchment-100)]">{faq.q}</span>
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-tavern-accent shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-[var(--rp-parchment-300)] shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 text-xs text-[var(--rp-parchment-200)] leading-relaxed pt-3 animate-fadeIn">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-tavern-border bg-tavern-bg py-10 px-6 text-center text-xs font-mono text-[var(--rp-parchment-300)]">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <span className="font-bold font-display text-[var(--rp-parchment-100)]">AetherTable</span> AI-Native Virtual Tabletop
          </div>
          <div>
            Built with Rust (Actix-Web, Wasmtime, WFC), Python (FastAPI, NetworkX), React 18, Tailwind CSS, and Web Audio API.
          </div>
          <div className="text-[10px] text-[var(--rp-leather-600)]">
            D&amp;D 5e SRD 5.1 rules provided under the Open Gaming License (OGL) &amp; Creative Commons CC-BY-4.0.
          </div>
        </div>
      </footer>
    </main>
  );
};
