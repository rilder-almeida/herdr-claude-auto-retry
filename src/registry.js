
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { monitorsDir, stateDir } from './paths.js';

const STALE_MS = 60_000;

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function lockPath(terminalId) {
  return join(monitorsDir(), `${sanitize(terminalId)}.json`);
}

function disarmedPath() {
  return join(stateDir(), 'disarmed.json');
}

function disarmedLockPath() {
  return join(stateDir(), '.disarmed.lock');
}

// Same exclusive-create-with-retry primitive claimSlot uses for monitor
// records, applied here as a mutex around the disarmed-list read-modify-write
// so two concurrent `arm` toggles (e.g. a fast double keypress) can't race and
// silently drop one of the writes.
function withDisarmedLock(fn) {
  mkdirSync(stateDir(), { recursive: true });
  const lockPath = disarmedLockPath();
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (!acquired) {
    // Stale lock from a crashed process; steal it rather than fail the toggle.
    try { unlinkSync(lockPath); } catch {}
    writeFileSync(lockPath, String(process.pid), { flag: 'w' });
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

function readDisarmedWorkspaces() {
  try {
    const list = JSON.parse(readFileSync(disarmedPath(), 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Explicit per-space opt-out, set by the `arm` toggle when it disarms a space.
// The automatic hooks (event-driven detection and the coverage sweep) check
// this before spawning a monitor, so a space the user turned off does not come
// back on its own the way a plain `stop` would -- only re-arming (via `arm`
// again, or `watch-all`) clears it.
export function isWorkspaceDisarmed(workspaceId) {
  return !!workspaceId && readDisarmedWorkspaces().includes(workspaceId);
}

export function setWorkspaceDisarmed(workspaceId, disarmed) {
  if (!workspaceId) return;
  withDisarmedLock(() => {
    const set = new Set(readDisarmedWorkspaces());
    if (disarmed) set.add(workspaceId); else set.delete(workspaceId);
    writeFileSync(disarmedPath(), JSON.stringify([...set], null, 2));
  });
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function isFresh(rec) {
  return !!rec && isAlive(rec.pid) && Date.now() - (rec.updatedAtMs || 0) < STALE_MS;
}

export function readRecord(terminalId) {
  try {
    return JSON.parse(readFileSync(lockPath(terminalId), 'utf-8'));
  } catch {
    return null;
  }
}

export function claimSlot(rec) {
  mkdirSync(monitorsDir(), { recursive: true });
  const path = lockPath(rec.terminalId);
  const body = JSON.stringify({ ...rec, updatedAtMs: rec.updatedAtMs || Date.now() }, null, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readRecord(rec.terminalId);
      if (isFresh(existing) && existing.pid !== rec.pid) return false;
      removeRecord(rec.terminalId);
    }
  }
  return false;
}

function writeRecord(rec) {
  mkdirSync(monitorsDir(), { recursive: true });
  writeFileSync(lockPath(rec.terminalId), JSON.stringify(rec, null, 2));
}

export function touchRecord(terminalId, patch = {}) {
  const rec = readRecord(terminalId);
  if (!rec) return;
  writeRecord({ ...rec, ...patch, updatedAtMs: Date.now() });
}

export function removeRecord(terminalId) {
  try {
    unlinkSync(lockPath(terminalId));
  } catch {
  }
}

export function listRecords() {
  let files;
  try {
    files = readdirSync(monitorsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(monitorsDir(), file), 'utf-8')));
    } catch {
    }
  }
  return out;
}

export function lockHeldByOther(terminalId, myPid) {
  const rec = readRecord(terminalId);
  return !!(rec && rec.pid !== myPid && isAlive(rec.pid));
}

export function hasActiveMonitor(terminalId) {
  const rec = readRecord(terminalId);
  if (isFresh(rec)) return true;
  if (rec) removeRecord(terminalId);
  return false;
}
