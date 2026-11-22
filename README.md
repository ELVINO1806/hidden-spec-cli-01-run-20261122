# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ELVINO1806/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ELVINO1806/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits — to a tree of text files. It finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, then full whitespace), and writes every change or none at all.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file; without it, or with `-`, the patch is read from standard input. `--format=NAME` forces one of `unified`, `search-replace`, `v4a` or `json` (default `auto` detects it). `--check` reports what would change without writing anything, and `--strict` matches lines exactly.

## Check it

The kit's practice set (100 checks with expected outcomes) runs locally with the starter's checker:

```sh
node check.ts <path to the kit's program/generator/practice.json>
```

---

Entered on [make.fun](https://make.fun/?ref=4ajjjbdm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
