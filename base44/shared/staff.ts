export const DEFAULT_SETTINGS = {
  shop_name: '',
  address: '',
  phone: '',
  email: '',
  pan_vat: '',
  currency: 'Rs',
  invoice_prefix: 'INV',
  receipt_footer: 'Thank you for shopping with us.',
  tax_percent: 0,
  tax_enabled: false,
  cashier_max_discount_percent: 5,
  allow_cashier_price_override: true,
  require_override_reason: true,
  allow_price_override: true,
  low_stock_threshold: 10,
};

export const PAYMENT_METHODS = ['cash', 'esewa', 'fonepay', 'card', 'credit'];

export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export async function getSettings(base44) {
  const rows = await base44.asServiceRole.entities.ShopSettings.list();
  const row = Array.isArray(rows) ? rows[0] : rows?.items?.[0];
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

export async function getSecurityConfig(base44) {
  const rows = await base44.asServiceRole.entities.SecurityConfig.list();
  const row = Array.isArray(rows) ? rows[0] : rows?.items?.[0];
  return row || null;
}

export async function getStaff(base44, user) {
  const isAdmin = user.role === 'admin';
  let record = null;
  const rows = await base44.asServiceRole.entities.User.filter({ email: user.email });
  const list = Array.isArray(rows) ? rows : rows?.items || [];
  record = list[0] || null;

  const maxDiscount =
    typeof record?.max_discount_percent === 'number'
      ? record.max_discount_percent
      : isAdmin
        ? 100
        : DEFAULT_SETTINGS.cashier_max_discount_percent;

  return {
    id: user.id,
    email: user.email,
    full_name: record?.full_name || user.full_name || user.email,
    role: user.role,
    is_admin: isAdmin,
    staff_role: record?.staff_role || (isAdmin ? 'owner' : 'cashier'),
    job_title: record?.job_title || '',
    max_discount_percent: Math.max(0, Math.min(100, maxDiscount)),
    can_override_price: typeof record?.can_override_price === 'boolean' ? record.can_override_price : true,
    can_reveal_price: typeof record?.can_reveal_price === 'boolean' ? record.can_reveal_price : true,
    is_active: typeof record?.is_active === 'boolean' ? record.is_active : true,
  };
}

export async function hashPin(pin, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function logAudit(base44, entry) {
  try {
    await base44.asServiceRole.entities.AuditLog.create({
      action: entry.action,
      description: entry.description || '',
      severity: entry.severity || 'info',
      actor_id: entry.actor?.id || '',
      actor_name: entry.actor?.full_name || entry.actor?.email || '',
      actor_email: entry.actor?.email || '',
      actor_role: entry.actor?.role || '',
      meta: entry.meta || {},
    });
  } catch (error) {
    // auditing must never break a business operation
    console.log('audit write failed', error?.message);
  }
}

export function nextInvoiceNumber(settings, existingCount) {
  const prefix = (settings.invoice_prefix || 'INV').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return `${prefix}-${String(existingCount + 1).padStart(6, '0')}`;
}

export async function fetchSalesPage(base44, query) {
  const collected = [];
  let cursor;
  for (let page = 0; page < 8; page += 1) {
    const options = { sort: '-created_date', limit: 500 };
    if (cursor) options.cursor = cursor;
    const result = await base44.asServiceRole.entities.Sale.filter(query, options);
    const items = result?.items || [];
    collected.push(...items);
    cursor = result?.next_cursor;
    if (!result?.has_more || !cursor) break;
  }
  return collected;
}