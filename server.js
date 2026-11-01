// server.js
//
// Eva's Touch — Custom COD checkout backend
// Endpoints:
//   GET  /api/wilayas
//   GET  /api/communes?wilaya_id=XX
//   GET  /api/centers?commune_id=XX
//   GET  /api/delivery-pricing?to_wilaya_id=XX&commune_id=YY
//   POST /api/order  (validates + creates a real Shopify order)
//   GET  /api/orders (lists recent Shopify orders, for the tracking dashboard)
//   GET  /health
//
// NOTE: Shopify Admin API logic is inlined directly in this file (instead of
// a separate shopify.js module) to avoid any risk of "Cannot find module"
// errors from filename casing issues on different filesystems/deploy targets.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { sendOrderEmail } = require('./email');

const yalidine = require('./yalidine');
const { validateOrder } = require('./validate');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. ON OUVRE LA SÉCURITÉ EN TOUT PREMIER (C'est ce qui bloquait !)
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// =====================================================
// GESTION DU STOCK (CONNEXION GOOGLE SHEETS)
// =====================================================
const { google } = require('googleapis');

// Configuration du robot Google
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Route permettant au site de lire le stock en direct dans ton tableau
app.get('/api/stock', async (req, res) => {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Stock!A2:B50', // Lit les colonnes A (Couleurs) et B (Quantités) à partir de la ligne 2
        });
        
        const rows = response.data.values;
        let currentStock = {};
        
        if (rows && rows.length) {
            rows.forEach(row => {
                if (row[0] && row[1] !== undefined) {
                    currentStock[row[0]] = parseInt(row[1], 10);
                }
            });
        }
        
        res.json({ success: true, stock: currentStock });
    } catch (error) {
        console.error("Erreur de connexion à Google Sheets :", error);
        res.json({ success: false, stock: {} });
    }
});


// =====================================================
// EXPRESS APP SETUP
// =====================================================

app.use(express.json({ limit: '1mb' }));

// ---- Rate limiting on the order submission endpoint ----
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Veuillez réessayer dans quelques minutes.' },
});

// =====================================================
// SHOPIFY ADMIN API (inlined — client credentials grant)
// =====================================================
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // e.g. "evastouch" (without .myshopify.com)
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

let shopifyCachedToken = null;
let shopifyTokenExpiresAt = 0;

function assertShopifyConfigured() {
  if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'Shopify credentials are not configured. Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in your environment variables.'
    );
  }
}

async function getShopifyAccessToken() {
  assertShopifyConfigured();

  if (shopifyCachedToken && Date.now() < shopifyTokenExpiresAt - 60_000) {
    return shopifyCachedToken;
  }

  const response = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Shopify token exchange failed (${response.status}): ${body}`);
  }

  const { access_token, expires_in } = await response.json();
  shopifyCachedToken = access_token;
  shopifyTokenExpiresAt = Date.now() + expires_in * 1000;
  return shopifyCachedToken;
}

async function shopifyGraphql(query, variables = {}) {
  const token = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Shopify GraphQL request failed (${response.status}): ${body}`);
  }

  const { data, errors } = await response.json();
  if (errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  }
  return data;
}

/**
 * Looks up an existing customer by phone number. Shopify treats phone as a
 * unique identifier, so re-using toUpsert with a phone that's already
 * attached to a customer throws "Phone number has already been taken".
 * Finding the existing customer first and linking by id avoids that.
 */
async function findCustomerByPhone(phone) {
  const query = `
    query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node { id }
        }
      }
    }
  `;
  const data = await shopifyGraphql(query, { query: `phone:${phone}` });
  const edge = data.customers.edges[0];
  return edge ? edge.node.id : null;
}

/**
 * Creates a real Shopify order from a validated COD order payload.
 * - Marked PENDING (cash is collected by Yalidine on delivery, not paid upfront).
 * - Left unfulfilled, shows as "Unfulfilled" / "Non traitée" in Shopify Admin.
 */
async function createShopifyOrder(order) {
  const { customer, items, delivery, shippingCost } = order;

  const lineItems = items.map((item) => {
    if (item.variantId) {
      return {
        variantId: `gid://shopify/ProductVariant/${item.variantId}`,
        quantity: item.quantity,
        // Even though the variant itself is set to "requires shipping" in
        // the product admin, orderCreate doesn't reliably inherit that —
        // it must be forced explicitly here, or the order shows up as
        // "Shipping not required" with no fulfillment options.
        requiresShipping: true,
      };
    }
    return {
      title: item.variant ? `${item.name} - ${item.variant}` : item.name,
      quantity: item.quantity,
      requiresShipping: true,
      priceSet: {
        shopMoney: { amount: String(item.price), currencyCode: 'DZD' },
      },
    };
  });

  const shippingLine = shippingCost
    ? {
        title: delivery.type === 'desk' ? 'Livraison au bureau Yalidine' : 'Livraison à domicile',
        priceSet: {
          shopMoney: { amount: String(shippingCost), currencyCode: 'DZD' },
        },
      }
    : null;

  const noteParts = [
    `Wilaya: ${delivery.wilayaName}`,
    `Commune: ${delivery.communeName}`,
    delivery.type === 'desk'
      ? `Bureau Yalidine: ${delivery.deskName || '-'}`
      : `Adresse: ${delivery.address || '-'}`,
    `Téléphone: ${customer.phone}`,
  ];

  const mutation = `
    mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput, $idempotencyKey: String!) {
      orderCreate(order: $order, options: $options) @idempotent(key: $idempotencyKey) {
        order {
          id
          name
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const idempotencyKey = order.idempotencyKey || crypto.randomUUID();

  // Shopify requires an email (or existing customer id) to create/link a
  // customer record. Since our popup only collects a phone number, we
  // generate a stable placeholder email from the phone number. This keeps
  // the customer record real and re-usable (same phone = same customer on
  // repeat orders) without requiring an email field in the popup.
  const placeholderEmail = `${customer.phone.replace(/\D/g, '')}@evastouch-cod.local`;

  // Phone numbers are unique per customer in Shopify. If this phone is
  // already attached to a customer, toUpsert-ing it again throws "Phone
  // number has already been taken". So we look the customer up first and
  // link by id when found, instead of re-submitting the phone.
  const existingCustomerId = await findCustomerByPhone(customer.phone);
  const customerField = existingCustomerId
    ? { toAssociate: { id: existingCustomerId } }
    : {
        toUpsert: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phone,
          email: placeholderEmail,
        },
      };

  const variables = {
    idempotencyKey,
    // Without this, orderCreate defaults to "BYPASS" and never touches
    // inventory at all — this is why stock wasn't decreasing. obeyingPolicy
    // respects each product's "continue selling when out of stock" setting.
    options: {
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
    },
    order: {
      lineItems,
      shippingLines: shippingLine ? [shippingLine] : [],
      financialStatus: 'PENDING',
      note: noteParts.join(' | '),
      tags: ["COD", "Eva's Touch popup"],
      customer: customerField,
      shippingAddress: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        address1: delivery.type === 'home' ? delivery.address || '' : (delivery.deskName || ''),
        city: delivery.communeName,
        province: delivery.wilayaName,
        country: 'Algeria',
        countryCode: 'DZ',
      },
    },
  };

  const data = await shopifyGraphql(mutation, variables);
  const result = data.orderCreate;

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`Shopify order creation errors: ${JSON.stringify(result.userErrors)}`);
  }

  return result.order; // { id, name }
}

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =====================================================
// YALIDINE: WILAYAS
// =====================================================
app.get('/api/wilayas', async (req, res) => {
  try {
    const wilayas = await yalidine.getWilayas();
    res.json({ success: true, data: wilayas });
  } catch (err) {
    console.error('Error fetching wilayas:', err.message);
    res.status(500).json({ success: false, error: 'Impossible de charger les wilayas.' });
  }
});

// =====================================================
// YALIDINE: COMMUNES (by wilaya)
// =====================================================
app.get('/api/communes', async (req, res) => {
  const { wilaya_id } = req.query;
  if (!wilaya_id) {
    return res.status(400).json({ success: false, error: 'wilaya_id est requis.' });
  }
  try {
    const communes = await yalidine.getCommunes(wilaya_id);
    res.json({ success: true, data: communes });
  } catch (err) {
    console.error('Error fetching communes:', err.message);
    res.status(500).json({ success: false, error: 'Impossible de charger les communes.' });
  }
});

// =====================================================
// YALIDINE: CENTERS / STOP DESKS (by commune)
// =====================================================
app.get('/api/centers', async (req, res) => {
  const { commune_id } = req.query;
  if (!commune_id) {
    return res.status(400).json({ success: false, error: 'commune_id est requis.' });
  }
  try {
    const centers = await yalidine.getCenters(commune_id);
    res.json({ success: true, data: centers });
  } catch (err) {
    console.error('Error fetching centers:', err.message);
    res.status(500).json({ success: false, error: 'Impossible de charger les bureaux Yalidine.' });
  }
});

// =====================================================
// YALIDINE: DELIVERY PRICING (desk + home) for a commune
// =====================================================
const STORE_WILAYA_ID = process.env.STORE_WILAYA_ID || 16; // 16 = Alger (default, change if needed)

app.get('/api/delivery-pricing', async (req, res) => {
  const { to_wilaya_id, commune_id } = req.query;
  if (!to_wilaya_id || !commune_id) {
    return res.status(400).json({ success: false, error: 'to_wilaya_id et commune_id sont requis.' });
  }
  try {
    const pricing = await yalidine.getDeliveryPricing({
      fromWilayaId: STORE_WILAYA_ID,
      toWilayaId: to_wilaya_id,
      communeId: commune_id,
    });
    res.json({ success: true, data: pricing });
  } catch (err) {
    console.error('Error fetching delivery pricing:', err.message);
    res.status(500).json({ success: false, error: 'Impossible de calculer les frais de livraison.' });
  }
});

// =====================================================
// ORDER SUBMISSION
// =====================================================
app.post('/api/order', orderLimiter, async (req, res) => {
  const payload = req.body;

  const { valid, errors } = validateOrder(payload);
  if (!valid) {
    return res.status(400).json({
      success: false,
      error: '‼️ Impossible de confirmer la commande, veuillez vérifier vos informations. Merci 🫶🏻🌸',
      details: errors,
    });
  }

  const order = {
    customer: {
      firstName: payload.customer.firstName.trim(),
      lastName: payload.customer.lastName.trim(),
      phone: payload.customer.phone.trim(),
    },
    items: payload.items.map((item) => ({
      name: item.name,
      variant: item.variant || null,
      variantId: item.variantId || null,
      quantity: item.quantity,
      price: item.price,
    })),
    subtotal: payload.subtotal,
    delivery: {
      wilayaName: payload.delivery.wilayaName,
      communeName: payload.delivery.communeName,
      type: payload.delivery.type,
      deskName: payload.delivery.deskName || null,
      address: payload.delivery.address || null,
    },
    shippingCost: payload.delivery.shippingCost ?? payload.shippingCost,
    total: payload.total,
  };

  try {
    const shopifyOrder = await createShopifyOrder(order);
    res.json({
      success: true,
      message: 'Commande confirmée avec succès ! 🌸',
      orderName: shopifyOrder.name,
    });
  } catch (err) {
    console.error('Error creating Shopify order:', err.message);
    return res.status(500).json({
      success: false,
      error: "Votre commande est valide mais une erreur technique est survenue lors de la création. Veuillez nous contacter directement.",
    });
  }
});

// =====================================================
// ORDERS LISTING (for the internal tracking dashboard)
// =====================================================
app.get('/api/orders', async (req, res) => {
  // Simple shared-secret protection: this endpoint exposes customer names,
  // phone numbers and order totals, so it must not be publicly open.
  const dashboardKey = process.env.DASHBOARD_KEY;
  if (dashboardKey && req.query.key !== dashboardKey) {
    return res.status(401).json({ success: false, error: 'Non autorisé.' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const query = `
    query RecentOrders($first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress {
              firstName
              lastName
              phone
              city
              province
              address1
            }
            tags
            note
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyGraphql(query, { first: limit });
    const orders = data.orders.edges.map(({ node }) => {
      const addr = node.shippingAddress;
      const fullName = addr ? `${addr.firstName || ''} ${addr.lastName || ''}`.trim() : '';
      return {
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        total: node.totalPriceSet?.shopMoney?.amount || '0',
        currency: node.totalPriceSet?.shopMoney?.currencyCode || 'DZD',
        customerName: fullName || 'Client',
        phone: addr?.phone || null,
        city: addr?.city || null,
        province: addr?.province || null,
        tags: node.tags || [],
        note: node.note || '',
      };
    });
    res.json({ success: true, data: orders });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ success: false, error: 'Impossible de charger les commandes.' });
  }
});

// NOUVELLE ROUTE POUR LE SITE GITHUB (TELEGRAM) - MULTI-ARTICLES AVEC VERIFICATION STOCK
// NOUVELLE ROUTE POUR LE SITE GITHUB (TELEGRAM ET GOOGLE SHEETS)
app.post('/api/order-telegram', async (req, res) => {
    try {
        const orderData = req.body;
        
        // --- 1. LECTURE DU STOCK GOOGLE SHEETS ---
        const getResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Stock!A2:B50',
        });
        
        const rows = getResponse.data.values;
        if (!rows) {
            return res.status(500).json({ success: false, message: "Erreur de lecture du tableau." });
        }

        // --- 2. VÉRIFICATION DU STOCK AVANT D'ACCEPTER LA COMMANDE ---
        let itemsToUpdate = [];
        if (orderData.items && Array.isArray(orderData.items)) {
            for (let item of orderData.items) {
                const couleurDemandee = item.variant;
                const quantiteDemandee = parseInt(item.quantity);
                let trouve = false;

                for (let i = 0; i < rows.length; i++) {
                    if (rows[i][0] === couleurDemandee) {
                        trouve = true;
                        const stockActuel = parseInt(rows[i][1], 10);
                        if (stockActuel < quantiteDemandee) {
                            return res.status(400).json({ 
                                success: false, 
                                message: `Désolé, la couleur ${couleurDemandee} vient de tomber en rupture de stock !`
                            });
                        }
                        // On prépare la mise à jour (ligne Excel = i + 2 car on commence à A2)
                        itemsToUpdate.push({
                            range: `Stock!B${i + 2}`,
                            values: [[stockActuel - quantiteDemandee]]
                        });
                        break;
                    }
                }
                
                if (!trouve) {
                     return res.status(400).json({ success: false, message: `Couleur ${couleurDemandee} introuvable.` });
                }
            }
        }

        // --- 3. MISE À JOUR DU STOCK DANS GOOGLE SHEETS ---
        for (let update of itemsToUpdate) {
             await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: update.range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: update.values },
            });
        }

        // --- 4. AJOUT DE LA COMMANDE DANS L'ONGLET "Commandes" ---
        const dateCommande = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
        const listeProduits = orderData.items.map(item => `(${item.variant})*${item.quantity}`).join(', ');
        const adresseComplete = `${orderData.delivery.wilayaName} - ${orderData.delivery.communeName} (${orderData.delivery.type === 'desk' ? 'Bureau: ' + orderData.delivery.deskName : orderData.delivery.address})`;
        const prixNet = String(orderData.subtotal || orderData.total).replace(/\D/g, ''); // Prix sans livraison

        // On capture la réponse de Google pour connaître la ligne exacte
        const sheetResponse = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Commandes!A:F',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[
                    dateCommande,
                    `${orderData.customer.firstName} ${orderData.customer.lastName}`,
                    orderData.customer.phone,
                    adresseComplete,
                    listeProduits,
                    prixNet
                ]]
            }
        });

        // Extraction du numéro de commande basé sur la ligne du tableau
        const updatedRange = sheetResponse.data.updates.updatedRange; 
        const numeroLigne = updatedRange.split('!')[1].match(/\d+/)[0]; 
        const numeroCommande = parseInt(numeroLigne) - 1; // -1 pour ignorer la ligne des titres

        // --- 4.5 CREATION DU COLIS YALIDINE VIA API ---
        try {
            // Calcul du texte exact des produits ("1 tablier de cuisine" ou "X tabliers...")
            let quantiteTotale = 0;
            orderData.items.forEach(item => quantiteTotale += parseInt(item.quantity) || 1);
            const texteProduit = quantiteTotale > 1 ? `${quantiteTotale} tabliers de cuisine` : "1 tablier de cuisine";

            const estStopdesk = orderData.delivery.type === 'desk';

            // Yalidine refuse les wilayas écrites comme "16 - Alger". On extrait uniquement le texte pur ("Alger").
            const wilayaPropre = orderData.delivery.wilayaName.includes('-') ? orderData.delivery.wilayaName.split('-')[1].trim() : orderData.delivery.wilayaName;

            const yalidinePayload = [{
                "order_id": numeroCommande.toString(),
                "firstname": orderData.customer.firstName,
                "familyname": orderData.customer.lastName,
                "contact_phone": orderData.customer.phone,
                "address": estStopdesk ? orderData.delivery.deskName : orderData.delivery.address,
                "to_commune_name": orderData.delivery.communeName,
                "to_wilaya_name": wilayaPropre, // Utilisation de la wilaya nettoyée
                "product_list": texteProduit,
                "price": Number(prixNet), 
                "freeshipping": false,
                "is_stopdesk": estStopdesk,
                "has_exchange": false,
                "do_insurance": false,
                "declared_value": Number(prixNet), 
                "can_open": true 
            }];

            const yalidineResponse = await fetch('https://api.yalidine.app/v1/parcels/', {
                method: 'POST',
                headers: {
                    'X-API-ID': process.env.YALIDINE_API_ID,
                    'X-API-TOKEN': process.env.YALIDINE_API_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(yalidinePayload)
            });

            const yalidineResult = await yalidineResponse.json();
           console.log("Résultat Yalidine:", yalidineResult);
            
            // Récupération du tracking Yalidine (basé sur le numéro de commande envoyé)
            const trackingNumber = yalidineResult[numeroCommande.toString()]?.tracking;
            
            if (trackingNumber) {
                // Écriture du tracking dans la cellule exacte de la colonne G
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `Commandes!G${numeroLigne}`, // Cible la bonne ligne de la colonne G
                    valueInputOption: 'USER_ENTERED',
                    requestBody: {
                        values: [[trackingNumber]]
                    }
                });
            }
        } catch (yalidineError) {
            console.error("Erreur lors de la création du colis Yalidine :", yalidineError);
            // On ne bloque pas la commande si Yalidine bug, on passe à Telegram
        }
      
        // --- 5. ENVOI TELEGRAM ---
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatIds = process.env.TELEGRAM_CHAT_ID.split(',');

        let articlesList = "";
        if (orderData.items && Array.isArray(orderData.items)) {
            articlesList = orderData.items.map(item => 
                `📦 ${item.name} (${item.variant})\n🔢 Quantité : ${item.quantity}`
            ).join('\n\n');
        }

        const text = `
🌸 *NOUVELLE COMMANDE (SITE GITHUB)* 🌸

👤 *Client :* ${orderData.customer.firstName} ${orderData.customer.lastName}
📞 *Téléphone :* ${orderData.customer.phone}

${articlesList}

💰 *Total :* ${orderData.total}

🚚 *Livraison :* ${orderData.delivery.type === 'desk' ? '🏢 Bureau Yalidine' : '🏠 À domicile'}
📍 *Wilaya :* ${orderData.delivery.wilayaName} (${orderData.delivery.communeName})
📝 *Détails :* ${orderData.delivery.deskName || orderData.delivery.address || 'Aucune adresse précisée'}
`;

       // Envoi via le Bot 1 (Ton bot actuel)
    if (botToken && process.env.TELEGRAM_CHAT_ID) {
        const chatIds1 = process.env.TELEGRAM_CHAT_ID.split(',');
        for (let id of chatIds1) {
            if (id.trim() !== '') {
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: id.trim(), text: text, parse_mode: 'Markdown' })
                });
            }
        }
    }

    // Envoi via le Bot 2 (Le nouveau)
    const botToken2 = process.env.TELEGRAM_BOT_TOKEN_2;
    if (botToken2 && process.env.TELEGRAM_CHAT_ID_2) {
        const chatIds2 = process.env.TELEGRAM_CHAT_ID_2.split(',');
        for (let id of chatIds2) {
            if (id.trim() !== '') {
                await fetch(`https://api.telegram.org/bot${botToken2}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: id.trim(), text: text, parse_mode: 'Markdown' })
                });
            }
        }
    } 

      // --- 6. ENVOI DE L'E-MAIL (RESEND) ---
        try {
            orderData.orderDate = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
            await sendOrderEmail(orderData);
        } catch (emailError) {
            console.error("L'e-mail n'a pas pu être envoyé :", emailError);
        }

        res.status(200).json({ success: true, message: 'Commande validée !' });

    } catch (error) {
        console.error("Erreur globale lors de la commande :", error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Les dernières lignes du fichier restent inchangées
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route non trouvée.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Erreur serveur.' });
});

app.listen(PORT, () => {
  console.log(`Eva's Touch COD backend running on port ${PORT}`);
});
