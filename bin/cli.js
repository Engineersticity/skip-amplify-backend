#!/usr/bin/env node

const { execSync, spawn } = require('child_process');

function runCommand(command) {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    if (error.status !== null) {
      return error.status.toString();
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: skip-amplify-backend <command to run if changes detected>');
    process.exit(1);
  }

  const amplifyFolder = 'amplify';

  try {
    // 1. Ensure git history if shallow clone
    const isShallow = runCommand('git rev-parse --is-shallow-repository');
    if (isShallow === 'true') {
      console.log('📦 Shallow repository detected. Fetching git history to compare previous commit...');
      try {
        execSync('git fetch --depth=2', { stdio: 'inherit' });
      } catch (e) {
        console.warn('⚠️ Warning: Failed to fetch deeper history. The diff check might skip or fail if history is missing.');
      }
    }

    // 2. Check for diffs between the current commit and the previous commit in the amplify folder
    // 'git diff --quiet HEAD^ HEAD -- amplify'
    // Returns 0 if there are no differences. 
    // Returns 1 if differences are found.
    console.log(`🔍 Checking for changes in the '${amplifyFolder}' folder...`);
    let diffStatus;
    try {
      execSync(`git diff --quiet HEAD^ HEAD -- ${amplifyFolder}`, { stdio: 'ignore' });
      diffStatus = 0;
    } catch (error) {
      if (error.status === 1) {
        diffStatus = 1; // Changes found
      } else {
        // e.g. status 128 if HEAD^ doesn't exist (initial commit situation)
        console.warn('⚠️ Warning: Failed to compare with HEAD^. Assuming changes exist.');
        diffStatus = 1;
      }
    }

    if (diffStatus === 0) {
      console.log(`✅ No changes detected in '${amplifyFolder}'. Skipping backend deployment...`);
      process.exit(0);
    }

    console.log(`🚧 Changes detected in '${amplifyFolder}'. Running deployment command...`);
    
    // 3. Spawn the user-provided command
    const [command, ...commandArgs] = args;
    
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      shell: true
    });

    child.on('close', (code) => {
      process.exit(code || 0);
    });

    child.on('error', (err) => {
      console.error(`❌ Failed to start command: ${err.message}`);
      process.exit(1);
    });

  } catch (err) {
    console.error(`❌ An unexpected error occurred: ${err.message}`);
    process.exit(1);
  }
}

main();
