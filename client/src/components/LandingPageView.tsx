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

export const LandingPageView: React.FC<LandingPageViewProps> = ({ onEnterApp, onOpenPricing, onOpenAuth }) => {
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
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans overflow-y-auto selection:bg-amber-500 selection:text-black">
      {/* Top Hero Navigation */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-6 py-3.5 flex items-center justify-between shadow-lg">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-500 to-red-600 flex items-center justify-center shadow-lg shadow-amber-950/40">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <span className="text-lg font-bold font-serif tracking-wider text-slate-100">AetherTable</span>
            <span className="ml-2 text-[10px] font-mono px-2 py-0.5 bg-amber-950/80 text-amber-300 border border-amber-600/40 rounded-full font-bold">
              AI-Native VTT
            </span>
          </div>
        </div>

        <nav className="hidden md:flex items-center space-x-6 text-xs font-semibold text-slate-300">
          <button onClick={() => onEnterApp('compendium')} className="hover:text-amber-400 transition cursor-pointer">
            Compendium Codex
          </button>
          <button onClick={() => onEnterApp('builder')} className="hover:text-amber-400 transition cursor-pointer">
            Character Studio
          </button>
          <button onClick={() => onEnterApp('encounters')} className="hover:text-amber-400 transition cursor-pointer">
            Encounter Builder
          </button>
          <button onClick={() => onEnterApp('dynasty')} className="hover:text-amber-400 transition cursor-pointer">
            Dynasty & Factions
          </button>
          <button onClick={() => onEnterApp('wfc')} className="hover:text-amber-400 transition cursor-pointer">
            WFC Studio
          </button>
        </nav>

        <div className="flex items-center space-x-3">
          {onOpenAuth && (
            <>
              <button
                onClick={() => onOpenAuth('signin')}
                className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white transition cursor-pointer"
              >
                Sign In
              </button>
              <button
                onClick={() => onOpenAuth('signup')}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-bold transition cursor-pointer"
              >
                Create Account
              </button>
            </>
          )}
          <button
            onClick={() => onEnterApp('tabletop')}
            className="flex items-center space-x-2 px-4 py-2 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-xs font-bold rounded-lg shadow-lg shadow-amber-950/50 border border-amber-500/40 transition active:scale-95 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>Launch Tabletop</span>
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-16 pb-20 px-6 max-w-7xl mx-auto text-center overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="inline-flex items-center space-x-2 px-3 py-1 bg-slate-900 border border-amber-500/40 rounded-full text-xs text-amber-300 font-mono mb-6 shadow-inner">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>Next-Generation D&D 5e SRD 5.1 & Multi-Agent Virtual Tabletop</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold font-serif tracking-tight text-slate-100 max-w-4xl mx-auto leading-tight">
          Where <span className="bg-clip-text text-transparent bg-gradient-to-r from-amber-400 via-orange-400 to-red-500">Legendary Narratives</span> Meet Authoritative Precision.
        </h1>

        <p className="text-sm md:text-base text-slate-400 max-w-2xl mx-auto mt-5 leading-relaxed">
          The all-in-one Tabletop RPG SaaS platform combining the heroic character depth of <strong>D&D Beyond</strong> with the high-performance tactical canvas of <strong>Roll20</strong>, powered by an AI Dungeon Master with zero hallucination.
        </p>

        {/* Hero CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-8">
          <button
            onClick={() => onEnterApp('tabletop')}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3.5 bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 hover:from-amber-500 hover:to-amber-400 text-slate-950 text-sm font-extrabold rounded-xl shadow-xl shadow-amber-950/60 transition active:scale-95 cursor-pointer uppercase tracking-wider"
          >
            <Swords className="w-4 h-4" />
            <span>Start Free Campaign</span>
          </button>
          <button
            onClick={() => onEnterApp('compendium')}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3.5 bg-slate-900 hover:bg-slate-850 border border-slate-700 hover:border-amber-500/50 text-slate-200 text-sm font-semibold rounded-xl transition cursor-pointer"
          >
            <BookOpen className="w-4 h-4 text-amber-400" />
            <span>Explore 5e Compendium</span>
          </button>
        </div>

        {/* Interactive Feature Badges */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-4xl mx-auto mt-14 text-left">
          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg">
            <div className="flex items-center space-x-2 text-amber-400 mb-1">
              <Cpu className="w-4 h-4" />
              <span className="text-xs font-bold font-mono">Zero-Allocation</span>
            </div>
            <div className="text-sm font-bold text-slate-100">Pure Rust Core</div>
            <p className="text-[11px] text-slate-400 mt-1">Floored ability scores, 7 AC derivations & LoS raycasting.</p>
          </div>

          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg">
            <div className="flex items-center space-x-2 text-purple-400 mb-1">
              <Volume2 className="w-4 h-4" />
              <span className="text-xs font-bold font-mono">WebRTC Mesh</span>
            </div>
            <div className="text-sm font-bold text-slate-100">3D Audio Radar</div>
            <p className="text-[11px] text-slate-400 mt-1">Stereo azimuth panning & distance sound reverberation.</p>
          </div>

          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg">
            <div className="flex items-center space-x-2 text-sky-400 mb-1">
              <Shield className="w-4 h-4" />
              <span className="text-xs font-bold font-mono">Zero-Trust</span>
            </div>
            <div className="text-sm font-bold text-slate-100">Invariant Auditor</div>
            <p className="text-[11px] text-slate-400 mt-1">Pre-commit state interception with 2-pass retry controller.</p>
          </div>

          <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl shadow-lg">
            <div className="flex items-center space-x-2 text-emerald-400 mb-1">
              <Layers className="w-4 h-4" />
              <span className="text-xs font-bold font-mono">WFC Engine</span>
            </div>
            <div className="text-sm font-bold text-slate-100">Procedural Maps</div>
            <p className="text-[11px] text-slate-400 mt-1">Wave function collapse dungeon synthesis in &lt;5ms.</p>
          </div>
        </div>
      </section>

      {/* SaaS Subscription Pricing Section */}
      <section className="py-16 bg-slate-900/60 border-y border-slate-800/80 px-6">
        <div className="max-w-6xl mx-auto text-center space-y-4">
          <span className="text-xs font-bold font-mono uppercase tracking-widest text-amber-400">
            Transparent SaaS Subscriptions
          </span>
          <h2 className="text-3xl font-bold font-serif text-slate-100">Choose Your Adventuring Tier</h2>
          <p className="text-xs text-slate-400 max-w-xl mx-auto">
            Upgrade your tabletop experience with unlimited campaigns, GPU AI inference, and 3D WebRTC voice radar.
          </p>

          {/* Monthly / Yearly Toggle */}
          <div className="flex items-center justify-center space-x-3 pt-2">
            <span className={`text-xs font-semibold ${billingCycle === 'monthly' ? 'text-amber-400' : 'text-slate-500'}`}>
              Monthly Billing
            </span>
            <button
              onClick={() => setBillingCycle(billingCycle === 'monthly' ? 'yearly' : 'monthly')}
              className="w-12 h-6 bg-slate-800 border border-slate-700 rounded-full p-1 transition-colors relative cursor-pointer"
            >
              <div
                className={`w-4 h-4 rounded-full bg-amber-500 transition-transform ${
                  billingCycle === 'yearly' ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
            <span className={`text-xs font-semibold ${billingCycle === 'yearly' ? 'text-amber-400' : 'text-slate-500'}`}>
              Annual (Save 20%)
            </span>
          </div>

          {/* Pricing Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-8 text-left">
            {/* Free Tier */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-slate-100">Adventurer</h3>
                  <span className="px-2 py-0.5 text-[10px] font-mono bg-slate-800 text-slate-300 rounded">FREE</span>
                </div>
                <div className="text-3xl font-extrabold text-slate-100 font-mono mt-3">$0</div>
                <p className="text-xs text-slate-400 mt-1">Core virtual tabletop for casual gaming groups.</p>

                <div className="space-y-2.5 mt-6 text-xs text-slate-300">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>1 Active Campaign Session</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Complete 5e SRD 5.1 Compendium</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>2D Tactical Canvas & Raycast LoS</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>3D Dice Box Physics</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="w-full mt-8 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg transition cursor-pointer"
              >
                Launch Free Tier
              </button>
            </div>

            {/* Hero Tier */}
            <div className="bg-slate-950/90 border-2 border-amber-500 rounded-2xl p-6 shadow-2xl relative flex flex-col justify-between">
              <div className="absolute -top-3 right-6 px-3 py-0.5 bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 text-[10px] font-extrabold uppercase rounded-full tracking-wider shadow">
                Most Popular
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-amber-300">Hero Tier</h3>
                  <span className="px-2 py-0.5 text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-600/40 rounded">
                    PRO
                  </span>
                </div>
                <div className="text-3xl font-extrabold text-amber-400 font-mono mt-3">
                  {billingCycle === 'monthly' ? '$5.99' : '$4.79'}
                  <span className="text-xs text-slate-400 font-sans font-normal"> / month</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">For regular game masters seeking deep AI immersion.</p>

                <div className="space-y-2.5 mt-6 text-xs text-slate-200">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Unlimited Active Campaigns</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>AI Encounter DM Narrative Generator</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Character Sheet PDF Exports</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Dynasty Lineage & Feud Matrix</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>500 MB Asset Cloud Storage</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="w-full mt-8 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-bold rounded-lg shadow-lg shadow-amber-950/60 transition cursor-pointer"
              >
                Upgrade to Hero Tier
              </button>
            </div>

            {/* Master Tier */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-purple-300">Master Tier</h3>
                  <span className="px-2 py-0.5 text-[10px] font-mono bg-purple-950 text-purple-300 border border-purple-600/40 rounded">
                    ENTERPRISE
                  </span>
                </div>
                <div className="text-3xl font-extrabold text-purple-400 font-mono mt-3">
                  {billingCycle === 'monthly' ? '$9.99' : '$7.99'}
                  <span className="text-xs text-slate-400 font-sans font-normal"> / month</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">Ultimate power for professional GMs & content creators.</p>

                <div className="space-y-2.5 mt-6 text-xs text-slate-300">
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Everything in Hero Tier</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>3D WebRTC Positional Voice Mesh</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Procedural WFC Dungeon Studio</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Sandboxed WASM & Rhai Scripting</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
                    <span>Unlimited Asset Cloud Storage</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onEnterApp('tabletop')}
                className="w-full mt-8 py-2.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded-lg shadow-lg shadow-purple-950/60 transition cursor-pointer"
              >
                Get Master Tier
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Accordion Section */}
      <section className="py-16 px-6 max-w-4xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <span className="text-xs font-bold font-mono uppercase tracking-widest text-amber-400">Knowledge Base</span>
          <h2 className="text-2xl font-bold font-serif text-slate-100">Frequently Asked Questions</h2>
        </div>

        <div className="space-y-3 pt-4">
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              onClick={() => setExpandedFaq(expandedFaq === idx ? null : idx)}
              className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-xl p-4 cursor-pointer transition"
            >
              <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                <span>{faq.q}</span>
                {expandedFaq === idx ? <ChevronUp className="w-4 h-4 text-amber-400" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
              </div>
              {expandedFaq === idx && (
                <p className="text-xs text-slate-400 mt-2.5 pt-2.5 border-t border-slate-800 leading-relaxed font-sans">
                  {faq.a}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950 px-6 py-8 text-center text-xs text-slate-500 space-y-2">
        <div className="flex items-center justify-center space-x-2 font-serif text-slate-300 font-bold">
          <span>AetherTable AI-Native Virtual Tabletop</span>
        </div>
        <p>Built with Rust (Actix-Web, Wasmtime, WFC), Python (FastAPI, NetworkX), React 18, Tailwind CSS, and Web Audio API.</p>
        <p className="text-[11px] text-slate-600">D&D 5e SRD 5.1 rules provided under the Open Gaming License (OGL) & Creative Commons CC-BY-4.0.</p>
      </footer>
    </div>
  );
};
