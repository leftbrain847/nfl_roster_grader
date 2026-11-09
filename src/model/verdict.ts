/**
 * Buy / sell / stand pat, and the one-line reason.
 *
 * 1. Odds at or below `sellerOdds`: sell.
 * 2. Odds at or above `contenderOdds`: buy for the weakest unit if it grades below `holeGrade`, else stand pat.
 * 3. The bubble in between: buy if odds >= bubble.buyOdds, the schedule left is easy and there is a hole;
 *    sell if odds <= bubble.sellOdds and the schedule left is hard; otherwise stand pat.
 */
import { UNIT_NEEDS, UNITS, VERDICT, type NeedConfig, type UnitKey, type Verdict, type VerdictConfig } from './config.ts';
import { ordinal } from './stats.ts';

export interface VerdictInput {
  record: string;
  playoffOdds: number;
  scheduleLeftRank: number;
  teams: number;
  weakest: UnitKey;
  weakestGrade: number;
  weakestRank: number;
  /** Ranks (1 = best) of the weakest unit's two halves (see UNIT_NEEDS); undefined when unknown. */
  primaryRank?: number;
  alternateRank?: number;
}

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
  need: NeedConfig | null;
}

export function needFor(unit: UnitKey, primaryRank?: number, alternateRank?: number): NeedConfig {
  const n = UNIT_NEEDS[unit];
  // larger rank = worse: when the alternate half is the weaker one, shop for it
  if (n.alternate && primaryRank !== undefined && alternateRank !== undefined && alternateRank > primaryRank) return n.alternate;
  return n.primary;
}

const pct = (x: number): string => {
  const p = Math.round(100 * x);
  if (p === 0 && x > 0) return '<1%';
  if (p === 100 && x < 1) return '>99%';
  return `${p}%`;
};

export function scheduleWord(rank: number, cfg: VerdictConfig = VERDICT): 'hard' | 'easy' | 'average' {
  if (rank <= cfg.schedule.hardRankMax) return 'hard';
  if (rank >= cfg.schedule.easyRankMin) return 'easy';
  return 'average';
}

export function decideVerdict(v: VerdictInput, cfg: VerdictConfig = VERDICT): VerdictResult {
  const unit = UNITS[v.weakest];
  const hole = v.weakestGrade < cfg.holeGrade;
  const sched = scheduleWord(v.scheduleLeftRank, cfg);
  const need = needFor(v.weakest, v.primaryRank, v.alternateRank);
  const buy = (): VerdictResult => ({
    verdict: 'buy',
    reason: `${cfg.labels.buy} ${need.label}: ${v.record}, ${unit.reason} ${ordinal(v.weakestRank)}`,
    need,
  });
  const sell = (): VerdictResult => ({
    verdict: 'sell',
    reason: `${cfg.labels.sell}: ${v.record}, ${pct(v.playoffOdds)} playoff odds${sched === 'hard' ? ', hard schedule left' : ''}`,
    need: null,
  });
  const standPat = (why: string): VerdictResult => ({ verdict: 'stand pat', reason: `${cfg.labels['stand pat']}: ${v.record}, ${why}`, need: null });

  if (v.playoffOdds <= cfg.sellerOdds) return sell();
  if (v.playoffOdds >= cfg.contenderOdds) {
    return hole ? buy() : standPat(`no weak unit (lowest: ${unit.reason} ${ordinal(v.weakestRank)})`);
  }
  if (v.playoffOdds >= cfg.bubble.buyOdds && sched === 'easy' && hole) return buy();
  if (v.playoffOdds <= cfg.bubble.sellOdds && sched === 'hard') return sell();
  return standPat(`${pct(v.playoffOdds)} playoff odds, ${sched} schedule left`);
}
