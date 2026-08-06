#!/usr/bin/env node

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');

// Timeouts (ms) so a slow/hung network call can never stall the build until
// Amplify's global timeout. On timeout execFileSync throws, which every caller
// already treats as a failure and handles by failing safe (deploying).
const GIT_TIMEOUT_MS = 20000; // local git plumbing (rev-parse, diff, cat-file)
const FETCH_TIMEOUT_MS = 45000; // network `git fetch`
const AWS_TIMEOUT_MS = 15000; // `aws amplify list-jobs`
const OUTPUTS_TIMEOUT_MS = 120000; // `ampx generate outputs` / `amplify pull`

// Run `file args...` and return trimmed stdout, or null if it fails/times out.
// Uses execFileSync (no shell) so arguments are never re-interpreted.
function tryExec(file, argsArray, timeout = GIT_TIMEOUT_MS) {
  try {
    return execFileSync(file, argsArray, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout,
      killSignal: 'SIGKILL',
    }).trim();
  } catch (error) {
    return null;
  }
}

// True if `git args...` exits 0 within the timeout.
function gitOk(argsArray, timeout = GIT_TIMEOUT_MS) {
  try {
    execFileSync('git', argsArray, { stdio: 'ignore', timeout, killSignal: 'SIGKILL' });
    return true;
  } catch (e) {
    return false;
  }
}

// Hand off to the user-provided deployment command and exit with its code.
function runDeploy(args) {
  console.log('🚧 Running deployment command...');
  const child = spawn(args.join(' '), { stdio: 'inherit', shell: true });
  child.on('close', (code, signal) => {
    if (signal) {
      // Terminated by a signal (OOM/SIGKILL, build timeout/cancel). `code` is
      // null here — never report that as success.
      console.error(`❌ Deployment command was terminated by signal ${signal}.`);
      process.exit(1);
    }
    process.exit(code == null ? 1 : code);
  });
  child.on('error', (err) => {
    console.error(`❌ Failed to start command: ${err.message}`);
    process.exit(1);
  });
}

// Ask the Amplify Jobs API what the previous build on this branch did, so we can
// diff against the commit whose backend is actually live.
//
// We only trust the *immediately preceding* build, and only when it is a clean
// success identified by a real commit SHA. Reaching past a newer non-success is
// unsafe: Amplify's backend phase (`ampx pipeline-deploy`) can deploy and THEN a
// later phase can fail, so a FAILED/CANCELLED job may still have advanced the
// live backend. And manual/webhook/redeploy jobs report commitId "HEAD" (not a
// SHA), which we must not feed to git as a baseline. In every unclear case we
// fail safe by asking the caller to deploy.
//
// Returns one of:
//   { commit: '<sha>' }   — trustworthy last-deployed commit
//   { firstDeploy: true } — API answered; this branch has no prior build
//   { uncertain: true }   — API answered, but the last build isn't a clean,
//                           SHA-identified success → deploy to be safe
//   null                  — couldn't query the API (not in Amplify CI, no AWS
//                           CLI, missing permission, error)
function getLastDeployedCommit() {
  const appId = process.env.AWS_APP_ID;
  const branch = process.env.AWS_BRANCH;
  if (!appId || !branch) return null;

  const cmd = ['amplify', 'list-jobs', '--app-id', appId, '--branch-name', branch,
    '--max-results', '50', '--output', 'json'];
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (region) cmd.push('--region', region);

  const raw = tryExec('aws', cmd, AWS_TIMEOUT_MS);
  if (raw === null) return null; // CLI missing / permission denied / timeout / error

  let jobs;
  try {
    jobs = JSON.parse(raw).jobSummaries || [];
  } catch (e) {
    return null;
  }

  // list-jobs is newest-first. Look only at the most recent build that isn't the
  // one we're currently running.
  const currentJob = process.env.AWS_JOB_ID;
  const prior = jobs.filter((j) => j.jobId !== currentJob);
  if (prior.length === 0) return { firstDeploy: true };

  const latest = prior[0];
  const isSha = /^[0-9a-fA-F]{7,40}$/.test(latest.commitId || '');
  if (latest.status === 'SUCCEED' && isSha) {
    return { commit: latest.commitId };
  }
  return { uncertain: true };
}

// Make sure commit `ref` exists locally so we can diff against it. In shallow CI
// clones it usually won't, so fetch just that one commit. Returns true if it is
// available afterwards.
function ensureCommit(ref) {
  if (gitOk(['cat-file', '-e', `${ref}^{commit}`])) return true;
  console.log(`📦 Baseline commit ${ref.slice(0, 8)} not in local history. Fetching it...`);
  try {
    // stderr silenced: an unreachable ref is expected sometimes and we translate
    // the failure into a friendly message + a safe deploy in the caller.
    execFileSync('git', ['fetch', '--depth=1', 'origin', ref], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: FETCH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    return false;
  }
  return gitOk(['cat-file', '-e', `${ref}^{commit}`]);
}

// Resolve what HEAD should be compared against. Priority:
//   1. SKIP_AMPLIFY_BASE_SHA           — explicit override
//   2. last successful Amplify build   — Jobs API (the deployed commit)
//   3. HEAD^                           — legacy fallback (single-commit builds)
// Returns either:
//   { ref, source }        — diff HEAD against ref
//   { deploy: true, reason} — skip the check and deploy (fail safe / first deploy)
function resolveBaseline() {
  const override = (process.env.SKIP_AMPLIFY_BASE_SHA || '').trim();
  if (override) {
    if (!/^[0-9a-fA-F]{7,40}$/.test(override)) {
      console.warn(`⚠️  SKIP_AMPLIFY_BASE_SHA ("${override}") is not a valid commit SHA. Ignoring it.`);
    } else if (ensureCommit(override)) {
      return { ref: override, source: `SKIP_AMPLIFY_BASE_SHA override (${override.slice(0, 8)})` };
    } else {
      return { deploy: true, reason: `Could not resolve SKIP_AMPLIFY_BASE_SHA (${override.slice(0, 8)}).` };
    }
  }

  const deployed = getLastDeployedCommit();
  if (deployed && deployed.firstDeploy) {
    return { deploy: true, reason: 'No previous successful Amplify deployment found for this branch — deploying the backend for the first time.' };
  }
  if (deployed && deployed.uncertain) {
    return { deploy: true, reason: "Could not confirm which commit is currently deployed (the last build wasn't a clean success) — deploying to be safe." };
  }
  if (deployed && deployed.commit) {
    if (ensureCommit(deployed.commit)) {
      return { ref: deployed.commit, source: `last successful Amplify build (${deployed.commit.slice(0, 8)})` };
    }
    return { deploy: true, reason: `Last deployed commit ${deployed.commit.slice(0, 8)} is unreachable (history rewritten?) — deploying to be safe.` };
  }

  // getLastDeployedCommit() returned null → the Jobs API was unavailable. Fall
  // back to the parent of HEAD. This only inspects the tip commit, so a
  // multi-commit push whose backend change isn't in the tip can be wrongly
  // skipped — warn about that in Amplify CI, where the robust path is available
  // by granting amplify:ListJobs. (SKIP_AMPLIFY_ALLOW_HEAD_PARENT acknowledges
  // the heuristic and silences the warning.)
  const inAmplifyCI = !!(process.env.AWS_APP_ID && process.env.AWS_BRANCH);
  const acknowledged = /^(1|true|yes)$/i.test(process.env.SKIP_AMPLIFY_ALLOW_HEAD_PARENT || '');
  if (inAmplifyCI && !acknowledged) {
    console.warn('⚠️  Could not read Amplify deployment history (is the amplify:ListJobs permission granted?).');
    console.warn('⚠️  Falling back to the HEAD^ heuristic — a backend change in a non-tip commit of a multi-commit push may be wrongly skipped.');
    console.warn('⚠️  Grant amplify:ListJobs for full protection, or set SKIP_AMPLIFY_ALLOW_HEAD_PARENT=1 to silence this warning.');
  }

  if (gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^'])) {
    return { ref: 'HEAD^', source: 'HEAD^ (parent commit — single-commit heuristic)' };
  }
  return { deploy: true, reason: 'No baseline available (no parent commit) — deploying to be safe.' };
}

// After a skip, refresh the frontend's backend config so the build doesn't break
// on a missing amplify_outputs.json / aws-exports.js.
function generateOutputs() {
  if (!(process.env.AWS_APP_ID && process.env.AWS_BRANCH)) {
    console.log('ℹ️ Not running in AWS Amplify CI/CD (missing AWS_APP_ID). Skipping outputs generation.');
    return;
  }
  console.log('📥 AWS Amplify CI/CD environment detected. Fetching latest backend outputs for the frontend...');
  try {
    if (fs.existsSync('amplify/backend.ts') || fs.existsSync('amplify/data/resource.ts') || fs.existsSync('amplify/package.json')) {
      console.log('⚡ Detected Amplify Gen 2. Running ampx generate outputs...');
      execFileSync('npx', ['ampx', 'generate', 'outputs', '--branch', process.env.AWS_BRANCH, '--app-id', process.env.AWS_APP_ID], { stdio: 'inherit', timeout: OUTPUTS_TIMEOUT_MS, killSignal: 'SIGKILL' });
    } else {
      console.log('⚡ Detected Amplify Gen 1. Running amplify pull...');
      execFileSync('amplify', ['pull', '--yes'], { stdio: 'inherit', timeout: OUTPUTS_TIMEOUT_MS, killSignal: 'SIGKILL' });
    }
    console.log('✅ Backend outputs successfully fetched!');
  } catch (error) {
    console.warn(`⚠️ Warning: Failed to fetch backend outputs automatically: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: skip-amplify-backend <command to run if changes detected>');
    process.exit(1);
  }

  const amplifyFolder = process.env.SKIP_AMPLIFY_FOLDER || 'amplify';

  // 0. Git must be available; if not, we can't compare — deploy to be safe.
  if (!gitOk(['--version'])) {
    console.warn('⚠️ Git is not installed or accessible. Cannot verify changes. Assuming changes exist.');
    return runDeploy(args);
  }

  // 1. Deepen shallow clones so the HEAD^ fallback has a parent. (A specific
  //    baseline SHA from the Jobs API is fetched on demand in ensureCommit.)
  if (tryExec('git', ['rev-parse', '--is-shallow-repository']) === 'true') {
    console.log('📦 Shallow repository detected. Fetching an extra commit of history...');
    try {
      execFileSync('git', ['fetch', '--depth=2'], { stdio: 'inherit', timeout: FETCH_TIMEOUT_MS, killSignal: 'SIGKILL' });
    } catch (e) {
      console.warn('⚠️ Warning: Failed to deepen history. Will fail safe (deploy) if the baseline is missing.');
    }
  }

  // 2. Resolve the baseline commit and diff the backend folder against HEAD.
  console.log(`🔍 Checking for changes in the '${amplifyFolder}' folder...`);
  const baseline = resolveBaseline();
  if (baseline.deploy) {
    console.log(`ℹ️ ${baseline.reason}`);
    return runDeploy(args);
  }
  console.log(`   Comparing HEAD against ${baseline.source}.`);

  let hasChanges;
  try {
    // `git diff A B -- path` compares the two trees directly (no merge-base), so
    // this captures every change to amplifyFolder since the last deployment.
    execFileSync('git', ['diff', '--quiet', baseline.ref, 'HEAD', '--', amplifyFolder], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    hasChanges = false;
  } catch (error) {
    if (error.status === 1) {
      hasChanges = true; // differences found
    } else {
      console.warn(`⚠️ Warning: git diff failed (status ${error.status}). Assuming changes exist.`);
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    console.log(`✅ No changes detected in '${amplifyFolder}' since the last deployment. Skipping backend deployment...`);
    generateOutputs();
    process.exit(0);
  }

  console.log(`🚧 Changes detected in '${amplifyFolder}'. Running deployment command...`);
  runDeploy(args);
}

main().catch((err) => {
  console.error(`❌ An unexpected error occurred: ${err.message}`);
  process.exit(1);
});
