import type { Config } from '../server/config.js';
import { makeAfterShipProvider } from './aftership.js';
import { noneProvider } from './none.js';
import { makeReacherProvider } from './reacher.js';
import type { DeepProvider } from './types.js';

export type { DeepProvider } from './types.js';

export function getProvider(cfg: Config): DeepProvider {
  if (cfg.provider === 'aftership' && cfg.deepVerifierUrl) {
    return makeAfterShipProvider({ url: cfg.deepVerifierUrl, apiKey: cfg.deepVerifierKey, debug: cfg.debug });
  }
  if (cfg.provider === 'reacher' && cfg.reacherUrl) {
    return makeReacherProvider({ url: cfg.reacherUrl, secret: cfg.reacherSecret, fromEmail: cfg.fromEmail, helloName: cfg.helloName, debug: cfg.debug });
  }
  return noneProvider;
}
