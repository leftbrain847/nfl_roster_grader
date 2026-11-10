/** Contract context for a player, including what trading for him now costs. */
import { TRADE_COST, type TradeCostConfig } from './config.ts';
import { round } from './stats.ts';
import type { Contract, PlayerContract } from './types.ts';

/** weeksPlayed: regular-season weeks already played (paid). */
export function playerContract(c: Contract, weeksPlayed: number, cfg: TradeCostConfig = TRADE_COST): PlayerContract {
  const left = Math.max(0, cfg.payWeeks - weeksPlayed) / cfg.payWeeks;
  return {
    apyMillions: c.apyMillions,
    capPct: c.capPct,
    lastYear: c.lastYear,
    baseSalaryMillions: c.baseSalaryMillions,
    baseSalaryLeftMillions: c.baseSalaryMillions === null ? null : round(c.baseSalaryMillions * left, 2),
  };
}
