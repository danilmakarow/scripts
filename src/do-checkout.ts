#!/usr/bin/env node
/**
 * docheckout — stage, commit, and push the current working tree.
 *
 * If invoked while sitting on `master`/`main`, asks Claude Haiku to suggest a
 * branch name + commit message based on the diff, creates that branch, then
 * commits + pushes it. Otherwise just commits + pushes to the current branch.
 *
 * Usage:
 *   docheckout
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required, used for the Claude Haiku call.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import Anthropic from '@anthropic-ai/sdk';

import { log } from './common/logger';
import { runCommand } from './common/command-runner';
import { runScript, runStep, reportError, fmt } from './common/tui/index';
import { consumeDebugFlag } from './common/cli-flags';
import { loadEnv, validateEnv } from './common/env';
import { SuggestionError } from './common/errors';
import { printUsage } from './common/usage';
import {
  assertGitRepo,
  getCurrentBranch,
  hasChanges,
  isMasterBranch,
} from './common/git-utils';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env that sits next to the bundled script
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_DIFF_CHARS = 60_000;
const MAX_BRANCH_FALLBACK_ATTEMPTS = 9;
const BRANCH_NAME_REGEX = /^[a-z]+\/[a-z0-9-]+$/;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface AppEnv {
  readonly ANTHROPIC_API_KEY: string;
}

interface CommitSuggestion {
  readonly commitMessage: string;
  readonly branchName?: string;
}

// ─────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────
const env = validateEnv<AppEnv>({
  ANTHROPIC_API_KEY: ['required', 'string', { min_length: 1 }],
});

// ─────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────
/** Conventional Commits system prompt shared with do-commit. */
const buildSystemPrompt = (): string =>
  [
    'You are a senior engineer writing Conventional Commits messages.',
    '',
    'Rules:',
    '- Subject line: <type>(<optional-scope>): <imperative summary>',
    '- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    '- Subject MUST be ≤ 72 characters, lowercase first letter after the colon, no trailing period.',
    '- Use the imperative mood ("add" not "added"/"adds").',
    '- Optional body: blank line, then 1–4 short bullet points (each starting with "- ") explaining the why.',
    '- Never invent changes that are not in the diff. Stay faithful to what was actually modified.',
    '- Output PLAIN TEXT for the commit message (no markdown fences, no quotes around it).',
  ].join('\n');

/** User-facing prompt asking for JSON when on master, plain commit message otherwise. */
const buildUserPrompt = (diff: string, includeBranchName: boolean): string => {
  const truncated = diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`
    : diff;

  if (!includeBranchName) {
    return [
      'Below is the staged git diff. Reply with ONLY a JSON object of shape:',
      '{ "commitMessage": "<conventional-commits message, possibly multi-line>" }',
      'No prose, no code fences, no surrounding text — just the JSON.',
      '',
      '--- diff ---',
      truncated,
    ].join('\n');
  }

  return [
    'Below is the staged git diff. Reply with ONLY a JSON object of shape:',
    '{',
    '  "branchName": "<type>/<kebab-case-summary>",',
    '  "commitMessage": "<conventional-commits message, possibly multi-line>"',
    '}',
    '',
    'branchName rules:',
    '- Must match the regex ^[a-z]+\\/[a-z0-9-]+$',
    '- The leading <type> must be the SAME conventional commit type used in the commit subject',
    '  (e.g. feat, fix, refactor, chore, docs, ...).',
    '- Use kebab-case for the summary portion: lowercase letters, digits, dashes only.',
    '- Keep the summary 2–6 words, intention-revealing, no abbreviations.',
    '- Examples: feat/add-export-csv, fix/null-deref-in-parser, refactor/extract-runner.',
    '',
    'No prose, no code fences, no surrounding text — just the JSON.',
    '',
    '--- diff ---',
    truncated,
  ].join('\n');
};

// ─────────────────────────────────────────────────────────────
// Anthropic helpers
// ─────────────────────────────────────────────────────────────
/** Strips ```json fences and surrounding whitespace from a model response. */
const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
};

/** Defensive JSON.parse that accepts stray prose around the JSON object. */
const parseJsonObject = (raw: string): Record<string, unknown> => {
  const stripped = stripCodeFences(raw);
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to brace-extraction below
  }

  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = stripped.slice(firstBrace, lastBrace + 1);
    const parsed: unknown = JSON.parse(slice);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  throw new Error('Model did not return a JSON object');
};

/** Pulls all `text` fields out of an Anthropic message response and joins them. */
const collectMessageText = (blocks: ReadonlyArray<{ type: string; text?: string }>): string => {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
};

/**
 * Calls Claude Haiku once with the staged diff and returns a validated
 * suggestion object. When `includeBranchName` is true the response must
 * include a kebab-case `<type>/<slug>` branch name.
 */
const requestSuggestion = async (
  apiKey: string,
  diff: string,
  includeBranchName: boolean,
): Promise<CommitSuggestion> => {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: HAIKU_MODEL_ID,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(diff, includeBranchName),
      },
    ],
  });

  const rawText = collectMessageText(response.content);
  if (!rawText.trim()) {
    throw new Error('Claude returned an empty response');
  }

  const parsed = parseJsonObject(rawText);
  const commitMessage = typeof parsed.commitMessage === 'string' ? parsed.commitMessage.trim() : '';
  if (commitMessage.length === 0) {
    throw new Error('Model response missing required field "commitMessage"');
  }

  if (!includeBranchName) return { commitMessage };

  const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : '';
  if (branchName.length === 0) {
    throw new Error('Model response missing required field "branchName"');
  }
  if (!BRANCH_NAME_REGEX.test(branchName)) {
    throw new Error(
      `Suggested branch name "${branchName}" does not match required pattern <type>/<kebab-slug>`,
    );
  }

  return { commitMessage, branchName };
};

// ─────────────────────────────────────────────────────────────
// Git helpers (script-local — generic helpers live in common/git-utils.ts)
// ─────────────────────────────────────────────────────────────
/** Captures the staged diff at `cwd`. Returns an empty string if nothing is staged. */
const captureStagedDiff = async (cwd: string): Promise<string> => {
  const result = await execa('git', ['diff', '--cached'], { cwd });
  return typeof result.stdout === 'string' ? result.stdout : '';
};

/** Returns true if the local branch already exists at `cwd`. */
const localBranchExists = async (cwd: string, branchName: string): Promise<boolean> => {
  const result = await execa(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    { cwd, reject: false },
  );
  return result.exitCode === 0;
};

/**
 * Picks a branch name that is not already a local branch, suffixing `-2`,
 * `-3`, ... up to `-${MAX_BRANCH_FALLBACK_ATTEMPTS + 1}`. Throws (with a
 * SuggestionError) if every candidate is taken.
 */
const resolveAvailableBranchName = async (cwd: string, baseName: string): Promise<string> => {
  if (!(await localBranchExists(cwd, baseName))) return baseName;

  const tried: string[] = [baseName];
  for (let suffix = 2; suffix <= MAX_BRANCH_FALLBACK_ATTEMPTS + 1; suffix += 1) {
    const candidate = `${baseName}-${suffix}`;
    tried.push(candidate);
    if (!(await localBranchExists(cwd, candidate))) {
      log.warning(`Branch "${baseName}" already exists locally, using "${candidate}" instead`);
      return candidate;
    }
  }

  throw new SuggestionError(
    `Branch "${baseName}" and ${MAX_BRANCH_FALLBACK_ATTEMPTS} suffixed variants all already exist locally.`,
    {
      suggestionLabel: 'Tried:',
      suggestions: tried,
    },
  );
};

/** Writes `message` to a fresh temp file and returns its absolute path. */
const writeCommitMessageFile = (message: string): string => {
  const filePath = path.join(
    os.tmpdir(),
    `docheckout-commit-${process.pid}-${Date.now()}.txt`,
  );
  fs.writeFileSync(filePath, message.endsWith('\n') ? message : `${message}\n`, 'utf-8');
  return filePath;
};

/** Returns the first non-empty line of `message` (i.e. the subject). */
const extractCommitSubject = (message: string): string => {
  for (const line of message.split('\n')) {
    if (line.trim().length > 0) return line.trim();
  }
  return message.trim();
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the docheckout usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'docheckout',
    description: 'Stage, commit, and push the current working tree (creates a branch off master/main).',
    usage: 'docheckout',
    examples: [
      { command: 'docheckout', comment: '# from any branch with pending changes' },
    ],
    steps: [
      'Verify cwd is a git repo with pending changes',
      'Stage everything (git add -A)',
      'Ask Claude Haiku for a commit message (and a branch name when on master/main)',
      'Create the branch (master/main only), commit, and push',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: validates state, drafts the commit, and pushes. */
const main = async (): Promise<void> => {
  // Consume the global -d/--debug flag before parsing this script's own args.
  consumeDebugFlag();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    showUsage();
    process.exit(0);
  }

  const cwd = process.cwd();

  // ── Phase 1: Sanity checks ──
  await assertGitRepo(cwd);

  if (!(await hasChanges(cwd))) {
    log.info('Working tree is clean — nothing to commit.');
    process.exit(0);
  }

  const currentBranch = await getCurrentBranch(cwd);
  const wasOnMaster = isMasterBranch(currentBranch);
  const subtitle =
    fmt`${cwd} · ${currentBranch}` + (wasOnMaster ? ' · will create new branch' : '');

  await runScript({ name: 'docheckout', subtitle }, async () => {
    // ── Phase 2: Stage & capture diff ──
    await runCommand('git add -A', { cwd, description: 'Staging all changes', doneDescription: 'Staged all changes' });

    const diff = await captureStagedDiff(cwd);
    if (diff.trim().length === 0) {
      log.info('No staged changes after `git add -A` — nothing to commit.');
      process.exit(0);
    }

    // ── Phase 3: Ask Claude Haiku for a commit message (+ branch name) ──
    const aiLabel = wasOnMaster
      ? { active: fmt`Asking ${HAIKU_MODEL_ID} for a branch name + commit message`, done: fmt`Generated branch name + commit message via ${HAIKU_MODEL_ID}` }
      : { active: fmt`Asking ${HAIKU_MODEL_ID} for a commit message`, done: fmt`Generated commit message via ${HAIKU_MODEL_ID}` };
    const suggestion = await runStep(aiLabel, async () =>
      requestSuggestion(env.ANTHROPIC_API_KEY, diff, wasOnMaster),
    );

    const commitSubject = extractCommitSubject(suggestion.commitMessage);
    log.success(fmt`Commit subject: ${commitSubject}`);
    if (suggestion.branchName) {
      log.success(fmt`Suggested branch: ${suggestion.branchName}`);
    }

    // ── Phase 4: Branch (when on master) ──
    let targetBranch = currentBranch;
    if (wasOnMaster) {
      const desiredName = suggestion.branchName;
      if (!desiredName) {
        throw new Error('Internal error: missing branch name suggestion while on master');
      }
      targetBranch = await resolveAvailableBranchName(cwd, desiredName);
      await runCommand(`git checkout -b ${targetBranch}`, {
        cwd,
        description: fmt`Creating branch ${targetBranch}`,
        doneDescription: fmt`Created branch ${targetBranch}`,
      });
    }

    // ── Phase 5: Commit ──
    const messageFile = writeCommitMessageFile(suggestion.commitMessage);
    try {
      await runCommand(`git commit -F ${JSON.stringify(messageFile)}`, {
        cwd,
        description: 'Creating commit',
        doneDescription: 'Created commit',
      });
    } finally {
      try {
        fs.unlinkSync(messageFile);
      } catch {
        // best-effort cleanup; the OS will reap tmpdir eventually
      }
    }

    // ── Phase 6: Push ──
    if (wasOnMaster) {
      await runCommand(`git push -u origin ${targetBranch}`, {
        cwd,
        description: fmt`Pushing ${targetBranch} to origin`,
        doneDescription: fmt`Pushed ${targetBranch} to origin`,
      });
    } else {
      await runCommand('git push', {
        cwd,
        description: fmt`Pushing ${targetBranch} to origin`,
        doneDescription: fmt`Pushed ${targetBranch} to origin`,
      });
    }

    log.success(fmt`Pushed ${targetBranch} — ${commitSubject}`);
  });
};

// ─────────────────────────────────────────────────────────────
// Error reporter (pre-flight only; in-run failures are reported by runScript)
// ─────────────────────────────────────────────────────────────
main().catch(reportError);
