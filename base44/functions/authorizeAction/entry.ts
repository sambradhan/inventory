import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { getSecurityConfig, getSettings, getStaff, hashPin, logAudit, round2 } from '../../shared/staff.ts';

/**
 * Verifies the owner's approval PIN and issues a single-use, short-lived
 * authorisation for a price reveal, a price override, or an above-limit
 * discount. Every attempt — success or failure — is written to the audit log,
 * and more than five failures inside the window raises a security alert.
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const purpose = String(body.purpose || '');
    const pin = String(body.pin || '');
    const productId = body.product_id ? String(body.product_id) : '';
    const reason = String(body.reason || '').trim();

    if (!['price_reveal', 'price_override', 'discount'].includes(purpose)) {
      return Response.json({ error: 'Unknown authorisation purpose' }, { status: 400 });
    }
    if (pin.length < 4 || pin.length > 32) {
      return Response.json({ error: 'Enter the approval password' }, { status: 400 });
    }

    const [settings, staff, config] = await Promise.all([
      getSettings(base44),
      getStaff(base44, user),
      getSecurityConfig(base44),
    ]);

    if (!config?.pin_hash || !config?.pin_salt) {
      return Response.json(
        { error: 'No approval password is configured yet. The owner must set one in Settings.', code: 'no_pin' },
        { status: 409 }
      );
    }

    if (!staff.is_active) {
      return Response.json({ error: 'This staff account is disabled.' }, { status: 403 });
    }

    // ---- rate limiting: more than five failures in the window locks the gate ----
    const windowMinutes = Number(config.lock_window_minutes) || 10;
    const maxAttempts = Number(config.max_failed_attempts) || 5;
    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const recent = await base44.asServiceRole.entities.AuditLog.filter(
      { action: 'authorization_failed', actor_id: user.id, created_date: { $gte: since } },
      { limit: 50 }
    );
    const failedCount = recent?.items?.length || 0;

    if (failedCount >= maxAttempts) {
      const alertCheck = await base44.asServiceRole.entities.AuditLog.filter(
        { action: 'security_alert', created_date: { $gte: since } },
        { limit: 10 }
      );
      if (!alertCheck?.items?.some((row) => row.actor_id === user.id)) {
        await logAudit(base44, {
          action: 'security_alert',
          description: `More than ${maxAttempts} incorrect approval passwords entered at the counter. Authorization locked for ${windowMinutes} minutes.`,
          severity: 'critical',
          actor: user,
          meta: { failed_attempts: failedCount, locked_minutes: windowMinutes },
        });
      }
      return Response.json(
        {
          error: `Too many incorrect attempts. Approval is locked for ${windowMinutes} minutes — a security alert has been raised.`,
          code: 'locked',
        },
        { status: 429 }
      );
    }

    const candidate = await hashPin(pin, config.pin_salt);
    if (candidate !== config.pin_hash) {
      await logAudit(base44, {
        action: 'authorization_failed',
        description: `Incorrect approval password entered (${purpose.replace('_', ' ')}).`,
        severity: 'warning',
        actor: user,
        meta: { purpose, attempt: failedCount + 1 },
      });
      return Response.json({
        ok: false,
        error: 'Incorrect approval password.',
        attempts_left: Math.max(0, maxAttempts - (failedCount + 1)),
      });
    }

    // ---- authorised ----
    let product = null;
    if (productId) {
      product = await base44.asServiceRole.entities.Product.get(productId).catch((e) =>
        e.status === 404 ? null : Promise.reject(e)
      );
      if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
    }

    if (purpose === 'price_reveal') {
      if (!product) return Response.json({ error: 'Product is required' }, { status: 400 });
      await logAudit(base44, {
        action: 'price_revealed',
        description: `Selling price of ${product.name} (${product.code}) was revealed at the counter with owner approval.`,
        severity: 'info',
        actor: user,
        meta: { product_id: product.id, product_code: product.code, approved_by: config.pin_owner_name || 'Owner' },
      });
      return Response.json({
        ok: true,
        purpose,
        product_id: product.id,
        selling_price: Number(product.selling_price) || 0,
      });
    }

    if (purpose === 'price_override') {
      if (!product) return Response.json({ error: 'Product is required' }, { status: 400 });
      if (!settings.allow_price_override) {
        return Response.json({ error: 'Price overrides are disabled in settings.' }, { status: 403 });
      }
      const newPrice = round2(body.new_price);
      if (!(newPrice > 0)) return Response.json({ error: 'Enter the approved price' }, { status: 400 });
      if (settings.require_override_reason && reason.length < 3) {
        return Response.json({ error: 'A reason is required for a price override.' }, { status: 400 });
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const approval = await base44.asServiceRole.entities.Approval.create({
        token,
        purpose,
        product_id: product.id,
        product_name: product.name,
        master_price: Number(product.selling_price) || 0,
        approved_price: newPrice,
        reason,
        requested_by_id: user.id,
        requested_by_name: staff.full_name,
        authorized_by_id: config.pin_owner_id || '',
        authorized_by_name: config.pin_owner_name || 'Owner',
        expires_at: expiresAt,
        used: false,
      });

      await logAudit(base44, {
        action: 'price_override_approved',
        description: `Price override approved for ${product.name} (${product.code}): ${product.selling_price} → ${newPrice}.`,
        severity: 'warning',
        actor: user,
        meta: {
          approval_id: approval.id,
          product_id: product.id,
          original_price: Number(product.selling_price) || 0,
          approved_price: newPrice,
          reason,
        },
      });

      return Response.json({
        ok: true,
        purpose,
        token,
        expires_at: expiresAt,
        product_id: product.id,
        master_price: Number(product.selling_price) || 0,
        approved_price: newPrice,
        authorized_by_name: config.pin_owner_name || 'Owner',
      });
    }

    // bill-level discount above the cashier limit
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await base44.asServiceRole.entities.Approval.create({
      token,
      purpose: 'discount',
      reason,
      requested_by_id: user.id,
      requested_by_name: staff.full_name,
      authorized_by_id: config.pin_owner_id || '',
      authorized_by_name: config.pin_owner_name || 'Owner',
      expires_at: expiresAt,
      used: false,
    });

    await logAudit(base44, {
      action: 'discount_approved',
      description: `Above-limit bill discount approved at the counter${reason ? `: ${reason}` : ''}.`,
      severity: 'warning',
      actor: user,
      meta: { reason },
    });

    return Response.json({
      ok: true,
      purpose,
      token,
      expires_at: expiresAt,
      authorized_by_name: config.pin_owner_name || 'Owner',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}