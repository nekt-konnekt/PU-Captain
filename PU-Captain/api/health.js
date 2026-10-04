import { api, json } from './_lib/http.js';
export default api(['GET'], (req, res) => json(res, 200, { ok: true }), { auth: false });
