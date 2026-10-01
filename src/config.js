import process from 'node:process';

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/^\+/, ''))
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseFile: process.env.DATABASE_FILE || './data/nreg.sqlite',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServerKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    matchTemplateName: process.env.WHATSAPP_MATCH_TEMPLATE_NAME || '',
    matchTemplateLanguage: process.env.WHATSAPP_MATCH_TEMPLATE_LANGUAGE || 'es_MX'
  },
  adminPhoneNumbers: list(process.env.ADMIN_PHONE_NUMBERS),
  adminPanelToken: process.env.ADMIN_PANEL_TOKEN || '',
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || ''
  }
};
