import { SETTINGS_STORAGE_KEY, normalizeSettings, type Settings } from './settings.js';

/**
 * Thin wrapper over chrome.storage.local. `StorageArea` is abstracted so the
 * store can be tested with an in-memory fake.
 */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  onChanged(listener: (changes: Record<string, { newValue?: unknown }>) => void): () => void;
}

export function chromeLocalStorageArea(): StorageAreaLike {
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    onChanged: (listener) => {
      const wrapped = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'local') listener(changes);
      };
      chrome.storage.onChanged.addListener(wrapped);
      return () => chrome.storage.onChanged.removeListener(wrapped);
    },
  };
}

export class SettingsStore {
  private readonly area: StorageAreaLike;

  constructor(area: StorageAreaLike = chromeLocalStorageArea()) {
    this.area = area;
  }

  async load(): Promise<Settings> {
    const result = await this.area.get(SETTINGS_STORAGE_KEY);
    return normalizeSettings(result[SETTINGS_STORAGE_KEY]);
  }

  /** Merge a partial update (style is merged one level deep), validate, persist, return the result. */
  async update(patch: Partial<Omit<Settings, 'version' | 'style'>> & { style?: Partial<Settings['style']> }): Promise<Settings> {
    const current = await this.load();
    const next = normalizeSettings({
      ...current,
      ...patch,
      style: { ...current.style, ...(patch.style ?? {}) },
    });
    await this.area.set({ [SETTINGS_STORAGE_KEY]: next });
    return next;
  }

  async reset(): Promise<Settings> {
    const next = normalizeSettings(undefined);
    await this.area.set({ [SETTINGS_STORAGE_KEY]: next });
    return next;
  }

  /** Fires with normalized settings whenever they change in storage. Returns an unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void {
    return this.area.onChanged((changes) => {
      const change = changes[SETTINGS_STORAGE_KEY];
      if (change) listener(normalizeSettings(change.newValue));
    });
  }
}
