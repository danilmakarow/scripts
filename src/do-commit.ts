#!/usr/bin/env node
/**
 * docommit — stages every change in the current git repo, asks Claude Haiku
 * to write a Conventional Commits message describing the diff, commits it,
 * and pushes to the remote.
 *
 * Usage:
 *   docommit
 *
 * Required env:
 *   ANTHROPIC_API_KEY — Anthropic API key used for the Haiku call.
 *
 * Behaviour summary:
 *   1. Verify cwd is a git repo, bail if not.
 *   2. Bail (exit 0) cleanly when there is nothing to commit.
 *   3. Stage all changes, capture diff, call Haiku for a message.
 *   4. Validate the generated message, then `git commit` + `git push`.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import { log, theme } from './common/logger';
import { runCommand } from './common/command-runner';
import { loadEnv, validateEnv } from './common/env';
import { assertGitRepo, hasChanges } from './common/git-utils';
import { printUsage } from './common/usage';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env that sits next to the bundled script
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
/** The fastest current-gen Anthropic model — used for short commit messages. */
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';

/** Hard cap on how many diff characters we hand to Haiku. */
const MAX_DIFF_CHARS = 80_000;

/** Cap on output tokens from Haiku — commit messages are short. */
const HAIKU_MAX_OUTPUT_TOKENS = 1024;

/** Sanity bound on the first line of the generated commit message. */
const MAX_TITLE_LENGTH = 100;

/** Verbatim system prompt the user requested — do not alter without reason. */
const COMMIT_SYSTEM_PROMPT = [
  'Write the commit message using Conventional Commits:',
  '- Title format: <type>[optional scope]: <description>',
  '- Types: fix (PATCH bump), feat (MINOR bump), build, chore, ci, docs, style, refactor, perf, test',
  '- The most important change drives the title and its type prefix',
  '- Breaking API changes: append ! after the type/scope (e.g. feat!: ...) AND add a footer "BREAKING CHANGE: <description>"',
  '- Any commit type can carry a BREAKING CHANGE footer; outline every breaking change explicitly in the body or footer',
  '- Additional footers may follow git trailer format (e.g. Refs: #123)',
  '- Do NOT include any Co-Authored-By line',
].join('\n');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface AppEnv {
  readonly ANTHROPIC_API_KEY: string;
}

interface DiffPayload {
  readonly status: string;
  readonly diff: string;
  readonly truncated: boolean;
}

// ─────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────
const env = validateEnv<AppEnv>({
  ANTHROPIC_API_KEY: ['required', 'string', { min_length: 1 }],
});

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the docommit usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'docommit',
    description: 'Stage, AI-author a commit message, commit, and push',
    usage: 'docommit',
    examples: [{ command: 'docommit' }],
    steps: [
      'Verify cwd is a git repo with pending changes',
      'Stage everything (git add -A) and capture the diff',
      'Ask Claude Haiku for a Conventional Commits message',
      'Commit and push',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Diff capture
// ─────────────────────────────────────────────────────────────
/**
 * Captures the current `git status --porcelain` and `git diff --cached`
 * output, truncating the diff to `MAX_DIFF_CHARS` if necessary.
 */
const captureDiffPayload = async (cwd: string): Promise<DiffPayload> => {
  const statusResult = await runCommand('git status --porcelain', {
    cwd,
    description: 'Reading git status',
  });
  const diffResult = await runCommand('git diff --cached', {
    cwd,
    description: 'Reading staged diff',
  });

  const status = typeof statusResult.stdout === 'string' ? statusResult.stdout : '';
  const rawDiff = typeof diffResult.stdout === 'string' ? diffResult.stdout : '';

  if (rawDiff.length <= MAX_DIFF_CHARS) {
    return { status, diff: rawDiff, truncated: false };
  }

  log.warning(
    `Diff is ${rawDiff.length.toLocaleString()} chars; truncating to ${MAX_DIFF_CHARS.toLocaleString()} for the model`,
  );
  return { status, diff: rawDiff.slice(0, MAX_DIFF_CHARS), truncated: true };
};

// ─────────────────────────────────────────────────────────────
// Anthropic client (kept inline per spec — do not extract yet)
// ─────────────────────────────────────────────────────────────
/**
 * Builds the user message handed to Haiku. Includes status + diff so the model
 * has both the high-level intent and the full content to summarise.
 */
const buildUserMessage = (payload: DiffPayload): string => {
  const truncationNote = payload.truncated
    ? '\n\nNote: the diff was truncated for length; summarise the visible portion.'
    : '';
  return [
    'Generate a Conventional Commits message for the staged changes below.',
    'Respond with ONLY the commit message text — no preamble, no code fences, no commentary.',
    '',
    'git status --porcelain:',
    payload.status.trim().length > 0 ? payload.status : '(empty)',
    '',
    'git diff --cached:',
    payload.diff.trim().length > 0 ? payload.diff : '(empty)',
    truncationNote,
  ].join('\n');
};

/**
 * Strips any markdown code fences Haiku may wrap its output in (``` or ```text).
 * Returns the unwrapped string verbatim.
 */
const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;

  const lines = trimmed.split('\n');
  if (lines.length < 2) return trimmed;

  const withoutOpening = lines.slice(1);
  const lastLine = withoutOpening[withoutOpening.length - 1] ?? '';
  if (lastLine.trim().startsWith('```')) {
    return withoutOpening.slice(0, -1).join('\n').trim();
  }
  return withoutOpening.join('\n').trim();
};

/**
 * Validates the model's output looks vaguely like a commit message:
 *   - non-empty after trimming
 *   - first line under MAX_TITLE_LENGTH
 *   - no leftover code fences
 *   - no Co-Authored-By line (we don't tag AI commits)
 */
const validateCommitMessage = (message: string): void => {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error('Haiku returned an empty commit message');
  }
  if (trimmed.includes('```')) {
    throw new Error('Haiku response still contains a code fence after stripping');
  }
  if (/co-authored-by:/i.test(trimmed)) {
    throw new Error('Haiku response contains a Co-Authored-By line; refusing');
  }
  const firstLine = trimmed.split('\n', 1)[0];
  if (firstLine.length > MAX_TITLE_LENGTH) {
    throw new Error(
      `Haiku title line is ${firstLine.length} chars (max ${MAX_TITLE_LENGTH}): "${firstLine}"`,
    );
  }
};

/**
 * Calls Claude Haiku for a commit message, strips fences, validates, and
 * returns the cleaned message text.
 */
const generateCommitMessage = async (
  apiKey: string,
  payload: DiffPayload,
): Promise<string> => {
  const client = new Anthropic({ apiKey });

  log.step(`Asking ${theme.highlight(HAIKU_MODEL_ID)} for a commit message`);

  const response = await client.messages.create({
    model: HAIKU_MODEL_ID,
    max_tokens: HAIKU_MAX_OUTPUT_TOKENS,
    system: COMMIT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(payload) }],
  });

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  const raw = textBlocks.map((block) => block.text).join('\n');
  const cleaned = stripCodeFences(raw);
  validateCommitMessage(cleaned);
  return cleaned;
};

// ─────────────────────────────────────────────────────────────
// Commit / push
// ─────────────────────────────────────────────────────────────
/**
 * Writes `message` to a tempfile and runs `git commit -F <tmpfile>` so that
 * multi-line bodies and footers survive verbatim. Cleans the tempfile up.
 */
const commitWithMessage = async (cwd: string, message: string): Promise<void> => {
  const tmpFile = path.join(os.tmpdir(), `docommit-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, `${message.trim()}\n`, 'utf-8');

  try {
    await runCommand(`git commit -F ${JSON.stringify(tmpFile)}`, {
      cwd,
      description: 'Committing',
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
};

/** Renders the generated message inside a labelled block before committing. */
const previewMessage = (message: string): void => {
  log.blank();
  console.log(theme.dim('  Generated commit message:'));
  for (const line of message.trim().split('\n')) {
    console.log(`    ${theme.highlight(line)}`);
  }
  log.blank();
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point — orchestrates validation, AI call, commit, and push. */
const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  const cwd = process.cwd();

  await assertGitRepo(cwd);

  const dirty = await hasChanges(cwd);
  if (!dirty) {
    log.info('Nothing to commit — working tree is clean.');
    return;
  }

  await runCommand('git add -A', {
    cwd,
    description: 'Staging all changes',
  });

  const payload = await captureDiffPayload(cwd);
  if (payload.diff.trim().length === 0 && payload.status.trim().length === 0) {
    // Defensive: hasChanges said dirty, but the staged diff is empty (e.g. a
    // mode-only change that vanished after `git add -A`). Bail cleanly.
    log.info('No staged changes after `git add -A`; nothing to commit.');
    return;
  }

  const message = await generateCommitMessage(env.ANTHROPIC_API_KEY, payload);
  previewMessage(message);

  await commitWithMessage(cwd, message);
  await runCommand('git push', {
    cwd,
    description: 'Pushing to remote',
  });

  log.blank();
  log.success('Committed and pushed');
  log.blank();
};

// ─────────────────────────────────────────────────────────────
// Error reporter (mirrors do-connect.ts)
// ─────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  log.blank();
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);

  if (err instanceof Error && 'stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string') {
    const stderr = (err as { stderr: string }).stderr;
    if (stderr.trim().length > 0) {
      console.log();
      console.log(theme.dim('  Error details:'));
      stderr
        .split('\n')
        .slice(0, 5)
        .forEach((line) => {
          if (line.trim()) console.log(`    ${theme.dim(line)}`);
        });
    }
  }

  log.blank();
  process.exit(1);
});
