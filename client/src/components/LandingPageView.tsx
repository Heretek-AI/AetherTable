import React, { useState } from 'react';
import {
  Sparkles,
  Swords,
  BookOpen,
  Shield,
  Zap,
  Flame,
  Users,
  Layers,
  Volume2,
  Crown,
  Play,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Package,
  Radio,
  Sliders,
  Award,
  Globe,
  Lock,
  Cpu,
  Dices,
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
    <main className="w-full h-full overflow-y-auto bg-slate-950 text-slate-100 font-sans selection:bg-amber-500 selection:text-black">
      {/* Hero Section */}
      <section className="relative overflow-hidden pt-12 pb-20 px-6 max-w-7xl mx-auto text-center flex flex-col items-center">
        {/* Ambient Glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-gradient-to-tr from-amber-600/15 via-red-600/10 to-indigo-600/15 blur-[120px] rounded-full pointer-events-none" />

        {/* Hero Pill Badge */}
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-slate-900 border border-amber-500/30 text-amber-300 text-xs font-mono mb-6 shadow-inner animate-fadeIn">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>Next-Generation D&D 5e SRD 5.1 & Multi-Agent Virtual Tabletop</span>
        </div>

        {/* Main Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold font-serif tracking-tight text-slate-100 max-w-4xl leading-tight">
          Where Legendary Narratives Meet{' '}
          <span className="bg-gradient-to-r from-amber-400 via-red-400 to-amber-200 bg-clip-text text-transparent">
            Authoritative Precision.
          </span>
        </h1>

        {/* Sub-headline */}
        <p className="mt-6 text-sm sm:text-base text-slate-300 max-w-2xl font-sans leading-relaxed">
          The all-in-one Tabletop RPG SaaS platform combining the heroic character depth of{' '}
          <strong className="text-amber-400 font-semibold">D&D Beyond</strong> with the high-performance tactical canvas of{' '}
          <strong className="text-sky-400 font-semibold">Roll20</strong>, powered by an AI Dungeon Master with zero hallucination.
        </p>

        {/* Hero CTAs */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={() => onEnterApp('tabletop')}
            className="flex items-center space-x-2 px-7 py-3.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold rounded-xl shadow-xl shadow-amber-950/60 transition-all transform hover:scale-105 cursor-pointer font-serif tracking-wide text-sm"
          >
            <span>START FREE CAMPAIGN</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => onEnterApp('compendium')}
            className="flex items-center space-x-2 px-6 py-3.5 bg-slate-900/90 hover:bg-slate-800 text-slate-200 border border-slate-700 hover:border-slate-600 font-semibold rounded-xl transition cursor-pointer text-sm font-mono"
          >
            <BookOpen className="w-4 h-4 text-amber-400" />
            <span>Explore 5e Compendium</span>
          </button>
        </div>

        {/* Trust Badges */}
        <div className="mt-14 grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-4xl text-left font-mono text-xs">
          <div className="p-4 bg-slate-900/60 rounded-xl border border-slate-800">
            <div className="text-amber-400 font-bold">Zero-Allocation</div>
            <div className="text-slate-200 font-serif font-bold text-sm mt-0.5">Pure Rust Core</div>
            <div className="text-[11px] text-slate-400 mt-1">Floored ability scores, 7 AC derivations & LoS raycasting.</div>
          </div>
          <div className="p-4 bg-slate-900/60 rounded-xl border border-slate-800">
            <div className="text-sky-400 font-bold">WebRTC Mesh</div>
            <div className="text-slate-200 font-serif font-bold text-sm mt-0.5">3D Audio Radar</div>
            <div className="text-[11px] text-slate-400 mt-1">Stereo azimuth panning & distance sound reverberation.</div>
          </div>
          <div className="p-4 bg-slate-900/60 rounded-xl border border-slate-800">
            <div className="text-emerald-400 font-bold">Zero-Trust</div>
            <div className="text-slate-200 font-serif font-bold text-sm mt-0.5">Invariant Auditor</div>
            <div className="text-[11px] text-slate-400 mt-1">Pre-commit state interception with 2-pass retry controller.</div>
          </div>
          <div className="p-4 bg-slate-900/60 rounded-xl border border-slate-800">
            <div className="text-purple-400 font-bold">WFC Engine</div>
            <div className="text-slate-200 font-serif font-bold text-sm mt-0.5">Procedural Maps</div>
            <div className="text-[11px] text-slate-400 mt-1">Wave function collapse dungeon synthesis in &lt;5ms.</div>
          </div>
        </div>
      </section>

      {/* Pricing Matrix Section */}
      <section className="py-16 px-6 bg-slate-950/80 border-t border-slate-900 relative">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xs font-mono text-amber-400 font-bold uppercase tracking-widest">
            TRANSPARENT SAAS SUBSCRIPTIONS
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold font-serif text-slate-100 mt-2">
            Choose Your Adventuring Tier
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 max-w-xl mx-auto mt-3">
            Upgrade your tabletop experience with unlimited campaigns, GPU AI inference, and 3D WebRTC voice radar.
          </p>

          {/* Billing Switcher */}
          <div className="mt-8 inline-flex items-center space-x-3 p-1.5 bg-slate-900 rounded-xl border border-slate-800 text-xs font-mono">
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-4 py-1.5 rounded-lg transition cursor-pointer ${
                billingCycle === 'monthly' ? 'bg-amber-600 text-white font-bold' : 'text-slate-400'
              }`}
            >
              Monthly Billing
            </button>
            <button
              onClick={() => setBillingCycle('yearly')}
              className={`px-4 py-1.5 rounded-lg transition cursor-pointer flex items-center space-x-1.5 ${
                billingCycle === 'yearly' ? 'bg-amber-600 text-white font-bold' : 'text-slate-400'
              }`}
            >
              <span>Annual</span>
              <span className="text-[10px] px-1.5 py-0.2 bg-amber-400 text-slate-950 rounded font-bold">
                Save 20%
              </span>
            </button>
          </div>

          {/* Pricing Cards */}
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto text-left">
            {/* Free Adventurer */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between hover:border-slate-700 transition">
              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-serif text-slate-100">Adventurer</h3>
                  <span className="px-2 py-0.5 bg-slate-800 text-slate-300 text-[10px] font-mono rounded font-bold">
                    FREE
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-slate-100">$0</span>
                  <span className="text-xs text-slate-400 ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">Essential tools for individual players and casual one-shots.</p>

                <div className="mt-6 space-y-2.5 text-xs text-slate-300 font-sans">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Up to 3 Active Characters</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Official D&D 5e SRD 5.1 Compendium</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Real-Time Dice Rolling & Physics</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Standard Battlemap Canvas</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="mt-8 w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold font-mono transition cursor-pointer"
              >
                Get Started Free
              </button>
            </div>

            {/* Hero Tier (Most Popular) */}
            <div className="bg-slate-900 border-2 border-amber-500 rounded-2xl p-6 flex flex-col justify-between shadow-2xl relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-amber-500 text-slate-950 text-[10px] font-mono font-extrabold uppercase rounded-full shadow">
                MOST POPULAR
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-serif text-amber-200">Hero Tier</h3>
                  <span className="px-2 py-0.5 bg-amber-950 text-amber-300 border border-amber-600/50 text-[10px] font-mono rounded font-bold">
                    PRO DM
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-slate-100">
                    {billingCycle === 'monthly' ? '$9.99' : '$7.99'}
                  </span>
                  <span className="text-xs text-slate-400 ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">Everything needed to run rich autonomous campaigns.</p>

                <div className="mt-6 space-y-2.5 text-xs text-slate-300 font-sans">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span><strong>Unlimited</strong> Characters & Campaigns</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Dynamic Line-of-Sight & Fog of War</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>3D Spatial Audio & Voice Radar</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>WFC Procedural Dungeon Generator</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Pre-Commit Invariant Auditor DM</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="mt-8 w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-bold font-serif transition cursor-pointer shadow-lg shadow-amber-950/60"
              >
                Upgrade to Hero Tier
              </button>
            </div>

            {/* Master Guild (Enterprise/Guilds) */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between hover:border-slate-700 transition">
              <div>
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold font-serif text-slate-100">Master Guild</h3>
                  <span className="px-2 py-0.5 bg-purple-950 text-purple-300 border border-purple-800 text-[10px] font-mono rounded font-bold">
                    GUILD
                  </span>
                </div>
                <div className="mt-4 flex items-baseline">
                  <span className="text-3xl font-extrabold font-mono text-slate-100">
                    {billingCycle === 'monthly' ? '$24.99' : '$19.99'}
                  </span>
                  <span className="text-xs text-slate-400 ml-1">/ month</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">For professional DMs, streamer tables, and gaming conventions.</p>

                <div className="mt-6 space-y-2.5 text-xs text-slate-300 font-sans">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>All Hero Features + Priority GPU Inference</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Campaign Bundles (.vttbundle) Commercial Export</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Live Streamer Clean HUD & Discord Relay</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Dedicated Cluster SLA & SLA Metrics</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="mt-8 w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold font-mono transition cursor-pointer"
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
          <div className="text-xs font-mono text-amber-400 font-bold uppercase tracking-widest">
            KNOWLEDGE BASE
          </div>
          <h2 className="text-3xl font-bold font-serif text-slate-100 mt-2">
            Frequently Asked Questions
          </h2>
        </div>

        <div className="space-y-3 font-sans">
          {faqs.map((faq, index) => {
            const isExpanded = expandedFaq === index;
            return (
              <div
                key={index}
                className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden transition-all"
              >
                <button
                  onClick={() => setExpandedFaq(isExpanded ? null : index)}
                  className="w-full p-4 text-left flex items-center justify-between hover:bg-slate-850 transition cursor-pointer"
                >
                  <span className="text-sm font-bold text-slate-100">{faq.q}</span>
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-amber-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 text-xs text-slate-300 leading-relaxed border-t border-slate-800/60 pt-3 animate-fadeIn">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-10 px-6 text-center text-xs font-mono text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <span className="font-bold font-serif text-slate-300">AetherTable</span> AI-Native Virtual Tabletop
          </div>
          <div>
            Built with Rust (Actix-Web, Wasmtime, WFC), Python (FastAPI, NetworkX), React 18, Tailwind CSS, and Web Audio API.
          </div>
          <div className="text-[10px] text-slate-600">
            D&D 5e SRD 5.1 rules provided under the Open Gaming License (OGL) & Creative Commons CC-BY-4.0.
          </div>
        </div>
      </footer>
    </main>
  );
};
