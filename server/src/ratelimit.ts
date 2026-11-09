import type { FastifyReply, FastifyRequest } from "fastify";

/** Fixed-window in-memory limiter keyed by client IP. Fine for a single server process. */
export function rateLimit(opts: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const key = req.ip;
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, e);
    }
    e.count++;
    if (e.count > opts.max) {
      reply.header("retry-after", Math.ceil((e.resetAt - now) / 1000));
      return reply.code(429).send({ error: "too many requests, try again later" });
    }
  };
}
