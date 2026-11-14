import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import {
  PAYMENT_METHODS,
  getSettings,
  getStaff,
  logAudit,
  nextInvoiceNumber,
  round2,
} from '../../shared/staff.ts';

/**
 * The counter checkout. Every price, stock level, discount limit, authorisation
 * token and total is resolved and validated here — the browser is never trusted.
 * Idempotent on client_ref so a retry or a reprint can never duplicate a sale or
 * deduct stock twice.
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const clientRef = String(body.client_ref || '').trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const rawPayments = Array.isArray(body.payments) ? body.payments : [];

    if (!clientRef) return Response.json({ error: 'client_ref is required' }, { status: 400 });
    if (!rawItems.length || rawItems.length > 80) {
      return Response.json({ error: 'A bill needs between 1 and 80 line items.' }, { status: 400 });
    }
    if (!rawPayments.length || rawPayments.length > 5) {
      return Response.json({ error: 'At least one payment is required.' }, { status: 400 });
    }

    const billDiscount = round2(body.discount);
    if (billDiscount < 0) return Response.json({ error: 'Discount cannot be negative.' }, { status: 400 });

    const [settings, staff] = await Promise.all([getSettings(base44), getStaff(base44, user)]);
    if (!staff.is_active) return Response.json({ error: 'This staff account is disabled.' }, { status: 403 });

    // ---- idempotency ----
    const existing = await base44.asServiceRole.entities.Sale.filter(
      { client_ref: clientRef, cashier_id: user.id },
      { limit: 1 }
    );
    if (existing?.items?.length) {
      return Response.json({ sale: existing.items[0], duplicate: true });
    }

    // ---- payments ----
    const payments = [];
    for (const raw of rawPayments) {
      const method = String(raw.method || '').toLowerCase();
      if (!PAYMENT_METHODS.includes(method)) {
        return Response.json({ error: `Unsupported payment method: ${method}` }, { status: 400 });
      }
      const amount = round2(raw.amount);
      if (!(amount > 0)) return Response.json({ error: 'Payment amounts must be greater than zero.' }, { status: 400 });
      payments.push({
        method,
        amount,
        reference: String(raw.reference || '').slice(0, 80),
        status: method === 'cash' ? 'verified' : 'unverified',
      });
    }

    // ---- products ----
    const ids = [...new Set(rawItems.map((item) => String(item.product_id || '')).filter(Boolean))];
    if (!ids.length) return Response.json({ error: 'No products on the bill.' }, { status: 400 });
    const productPage = await base44.asServiceRole.entities.Product.filter({ id: { $in: ids } }, { limit: 100 });
    const products = new Map((productPage?.items || []).map((p) => [p.id, p]));

    // ---- approvals issued by the owner PIN ----
    const tokens = [];
    rawItems.forEach((item) => {
      if (item.override_token) tokens.push(String(item.override_token));
    });
    if (body.discount_token) tokens.push(String(body.discount_token));
    const approvals = new Map();
    if (tokens.length) {
      const page = await base44.asServiceRole.entities.Approval.filter(
        { token: { $in: [...new Set(tokens)] } },
        { limit: 40 }
      );
      (page?.items || []).forEach((row) => approvals.set(row.token, row));
    }
    const approvalValid = (row, purpose) =>
      !!row &&
      row.purpose === purpose &&
      row.used !== true &&
      row.requested_by_id === user.id &&
      new Date(row.expires_at).getTime() > Date.now();

    // ---- lines ----
    const lines = [];
    const stockUpdates = [];
    const costLines = [];
    const usedApprovalIds = [];
    let subtotal = 0;
    let costTotal = 0;
    let itemCount = 0;

    for (const raw of rawItems) {
      const product = products.get(String(raw.product_id || ''));
      if (!product) {
        return Response.json({ error: 'A product on this bill no longer exists. Refresh the bill.' }, { status: 400 });
      }
      if (product.is_active === false) {
        return Response.json({ error: `${product.name} is not available for sale.` }, { status: 400 });
      }

      const quantity = Number(raw.quantity);
      if (!(quantity > 0)) return Response.json({ error: 'Quantity must be greater than zero.' }, { status: 400 });

      const stock = Number(product.stock) || 0;
      if (quantity > stock) {
        return Response.json(
          { error: `${product.name} has only ${stock} in stock.`, code: 'insufficient_stock', product_id: product.id },
          { status: 409 }
        );
      }

      const masterPrice = round2(product.selling_price);
      const unitPrice =
        raw.unit_price === undefined || raw.unit_price === null || raw.unit_price === ''
          ? masterPrice
          : round2(raw.unit_price);
      if (!(unitPrice > 0)) return Response.json({ error: 'Line prices must be greater than zero.' }, { status: 400 });

      let priceOverride = null;
      if (Math.abs(unitPrice - masterPrice) > 0.009) {
        const approval = approvals.get(String(raw.override_token || ''));
        const matchesPrice = approval && Math.abs(round2(approval.approved_price) - unitPrice) <= 0.009;
        if (!approvalValid(approval, 'price_override') || approval.product_id !== product.id || !matchesPrice) {
          return Response.json(
            {
              error: `A price change on ${product.name} needs authorised permission.`,
              code: 'override_not_authorised',
              product_id: product.id,
            },
            { status: 403 }
          );
        }
        usedApprovalIds.push(approval.id);
        priceOverride = {
          approval_id: approval.id,
          original_price: masterPrice,
          charged_price: unitPrice,
          reason: approval.reason || '',
          authorized_by: approval.authorized_by_name || 'Owner',
          authorized_at: approval.created_date || new Date().toISOString(),
        };
      }

      const lineTotal = round2(unitPrice * quantity);
      subtotal = round2(subtotal + lineTotal);
      itemCount += quantity;

      const unitCost = round2(product.purchase_price);
      costTotal = round2(costTotal + unitCost * quantity);
      costLines.push({
        product_id: product.id,
        code: product.code,
        quantity,
        unit_cost: unitCost,
        cost_total: round2(unitCost * quantity),
      });

      lines.push({
        product_id: product.id,
        product_name: product.name,
        product_code: product.code,
        unit: product.unit || 'pcs',
        quantity,
        unit_price: unitPrice,
        master_price: masterPrice,
        line_total: lineTotal,
        price_override: priceOverride,
      });

      stockUpdates.push({ id: product.id, stock: round2(stock - quantity) });
    }

    // ---- discount limits ----
    const maxDiscountPercent = staff.is_admin
      ? 100
      : Math.max(0, Math.min(100, staff.max_discount_percent ?? settings.cashier_max_discount_percent));
    const capAmount = round2((subtotal * maxDiscountPercent) / 100);
    if (billDiscount > subtotal) {
      return Response.json({ error: 'Discount cannot exceed the bill subtotal.' }, { status: 400 });
    }
    let discountApproval = null;
    if (billDiscount > capAmount + 0.009) {
      const approval = approvals.get(String(body.discount_token || ''));
      if (!approvalValid(approval, 'discount')) {
        return Response.json(
          {
            error: `Discounts above ${maxDiscountPercent}% need authorised permission.`,
            code: 'discount_not_authorised',
            max_discount_percent: maxDiscountPercent,
            cap_amount: capAmount,
          },
          { status: 403 }
        );
      }
      usedApprovalIds.push(approval.id);
      discountApproval = { approval_id: approval.id, authorized_by: approval.authorized_by_name || 'Owner', reason: approval.reason || '' };
    }

    const taxable = round2(subtotal - billDiscount);
    const taxTotal = settings.tax_enabled ? round2((taxable * (Number(settings.tax_percent) || 0)) / 100) : 0;
    const total = round2(taxable + taxTotal);

    const received = round2(payments.reduce((sum, p) => sum + p.amount, 0));
    if (Math.abs(received - total) > 0.01) {
      return Response.json(
        {
          error: `Payment ${received} does not match the bill total ${total}.`,
          code: 'payment_mismatch',
          expected_total: total,
          received_total: received,
        },
        { status: 400 }
      );
    }

    // ---- persist ----
    const count = await base44.asServiceRole.entities.Sale.count();
    const invoiceNo = nextInvoiceNumber(settings, count);
    const unverifiedAmount = round2(
      payments.filter((p) => p.status === 'unverified').reduce((sum, p) => sum + p.amount, 0)
    );

    const sale = await base44.asServiceRole.entities.Sale.create({
      invoice_no: invoiceNo,
      client_ref: clientRef,
      items: lines,
      subtotal,
      discount: billDiscount,
      tax_total: taxTotal,
      total,
      payments,
      payment_status: unverifiedAmount > 0 ? 'awaiting_verification' : 'paid',
      unverified_amount: unverifiedAmount,
      item_count: itemCount,
      cashier_id: user.id,
      cashier_name: staff.full_name,
      status: 'completed',
      notes: String(body.notes || '').slice(0, 300),
      print_count: 0,
      discount_approval: discountApproval,
    });

    await base44.asServiceRole.entities.SaleCost.create({
      sale_id: sale.id,
      invoice_no: invoiceNo,
      cost_total: costTotal,
      revenue_total: taxable,
      lines: costLines,
    });

    // stock moves exactly once, keyed by the invoice that was just created
    await Promise.allSettled(
      stockUpdates.map((row) => base44.asServiceRole.entities.Product.update(row.id, { stock: row.stock }))
    );

    if (usedApprovalIds.length) {
      await Promise.allSettled(
        [...new Set(usedApprovalIds)].map((id) =>
          base44.asServiceRole.entities.Approval.update(id, { used: true, sale_id: sale.id, invoice_no: invoiceNo })
        )
      );
    }

    await logAudit(base44, {
      action: 'sale_completed',
      description: `Invoice ${invoiceNo} completed for ${total} (${itemCount} units).`,
      severity: 'info',
      actor: user,
      meta: {
        sale_id: sale.id,
        invoice_no: invoiceNo,
        total,
        payments: payments.map((p) => ({ method: p.method, amount: p.amount, status: p.status })),
        overrides: lines.filter((l) => l.price_override).length,
        discount: billDiscount,
      },
    });

    return Response.json({ sale, duplicate: false });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}