/**
 * Roster Grader is a read-only page: no runs, no rooms, no scores. The platform still needs a GameModule to
 * register for the friends Worker, so this is the smallest valid one. The model lives in src/model/.
 */
import type { GameModule } from '@app-builder/host';
import config from '../app.config.json';

export const app: GameModule<Record<string, never>, null, never, null> = {
  id: config.id,
  defaultConfig: {},
  // No rooms: these limits are unused but required by the contract.
  limits: { tickHz: 0, snapshotHz: 0, minPlayers: 1, maxPlayers: 1, maxMsgBytes: 256, maxInputsPerSec: 1 },
  parseInput: () => null,
  init: () => null,
  onInput: () => undefined,
  viewFor: () => null,
  isOver: () => true,
};
