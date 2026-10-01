import crypto from 'node:crypto';

export function verifySignature(rawBody, signature, appSecret) {
  if (!appSecret) return true;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function extractMessages(payload) {
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const message of value.messages || []) {
        const text = message.text?.body
          || message.interactive?.button_reply?.id
          || message.interactive?.list_reply?.id
          || message.image?.caption
          || message.document?.caption
          || '';
        messages.push({
          id: message.id,
          from: String(message.from || '').replace(/^\+/, ''),
          type: message.type,
          text: text.trim(),
          timestamp: message.timestamp,
          raw: message
        });
      }
    }
  }
  return messages;
}

export async function sendWhatsAppText(config, to, body) {
  if (!config.accessToken || !config.phoneNumberId) {
    console.log(`[WhatsApp dry-run → ${to}]\n${body}`);
    return { dryRun: true };
  }
  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body } })
  });
  if (!response.ok) throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function sendWhatsAppButtons(config, to, body, buttons) {
  if (!config.accessToken || !config.phoneNumberId) {
    console.log(`[WhatsApp dry-run → ${to}]\n${body}\n${buttons.map((button) => `[${button.id}] ${button.title}`).join(' ')}`);
    return { dryRun: true };
  }
  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.slice(0, 3).map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title } })) }
      }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp buttons failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function sendWhatsAppTemplate(config, to, templateName, language, parameters) {
  if (!config.accessToken || !config.phoneNumberId) {
    console.log(`[WhatsApp dry-run template → ${to}] ${templateName} (${language}) ${parameters.join(' | ')}`);
    return { dryRun: true };
  }
  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: String(text) })) }]
      }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp template failed: ${response.status} ${await response.text()}`);
  return response.json();
}
