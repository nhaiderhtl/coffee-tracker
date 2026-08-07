// SSE connection registry. Each authenticated client holds one or more open
// EventSource connections; we track them by userId so personal events can be
// targeted and global events can be fanned out efficiently.
//
// Events are plain `invalidate` payloads: `{ keys: string[][] }` where each
// entry is a React Query key to invalidate. The client never receives data —
// only signals telling it which cached results are stale.

/** @type {Map<number, Set<import('express').Response>>} */
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

/**
 * Broadcast an invalidate event.
 * @param {string[][]} keys  React Query key arrays to invalidate on the client.
 * @param {number[]=}  userIds  Target users. Omit to send to everyone connected.
 */
function broadcast(keys, userIds) {
  const payload = `event: invalidate\ndata: ${JSON.stringify({ keys })}\n\n`;
  const targets = userIds
    ? userIds.flatMap((id) => [...(clients.get(id) ?? [])])
    : [...clients.values()].flatMap((set) => [...set]);

  for (const res of targets) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

/**
 * Express route handler for GET /api/events.
 * Auth is done by the caller (requireAuthSSE) before this runs.
 */
function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.user.id;
  addClient(userId, res);

  // 25-second heartbeat keeps the connection alive through proxies that close
  // idle streams. A comment line (`: ping`) is invisible to EventSource but
  // resets the proxy timeout.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(userId, res);
  });
}

module.exports = { broadcast, sseHandler };
