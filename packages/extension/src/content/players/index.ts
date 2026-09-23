import type { Platform } from '../../shared/platform.js';
import type { PlayerAdapter } from './types.js';
import { youtubeAdapter } from './youtube.js';
import { twitchAdapter } from './twitch.js';

export type { PlayerAdapter } from './types.js';

const ADAPTERS: Record<Platform, PlayerAdapter> = { youtube: youtubeAdapter, twitch: twitchAdapter };

export function adapterFor(platform: Platform | null): PlayerAdapter | null {
  return platform === null ? null : ADAPTERS[platform];
}
