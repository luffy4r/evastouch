// utils/validate.js
//
// Server-side validation. The frontend also validates for UX, but we NEVER
// trust the client — every order is re-validated here before a real
// Shopify order is created.

const PHONE_REGEX = /^(05|06|07)[0-9]{8}$/; // exactly 10 digits, starts 05/06/07

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Validates an incoming order payload.
 * Returns { valid: boolean, errors: string[] }
 */
function validateOrder(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload invalide.'] };
  }

  const { customer, items, delivery } = payload;

  // ---- Customer ----
  if (!customer || !isNonEmptyString(customer.firstName)) {
    errors.push('Prénom manquant.');
  }
  if (!customer || !isNonEmptyString(customer.lastName)) {
    errors.push('Nom manquant.');
  }
  if (!customer || !isNonEmptyString(customer.phone)) {
    errors.push('Téléphone manquant.');
  } else if (!PHONE_REGEX.test(customer.phone.trim())) {
    errors.push('Numéro de téléphone algérien invalide (doit commencer par 05, 06 ou 07 et contenir 10 chiffres).');
  }

  // ---- Items ----
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('Le panier est vide.');
  }

  // ---- Delivery ----
  if (!delivery) {
    errors.push('Informations de livraison manquantes.');
  } else {
    if (!delivery.wilayaId || !isNonEmptyString(delivery.wilayaName)) {
      errors.push('Wilaya manquante.');
    }
    if (!delivery.communeId || !isNonEmptyString(delivery.communeName)) {
      errors.push('Commune manquante.');
    }
    if (delivery.type !== 'desk' && delivery.type !== 'home') {
      errors.push('Type de livraison invalide.');
    }
    if (delivery.type === 'desk' && !delivery.deskId) {
      errors.push('Veuillez sélectionner un bureau Yalidine.');
    }
    if (delivery.type === 'home' && !isNonEmptyString(delivery.address)) {
      errors.push('Adresse complète requise pour la livraison à domicile.');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateOrder, PHONE_REGEX };
