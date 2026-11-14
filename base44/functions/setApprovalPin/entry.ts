import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { getSecurityConfig, hashPin, logAudit } from '../../shared/staff.ts';

/** Owner-only: set or replace the counter approval password (stored salted + hashed). */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const pin = String(body.pin || '');
    if (pin.length < 4 || pin.length > 32) {
      return Response.json({ error: 'The approval password must be 4–32 characters.' }, { status: 400 });
    }

    const salt = crypto.randomUUID();
    const pinHash = await hashPin(pin, salt);
    const existing = await getSecurityConfig(base44);

    const payload = {
      pin_hash: pinHash,
      pin_salt: salt,
      pin_owner_id: user.id,
      pin_owner_name: user.full_name || user.email,
      pin_updated_at: new Date().toISOString(),
      max_failed_attempts: Number(body.max_failed_attempts) || existing?.max_failed_attempts || 5,
      lock_window_minutes: Number(body.lock_window_minutes) || existing?.lock_window_minutes || 10,
    };

    const saved = existing
      ? await base44.asServiceRole.entities.SecurityConfig.update(existing.id, payload)
      : await base44.asServiceRole.entities.SecurityConfig.create(payload);

    await logAudit(base44, {
      action: 'approval_password_set',
      description: 'Counter approval password was set or replaced by the owner.',
      severity: 'warning',
      actor: user,
      meta: { owner: payload.pin_owner_name },
    });

    return Response.json({ ok: true, config: { id: saved.id, updated_at: payload.pin_updated_at } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}