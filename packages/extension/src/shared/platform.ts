export type Platform = 'youtube' | 'twitch';

export function detectPlatform(hostname: string): Platform | null {
  const host = hostname.toLowerCase();
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  return null;
}

export function detectPlatformFromUrl(url: string | undefined): Platform | null {
  if (!url) return null;
  try {
    return detectPlatform(new URL(url).hostname);
  } catch {
    return null;
  }
}
