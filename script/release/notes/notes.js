#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GitProcess } = require('dugite');
const octokit = require('@octokit/rest')({
  auth: process.env.ELECTRON_GITHUB_TOKEN
});
const semver = require('semver');

const { ELECTRON_VERSION, SRC_DIR } = require('../../lib/utils');

const MAX_FAIL_COUNT = 3;
const CHECK_INTERVAL = 5000;

const CACHE_DIR = path.resolve(__dirname, '.cache');
const NO_NOTES = 'No notes';
const FOLLOW_REPOS = ['electron/electron', 'electron/node'];

const breakTypes = new Set(['breaking-change']);
const docTypes = new Set(['doc', 'docs']);
const featTypes = new Set(['feat', 'feature']);
const fixTypes = new Set(['fix']);
const otherTypes = new Set(['spec', 'build', 'test', 'chore', 'deps', 'refactor', 'tools', 'vendor', 'perf', 'style', 'ci']);
const knownTypes = new Set([...breakTypes.keys(), ...docTypes.keys(), ...featTypes.keys(), ...fixTypes.keys(), ...otherTypes.keys()]);

/**
***
**/

// link to a GitHub item, e.g. an issue or pull request
class GHKey {
  constructor (owner, repo, number) {
    this.owner = owner;
    this.repo = repo;
    this.number = number;
  }
}

/*
class Commit {
  body? string;
  breakingChange? boolean = false;
  hash: string;
  issueNumber? number;
  note? string;
  originalSubject? string;
  prKey? GHKey;
  revertHash? string;
  subject? string;
  type? string;
}
*/

const runGit = async (dir, args) => {
  const response = await GitProcess.exec(args, dir);
  if (response.exitCode !== 0) {
    throw new Error(response.stderr.trim());
  }
  return response.stdout.trim();
};

const getCommonAncestor = async (dir, point1, point2) => {
  return runGit(dir, ['merge-base', point1, point2]);
};

const getNoteFromClerk = async (ghKey) => {
  const comments = await getComments(ghKey);
  if (!comments || !comments.data) return;

  const CLERK_LOGIN = 'release-clerk[bot]';
  const CLERK_NO_NOTES = '**No Release Notes**';
  const PERSIST_LEAD = '**Release Notes Persisted**\n\n';
  const QUOTE_LEAD = '> ';

  for (const comment of comments.data.reverse()) {
    if (comment.user.login !== CLERK_LOGIN) {
      continue;
    }
    if (comment.body === CLERK_NO_NOTES) {
      return NO_NOTES;
    }
    if (comment.body.startsWith(PERSIST_LEAD)) {
      return comment.body
        .slice(PERSIST_LEAD.length).trim() // remove PERSIST_LEAD
        .split('\r?\n') // break into lines
        .map(line => line.trim())
        .filter(line => line.startsWith(QUOTE_LEAD)) // notes are quoted
        .map(line => line.slice(QUOTE_LEAD.length)) // unquote the lines
        .join(' ') // join the note lines
        .trim();
    }
  }
};

// copied from https://github.com/electron/clerk/blob/master/src/index.ts#L4-L13
const OMIT_FROM_RELEASE_NOTES_KEYS = [
  'no-notes',
  'no notes',
  'no_notes',
  'none',
  'no',
  'nothing',
  'empty',
  'blank'
];

const getNoteFromBody = body => {
  if (!body) {
    return null;
  }

  const NOTE_PREFIX = 'Notes: ';
  const NOTE_HEADER = '#### Release Notes';

  let note = body
    .split(/\r?\n\r?\n/) // split into paragraphs
    .map(paragraph => paragraph.trim())
    .map(paragraph => paragraph.startsWith(NOTE_HEADER) ? paragraph.slice(NOTE_HEADER.length).trim() : paragraph)
    .find(paragraph => paragraph.startsWith(NOTE_PREFIX));

  if (note) {
    note = note
      .slice(NOTE_PREFIX.length)
      .replace(/<!--.*-->/, '') // '<!-- change summary here-->'
      .replace(/\r?\n/, ' ') // remove newlines
      .trim();
  }

  if (note && OMIT_FROM_RELEASE_NOTES_KEYS.includes(note.toLowerCase())) {
    return NO_NOTES;
  }

  return note;
};

/**
 * Looks for our project's conventions in the commit message:
 *
 * 'semantic: some description' -- sets type, subject
 * 'some description (#99999)' -- sets subject, pr
 * 'Fixes #3333' -- sets issueNumber
 * 'Merge pull request #99999 from ${branchname}' -- sets pr
 * 'This reverts commit ${sha}' -- sets revertHash
 * line starting with 'BREAKING CHANGE' in body -- sets breakingChange
 * 'Backport of #99999' -- sets pr
 */
const parseCommitMessage = (commitMessage, owner, repo, commit = {}) => {
  // split commitMessage into subject & body
  let subject = commitMessage;
  let body = '';
  const pos = subject.indexOf('\n');
  if (pos !== -1) {
    body = subject.slice(pos).trim();
    subject = subject.slice(0, pos).trim();
  }

  if (!commit.originalSubject) {
    commit.originalSubject = subject;
  }

  if (body) {
    commit.body = body;

    const note = getNoteFromBody(body);
    if (note) { commit.note = note; }
  }

  // if the subject ends in ' (#dddd)', treat it as a pull request id
  let match;
  if ((match = subject.match(/^(.*)\s\(#(\d+)\)$/))) {
    commit.prKey = new GHKey(owner, repo, parseInt(match[2]));
    subject = match[1];
  }

  // if the subject begins with 'word:', treat it as a semantic commit
  if ((match = subject.match(/^(\w+):\s(.*)$/))) {
    const type = match[1].toLocaleLowerCase();
    if (knownTypes.has(type)) {
      commit.type = type;
      subject = match[2];
    }
  }

  // Check for GitHub commit message that indicates a PR
  if (!commit.prKey && ((match = subject.match(/^Merge pull request #(\d+) from (.*)$/)))) {
    commit.prKey = new GHKey(owner, repo, parseInt(match[1]));
  }

  // Check for a comment that indicates a PR
  const backportPattern = /(?:^|\n)(?:manual |manually )?backport.*(?:#(\d+)|\/pull\/(\d+))/im;
  if (!commit.prKey && ((match = commitMessage.match(backportPattern)))) {
    // This might be the first or second capture group depending on if it's a link or not.
    const backportNumber = match[1] ? parseInt(match[1], 10) : parseInt(match[2], 10);
    commit.prKey = new GHKey(owner, repo, backportNumber);
  }

  // https://help.github.com/articles/closing-issues-using-keywords/
  if ((match = subject.match(/\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|for)\s#(\d+)\b/))) {
    commit.issueNumber = parseInt(match[1]);
    if (!commit.type) {
      commit.type = 'fix';
    }
  }

  // look for 'fixes' in markdown; e.g. 'Fixes [#8952](https://github.com/electron/electron/issues/8952)'
  if (!commit.issueNumber && ((match = commitMessage.match(/Fixes \[#(\d+)\]\(https:\/\/github.com\/(\w+)\/(\w+)\/issues\/(\d+)\)/)))) {
    commit.issueNumber = parseInt(match[1]);
    if (commit.prKey && commit.prKey.number === commit.issueNumber) {
      delete commit.prKey;
    }
    if (!commit.type) {
      commit.type = 'fix';
    }
  }

  // https://www.conventionalcommits.org/en
  if (commitMessage
    .split(/\r?\n/) // split into lines
    .map(line => line.trim())
    .some(line => line.startsWith('BREAKING CHANGE'))) {
    commit.type = 'breaking-change';
  }

  // Check for a reversion commit
  if ((match = body.match(/This reverts commit ([a-f0-9]{40})\./))) {
    commit.revertHash = match[1];
  }

  commit.subject = subject.trim();
  return commit;
};

const getLocalCommitHashes = async (dir, ref) => {
  const args = ['log', '-z', '--format=%H', ref];
  return (await runGit(dir, args)).split('\0').map(hash => hash.trim());
};

/*
 * possible properties:
 * breakingChange, hash, issueNumber, originalSubject,
 * pr { owner, repo, number, branch }, revertHash, subject, type
 */
const getLocalCommitDetails = async (module, point1, point2) => {
  const { owner, repo, dir } = module;

  const fieldSep = '||';
  const format = ['%H', '%B'].join(fieldSep);
  const args = ['log', '-z', '--cherry-pick', '--right-only', '--first-parent', `--format=${format}`, `${point1}..${point2}`];
  const commits = (await runGit(dir, args)).split('\0').map(field => field.trim());
  const details = [];
  for (const commit of commits) {
    if (!commit) {
      continue;
    }
    const [hash, commitMessage] = commit.split(fieldSep, 2).map(field => field.trim());
    details.push(parseCommitMessage(commitMessage, owner, repo, { hash, owner, repo }));
  }
  return details;
};

const checkCache = async (name, operation) => {
  const filename = path.resolve(CACHE_DIR, name);
  if (fs.existsSync(filename)) {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  const response = await operation();
  if (response) {
    fs.writeFileSync(filename, JSON.stringify(response));
  }
  return response;
};

// helper function to add some resiliency to volatile GH api endpoints
async function runRetryable (fn, maxRetries) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      await new Promise((resolve, reject) => setTimeout(resolve, CHECK_INTERVAL));
      lastError = error;
    }
  }
  // Silently eat 404s.
  if (lastError.status !== 404) throw lastError;
}

const getPullRequest = async (ghKey) => {
  const { number, owner, repo } = ghKey;
  const name = `${owner}-${repo}-pull-${number}`;
  const retryableFunc = () => octokit.pulls.get({ pull_number: number, owner, repo });
  return checkCache(name, () => runRetryable(retryableFunc, MAX_FAIL_COUNT));
};

const getComments = async (ghKey) => {
  const { number, owner, repo } = ghKey;
  const name = `${owner}-${repo}-issue-${number}-comments`;
  const retryableFunc = () => octokit.issues.listComments({ issue_number: number, owner, repo, per_page: 100 });
  return checkCache(name, () => runRetryable(retryableFunc, MAX_FAIL_COUNT));
};

const addRepoToPool = async (pool, repo, from, to) => {
  const commonAncestor = await getCommonAncestor(repo.dir, from, to);
  const oldHashes = await getLocalCommitHashes(repo.dir, from);
  oldHashes.forEach(hash => { pool.processedHashes.add(hash); });
  const commits = await getLocalCommitDetails(repo, commonAncestor, to);
  pool.commits.push(...commits);
};

/***
****  Other Repos
***/

// other repos - gn

const getDepsVariable = async (ref, key) => {
  // get a copy of that reference point's DEPS file
  const deps = await runGit(ELECTRON_VERSION, ['show', `${ref}:DEPS`]);
  const filename = path.resolve(os.tmpdir(), 'DEPS');
  fs.writeFileSync(filename, deps);

  // query the DEPS file
  const response = childProcess.spawnSync(
    'gclient',
    ['getdep', '--deps-file', filename, '--var', key],
    { encoding: 'utf8' }
  );

  // cleanup
  fs.unlinkSync(filename);
  return response.stdout.trim();
};

const getDependencyCommitsGN = async (pool, fromRef, toRef) => {
  const repos = [{ // just node
    owner: 'electron',
    repo: 'node',
    dir: path.resolve(SRC_DIR, 'third_party', 'electron_node'),
    deps_variable_name: 'node_version'
  }];

  for (const repo of repos) {
    // the 'DEPS' file holds the dependency reference point
    const key = repo.deps_variable_name;
    const from = await getDepsVariable(fromRef, key);
    const to = await getDepsVariable(toRef, key);
    await addRepoToPool(pool, repo, from, to);
  }
};

// Changes are interesting if they make a change relative to a previous
// release in the same series. For example if you fix a Y.0.0 bug, that
// should be included in the Y.0.1 notes even if it's also tropped back
// to X.0.1.
//
// The phrase 'previous release' is important: if this is the first
// prerelease or first stable release in a series, we omit previous
// branches' changes. Otherwise we will have an overwhelmingly long
// list of mostly-irrelevant changes.
const shouldIncludeMultibranchChanges = (version) => {
  let show = true;

  if (semver.valid(version)) {
    const prerelease = semver.prerelease(version);
    show = prerelease
      ? parseInt(prerelease.pop()) > 1
      : semver.patch(version) > 0;
  }

  return show;
};

/***
****  Main
***/

const getNotes = async (fromRef, toRef, newVersion) => {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
  }

  const pool = {
    processedHashes: new Set(),
    commits: []
  };

  // get the electron/electron commits
  const electron = { owner: 'electron', repo: 'electron', dir: ELECTRON_VERSION };
  await addRepoToPool(pool, electron, fromRef, toRef);

  // Don't include submodules if comparing across major versions;
  // there's just too much churn otherwise.
  const includeDeps = semver.valid(fromRef) &&
                      semver.valid(toRef) &&
                      semver.major(fromRef) === semver.major(toRef);

  if (includeDeps) {
    await getDependencyCommitsGN(pool, fromRef, toRef);
  }

  // remove any old commits
  pool.commits = pool.commits.filter(commit => !pool.processedHashes.has(commit.hash));

  // if a commmit _and_ revert occurred in the unprocessed set, skip them both
  for (const commit of pool.commits) {
    const revertHash = commit.revertHash;
    if (!revertHash) {
      continue;
    }

    const revert = pool.commits.find(commit => commit.hash === revertHash);
    if (!revert) {
      continue;
    }

    commit.note = NO_NOTES;
    revert.note = NO_NOTES;
    pool.processedHashes.add(commit.hash);
    pool.processedHashes.add(revertHash);
  }

  // scrape PRs for release note 'Notes:' comments
  for (const commit of pool.commits) {
    let { prKey } = commit;

    let prSubject;
    while (prKey && !commit.note) {
      const note = await getNoteFromClerk(prKey);
      if (note) {
        commit.note = note;
      }

      // if we already have all the data we need, stop scraping the PRs
      if (commit.note && commit.type && prSubject) {
        break;
      }

      const prData = await getPullRequest(prKey);
      if (!prData || !prData.data) {
        break;
      }

      // try to pull a release note from the pull comment
      const prParsed = parseCommitMessage(`${prData.data.title}\n\n${prData.data.body}`, prKey.owner, prKey.repo);
      if (!commit.note) {
        commit.note = prParsed.note;
      }
      if (!commit.type || prParsed.type === 'breaking-change') {
        commit.type = prParsed.type;
      }
      prSubject = prSubject || prParsed.subject;

      prKey = prParsed.prKey && (prParsed.prKey.number !== prKey.number) ? prParsed.prKey : null;
    }

    // if we still don't have a note, it's because someone missed a 'Notes:
    // comment in a PR somewhere... use the PR subject as a fallback.
    commit.note = commit.note || prSubject;
  }

  // remove non-user-facing commits
  pool.commits = pool.commits
    .filter(commit => commit.note !== NO_NOTES)
    .filter(commit => !((commit.note || commit.subject).match(/^[Bb]ump v\d+\.\d+\.\d+/)));

  if (!shouldIncludeMultibranchChanges(newVersion)) {
    // load all the prDatas
    await Promise.all(
      pool.commits.map(commit => (async () => {
        if (commit.prKey) {
          const prData = await getPullRequest(commit.prKey);
          if (prData) {
            commit.prData = prData;
          }
        }
      })())
    );

    // remove items that already landed in a previous major/minor series
    pool.commits = pool.commits
      .filter(commit => {
        if (!commit.prData) {
          return true;
        }
        const reducer = (accumulator, current) => {
          if (!semver.valid(accumulator)) { return current; }
          if (!semver.valid(current)) { return accumulator; }
          return semver.lt(accumulator, current) ? accumulator : current;
        };
        const earliestRelease = commit.prData.data.labels
          .map(label => label.name.match(/merged\/(\d+)-(\d+)-x/))
          .filter(label => !!label)
          .map(label => `${label[1]}.${label[2]}.0`)
          .reduce(reducer, null);
        if (!semver.valid(earliestRelease)) {
          return true;
        }
        return semver.diff(earliestRelease, newVersion).includes('patch');
      });
  }

  pool.commits = removeSupercededChromiumUpdates(pool.commits);

  const notes = {
    breaking: [],
    docs: [],
    feat: [],
    fix: [],
    other: [],
    unknown: [],
    name: newVersion
  };

  pool.commits.forEach(commit => {
    const str = commit.type;
    if (!str) {
      notes.unknown.push(commit);
    } else if (breakTypes.has(str)) {
      notes.breaking.push(commit);
    } else if (docTypes.has(str)) {
      notes.docs.push(commit);
    } else if (featTypes.has(str)) {
      notes.feat.push(commit);
    } else if (fixTypes.has(str)) {
      notes.fix.push(commit);
    } else if (otherTypes.has(str)) {
      notes.other.push(commit);
    } else {
      notes.unknown.push(commit);
    }
  });

  return notes;
};

const removeSupercededChromiumUpdates = (commits) => {
  const chromiumRegex = /^Updated Chromium to \d+\.\d+\.\d+\.\d+/;
  const updates = commits.filter(commit => (commit.note || commit.subject).match(chromiumRegex));
  const keepers = commits.filter(commit => !updates.includes(commit));

  // keep the newest update.
  if (updates.length) {
    updates.sort((a, b) => a.prKey.number - b.prKey.number);
    keepers.push(updates.pop());
  }

  return keepers;
};

/***
****  Render
***/

const renderLink = (commit, explicitLinks) => {
  let link;
  if (commit.prKey) {
    const { owner, repo, number } = commit.prKey;
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    const text = owner === 'electron' && repo === 'electron'
      ? `#${number}`
      : `${owner}/${repo}#${number}`;
    link = explicitLinks ? `[${text}](${url})` : text;
  } else {
    const { owner, repo, hash } = commit;
    const url = `https://github.com/${owner}/${repo}/commit/${hash}`;
    const text = owner === 'electron' && repo === 'electron'
      ? `${hash.slice(0, 8)}`
      : `${owner}/${repo}@${hash.slice(0, 8)}`;
    link = explicitLinks ? `[${text}](${url})` : text;
  }
  return link;
};

const renderCommit = (commit, explicitLinks) => {
  // clean up the note
  let note = commit.note || commit.subject;
  note = note.trim();
  if (note.length !== 0) {
    note = note[0].toUpperCase() + note.substr(1);

    if (!note.endsWith('.')) {
      note = note + '.';
    }

    const commonVerbs = {
      Added: ['Add'],
      Backported: ['Backport'],
      Cleaned: ['Clean'],
      Disabled: ['Disable'],
      Ensured: ['Ensure'],
      Exported: ['Export'],
      Fixed: ['Fix', 'Fixes'],
      Handled: ['Handle'],
      Improved: ['Improve'],
      Made: ['Make'],
      Removed: ['Remove'],
      Repaired: ['Repair'],
      Reverted: ['Revert'],
      Stopped: ['Stop'],
      Updated: ['Update'],
      Upgraded: ['Upgrade']
    };
    for (const [key, values] of Object.entries(commonVerbs)) {
      for (const value of values) {
        const start = `${value} `;
        if (note.startsWith(start)) {
          note = `${key} ${note.slice(start.length)}`;
        }
      }
    }
  }

  const link = renderLink(commit, explicitLinks);

  return { note, link };
};

const renderNotes = (notes, explicitLinks) => {
  const rendered = [`# Release Notes for ${notes.name}\n\n`];

  const renderSection = (title, commits) => {
    if (commits.length === 0) {
      return;
    }
    const notes = new Map();
    for (const note of commits.map(commit => renderCommit(commit, explicitLinks))) {
      if (!notes.has(note.note)) {
        notes.set(note.note, [note.link]);
      } else {
        notes.get(note.note).push(note.link);
      }
    }
    rendered.push(`## ${title}\n\n`);
    const lines = [];
    notes.forEach((links, key) => lines.push(` * ${key} ${links.map(link => link.toString()).sort().join(', ')}\n`));
    rendered.push(...lines.sort(), '\n');
  };

  renderSection('Breaking Changes', notes.breaking);
  renderSection('Features', notes.feat);
  renderSection('Fixes', notes.fix);
  renderSection('Other Changes', notes.other);

  if (notes.docs.length) {
    const docs = notes.docs.map(commit => renderLink(commit, explicitLinks)).sort();
    rendered.push('## Documentation\n\n', ` * Documentation changes: ${docs.join(', ')}\n`, '\n');
  }

  renderSection('Unknown', notes.unknown);

  return rendered.join('');
};

/***
****  Module
***/

module.exports = {
  get: getNotes,
  render: renderNotes
};
