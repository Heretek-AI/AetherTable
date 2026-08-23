import React, { useEffect, useState } from 'react';
import {
  Save,
  FolderOpen,
  Trash2,
  X,
  CloudUpload,
  Clock,
  Swords,
} from 'lucide-react';
import {
  CampaignSnapshot,
  CampaignSaveMeta,
  listSaves,
  saveCampaign,
  loadCampaign,
  deleteSave,
} from '../api/campaign_store';

interface CampaignSaveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadSnapshot: (snapshot: CampaignSnapshot) => void;
  getSnapshot: () => CampaignSnapshot;
}

export const CampaignSaveModal: React.FC<CampaignSaveModalProps> = ({
  isOpen,
  onClose,
  onLoadSnapshot,
  getSnapshot,
}) => {
  const [saves, setSaves] = useState<CampaignSaveMeta[]>([]);
  const [saveName, setSaveName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStatus(null);
      listSaves().then(setSaves);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setLoading(true);
    setStatus(null);
    const name = saveName.trim() || `Session ${new Date().toLocaleDateString()}`;
    const meta = await saveCampaign(name, getSnapshot());
    setLoading(false);
    if (meta) {
      setStatus(`Saved "${meta.save_name}" (round ${meta.round_number}).`);
      setSaveName('');
      setSaves(await listSaves());
    } else {
      setStatus('Could not save — server unreachable or not signed in.');
    }
  };

  const handleLoad = async (saveId: string) => {
    setLoading(true);
    const snapshot = await loadCampaign(saveId);
    setLoading(false);
    if (snapshot) {
      onLoadSnapshot(snapshot);
      setStatus('Campaign restored.');
      onClose();
    } else {
      setStatus('Could not load that save.');
    }
  };

  const handleDelete = async (saveId: string) => {
    await deleteSave(saveId);
    setSaves(await listSaves());
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl space-y-4 animate-fadeIn">
        <div className="flex items-start justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-xl font-bold font-serif text-slate-100">Campaign Saves</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Snapshots persist in the campaign database and survive restarts.
            </p>
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

        {/* Save current state */}
        <div className="flex gap-2">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Save name..."
            className="flex-1 bg-slate-950/90 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 font-mono"
          />
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex items-center space-x-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            <CloudUpload className="w-4 h-4" />
            <span>Save</span>
          </button>
        </div>

        {status && (
          <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-600/30 rounded-lg px-3 py-2 font-mono">
            {status}
          </div>
        )}

        {/* Saved games list */}
        <div className="space-y-2">
          {saves.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 font-mono bg-slate-950/60 rounded-xl border border-slate-800">
              No saves yet. Arrange your board and press Save.
            </div>
          ) : (
            saves.map((save) => (
              <div
                key={save.save_id}
                className="flex items-center justify-between bg-slate-950/70 border border-slate-800 hover:border-emerald-500/40 rounded-xl px-3 py-2.5 transition"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-100 truncate">{save.save_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono flex items-center space-x-3 mt-0.5">
                    <span className="flex items-center space-x-1">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(save.updated_at).toLocaleString()}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <Swords className="w-3 h-3" />
                      <span>Round {save.round_number}</span>
                    </span>
                  </div>
                </div>
                <div className="flex items-center space-x-1.5 shrink-0 ml-3">
                  <button
                    onClick={() => handleLoad(save.save_id)}
                    disabled={loading}
                    className="flex items-center space-x-1 px-2.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-600/40 rounded-lg text-xs font-semibold transition cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Load</span>
                  </button>
                  <button
                    onClick={() => handleDelete(save.save_id)}
                    className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 border border-slate-800 rounded-lg transition cursor-pointer"
                    title="Delete save"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
