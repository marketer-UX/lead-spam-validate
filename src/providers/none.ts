import type { DeepProvider } from './types.js';
import { unknownResult } from './types.js';

export const noneProvider: DeepProvider = {
  name: 'none',
  async checkDeep() { return unknownResult('native', Date.now()); },
  async health() { return null; },
};
