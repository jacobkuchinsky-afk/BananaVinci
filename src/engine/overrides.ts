// Temporary values that win over the project's own values while a recording is in progress
// (the object follows the mouse before the recording is turned into keyframes).
let override: { id: string; values: Record<string, number> } | null = null;

export const setOverride = (id: string | null, values?: Record<string, number>) => {
  override = id && values ? { id, values } : null;
};

export const getOverride = (id: string): Record<string, number> | null => (override && override.id === id ? override.values : null);
