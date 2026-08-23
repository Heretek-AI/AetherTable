export type UserRole = 'admin' | 'gm' | 'player' | 'spectator';
export type SubscriptionTier = 'free' | 'hero' | 'master';
export type DiceTheme = 'obsidian' | 'gold' | 'mithril' | 'crimson' | 'emerald';

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  role: UserRole;
  subscriptionTier: SubscriptionTier;
  assignedTokenIds: string[];
  diceTheme: DiceTheme;
  bio?: string;
  createdAt: string;
}

export interface DemoAccount {
  user: User;
  description: string;
  badge: string;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    user: {
      id: 'usr_admin',
      username: 'lead_gm',
      email: 'admin@aethertable.io',
      displayName: 'Arch-Mage Arthur (Admin & GM)',
      avatarUrl: 'crown',
      role: 'admin',
      subscriptionTier: 'master',
      assignedTokenIds: ['*'], // Full tabletop authority
      diceTheme: 'gold',
      bio: 'Lead Dungeon Master and Platform Administrator.',
      createdAt: '2026-01-01T00:00:00Z',
    },
    description: 'Full Platform Admin + Tabletop GM Authority (Controls all tokens, Admin Console, WFC & Invariants).',
    badge: 'PLATFORM ADMIN & GM',
  },
  {
    user: {
      id: 'usr_player1',
      username: 'thorin_player',
      email: 'thorin@aethertable.io',
      displayName: 'Thorin Oakenshield',
      avatarUrl: 'fighter',
      role: 'player',
      subscriptionTier: 'hero',
      assignedTokenIds: ['thorin_1'], // Controls Thorin token
      diceTheme: 'crimson',
      bio: 'Dwarven champion seeking the lost halls of his ancestors.',
      createdAt: '2026-02-15T12:00:00Z',
    },
    description: 'Player Character 1: Bound authority to move and act with Thorin Oakenshield.',
    badge: 'HERO PLAYER 1',
  },
  {
    user: {
      id: 'usr_player2',
      username: 'lyra_player',
      email: 'lyra@aethertable.io',
      displayName: 'Lyra Moonshadow',
      avatarUrl: 'mage',
      role: 'player',
      subscriptionTier: 'hero',
      assignedTokenIds: ['lyra_1'], // Controls Lyra token
      diceTheme: 'mithril',
      bio: 'Elven wizard wielding weave evocation and divination.',
      createdAt: '2026-03-01T08:30:00Z',
    },
    description: 'Player Character 2: Bound authority to move and act with Lyra Moonshadow.',
    badge: 'HERO PLAYER 2',
  },
  {
    user: {
      id: 'usr_spectator',
      username: 'guest_watcher',
      email: 'spectator@aethertable.io',
      displayName: 'Guest Spectator',
      avatarUrl: 'scout',
      role: 'spectator',
      subscriptionTier: 'free',
      assignedTokenIds: [], // Read-only
      diceTheme: 'obsidian',
      bio: 'Tabletop spectator watching the live stream.',
      createdAt: '2026-08-20T19:00:00Z',
    },
    description: 'Read-only viewer perspective: Tactical vision and 3D audio listener.',
    badge: 'GUEST SPECTATOR',
  },
];
