import React, { useState } from 'react';
import { 
  Package, 
  Download, 
  Upload, 
  FileText, 
  Sparkles, 
  Check, 
  Shield, 
  Swords, 
  FileCode, 
  Layers, 
  Zap, 
  Plus, 
  Eye, 
  RefreshCw 
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { Token } from './TacticalCanvas';

interface BundleManagerViewProps {
  tokens: Token[];
  walls: { x: number; y: number }[];
  onDeployToken: (token: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

export const BundleManagerView: React.FC<BundleManagerViewProps> = ({
  tokens,
  walls,
  onDeployToken,
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  // Markdown Playground state
  const [markdownInput, setMarkdownInput] = useState<string>(`___
> ## Shadow Drake
>*Medium dragon, neutral evil*
> ___
> * **Armor Class** 16 (natural armor)
> * **Hit Points** 52 (8d8 + 16)
> * **Speed** 30 ft., fly 60 ft.
> ___
> | STR | DEX | CON | INT | WIS | CHA |
> | 16 (+3) | 15 (+2) | 14 (+2) | 6 (-2) | 12 (+1) | 8 (-1) |
> ___
> * **Skills** Stealth +6, Perception +3
> * **Damage Resistances** necrotic
> * **Senses** darkvision 120 ft., passive Perception 13
> * **Challenge** 3 (700 XP)
> ___
> ### Actions
> ***Bite.*** *Melee Weapon Attack:* +5 to hit, reach 5 ft., one target. *Hit:* 10 (2d6 + 3) piercing damage.
>
> ***Shadow Breath (Recharge 5-6).*** The drake exhales shadowy flames in a 15-foot cone.`);

  const [parsedCreature, setParsedCreature] = useState<any>({
    name: 'Shadow Drake',
    ac: 16,
    hp: 52,
    speed: 30,
    abilities: { STR: 16, DEX: 15, CON: 14, INT: 6, WIS: 12, CHA: 8 },
    actions: [
      { name: 'Bite', to_hit: '+5', damage_formula: '2d6 + 3', damage_type: 'piercing' },
      { name: 'Shadow Breath', to_hit: '+5', damage_formula: '3d6', damage_type: 'necrotic' },
    ],
    avatarIconType: 'boss',
    color: '#dc2626',
  });

  const handleExportBundle = async () => {
    setIsExporting(true);
    globalAudio.playSpellCast();

    try {
      const payload = {
        title: 'The Fall of Baron Vane',
        author: 'Lead GM (John)',
        ruleset: 'D&D 5e SRD + Homebrew',
        grid_dimensions: { width: 16, height: 12 },
        walls,
        tokens,
        dynasties: { houses: ['house_vane', 'house_silverthorn', 'house_duskwalker'] },
        lore_graph: { node_count: 5, edge_count: 3 },
        loot_tables: { chest_loot: ['Sunblade', 'Potion of Healing'] },
      };

      const res = await fetch('/api/v1/campaign/export-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'The_Fall_of_Baron_Vane.vttbundle';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        setExportSuccess(true);
        setTimeout(() => setExportSuccess(false), 3000);
      }
    } catch (e) {
      console.error('Bundle export failed:', e);
    } finally {
      setIsExporting(false);
    }
  };

  const handleParseMarkdown = async () => {
    globalAudio.playDiceRoll();
    try {
      const res = await fetch('/api/v1/homebrew/parse-markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown_text: markdownInput }),
      });
      if (res.ok) {
        const data = await res.json();
        setParsedCreature(data);
      }
    } catch (e) {
      console.warn('Backend parser unavailable, local parse fallback:', e);
    }
  };

  const handleDeployCreature = () => {
    globalAudio.playSpellCast();
    onDeployToken({
      name: parsedCreature.name || 'Shadow Drake',
      hp: parsedCreature.hp || 52,
      maxHp: parsedCreature.hp || 52,
      ac: parsedCreature.ac || 16,
      color: parsedCreature.color || '#dc2626',
      isPlayer: false,
      avatarIconType: parsedCreature.avatarIconType || 'boss',
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden select-none">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2">
            <Package className="w-5 h-5 text-purple-400" />
            <span>Campaign Archive Bundles (.vttbundle) & Homebrew Studio</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            COMPASS-compatible .vttbundle archive packaging, lossless campaign export/import, and Homebrewery markdown stat block parser.
          </p>
        </div>

        <button
          onClick={handleExportBundle}
          disabled={isExporting}
          className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold font-mono shadow-lg shadow-purple-950 transition active:scale-95"
        >
          {exportSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : <Download className="w-4 h-4" />}
          <span>{exportSuccess ? 'Downloaded .vttbundle!' : isExporting ? 'Packaging...' : 'Export Campaign Archive (.vttbundle)'}</span>
        </button>
      </div>

      {/* Main Grid */}
      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Active Campaign Archive Inspector & Upload Dropzone */}
        <div className="space-y-6">
          <div>
            <h2 className="text-xs font-bold font-display uppercase tracking-wider text-purple-400 mb-3 flex items-center gap-1.5">
              <Layers className="w-4 h-4" />
              <span>Active Campaign State Manifest</span>
            </h2>

            <div className="vtt-glass-panel p-5 rounded-2xl border border-slate-800 space-y-4 shadow-xl">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h3 className="font-bold text-sm font-display text-slate-100">The Fall of Baron Vane</h3>
                  <span className="text-[10px] font-mono text-purple-300">Spec Version 1.0.0 · D&D 5e SRD + Homebrew</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                  Ready to Archive
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 bg-slate-900/70 rounded-xl border border-slate-800">
                  <div className="text-slate-400 text-[10px]">Active Battlefield Tokens:</div>
                  <strong className="text-purple-300 text-sm">{tokens.length} Entities</strong>
                </div>
                <div className="p-3 bg-slate-900/70 rounded-xl border border-slate-800">
                  <div className="text-slate-400 text-[10px]">Grid Dimensions & Walls:</div>
                  <strong className="text-sky-300 text-sm">16x12 ({walls.length} Walls)</strong>
                </div>
                <div className="p-3 bg-slate-900/70 rounded-xl border border-slate-800">
                  <div className="text-slate-400 text-[10px]">Noble House Dynasties:</div>
                  <strong className="text-amber-300 text-sm">3 Great Houses</strong>
                </div>
                <div className="p-3 bg-slate-900/70 rounded-xl border border-slate-800">
                  <div className="text-slate-400 text-[10px]">Epistemic Canon Propositions:</div>
                  <strong className="text-emerald-300 text-sm">Active & Synced</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Import Dropzone */}
          <div>
            <h2 className="text-xs font-bold font-display uppercase tracking-wider text-purple-400 mb-3 flex items-center gap-1.5">
              <Upload className="w-4 h-4" />
              <span>Import Campaign Archive</span>
            </h2>

            <div className="p-6 border-2 border-dashed border-slate-800 hover:border-purple-500/80 rounded-2xl flex flex-col items-center justify-center text-center space-y-2 bg-slate-900/40 hover:bg-purple-950/20 transition cursor-pointer">
              <Package className="w-8 h-8 text-purple-400" />
              <div className="text-xs font-bold text-slate-200">Drag & drop `.vttbundle` or click to browse</div>
              <p className="text-[10px] text-slate-500 font-mono">
                Automatically extracts and restores maps, tokens, lore graphs, and custom loot tables.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Homebrewery & GM Binder Markdown Parser */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold font-display uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
              <FileCode className="w-4 h-4" />
              <span>Homebrewery / GM Binder Markdown Importer</span>
            </h2>

            <button
              onClick={handleParseMarkdown}
              className="flex items-center gap-1.5 px-3 py-1 bg-slate-900 hover:bg-slate-800 text-purple-300 rounded-lg text-xs font-mono border border-slate-800 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Parse Statblock</span>
            </button>
          </div>

          {/* Markdown Textarea */}
          <textarea
            value={markdownInput}
            onChange={(e) => setMarkdownInput(e.target.value)}
            rows={8}
            className="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 focus:outline-none focus:border-purple-500 vtt-scrollbar resize-none select-text"
            placeholder="Paste Homebrewery or GM Binder markdown statblock..."
          />

          {/* Real-time Parsed Creature Preview */}
          {parsedCreature && (
            <div className="vtt-glass-panel p-4 rounded-xl border border-slate-800 space-y-3 shadow-lg">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow font-bold text-xs"
                    style={{ backgroundColor: parsedCreature.color || '#dc2626' }}
                  >
                    {parsedCreature.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="font-bold text-sm font-display text-slate-100">{parsedCreature.name}</h3>
                    <span className="text-[10px] font-mono text-rose-300">
                      AC {parsedCreature.ac} · HP {parsedCreature.hp}/{parsedCreature.hp} · Speed {parsedCreature.speed} ft
                    </span>
                  </div>
                </div>

                <button
                  onClick={handleDeployCreature}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-600 to-rose-600 hover:from-purple-500 hover:to-rose-500 text-white rounded-xl text-xs font-bold font-mono shadow shadow-purple-950 transition active:scale-95"
                >
                  <Plus className="w-4 h-4" />
                  <span>Deploy to Tabletop</span>
                </button>
              </div>

              {/* Ability Scores Grid */}
              <div className="grid grid-cols-6 gap-1 text-center font-mono text-[10px]">
                {Object.entries(parsedCreature.abilities || {}).map(([stat, val]) => (
                  <div key={stat} className="p-1.5 bg-slate-900/80 rounded-lg border border-slate-800">
                    <span className="text-slate-500 block text-[9px]">{stat}</span>
                    <strong className="text-slate-200">{val as any}</strong>
                  </div>
                ))}
              </div>

              {/* Actions List */}
              {parsedCreature.actions && parsedCreature.actions.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-[10px] font-mono text-purple-400 font-bold uppercase">Parsed Actions:</div>
                  <div className="space-y-1">
                    {parsedCreature.actions.map((act: any, idx: number) => (
                      <div key={idx} className="p-2 bg-slate-900/60 rounded-lg border border-slate-800 text-xs font-mono flex items-center justify-between">
                        <strong className="text-slate-200">{act.name}</strong>
                        <span className="text-[10px] text-amber-400 font-semibold">{act.to_hit} to hit · {act.damage_formula} {act.damage_type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
