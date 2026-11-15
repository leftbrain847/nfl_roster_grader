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
| Snap counts | `snap_counts/snap_counts_<season>.csv` | defense snaps (rates and qualifying minimums), snap share in game logs |
| Contracts | `contracts/historical_contracts.parquet` | cap context on each player (APY, % of cap at signing, last year) and this season's base salary (for the base salary left). Only the parquet is current; the csv.gz stopped in 2022. Reading its year-by-year column takes ~1.3 GB, so `npm run refresh` raises Node's heap to 4 GB. |
| Weekly player stats | `stats_player/stats_player_week_<season>.csv` | player pages: one game-log line per game (columns in `GAME_LOG`, `config.ts`) |
| Weekly rosters (again) | `weekly_rosters/roster_weekly_<season>.csv` | the Moves tab: each player's team and status week by week; a change between weeks is a signing, release, reserve or practice-squad move |
| Trades | `trades/trades.csv` | the Moves tab: this season's trades (nflverse updates it a few times a year; until then an in-season trade shows as a player changing teams) |
| Depth charts | `depth_charts/depth_charts_<season>.csv` | team sheets: current depth order and changes (~75 MB by midseason) |
| Injuries | `injuries/injuries_<season>.csv` | game designations (and, from the This week tab, practice status) |
| FTN participation | `pbp_participation/pbp_participation_<season>.csv`, this season (after it ends) and last season | exact personnel shares and EPA per grouping (FTN Data via nflverse, CC BY-SA 4.0) |
| Play-by-play, last season | `pbp/play_by_play_<season-1>.csv.gz` | EPA per play for last season's exact personnel |
| Draft picks | `draft_picks/draft_picks.csv` | the Moves tab: this season's draft (no dates in the file: sorted on the draft's first day, `MOVES.draftDay`) |
| Pick values | [Ben Baldwin, NFL Draft Value Chart, Open Source Football](https://www.opensourcefootball.com/posts/2023-02-23-nfl-draft-value-chart/) (its `surplus` column, in `src/model/pickChart.ts`) | trade grades: a pick's surplus value as % of the cap per rookie season. **Licensed CC BY-NC 4.0** (attribution, no commercial use): that file keeps that license, not this repo's. A future pick is valued one round later per draft away (`PICK_VALUE`) |

**Value** (`src/model/value.ts`, settings in `VALUE`). Cap hit = the contract's row for this season. *Production per $*: a ranked player's production score is worth the cap hit at the same percentile of pay at his position; surplus = worth minus his cap hit. The best roster under a budget takes the starters with the highest total production whose cap hits fit (found exactly: a knapsack per position, then the budget split across positions). *Fantasy per $*: PPR points per $1M of cap hit, and the best fantasy lineup under a budget. *Cap value by team* (Front office tab): surplus summed over a team's ranked players, graded 0-100 across teams. Dead money, linemen and specialists are left out.

**Freshness.** Each source's footer row shows its Last-Modified date and what it covers ("through week 8 + 1 of 14 week 9 games"). States: *Current* (every played game is in), *Behind* (some aren't; the note says whether that is the usual lag or overdue), *Kept last copy* (the download failed, the file didn't parse, or it held less than our last copy, so the last good copy in `data/sources/` is used), *Missing* (no copy ever; the page builds without those stats). Only schedules, play-by-play and rosters are required; without any copy of those the refresh fails and nothing is committed.

## Model

Everything tunable is in `src/model/config.ts`.

1. **Unit grades** (`adjust.ts`, `grades.ts`). EPA per play, regular season, garbage time removed (win probability outside 5-95%). Opponent adjustment is a **ridge regression** per play type: `EPA = mu + offense + defense + home`, with each team effect penalized as if it had 120 extra league-average plays. Why ridge over the iterative "subtract opponents' average" method: it fits all offenses and defenses jointly, so schedule imbalance is handled in one fit, and the penalty shrinks small samples toward average, which matters at 9 games. With lambda 0 it is plain least squares (the tests check it recovers known effects). Grade = 100 × normal CDF of the team's z-score (sign flipped for defense); rank 1-32. **Series success** (nflfastR `series_success`: the play's series earned a first down or TD) is graded the same way on the same plays and shown beside EPA through a toggle (`UNIT_METRICS`); the calls, odds and needs use EPA only.
2. **Verdict** (`playoffs.ts`, `verdict.ts`). Team strength blends adjusted net EPA × 62 plays with point differential per game, regressed 30% to average. A seeded simulation plays out the remaining schedule 10,000 times (margin ~ Normal(strength gap + 1.5 home, 13.5)); per conference, 4 division winners + 3 best records make it, standings ties broken at random (not NFL tiebreakers). The page labels these "Playoff odds (rough sim)". Rules: odds ≤ 15% sell; ≥ 55% buy for the weakest unit if it grades under 45, else stand pat; in between, buy (odds ≥ 35%, easy schedule left, a hole) or sell (odds ≤ 30%, hard schedule left), else stand pat. Reason: `Buy pass rush: 9-3, pass D 27th`.
3. **Player rankings** (`players.ts`). Percentile within the position (mid-rank: ties share, a lone player is 50th) of a weighted mix of stat percentiles, among players over a per-team-game volume minimum. Rate stats take numerator and denominator from the same games, so a lagging source doesn't skew them. A player needs stats worth 60% of the position's weight to be scored.

    | Position | Stats (weight) | Minimum per team game |
    | --- | --- | --- |
    | QB | EPA/dropback 40, success rate 20, CPOE 20, sack rate 10 (low), pressure-to-sack 10 (low) | 14 dropbacks |
    | RB | EPA/carry 30, success rate 20, RYOE/carry 25, yards after contact/carry 15, broken tackles/carry 10 | 6 carries |
    | WR | EPA/target 35, target share 25, separation 15, YAC over expected 10, drop rate 15 (low) | 3.5 targets |
    | TE | EPA/target 40, target share 20, separation 15, YAC over expected 10, drop rate 15 (low) | 2.5 targets |
    | EDGE (DE, OLB) | pressures/100 snaps 50, big plays/100 35, missed tackle rate 15 (low) | 20 defense snaps |
    | IDL (DT, NT) | pressures/100 35, big plays/100 35, tackles/100 15, missed tackle rate 15 (low) | 20 defense snaps |
    | LB | big plays/100 35, tackles/100 20, missed tackle rate 15 (low), yards/target allowed 15 (low), pressures/100 15 | 25 defense snaps |
    | CB | big plays/100 35, yards/target allowed 25, rating allowed 20, comp % allowed 10 (all low), missed tackle rate 10 (low) | 30 defense snaps |
    | S | big plays/100 35, yards/target allowed 20, rating allowed 15 (low), tackles/100 15, missed tackle rate 15 (low) | 30 defense snaps |

    *Big plays* (a sack, interception, forced fumble, tackle for loss, pass defensed or QB hit) are each worth the EPA the play took from the offense, split evenly among the defenders who made one on it. Every defender is credited the same way, at the same weight in every group. This season that averages about 4.3 per interception, 2.9 per forced fumble (4.6 when the offense loses the ball), 1.7 per sack, 1.2 per tackle for loss, 0.9 per pass breakup and 0.3 per QB hit. Columns in `BIG_PLAYS`, `config.ts`.

    Kickers, punters and long snappers aren't ranked, and offensive linemen aren't ranked individually: open data has no per-player stat good enough. The line is graded by team instead (below).
4. **Offensive line** (`line.ts`). Team-level grades, not opponent-adjusted: **pass protection** = QB pressures (PFR) per dropback (play-by-play), counting only the team-games PFR covers; **run blocking** = rushing yards before contact per carry (PFR). Both also reflect the QB, backs and scheme, and the page says so. Grade and rank as for units. Shown on each team sheet and under Players → OL.
5. **Where to buy** (`buy.ts`, `line.ts`). Unit → need (`UNIT_NEEDS`). Three units pick the weaker of their two halves:
    - pass O → a pass catcher (WR, TE; rank: EPA per non-sack attempt) or **pass protection** (rank: pressure rate allowed)
    - rush O → a running back (RB; rank: yards after contact per carry) or **run blocking** (rank: yards before contact per carry)
    - pass D → pass rush (EDGE, IDL; sacks + QB hits per dropback) or coverage (CB, S; EPA per non-sack attempt allowed)
    - rush D → run defense (IDL, LB)

    Position needs list the best producers at those positions on seller teams, active roster only. Line needs list starters (T, G, C with ≥ 60% of their team's offense snaps) from the sellers with the best line grade of that kind, at most 2 per team. Their score is the team's line grade, labeled as such. The roster file has no PFR id for linemen, so they're matched to snap counts by name on the same team (full name, else a last name unique among that team's linemen); anything ambiguous is left out, and the refresh log lists unmatched linemen.
6. **Base salary left** (`contracts.ts`). This season's base salary × weeks left / 18, what a team trading for the player takes on (per-game roster bonuses and incentives not included) (base salary is paid weekly; signing-bonus proration stays with the old team). Shown on every player with a contract on file. **Team cap room is not shown:** the open contracts data has no dead money (its inactive rows are mostly superseded contracts), so room computed from it is badly wrong for some teams (one would show over $200M).

**Depth charts** (`depth.ts`, `DEPTH`, `INJURY`). Team sheets show the newest nflverse depth chart snapshot (ESPN, about two a day; one file per season from 2025 on) with each player's production score and this week's injury designation (nflverse injuries `report_status`, else a reserve status on the weekly roster). Changes are flagged against the newest snapshot from at least `minDaysBefore` (1) days earlier: new on a slot, moved up or down, off the chart. A snapshot much smaller than the team's usual (a partial pull) is skipped.

**This week tab** (`src/model/fantasyAllowed.ts`, settings in `THIS_WEEK` and `FANTASY_ALLOWED`). The week is the first one with a game not yet played.
- *Fantasy points allowed*: PPR points per game each defense gave up to QB / RB (FB included) / WR / TE, from the weekly player stats (`opponent_team`), over the season and the last `recentWeeks` (4) weeks played. Adjusted with the unit grades' ridge regression on game totals (`points = mu + offense + defense + home`, penalty `lambdaGames` = 3 games). Rank 1 = allows the most.
- *Red zone usage* (`redZone.ts`, `RED_ZONE`): targets and carries from play-by-play with `yardline_100` at or inside 20 and 10, per player per week, with each player's share of his team's. Kneels, spikes, two-point tries and sacks don't count. The saved play-by-play extract carries `PBP_VERSION`; bump it when the cutoffs change.
- *Personnel* (`personnel.ts`, `PERSONNEL`), **estimated from snap counts**: average RBs (FB included), TEs and WRs on the field per offensive snap = the position's offense snaps / the team's offense snaps (PFR snap counts), per game and season to date. Rates: heavy (2+ TE or 2+ RB) = `heavyScale` × ((TE−1)+ + (RB−1)+); 12 = `twoTeScale` × (TE−1)+; 11 = 1 − heavy − (WR−3)+, where (x)+ is x clamped to 0-1. Unscaled, those would be exact for a team that only ever used 1-2 TEs and 1-2 RBs; real teams spread wider, so the scales (0.83, 0.62) are least-squares fits on 2025. `node pipeline/validate-personnel.ts 2025 <snap_counts_2025.csv> <pbp_participation_2025.csv> <play_by_play_2025.csv.gz> <games.csv>` compares with FTN participation and refits. 2025, scales refit leaving each team out: by team over the season, MAE 4.5 / 5.5 / 3.6 rate points for 11 / 12 / heavy, Spearman 0.85 / 0.71 / 0.90; by team-game, MAE 6.2 / 8.5 / 5.3. The page labels it "Estimated from snap counts" and names SumerSports for exact current numbers (as text: the Play bundle check forbids `https://` strings).
- *Exact personnel*: when FTN participation (`pbp_participation_<season>.csv`, via nflverse, **CC BY-SA 4.0**) is published for a season, the page shows that season's exact 11 / 12 / heavy shares and EPA per play by grouping (joined to play-by-play on `play_id`), credited "FTN Data via nflverse". It reads this season's file (published after the season) and last season's (with last season's play-by-play for EPA). Tables derived from it are shared under the same license.
- *Exact personnel slot (off)*: `PERSONNEL_SOURCE` reads `{ "<TEAM>": { "<week>": { "<grouping>": plays } } }` from `data/personnel.json` and shows it instead of the estimate. Like the ratings slot, the refresh refuses it unless `republishAllowed` is true.

**Ratings slot (off).** `RATINGS_SOURCE` in config reserves a second ranking: a `{gsis_id: 0-100}` file plus a Production / Ratings / Composite toggle that appears only when it's on. It may be enabled only for data we're allowed to republish (`republishAllowed: true`); the refresh refuses otherwise. Madden ratings are not in this build.

## Nightly refresh

`.github/workflows/refresh-data.yml` runs at 06:07 UTC (1:07 AM EST, 2:07 AM EDT) and on manual dispatch. A read-only job runs `npm ci`, the refresh, typecheck, tests and the page build, and hands over only `data/*.json`, `data/sources/*.json` and `web/roster_grader.html`. A second job (the only one with `contents: write`) checks that hand-over, commits to `main` if anything changed, and pushes. Any failure commits nothing, so the last good page stays live. Actions are pinned to full commit SHAs.

## Credits

Data: [nflverse](https://github.com/nflverse) (nflfastR play-by-play and EPA, schedules, rosters), NFL Next Gen Stats, Pro Football Reference, OverTheCap, all via nflverse. Not affiliated with the NFL or any team.

### Data under their own licenses

This repo's code license does not cover these. Each keeps its own terms, which the page states where the data appears.

| What | Where in this repo / on the page | License | What we do about it |
| --- | --- | --- | --- |
| Draft pick values (Ben Baldwin, Open Source Football) | `src/model/pickChart.ts`; trade grades | CC BY-NC 4.0 | Credit on the page; no commercial use of that file or what's built from it |
| FTN participation (FTN Data via nflverse) | `data/sources/participation*.json` (per-play groupings, written by the nightly refresh); the page's exact personnel tables | CC BY-SA 4.0 | Credit with a license link and the changes made (summed by team and grouping, joined to nflfastR EPA). ShareAlike: those files and tables are offered under CC BY-SA 4.0 too. It does not reach the rest of the page or the code, which are separate works |

Not used from FTN: the snap-count estimate's two scales were fitted against 2025 FTN numbers (two constants, not FTN data), and the estimate itself uses only PFR snap counts.

If a new source comes with a license, add it here and on the page, or don't add the source.

## Budget (friends target)

Read-only page: no runs or rooms, so it costs only the requests to load it.
