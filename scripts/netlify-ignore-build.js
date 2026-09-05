'use strict';

const { execFileSync } = require('child_process');
const { decide } = require('./lib/netlify-ignore');

function createGit(cwd = process.cwd()) {
  const run = (args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    changedFiles(base, head) {
      const output = run(['diff', '--name-only', '--no-renames', base, head]).trim();
      return output ? output.split(/\r?\n/) : [];
    },

    show(ref, file) {
      try {
        return run(['show', `${ref}:${file}`]);
      } catch (showError) {
        try {
          run(['cat-file', '-e', `${ref}^{commit}`]);
        } catch (_) {
          throw showError;
        }

        try {
          run(['cat-file', '-e', `${ref}:${file}`]);
        } catch (_) {
          return null;
        }
        throw showError;
      }
    },

    hasCommit(sha) {
      try {
        run(['cat-file', '-e', `${sha}^{commit}`]);
        return true;
      } catch (_) {
        return false;
      }
    },

    fetchCommit(sha) {
      try {
        run(['fetch', '--quiet', '--no-tags', 'origin', sha]);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}

function formatError(error) {
  const message = error && error.message ? error.message : String(error);
  return String(message).replace(/\s+/g, ' ').trim();
}

function main() {
  try {
    const decision = decide({ env: process.env, git: createGit() });
    console.log(`[netlify-ignore] ${decision.skip ? '飛ばす' : 'ビルド'}: ${decision.reason}`);
    process.exitCode = decision.skip ? 0 : 1;
  } catch (error) {
    console.log(`[netlify-ignore] ビルド: 判定中に例外 (${formatError(error)})`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { createGit, main };
