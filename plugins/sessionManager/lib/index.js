/**
 * dsh-session-manager — host half.
 *
 * DSH can archive a session but never delete one: `sessionPersistence` has no
 * `delete`, `sessionController` has no `delete`, and `workspaceRegistry` only
 * keeps bookkeeping (archive/pin). So a real delete is three independent jobs:
 *
 *   1. workspace bookkeeping  — `Workspace.detachSession(id)` + `unpinSession`
 *                               + `unarchiveSession`
 *   2. on-disk session data   — `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/`
 *   3. projection cache       — `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`
 *
 * The browser half cannot reach any of that, so this half exposes same-origin
 * HTTP routes and the client half calls them with `fetch`.
 *
 * Routes (all loopback-only, all require `x-dsh-session-manager: 1`):
 *   POST /dsh-session-manager/delete       { sessionId, mode?: 'trash' | 'purge', dryRun?, displayTitle? }
 *   GET  /dsh-session-manager/trash        → { ok, entries: TrashEntry[] }
 *   POST /dsh-session-manager/restore      { trashId } | { sessionId }
 *   POST /dsh-session-manager/trash/purge  { trashId } | { all: true }
 *
 * Restore is two jobs, in this order:
 *   1. rename the trash directory back to its recorded `originalPath`
 *      (`Workspace.attachSession` reads the session header from disk, so the
 *      file has to exist first)
 *   2. `Workspace.attachSession(id)` — without it the sidebar never lists the
 *      session again, because rows render from workspace membership
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'session-manager';
export const inject = ['webServer'];

const ROUTE_BASE = '/dsh-session-manager';
const INTENT_HEADER = 'x-dsh-session-manager';
const BODY_LIMIT = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const META_NAME = '.session-manager.json';
/** Entries written by the pre-rename build (dsh-plugin-session-delete) still read. */
const LEGACY_META_NAMES = ['.session-delete.json'];
const META_NAMES = [META_NAME, ...LEGACY_META_NAMES];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

function projectionCacheRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

function trashRoot() {
  return join(dshHome(), '.session-trash');
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A session id is a directory name: allow no separators, no traversal. */
function validSessionId(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 200) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/** A trash id is one directory name under the trash root. */
function validTrashId(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 300) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value);
}

/** Session directories are named exactly after the session id. */
function candidateNames(sessionId) {
  const names = [sessionId];
  if (!sessionId.startsWith('session-')) names.push(`session-${sessionId}`);
  return [...new Set(names)];
}

async function dirSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}

/** Locate every `<cwd-encoded>/<sessionId>/` directory that exists. */
async function locateSessionDirs(sessionId) {
  const root = sessionsRoot();
  const names = candidateNames(sessionId);
  const found = [];
  let buckets = [];
  try {
    buckets = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    for (const entry of names) {
      const dir = join(root, bucket.name, entry);
      if (!existsSync(dir)) continue;
      let sizeBytes = 0;
      try {
        sizeBytes = await dirSize(dir);
      } catch {
        sizeBytes = 0;
      }
      found.push({ dir, bucket: bucket.name, sizeBytes });
    }
  }
  return found;
}

/** Best effort: is this session currently running or holding a write handle? */
function sessionIsBusy(ctx, sessionId) {
  const controller = ctx.get('sessionController');
  if (!controller) return false;
  try {
    const list = controller.list?.();
    const rows = Array.isArray(list) ? list : Array.isArray(list?.sessions) ? list.sessions : [];
    const row = rows.find((entry) => entry && (entry.id === sessionId || entry.sessionId === sessionId));
    if (!row) return false;
    if (row.running === true) return true;
    const status = row.status ?? row.state ?? row.activity;
    return status === 'running' || status === 'streaming' || status === 'busy';
  } catch {
    return false;
  }
}

async function stopSession(ctx, sessionId) {
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.cancel !== 'function') return false;
  try {
    await controller.cancel({ id: sessionId });
    return true;
  } catch {
    try {
      await controller.cancel(sessionId);
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sessionStore(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions;
  } catch {
    return undefined;
  }
}

function agentStore(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
  } catch {
    return undefined;
  }
}

/** The live Session object still held in memory, or undefined. */
function liveSession(ctx, sessionId) {
  const store = sessionStore(ctx);
  try {
    return store && typeof store.get === 'function' ? store.get(sessionId) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop a Session from the in-memory stores so `session.list` stops returning it.
 *
 * `session.list` returns "every visible attached and persisted Session", so a
 * Session whose files were deleted still comes back from `list()` while it is
 * attached to the in-memory SessionStore — the client keeps rendering a row for
 * it (under 未分组, because the workspace membership is already gone). That is
 * exactly the "the workspace got deleted" look instead of a real delete.
 *
 * The store API has no `remove`, but the detach machinery is reachable:
 * `SessionStore.liveEntryFor(session)` → `SessionStore.detachEntered(entry)`
 * deletes the store entry and emits `session/disposed`; the agent registry has
 * the mirror pair (`store.get(id)` → `detachEntered(entry)`, emitting
 * `agent/disposed`). Disposing the Agent scope alone does NOT detach the
 * Session (verified), so the store entry is the thing that has to go.
 */
async function evictLiveAgent(ctx, sessionId) {
  const steps = [];
  const store = sessionStore(ctx);
  const agents = agentStore(ctx);
  const live = () => liveSession(ctx, sessionId) !== undefined;
  if (typeof store?.get !== 'function' || !live()) {
    return { attempted: false, live: live(), steps };
  }
  const failure = (error) => String(error?.message ?? error);
  let agent;
  try {
    agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
  } catch {
    agent = undefined;
  }

  // 1. the SessionStore entry — this is what `session.list` reads
  try {
    const session = store.get(sessionId);
    const entry =
      typeof store.liveEntryFor === 'function'
        ? store.liveEntryFor(session)
        : typeof store.store?.get === 'function'
          ? store.store.get(sessionId)
          : undefined;
    if (entry === undefined) throw new Error('no live store entry');
    if (typeof store.detachEntered !== 'function') throw new Error('SessionStore.detachEntered is unavailable');
    store.detachEntered(entry);
    steps.push({ step: 'sessions.detachEntered', ok: true });
  } catch (error) {
    steps.push({ step: 'sessions.detachEntered', ok: false, reason: failure(error) });
  }

  // 2. the agent registry entry, so nothing keeps resolving the dead agent
  try {
    const entry = typeof agents?.store?.get === 'function' ? agents.store.get(sessionId) : undefined;
    if (entry !== undefined) {
      if (typeof agents.detachEntered !== 'function') throw new Error('AgentService.detachEntered is unavailable');
      agents.detachEntered(entry);
      steps.push({ step: 'agents.detachEntered', ok: true });
    }
  } catch (error) {
    steps.push({ step: 'agents.detachEntered', ok: false, reason: failure(error) });
  }

  // 3. best effort: unwind the driver so it stops appending to a deleted file
  try {
    const scope = agent?.scope;
    if (scope && typeof scope.rawDispose === 'function') {
      await scope.rawDispose();
      steps.push({ step: 'agent.scope.rawDispose', ok: true });
    }
  } catch (error) {
    steps.push({ step: 'agent.scope.rawDispose', ok: false, reason: failure(error) });
  }

  await sleep(120);
  return { attempted: true, live: live(), steps };
}

/** Remove the session from every workspace that still lists it. */
async function detachFromWorkspaces(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  const touched = [];
  if (!registry) return touched;
  let workspaces = [];
  try {
    workspaces = registry.list() ?? [];
  } catch {
    return touched;
  }
  for (const workspace of workspaces) {
    try {
      if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue;
      await workspace.detachSession(sessionId);
      touched.push(workspace.id ?? workspace.path ?? '(workspace)');
    } catch {
      // Keep going: one stubborn workspace must not block the file delete.
    }
  }
  return touched;
}

function clearGlobalBookkeeping(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  const cleared = [];
  if (!registry) return cleared;
  for (const method of ['unpinSession', 'unarchiveSession']) {
    try {
      if (typeof registry[method] !== 'function') continue;
      registry[method](sessionId);
      cleared.push(method);
    } catch {
      // Idempotent helper failed: nothing to report beyond the miss.
    }
  }
  return cleared;
}

async function removeProjectionCache(sessionId) {
  const removed = [];
  for (const name of candidateNames(sessionId)) {
    const file = join(projectionCacheRoot(), `${name}.json`);
    if (!existsSync(file)) continue;
    await rm(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/* ------------------------------------------------------------------ trash */

/** Move one session directory into the trash, recording what restore needs. */
async function moveToTrash(entry, sessionId, extra = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashId = `${stamp}__${sessionId}`;
  const destination = join(trashRoot(), trashId);
  await mkdir(trashRoot(), { recursive: true });
  await rename(entry.dir, destination);
  await writeFile(
    join(destination, META_NAME),
    `${JSON.stringify(
      {
        sessionId,
        originalPath: entry.dir,
        workspaceBucket: entry.bucket,
        workspaceId: extra.workspaceId ?? null,
        displayTitle: extra.displayTitle ?? null,
        sizeBytes: entry.sizeBytes,
        deletedAt: new Date().toISOString(),
        restoreHint: `mv "${destination}" "${entry.dir}"`,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { destination, trashId };
}

/** Every directory under the trash root that carries (or implies) a session. */
async function readTrashIndex() {
  const root = trashRoot();
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const index = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let meta = null;
    for (const candidate of META_NAMES) {
      try {
        meta = JSON.parse(await readFile(join(dir, candidate), 'utf8'));
        break;
      } catch {
        meta = null;
      }
    }
    const derived = entry.name.includes('__') ? entry.name.split('__').slice(1).join('__') : entry.name;
    const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : derived;
    let sizeBytes = typeof meta?.sizeBytes === 'number' ? meta.sizeBytes : 0;
    if (!sizeBytes) {
      try {
        sizeBytes = await dirSize(dir);
      } catch {
        sizeBytes = 0;
      }
    }
    index.push({
      trashId: entry.name,
      dir,
      sessionId,
      originalPath: typeof meta?.originalPath === 'string' ? meta.originalPath : null,
      workspaceBucket: typeof meta?.workspaceBucket === 'string' ? meta.workspaceBucket : null,
      workspaceId: typeof meta?.workspaceId === 'string' ? meta.workspaceId : null,
      displayTitle: typeof meta?.displayTitle === 'string' ? meta.displayTitle : null,
      sizeBytes,
      deletedAt: typeof meta?.deletedAt === 'string' ? meta.deletedAt : null,
      hasMeta: meta !== null,
    });
  }
  index.sort((left, right) => String(right.trashId).localeCompare(String(left.trashId)));
  return index;
}

/** Where a trashed directory goes back to, even for entries without metadata. */
function originalPathOf(entry) {
  if (entry.originalPath) return entry.originalPath;
  if (!entry.workspaceBucket) return null;
  return join(sessionsRoot(), entry.workspaceBucket, entry.sessionId);
}

/** Compare a workspace path against a stored cwd bucket by letters only. */
function tokenOf(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
}

/** Re-attach a restored session to the workspace it came from. */
async function attachToWorkspace(ctx, entry) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return null;
  let workspaces = [];
  try {
    workspaces = registry.list() ?? [];
  } catch {
    return null;
  }
  let target = null;
  if (entry.workspaceId) {
    target = workspaces.find((workspace) => String(workspace.id) === entry.workspaceId) ?? null;
  }
  if (!target && entry.workspaceBucket) {
    const bucket = tokenOf(entry.workspaceBucket);
    target =
      workspaces.find((workspace) => tokenOf(workspace.path) === bucket) ??
      workspaces.find((workspace) => {
        const path = tokenOf(workspace.path);
        return path.length > 0 && (bucket.endsWith(path) || path.endsWith(bucket));
      }) ??
      null;
  }
  if (!target) return null;
  try {
    await target.attachSession(entry.sessionId);
    return target.id ?? target.path ?? '(workspace)';
  } catch (error) {
    return { failed: String(error?.message ?? error) };
  }
}

/** Undo one delete: put the directory back, then re-attach the session. */
async function restoreFromTrash(ctx, { trashId, sessionId }) {
  const index = await readTrashIndex();
  const entry = trashId
    ? index.find((row) => row.trashId === trashId)
    : index.filter((row) => row.sessionId === sessionId)[0];
  if (!entry) {
    return { ok: false, code: 'trash-miss', message: 'no matching entry under the trash root', trashId, sessionId };
  }
  const destination = originalPathOf(entry);
  if (!destination) {
    return { ok: false, code: 'trash-corrupt', message: 'entry names no original path', trashId: entry.trashId };
  }
  if (existsSync(destination)) {
    return {
      ok: false,
      code: 'destination-exists',
      message: 'a session directory already occupies the original path',
      trashId: entry.trashId,
      sessionId: entry.sessionId,
      path: destination,
    };
  }
  if (sessionIsBusy(ctx, entry.sessionId)) {
    return {
      ok: false,
      code: 'session-busy',
      message: 'that session id is live in this host',
      trashId: entry.trashId,
      sessionId: entry.sessionId,
    };
  }

  try {
    await mkdir(dirname(destination), { recursive: true });
    await rename(entry.dir, destination);
    // The metadata file travelled with the directory; it must not stay inside
    // a live session folder.
    for (const candidate of META_NAMES) {
      await rm(join(destination, candidate), { force: true });
    }
  } catch (error) {
    return {
      ok: false,
      code: 'restore-failed',
      message: String(error?.message ?? error),
      trashId: entry.trashId,
      sessionId: entry.sessionId,
    };
  }

  const attachedTo = await attachToWorkspace(ctx, entry);
  let unarchived = false;
  try {
    const registry = ctx.get('workspaceRegistry');
    const archived = registry?.archivedSessionIds;
    if (Array.isArray(archived) && archived.includes(entry.sessionId)) {
      registry.unarchiveSession(entry.sessionId);
      unarchived = true;
    }
  } catch {
    unarchived = false;
  }

  return {
    ok: true,
    code: 'restored',
    trashId: entry.trashId,
    sessionId: entry.sessionId,
    path: destination,
    attachedTo,
    unarchived,
    displayTitle: entry.displayTitle,
  };
}

/** Delete one trashed directory for good (or every one of them). */
async function purgeTrash({ trashId, all = false }) {
  const index = await readTrashIndex();
  const targets = all ? index : index.filter((row) => row.trashId === trashId);
  if (targets.length === 0) {
    return { ok: false, code: 'trash-miss', message: 'no matching entry under the trash root', trashId };
  }
  const removed = [];
  const residual = [];
  for (const entry of targets) {
    try {
      await rm(entry.dir, { recursive: true, force: true });
      removed.push({ trashId: entry.trashId, sessionId: entry.sessionId, path: entry.dir });
    } catch (error) {
      residual.push({ trashId: entry.trashId, error: String(error?.message ?? error) });
    }
  }
  return {
    ok: residual.length === 0,
    code: residual.length === 0 ? 'purged' : 'partial',
    removed,
    residual,
  };
}

/* ----------------------------------------------------------------- config */

const CONFIG_NAME = 'session-manager.config.json';
const DEFAULT_CONFIG = { workspaceDeleteMode: 'system', deleteMode: 'trash' };
const WORKSPACE_DELETE_MODES = new Set(['system', 'archive', 'delete']);
const DELETE_MODES = new Set(['trash', 'purge']);

/** Outcome of the most recent workspace-delete policy run, for diagnostics. */
let lastPolicyRun = null;

function configFile() {
  return join(dshHome(), CONFIG_NAME);
}

/** Keep only known keys with known values; anything else is ignored. */
function normalizeConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (WORKSPACE_DELETE_MODES.has(raw.workspaceDeleteMode)) out.workspaceDeleteMode = raw.workspaceDeleteMode;
  if (DELETE_MODES.has(raw.deleteMode)) out.deleteMode = raw.deleteMode;
  return out;
}

async function readStoredConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(configFile(), 'utf8')));
  } catch {
    return {};
  }
}

async function writeStoredConfig(patch) {
  const next = { ...(await readStoredConfig()), ...normalizeConfig(patch) };
  await mkdir(dshHome(), { recursive: true });
  await writeFile(configFile(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Defaults < loader entry config < the file the settings page writes. */
async function effectiveConfig(entryConfig) {
  const fromEntry = normalizeConfig(entryConfig);
  const fromFile = await readStoredConfig();
  return { ...DEFAULT_CONFIG, ...fromEntry, ...fromFile };
}

/* --------------------------------------------------------------- sessions */

/** A session's display title: live projection first, then the projection cache. */
async function titleOf(ctx, sessionId, live) {
  try {
    const projections = ctx.get('sessionProjections');
    if (live !== undefined && projections && typeof projections.snapshot === 'function') {
      const snapshot = projections.snapshot(live, ['title']);
      const value = snapshot?.values?.title;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  } catch {
    /* fall through to the cache */
  }
  try {
    const parsed = JSON.parse(await readFile(join(projectionCacheRoot(), `${sessionId}.json`), 'utf8'));
    const value = parsed?.record?.rows?.title?.val;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  } catch {
    /* no cache row */
  }
  return '';
}

/** One row per session the Host knows about, with archive/pin/workspace state. */
async function listSessions(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const controller = ctx.get('sessionController');

  const archived = new Set();
  const pinned = new Set();
  try {
    for (const id of registry?.archivedSessionIds ?? []) archived.add(String(id));
  } catch {
    /* registry unavailable */
  }
  try {
    for (const id of registry?.pinnedSessionIds ?? []) pinned.add(String(id));
  } catch {
    /* registry unavailable */
  }

  const membership = new Map();
  try {
    for (const workspace of registry?.list() ?? []) {
      for (const id of workspace.sessionIds ?? []) {
        const key = String(id);
        if (!membership.has(key)) {
          membership.set(key, {
            workspaceId: workspace.id ?? null,
            workspaceTitle: workspace.title ?? null,
            workspacePath: workspace.path ?? null,
          });
        }
      }
    }
  } catch {
    /* registry unavailable */
  }

  let items = [];
  let listError = null;
  try {
    const result = await controller.list({}, undefined);
    items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
    if (!Array.isArray(items)) listError = `unexpected list shape: ${Object.keys(result ?? {}).join(',')}`;
  } catch (error) {
    listError = String(error?.message ?? error);
  }

  const sessions = [];
  for (const row of items) {
    const sessionId = String(row?.sessionId ?? row?.id ?? '');
    const owner = membership.get(sessionId) ?? {};
    const live = liveSession(ctx, sessionId);
    sessions.push({
      sessionId,
      title: await titleOf(ctx, sessionId, live),
      cwd: row?.cwd ?? owner.workspacePath ?? null,
      updatedAt: typeof row?.updatedAt === 'number' ? row.updatedAt : null,
      running: Boolean(row?.running ?? row?.status === 'running'),
      archived: archived.has(sessionId),
      pinned: pinned.has(sessionId),
      workspaceId: owner.workspaceId ?? null,
      workspaceTitle: owner.workspaceTitle ?? null,
      live: live !== undefined,
    });
  }

  return {
    sessions,
    archivedSessionIds: [...archived],
    pinnedSessionIds: [...pinned],
    listError,
  };
}

/** Archive (or unarchive) many sessions, reporting per-id outcomes. */
async function setArchived(ctx, sessionIds, archived) {
  const registry = ctx.get('workspaceRegistry');
  const results = [];
  for (const raw of sessionIds) {
    const sessionId = String(raw);
    if (!validSessionId(sessionId)) {
      results.push({ sessionId, ok: false, reason: 'invalid session id' });
      continue;
    }
    try {
      if (archived) await registry.archiveSession(sessionId, { stopActivity: true });
      else await registry.unarchiveSession(sessionId);
      results.push({ sessionId, ok: true, archived });
    } catch (error) {
      results.push({ sessionId, ok: false, archived, reason: String(error?.message ?? error) });
    }
  }
  return {
    ok: results.every((row) => row.ok),
    code: results.every((row) => row.ok) ? (archived ? 'archived' : 'unarchived') : 'partial',
    results,
  };
}

/** Delete many sessions one by one, so one failure never blocks the rest. */
async function deleteSessions(ctx, sessionIds, mode) {
  const results = [];
  for (const raw of sessionIds) {
    const sessionId = String(raw);
    if (!validSessionId(sessionId)) {
      results.push({ sessionId, ok: false, code: 'invalid-session-id' });
      continue;
    }
    try {
      const outcome = await deleteSession(ctx, { sessionId, mode });
      results.push({
        sessionId,
        ok: outcome.ok,
        code: outcome.code,
        trashId: outcome.trashId ?? null,
        residual: outcome.residual ?? [],
      });
    } catch (error) {
      results.push({ sessionId, ok: false, code: 'internal-error', reason: String(error?.message ?? error) });
    }
  }
  return {
    ok: results.every((row) => row.ok),
    code: results.every((row) => row.ok) ? 'deleted' : 'partial',
    mode,
    results,
  };
}

/**
 * What happens to a workspace's sessions when that workspace is deleted.
 * `system` keeps the shipped behaviour (rows fall through to 未分组).
 */
async function applyWorkspaceDeletePolicy(ctx, known, settings) {
  const mode = settings.workspaceDeleteMode;
  const sessionIds = (known.sessionIds ?? []).filter((id) => validSessionId(String(id)));
  const base = { at: Date.now(), workspaceId: known.id, workspacePath: known.path, mode, sessionIds };
  if (mode === 'system' || sessionIds.length === 0) return { ...base, results: [] };
  if (mode === 'archive') {
    const outcome = await setArchived(ctx, sessionIds, true);
    return { ...base, code: outcome.code, results: outcome.results };
  }
  const outcome = await deleteSessions(ctx, sessionIds, settings.deleteMode);
  return { ...base, code: outcome.code, results: outcome.results };
}

/* ----------------------------------------------------------------- delete */

async function deleteSession(ctx, { sessionId, mode = 'trash', dryRun = false, displayTitle = null }) {
  const targets = await locateSessionDirs(sessionId);
  const cacheFiles = candidateNames(sessionId)
    .map((name) => join(projectionCacheRoot(), `${name}.json`))
    .filter((file) => existsSync(file));
  const busy = sessionIsBusy(ctx, sessionId);

  if (targets.length === 0 && cacheFiles.length === 0) {
    return {
      ok: false,
      code: 'not-found',
      message: 'no session directory or projection cache entry on disk',
      sessionId,
      mode,
      targets: [],
      cacheFiles: [],
      busy,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      sessionId,
      mode,
      busy,
      live: liveSession(ctx, sessionId) !== undefined,
      targets,
      cacheFiles,
      totalBytes: targets.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
  }

  const stopped = busy ? await stopSession(ctx, sessionId) : false;
  if (stopped) await new Promise((resolve) => setTimeout(resolve, 300));

  // Detach the in-memory Session BEFORE touching the files: `session.list`
  // merges live Sessions, so a surviving store entry keeps the row alive in
  // every client's sidebar (under 未分组) even after the files are gone.
  const evicted = await evictLiveAgent(ctx, sessionId);

  const detached = await detachFromWorkspaces(ctx, sessionId);

  const removed = [];
  const residual = [];
  for (const entry of targets) {
    try {
      if (mode === 'purge') {
        await rm(entry.dir, { recursive: true, force: true });
        removed.push({ path: entry.dir, how: 'purged' });
      } else {
        const { destination, trashId } = await moveToTrash(entry, sessionId, {
          workspaceId: detached[0] ?? null,
          displayTitle,
        });
        removed.push({ path: entry.dir, how: 'trashed', destination, trashId });
      }
    } catch (error) {
      residual.push({ path: entry.dir, error: String(error?.message ?? error) });
    }
  }

  const removedCache = await removeProjectionCache(sessionId);
  const cleared = clearGlobalBookkeeping(ctx, sessionId);

  // A live write handle can recreate the directory right after removal.
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const entry of targets) {
    if (existsSync(entry.dir)) residual.push({ path: entry.dir, error: 'reappeared (live session handle)' });
  }

  return {
    ok: residual.length === 0,
    code: residual.length === 0 ? 'deleted' : 'partial',
    sessionId,
    mode,
    busy,
    stopped,
    evicted,
    detachedWorkspaces: detached,
    clearedBookkeeping: cleared,
    trashId: removed.find((entry) => entry.trashId)?.trashId ?? null,
    removed,
    removedCache,
    residual,
  };
}

/* ------------------------------------------------------------------ routes */

export function apply(ctx, entryConfig) {
  const webServer = ctx.webServer ?? ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    return () => {};
  }

  const logger = typeof ctx.logger === 'function' ? ctx.logger('session-manager') : undefined;

  /* A workspace's session ids are gone the moment it is deleted, so keep the
     last known membership in memory and act on it when the delete lands. */
  const workspaceCache = new Map();
  const rememberWorkspaces = () => {
    let workspaces = [];
    try {
      workspaces = ctx.get('workspaceRegistry')?.list() ?? [];
    } catch {
      return;
    }
    for (const workspace of workspaces) {
      const id = String(workspace.id ?? '');
      if (!id) continue;
      workspaceCache.set(id, {
        id,
        path: workspace.path ?? null,
        title: workspace.title ?? null,
        sessionIds: (workspace.sessionIds ?? []).map(String),
      });
    }
  };

  const onDomainChanged = (change) => {
    if (!change || change.domain !== 'workspace' || change.table !== 'workspaces') return;
    if (change.operation === 'put') {
      const record = change.value ?? {};
      workspaceCache.set(String(change.key), {
        id: String(change.key),
        path: record.path ?? null,
        title: record.title ?? null,
        sessionIds: (record.sessionIds ?? []).map(String),
      });
      return;
    }
    if (change.operation !== 'deleted') return;
    const known = workspaceCache.get(String(change.key));
    workspaceCache.delete(String(change.key));
    if (!known) return;
    void (async () => {
      try {
        const settings = await effectiveConfig(entryConfig);
        lastPolicyRun = await applyWorkspaceDeletePolicy(ctx, known, settings);
        logger?.info?.(
          `workspace ${known.id} deleted → ${settings.workspaceDeleteMode} (${lastPolicyRun.results?.length ?? 0} sessions)`,
        );
      } catch (error) {
        logger?.warn?.(`workspace delete policy failed: ${String(error?.message ?? error)}`);
      }
    })();
  };

  /** Shared guard: loopback, method, intent header, same-origin. True = handled. */
  function reject(req, res, method) {
    const remote = req.socket?.remoteAddress ?? '';
    if (!LOOPBACK.has(remote)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback only' });
      return true;
    }
    if (req.method !== method) {
      res.setHeader('Allow', method);
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' });
      return true;
    }
    if (String(req.headers[INTENT_HEADER] ?? '') !== '1') {
      sendJson(res, 400, { ok: false, code: 'missing-intent-header' });
      return true;
    }
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== host) {
        sendJson(res, 403, { ok: false, code: 'forbidden', message: 'cross-origin request' });
        return true;
      }
    }
    return false;
  }

  async function bodyOf(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
  }

  const deleteHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const sessionId = body?.sessionId;
      if (!validSessionId(sessionId)) {
        sendJson(res, 400, {
          ok: false,
          code: 'invalid-session-id',
          message: 'sessionId must be a plain identifier',
        });
        return;
      }
      const mode = body?.mode === 'purge' ? 'purge' : 'trash';
      const displayTitle = typeof body?.displayTitle === 'string' ? body.displayTitle.slice(0, 300) : null;
      const result = await deleteSession(ctx, {
        sessionId,
        mode,
        dryRun: body?.dryRun === true,
        displayTitle,
      });
      logger?.info?.(`${mode} ${sessionId}: ${result.code ?? 'ok'}`);
      sendJson(res, result.ok ? 200 : result.code === 'not-found' ? 404 : 500, result);
    } catch (error) {
      logger?.warn?.(`delete failed: ${String(error?.message ?? error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
      } else {
        res.end();
      }
    }
  };

  const trashHandler = async (req, res) => {
    try {
      if (reject(req, res, 'GET')) return;
      const entries = await readTrashIndex();
      sendJson(res, 200, {
        ok: true,
        root: trashRoot(),
        entries: entries.map((entry) => ({
          trashId: entry.trashId,
          sessionId: entry.sessionId,
          displayTitle: entry.displayTitle,
          originalPath: entry.originalPath,
          workspaceId: entry.workspaceId,
          sizeBytes: entry.sizeBytes,
          deletedAt: entry.deletedAt,
          restorable: originalPathOf(entry) !== null,
        })),
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  const restoreHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const trashId = body?.trashId;
      const sessionId = body?.sessionId;
      if (trashId !== undefined && !validTrashId(trashId)) {
        sendJson(res, 400, { ok: false, code: 'invalid-trash-id' });
        return;
      }
      if (trashId === undefined && !validSessionId(sessionId)) {
        sendJson(res, 400, { ok: false, code: 'invalid-session-id' });
        return;
      }
      const result = await restoreFromTrash(ctx, { trashId, sessionId });
      logger?.info?.(`restore ${result.trashId ?? trashId ?? sessionId}: ${result.code}`);
      const status = result.ok ? 200 : result.code === 'trash-miss' ? 404 : 409;
      sendJson(res, status, result);
    } catch (error) {
      logger?.warn?.(`restore failed: ${String(error?.message ?? error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
      } else {
        res.end();
      }
    }
  };

  const purgeHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const all = body?.all === true;
      const trashId = body?.trashId;
      if (!all && !validTrashId(trashId)) {
        sendJson(res, 400, { ok: false, code: 'invalid-trash-id' });
        return;
      }
      const result = await purgeTrash({ trashId, all });
      const status = result.ok ? 200 : result.code === 'trash-miss' ? 404 : 500;
      sendJson(res, status, result);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
      } else {
        res.end();
      }
    }
  };

  /**
   * Diagnostics: which Sessions are live in memory right now.
   *
   * `session.list` merges attached Sessions with stored ones, so a deleted
   * Session whose Agent is still attached keeps showing up in every client's
   * sidebar even though its files are gone. This route makes that visible.
   */
  const liveHandler = async (req, res) => {
    try {
      if (reject(req, res, 'GET')) return;
      const store = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions;
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
      const live = store && typeof store.list === 'function' ? store.list().map((session) => String(session.id)) : [];
      const attached = agents && typeof agents.list === 'function' ? agents.list().map((agent) => String(agent.id)) : [];
      let listed;
      try {
        const target = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId');
        if (target) {
          const controller = ctx.get('sessionController');
          const rows = await controller.list({}, undefined);
          const items = Array.isArray(rows) ? rows : Array.isArray(rows?.sessions) ? rows.sessions : [];
          listed = items.some((row) => String(row?.sessionId ?? row?.id) === target);
        }
      } catch {
        listed = undefined;
      }
      sendJson(res, 200, { ok: true, live, agents: attached, listed });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  /** Detach one Session from the in-memory store by disposing its Agent scope. */
  const evictHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      if (!validSessionId(body?.sessionId)) {
        sendJson(res, 400, { ok: false, code: 'invalid-session-id' });
        return;
      }
      const report = await evictLiveAgent(ctx, body.sessionId);
      sendJson(res, 200, { ok: true, sessionId: body.sessionId, ...report });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  /** Effective settings, and the one place the settings page writes them. */
  const configHandler = async (req, res) => {
    try {
      if (reject(req, res, req.method === 'POST' ? 'POST' : 'GET')) return;
      if (req.method !== 'POST') {
        sendJson(res, 200, {
          ok: true,
          config: await effectiveConfig(entryConfig),
          defaults: DEFAULT_CONFIG,
          file: configFile(),
          modes: {
            workspaceDeleteMode: [...WORKSPACE_DELETE_MODES],
            deleteMode: [...DELETE_MODES],
          },
        });
        return;
      }
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const stored = await writeStoredConfig(body ?? {});
      sendJson(res, 200, { ok: true, stored, config: await effectiveConfig(entryConfig) });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  const sessionsHandler = async (req, res) => {
    try {
      if (reject(req, res, 'GET')) return;
      const listing = await listSessions(ctx);
      sendJson(res, 200, { ok: true, ...listing, lastPolicy: lastPolicyRun });
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  const batchDeleteHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.slice(0, 200) : [];
      if (sessionIds.length === 0) {
        sendJson(res, 400, { ok: false, code: 'no-sessions' });
        return;
      }
      const mode = body?.mode === 'purge' ? 'purge' : body?.mode === 'trash' ? 'trash' : (await effectiveConfig(entryConfig)).deleteMode;
      const outcome = await deleteSessions(ctx, sessionIds, mode);
      logger?.info?.(`batch ${mode}: ${outcome.code} (${sessionIds.length})`);
      sendJson(res, outcome.ok ? 200 : 500, outcome);
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  const batchArchiveHandler = async (req, res) => {
    try {
      if (reject(req, res, 'POST')) return;
      let body;
      try {
        body = await bodyOf(req);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid-json' });
        return;
      }
      const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.slice(0, 200) : [];
      if (sessionIds.length === 0) {
        sendJson(res, 400, { ok: false, code: 'no-sessions' });
        return;
      }
      const outcome = await setArchived(ctx, sessionIds, body?.archived !== false);
      sendJson(res, outcome.ok ? 200 : 500, outcome);
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    }
  };

  return ctx.effect(() => {
    rememberWorkspaces();
    const disposers = [
      ctx.on('domain/changed', onDomainChanged),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/delete`, handler: deleteHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/trash`, handler: trashHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/restore`, handler: restoreHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/trash/purge`, handler: purgeHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/live`, handler: liveHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/evict`, handler: evictHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/config`, handler: configHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/sessions`, handler: sessionsHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/batch/delete`, handler: batchDeleteHandler }),
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/batch/archive`, handler: batchArchiveHandler }),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* already gone */
        }
      }
    };
  });
}
