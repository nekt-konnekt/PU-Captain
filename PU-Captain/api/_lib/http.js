import { requireUser } from './auth.js';

export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Wraps a handler with method check, auth, role check and safe error output. */
export function api(methods, fn, { auth = true, roles = null } = {}) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        return json(res, 405, { error: 'method_not_allowed' });
      }
      let user = null;
      if (auth) {
        user = await requireUser(req);
        if (!user) return json(res, 401, { error: 'unauthorized' });
        if (roles && !roles.includes(user.role)) return json(res, 403, { error: 'forbidden' });
      }
      await fn(req, res, user);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.code });
      console.error('api_error', e?.message);
      json(res, 500, { error: 'server_error' });
    }
  };
}
