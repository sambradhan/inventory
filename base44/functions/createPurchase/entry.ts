import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { logAudit, round2 } from '../../shared/staff.ts';

/** Owner-only: records a supplier purchase and moves stock in. */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length || rawItems.length > 80) {
      return Response.json({ error: 'A purchase needs between 1 and 80 lines.' }, { status: 400 });
    }

    const supplierId = String(body.supplier_id || '');
    let supplierName = String(body.supplier_name || '').trim();
    if (supplierId) {
      const supplier = await base44.asServiceRole.entities.Supplier.get(supplierId).catch((e) =>
        e.status === 404 ? null : Promise.reject(e)
      );
      if (supplier) supplierName = supplier.name;
    }
    if (!supplierName) return Response.json({ error: 'Choose a supplier.' }, { status: 400 });

    const ids = [...new Set(rawItems.map((i) => String(i.product_id || '')).filter(Boolean))];
    const page = await base44.asServiceRole.entities.Product.filter({ id: { $in: ids } }, { limit: 100 });
    const products = new Map((page?.items || []).map((p) => [p.id, p]));

    const lines = [];
    let subtotal = 0;
    for (const raw of rawItems) {
      const product = products.get(String(raw.product_id || ''));
      if (!product) return Response.json({ error: 'One of the products no longer exists.' }, { status: 400 });
      const quantity = Number(raw.quantity);
      const unitCost = round2(raw.unit_cost);
      if (!(quantity > 0)) return Response.json({ error: 'Quantities must be greater than zero.' }, { status: 400 });
      if (unitCost < 0) return Response.json({ error: 'Unit cost cannot be negative.' }, { status: 400 });
      const lineTotal = round2(quantity * unitCost);
      subtotal = round2(subtotal + lineTotal);
      lines.push({
        product_id: product.id,
        name: product.name,
        code: product.code,
        quantity,
        unit_cost: unitCost,
        line_total: lineTotal,
      });
    }

    const purchase = await base44.asServiceRole.entities.Purchase.create({
      supplier_id: supplierId,
      supplier_name: supplierName,
      invoice_ref: String(body.invoice_ref || '').slice(0, 60),
      purchase_date: String(body.purchase_date || new Date().toISOString().slice(0, 10)),
      items: lines,
      subtotal,
      total: subtotal,
      payment_status: body.payment_status === 'credit' ? 'credit' : 'paid',
      notes: String(body.notes || '').slice(0, 300),
      recorded_by: user.full_name || user.email,
    });

    await Promise.allSettled(
      lines.map(async (line) => {
        const product = products.get(line.product_id);
        const stock = round2((Number(product.stock) || 0) + line.quantity);
        await base44.asServiceRole.entities.Product.update(line.product_id, {
          stock,
          purchase_price: line.unit_cost,
        });
      })
    );

    await logAudit(base44, {
      action: 'purchase_recorded',
      description: `Purchase from ${supplierName} recorded for ${subtotal} (${lines.length} lines).`,
      severity: 'info',
      actor: user,
      meta: { purchase_id: purchase.id, supplier: supplierName, total: subtotal },
    });

    return Response.json({ purchase });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}