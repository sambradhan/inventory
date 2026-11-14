import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { getSettings, getStaff } from '../../shared/staff.ts';

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const [settings, staff] = await Promise.all([getSettings(base44), getStaff(base44, user)]);

    return Response.json({
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
      staff,
      settings: {
        shop_name: settings.shop_name,
        address: settings.address,
        phone: settings.phone,
        email: settings.email,
        pan_vat: settings.pan_vat,
        currency: settings.currency,
        invoice_prefix: settings.invoice_prefix,
        receipt_footer: settings.receipt_footer,
        tax_percent: settings.tax_percent,
        tax_enabled: settings.tax_enabled,
        cashier_max_discount_percent: settings.cashier_max_discount_percent,
        allow_cashier_price_override: settings.allow_cashier_price_override,
        allow_price_override: settings.allow_price_override,
        require_override_reason: settings.require_override_reason,
        low_stock_threshold: settings.low_stock_threshold,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}