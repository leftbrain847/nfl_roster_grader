# Roster Grader

Every NFL team graded on four units (pass offense, rush offense, pass defense, rush defense), a buy / sell / stand pat call for the trade deadline with a one-line reason, and where each buyer should shop: the top producers at the matching positions on teams that should sell. Player rankings by position come from open production data. Built on [app_builder](https://github.com/leftbrain847/app_builder) (`solo` mode).

The public page is `web/roster_grader.html`: one self-contained file, no network calls. The nightly workflow rebuilds it.

## Run

```sh
npm ci
npm run refresh      # download nflverse, rebuild data/ (writes data/roster_grader.json and data/sources/*.json)
npm run dev          # local dev server
npm run build:web    # web/roster_grader.html
npm test             # model, verdict, percentile, mapping and refresh tests (fixtures, no network)
npm run sample       # rebuild test/fixtures/sample-output.json after changing the model or fixtures
```

`npm run refresh -- --offline <dir>` rebuilds from files already downloaded (as in `.cache/raw`). `REFRESH_DATE=YYYY-MM-DD` sets "today".

## Data

All from the [nflverse-data](https://github.com/nflverse/nflverse-data) GitHub releases (`pipeline/sources.ts`):

| Source | File | Used for |
| --- | --- | --- |
| Schedules | `schedules/games.csv` | records, remaining schedule, what each source should cover |
| Play-by-play | `pbp/play_by_play_<season>.csv.gz` | team EPA (unit grades), player EPA, success, targets, tackles, sacks, TFL, passes defensed |
| Weekly rosters | `weekly_rosters/roster_weekly_<season>.csv` | current team, position, status, gsis/PFR id join |
| Next Gen Stats | `nextgen_stats/ngs_{passing,receiving,rushing}.csv.gz` | CPOE, separation, YAC over expected, rush yards over expected |
| PFR advanced | `pfr_advstats/advstats_week_{pass,rush,rec,def}_<season>.csv` | pressure-to-sack, yards after contact, broken tackles, drops, pressures, coverage, missed tackles |
| Snap counts | `snap_counts/snap_counts_<season>.csv` | defense snaps (rates and qualifying minimums) |
| Contracts | `contracts/historical_contracts.parquet` | cap context on each player (APY, % of cap at signing, last year) and this season's base salary (for the base salary left). Only the parquet is current; the csv.gz stopped in 2022. Reading its year-by-year column takes ~1.3 GB, so `npm run refresh` raises Node's heap to 4 GB. |

**Freshness.** Each source's footer row shows its Last-Modified date and what it covers ("through week 8 + 1 of 14 week 9 games"). States: *Current* (every played game is in), *Behind* (some aren't; the note says whether that is the usual lag or overdue), *Kept last copy* (the download failed, the file didn't parse, or it held less than our last copy, so the last good copy in `data/sources/` is used), *Missing* (no copy ever; the page builds without those stats). Only schedules, play-by-play and rosters are required; without any copy of those the refresh fails and nothing is committed.

## Model

Everything tunable is in `src/model/config.ts`.

1. **Unit grades** (`adjust.ts`, `grades.ts`). EPA per play, regular season, garbage time removed (win probability outside 5-95%). Opponent adjustment is a **ridge regression** per play type: `EPA = mu + offense + defense + home`, with each team effect penalized as if it had 120 extra league-average plays. Why ridge over the iterative "subtract opponents' average" method: it fits all offenses and defenses jointly, so schedule imbalance is handled in one fit, and the penalty shrinks small samples toward average, which matters at 9 games. With lambda 0 it is plain least squares (the tests check it recovers known effects). Grade = 100 × normal CDF of the team's z-score (sign flipped for defense); rank 1-32.
2. **Verdict** (`playoffs.ts`, `verdict.ts`). Team strength blends adjusted net EPA × 62 plays with point differential per game, regressed 30% to average. A seeded simulation plays out the remaining schedule 10,000 times (margin ~ Normal(strength gap + 1.5 home, 13.5)); per conference, 4 division winners + 3 best records make it, standings ties broken at random (not NFL tiebreakers). The page labels these "Playoff odds (rough sim)". Rules: odds ≤ 15% sell; ≥ 55% buy for the weakest unit if it grades under 45, else stand pat; in between, buy (odds ≥ 35%, easy schedule left, a hole) or sell (odds ≤ 30%, hard schedule left), else stand pat. Reason: `Buy pass rush: 9-3, pass D 27th`.
3. **Player rankings** (`players.ts`). Percentile within the position (mid-rank: ties share, a lone player is 50th) of a weighted mix of stat percentiles, among players over a per-team-game volume minimum. Rate stats take numerator and denominator from the same games, so a lagging source doesn't skew them. A player needs stats worth 60% of the position's weight to be scored.

    | Position | Stats (weight) | Minimum per team game |
    | --- | --- | --- |
    | QB | EPA/dropback 40, success rate 20, CPOE 20, sack rate 10 (low), pressure-to-sack 10 (low) | 14 dropbacks |
    | RB | EPA/carry 30, success rate 20, RYOE/carry 25, yards after contact/carry 15, broken tackles/carry 10 | 6 carries |
    | WR | EPA/target 35, target share 25, separation 15, YAC over expected 10, drop rate 15 (low) | 3.5 targets |
    | TE | EPA/target 40, target share 20, separation 15, YAC over expected 10, drop rate 15 (low) | 2.5 targets |
    | EDGE (DE, OLB) | pressures/100 snaps 45, sacks/100 25, TFL/100 20, missed tackle rate 10 (low) | 20 defense snaps |
    | IDL (DT, NT) | pressures/100 35, sacks/100 15, TFL/100 25, tackles/100 15, missed tackle rate 10 (low) | 20 defense snaps |
    | LB | tackles/100 25, TFL/100 20, missed tackle rate 20 (low), yards/target allowed 20 (low), pressures/100 15 | 25 defense snaps |
    | CB | yards/target allowed 30, rating allowed 25, comp % allowed 15 (all low), INT+PD/target 20, missed tackle rate 10 (low) | 30 defense snaps |
    | S | yards/target allowed 25, rating allowed 20 (low), INT+PD/target 20, tackles/100 15, missed tackle rate 20 (low) | 30 defense snaps |

    Kickers, punters and long snappers aren't ranked, and offensive linemen aren't ranked individually: open data has no per-player stat good enough. The line is graded by team instead (below).
4. **Offensive line** (`line.ts`). Team-level grades, not opponent-adjusted: **pass protection** = QB pressures (PFR) per dropback (play-by-play), counting only the team-games PFR covers; **run blocking** = rushing yards before contact per carry (PFR). Both also reflect the QB, backs and scheme, and the page says so. Grade and rank as for units. Shown on each team sheet and under Players → OL.
5. **Where to buy** (`buy.ts`, `line.ts`). Unit → need (`UNIT_NEEDS`). Three units pick the weaker of their two halves:
    - pass O → a pass catcher (WR, TE; rank: EPA per non-sack attempt) or **pass protection** (rank: pressure rate allowed)
    - rush O → a running back (RB; rank: yards after contact per carry) or **run blocking** (rank: yards before contact per carry)
    - pass D → pass rush (EDGE, IDL; sacks + QB hits per dropback) or coverage (CB, S; EPA per non-sack attempt allowed)
    - rush D → run defense (IDL, LB)

    Position needs list the best producers at those positions on seller teams, active roster only. Line needs list starters (T, G, C with ≥ 60% of their team's offense snaps) from the sellers with the best line grade of that kind, at most 2 per team. Their score is the team's line grade, labeled as such. The roster file has no PFR id for linemen, so they're matched to snap counts by name on the same team (full name, else a last name unique among that team's linemen); anything ambiguous is left out, and the refresh log lists unmatched linemen.
6. **Base salary left** (`contracts.ts`). This season's base salary × weeks left / 18, what a team trading for the player takes on (per-game roster bonuses and incentives not included) (base salary is paid weekly; signing-bonus proration stays with the old team). Shown on every player with a contract on file. **Team cap room is not shown:** the open contracts data has no dead money (its inactive rows are mostly superseded contracts), so room computed from it is badly wrong for some teams (one would show over $200M).

**Ratings slot (off).** `RATINGS_SOURCE` in config reserves a second ranking: a `{gsis_id: 0-100}` file plus a Production / Ratings / Composite toggle that appears only when it's on. It may be enabled only for data we're allowed to republish (`republishAllowed: true`); the refresh refuses otherwise. Madden ratings are not in this build.

## Nightly refresh

`.github/workflows/refresh-data.yml` runs at 06:07 UTC (1:07 AM EST, 2:07 AM EDT) and on manual dispatch. A read-only job runs `npm ci`, the refresh, typecheck, tests and the page build, and hands over only `data/*.json`, `data/sources/*.json` and `web/roster_grader.html`. A second job (the only one with `contents: write`) checks that hand-over, commits to `main` if anything changed, and pushes. Any failure commits nothing, so the last good page stays live. Actions are pinned to full commit SHAs.

## Credits

Data: [nflverse](https://github.com/nflverse) (nflfastR play-by-play and EPA, schedules, rosters), NFL Next Gen Stats, Pro Football Reference, OverTheCap, all via nflverse. Not affiliated with the NFL or any team.

## Budget (friends target)

Read-only page: no runs or rooms, so it costs only the requests to load it.
