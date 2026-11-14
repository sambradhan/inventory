import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { logAudit, round2 } from '../../shared/staff.ts';

/** Owner-only product create/update with code uniqueness and price validation. */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const code = String(body.code || '').trim();
    const sellingPrice = round2(body.selling_price);
    const purchasePrice = round2(body.purchase_price);

    if (name.length < 2) return Response.json({ error: 'Product name is too short.' }, { status: 400 });
    if (code.length < 2) return Response.json({ error: 'Product code is too short.' }, { status: 400 });
    if (!/[^A-Za-z0-9]/.test(code)) {
      return Response.json(
        { error: 'The product code must include at least one special character, e.g. AM-BTR#100.' },
        { status: 400 }
      );
    }
    if (!(sellingPrice >= 0)) return Response.json({ error: 'Selling price must be zero or more.' }, { status: 400 });
    if (!(purchasePrice >= 0)) return Response.json({ error: 'Purchase price must be zero or more.' }, { status: 400 });

    const all = await base44.asServiceRole.entities.Product.filter({}, { limit: 800 });
    const rows = all?.items || [];
    const clash = rows.find(
      (row) => String(row.code || '').trim().toLowerCase() === code.toLowerCase() && row.id !== body.id
    );
    if (clash) {
      return Response.json({ error: `The code ${code} is already used by ${clash.name}.` }, { status: 409 });
    }

    const payload = {
      name,
      code,
      part_number: String(body.part_number || '').trim(),
      oem_number: String(body.oem_number || '').trim(),
      brand: String(body.brand || '').trim(),
      condition: ['new', 'used', 'refurbished'].includes(body.condition) ? body.condition : 'new',
      category: String(body.category || '').trim(),
      vehicle_make: String(body.vehicle_make || '').trim(),
      vehicle_model: String(body.vehicle_model || '').trim(),
      year_from: Math.max(0, Number(body.year_from) || 0),
      year_to: Math.max(0, Number(body.year_to) || 0),
      unit: String(body.unit || 'pcs').trim() || 'pcs',
      purchase_price: purchasePrice,
      selling_price: sellingPrice,
      stock: round2(body.stock),
      reorder_level: round2(body.reorder_level),
      supplier_id: String(body.supplier_id || ''),
      is_active: body.is_active !== false,
      notes: String(body.notes || '').slice(0, 300),
    };

    let product;
    if (body.id) {
      product = await base44.asServiceRole.entities.Product.update(String(body.id), payload);
    } else {
      product = await base44.asServiceRole.entities.Product.create(payload);
    }

    await logAudit(base44, {
      action: body.id ? 'product_updated' : 'product_created',
      description: `${payload.name} (${payload.code}) ${body.id ? 'updated' : 'added to inventory'}.`,
      severity: 'info',
      actor: user,
      meta: { product_id: product.id, selling_price: sellingPrice, purchase_price: purchasePrice },
    });

    return Response.json({ product });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}