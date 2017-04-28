'use strict';

const Git = require('nodegit');
const rimraf = require('rimraf');
const ncp = require('ncp').ncp;
const { 
  existsSync,
} = require('fs');
const exec = require('child_process').exec;
const {
  join,
} = require('path');

const reactUrl = 'https://github.com/facebook/react.git';

function cleanDir() {
  return new Promise(_resolve => rimraf('remote-repo', _resolve));
}

function executeCommand(command) {
  return new Promise(_resolve => exec(command, (error) => {
    if (!error) {
      _resolve();
    } else {
      console.error(error);
      process.exit(1);
    }
  }));
}

function asyncCopyTo(from, to) {
  return new Promise(_resolve => {
    ncp(from, to, error => {
      if (error) {
        console.error(error);
        process.exit(1);
      }
      _resolve();
    });
  });
}

function getDefaultReactPath() {
  return join(__dirname, 'remote-repo');
}

async function buldAllBundles(reactPath = getDefaultReactPath()) {
  // build the react FB bundles in the build
  await executeCommand(`cd ${reactPath} && yarn && yarn build`);
}

async function buildBenchmark(reactPath = getDefaultReactPath(), benchmark) {
  // get the build.js from the benchmark directory and execute it
  await require(
    join(__dirname, 'benchmarks', benchmark, 'build.js')
  )(reactPath, asyncCopyTo);
}

function getBundleResults(reactPath = getDefaultReactPath()) {
  return require(join(reactPath, 'scripts', 'rollup', 'results.json'));
}

async function getMergeBaseFromLocalGitRepo(localRepo) {
  const repo = await Git.Repository.open(localRepo);
  return await Git.Merge.base(
    repo,
    await repo.getHeadCommit(),
    await repo.getBranchCommit('master')
  );
}

async function buildBenchmarkBundlesFromGitRepo(commitId, skipBuild, url = reactUrl, clean) {
  let repo;
  const remoteRepoDir = getDefaultReactPath();

  if (!skipBuild) {
    if (clean) {
      //clear remote-repo folder
      await cleanDir(remoteRepoDir);
    }
    // check if remote-repo diretory already exists
    if (existsSync(join(__dirname, 'remote-repo'))) {
      repo = await Git.Repository.open(remoteRepoDir);
      // fetch all the latest remote changes
      await repo.fetchAll();
    } else {
      // if not, clone the repo to remote-repo folder
      repo = await Git.Clone(url, remoteRepoDir);
    }
    let commit;
    if (!commitId || commitId === 'master') {
      // if we don't have a commitId, we assume to use master
      commit = await repo.getBranchCommit('master');
    } else {
      // as the commitId probably came from our local repo
      // we use it to lookup the right commit in our remote repo
      commit = await Git.Commit.lookup(repo, commitId);
    }
    // reset hard to this commit
    await Git.Reset.reset(repo, commit, Git.Reset.TYPE.HARD);
    await buildAllBundles();
  }
  return getBundleResults();
}

async function buildAllBundles(reactPath, skipBuild) {
  if (!skipBuild) {
    // build all bundles so we can get all stats and use bundles for benchmarks
    await buldAllBundles(reactPath);
  }
  return getBundleResults(reactPath);
}

// if run directly via CLI
if (require.main === module) {
  buildBenchmarkBundlesFromGitRepo();
}

module.exports = {
  buildAllBundles,
  buildBenchmark,
  buildBenchmarkBundlesFromGitRepo,
  getMergeBaseFromLocalGitRepo,
};
