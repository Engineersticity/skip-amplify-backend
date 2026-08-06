# skip-amplify-backend

A CLI wrapper to intelligently skip AWS Amplify backend updates (Gen 2) if there are no changes in the `amplify` folder. This helps speed up your CI/CD pipelines and prevents unnecessary backend deployments when only frontend code changes.

## Problem

By default, AWS Amplify will run a full backend deployment during every continuous deployment cycle. For monorepos or projects where frontend code changes rapidly relative to the backend (the `amplify/` folder), this slows down the deployment pipeline and introduces potential risk. 

## Solution

This package acts as a conditional wrapper around your deploy command: `npx skip-amplify-backend <command>`. It automatically compares the current commit with the previous commit (`HEAD` vs `HEAD^`) in the `amplify/` folder.

- If **no changes** are found, the script safely exits code `0`, skipping the deployment command entirely without causing the pipeline to fail. **It also automatically fetches your latest backend configuration (`amplify_outputs.json` or `aws-exports.js`) so your frontend always has what it needs to build!**
- If **changes** are found, it transparently passes execution to your deploy command.
- It automatically detects shallow clones (common in CI/CD platforms like Amplify Hosting) and fetches enough Git history to do the comparison.

## Installation

You can install this globally, or run it via `npx` (recommended).

```bash
npm install -g skip-amplify-backend
# or add as a devDependency in your project
npm install -D skip-amplify-backend
```

## Usage in `amplify.yml`

In your standard Amplify Build settings (`amplify.yml`), prefix your backend deployment command (`ampx pipeline-deploy`) with `npx skip-amplify-backend`.

### Example `amplify.yml`

```yaml
version: 1
backend:
  phases:
    build:
      commands:
        - npm ci --cache .npm --prefer-offline
        # Wrap your deployment command with skip-amplify-backend
        # Note: Using --yes avoids interactive prompts in CI/CD environments
        - npx --yes skip-amplify-backend npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
artifacts:
  baseDirectory: .amplify
  files:
    - '**/*'
```

### Monorepo Support (Custom Backend Folder)
By default, the script watches the `amplify` folder based on standard AWS Amplify architecture. If your backend is in a different folder (e.g. `packages/backend`), you can override it using the `SKIP_AMPLIFY_FOLDER` environment variable:

```yaml
        - SKIP_AMPLIFY_FOLDER="packages/backend" npx --yes skip-amplify-backend npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
```

## How it works
1. Detects if it's running in a shallow cloned git repository, and if so, deepens it with `git fetch` so history is available.
2. Resolves the **baseline commit** to compare against (see below), fetching it on demand if it isn't in the shallow clone.
3. Runs `git diff --quiet <baseline> HEAD -- amplify`.
4. If there are no changes, prints a success message and checks if it is running in an Amplify CI/CD environment (by checking for `AWS_APP_ID` and `AWS_BRANCH`).
5. If in Amplify CI/CD, it automatically fetches your current backend config (`npx ampx generate outputs` for Gen 2 or `amplify pull` for Gen 1) so your frontend code doesn't break due to a missing outputs file.
6. If there are changes, spawns the user-provided deployment command passed as arguments.

At every step where it can't be sure (git missing, baseline unresolvable, diff errors), it **fails safe by deploying** — it will never skip a deploy it isn't certain about.

### How the baseline is chosen

The baseline is the commit whose backend is currently live. The script resolves it in this order:

1. **`SKIP_AMPLIFY_BASE_SHA`** — an explicit commit SHA, if you set it (escape hatch / advanced use).
2. **Last successful Amplify build** — in Amplify CI/CD it calls the Amplify Jobs API (`aws amplify list-jobs`) and looks at the **immediately preceding build** on this branch. It uses that build's commit as the baseline **only** if the build was a clean `SUCCEED` identified by a real commit SHA. Otherwise (a failed/cancelled/running build, or a manual/webhook deploy whose `commitId` is `"HEAD"` rather than a SHA) it can't be sure what's live, so it **deploys to be safe**. It also deploys when there is no prior build at all (first deployment).
3. **`HEAD^`** — the parent of the tip commit. A single-commit heuristic used whenever the Jobs API isn't available (no `amplify:ListJobs` permission, outside Amplify CI/CD, etc.). In Amplify CI/CD it logs a warning that multi-commit protection is inactive; set `SKIP_AMPLIFY_ALLOW_HEAD_PARENT=1` to acknowledge the heuristic and silence that warning.

**Why not just `HEAD^`?** `HEAD^` only works when exactly one commit is deployed per build. If you push several commits at once (or rebase/fast-forward) and the backend change is in an earlier commit of that batch — not the branch tip — a `HEAD^ vs HEAD` diff misses it and **skips a deploy it shouldn't**. Diffing against the last *actually deployed* commit closes that gap and also avoids redundant deploys on manual redeploys of the same commit.

**Fail-safe principle:** whenever the script can't be *certain* the backend is unchanged (git missing, baseline unresolvable, unreachable commit, unclear deploy history, diff error), it deploys. A redundant deploy is wasteful; a wrongly-skipped one ships a stale backend — so it always errs toward deploying.

### Required IAM permission

To read the last deployed commit, the Amplify **backend build role** needs the `amplify:ListJobs` permission. Add this statement to that role's policy:

```json
{
  "Effect": "Allow",
  "Action": "amplify:ListJobs",
  "Resource": "arn:aws:amplify:*:*:apps/*/branches/*/jobs/*"
}
```

This permission is **strongly recommended**. It's what lets the script diff against the last *actually deployed* commit and protect against multi-commit pushes, rebases, and manual redeploys.

**Without it, the tool still works** — it falls back to the `HEAD^` heuristic and logs a warning that multi-commit protection is inactive. That fallback only compares the tip commit against its parent, so a backend change that lands in a non-tip commit of a multi-commit push can be wrongly skipped. Grant `amplify:ListJobs` to close that gap, or set `SKIP_AMPLIFY_ALLOW_HEAD_PARENT=1` to silence the warning if you accept the heuristic (e.g. your branch always deploys one commit at a time).

### First deployment

The first-ever build is always deployed, never skipped, **when `amplify:ListJobs` is granted**: the Jobs API reports no prior successful build, so the script deploys.

Without the permission, the first build falls back to the `HEAD^` heuristic, so make sure your first commit is the one that introduces the `amplify/` folder — that way the heuristic sees a change and triggers the initial deploy.
