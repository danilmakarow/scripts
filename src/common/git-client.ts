/**
 * GitClient — a thin wrapper around git CLI + remote-host (GitLab/GitHub) HTTP
 * APIs. Construct one per script with an access token and call high-level
 * methods like {@link GitClient.findOpenMergeRequest} or
 * {@link GitClient.createMergeRequest} without caring which host is on the
 * other end of the wire.
 *
 * Architecture:
 *   - The class delegates all host-specific behaviour to a {@link HostAdapter}
 *     (Strategy pattern). Concrete adapters live below as `GitlabAdapter` and
 *     `GithubAdapter`.
 *   - All HTTP traffic uses Node 22+ built-in `fetch`. Failed responses are
 *     wrapped in a typed {@link GitClientError} so callers can inspect status
 *     and body.
 *
 * The token is read from a single canonical env var: `GIT_ACCESS_TOKEN`.
 */

import { execa } from 'execa';

import { validateEnv } from './env';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type GitHost = 'gitlab' | 'github' | 'unknown';

export interface RemoteInfo {
  readonly host: GitHost;
  readonly projectPath: string;
  readonly remoteUrl: string;
}

export interface MergeRequestParams {
  /** Branch to merge from (HEAD on GitHub / source_branch on GitLab). */
  readonly sourceBranch: string;
  /** Optional explicit target branch. When omitted, the repo default is used. */
  readonly targetBranch?: string;
  /** MR/PR title. */
  readonly title: string;
  /** MR/PR description / body. */
  readonly description: string;
}

export interface MergeRequest {
  /** Web URL the human can open in a browser. */
  readonly url: string;
}

export interface HostAdapter {
  readonly host: Exclude<GitHost, 'unknown'>;
  /** Returns the repo's default branch name (e.g. `main`, `master`). */
  readonly getDefaultBranch: (projectPath: string) => Promise<string>;
  /** Looks up the first open MR/PR sourced from `sourceBranch`. */
  readonly findOpenMergeRequest: (
    projectPath: string,
    sourceBranch: string,
  ) => Promise<MergeRequest | null>;
  /** Opens a new MR/PR. */
  readonly createMergeRequest: (
    projectPath: string,
    params: Required<Omit<MergeRequestParams, 'targetBranch'>> & { readonly targetBranch: string },
  ) => Promise<MergeRequest>;
}

// ─────────────────────────────────────────────────────────────
// GitClientError
// ─────────────────────────────────────────────────────────────
/**
 * Typed error thrown when a remote-host HTTP call fails. Carries the response
 * status and (truncated) body for debugging.
 */
export class GitClientError extends Error {
  public static is(value: unknown): value is GitClientError {
    return value instanceof GitClientError;
  }

  public readonly status: number;
  public readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'GitClientError';
    this.status = status;
    this.body = body;
  }
}

// ─────────────────────────────────────────────────────────────
// Internal HTTP helpers
// ─────────────────────────────────────────────────────────────
const MAX_BODY_PREVIEW = 1024;

/** Reads the response body as text, truncated for safe error reporting. */
const readBodyPreview = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    return text.length > MAX_BODY_PREVIEW ? `${text.slice(0, MAX_BODY_PREVIEW)}…` : text;
  } catch {
    return '';
  }
};

/** Issues an HTTP request and returns parsed JSON, throwing GitClientError on failure. */
const requestJson = async <T>(
  url: string,
  init: RequestInit,
): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await readBodyPreview(response);
    throw new GitClientError(
      `${init.method ?? 'GET'} ${url} failed with status ${response.status}`,
      response.status,
      body,
    );
  }
  return (await response.json()) as T;
};

// ─────────────────────────────────────────────────────────────
// Internal type guards for parsed JSON
// ─────────────────────────────────────────────────────────────
/** True when `value` is a non-null object record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns `value[key]` typed as string, or null if the field is missing/invalid. */
const stringField = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) return null;
  const raw = value[key];
  return typeof raw === 'string' ? raw : null;
};

// ─────────────────────────────────────────────────────────────
// GitlabAdapter
// ─────────────────────────────────────────────────────────────
/** Strategy implementation for gitlab.com / self-hosted GitLab instances. */
class GitlabAdapter implements HostAdapter {
  private static readonly API_BASE = 'https://gitlab.com/api/v4';

  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private projectId(projectPath: string): string {
    return encodeURIComponent(projectPath);
  }

  public readonly host = 'gitlab' as const;

  /** GET /projects/:id → default_branch. */
  public readonly getDefaultBranch = async (projectPath: string): Promise<string> => {
    const url = `${GitlabAdapter.API_BASE}/projects/${this.projectId(projectPath)}`;
    const data = await requestJson<unknown>(url, { method: 'GET', headers: this.headers() });
    const defaultBranch = stringField(data, 'default_branch');
    if (!defaultBranch) {
      throw new GitClientError(
        `GitLab project ${projectPath} returned no default_branch`,
        200,
        JSON.stringify(data).slice(0, MAX_BODY_PREVIEW),
      );
    }
    return defaultBranch;
  };

  /** GET /projects/:id/merge_requests?source_branch=...&state=opened. */
  public readonly findOpenMergeRequest = async (
    projectPath: string,
    sourceBranch: string,
  ): Promise<MergeRequest | null> => {
    const url = new URL(`${GitlabAdapter.API_BASE}/projects/${this.projectId(projectPath)}/merge_requests`);
    url.searchParams.set('source_branch', sourceBranch);
    url.searchParams.set('state', 'opened');

    const data = await requestJson<unknown>(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });
    if (!Array.isArray(data) || data.length === 0) return null;

    const webUrl = stringField(data[0], 'web_url');
    return webUrl ? { url: webUrl } : null;
  };

  /** POST /projects/:id/merge_requests. */
  public readonly createMergeRequest = async (
    projectPath: string,
    params: Required<Omit<MergeRequestParams, 'targetBranch'>> & { readonly targetBranch: string },
  ): Promise<MergeRequest> => {
    const url = `${GitlabAdapter.API_BASE}/projects/${this.projectId(projectPath)}/merge_requests`;
    const payload = {
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      title: params.title,
      description: params.description,
      remove_source_branch: true,
    };
    const data = await requestJson<unknown>(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const webUrl = stringField(data, 'web_url');
    if (!webUrl) {
      throw new GitClientError(
        `GitLab createMergeRequest returned no web_url`,
        200,
        JSON.stringify(data).slice(0, MAX_BODY_PREVIEW),
      );
    }
    return { url: webUrl };
  };
}

// ─────────────────────────────────────────────────────────────
// GithubAdapter
// ─────────────────────────────────────────────────────────────
/** Strategy implementation for github.com pull requests. */
class GithubAdapter implements HostAdapter {
  private static readonly API_BASE = 'https://api.github.com';

  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private splitPath(projectPath: string): { readonly owner: string; readonly repo: string } {
    const segments = projectPath.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      throw new GitClientError(
        `Invalid GitHub project path: "${projectPath}" (expected "owner/repo")`,
        0,
        '',
      );
    }
    return { owner: segments[0], repo: segments[1] };
  }

  public readonly host = 'github' as const;

  /** GET /repos/:owner/:repo → default_branch. */
  public readonly getDefaultBranch = async (projectPath: string): Promise<string> => {
    const { owner, repo } = this.splitPath(projectPath);
    const url = `${GithubAdapter.API_BASE}/repos/${owner}/${repo}`;
    const data = await requestJson<unknown>(url, { method: 'GET', headers: this.headers() });
    const defaultBranch = stringField(data, 'default_branch');
    if (!defaultBranch) {
      throw new GitClientError(
        `GitHub repo ${projectPath} returned no default_branch`,
        200,
        JSON.stringify(data).slice(0, MAX_BODY_PREVIEW),
      );
    }
    return defaultBranch;
  };

  /** GET /repos/:owner/:repo/pulls?head=:owner:branch&state=open. */
  public readonly findOpenMergeRequest = async (
    projectPath: string,
    sourceBranch: string,
  ): Promise<MergeRequest | null> => {
    const { owner, repo } = this.splitPath(projectPath);
    const url = new URL(`${GithubAdapter.API_BASE}/repos/${owner}/${repo}/pulls`);
    url.searchParams.set('head', `${owner}:${sourceBranch}`);
    url.searchParams.set('state', 'open');

    const data = await requestJson<unknown>(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });
    if (!Array.isArray(data) || data.length === 0) return null;

    const htmlUrl = stringField(data[0], 'html_url');
    return htmlUrl ? { url: htmlUrl } : null;
  };

  /** POST /repos/:owner/:repo/pulls. */
  public readonly createMergeRequest = async (
    projectPath: string,
    params: Required<Omit<MergeRequestParams, 'targetBranch'>> & { readonly targetBranch: string },
  ): Promise<MergeRequest> => {
    const { owner, repo } = this.splitPath(projectPath);
    const url = `${GithubAdapter.API_BASE}/repos/${owner}/${repo}/pulls`;
    const payload = {
      head: params.sourceBranch,
      base: params.targetBranch,
      title: params.title,
      body: params.description,
    };
    const data = await requestJson<unknown>(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const htmlUrl = stringField(data, 'html_url');
    if (!htmlUrl) {
      throw new GitClientError(
        `GitHub createPullRequest returned no html_url`,
        200,
        JSON.stringify(data).slice(0, MAX_BODY_PREVIEW),
      );
    }
    return { url: htmlUrl };
  };
}

// ─────────────────────────────────────────────────────────────
// GitClient
// ─────────────────────────────────────────────────────────────
/**
 * Facade over local git commands and a chosen {@link HostAdapter}. Construct
 * one per script (typically via {@link GitClient.fromEnv}) and call its
 * methods — host detection happens lazily inside the helper methods.
 */
export class GitClient {
  // ── static ──
  /**
   * Builds a {@link GitClient} using the access token in `GIT_ACCESS_TOKEN`
   * (validated via the shared LIVR-based `validateEnv` helper). On a missing
   * or empty token the helper prints a friendly error block and exits.
   */
  public static fromEnv(): GitClient {
    const validated = validateEnv<{ GIT_ACCESS_TOKEN: string }>({
      GIT_ACCESS_TOKEN: ['required', 'string', { min_length: 1 }],
    });
    return new GitClient(validated.GIT_ACCESS_TOKEN);
  }

  // ── private fields ──
  private readonly token: string;

  // ── constructor ──
  constructor(token: string) {
    if (!token || token.length === 0) {
      throw new Error('GitClient requires a non-empty access token');
    }
    this.token = token;
  }

  // ── private methods ──
  /** Picks the right {@link HostAdapter} for the given host string. */
  private adapterFor(host: GitHost): HostAdapter {
    if (host === 'gitlab') return new GitlabAdapter(this.token);
    if (host === 'github') return new GithubAdapter(this.token);
    throw new Error(`Unsupported git host: ${host}`);
  }

  // ── public methods ──
  /**
   * Returns the URL of the `origin` remote at `cwd`. Throws if the command
   * fails (e.g. no remote configured).
   */
  public readonly getRemoteUrl = async (cwd: string): Promise<string> => {
    const result = await execa('git', ['remote', 'get-url', 'origin'], {
      cwd,
      reject: false,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (result.exitCode !== 0 || stdout.length === 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(stderr || `Could not read git remote "origin" in ${cwd}`);
    }
    return stdout;
  };

  /**
   * Heuristically maps a remote URL to a known host. Works on both SSH
   * (`git@host:path.git`) and HTTPS (`https://host/path.git`) forms. Returns
   * `unknown` for hosts we don't speak.
   */
  public readonly detectHost = (remoteUrl: string): GitHost => {
    const trimmed = remoteUrl.trim();
    let hostname = '';

    if (trimmed.startsWith('git@')) {
      // git@host:path.git
      const afterAt = trimmed.slice('git@'.length);
      const colonIndex = afterAt.indexOf(':');
      hostname = colonIndex === -1 ? afterAt : afterAt.slice(0, colonIndex);
    } else {
      try {
        hostname = new URL(trimmed).hostname;
      } catch {
        return 'unknown';
      }
    }

    const lower = hostname.toLowerCase();
    if (lower === 'gitlab.com' || lower.endsWith('.gitlab.com')) return 'gitlab';
    if (lower === 'github.com' || lower.endsWith('.github.com')) return 'github';
    return 'unknown';
  };

  /**
   * Extracts `namespace/repo` (or `owner/repo`) from a remote URL. Handles
   * both SSH (`git@host:foo/bar.git`) and HTTPS (`https://host/foo/bar.git`)
   * styles. The trailing `.git` suffix is stripped.
   */
  public readonly getProjectPath = (remoteUrl: string): string => {
    const trimmed = remoteUrl.trim();
    let pathPart = '';

    if (trimmed.startsWith('git@')) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) {
        throw new Error(`Could not parse SSH remote URL: ${remoteUrl}`);
      }
      pathPart = trimmed.slice(colonIndex + 1);
    } else {
      try {
        const parsed = new URL(trimmed);
        pathPart = parsed.pathname.replace(/^\/+/, '');
      } catch {
        throw new Error(`Could not parse remote URL: ${remoteUrl}`);
      }
    }

    if (pathPart.endsWith('.git')) pathPart = pathPart.slice(0, -'.git'.length);
    pathPart = pathPart.replace(/\/+$/, '');

    if (pathPart.length === 0) {
      throw new Error(`Empty project path in remote URL: ${remoteUrl}`);
    }
    return pathPart;
  };

  /**
   * Returns the `{ host, projectPath, remoteUrl }` triple for `cwd`. Sugar for
   * the common case of "tell me what repo I'm in".
   */
  public readonly describeRemote = async (cwd: string): Promise<RemoteInfo> => {
    const remoteUrl = await this.getRemoteUrl(cwd);
    return {
      remoteUrl,
      host: this.detectHost(remoteUrl),
      projectPath: this.getProjectPath(remoteUrl),
    };
  };

  /** Pushes `branch` to `origin` with upstream tracking (`-u`). */
  public readonly pushBranch = async (cwd: string, branch: string): Promise<void> => {
    const result = await execa('git', ['push', '-u', 'origin', branch], {
      cwd,
      reject: false,
    });
    if (result.exitCode !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const detail = stderr || stdout || `git push failed with exit code ${result.exitCode}`;
      const error = new Error(detail) as Error & { stderr?: string };
      error.stderr = stderr;
      throw error;
    }
  };

  /**
   * Looks up the first open MR/PR whose source branch matches `sourceBranch`.
   * Returns null when none exist. Errors out for `unknown` hosts.
   */
  public readonly findOpenMergeRequest = async (
    host: GitHost,
    projectPath: string,
    sourceBranch: string,
  ): Promise<MergeRequest | null> =>
    this.adapterFor(host).findOpenMergeRequest(projectPath, sourceBranch);

  /**
   * Resolves the repository's default branch (e.g. `main`, `master`) via the
   * appropriate host API. Useful as a target for `createMergeRequest`.
   */
  public readonly getDefaultBranch = async (
    host: GitHost,
    projectPath: string,
  ): Promise<string> => this.adapterFor(host).getDefaultBranch(projectPath);

  /**
   * Opens a new MR/PR. When `params.targetBranch` is omitted, the repo's
   * default branch is fetched and used.
   */
  public readonly createMergeRequest = async (
    host: GitHost,
    projectPath: string,
    params: MergeRequestParams,
  ): Promise<MergeRequest> => {
    const adapter = this.adapterFor(host);
    const targetBranch = params.targetBranch ?? (await adapter.getDefaultBranch(projectPath));
    return adapter.createMergeRequest(projectPath, {
      sourceBranch: params.sourceBranch,
      title: params.title,
      description: params.description,
      targetBranch,
    });
  };
}
