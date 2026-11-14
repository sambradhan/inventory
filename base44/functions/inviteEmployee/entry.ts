import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { logAudit } from '../../shared/staff.ts';

/** Owner-only: invite a staff member and set their counter permissions. */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const fullName = String(body.full_name || '').trim();
    const role = body.role === 'admin' ? 'admin' : 'user';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    const fields = {
      full_name: fullName || undefined,
      job_title: String(body.job_title || '').trim(),
      phone: String(body.phone || '').trim(),
      staff_role: ['owner', 'manager', 'cashier'].includes(body.staff_role) ? body.staff_role : 'cashier',
      max_discount_percent: Math.max(0, Math.min(100, Number(body.max_discount_percent) || 0)),
      can_override_price: body.can_override_price !== false,
      can_reveal_price: body.can_reveal_price !== false,
      is_active: body.is_active !== false,
    };

    const existing = await base44.asServiceRole.entities.User.filter({ email });
    const existingList = Array.isArray(existing) ? existing : existing?.items || [];

    if (existingList.length) {
      const record = existingList[0];
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      await base44.asServiceRole.entities.User.update(record.id, patch);
      await logAudit(base44, {
        action: 'employee_updated',
        description: `Staff record updated for ${email}.`,
        severity: 'warning',
        actor: user,
        meta: { email, ...patch },
      });
      return Response.json({ ok: true, updated: true, email });
    }

    await base44.users.inviteUser(email, role);

    await logAudit(base44, {
      action: 'employee_invited',
      description: `Invited ${email} as ${role === 'admin' ? 'owner/admin' : 'cashier'}.`,
      severity: 'warning',
      actor: user,
      meta: { email, role, staff_role: fields.staff_role },
    });

    return Response.json({ ok: true, invited: true, email });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}