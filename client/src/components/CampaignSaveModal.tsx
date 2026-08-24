import React, { useEffect, useState } from 'react';
import {
  Save,
  FolderOpen,
  Trash2,
  CloudUpload,
  Clock,
  Swords,
} from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Campaign Saves"
      subtitle="Snapshots persist in the campaign database and survive restarts."
      icon={<Save className="w-5 h-5" />}
      size="md"
    >
      <div className="space-y-4">
        {/* Save current state */}
        <div className="flex gap-2">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Save name..."
            className="vtt-input flex-1 font-mono text-xs"
          />
          <button
            onClick={handleSave}
            disabled={loading}
            className="vtt-btn vtt-btn-primary font-display tracking-wide disabled:opacity-50"
          >
            <CloudUpload className="w-4 h-4" />
            <span>Save</span>
          </button>
        </div>

        {status && (
          <div
            className="text-xs rounded-lg px-3 py-2 font-mono border border-[color-mix(in_srgb,var(--tavern-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--tavern-accent)_8%,transparent)]"
            style={{ color: 'var(--tavern-accent)' }}
          >
            {status}
          </div>
        )}

        {/* Saved games list */}
        <div className="space-y-2">
          {saves.length === 0 ? (
            <div className="vtt-surface rounded-xl p-6 text-center text-xs text-[var(--rp-parchment-300)] font-mono">
              No saves yet. Arrange your board and press Save.
            </div>
          ) : (
            saves.map((save) => (
              <div
                key={save.save_id}
                className="vtt-card-elevated rounded-xl px-3 py-2.5 flex items-center justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-[var(--rp-parchment-100)] truncate">{save.save_name}</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-mono flex items-center space-x-3 mt-0.5">
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
                    className="vtt-btn vtt-btn-secondary text-xs disabled:opacity-50"
                    style={{ padding: '0.25rem 0.6rem' }}
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Load</span>
                  </button>
                  <button
                    onClick={() => handleDelete(save.save_id)}
                    className="p-1.5 rounded-lg border border-tavern-border transition cursor-pointer hover:bg-[color-mix(in_srgb,var(--state-danger)_15%,transparent)]"
                    style={{ color: 'var(--state-danger)' }}
                    title="Delete save"
                    aria-label={`Delete save ${save.save_name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
};
