# skip-amplify-backend

A CLI wrapper to intelligently skip AWS Amplify backend updates (Gen 2) if there are no changes in the `amplify` folder. This helps speed up your CI/CD pipelines and prevents unnecessary backend deployments when only frontend code changes.

## Problem

By default, AWS Amplify will run a full backend deployment during every continuous deployment cycle. For monorepos or projects where frontend code changes rapidly relative to the backend (the `amplify/` folder), this slows down the deployment pipeline and introduces potential risk. 

## Solution

This package acts as a conditional wrapper around your deploy command: `npx skip-amplify-backend <command>`. It automatically compares the current commit with the previous commit (`HEAD` vs `HEAD^`) in the `amplify/` folder.

- If **no changes** are found, the script safely exits code `0`, skipping the deployment command entirely without causing the pipeline to fail.
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

## How it works
1. Detects if it's running in a shallow cloned git repository, and if so, runs `git fetch --depth=2`.
2. Runs `git diff --quiet HEAD^ HEAD -- amplify`.
3. If the exit code is 0 (no changes), prints a success message and skips the next command.
4. If the exit code is 1 (changes), spawns the command passed as arguments.
