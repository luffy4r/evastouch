// services/email.js
//
// Sends the order notification email to the store owner via Resend's HTTPS API.
// No Shopify order or draft order is created — this is purely a notification
// email containing everything needed to manually process the COD order.
//
// We use Resend (instead of Gmail/Nodemailer) because cloud hosts like Render
// often block outbound SMTP connections (port 587/465) to Gmail, causing
// indefinite hangs. Resend works over plain HTTPS, which always works.

const fetch = require('node-fetch');

const RESEND_API_URL = 'https://api.resend.com/emails';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds the HTML body of the order notification email.
 */
function buildOrderEmailHtml(order) {
  const {
    customer,
    items,
    subtotal,
    delivery,
    shippingCost,
    total,
    orderDate,
  } = order;

  const itemsRows = items
    .map(
      (item) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #f0d9e0;">${escapeHtml(item.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #f0d9e0;">${escapeHtml(item.variant || '-')}</td>
      <td style="padding:8px;border-bottom:1px solid #f0d9e0;text-align:center;">${escapeHtml(item.quantity)}</td>
      <td style="padding:8px;border-bottom:1px solid #f0d9e0;text-align:right;">${escapeHtml(item.price)} DA</td>
    </tr>`
    )
    .join('');

  const deliveryDetailsRow =
    delivery.type === 'desk'
      ? `<tr><td style="padding:6px 0;color:#888;">Point de retrait</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(delivery.deskName)}</td></tr>`
      : `<tr><td style="padding:6px 0;color:#888;">Adresse complète</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(delivery.address)}</td></tr>`;

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:linear-gradient(135deg,#f8c8d4,#fbe4ea);padding:24px;text-align:center;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;color:#7a2e44;font-size:22px;">🌸 Nouvelle commande Eva's Touch 🌸</h1>
      <p style="margin:6px 0 0;color:#7a2e44;font-size:13px;">${escapeHtml(orderDate)}</p>
    </div>

    <div style="padding:20px;border:1px solid #f0d9e0;border-top:none;">
      <h2 style="color:#7a2e44;font-size:16px;border-bottom:2px solid #f8c8d4;padding-bottom:6px;">👤 Informations client</h2>
      <table style="width:100%;font-size:14px;">
        <tr><td style="padding:6px 0;color:#888;width:140px;">Nom complet</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(customer.firstName)} ${escapeHtml(customer.lastName)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Téléphone</td><td style="padding:6px 0;font-weight:600;"><a href="tel:${escapeHtml(customer.phone)}" style="color:#c45a78;text-decoration:none;">${escapeHtml(customer.phone)}</a></td></tr>
      </table>

      <h2 style="color:#7a2e44;font-size:16px;border-bottom:2px solid #f8c8d4;padding-bottom:6px;margin-top:24px;">🛍️ Produits commandés</h2>
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead>
          <tr style="background:#fbe4ea;">
            <th style="padding:8px;text-align:left;color:#7a2e44;">Produit</th>
            <th style="padding:8px;text-align:left;color:#7a2e44;">Variante</th>
            <th style="padding:8px;text-align:center;color:#7a2e44;">Qté</th>
            <th style="padding:8px;text-align:right;color:#7a2e44;">Prix</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>

      <h2 style="color:#7a2e44;font-size:16px;border-bottom:2px solid #f8c8d4;padding-bottom:6px;margin-top:24px;">🚚 Livraison</h2>
      <table style="width:100%;font-size:14px;">
        <tr><td style="padding:6px 0;color:#888;width:140px;">Wilaya</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(delivery.wilayaName)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Commune</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(delivery.communeName)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Type</td><td style="padding:6px 0;font-weight:600;">${delivery.type === 'desk' ? 'Bureau Yalidine 🏢' : 'Domicile 🏠'}</td></tr>
        ${deliveryDetailsRow}
      </table>

      <h2 style="color:#7a2e44;font-size:16px;border-bottom:2px solid #f8c8d4;padding-bottom:6px;margin-top:24px;">💰 Récapitulatif prix</h2>
      <table style="width:100%;font-size:14px;">
        <tr><td style="padding:6px 0;color:#888;">Sous-total</td><td style="padding:6px 0;text-align:right;">${escapeHtml(subtotal)} DA</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Livraison</td><td style="padding:6px 0;text-align:right;">${escapeHtml(shippingCost)} DA</td></tr>
        <tr style="border-top:2px solid #f8c8d4;"><td style="padding:10px 0;font-weight:700;color:#7a2e44;">TOTAL (COD)</td><td style="padding:10px 0;text-align:right;font-weight:700;color:#7a2e44;font-size:18px;">${escapeHtml(total)} DA</td></tr>
      </table>
    </div>

    <div style="text-align:center;padding:16px;color:#aaa;font-size:11px;">
      Email généré automatiquement par le système de commande Eva's Touch
    </div>
  </div>`;
}

/**
 * Builds a plain-text fallback version of the email.
 */
function buildOrderEmailText(order) {
  const { customer, items, subtotal, delivery, shippingCost, total, orderDate } = order;

  const itemsText = items
    .map((i) => `- ${i.name} (${i.variant || 'sans variante'}) x${i.quantity} — ${i.price} DA`)
    .join('\n');

  const deliveryDetail =
    delivery.type === 'desk'
      ? `Bureau Yalidine: ${delivery.deskName}`
      : `Adresse: ${delivery.address}`;

  return `NOUVELLE COMMANDE EVA'S TOUCH
${orderDate}

CLIENT
Nom: ${customer.firstName} ${customer.lastName}
Téléphone: ${customer.phone}

PRODUITS
${itemsText}

LIVRAISON
Wilaya: ${delivery.wilayaName}
Commune: ${delivery.communeName}
Type: ${delivery.type === 'desk' ? 'Bureau Yalidine' : 'Domicile'}
${deliveryDetail}

PRIX
Sous-total: ${subtotal} DA
Livraison: ${shippingCost} DA
TOTAL: ${total} DA
`;
}

/**
 * Sends the order notification email via Resend's HTTPS API.
 * @param {Object} order - normalized order object (see buildOrderEmailHtml for shape)
 */
async function sendOrderEmail(order) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ORDER_NOTIFICATION_EMAIL;

  if (!apiKey || apiKey === 'your_resend_api_key') {
    throw new Error(
      'Resend API key is not configured. Set RESEND_API_KEY in your environment variables.'
    );
  }
  if (!to) {
    throw new Error('ORDER_NOTIFICATION_EMAIL is not configured.');
  }

  // Using Resend's shared test sender. This works immediately with no DNS
  // setup. Once you verify your own domain on Resend, you can change this
  // to something like "Eva's Touch <commandes@evastouch.com>".
  const from = process.env.RESEND_FROM_EMAIL || "Eva's Touch <onboarding@resend.dev>";

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Nouvelle commande Eva's Touch 🌸",
      text: buildOrderEmailText(order),
      html: buildOrderEmailHtml(order),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${errBody}`);
  }

  return res.json();
}

module.exports = { sendOrderEmail };
